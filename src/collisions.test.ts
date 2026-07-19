import { describe, it, expect } from "vitest";
import { findBindCollisions, computeIdentityKeyClassesByFile, computeCompanionPlanByFile } from "./core";

describe("findBindCollisions（複数ファイルの型名衝突検出、案D）", () => {
  it("互いに無関係な2ファイルが同名interfaceをローカル宣言していても衝突としない（companionで自動分離）", () => {
    // 以前はローカル宣言の同名interfaceを衝突として検出していたが、案A(b)の
    // companion Symbol 自動付与により、宣言ごとに別の Symbol でキー化されるため
    // 手動tokenなしで自動的に分離される。よって衝突検出の対象から外れる。
    const files = [
      {
        path: "fileA.dis",
        source: `
export interface IRepository { whoAmI(): string; }
export class ImplA implements IRepository { whoAmI() { return "A"; } }
export class ServiceA { injectable repo: IRepository = new ImplA(); }
`,
      },
      {
        path: "fileD.dis",
        source: `
export interface IRepository { whoAmI(): string; }
export class ImplD implements IRepository { whoAmI() { return "D"; } }
export class ServiceD { injectable repo: IRepository = new ImplD(); }
`,
      },
    ];
    expect(findBindCollisions(files)).toEqual([]);
  });

  it("同名interfaceでも片方だけの場合や無関係な型なら衝突を検出しない", () => {
    const files = [
      { path: "fileA.dis", source: `export interface IRepository {} export class S { injectable dep: IRepository = new S(); }` },
      { path: "fileB.dis", source: `export class Unrelated {}` },
    ];
    expect(findBindCollisions(files)).toEqual([]);
  });

  it("同じimport specifierから正しく共有されているケースは衝突とみなさない", () => {
    const files = [
      { path: "contracts.dis", source: `export interface IRepository {}` },
      {
        path: "fileB.dis",
        source: `import { IRepository } from "./contracts";\nexport class ImplB implements IRepository {}\nexport class S { injectable dep: IRepository = new ImplB(); }`,
      },
      {
        path: "fileC.dis",
        source: `import { IRepository } from "./contracts";\nexport class MockC implements IRepository {}\nconfiguration Cfg { bind IRepository = MockC; }`,
      },
    ];
    expect(findBindCollisions(files)).toEqual([]);
  });

  it("あるファイルのローカル宣言を、別ファイルが相対パスで正しくimportしている場合は衝突とみなさない", () => {
    const files = [
      {
        path: "/proj/base.dis",
        source: `export class Base {}\nexport class S { injectable dep: Base = new Base(); }`,
      },
      {
        path: "/proj/configs.dis",
        source: `import { Base } from "./base";\nclass Mock extends Base {}\nconfiguration Cfg { bind Base = Mock; }`,
      },
    ];
    expect(findBindCollisions(files)).toEqual([]);
  });

  it("異なるimport specifierから同名の型が使われている場合（外部パッケージ同士を想定）は衝突を検出する", () => {
    const files = [
      {
        path: "fileX.dis",
        source: `import { IRepository } from "package-x";\nexport class ImplX implements IRepository {}\nexport class ServiceX { injectable repo: IRepository = new ImplX(); }`,
      },
      {
        path: "fileY.dis",
        source: `import { IRepository } from "package-y";\nexport class MockY implements IRepository {}\nconfiguration CfgY { bind IRepository = MockY; }`,
      },
    ];
    const diagnostics = findBindCollisions(files);
    expect(diagnostics.length).toBe(2);
  });

  it("as句でトークン化された出現は衝突検出から除外され、残りの無関係な出現には影響しない", () => {
    const files = [
      {
        path: "tokens.dis",
        source: `token RepoToken;`,
      },
      {
        path: "fileA.dis",
        source: `
import { RepoToken } from "./tokens";
export interface IRepository { whoAmI(): string; }
export class ImplA implements IRepository { whoAmI() { return "A"; } }
export class ServiceA { injectable repo: IRepository as RepoToken = new ImplA(); }
`,
      },
      {
        path: "fileD.dis",
        source: `
export interface IRepository { whoAmI(): string; }
export class ImplD implements IRepository { whoAmI() { return "D"; } }
export class ServiceD { injectable repo: IRepository = new ImplD(); }
`,
      },
    ];
    // fileAはトークン化済みなので対象外。fileDは他に衝突する相手がいないので単独では
    // 衝突しない（トークン化されていない出現同士でのみ衝突を判定するため）。
    expect(findBindCollisions(files)).toEqual([]);
  });

  it("互いに無関係な2ファイルが同名の具象クラスをbind/injectableに使っていても衝突としない（実体キー化されるため）", () => {
    // interfaceと違い、具象クラスは実体参照キーになるので同名でも別の実体として
    // 区別され、手動tokenなしで衝突しない（docs/type-identity-matching.md 案A(a)）。
    const files = [
      {
        path: "a.dis",
        source: `
export class Foo { who() { return "A"; } }
export class MockA extends Foo { who() { return "A-mock"; } }
export class ServiceA { injectable repo: Foo; }
configuration CfgA { bind Foo = MockA; }
`,
      },
      {
        path: "d.dis",
        source: `
export class Foo { who() { return "D"; } }
export class ServiceD { injectable repo: Foo; }
`,
      },
    ];
    expect(findBindCollisions(files)).toEqual([]);
  });
});

describe("computeIdentityKeyClassesByFile（複数ファイルの実体キー一致、案A(a)）", () => {
  it("他のプロジェクトファイルからvalue-importした具象クラスを、import側の実体キー集合に含める", () => {
    const files = [
      { path: "/p/base.dis", source: `export class Shared {}` },
      { path: "/p/user.dis", source: `import { Shared } from "./base";\nclass S { injectable dep: Shared; }` },
    ];
    const m = computeIdentityKeyClassesByFile(files);
    // import側は宣言元と同じ実体をキーにする必要があるので Shared を含める。
    expect([...m.get("/p/user.dis")!]).toContain("Shared");
    // 宣言元のローカルクラスはここには含めない（transpile側がtypeKindsから追加する）。
    expect([...m.get("/p/base.dis")!]).toEqual([]);
  });

  it("import type された具象クラスは実行時に値が無いため実体キー集合に含めない", () => {
    const files = [
      { path: "/p/base.dis", source: `export class Shared {}` },
      { path: "/p/user.dis", source: `import type { Shared } from "./base";\nclass S { injectable dep: Shared = anyFactory(); }` },
    ];
    expect([...computeIdentityKeyClassesByFile(files).get("/p/user.dis")!]).toEqual([]);
  });

  it("外部パッケージ由来のクラスは解決できないため含めない", () => {
    const files = [
      { path: "/p/user.dis", source: `import { Repo } from "typeorm";\nclass S { injectable dep: Repo = new Repo(); }` },
    ];
    expect([...computeIdentityKeyClassesByFile(files).get("/p/user.dis")!]).toEqual([]);
  });
});

describe("computeCompanionPlanByFile（複数ファイルの companion 計画、案A(b)(c)）", () => {
  it("DI利用されるローカルinterfaceは宣言元ファイルの emit 集合に入る", () => {
    const files = [
      { path: "/p/a.dis", source: `interface IRepo {}\nclass Impl implements IRepo {}\nconfiguration C { bind IRepo = Impl; }` },
    ];
    const plan = computeCompanionPlanByFile(files).get("/p/a.dis")!;
    expect([...plan.companionEmit]).toContain("IRepo");
  });

  it("DI利用されないローカルinterfaceは emit しない（案2: DI利用のみ）", () => {
    const files = [
      { path: "/p/a.dis", source: `interface IUsed {}\ninterface IUnused {}\nclass S { injectable dep: IUsed = ({} as any); }` },
    ];
    const plan = computeCompanionPlanByFile(files).get("/p/a.dis")!;
    expect([...plan.companionEmit]).toContain("IUsed");
    expect([...plan.companionEmit]).not.toContain("IUnused");
  });

  it("他ファイルのinterfaceをimportしてDI利用すると、宣言元がemit・利用側がimport計画になる", () => {
    const files = [
      { path: "/p/base.dis", source: `export interface IShared {}` },
      {
        path: "/p/cfg.dis",
        source: `import type { IShared } from "./base";\nclass Mock implements IShared {}\nconfiguration C { bind IShared = Mock; }`,
      },
    ];
    const plans = computeCompanionPlanByFile(files);
    // 宣言元は emit（他ファイルで DI利用されるため）
    expect([...plans.get("/p/base.dis")!.companionEmit]).toContain("IShared");
    // 利用側は import 計画（import type でも companion は値として別 import されるので対象）
    const cfgImports = plans.get("/p/cfg.dis")!.companionImports;
    expect(cfgImports.get("IShared")).toEqual({ specifier: "./base", originalName: "IShared" });
  });

  it("外部パッケージ由来のinterfaceは companion を持てないので import 計画に入らない", () => {
    const files = [
      { path: "/p/cfg.dis", source: `import { IExt } from "some-pkg";\nclass Mock implements IExt {}\nconfiguration C { bind IExt = Mock; }` },
    ];
    const plan = computeCompanionPlanByFile(files).get("/p/cfg.dis")!;
    expect(plan.companionImports.size).toBe(0);
    expect(plan.companionEmit.size).toBe(0);
  });
});
