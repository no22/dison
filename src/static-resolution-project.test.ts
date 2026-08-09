import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSync } from "esbuild";
import {
  transpileDisonToTS,
  computeProjectWiring,
  computeIdentityKeyClassesByFile,
  computeCompanionPlanByFile,
  computeConfigExtendsPlanByFile,
} from "./core";
import type { DisonFileInput } from "./collisions";

// 静的解決 フェーズ2: 複数ファイル（docs/static-resolution-design.md §8）。
// プロジェクト全体の評価順解析・キー正準化・factory hoisting・ランタイム消去を検証する。

const FAKE_DIR = path.join(os.tmpdir(), "dison-project-wiring-test");

function makeInputs(files: Record<string, string>): DisonFileInput[] {
  return Object.entries(files).map(([name, source]) => ({
    path: path.join(FAKE_DIR, name),
    source,
  }));
}

// CLI の複数ファイル経路と同じオプションで transpile する（解析はメモリ上のみ）。
function transpileProject(
  files: Record<string, string>,
  opts: { noStatic?: boolean } = {}
): { outputs: Map<string, string>; wiring: ReturnType<typeof computeProjectWiring> } {
  const inputs = makeInputs(files);
  const wiring = computeProjectWiring(inputs);
  const identityByFile = computeIdentityKeyClassesByFile(inputs);
  const companionByFile = computeCompanionPlanByFile(inputs);
  const extendsByFile = computeConfigExtendsPlanByFile(inputs);
  const outputs = new Map<string, string>();
  for (const f of inputs) {
    const plan = companionByFile.get(f.path);
    outputs.set(
      path.basename(f.path),
      transpileDisonToTS(f.source, {
        runtimeModulePath: "dison/runtime",
        identityKeyClasses: identityByFile.get(f.path),
        companionEmit: plan?.companionEmit,
        companionImports: plan?.companionImports,
        projectWiring: opts.noStatic ? undefined : wiring.get(f.path),
        staticResolution: opts.noStatic ? false : undefined,
        configApplierEmit: extendsByFile.get(f.path)?.applierEmit,
        configExtendsImports: extendsByFile.get(f.path)?.extendsImports,
      })
    );
  }
  return { outputs, wiring };
}

// 生成物一式を一時ディレクトリに書き出し、esbuild でバンドルして実行し、
// エントリの exports を返す（共有ランタイムは実物の src/generated-runtime.ts へ alias）。
function runProject(outputs: Map<string, string>, entryName: string): any {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dison-sr2-"));
  try {
    for (const [name, content] of outputs) {
      fs.writeFileSync(path.join(dir, name.replace(/\.dis$/, ".ts")), content);
    }
    const result = buildSync({
      entryPoints: [path.join(dir, entryName)],
      bundle: true,
      format: "cjs",
      platform: "node",
      write: false,
      alias: { "dison/runtime": path.join(__dirname, "generated-runtime.ts") },
    });
    const code = result.outputFiles[0].text;
    const mod: { exports: any } = { exports: {} };
    const fn = new Function("module", "exports", "require", code);
    fn(mod, mod.exports, require);
    return mod.exports;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("フェーズ2: 宣言的ヘッダの複数ファイルプロジェクトは全体が畳まれる", () => {
  const files = {
    "user-module.dis": `
export interface IRepository { whoAmI(): string; }
export class SqlUserRepository implements IRepository { whoAmI() { return "real user"; } }
class MockUserRepository implements IRepository { whoAmI() { return "mock user"; } }
export class UserService { injectable repo: IRepository = new SqlUserRepository(); }
configuration UseMockUserRepo { bind IRepository = MockUserRepository; }
`,
    "main.dis": `
import { UserService } from "./user-module";
activate UseMockUserRepo from "./user-module";
export const results = [new UserService().repo.whoAmI()];
`,
  };

  it("全ファイルから共有ランタイムの import が消える", () => {
    const { outputs, wiring } = transpileProject(files);
    for (const [name, w] of wiring) {
      expect(w.needsRuntimeImport, name).toBe(false);
      expect(w.dropRegistrations, name).toBe(true);
    }
    for (const [, out] of outputs) {
      expect(out).not.toContain('from "dison/runtime"');
    }
  });

  it("勝者は同一ファイル内なのでインラインされ、activate は空関数として残る", () => {
    const { outputs } = transpileProject(files);
    const userModule = outputs.get("user-module.dis")!;
    expect(userModule).toContain("this._repo = new MockUserRepository();");
    expect(userModule).toContain("export function activateUseMockUserRepo() {\n}");
    expect(userModule).not.toContain("bindTypeLazy");
  });

  it("実行結果は --no-static と一致する", () => {
    const folded = runProject(transpileProject(files).outputs, "main.ts");
    const dynamic = runProject(transpileProject(files, { noStatic: true }).outputs, "main.ts");
    expect(folded.results).toEqual(["mock user"]);
    expect(dynamic.results).toEqual(["mock user"]);
  });
});

describe("フェーズ2: factory hoisting（中央設定ファイルパターン）", () => {
  const files = {
    "services.dis": `
export class Repo { whoAmI() { return "real repo"; } }
export class PgRepo extends Repo { constructor(private url: string) { super(); } whoAmI() { return "pg @ " + this.url; } }
export class UserService { injectable repo: Repo; }
`,
    "config.dis": `
import { Repo, PgRepo, UserService } from "./services";
const DB_URL = "postgres://localhost/db";
bind Repo = PgRepo(DB_URL);
export const results = [new UserService().repo.whoAmI()];
`,
  };

  it("配線ファイル側に関数宣言の factory が生成され、ゲッターはそれを直接呼ぶ", () => {
    const { outputs, wiring } = transpileProject(files);
    const services = outputs.get("services.dis")!;
    const config = outputs.get("config.dis")!;
    // 関数宣言（const アローではなく）: ESM のリンク時初期化により、循環 import でも
    // TDZ を踏まない。
    expect(config).toMatch(/export function __dison_factory_\d+\(\) \{ return \(new PgRepo\(DB_URL\)\); \}/);
    expect(services).toMatch(/import \{ __dison_factory_\d+ \} from "\.\/config";/);
    expect(services).toMatch(/this\._repo = __dison_factory_\d+\(\);/);
    for (const [, w] of wiring) expect(w.needsRuntimeImport).toBe(false);
  });

  it("実行結果は --no-static と一致する（循環 import になっても TDZ にならない）", () => {
    const folded = runProject(transpileProject(files).outputs, "config.ts");
    const dynamic = runProject(transpileProject(files, { noStatic: true }).outputs, "config.ts");
    expect(folded.results).toEqual(["pg @ postgres://localhost/db"]);
    expect(dynamic.results).toEqual(["pg @ postgres://localhost/db"]);
  });
});

describe("フェーズ2: モジュール評価順", () => {
  it("勝者ファイルが消費側を支配しない場合は畳まず、実行時の後勝ちを保つ", () => {
    // 評価順は a → b → main で、b の bind が後勝ち。しかし b は a を支配しない
    // （main が a を直接 import している）ため、a に b への factory import を注入すると
    // b の評価が繰り上がり `class MockB extends Repo` が未初期化の Repo を参照して
    // しまう。よってこのキーは動的維持が正しい（挙動は両モードで一致する）。
    const files = {
      "a.dis": `
export class Repo { tag = "real"; }
export class MockA extends Repo { tag = "a"; }
export class S { injectable repo: Repo; }
bind Repo = MockA;
`,
      "b.dis": `
import { Repo, S } from "./a";
export class MockB extends Repo { tag = "b"; }
bind Repo = MockB;
`,
      "main.dis": `
import { S } from "./a";
import "./b";
export const results = [new S().repo.tag];
`,
    };
    const { outputs, wiring } = transpileProject(files);
    const a = wiring.get(makeInputs(files)[0].path)!;
    expect(a.decisionsByInjectableIndex[0].kind).toBe("dynamic");
    if (a.decisionsByInjectableIndex[0].kind === "dynamic") {
      expect(a.decisionsByInjectableIndex[0].reason).toContain("module evaluation order");
    }
    const folded = runProject(outputs, "main.ts");
    expect(folded.results).toEqual(["b"]);
    const dynamic = runProject(transpileProject(files, { noStatic: true }).outputs, "main.ts");
    expect(dynamic.results).toEqual(["b"]);
  });

  it("先に評価されるモジュールの実行文がキーを使う場合、その後の配線は畳まれない", () => {
    // probe が S を構築（= キー Repo を使用）した後で main が Repo を配線し直す。
    // フェーズ3b のクロスファイル mention 閉包がこれを検出して動的に落とす。
    const files = {
      "probe.dis": `
export class Repo { tag = "real"; }
export class Mock extends Repo { tag = "mock"; }
export class S { injectable repo: Repo; }
export const early = new S().repo.tag;
`,
      "main.dis": `
import { Repo, Mock, S } from "./probe";
configuration { bind Repo = Mock; }
export const results = [new S().repo.tag];
`,
    };
    const { wiring, outputs } = transpileProject(files);
    const probe = wiring.get(makeInputs(files)[0].path)!;
    expect(probe.decisionsByInjectableIndex[0].kind).toBe("dynamic");
    expect(outputs.get("main.dis")!).toContain('from "dison/runtime"');
    // 実行時挙動も両モードで一致（early=real、results=mock）。
    const folded = runProject(outputs, "main.ts");
    expect(folded.results).toEqual(["mock"]);
    const dynamic = runProject(transpileProject(files, { noStatic: true }).outputs, "main.ts");
    expect(dynamic.results).toEqual(["mock"]);
  });

  it("フェーズ3b: 先行モジュールの実行文がキーと無関係なら、その後の配線も畳める", () => {
    // probe の console.log は Repo キーを使えない（言及閉包に S が入らない）ため、
    // main の配線はプレバリア扱いで畳める。L1（ファイル単位バリア）では畳めなかった形。
    const files = {
      "probe.dis": `
export const seen: void = console.log("probe module evaluated");
`,
      "main.dis": `
import { seen } from "./probe";
class Repo { tag = "real"; }
class Mock extends Repo { tag = "mock"; }
class S { injectable repo: Repo; }
configuration { bind Repo = Mock; }
export const results = [new S().repo.tag];
`,
    };
    const { wiring, outputs } = transpileProject(files);
    const main = wiring.get(makeInputs(files)[1].path)!;
    expect(main.decisionsByInjectableIndex[0]).toEqual(
      expect.objectContaining({ kind: "static", expr: "new Mock()" })
    );
    expect(outputs.get("main.dis")!).not.toContain('from "dison/runtime"');
    const folded = runProject(outputs, "main.ts");
    expect(folded.results).toEqual(["mock"]);
  });

  it("エントリ候補が複数ある場合は順序依存の配線を畳まない（L0 は畳む）", () => {
    const files = {
      "one.dis": `
class Repo { tag = "real"; }
class Mock extends Repo { tag = "mock"; }
class S { injectable repo: Repo; }
class Plain {}
class T { injectable dep: Plain; }
configuration { bind Repo = Mock; }
`,
      "two.dis": `
class Other {}
class U { injectable dep: Other; }
console.log(new U().dep);
`,
    };
    const { wiring } = transpileProject(files);
    const one = wiring.get(makeInputs(files)[0].path)!;
    // 配線されたキー（Repo）は順序不明なので動的。
    expect(one.decisionsByInjectableIndex[0].kind).toBe("dynamic");
    if (one.decisionsByInjectableIndex[0].kind === "dynamic") {
      expect(one.decisionsByInjectableIndex[0].reason).toContain("multiple entry candidates");
    }
    // 配線がどこにも無いキー（Plain）は評価順と無関係に L0 で畳める。
    expect(one.decisionsByInjectableIndex[1]).toEqual(
      expect.objectContaining({ kind: "static", expr: "new Plain()" })
    );
  });

  it("配線ファイルを import すると評価順が変わる場合は畳まない（ガード）", () => {
    // G（services）と W（wiring）は第三のファイルの interface を介して結ばれ、
    // W は G を import しない。root は G → W の順に import しているため、
    // G に W への factory import を注入すると W の評価が繰り上がってしまう。
    const files = {
      "types.dis": `
export interface IRepo { whoAmI(): string; }
`,
      "services.dis": `
import { IRepo } from "./types";
export class RealRepo implements IRepo { whoAmI() { return "real"; } }
export class S { injectable repo: IRepo = new RealRepo(); }
`,
      "wiring.dis": `
import { IRepo } from "./types";
class WMock implements IRepo { whoAmI() { return "wmock"; } }
bind IRepo = WMock;
`,
      "main.dis": `
import { S } from "./services";
import "./wiring";
export const results = [new S().repo.whoAmI()];
`,
    };
    const { wiring } = transpileProject(files);
    const services = wiring.get(makeInputs(files)[1].path)!;
    expect(services.decisionsByInjectableIndex[0].kind).toBe("dynamic");
    if (services.decisionsByInjectableIndex[0].kind === "dynamic") {
      expect(services.decisionsByInjectableIndex[0].reason).toContain("module evaluation order");
    }
  });
});

describe("フェーズ3b: クロスファイル mention 閉包", () => {
  it("import した関数の呼び出し経由の使用も閉包が捕捉する", () => {
    // main のバリアは makeService だけに言及するが、その本体（services 側）が S に
    // 言及する → S のキーは使用扱いになり、後続の配線は畳めない。
    const files = {
      "services.dis": `
export class Repo { tag = "real"; }
export class Mock extends Repo { tag = "mock"; }
export class S { injectable repo: Repo; }
export function makeService() { return new S().repo.tag; }
`,
      "main.dis": `
import { Repo, Mock, makeService } from "./services";
export const early = makeService();
configuration { bind Repo = Mock; }
export const results = [makeService()];
`,
    };
    const { wiring, outputs } = transpileProject(files);
    const services = wiring.get(makeInputs(files)[0].path)!;
    expect(services.decisionsByInjectableIndex[0].kind).toBe("dynamic");
    // 実行時挙動も両モードで一致（early=real、results=mock）。
    const folded = runProject(outputs, "main.ts");
    expect(folded.early).toBe("real");
    expect(folded.results).toEqual(["mock"]);
    const dyn = runProject(transpileProject(files, { noStatic: true }).outputs, "main.ts");
    expect(dyn.early).toBe("real");
    expect(dyn.results).toEqual(["mock"]);
  });

  it("import した関数がキーと無関係なら、呼び出し後の配線も畳める", () => {
    const files = {
      "util.dis": `
export function greet() { return "hello"; }
`,
      "main.dis": `
import { greet } from "./util";
export const greeting = greet();
class Repo { tag = "real"; }
class Mock extends Repo { tag = "mock"; }
class S { injectable repo: Repo; }
configuration { bind Repo = Mock; }
export const results = [new S().repo.tag];
`,
    };
    const { wiring, outputs } = transpileProject(files);
    const main = wiring.get(makeInputs(files)[1].path)!;
    expect(main.decisionsByInjectableIndex[0]).toEqual(
      expect.objectContaining({ kind: "static", expr: "new Mock()" })
    );
    expect(outputs.get("main.dis")!).not.toContain('from "dison/runtime"');
    const folded = runProject(outputs, "main.ts");
    expect(folded.results).toEqual(["mock"]);
  });
});

describe("フェーズ2+L1.5: クロスファイルのクラススコープ", () => {
  it("別ファイルの親クラスのフレームが子の解決に効き、factory hoisting で畳まれる", () => {
    // Base（base.dis）のフレームが C（main.dis）の chain に入る。勝者式の字句的な
    // 所属は base.dis なので factory hoisting になる（base は main より先に評価される
    // ためガードも通る）。
    const files = {
      "base.dis": `
export class Repo { tag = "real"; }
export class Cached extends Repo { tag = "cached"; }
export class Base {
  configuration { bind Repo = Cached; }
}
`,
      "main.dis": `
import { Repo, Base } from "./base";
class C extends Base { injectable repo: Repo; }
export const results = [new C().repo.tag];
`,
    };
    const { outputs, wiring } = transpileProject(files);
    const main = wiring.get(makeInputs(files)[1].path)!;
    expect(main.decisionsByInjectableIndex[0].kind).toBe("static");
    expect(outputs.get("base.dis")!).toMatch(/export function __dison_factory_\d+\(\) \{ return \(new Cached\(\)\); \}/);
    expect(outputs.get("main.dis")!).toMatch(/this\._repo = __dison_factory_\d+\(\);/);
    for (const [, w] of wiring) expect(w.needsRuntimeImport).toBe(false);
    const folded = runProject(outputs, "main.ts");
    expect(folded.results).toEqual(["cached"]);
    const dynamic = runProject(transpileProject(files, { noStatic: true }).outputs, "main.ts");
    expect(dynamic.results).toEqual(["cached"]);
  });

  it("他クラスのフレームは無関係な同キー injectable を汚染しない（プロジェクト版）", () => {
    const files = {
      "types.dis": `
export class Repo { tag = "real"; }
export class Cached extends Repo { tag = "cached"; }
`,
      "main.dis": `
import { Repo, Cached } from "./types";
class X {
  injectable p: Repo;
  configuration { bind Repo = Cached; }
}
class D { injectable q: Repo; }
export const results = [new X().p.tag, new D().q.tag];
`,
    };
    const { outputs, wiring } = transpileProject(files);
    const main = wiring.get(makeInputs(files)[1].path)!;
    expect(main.decisionsByInjectableIndex[0].kind).toBe("static"); // X.p → Cached
    expect(main.decisionsByInjectableIndex[1]).toEqual(
      expect.objectContaining({ kind: "static", expr: "new Repo()" }) // D.q はフレームの影響を受けない
    );
    const folded = runProject(outputs, "main.ts");
    expect(folded.results).toEqual(["cached", "real"]);
    const dynamic = runProject(transpileProject(files, { noStatic: true }).outputs, "main.ts");
    expect(dynamic.results).toEqual(["cached", "real"]);
  });
});

describe("2.1: configuration extends のクロスファイル展開（3層分離）", () => {
  const files = {
    "contracts.dis": `
export interface Repository { find(id: string): string; }
export interface Clock { now(): string; }
`,
    "impl.dis": `
import type { Repository, Clock } from "./contracts";
export class PgRepository implements Repository { constructor(private url: string) {} find(id: string) { return id + "@" + this.url; } }
export class MemRepository implements Repository { find(id: string) { return id + "@mem"; } }
export class SystemClock implements Clock { now() { return "sys"; } }
`,
    "wiring.dis": `
import type { Repository, Clock } from "./contracts";
import { PgRepository, MemRepository, SystemClock } from "./impl";
const DB_URL = "postgres://app";
export configuration Production { bind Repository = PgRepository(DB_URL); bind Clock = SystemClock; }
export configuration Test extends Production { bind Repository = MemRepository; }
`,
    "service.dis": `
import type { Repository, Clock } from "./contracts";
export class ReportService {
  injectable repo: Repository;
  injectable clock: Clock;
  render(id: string): string { return "[" + this.clock.now() + "] " + this.repo.find(id); }
}
`,
    "main.dis": `
import { ReportService } from "./service";
configuration extends Production {}
export const results = [new ReportService().render("42")];
`,
  };

  it("契約・実装・配線・利用が分離したまま全体が畳まれ、ランタイム依存が消える", () => {
    const { outputs, wiring } = transpileProject(files);
    for (const [name, w] of wiring) expect(w.needsRuntimeImport, name).toBe(false);
    for (const [, out] of outputs) expect(out).not.toContain('from "dison/runtime"');
    // service.dis は既定初期化式なしの interface 型 injectable（2.1の緩和）を持つ。
    expect(files["service.dis"]).toContain("injectable repo: Repository;");
    // 勝者式は wiring.dis の字句環境（DB_URL）を参照するので factory hoisting される。
    expect(outputs.get("service.dis")!).toMatch(/this\._repo = __dison_factory_\d+\(\);/);
    expect(outputs.get("wiring.dis")!).toMatch(/export function __dison_factory_\d+\(\) \{ return \(new PgRepository\(DB_URL\)\); \}/);
  });

  it("extends の import は生成側が注入する（利用者は書かない）", () => {
    const { outputs } = transpileProject(files);
    expect(files["main.dis"]).not.toContain('from "./wiring"');
    expect(outputs.get("main.dis")!).toContain('import { activateProduction } from "./wiring";');
  });

  it("実行結果は --no-static と一致する", () => {
    const folded = runProject(transpileProject(files).outputs, "main.ts");
    const dynamic = runProject(transpileProject(files, { noStatic: true }).outputs, "main.ts");
    expect(folded.results).toEqual(["[sys] 42@postgres://app"]);
    expect(dynamic.results).toEqual(["[sys] 42@postgres://app"]);
  });

  it("ローカルスコープへのクロスファイル展開は applier 経由で動的に残る", () => {
    const withTest = {
      ...files,
      "main.dis": `
import { ReportService } from "./service";
configuration extends Production {}
export function underTest(): string {
  configuration extends Test {}
  return new ReportService().render("42");
}
export const results = [new ReportService().render("42"), underTest()];
`,
    };
    const { outputs } = transpileProject(withTest);
    expect(outputs.get("wiring.dis")!).toContain("export function __dison_config_Test(");
    expect(outputs.get("main.dis")!).toContain('import { __dison_config_Test } from "./wiring";');
    const folded = runProject(outputs, "main.ts");
    expect(folded.results).toEqual(["[sys] 42@postgres://app", "[sys] 42@mem"]);
    const dynamic = runProject(transpileProject(withTest, { noStatic: true }).outputs, "main.ts");
    expect(dynamic.results).toEqual(["[sys] 42@postgres://app", "[sys] 42@mem"]);
  });
});

describe("フェーズ2: 混在プロジェクト", () => {
  it("ローカルスコープを使うファイルはランタイム維持、畳めたファイルは import 無し", () => {
    const files = {
      "folded.dis": `
export class Plain { tag = "plain"; }
export class F { injectable dep: Plain; }
`,
      "scoped.dis": `
import { F } from "./folded";
export class Repo { tag = "real"; }
export class Mock extends Repo { tag = "mock"; }
export class S { injectable repo: Repo; }
export function test() {
  configuration { bind Repo = Mock; }
  return new S().repo.tag;
}
export const results = [test(), new F().dep.tag];
`,
    };
    const { outputs, wiring } = transpileProject(files);
    const [foldedPath, scopedPath] = makeInputs(files).map((f) => f.path);
    // scoped.dis: ローカルスコープ束縛の Repo は動的、ランタイム import が残る。
    expect(wiring.get(scopedPath)!.needsRuntimeImport).toBe(true);
    expect(outputs.get("scoped.dis")!).toContain('from "dison/runtime"');
    expect(outputs.get("scoped.dis")!).toContain("__disonEnterScopeLazy");
    // folded.dis: 配線なしの Plain は畳まれ、ランタイム import 自体が無い。
    expect(wiring.get(foldedPath)!.needsRuntimeImport).toBe(false);
    expect(wiring.get(foldedPath)!.dropRegistrations).toBe(false); // プロジェクト全体では登録は残る
    expect(outputs.get("folded.dis")!).not.toContain('from "dison/runtime"');
    expect(outputs.get("folded.dis")!).toContain("this._dep = new Plain();");
    // 実行: ローカルスコープの差し替えと畳んだ既定解決が共存する。
    const folded = runProject(outputs, "scoped.ts");
    expect(folded.results).toEqual(["mock", "plain"]);
    const dynamic = runProject(transpileProject(files, { noStatic: true }).outputs, "scoped.ts");
    expect(dynamic.results).toEqual(["mock", "plain"]);
  });
});
