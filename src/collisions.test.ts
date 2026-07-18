import { describe, it, expect } from "vitest";
import { findBindCollisions } from "./core";

describe("findBindCollisions（複数ファイルの型名衝突検出、案D）", () => {
  it("互いに無関係な2ファイルが同名interfaceをローカル宣言していると衝突を検出する", () => {
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
    const diagnostics = findBindCollisions(files);
    expect(diagnostics.length).toBe(2);
    expect(diagnostics.every((d) => d.name === "IRepository")).toBe(true);
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
});
