import { describe, it, expect } from "vitest";
import { transpileDisonToTS } from "./core";
import { runGenerated } from "./test-helpers";

// async関数内ローカルスコープの隔離（docs/async-local-scope.md）。
// async関数本体のローカルconfigurationは (await null, __disonEnterScope(...)) に
// 脱糖され、enterWithが関数専有のマイクロタスク実行で走る（呼び出し元へ漏れない）。
// ジェネレータ（sync/async）本体ではtranspile時エラー。

const AWAIT_FORM = "= (await null, __disonEnterScope(";
const SYNC_FORM = "= __disonEnterScope(";

describe("脱糖形の切り替え（囲み関数種別の判定）", () => {
  it("async関数本体では (await null, ...) 形になる", () => {
    const out = transpileDisonToTS(`
class Repo {}
class Mock extends Repo {}
async function f(): Promise<void> {
  configuration { bind Repo = Mock; }
}
`);
    expect(out).toContain(AWAIT_FORM);
  });

  it("同期関数本体では従来形のまま（await なし）", () => {
    const out = transpileDisonToTS(`
class Repo {}
class Mock extends Repo {}
function f(): void {
  configuration { bind Repo = Mock; }
}
`);
    expect(out).toContain(SYNC_FORM);
    expect(out).not.toContain(AWAIT_FORM);
  });

  it("asyncアロー関数（戻り値型注釈つき）でも await 形になる", () => {
    const out = transpileDisonToTS(`
class Repo {}
class Mock extends Repo {}
const f = async (): Promise<void> => {
  configuration { bind Repo = Mock; }
};
`);
    expect(out).toContain(AWAIT_FORM);
  });

  it("asyncメソッド本体でも await 形になる", () => {
    const out = transpileDisonToTS(`
class Repo {}
class Mock extends Repo {}
class Runner {
  async run(): Promise<void> {
    configuration { bind Repo = Mock; }
  }
}
`);
    expect(out).toContain(AWAIT_FORM);
  });

  it("async関数内の制御ブロック（if等）の中でも await 形になる（種別を継承）", () => {
    const out = transpileDisonToTS(`
class Repo {}
class Mock extends Repo {}
async function f(flag: boolean): Promise<void> {
  if (flag) {
    configuration { bind Repo = Mock; }
  }
}
`);
    expect(out).toContain(AWAIT_FORM);
  });

  it("async関数内にネストした同期アロー関数の中は従来形（awaitは不正になるため）", () => {
    const out = transpileDisonToTS(`
class Repo {}
class Mock extends Repo {}
async function f(): Promise<void> {
  const setup = () => {
    configuration { bind Repo = Mock; }
    return new Repo();
  };
  setup();
}
`);
    expect(out).toContain(SYNC_FORM);
    expect(out).not.toContain(AWAIT_FORM);
  });
});

describe("ジェネレータ本体はtranspile時エラー", () => {
  it("syncジェネレータ内のローカルconfigurationはエラー（yieldごとに呼び出し元へ漏れるため）", () => {
    expect(() =>
      transpileDisonToTS(`
class Repo {}
class Mock extends Repo {}
function* gen(): Generator<number> {
  configuration { bind Repo = Mock; }
  yield 1;
}
`)
    ).toThrow(/generator function body/);
  });

  it("asyncジェネレータ内もエラー（最初のyield後にスコープが静かに失われるため）", () => {
    expect(() =>
      transpileDisonToTS(`
class Repo {}
class Mock extends Repo {}
async function* agen(): AsyncGenerator<number> {
  configuration { bind Repo = Mock; }
  yield 1;
}
`)
    ).toThrow(/async generator function body/);
  });

  it("ジェネレータメソッド（*name() {}）内もエラー", () => {
    expect(() =>
      transpileDisonToTS(`
class Repo {}
class Mock extends Repo {}
class Seq {
  *items(): Generator<number> {
    configuration { bind Repo = Mock; }
    yield 1;
  }
}
`)
    ).toThrow(/generator function body/);
  });
});

describe("実行時の挙動", () => {
  it("呼び出し元へ漏れない（監査#1の回帰）＋await越しにスコープが維持される", async () => {
    const mod = runGenerated(`
class Repo { name = "real"; }
class Mock extends Repo { name = "mock"; }
class S { injectable repo: Repo; }
async function withMock(): Promise<string> {
  configuration { bind Repo = Mock; }
  await new Promise(r => setTimeout(r, 5));
  return (new S() as any).repo.name;
}
const p = withMock();
const outside = (new S() as any).repo.name;
module.exports = { p, outside };
`);
    // 呼び出し直後（関数がサスペンド中）の呼び出し元の構築は汚染されない
    expect(mod.outside).toBe("real");
    // 関数内ではawaitをまたいでスコープが効く
    await expect(mod.p).resolves.toBe("mock");
  });

  it("並行asyncタスクの分離と、スコープ内構築インスタンスの捕捉が維持される", async () => {
    const mod = runGenerated(`
class Repo { name = "real"; }
class MockA extends Repo { name = "A"; }
class MockB extends Repo { name = "B"; }
class S { injectable repo: Repo; }
async function taskA(): Promise<string> {
  configuration { bind Repo = MockA; }
  await new Promise(r => setTimeout(r, 20));
  return (new S() as any).repo.name;
}
async function taskB(): Promise<string> {
  configuration { bind Repo = MockB; }
  await new Promise(r => setTimeout(r, 5));
  return (new S() as any).repo.name;
}
async function capture(): Promise<S> {
  configuration { bind Repo = MockA; }
  await null;
  return new S();
}
module.exports = {
  run: (async () => {
    const [a, b] = await Promise.all([taskA(), taskB()]);
    const captured = await capture();
    return { a, b, captured: (captured as any).repo.name, plain: (new S() as any).repo.name };
  })(),
};
`);
    const r = await mod.run;
    expect(r.a).toBe("A");
    expect(r.b).toBe("B");
    // スコープ内で構築されたインスタンスは、スコープ終了後のアクセスでも捕捉したスコープで解決する
    expect(r.captured).toBe("A");
    expect(r.plain).toBe("real");
  });
});
