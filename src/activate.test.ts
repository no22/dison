import { describe, it, expect } from "vitest";
import { transpileDisonToTS } from "./core";

describe("activate", () => {
  it("定義済みのconfiguration名を参照すれば activateName(); に変換される", () => {
    const out = transpileDisonToTS(`
configuration Cfg {}
activate Cfg;
`);
    expect(out).toContain("activateCfg();");
  });

  it("未定義のconfiguration名を参照するとパースエラーになる", () => {
    expect(() => transpileDisonToTS(`activate Typo;`)).toThrow(/is not defined/);
  });
});

describe("activate ... from 'パス'（複数ファイル対応フェーズ2）", () => {
  it("activateをクラス本体の直下に書くとパースエラーになる（from の有無を問わず）", () => {
    expect(() =>
      transpileDisonToTS(`configuration Cfg {}\nclass Foo {\n  bar() {}\n  activate Cfg;\n}`)
    ).toThrow(/cannot be placed directly inside a class body/);
    expect(() =>
      transpileDisonToTS(`class Foo {\n  bar() {}\n  activate Cfg from "./configs";\n}`)
    ).toThrow(/cannot be placed directly inside a class body/);
  });

  it("メソッドの中のactivateは引き続き有効（回帰確認）", () => {
    const out = transpileDisonToTS(`configuration Cfg {}\nclass Foo {\n  bar() { activate Cfg; }\n}`);
    expect(out).toContain("bar() { activateCfg(); }");
  });

  it("from句があると、同一ファイル内の定義確認をスキップし、import文とその場の呼び出し文を生成する", () => {
    const out = transpileDisonToTS(`activate TestConfig from "./configs";`);
    expect(out).toContain('import { activateTestConfig } from "./configs";');
    expect(out).toContain("activateTestConfig();");
  });

  it("関数の中でfromを使っても、importはファイル先頭に巻き上げられ、呼び出しだけがその場に残る", () => {
    const out = transpileDisonToTS(`function setup() {\n  activate TestConfig from "./configs";\n}`);
    const importIdx = out.indexOf('import { activateTestConfig } from "./configs";');
    const fnIdx = out.indexOf("function setup()");
    expect(importIdx).toBeGreaterThan(-1);
    expect(importIdx).toBeLessThan(fnIdx);
    expect(out).toContain("function setup() {\n  activateTestConfig();\n}");
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
