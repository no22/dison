import { describe, it, expect } from "vitest";
import { transpileDisonToTS } from "./core";
import { runGenerated } from "./test-helpers";

// configuration の継承（docs/configuration-inheritance.md）。
// 優先順位・多重継承・菱形・衝突検出・3スコープへの展開を検証する。

describe("configuration extends: 優先順位", () => {
  const program = `
class Repo { tag() { return "real"; } }
class PgRepo extends Repo { tag() { return "pg"; } }
class MemRepo extends Repo { tag() { return "mem"; } }
class Clock { now() { return "sys"; } }
class Frozen extends Clock { now() { return "frozen"; } }
class S { injectable repo: Repo; injectable clock: Clock; }
configuration Production { bind Repo = PgRepo; }
configuration Test extends Production { bind Clock = Frozen; }
activate Test;
export const results = [new S().repo.tag(), new S().clock.now()];
`;

  it("親のエントリを継ぎ、子の差分だけを書ける", () => {
    const out = transpileDisonToTS(program);
    expect(out).toContain("this._repo = new PgRepo();");
    expect(out).toContain("this._clock = new Frozen();");
  });

  it("同じキーは子が勝つ", () => {
    const out = transpileDisonToTS(`
class Repo {}
class PgRepo extends Repo {}
class MemRepo extends Repo {}
class S { injectable repo: Repo; }
configuration Production { bind Repo = PgRepo; }
configuration Test extends Production { bind Repo = MemRepo; }
activate Test;
`);
    expect(out).toContain("this._repo = new MemRepo();");
  });

  it("多重継承では右の親が勝つ", () => {
    const out = transpileDisonToTS(`
class Repo {}
class A extends Repo {}
class B extends Repo {}
class S { injectable repo: Repo; }
configuration Left { bind Repo = A; }
configuration Right { bind Repo = B; }
configuration Both extends Left, Right { bind Repo = B; }
activate Both;
`);
    expect(out).toContain("this._repo = new B();");
  });

  it("実行結果は --no-static と一致する", () => {
    const folded = runGenerated(program);
    const dynamic = runGenerated(program, { staticResolution: false });
    expect(folded.results).toEqual(["pg", "frozen"]);
    expect(dynamic.results).toEqual(["pg", "frozen"]);
  });

  it("動的パスでは親の activate を呼ぶ形に脱糖される", () => {
    const out = transpileDisonToTS(program, { staticResolution: false });
    expect(out).toContain("export function activateTest() {");
    expect(out).toContain("  activateProduction();");
  });
});

describe("configuration extends: 診断", () => {
  it("兄弟が同じキーを別々に束縛し、子が上書きしていなければエラー", () => {
    expect(() =>
      transpileDisonToTS(`
class Repo {}
class A extends Repo {}
class B extends Repo {}
class S { injectable repo: Repo; }
configuration Left { bind Repo = A; }
configuration Right { bind Repo = B; }
configuration Both extends Left, Right {}
activate Both;
`)
    ).toThrow(/both wire bind "Repo"/);
  });

  it("子が明示的に上書きすれば兄弟衝突は解消する", () => {
    const out = transpileDisonToTS(`
class Repo {}
class A extends Repo {}
class B extends Repo {}
class S { injectable repo: Repo; }
configuration Left { bind Repo = A; }
configuration Right { bind Repo = B; }
configuration Both extends Left, Right { bind Repo = A; }
activate Both;
`);
    expect(out).toContain("this._repo = new A();");
  });

  it("菱形継承（共通祖先からの同一束縛）は衝突にならない", () => {
    const out = transpileDisonToTS(`
class Repo {}
class BaseImpl extends Repo {}
class S { injectable repo: Repo; }
configuration Base { bind Repo = BaseImpl; }
configuration Left extends Base {}
configuration Right extends Base {}
configuration Both extends Left, Right {}
activate Both;
`);
    expect(out).toContain("this._repo = new BaseImpl();");
  });

  it("循環はエラー", () => {
    expect(() =>
      transpileDisonToTS(`
class Repo {}
class A extends Repo {}
class S { injectable repo: Repo; }
configuration X extends Y { bind Repo = A; }
configuration Y extends X {}
activate X;
`)
    ).toThrow(/cycle/);
  });

  it("自分自身を extends するとパースエラー", () => {
    expect(() => transpileDisonToTS(`configuration X extends X {}`)).toThrow(/cannot extend itself/);
  });

  it("未定義の configuration を extends すると解決エラー（単一ファイル）", () => {
    // パーサは寛容（複数ファイルでは他ファイルの configuration を import 無しで
    // 参照できるため）。実在チェックは単一ファイルなら core、複数ファイルなら CLI が行う。
    expect(() => transpileDisonToTS(`configuration X extends Nope {}`)).toThrow(/could not be resolved/);
  });

  it("同じ親を二度書くとパースエラー", () => {
    expect(() =>
      transpileDisonToTS(`configuration A {}\nconfiguration B extends A, A {}`)
    ).toThrow(/listed twice/);
  });

  it('"extends" という名前の configuration は activate の既知名に登録されない', () => {
    // configuration extends A {} の "extends" が config 名として誤登録されると、
    // activate extends; がパースエラーにならなくなってしまう（§1.1 の既知バグ）。
    expect(() =>
      transpileDisonToTS(`configuration A {}\nconfiguration extends A {}\nactivate extends;`)
    ).toThrow(/is not defined/);
  });
});

describe("configuration extends: 位置による展開（無名 + extends）", () => {
  it("トップレベルへの展開はグローバル配線になる", () => {
    const program = `
class Repo { tag() { return "real"; } }
class PgRepo extends Repo { tag() { return "pg"; } }
class S { injectable repo: Repo; }
configuration Production { bind Repo = PgRepo; }
configuration extends Production {}
export const results = [new S().repo.tag()];
`;
    const out = transpileDisonToTS(program);
    expect(out).toContain("this._repo = new PgRepo();");
    expect(runGenerated(program).results).toEqual(["pg"]);
    expect(runGenerated(program, { staticResolution: false }).results).toEqual(["pg"]);
  });

  it("クラス本体への展開はクラススコープになり、他クラスを汚染しない", () => {
    const program = `
class Repo { tag() { return "real"; } }
class MemRepo extends Repo { tag() { return "mem"; } }
class Wiring { }
configuration TestWiring { bind Repo = MemRepo; }
class Scoped {
  injectable repo: Repo;
  configuration extends TestWiring {}
}
class Other { injectable repo: Repo; }
export const results = [new Scoped().repo.tag(), new Other().repo.tag()];
`;
    const out = transpileDisonToTS(program);
    expect(out).toContain("this._repo = new MemRepo();"); // Scoped
    expect(out).toContain("this._repo = new Repo();"); // Other は影響を受けない
    expect(runGenerated(program).results).toEqual(["mem", "real"]);
    expect(runGenerated(program, { staticResolution: false }).results).toEqual(["mem", "real"]);
  });

  it("関数本体への展開はローカルスコープになり、ブロックを抜けると元に戻る", () => {
    const program = `
class Repo { tag() { return "real"; } }
class MemRepo extends Repo { tag() { return "mem"; } }
class S { injectable repo: Repo; }
configuration TestWiring { bind Repo = MemRepo; }
export function underTest(): string {
  configuration extends TestWiring {}
  return new S().repo.tag();
}
export const results = [underTest(), new S().repo.tag()];
`;
    const out = transpileDisonToTS(program);
    // ローカルスコープなので動的維持され、applier 経由で展開される。
    expect(out).toContain("__disonEnterScopeLazy");
    expect(out).toContain("__dison_config_TestWiring(__disonBind, __disonOverride);");
    expect(out).toContain("export function __dison_config_TestWiring(");
    expect(runGenerated(program).results).toEqual(["mem", "real"]);
    expect(runGenerated(program, { staticResolution: false }).results).toEqual(["mem", "real"]);
  });

  it("差分つきで展開できる", () => {
    const program = `
class Repo { tag() { return "real"; } }
class MemRepo extends Repo { tag() { return "mem"; } }
class Clock { now() { return "sys"; } }
class Frozen extends Clock { now() { return "frozen"; } }
class S { injectable repo: Repo; injectable clock: Clock; }
configuration TestWiring { bind Repo = MemRepo; }
configuration extends TestWiring { bind Clock = Frozen; }
export const results = [new S().repo.tag(), new S().clock.now()];
`;
    expect(runGenerated(program).results).toEqual(["mem", "frozen"]);
    expect(runGenerated(program, { staticResolution: false }).results).toEqual(["mem", "frozen"]);
  });

  it("applier を使う configuration も、全畳み時は空関数として残る", () => {
    const out = transpileDisonToTS(`
class Repo {}
class MemRepo extends Repo {}
configuration TestWiring { bind Repo = MemRepo; }
class Scoped {
  injectable repo: Repo;
  configuration extends TestWiring {}
}
`);
    expect(out).toContain("this._repo = new MemRepo();");
    expect(out).toContain("export function __dison_config_TestWiring(");
    expect(out).not.toContain("DI_REGISTRY");
  });
});
