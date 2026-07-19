import { describe, it, expect } from "vitest";
import { transpileDisonToTS } from "./core";
import { runGenerated, extractKeys } from "./test-helpers";

describe("override", () => {
  it("registerOverride呼び出しが生成され、代入式は自動でnewされない", () => {
    const out = transpileDisonToTS(`
class Real {}
class Mock {}
configuration Cfg {
  override S {
    dep = Mock;
  }
}
`);
    expect(out).toContain('registerOverride(S, "dep", () => (Mock));');
  });

  it("override対象クラス名がスコープに無い（タイプミス）場合はtscが検出する", () => {
    // クラスの実体そのものをキーにするため、存在しない識別子を書くと
    // 生成コードがそもそも tsc の型チェックを通らなくなる
    // （従来は文字列一致のため何のエラーにもならなかった）。
    const out = transpileDisonToTS(`
class Service {}
configuration Cfg {
  override Servcie {
    dep = new Service();
  }
}
`);
    expect(out).toContain("registerOverride(Servcie,");
  });
});

describe("bind: 具象クラスは実体参照キー（docs/type-identity-matching.md 案A(a)）", () => {
  it("具象クラスの左辺・差し替え先はクラスの実体をキーにする（文字列リテラルにしない）", () => {
    const out = transpileDisonToTS(`
class Real {}
class Mock {}
configuration Cfg {
  bind Real = Mock;
}
`);
    // Real / Mock はどちらも具象クラスなので、"Real"/"Mock" ではなくクラスの
    // 実体参照そのものがキーになる。これにより複数ファイルで同名クラスが
    // 衝突しなくなる（手動tokenが不要）。
    expect(out).toContain('bindType<Real>(Real, () => resolveType(Mock, () => new Mock()));');
  });

  it("injectableの具象クラス型も実体参照キーになり、bindの左辺と一致する", () => {
    const out = transpileDisonToTS(`
class Real {}
class Mock {}
class S { injectable dep: Real; }
configuration Cfg { bind Real = Mock; }
`);
    // injectable側 resolveType のキーも bind側 bindType のキーも同じ実体 Real。
    expect(out).toContain("resolveType(Real, () => new Real())");
    expect(out).toContain("bindType<Real>(Real,");
  });

  it("interface/型エイリアスは companion Symbol でキー化される（案A(b)）", () => {
    const out = transpileDisonToTS(`
interface IRepo {}
class Impl implements IRepo {}
configuration Cfg { bind IRepo = Impl; }
`);
    // 左辺 IRepo は interface なので companion Symbol（宣言に対し自動生成）をキーに、
    // 差し替え先 Impl は具象クラスなので実体キー。DI利用されるので companion が emit される。
    expect(out).toContain('export const __dison_token_IRepo = Symbol("IRepo");');
    expect(out).toContain('bindType<IRepo>(__dison_token_IRepo, () => resolveType(Impl, () => new Impl()));');
  });

  it("abstract class は実行時に値を持つので companion ではなく実体参照キーになる", () => {
    const out = transpileDisonToTS(`
abstract class Repo { abstract who(): string; }
class Real extends Repo { who() { return "r"; } }
class Mock extends Repo { who() { return "m"; } }
class S { injectable dep: Repo = new Real(); }
configuration Cfg { bind Repo = Mock; }
`);
    // abstract class は new 不可だが値を持つため実体キー（companion は生成しない）。
    expect(out).not.toContain("__dison_token_Repo");
    expect(out).toContain("resolveType(Repo, () => (new Real()))");
    expect(out).toContain("bindType<Repo>(Repo, () => resolveType(Mock, () => new Mock()));");
  });

  it("DI利用されないローカルinterfaceには companion を emit しない（案2: DI利用のみ）", () => {
    const out = transpileDisonToTS(`
interface IUsed {}
interface IUnused { x: number; }
class Impl implements IUsed {}
class S { injectable dep: IUsed = new Impl(); }
`);
    expect(out).toContain("__dison_token_IUsed");
    expect(out).not.toContain("__dison_token_IUnused");
  });
});

describe("bind: コンストラクタ引数（docs/bind-constructor-arguments.md）", () => {
  it("差し替え先に引数を書くと new Replacement(args) が生成される", () => {
    const out = transpileDisonToTS(`
class Base {}
class WithConn extends Base { constructor(c: string) { super(); } }
configuration Cfg { bind Base = WithConn("prod://db"); }
`);
    expect(out).toContain('resolveType(WithConn, () => new WithConn("prod://db"))');
  });

  it("引数なし・空括弧はどちらも new Replacement() になる", () => {
    const out = transpileDisonToTS(`
class Base {}
class Plain extends Base {}
configuration Cfg { bind Base = Plain; bind Base = Plain(); }
`);
    const news = out.split("\n").filter((l) => l.includes("new Plain"));
    expect(news.every((l) => l.includes("new Plain()"))).toBe(true);
  });

  it("入れ子の括弧・アロー関数を含む引数も1つの引数リストとして取り込む", () => {
    const out = transpileDisonToTS(`
class Base {}
class Factory extends Base { constructor(make: () => number, opts: { n: number }) { super(); } }
configuration Cfg { bind Base = Factory(() => 1 + 2, { n: 3 }); }
`);
    expect(out).toContain("new Factory(() => 1 + 2, { n: 3 })");
  });

  it("ジェネリクス＋引数を併用できる", () => {
    const out = transpileDisonToTS(`
interface Repo<T> { get(): T; }
class PgRepo<T> implements Repo<T> { constructor(dsn: string) {} get(): T { return null as any; } }
configuration Cfg { bind Repo<string> = PgRepo<string>("dsn"); }
`);
    expect(out).toContain('new PgRepo<string>("dsn")');
  });

  it("引数が実行時に実際にコンストラクタへ渡る", () => {
    const mod = runGenerated(`
class Base { desc() { return "base"; } }
class WithConn extends Base { constructor(private conn: string) { super(); } desc() { return "conn=" + this.conn; } }
class S { injectable dep: Base = new Base(); }
configuration Cfg { bind Base = WithConn("prod://db"); }
activate Cfg;
module.exports = { v: (new S() as any).dep.desc() };
`);
    expect(mod.v).toBe("conn=prod://db");
  });

  it("単独bindの引数は関数のレキシカル変数を捕捉できる", () => {
    const mod = runGenerated(`
class Base { desc() { return "base"; } }
class WithConn extends Base { constructor(private conn: string) { super(); } desc() { return "conn=" + this.conn; } }
class S { injectable dep: Base = new Base(); }

function setup(connStr: string) {
  bind Base = WithConn(connStr);
  return new S();
}

module.exports = { v: (setup("from-closure") as any).dep.desc() };
`);
    expect(mod.v).toBe("conn=from-closure");
  });

  it("as トークンと引数を併用できる", () => {
    const out = transpileDisonToTS(`
token IRepoToken;
interface IRepo {}
class Impl implements IRepo { constructor(x: number) {} }
configuration Cfg { bind IRepo as IRepoToken = Impl(42); }
`);
    expect(out).toContain("bindType<IRepo>(IRepoToken, () => resolveType(Impl, () => new Impl(42)))");
  });

  it("引数リストが閉じていないとパースエラーになる", () => {
    expect(() =>
      transpileDisonToTS(`class Base {}\nclass X extends Base {}\nconfiguration Cfg { bind Base = X("unclosed; }`)
    ).toThrow(/not closed with a matching/);
  });
});

describe("bind: ジェネリクス対応", () => {
  it("識別子＋<...>の形をパースできる", () => {
    const out = transpileDisonToTS(`
interface Repository<T> { find(): T; }
class Impl implements Repository<{ id: string }> { find() { return { id: "x" }; } }
class S { injectable dep: Repository<{ id: string }> = new Impl(); }
configuration Cfg {
  bind Repository<{ id: string }> = Impl;
}
`);
    expect(out).toContain("bindType<Repository<{ id: string }>>(");
  });

  it("型引数ごとに別々のbindが両立する", () => {
    const out = transpileDisonToTS(`
interface Repository<T> { find(): T; }
class UserImpl implements Repository<{ kind: "user" }> { find() { return { kind: "user" as const }; } }
class AdminImpl implements Repository<{ kind: "admin" }> { find() { return { kind: "admin" as const }; } }
configuration Cfg {
  bind Repository<{ kind: "user" }> = UserImpl;
  bind Repository<{ kind: "admin" }> = AdminImpl;
}
`);
    const keys = extractKeys(out);
    expect(keys).toContain('Repository<{kind:"user"}>');
    expect(keys).toContain('Repository<{kind:"admin"}>');
  });

  it("ジェネリクス型引数中の関数型 '=>' が角カッコの閉じと誤認識されない", () => {
    const out = transpileDisonToTS(`
class Handler<T> {}
class ConcreteHandler<T> extends Handler<T> {}
configuration Cfg {
  bind Handler<(x: number) => void> = ConcreteHandler;
}
`);
    expect(out).toContain("bindType<Handler<(x: number) => void>>(");
  });
});

describe("bind: 照合キーの正規化", () => {
  it("injectable側とbind側で型注釈の空白の書き方が違っていても同じキーになる", () => {
    const out = transpileDisonToTS(`
interface Repository<T> { find(): T; }
class Impl implements Repository<{ id: string }> { find() { return { id: "x" }; } }
class S {
  injectable dep: Repository < { id: string } > = new Impl();
}
configuration Cfg {
  bind Repository<{id:string}> = Impl;
}
`);
    // injectable側のresolveTypeキー、bind側のbindType原型キーの両方が
    // 同じ正規化済み文字列になっているはず（bindの差し替え先Implの
    // resolveTypeキーは別に1件あるので、それを含めて数えないよう
    // 対象のキーだけ絞り込む）。
    const keys = extractKeys(out);
    const repositoryKeyCount = keys.filter((k) => k === "Repository<{id:string}>").length;
    expect(repositoryKeyCount).toBe(2);
  });

  it("表示用の型注釈テキスト（生成コードの型として使う部分）は元の空白を保持する", () => {
    const out = transpileDisonToTS(`
class S {
  injectable dep: Repository < User > = new Repository<User>();
}
class Repository<T> {}
class User {}
`);
    expect(out).toContain("get dep(): Repository < User > {");
  });
});

describe("単独のoverride/bind（configurationで包まない）", () => {
  it("トップレベルで単独bindを書ける（後方互換の拡張）", () => {
    const out = transpileDisonToTS(`
class Base { name = "default"; }
class Mock extends Base { name = "mock"; }
bind Base = Mock;
`);
    expect(out).toContain('bindType<Base>(Base, () => resolveType(Mock, () => new Mock()));');
    expect(out).not.toContain("function activate");
  });

  it("関数の中で単独overrideを書くと、その場で即座に実行される代入文になる", () => {
    const out = transpileDisonToTS(`
function f() {
  override S {
    dep = new Mock();
  }
}
`);
    expect(out).toContain("function f() {");
    expect(out).toContain('registerOverride(S, "dep", () => (new Mock()));');
    expect(out).not.toContain("function activate");
  });

  it("関数の中の単独overrideはレキシカル変数（クロージャ）を捕捉できる", () => {
    const mod = runGenerated(`
class Base {}
class S { injectable dep: Base = new Base(); }

function createHarness(label: string) {
  class Tagged extends Base { tag = label; }
  override S {
    dep = new Tagged();
  }
  return new S();
}

module.exports = {
  a: (createHarness("A") as any).dep.tag,
  b: (createHarness("B") as any).dep.tag,
};
`);
    expect(mod.a).toBe("A");
    expect(mod.b).toBe("B");
  });

  it("トップレベルの単独bindは即座に効き、その後の new に反映される", () => {
    const mod = runGenerated(`
class Base { name = "default"; }
class Mock extends Base { name = "mock"; }
class S { injectable dep: Base = new Base(); }
bind Base = Mock;

module.exports = { name: (new S() as any).dep.name };
`);
    expect(mod.name).toBe("mock");
  });
});
