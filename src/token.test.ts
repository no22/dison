import { describe, it, expect } from "vitest";
import { transpileDisonToTS } from "./core";
import { runGenerated } from "./test-helpers";

describe("token / as 句（bindのinterface衝突対応、案D）", () => {
  it("token宣言はexportされたSymbolに脱糖される", () => {
    const out = transpileDisonToTS(`token IRepositoryToken;`);
    expect(out).toContain('export const IRepositoryToken = Symbol("IRepositoryToken");');
  });

  it("tokenはトップレベルでなければパースエラーになる", () => {
    expect(() => transpileDisonToTS(`function f() { token X; }`)).toThrow(/can only be placed at the top level/);
    expect(() => transpileDisonToTS(`class Foo { bar() {} token X; }`)).toThrow(/can only be placed at the top level/);
  });

  it("injectableのas句は、トークンの識別子参照をresolveTypeのキーとして使う", () => {
    const out = transpileDisonToTS(`
token IRepositoryToken;
interface IRepository {}
class Impl implements IRepository {}
class S { injectable dep: IRepository as IRepositoryToken = new Impl(); }
`);
    expect(out).toContain("resolveType(IRepositoryToken, () => (new Impl()))");
  });

  it("bindのas句は、トークンの識別子参照をbindTypeのキーとして使う", () => {
    const out = transpileDisonToTS(`
token IRepositoryToken;
interface IRepository {}
class Mock implements IRepository {}
configuration Cfg { bind IRepository as IRepositoryToken = Mock; }
`);
    expect(out).toContain('bindType<IRepository>(IRepositoryToken, () => resolveType("Mock"');
  });

  it("as句が無ければ従来通り文字列キーのまま", () => {
    const out = transpileDisonToTS(`
interface IRepository {}
class Impl implements IRepository {}
class S { injectable dep: IRepository = new Impl(); }
`);
    expect(out).toContain('resolveType("IRepository"');
  });

  it("as の後に識別子以外が来るとパースエラーになる", () => {
    expect(() =>
      transpileDisonToTS(`interface I {} class S { injectable dep: I as 123 = new S(); }`)
    ).toThrow(/identifier for the token is required/);
  });

  it("トークン経由でも実際に衝突を回避して正しく解決する（ランタイム検証）", () => {
    const mod = runGenerated(`
token RepoToken;
interface IRepository { whoAmI(): string; }
class Real implements IRepository { whoAmI() { return "real"; } }
class Mock implements IRepository { whoAmI() { return "mock"; } }

class S { injectable dep: IRepository as RepoToken = new Real(); }
configuration Cfg { bind IRepository as RepoToken = Mock; }
activate Cfg;

module.exports = { name: (new S() as any).dep.whoAmI() };
`);
    expect(mod.name).toBe("mock");
  });
});
