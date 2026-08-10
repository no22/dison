import { describe, it, expect } from "vitest";
import { transpileDisonToTS, explainProvides } from "./core";
import { runGenerated } from "./test-helpers";

// configuration の宣言された表面（docs/configuration-provides.md）。
// 宣言された集合 ⊆ 実効エントリのキー集合、を transpile 時に検査する。

const TYPES = `
interface Repository { tag(): string; }
interface Clock { now(): string; }
class PgRepo implements Repository { tag() { return "pg"; } }
class SqlRepo implements Repository { tag() { return "sql"; } }
class SysClock implements Clock { now() { return "sys"; } }
class Frozen implements Clock { now() { return "frozen"; } }
class Service { injectable repo: Repository = new SqlRepo(); }
`;

describe("provides: 基本", () => {
  it("宣言を満たしていれば通り、生成物には影響しない", () => {
    const program = `${TYPES}
configuration Production provides Repository, Clock {
  bind Repository = PgRepo;
  bind Clock = SysClock;
}
activate Production;
export const results = [new Service().repo.tag()];
`;
    const out = transpileDisonToTS(program);
    // provides は transpile 時の検査だけで、生成物に痕跡を残さない。
    expect(out).not.toContain("provides");
    expect(runGenerated(program).results).toEqual(["pg"]);
  });

  it("宣言したキーが配線されていなければエラー（動機の穴を塞ぐ）", () => {
    // bind を落としても既定初期化式が吸収して無言で挙動が変わる、というのが動機。
    expect(() =>
      transpileDisonToTS(`${TYPES}
configuration Production provides Repository, Clock {
  bind Repository = PgRepo;
}
activate Production;
`)
    ).toThrow(/declares that it provides "Clock", but nothing in it/);
  });

  it("エラーは壊した configuration の名前を指す", () => {
    let err: Error | undefined;
    try {
      transpileDisonToTS(`${TYPES}\nconfiguration Production provides Clock { }`);
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toContain('configuration "Production"');
    expect(err?.message).toContain('remove "Clock" from the "provides" clause');
  });

  it("extends で継いだ分でも満たせる", () => {
    const out = transpileDisonToTS(`${TYPES}
configuration Base { bind Repository = PgRepo; bind Clock = SysClock; }
configuration Test provides Repository, Clock extends Base { bind Clock = Frozen; }
activate Test;
`);
    expect(out).toContain("export function activateTest()");
  });

  it("provides と extends は順不同で書ける", () => {
    const both = [
      `configuration Test provides Clock extends Base { }`,
      `configuration Test extends Base provides Clock { }`,
    ];
    for (const decl of both) {
      expect(() =>
        transpileDisonToTS(`${TYPES}\nconfiguration Base { bind Clock = SysClock; }\n${decl}\nactivate Test;`)
      ).not.toThrow();
    }
  });

  it("「少なくとも」の意味論（宣言していない bind を足してよい）", () => {
    expect(() =>
      transpileDisonToTS(`${TYPES}
configuration Production provides Repository {
  bind Repository = PgRepo;
  bind Clock = SysClock;
}
activate Production;
`)
    ).not.toThrow();
  });

  it("provides を書かない既存プログラムには影響しない", () => {
    const program = `${TYPES}
configuration Production { bind Repository = PgRepo; }
activate Production;
export const results = [new Service().repo.tag()];
`;
    expect(runGenerated(program).results).toEqual(["pg"]);
  });
});

describe("provides: キーの種類", () => {
  it("override 対（Cls.prop）を宣言できる", () => {
    expect(() =>
      transpileDisonToTS(`${TYPES}
configuration Production provides Service.repo {
  override Service { repo = new PgRepo(); }
}
activate Production;
`)
    ).not.toThrow();
  });

  it("override 対が配線されていなければエラー", () => {
    expect(() =>
      transpileDisonToTS(`${TYPES}
configuration Production provides Service.repo { bind Repository = PgRepo; }
activate Production;
`)
    ).toThrow(/provides "Service\.repo"/);
  });

  it("ジェネリクスのインスタンス化をキーにできる", () => {
    expect(() =>
      transpileDisonToTS(`
interface Repository<T> { find(): T; }
class UserRepo implements Repository<{ id: string }> { find() { return { id: "u" }; } }
configuration Production provides Repository<{ id: string }> {
  bind Repository<{ id: string }> = UserRepo;
}
activate Production;
`)
    ).not.toThrow();
  });

  it("as トークンつきのキーを宣言できる", () => {
    expect(() =>
      transpileDisonToTS(`
token RepoToken;
interface IRepo { tag(): string; }
class Impl implements IRepo { tag() { return "impl"; } }
configuration Production provides IRepo as RepoToken {
  bind IRepo as RepoToken = Impl;
}
activate Production;
`)
    ).not.toThrow();
  });

  it("同じキーを二度書くとパースエラー", () => {
    expect(() =>
      transpileDisonToTS(`${TYPES}\nconfiguration P provides Clock, Clock { bind Clock = SysClock; }`)
    ).toThrow(/listed twice/);
  });

  it("provides 節が二つあるとパースエラー", () => {
    expect(() =>
      transpileDisonToTS(`${TYPES}\nconfiguration P provides Clock provides Repository { }`)
    ).toThrow(/only one "provides" clause/);
  });
});

describe("provides: 実行時選択との組み合わせ", () => {
  const CONFIGS = `${TYPES}
configuration Test { bind Repository = SqlRepo; bind Clock = Frozen; }
configuration Production { bind Repository = PgRepo; }
declare const isTest: boolean;
`;

  it("依拠すると書いたときだけ分岐の食い違いがエラーになる", () => {
    // provides を書かなければ従来どおり通る（非対称が意図的なこともある）。
    expect(() =>
      transpileDisonToTS(`${CONFIGS}\nconfiguration extends (isTest ? Test : Production) {}`)
    ).not.toThrow();
    expect(() =>
      transpileDisonToTS(`${CONFIGS}\nconfiguration extends (isTest ? Test : Production) provides Repository, Clock {}`)
    ).toThrow(/runtime selection can pick a configuration that does not provide it/);
  });

  it("エラーにはどの葉が欠けているかが出る", () => {
    let err: Error | undefined;
    try {
      transpileDisonToTS(`${CONFIGS}\nconfiguration extends (isTest ? Test : Production) provides Clock {}`);
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toContain("Test provides it");
    expect(err?.message).toContain("Production does NOT provide it");
  });

  it("全葉が提供するキーは積集合に入るので通る", () => {
    expect(() =>
      transpileDisonToTS(`${CONFIGS}\nconfiguration extends (isTest ? Test : Production) provides Repository {}`)
    ).not.toThrow();
  });
});

describe("provides: --explain の宣言行", () => {
  it("宣言された表面を行として返す", () => {
    const lines = explainProvides(`${TYPES}
configuration Production provides Repository, Service.repo {
  bind Repository = PgRepo;
  override Service { repo = new PgRepo(); }
}
`);
    expect(lines).toEqual(["Production provides {Repository, Service.repo}"]);
  });

  it("provides が無ければ空", () => {
    expect(explainProvides(`${TYPES}\nconfiguration P { bind Repository = PgRepo; }`)).toEqual([]);
  });
});

describe("provides: 先読みの回帰（2.1/2.3 で二度踏んだ箇所）", () => {
  it('"." や "<" を含む provides 節でも raw パススルーに落ちない', () => {
    // 落ちると configuration 宣言と認識されず、生成物が構文エラーになる。
    const out = transpileDisonToTS(`
interface Repository<T> { find(): T; }
class UserRepo implements Repository<{ id: string }> { find() { return { id: "u" }; } }
class Service { injectable repo: Repository<{ id: string }> = new UserRepo(); }
configuration P provides Repository<{ id: string }>, Service.repo {
  bind Repository<{ id: string }> = UserRepo;
  override Service { repo = new UserRepo(); }
}
activate P;
`);
    expect(out).toContain("export function activateP()");
    expect(out).not.toContain("configuration P provides"); // raw で通っていない
  });
});
