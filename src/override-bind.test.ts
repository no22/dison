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

describe("bind: 非ジェネリクス（後方互換）", () => {
  it("bindType<Original>(\"Original\", ...) が生成される", () => {
    const out = transpileDisonToTS(`
class Real {}
class Mock {}
configuration Cfg {
  bind Real = Mock;
}
`);
    expect(out).toContain('bindType<Real>("Real", () => resolveType("Mock", () => new Mock()));');
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
    expect(out).toContain('bindType<Base>("Base", () => resolveType("Mock", () => new Mock()));');
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
