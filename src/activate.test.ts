import { describe, it, expect } from "vitest";
import { transpileDisonToTS } from "./core";

describe("activate", () => {
  it("定義済みのconfiguration名を参照すれば activateName(); に変換される", () => {
    const out = transpileDisonToTS(`
configuration Cfg {}
activate Cfg;
`);
    // 3.0: activate は「その位置への展開」。登録を読む者がいなければ呼び出しごと消える。
    // 動的残余があるケースは下のテストで確認する。
    expect(out).toContain("export function activateCfg()");
  });

  it("未定義のconfiguration名を参照するとパースエラーになる", () => {
    expect(() => transpileDisonToTS(`activate Typo;`)).toThrow(/is not defined/);
  });
});

describe("activate ... from 'パス'（複数ファイル対応フェーズ2）", () => {
  it("activateはクラス本体の直下に書ける（3.0: クラススコープになる）", () => {
    const out = transpileDisonToTS(`
class Repo { tag() { return "pg"; } }
class MockRepo extends Repo { tag() { return "mock"; } }
configuration Cfg { bind Repo = MockRepo; }
class Foo {
  injectable repo: Repo;
  activate Cfg;
}
class Other { injectable repo: Repo; }
`);
    // クラススコープとして畳まれ、他クラスは影響を受けない。
    expect(out).toContain("this._repo = new MockRepo();");
    expect(out).toContain("this._repo = new Repo();");
  });

  it("メソッドの中のactivateは3.0で移行エラーになる", () => {
    expect(() =>
      transpileDisonToTS(`configuration Cfg {}\nclass Foo {\n  bar() { activate Cfg; }\n}`)
    ).toThrow(/is inside a block/);
  });

  it("from句があると、同一ファイル内の定義確認をスキップし、import文とその場の呼び出し文を生成する", () => {
    const out = transpileDisonToTS(`activate TestConfig from "./configs";`);
    expect(out).toContain('import { activateTestConfig } from "./configs";');
    expect(out).toContain("activateTestConfig();");
  });

  it("関数の中でfromを使うと3.0で移行エラーになる", () => {
    expect(() =>
      transpileDisonToTS(`function f() {\n  activate TestConfig from "./configs";\n}`)
    ).toThrow(/is inside a block/);
  });

  it("同じ(名前, パス)の組は1つのimportにまとめられる", () => {
    const out = transpileDisonToTS(`
activate TestConfig from "./configs";
activate TestConfig from "./configs";
`);
    const count = out.split('import { activateTestConfig } from "./configs";').length - 1;
    expect(count).toBe(1);
  });

  it("クォートスタイルの違い（'...' と \"...\"）は同一パスとして扱われ、importが重複しない", () => {
    const out = transpileDisonToTS(`
activate TestConfig from './configs';
activate TestConfig from "./configs";
`);
    const count = out.split('import { activateTestConfig } from "./configs";').length - 1;
    expect(count).toBe(1);
  });

  it("異なるパスが同じconfiguration名を持つ場合、エイリアスで衝突を回避する", () => {
    const out = transpileDisonToTS(`
activate TestConfig from "./a";
activate TestConfig from "./b";
`);
    expect(out).toContain('import { activateTestConfig } from "./a";');
    expect(out).toContain('import { activateTestConfig as activateTestConfig_2 } from "./b";');
    expect(out).toContain("activateTestConfig();");
    expect(out).toContain("activateTestConfig_2();");
  });

  it("from の後に文字列リテラル以外が来るとパースエラーになる", () => {
    expect(() => transpileDisonToTS(`activate TestConfig from configs;`)).toThrow(
      /string literal path is required/
    );
  });
});
