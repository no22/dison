import { describe, it, expect } from "vitest";
import { transpileDisonToTS, explainWiring } from "./core";
import { runGenerated } from "./test-helpers";

// 実行時選択 `configuration extends (cond ? A : B) {}` と、3.0 への移行警告
// （docs/activate-sugar-implementation.md）。

const CONFIGS = `
class Repo { tag() { return "default"; } }
class PgRepo extends Repo { tag() { return "pg"; } }
class MockRepo extends Repo { tag() { return "mock"; } }
class Service { injectable repo: Repo; }
configuration Test { bind Repo = MockRepo; }
configuration Production { bind Repo = PgRepo; }
`;

describe("実行時選択: extends (条件木)", () => {
  it("グローバル位置では applier を値として選ぶ形に脱糖される", () => {
    const out = transpileDisonToTS(`${CONFIGS}
const isTest = false;
configuration extends (isTest ? Test : Production) {}
`);
    expect(out).toContain("__disonApplyToGlobal(isTest ? __dison_config_Test : __dison_config_Production);");
    // 葉は「値として」参照されるので、グローバル位置でも applier が必要。
    expect(out).toContain("export function __dison_config_Test(");
    expect(out).toContain("export function __dison_config_Production(");
  });

  it("両分岐が実行時に効く", () => {
    const program = (isTest: string) => `${CONFIGS}
const isTest = ${isTest};
configuration extends (isTest ? Test : Production) {}
export const results = [new Service().repo.tag()];
`;
    expect(runGenerated(program("true")).results).toEqual(["mock"]);
    expect(runGenerated(program("false")).results).toEqual(["pg"]);
  });

  it("ローカルスコープに置くとブロック終端で元に戻る", () => {
    const program = `${CONFIGS}
const isTest = true;
configuration extends (isTest ? Production : Test) {}
export function inner(): string {
  configuration extends (isTest ? Test : Production) {}
  return new Service().repo.tag();
}
export const results = [inner(), new Service().repo.tag()];
`;
    const out = transpileDisonToTS(program);
    expect(out).toContain("(isTest ? __dison_config_Test : __dison_config_Production)(__disonBind, __disonOverride);");
    // ブロック内は Test、抜けたらグローバル側の選択（Production）に戻る。
    expect(runGenerated(program).results).toEqual(["mock", "pg"]);
  });

  it("クラススコープに置ける", () => {
    const program = `${CONFIGS}
const isTest = true;
class Scoped {
  injectable repo: Repo;
  configuration extends (isTest ? Test : Production) {}
}
export const results = [new Scoped().repo.tag(), new Service().repo.tag()];
`;
    expect(runGenerated(program).results).toEqual(["mock", "default"]);
  });

  it("入れ子の条件木を扱える", () => {
    const program = `${CONFIGS}
class DevRepo extends Repo { tag() { return "dev"; } }
configuration Dev { bind Repo = DevRepo; }
const mode = "dev";
configuration extends (mode === "test" ? Test : mode === "dev" ? Dev : Production) {}
export const results = [new Service().repo.tag()];
`;
    expect(runGenerated(program).results).toEqual(["dev"]);
  });

  it("条件部分に三項演算子が入っても葉を正しく取り出す", () => {
    const out = transpileDisonToTS(`${CONFIGS}
const n = 1;
configuration extends ((n ? 1 : 2) === 1 ? Test : Production) {}
`);
    expect(out).toContain("__disonApplyToGlobal((n ? 1 : 2) === 1 ? __dison_config_Test : __dison_config_Production);");
  });

  it("静的解決は全葉を動的維持にし、候補を --explain に出す", () => {
    const report = explainWiring(`${CONFIGS}
const isTest = false;
configuration extends (isTest ? Test : Production) {}
`);
    expect(report[0]).toContain("runtime lookup");
    expect(report[0]).toContain("configuration selected at runtime among {Test, Production}");
  });

  it("--no-static と実行結果が一致する", () => {
    const program = `${CONFIGS}
const isTest = true;
configuration extends (isTest ? Test : Production) {}
export const results = [new Service().repo.tag()];
`;
    expect(runGenerated(program).results).toEqual(["mock"]);
    expect(runGenerated(program, { staticResolution: false }).results).toEqual(["mock"]);
  });

  it("葉が configuration 名でなければパースエラー", () => {
    expect(() =>
      transpileDisonToTS(`configuration A {}\nconfiguration extends (cond ? A : makeConfig()) {}`)
    ).toThrow(/must be a single configuration name/);
  });

  it("同じ葉を二度書くとパースエラー", () => {
    expect(() =>
      transpileDisonToTS(`configuration A {}\nconfiguration extends (cond ? A : A) {}`)
    ).toThrow(/appears twice/);
  });
});

describe("実行時選択と被覆チェック（既定初期化式の省略）", () => {
  const IFACE = `
interface IRepo { tag(): string; }
class PgRepo implements IRepo { tag() { return "pg"; } }
class MockRepo implements IRepo { tag() { return "mock"; } }
class Service { injectable repo: IRepo; }
`;

  it("全ての葉が束縛していれば省略できる", () => {
    const out = transpileDisonToTS(`${IFACE}
configuration Test { bind IRepo = MockRepo; }
configuration Production { bind IRepo = PgRepo; }
const isTest = false;
configuration extends (isTest ? Test : Production) {}
`);
    expect(out).toContain("__disonApplyToGlobal");
  });

  it("一つでも束縛しない葉があれば保証されない（エラー）", () => {
    expect(() =>
      transpileDisonToTS(`${IFACE}
configuration Test { bind IRepo = MockRepo; }
configuration Production { }
const isTest = false;
configuration extends (isTest ? Test : Production) {}
`)
    ).toThrow(/no binding for it is guaranteed to be active/);
  });
});

describe("3.0: 非トップレベルの activate は移行エラー", () => {
  it("関数の中の activate はエラーになり、書き換え先を示す", () => {
    let err: Error | undefined;
    try {
      transpileDisonToTS(`${CONFIGS}\nexport function enable(): void { activate Test; }`);
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toContain("is inside a block");
    expect(err?.message).toContain("configuration extends Test {}");
    expect(err?.message).toContain("configuration extends (cond ? Test : Other) {}");
  });

  it("条件分岐の中の activate もエラーになる", () => {
    expect(() =>
      transpileDisonToTS(`${CONFIGS}\nif (true) { activate Test; }`)
    ).toThrow(/is inside a block/);
  });

  it("トップレベルの activate は従来どおり動く", () => {
    const mod = runGenerated(`${CONFIGS}
console.log("barrier");
activate Test;
export const results = [new Service().repo.tag()];
`);
    expect(mod.results).toEqual(["mock"]);
  });

  it("クラス本体の activate はクラススコープになる（3.0 で解禁）", () => {
    const mod = runGenerated(`${CONFIGS}
class Scoped {
  injectable repo: Repo;
  activate Test;
}
export const results = [new Scoped().repo.tag(), new Service().repo.tag()];
`);
    expect(mod.results).toEqual(["mock", "default"]);
  });
});
