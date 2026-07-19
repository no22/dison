import { describe, it, expect } from "vitest";
import { transpileDisonToTS } from "./core";
import { runGenerated } from "./test-helpers";

describe("ローカルスコープ configuration（docs/scoped-configuration.md フェーズ1）", () => {
  it("無名ローカルconfigurationは using __disonEnterScope に脱糖される", () => {
    const out = transpileDisonToTS(`
class Db {}
class MockDb extends Db {}
function f() { configuration { bind Db = MockDb; } }
`);
    expect(out).toContain("using __dison_scope_0 = __disonEnterScopeLazy((__disonBind, __disonOverride) => {");
    expect(out).toContain("__disonBind(() => Db, (): Db => resolveType(MockDb, () => new MockDb()));");
  });

  it("ローカルスコープ内では bind が効き、スコープ外ではグローバル（既定）に戻る", () => {
    const mod = runGenerated(`
class Db { n() { return "real"; } }
class MockDb extends Db { n() { return "mock"; } }
class S { injectable db: Db; }
function withMock(): string { configuration { bind Db = MockDb; } return new S().db.n(); }
module.exports = { inside: withMock(), outside: new S().db.n() };
`);
    expect(mod.inside).toBe("mock");
    expect(mod.outside).toBe("real");
  });

  it("スコープ内で構築し、初回アクセスがスコープ脱出後でも構築時のスコープに従う（構築時捕捉）", () => {
    const mod = runGenerated(`
class Db { n() { return "real"; } }
class MockDb extends Db { n() { return "mock"; } }
class S { injectable db: Db; }
function make(): S { configuration { bind Db = MockDb; } return new S(); }
const s = make();                 // スコープ内で構築、db未アクセス
module.exports = { v: s.db.n() }; // スコープ外で初回アクセス
`);
    expect(mod.v).toBe("mock");
  });

  it("スコープ外で構築したオブジェクトは、スコープ内でアクセスしてもグローバルのまま", () => {
    const mod = runGenerated(`
class Db { n() { return "real"; } }
class MockDb extends Db { n() { return "mock"; } }
class S { injectable db: Db; }
const s = new S();   // スコープ外で構築
function use(o: S): string { configuration { bind Db = MockDb; } return o.db.n(); }
module.exports = { v: use(s) };  // スコープ内でアクセスするが構築は外
`);
    expect(mod.v).toBe("real");
  });

  it("遅延構築される依存グラフ全体が root の構築スコープに一貫して従う", () => {
    const mod = runGenerated(`
class Log { t() { return "gLog"; } }
class SLog extends Log { t() { return "sLog"; } }
class Dep { d() { return "gDep"; } }
class MockDep extends Dep { injectable log: Log; d() { return "mock/" + this.log.t(); } }
class S { injectable dep: Dep; }
function make(): S { configuration { bind Dep = MockDep; bind Log = SLog; } return new S(); }
const s = make();
module.exports = { v: s.dep.d() };  // Mockは遅延構築(スコープ外)だが S のスコープを継ぐ
`);
    expect(mod.v).toBe("mock/sLog");
  });

  it("並行する2つの非同期スコープが互いに干渉しない（AsyncLocalStorage）", async () => {
    const mod = runGenerated(`
class Svc { who() { return "base"; } }
class A extends Svc { who() { return "A"; } }
class B extends Svc { who() { return "B"; } }
class S { injectable svc: Svc; }
async function req(which: "A" | "B"): Promise<string> {
  if (which === "A") { configuration { bind Svc = A; } await new Promise(r => setTimeout(r, 10)); return new S().svc.who(); }
  configuration { bind Svc = B; }
  await new Promise(r => setTimeout(r, 3));
  return new S().svc.who();
}
module.exports = { go: () => Promise.all([req("A"), req("B")]) };
`);
    const result = await mod.go();
    expect(result).toEqual(["A", "B"]);
  });

  it("ローカルスコープの override も効く", () => {
    const mod = runGenerated(`
class Base { n() { return "base"; } }
class Mock extends Base { n() { return "mock"; } }
class S { injectable dep: Base = new Base(); }
function withOverride(): string { configuration { override S { dep = new Mock(); } } return new S().dep.n(); }
module.exports = { inside: withOverride(), outside: new S().dep.n() };
`);
    expect(mod.inside).toBe("mock");
    expect(mod.outside).toBe("base");
  });

  it("ネストしたローカルスコープは内側が優先、内側に無ければ外側へフォールスルー", () => {
    const mod = runGenerated(`
class Db { n() { return "real"; } }
class Outer extends Db { n() { return "outer"; } }
class Inner extends Db { n() { return "inner"; } }
class Log { n() { return "gLog"; } }
class OuterLog extends Log { n() { return "outerLog"; } }
class S { injectable db: Db; injectable log: Log; }
function run(): { db: string; log: string } {
  configuration { bind Db = Outer; bind Log = OuterLog; }
  configuration { bind Db = Inner; }   // 内側は Db だけ差分
  const s = new S();
  return { db: s.db.n(), log: s.log.n() };
}
module.exports = run();
`);
    expect(mod.db).toBe("inner"); // 内側が優先
    expect(mod.log).toBe("outerLog"); // 内側に無い→外側へフォールスルー
  });
});

describe("クラススコープ configuration（docs/scoped-configuration.md フェーズ2）", () => {
  it("クラス本体直下の無名configurationは static __dison_classScope に脱糖される", () => {
    const out = transpileDisonToTS(`
class Db {}
class ClassDb extends Db {}
class S { injectable db: Db; configuration { bind Db = ClassDb; } }
`);
    expect(out).toContain("static __dison_classScope_0 = __disonBuildFrameLazy((__disonBind, __disonOverride) => {");
    expect(out).toContain("__disonBind(() => Db, (): Db => resolveType(ClassDb, () => new ClassDb()));");
  });

  it("クラススコープの bind がそのクラスのインスタンスの解決に効く", () => {
    const mod = runGenerated(`
class Db { n() { return "real"; } }
class ClassDb extends Db { n() { return "class"; } }
class S { injectable db: Db; configuration { bind Db = ClassDb; } }
module.exports = { v: new S().db.n() };
`);
    expect(mod.v).toBe("class");
  });

  it("子クラスは親のクラススコープを継ぐ（プロトタイプ鎖）", () => {
    const mod = runGenerated(`
class Db { n() { return "real"; } }
class ClassDb extends Db { n() { return "class"; } }
class Base { injectable db: Db; configuration { bind Db = ClassDb; } }
class Sub extends Base {}
module.exports = { v: new Sub().db.n() };
`);
    expect(mod.v).toBe("class");
  });

  it("子クラスは親のクラスconfigの一部だけ差分で上書きできる", () => {
    const mod = runGenerated(`
class A { n() { return "gA"; } }
class SA extends A { n() { return "superA"; } }
class ChA extends A { n() { return "childA"; } }
class B { n() { return "gB"; } }
class SB extends B { n() { return "superB"; } }
class Base { injectable a: A; injectable b: B; configuration { bind A = SA; bind B = SB; } }
class Child extends Base { configuration { bind A = ChA; } }
const c = new Child();
module.exports = { a: c.a.n(), b: c.b.n() };
`);
    expect(mod.a).toBe("childA"); // 子の差分
    expect(mod.b).toBe("superB"); // 親から継承
  });

  it("優先順位 ローカル > クラス > グローバル", () => {
    const mod = runGenerated(`
class Db { n() { return "real"; } }
class GDb extends Db { n() { return "global"; } }
class CDb extends Db { n() { return "class"; } }
class LDb extends Db { n() { return "local"; } }
configuration { bind Db = GDb; }
class S { injectable db: Db; configuration { bind Db = CDb; } }
function inLocal(): string { configuration { bind Db = LDb; } return new S().db.n(); }
module.exports = { local: inLocal(), classOnly: new S().db.n() };
`);
    expect(mod.local).toBe("local"); // ローカルが最優先
    expect(mod.classOnly).toBe("class"); // クラス > グローバル
  });

  it("クラススコープ内の bind 連鎖（A=B; B=C）が辿れる", () => {
    const mod = runGenerated(`
class A { n() { return "A"; } }
class B extends A { n() { return "B"; } }
class C extends A { n() { return "C"; } }
class S { injectable a: A; configuration { bind A = B; bind B = C; } }
module.exports = { v: new S().a.n() };
`);
    expect(mod.v).toBe("C");
  });

  it("クラススコープは依存に伝播しない（依存は自分のクラススコープを使う）", () => {
    const mod = runGenerated(`
class Log { t() { return "gLog"; } }
class DepLog extends Log { t() { return "depClassLog"; } }
class Dep { d() { return "gDep"; } }
class MockDep extends Dep { injectable log: Log; configuration { bind Log = DepLog; } d() { return "mock/" + this.log.t(); } }
class S { injectable dep: Dep; configuration { bind Dep = MockDep; } }
module.exports = { v: new S().dep.d() };
`);
    // S のクラススコープは Log を指定していないが、MockDep は自分のクラススコープで Log を解決する。
    expect(mod.v).toBe("mock/depClassLog");
  });

  it("クラススコープの override も効く", () => {
    const mod = runGenerated(`
class Base { n() { return "base"; } }
class Mock extends Base { n() { return "mock"; } }
class S { injectable dep: Base = new Base(); configuration { override S { dep = new Mock(); } } }
module.exports = { v: new S().dep.n() };
`);
    expect(mod.v).toBe("mock");
  });
});

describe("グローバル configuration の後方互換（スコープ導入後）", () => {
  it("名前付きグローバルconfiguration + activate は従来どおり効く", () => {
    const mod = runGenerated(`
class Base { n() { return "real"; } }
class Mock extends Base { n() { return "mock"; } }
class S { injectable dep: Base = new Base(); }
configuration Cfg { bind Base = Mock; }
activate Cfg;
module.exports = { v: (new S() as any).dep.n() };
`);
    expect(mod.v).toBe("mock");
  });

  it("無名グローバルconfigurationは auto-active（その場で即時グローバル適用）", () => {
    const out = transpileDisonToTS(`
class Base {}
class Mock extends Base {}
configuration { bind Base = Mock; }
`);
    // 関数化されず、その場に即時のグローバル bindType 呼び出しが出る（using脱糖はしない）。
    expect(out).toContain("bindTypeLazy<Base>(() => Base, () => resolveType(Mock, () => new Mock()));");
    expect(out).not.toContain("function activate");
    expect(out).not.toContain("using __dison_scope");
  });

  it("無名グローバルconfigurationが実行時に効く", () => {
    const mod = runGenerated(`
class Base { n() { return "real"; } }
class Mock extends Base { n() { return "mock"; } }
configuration { bind Base = Mock; }
class S { injectable dep: Base = new Base(); }
module.exports = { v: (new S() as any).dep.n() };
`);
    expect(mod.v).toBe("mock");
  });
});
