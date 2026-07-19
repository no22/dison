import { describe, it, expect } from "vitest";
import { runGenerated } from "./test-helpers";

// configurationの前方参照（docs/config-forward-reference.md）。
// 登録はキューに積まれ、キー式はサンクとして初回参照時に評価されるため、
// 同一ファイル内で後方宣言されたクラスをconfigurationが前方参照できる
// （従来はTDZのReferenceErrorになっていた。仕様監査2026-07 #3）。

describe("前方参照: 後方宣言クラスをキー位置で参照できる", () => {
  it("無名グローバルconfigurationのbindがクラス宣言より前に書ける", () => {
    const mod = runGenerated(`
configuration { bind Foo = Bar; }
class Foo { tag = "foo"; }
class Bar extends Foo { tag = "bar"; }
class S { injectable dep: Foo; }
module.exports = { v: (new S() as any).dep.tag };
`);
    expect(mod.v).toBe("bar");
  });

  it("無名グローバルconfigurationのoverrideが対象クラス宣言より前に書ける", () => {
    const mod = runGenerated(`
configuration { override S { dep = new Mock(); } }
class Mock { tag = "mock"; }
class S { injectable dep: Mock; }
module.exports = { v: (new S() as any).dep.tag };
`);
    expect(mod.v).toBe("mock");
  });

  it("単独bind（トップレベル）も前方参照できる", () => {
    const mod = runGenerated(`
bind Foo = Bar;
class Foo { tag = "foo"; }
class Bar extends Foo { tag = "bar"; }
class S { injectable dep: Foo; }
module.exports = { v: (new S() as any).dep.tag };
`);
    expect(mod.v).toBe("bar");
  });

  it("クラススコープconfigurationのbind左辺が後方宣言でもよい", () => {
    const mod = runGenerated(`
class S {
  injectable dep: Repo = new Repo();
  configuration { bind Repo = MockRepo; }
}
class Repo { tag = "real"; }
class MockRepo extends Repo { tag = "mock"; }
module.exports = { v: (new S() as any).dep.tag };
`);
    expect(mod.v).toBe("mock");
  });

  it("activateがクラス宣言より前でも動く（名前付きとの非対称性も解消）", () => {
    const mod = runGenerated(`
configuration Cfg { bind Foo = Bar; }
activate Cfg;
class Foo { tag = "foo"; }
class Bar extends Foo { tag = "bar"; }
class S { injectable dep: Foo; }
module.exports = { v: (new S() as any).dep.tag };
`);
    expect(mod.v).toBe("bar");
  });
});

describe("順序保存とブロック回避（ドレインアルゴリズム）", () => {
  it("遅延キュー経由の登録と後続のactivateが混在しても、後の登録が勝つ", () => {
    const mod = runGenerated(`
configuration { bind Foo = Bar; }
configuration Cfg { bind Foo = Baz; }
activate Cfg;
class Foo { tag = "foo"; }
class Bar extends Foo { tag = "bar"; }
class Baz extends Foo { tag = "baz"; }
class S { injectable dep: Foo; }
module.exports = { v: (new S() as any).dep.tag };
`);
    expect(mod.v).toBe("baz");
  });

  it("未宣言キーの登録が、無関係なキーの解決をブロックしない（seq＋再試行）", () => {
    const mod = runGenerated(`
configuration { bind A = LateA; }
configuration { bind K = MockK; }
class K { tag = "k"; }
class MockK extends K { tag = "mockK"; }
class SK { injectable dep: K; }
const early = (new SK() as any).dep.tag; // この時点で LateA は未宣言（Aの登録は保留のまま）
class A { tag = "a"; }
class LateA extends A { tag = "late"; }
class SA { injectable dep: A; }
module.exports = { early, late: (new SA() as any).dep.tag };
`);
    // Kのbindは、Aの登録（LateA未宣言で保留中）にブロックされず先に効く
    expect(mod.early).toBe("mockK");
    // LateA宣言後の解決では、保留されていたAの登録が適用される
    expect(mod.late).toBe("late");
  });

  it("保留エントリより後の同一キー登録が先に適用されても、最終状態はソース順（seq比較）", () => {
    const mod = runGenerated(`
configuration { bind A = LateA; }
class A { tag = "a"; }
class EarlyA extends A { tag = "early"; }
configuration { bind A = EarlyA; }
class SA { injectable dep: A; }
const before = (new SA() as any).dep.tag; // LateA未宣言: 保留、EarlyA(後の登録)が適用 → "early"
class LateA extends A { tag = "late"; }
const after = (new SA() as any).dep.tag;  // LateA宣言後: 保留分はseqが古いので適用されない
module.exports = { before, after };
`);
    expect(mod.before).toBe("early");
    // ソース順では bind A = LateA(先) → bind A = EarlyA(後) なので、最終的に EarlyA が勝つ
    expect(mod.after).toBe("early");
  });
});
