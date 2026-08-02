import { describe, it, expect } from "vitest";
import { transpileDisonToTS, explainWiring } from "./core";
import { runGenerated } from "./test-helpers";

// 配線の静的解決（docs/static-resolution-design.md フェーズ1: 単一ファイル・L0+L1）。
// 生成形（畳み込み・prelude消去・登録文削除）と、動的維持の判定（taint）、
// 両モードの実行時等価性、--explain レポートを検証する。

describe("静的解決 L0: 配線が無いキーは既定初期化式に畳む", () => {
  it("配線ゼロのファイルはランタイム前置きが一切出ない", () => {
    const out = transpileDisonToTS(`
class Repo { name = "real"; }
class S { injectable repo: Repo; }
`);
    expect(out).toContain("this._repo = new Repo();");
    expect(out).not.toContain("DI_REGISTRY");
    expect(out).not.toContain("TYPE_BINDINGS");
    expect(out).not.toContain("__disonResolveInjectable");
    expect(out).not.toContain("__dison_scope_");
    expect(out).not.toContain("node:async_hooks");
  });

  it("既定初期化式は括弧で包んで畳まれる", () => {
    const out = transpileDisonToTS(`
interface IRepo { find(): string; }
class Impl implements IRepo { find() { return "x"; } }
class S { injectable repo: IRepo = new Impl(); }
`);
    expect(out).toContain("this._repo = (new Impl());");
  });

  it("遅延性は保存される（式の評価は初回アクセス時）", () => {
    const mod = runGenerated(`
export const log: string[] = [];
class Dep { constructor() { log.push("constructed"); } }
class S { injectable dep: Dep; }
export const s = new S();
export function touch() { return s.dep; }
`);
    expect(mod.log).toEqual([]); // 構築だけでは評価されない
    mod.touch();
    expect(mod.log).toEqual(["constructed"]);
  });
});

describe("静的解決 L1: 宣言的ヘッダの配線は最終状態に畳む", () => {
  it("無名configurationのbindは直接構築に畳まれ、前方参照もゲッター内で解決する", () => {
    const out = transpileDisonToTS(`
configuration { bind Repo = MockRepo; }
class Repo { name = "real"; }
class MockRepo extends Repo { name = "mock"; }
class S { injectable repo: Repo; }
`);
    expect(out).toContain("this._repo = new MockRepo();");
    expect(out).not.toContain("bindTypeLazy");
    expect(out).not.toContain("DI_REGISTRY");
  });

  it("名前付き+トップレベルactivateも畳まれ、登録は空関数として残る", () => {
    const out = transpileDisonToTS(`
configuration Cfg { bind Repo = MockRepo; }
activate Cfg;
class Repo {}
class MockRepo extends Repo {}
class S { injectable repo: Repo; }
`);
    expect(out).toContain("this._repo = new MockRepo();");
    // activate 呼び出しの形は維持しつつ、中身は空になる。
    expect(out).toContain("export function activateCfg() {\n}");
    expect(out).toContain("activateCfg();");
    expect(out).not.toContain("bindTypeLazy");
  });

  it("bindチェーンは終端まで辿り、引数は終端のみ有効（#5）", () => {
    const out = transpileDisonToTS(`
configuration { bind A = B("dropped"); bind B = C; }
class A { tag = "a"; }
class B extends A { constructor(x?: string) { super(); } }
class C extends B { tag = "c"; }
class S { injectable value: A; }
`);
    expect(out).toContain("this._value = new C();");
  });

  it("チェーン終端の引数は保持される", () => {
    const out = transpileDisonToTS(`
configuration { bind A = B("kept"); }
class A { tag = "a"; }
class B extends A { constructor(public x: string) { super(); } }
class S { injectable value: A; }
`);
    expect(out).toContain('this._value = new B("kept");');
  });

  it("overrideの畳み込みは継承鎖のchild-winsを再現する（#2）", () => {
    const out = transpileDisonToTS(`
configuration { override Base { dep = new M2(); } }
class M1 { tag = "m1"; }
class M2 extends M1 { tag = "m2"; }
class Base { injectable dep: M1; }
class Sub extends Base {}
`);
    // Base のゲッターに畳まれ、Sub は継承でそのまま同じ勝者になる。
    expect(out).toContain("this._dep = (new M2());");
  });

  it("同一キーへの複数bindは後勝ち（登録順を保存）", () => {
    const out = transpileDisonToTS(`
configuration { bind Repo = M1; }
configuration { bind Repo = M2; }
class Repo {}
class M1 extends Repo {}
class M2 extends Repo {}
class S { injectable repo: Repo; }
`);
    expect(out).toContain("this._repo = new M2();");
  });

  it("トップレベルのstandalone bindも畳まれ、文自体は消える", () => {
    const out = transpileDisonToTS(`
bind Repo = MockRepo;
class Repo {}
class MockRepo extends Repo {}
class S { injectable repo: Repo; }
`);
    expect(out).toContain("this._repo = new MockRepo();");
    expect(out).not.toContain("bindTypeLazy");
  });

  it("リテラルのみのconst宣言は配線ヘッダを分断しない（バリアにならない）", () => {
    const out = transpileDisonToTS(`
const url = "postgres://localhost/db";
bind Repo = PgRepo(url);
class Repo {}
class PgRepo extends Repo { constructor(public u?: string) { super(); } }
class S { injectable repo: Repo; }
`);
    expect(out).toContain("this._repo = new PgRepo(url);");
  });
});

describe("静的解決: 動的維持の判定（taint）", () => {
  it("実行文の後の配線は畳まれない（L1のバリア）", () => {
    const out = transpileDisonToTS(`
class Repo { name = "real"; }
class MockRepo extends Repo { name = "mock"; }
class S { injectable repo: Repo; }
console.log(new S().repo.name);
configuration { bind Repo = MockRepo; }
`);
    expect(out).toContain("__disonResolveInjectable");
    expect(out).toContain("bindTypeLazy");
    expect(out).toContain("DI_REGISTRY"); // prelude は残る
  });

  it("ローカルスコープで束縛されるキーは畳まれない", () => {
    const out = transpileDisonToTS(`
class Repo { name = "real"; }
class MockRepo extends Repo { name = "mock"; }
class S { injectable repo: Repo; }
function test() {
  configuration { bind Repo = MockRepo; }
  return new S().repo.name;
}
`);
    expect(out).toContain("__disonResolveInjectable");
    expect(out).toContain("__disonEnterScopeLazy");
  });

  it("クラススコープの配線はL1.5で畳まれる（フレームごと消える）", () => {
    const out = transpileDisonToTS(`
class Repo {}
class Cached extends Repo {}
class S {
  injectable repo: Repo;
  configuration { bind Repo = Cached; }
}
`);
    expect(out).toContain("this._repo = new Cached();");
    expect(out).not.toContain("__disonBuildFrameLazy");
    expect(out).not.toContain("DI_REGISTRY");
  });

  it("関数内のactivateがある名前付きconfigurationの配線は畳まれない", () => {
    const out = transpileDisonToTS(`
configuration Cfg { bind Repo = MockRepo; }
class Repo {}
class MockRepo extends Repo {}
class S { injectable repo: Repo; }
function enable() { activate Cfg; }
`);
    expect(out).toContain("__disonResolveInjectable");
    expect(out).toContain("bindTypeLazy");
  });

  it("サブクラスを対象にしたoverrideがあると親のゲッターは畳まれない（勝者分岐）", () => {
    const out = transpileDisonToTS(`
configuration { override Sub { dep = new M2(); } }
class M1 {}
class M2 extends M1 {}
class Base { injectable dep: M1; }
class Sub extends Base {}
`);
    expect(out).toContain("__disonResolveInjectable");
  });

  it("mixin継承（extendsが式）のクラスのinjectableは畳まれない", () => {
    const out = transpileDisonToTS(`
class M1 {}
function mixin(b: any) { return b; }
class Base {}
class C extends mixin(Base) { injectable dep: M1; }
`);
    expect(out).toContain("__disonResolveInjectable");
  });

  it("ローカルスコープがあるファイルでは、依存先が動的なゲッターも畳まれない（推移的taint）", () => {
    const out = transpileDisonToTS(`
class Inner { name = "real"; }
class MockInner extends Inner {}
class Wrapper { injectable inner: Inner; }
class Outer { injectable wrapper: Wrapper; }
function test() {
  configuration { bind Inner = MockInner; }
  return new Outer().wrapper.inner;
}
`);
    // Inner はローカル束縛 → Wrapper.inner が動的 → Wrapper を構築する
    // Outer.wrapper も動的に降格する（スコープ捕捉の差を塞ぐ。設計 §3.2）。
    const explain = explainWiring(`
class Inner { name = "real"; }
class MockInner extends Inner {}
class Wrapper { injectable inner: Inner; }
class Outer { injectable wrapper: Wrapper; }
function test() {
  configuration { bind Inner = MockInner; }
  return new Outer().wrapper.inner;
}
`);
    expect(explain.find((l) => l.startsWith("Outer.wrapper"))).toContain("dynamic");
    expect(out).toContain("__disonResolveInjectable");
  });

  it("スコープが無いファイルでは依存の入れ子があっても畳まれる（lax regime）", () => {
    const out = transpileDisonToTS(`
class Inner {}
class Wrapper { injectable inner: Inner; }
class Outer { injectable wrapper: Wrapper; }
`);
    expect(out).toContain("this._inner = new Inner();");
    expect(out).toContain("this._wrapper = new Wrapper();");
    expect(out).not.toContain("DI_REGISTRY");
  });

  it("static初期化子を持つクラス宣言はバリアになる", () => {
    const out = transpileDisonToTS(`
class Probe { static seen = probe(); }
function probe() { return 1; }
configuration { bind Repo = MockRepo; }
class Repo {}
class MockRepo extends Repo {}
class S { injectable repo: Repo; }
`);
    // Probe の static 初期化式が configuration より前に実行されるため、
    // 配線はプレバリアではなくなり畳まれない。
    expect(out).toContain("__disonResolveInjectable");
  });
});

describe("静的解決 L1.5: クラススコープの静的勝者化", () => {
  it("クラススコープの override も畳まれ、グローバル override より優先される（scope-major）", () => {
    const out = transpileDisonToTS(`
configuration { override S { dep = new G(); } }
class M {}
class G extends M {}
class C2 extends M {}
class S {
  injectable dep: M;
  configuration { override S { dep = new C2(); } }
}
`);
    expect(out).toContain("this._dep = (new C2());");
  });

  it("グローバル override はクラススコープ bind より優先される（override層が先）", () => {
    const out = transpileDisonToTS(`
configuration { override S { dep = new G(); } }
class M {}
class G extends M {}
class C2 extends M {}
class S {
  injectable dep: M;
  configuration { bind M = C2; }
}
`);
    expect(out).toContain("this._dep = (new G());");
  });

  it("親クラスのフレームは子の解決にも効く（継承）", () => {
    const program = `
class Repo { tag = "real"; }
class Cached extends Repo { tag = "cached"; }
class Base {
  injectable repo: Repo;
  configuration { bind Repo = Cached; }
}
class Sub extends Base {}
export const results = [new Base().repo.tag, new Sub().repo.tag];
`;
    const out = transpileDisonToTS(program);
    expect(out).toContain("this._repo = new Cached();");
    const folded = runGenerated(program);
    const dynamic = runGenerated(program, { staticResolution: false });
    expect(folded.results).toEqual(["cached", "cached"]);
    expect(dynamic.results).toEqual(["cached", "cached"]);
  });

  it("サブクラス側のフレームが同じキーを配線すると勝者分岐で畳まれない（差分継承）", () => {
    const program = `
class Repo { tag = "real"; }
class A extends Repo { tag = "a"; }
class B extends Repo { tag = "b"; }
class Base {
  injectable repo: Repo;
  configuration { bind Repo = A; }
}
class Sub extends Base {
  configuration { bind Repo = B; }
}
export const results = [new Base().repo.tag, new Sub().repo.tag];
`;
    const out = transpileDisonToTS(program);
    expect(out).toContain("__disonResolveInjectable"); // Base.repo は動的維持
    const folded = runGenerated(program);
    const dynamic = runGenerated(program, { staticResolution: false });
    expect(folded.results).toEqual(["a", "b"]);
    expect(dynamic.results).toEqual(["a", "b"]);
  });

  it("同一クラス内の複数フレームは後勝ち（#6 を静的に再現）", () => {
    const out = transpileDisonToTS(`
class Repo {}
class M1 extends Repo {}
class M2 extends Repo {}
class S {
  injectable repo: Repo;
  configuration { bind Repo = M1; }
  configuration { bind Repo = M2; }
}
`);
    expect(out).toContain("this._repo = new M2();");
  });

  it("他クラスのフレームは無関係な同キー injectable を汚染しない（v1 からの精密化）", () => {
    // v1 はクラススコープの bind をキー単位でグローバルに taint していたため、
    // D.q も動的に落ちていた。実行時にはフレームは受け手自身の鎖にしか効かない
    // （runtime.ts __disonResolveInjectable がクラスコンテキストを置き換える）ので、
    // D.q は既定式に畳んでよい。
    const program = `
class Repo { tag = "real"; }
class Cached extends Repo { tag = "cached"; }
class X {
  injectable p: Repo;
  configuration { bind Repo = Cached; }
}
class D { injectable q: Repo; }
export const results = [new X().p.tag, new D().q.tag];
`;
    const out = transpileDisonToTS(program);
    expect(out).toContain("this._p = new Cached();");
    expect(out).toContain("this._q = new Repo();");
    expect(out).not.toContain("DI_REGISTRY");
    const folded = runGenerated(program);
    const dynamic = runGenerated(program, { staticResolution: false });
    expect(folded.results).toEqual(["cached", "real"]);
    expect(dynamic.results).toEqual(["cached", "real"]);
  });

  it("bind チェーンはフレーム層とグローバル層をホップ毎に跨いで辿る", () => {
    const program = `
configuration { bind Cached = Distributed; }
class Repo { tag = "real"; }
class Cached extends Repo { tag = "cached"; }
class Distributed extends Cached { tag = "dist"; }
class S {
  injectable repo: Repo;
  configuration { bind Repo = Cached; }
}
export const results = [new S().repo.tag];
`;
    const out = transpileDisonToTS(program);
    // フレームで Repo→Cached、グローバルで Cached→Distributed。
    expect(out).toContain("this._repo = new Distributed();");
    const folded = runGenerated(program);
    const dynamic = runGenerated(program, { staticResolution: false });
    expect(folded.results).toEqual(["dist"]);
    expect(dynamic.results).toEqual(["dist"]);
  });

  it("クラススコープの存在だけでは strict regime を発動しない（解析不能な既定式も畳める）", () => {
    const out = transpileDisonToTS(`
function makeRepo() { return { find: () => "x" }; }
interface IRepo { find(): string; }
class X {
  injectable other: X2 = new X2();
  configuration { bind X2 = X2; }
}
class X2 {}
class S { injectable repo: IRepo = makeRepo(); }
`);
    // v1 ではクラススコープの存在が strict regime を発動し、makeRepo() が opaque で
    // 動的に落ちていた。L1.5 ではクラススコープは捕捉差を生まないので畳める。
    expect(out).toContain("this._repo = (makeRepo());");
  });
});

describe("静的解決 L2: mention 解析（フェーズ3）", () => {
  it("バリアと無関係なキーの配線は実行文の後でも畳める（02サンプルの形）", () => {
    const out = transpileDisonToTS(`
interface Repository<T> { find(): T; }
class RealRepo implements Repository<{ id: string }> { find() { return { id: "real" }; } }
class MockRepo implements Repository<{ id: string }> { find() { return { id: "mock" }; } }
class UserService { injectable repo: Repository<{ id: string }> = new RealRepo(); }
configuration TestConfig { bind Repository<{ id: string }> = MockRepo; }
activate TestConfig;
console.log(new UserService().repo.find());
class A { tag = "a"; }
class B extends A { tag = "b"; }
class C extends B { tag = "c"; }
class Chained { injectable value: A; }
configuration ChainConfig { bind A = B; bind B = C; }
activate ChainConfig;
console.log(new Chained().value.tag);
`);
    expect(out).toContain("this._repo = new MockRepo();");
    expect(out).toContain("this._value = new C();");
    expect(out).not.toContain("DI_REGISTRY"); // 全畳み → prelude 消去
  });

  it("バリアが使う（言及閉包に入る）同じキーのバリア後配線は畳めない", () => {
    const report = explainWiring(`
class Repo {}
class Mock extends Repo {}
class S { injectable repo: Repo; }
console.log(new S().repo);
bind Repo = Mock;
`);
    expect(report[0]).toContain("[dynamic:");
    expect(report[0]).toContain("may resolve this key");
  });

  it("関数呼び出し経由の間接的な使用も閉包が捕捉する", () => {
    // バリアは f だけに言及するが、f の本体が S に言及する → S のキーは使用扱い。
    const report = explainWiring(`
class Repo {}
class Mock extends Repo {}
class S { injectable repo: Repo; }
function f() { return new S().repo; }
f();
bind Repo = Mock;
`);
    expect(report[0]).toContain("[dynamic:");
  });

  it("const に格納したクラスの計算アクセス構築も閉包が捕捉する", () => {
    // 格納文が S に言及するため、m を言及するバリアの閉包に S が入る。
    const report = explainWiring(`
class Repo {}
class Mock extends Repo {}
class S { injectable repo: Repo; }
const m = { c: S };
console.log(new m.c().repo);
bind Repo = Mock;
`);
    expect(report[0]).toContain("[dynamic:");
  });

  it("bind チェーンの中継キーへのバリア後配線も塞がれる", () => {
    // バリアは S（キー Repo）を使用。Repo は M に bind されるので、解決は M の
    // キーへも波及する。バリア後の bind M = M2 を畳むと、バリア時点の解決（M）と
    // 最終状態（M2）が食い違うため動的でなければならない。
    const report = explainWiring(`
class Repo {}
class M extends Repo { tag = "m"; }
class M2 extends M { tag = "m2"; }
class S { injectable repo: Repo; }
bind Repo = M;
console.log(new S().repo);
bind M = M2;
`);
    expect(report[0]).toContain("[dynamic:");
  });

  it("globalThis に触れる文は全キーのバリアに落ちる", () => {
    const report = explainWiring(`
class Repo {}
class Mock extends Repo {}
class S { injectable repo: Repo; }
console.log((globalThis as any).anything);
bind Repo = Mock;
`);
    expect(report[0]).toContain("[dynamic:");
    expect(report[0]).toContain("executable top-level code");
  });

  it("プロジェクト外の相対 import の呼び出しは全キーのバリアに落ちる", () => {
    const report = explainWiring(`
import { helper } from "./helper";
class Repo {}
class Mock extends Repo {}
class S { injectable repo: Repo; }
helper();
bind Repo = Mock;
`);
    expect(report[0]).toContain("[dynamic:");
  });

  it("埋め込みテンプレートを含む文は言及が見えないため全キーのバリアに落ちる", () => {
    const report = explainWiring(
      "\nclass Repo {}\nclass Mock extends Repo {}\nclass S { injectable repo: Repo; }\n" +
        "console.log(`value: ${new S().repo}`);\nbind Repo = Mock;\n"
    );
    expect(report[0]).toContain("[dynamic:");
  });

  it("トップレベルの制御フロー文（ブロック）は全キーのバリアに落ちる", () => {
    const report = explainWiring(`
class Repo {}
class Mock extends Repo {}
class S { injectable repo: Repo; }
if (process.env.NODE_ENV) { console.log("hi"); }
bind Repo = Mock;
`);
    expect(report[0]).toContain("[dynamic:");
  });

  it("交錯した配線でも実行結果は --no-static と一致する", () => {
    const program = `
class Repo { tag = "real"; }
class Mock extends Repo { tag = "mock"; }
class S { injectable repo: Repo; }
export const first = new S().repo.tag;
class Late { tag = "late"; }
class LateMock extends Late { tag = "late-mock"; }
class U { injectable late: Late; }
configuration { bind Late = LateMock; }
export const second = new U().late.tag;
`;
    const folded = runGenerated(program);
    const dynamic = runGenerated(program, { staticResolution: false });
    expect(folded.first).toBe("real");
    expect(folded.second).toBe("late-mock");
    expect(dynamic.first).toBe("real");
    expect(dynamic.second).toBe("late-mock");
  });
});

describe("静的解決: 混在（一部だけ畳む）", () => {
  it("畳めるキーは畳み、畳めないキーはレジストリ経由のまま共存する", () => {
    const out = transpileDisonToTS(`
configuration { bind A = MockA; }
class A {}
class MockA extends A {}
class B { name = "real"; }
class MockB extends B {}
class S { injectable a: A; injectable b: B; }
function test() {
  configuration { bind B = MockB; }
  return new S().b;
}
`);
    // A は... ローカルスコープが存在するファイルなので strict regime。
    // MockA 自身は injectable を持たないので A は畳まれる。B はローカル束縛で動的。
    expect(out).toContain("this._a = new MockA();");
    expect(out).toContain('__disonResolveInjectable(this.__dison_scope_b, this.constructor, "b"');
    expect(out).toContain("DI_REGISTRY"); // 動的キーが残るので prelude は必要
  });
});

describe("静的解決: 実行時等価性（両モードで同じ挙動）", () => {
  const program = `
configuration { bind Repo = MockRepo; }
configuration Named { override S { extra = new Tag("named"); } }
activate Named;
class Repo { kind = "real"; }
class MockRepo extends Repo { kind = "mock"; }
class Tag { constructor(public label: string) {} }
class S {
  injectable repo: Repo;
  injectable extra: Tag = new Tag("default");
}
export const s = new S();
export const results = [s.repo.kind, s.extra.label];
`;

  it("畳んだ出力と--no-static出力が同じ結果になる", () => {
    const folded = runGenerated(program);
    const dynamic = runGenerated(program, { staticResolution: false });
    expect(folded.results).toEqual(["mock", "named"]);
    expect(dynamic.results).toEqual(["mock", "named"]);
  });

  it("動的と判定されたプログラムも従来どおり動く（activate前後の変化）", () => {
    const program2 = `
class Repo { kind = "real"; }
class MockRepo extends Repo { kind = "mock"; }
class S { injectable repo: Repo; }
export const before = new S().repo.kind;
configuration Cfg { override S { repo = new MockRepo(); } }
activate Cfg;
export const after = new S().repo.kind;
`;
    const folded = runGenerated(program2);
    const dynamic = runGenerated(program2, { staticResolution: false });
    expect(folded.before).toBe("real");
    expect(folded.after).toBe("mock");
    expect(dynamic.before).toBe("real");
    expect(dynamic.after).toBe("mock");
  });
});

describe("staticResolution: false（--no-static）", () => {
  it("従来の全レジストリ経由の生成形に固定される", () => {
    const out = transpileDisonToTS(`class Foo {}\nclass S { injectable dep: Foo; }`, {
      staticResolution: false,
    });
    expect(out).toContain("__disonResolveInjectable");
    expect(out).toContain("resolveType(Foo, () => new Foo())");
    expect(out).toContain("DI_REGISTRY");
  });
});

describe("explainWiring（--explain）", () => {
  it("staticの行には畳んだ式と由来、dynamicの行には理由が出る", () => {
    const report = explainWiring(`
configuration { bind Repo = MockRepo; }
class Repo {}
class MockRepo extends Repo {}
class S { injectable repo: Repo; }
console.log(new S().repo);
configuration { bind Repo = TooLate; }
class TooLate extends Repo {}
configuration { bind Late = LateMock; }
class Late {}
class LateMock extends Late {}
class U { injectable late: Late; }
`);
    // S.repo: バリア（console.log が S に言及）の後に同じキー Repo を配線し直して
    // いるため動的。
    const sLine = report.find((l) => l.startsWith("S.repo"))!;
    expect(sLine).toContain("runtime lookup");
    expect(sLine).toContain("[dynamic:");
    // U.late: バリアの後の配線だが、バリアの言及閉包（S→Repo）と無関係なキーなので
    // L2（mention 解析）で畳める。
    const uLine = report.find((l) => l.startsWith("U.late"))!;
    expect(uLine).toContain("new LateMock()");
    expect(uLine).toContain("[static:");
  });

  it("injectableが無ければ空", () => {
    expect(explainWiring(`class A {}\nconsole.log(new A());`)).toEqual([]);
  });
});
