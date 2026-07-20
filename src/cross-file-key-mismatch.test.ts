import { describe, it, expect } from "vitest";
import { findCrossFileKeyMismatches } from "./core";

// クロスファイルキー不一致の検出（docs/cross-file-key-mismatch.md、仕様監査2026-07 #4）。
// このファイルで文字列キーに落ちる裸の識別子が、他のプロジェクトファイルでは
// identity/companionキー化される宣言を持つ場合、キーは決して一致しないため
// transpile時エラーにする。

const declFile = {
  path: "a.dis",
  source: `
export class Db { kind = "real"; }
export class MockDb extends Db { kind = "mock"; }
export class Service { injectable db: Db; }
`,
};

describe("検出されるケース", () => {
  it("bind左辺のimport忘れ（監査#4の再現ケース）", () => {
    const diags = findCrossFileKeyMismatches([
      declFile,
      {
        path: "main.dis",
        source: `
import { Service, MockDb } from "./a.js";
bind Db = MockDb;
`,
      },
    ]);
    expect(diags).toHaveLength(1);
    expect(diags[0].name).toBe("Db");
    expect(diags[0].message).toContain("main.dis");
    expect(diags[0].message).toContain("a.dis");
    expect(diags[0].message).toContain("string key");
  });

  it("override対象のimport忘れ", () => {
    const diags = findCrossFileKeyMismatches([
      declFile,
      {
        path: "main.dis",
        source: `
class LocalMock { kind = "mock"; }
configuration Cfg { override Service { db = new LocalMock(); } }
`,
      },
    ]);
    expect(diags).toHaveLength(1);
    expect(diags[0].name).toBe("Service");
  });

  it("bind差し替え先のimport忘れ", () => {
    const diags = findCrossFileKeyMismatches([
      declFile,
      {
        path: "main.dis",
        source: `
import { Db } from "./a.js";
bind Db = MockDb;
`,
      },
    ]);
    expect(diags).toHaveLength(1);
    expect(diags[0].name).toBe("MockDb");
  });

  it("type-only importされたクラスをbind左辺に使うとエラー（typeを外すよう案内）", () => {
    const diags = findCrossFileKeyMismatches([
      declFile,
      {
        path: "main.dis",
        source: `
import type { Db } from "./a.js";
import { MockDb } from "./a.js";
bind Db = MockDb;
`,
      },
    ]);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('Remove "type"');
  });

  it("injectable型注釈のimport忘れ（対称ケース）", () => {
    const diags = findCrossFileKeyMismatches([
      declFile,
      {
        path: "main.dis",
        source: `
class Impl { kind = "impl"; }
export class Consumer { injectable db: Db = new Impl(); }
`,
      },
    ]);
    expect(diags).toHaveLength(1);
    expect(diags[0].name).toBe("Db");
  });

  it("interface宣言（companionキー）の未importも検出する", () => {
    const diags = findCrossFileKeyMismatches([
      {
        path: "a.dis",
        source: `
export interface IRepo { whoAmI(): string; }
export class Impl implements IRepo { whoAmI() { return "impl"; } }
export class Service { injectable repo: IRepo = new Impl(); }
`,
      },
      {
        path: "main.dis",
        source: `
class Mock { whoAmI() { return "mock"; } }
bind IRepo = Mock;
`,
      },
    ]);
    expect(diags).toHaveLength(1);
    expect(diags[0].name).toBe("IRepo");
    expect(diags[0].message).toContain("companion Symbol");
  });
});

describe("検出されないケース（正当な書き方）", () => {
  it("value-import済みなら診断なし", () => {
    const diags = findCrossFileKeyMismatches([
      declFile,
      {
        path: "main.dis",
        source: `
import { Db, MockDb } from "./a.js";
bind Db = MockDb;
`,
      },
    ]);
    expect(diags).toHaveLength(0);
  });

  it("interfaceのtype-only importは診断なし（companion機構が解決する）", () => {
    const diags = findCrossFileKeyMismatches([
      {
        path: "a.dis",
        source: `
export interface IRepo { whoAmI(): string; }
export class Impl implements IRepo { whoAmI() { return "impl"; } }
export class Service { injectable repo: IRepo = new Impl(); }
`,
      },
      {
        path: "main.dis",
        source: `
import type { IRepo } from "./a.js";
class Mock implements IRepo { whoAmI() { return "mock"; } }
bind IRepo = Mock;
`,
      },
    ]);
    expect(diags).toHaveLength(0);
  });

  it("どこにも宣言のない名前（外部パッケージ型・タイプミス）は対象外（tscの担当）", () => {
    const diags = findCrossFileKeyMismatches([
      declFile,
      {
        path: "main.dis",
        source: `
class Mock { kind = "mock"; }
bind ExternalPkgType = Mock;
`,
      },
    ]);
    expect(diags).toHaveLength(0);
  });

  it("as トークン付きは対象外（明示キーは文字列プールから抜けている）", () => {
    const diags = findCrossFileKeyMismatches([
      declFile,
      {
        path: "main.dis",
        source: `
token DbToken;
class Mock { kind = "mock"; }
bind Db as DbToken = Mock;
`,
      },
    ]);
    expect(diags).toHaveLength(0);
  });

  it("同名をローカル宣言しているファイルは対象外（自分のidentityキーを使う）", () => {
    const diags = findCrossFileKeyMismatches([
      declFile,
      {
        path: "main.dis",
        source: `
class Db { kind = "local"; }
class MockDb extends Db { kind = "mock"; }
bind Db = MockDb;
`,
      },
    ]);
    expect(diags).toHaveLength(0);
  });

  it("ジェネリクス複合型は対象外（文字列キーが正当）", () => {
    const diags = findCrossFileKeyMismatches([
      declFile,
      {
        path: "main.dis",
        source: `
class Repo<T> { x?: T; }
class MockRepo extends Repo<string> {}
bind Repo<string> = MockRepo;
`,
      },
    ]);
    expect(diags).toHaveLength(0);
  });
});
