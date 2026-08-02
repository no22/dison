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
`, { staticResolution: false });
    expect(out).toContain("resolveType(IRepositoryToken, () => (new Impl()))");
  });

  it("bindのas句は、トークンの識別子参照をbindTypeのキーとして使う", () => {
    const out = transpileDisonToTS(`
token IRepositoryToken;
interface IRepository {}
class Mock implements IRepository {}
configuration Cfg { bind IRepository as IRepositoryToken = Mock; }
`, { staticResolution: false });
    // 左辺のキーはトークン（IRepositoryToken）。差し替え先 Mock は具象クラスなので
    // 実体参照キー（resolveType(Mock, ...)）になる。
    expect(out).toContain('bindTypeLazy<IRepository>(() => IRepositoryToken, () => resolveType(Mock,');
  });

  it("as句が無いローカルinterfaceは companion Symbol でキー化される（案A(b)）", () => {
    // 以前は文字列キー "IRepository" だったが、案A(b)の companion 自動付与により
    // 宣言ごとの Symbol でキー化される（手動tokenなしで衝突回避）。明示的な as/token は
    // 上書き手段として引き続き使える（keyExprFor はトークン最優先）。
    const out = transpileDisonToTS(`
interface IRepository {}
class Impl implements IRepository {}
class S { injectable dep: IRepository = new Impl(); }
`, { staticResolution: false });
    expect(out).toContain('export const __dison_token_IRepository = Symbol("IRepository");');
    expect(out).toContain("resolveType(__dison_token_IRepository, () => (new Impl()))");
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
