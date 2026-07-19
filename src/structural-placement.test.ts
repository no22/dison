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

  it("無名configurationは関数の中に書ける（ローカルスコープ、docs/scoped-configuration.md）", () => {
    // 非トップレベルの無名 configuration は using で脱糖されるローカルスコープになる。
    const out = transpileDisonToTS(`class A {}\nclass B extends A {}\nfunction f() { configuration { bind A = B; } }`);
    expect(out).toContain("using __dison_scope_0 = __disonEnterScopeLazy(");
    expect(out).toContain("__disonBind(() => A,");
  });

  it("名前付きローカルconfigurationは未対応でパースエラーになる", () => {
    expect(() => transpileDisonToTS(`function f() { configuration Cfg { bind A = B; } }`)).toThrow(
      /not supported yet/
    );
  });

  it("無名configurationはクラス本体の直下に書ける（クラススコープ、docs/scoped-configuration.md フェーズ2）", () => {
    // クラス本体直下の無名 configuration は static __dison_classScope に脱糖される。
    const out = transpileDisonToTS(`class A {}\nclass B extends A {}\nclass S { injectable a: A; configuration { bind A = B; } }`);
    expect(out).toContain("static __dison_classScope_0 = __disonBuildFrameLazy(");
    expect(out).toContain("__disonBind(() => A,");
  });

  it("名前付きクラスconfigurationは未対応でパースエラーになる", () => {
    expect(() =>
      transpileDisonToTS(`class S { configuration Cfg { bind A = B; } }`)
    ).toThrow(/not supported yet/);
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
