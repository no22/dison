import { describe, it, expect } from "vitest";
import { transpileDisonToTS } from "./core";

describe("構造的な位置制約", () => {
  it("injectableはクラス本体の直下でなければパースエラーになる（メソッドの中）", () => {
    expect(() => transpileDisonToTS(`class S { bar() { injectable dep: Foo; } }`)).toThrow(
      /can only be placed directly inside a class body/
    );
  });

  it("injectableはクラス本体の直下でなければパースエラーになる（トップレベル）", () => {
    expect(() => transpileDisonToTS(`class Foo {}\ninjectable dep: Foo;`)).toThrow(
      /can only be placed directly inside a class body/
    );
  });

  it("configurationはトップレベルでなければパースエラーになる（関数の中）", () => {
    expect(() => transpileDisonToTS(`function f() { configuration Cfg { bind A = B; } } `)).toThrow(
      /can only be placed at the top level/
    );
  });

  it("configurationはトップレベルでなければパースエラーになる（クラスの中）", () => {
    expect(() =>
      transpileDisonToTS(`class S { m() { configuration Cfg { bind A = B; } } }`)
    ).toThrow(/can only be placed at the top level/);
  });

  it("単独のoverrideはクラス本体の直下には書けない（メソッドの外）", () => {
    expect(() => transpileDisonToTS(`class Foo { bar() {} override Foo { x = 1; } }`)).toThrow(
      /cannot be placed directly inside a class body/
    );
  });

  it("単独のbindはクラス本体の直下には書けない（メソッドの外）", () => {
    expect(() => transpileDisonToTS(`class Foo { bar() {} bind A = B; }`)).toThrow(
      /cannot be placed directly inside a class body/
    );
  });
});
