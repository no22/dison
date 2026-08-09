import { describe, it, expect } from "vitest";
import { transpileDisonToTS } from "./core";

describe("injectable: 安全な型（new可能なクラス型）", () => {
  it("型注釈のみ（裸の宣言）なら new T() が自動生成される", () => {
    const out = transpileDisonToTS(`
class Foo {}
class S {
  injectable dep: Foo;
}
`);
    expect(out).toContain("new Foo()");
    expect(out).toContain("get dep(): Foo {");
  });

  it("'= 式' を明示すればそれが使われる（コンストラクタ引数を渡すケースなど）", () => {
    const out = transpileDisonToTS(`
class Foo {
  constructor(public x: number) {}
}
class S {
  injectable dep: Foo = new Foo(42);
}
`);
    expect(out).toContain("new Foo(42)");
  });

  it("宣言マージ（同名の class と interface）は安全側に判定され省略可能", () => {
    const out = transpileDisonToTS(`
class Foo { m(): void {} }
interface Foo { extra?: string; }
class S {
  injectable dep: Foo;
}
`);
    expect(out).toContain("new Foo()");
  });
});

describe("injectable: 危険な型には既定初期化式 '= 式' が必須", () => {
  it("interface型は '= 式' が無くても、束縛が無ければ被覆チェックのエラーになる（2.1で緩和）", () => {
    expect(() =>
      transpileDisonToTS(`
interface IRepo { find(): void; }
class S { injectable dep: IRepo; }
`)
    ).toThrow(/default initializer/);
  });

  it("interface型に '= 式' があれば成功する", () => {
    const out = transpileDisonToTS(`
interface IRepo { find(): void; }
class Impl implements IRepo { find(): void {} }
class S { injectable dep: IRepo = new Impl(); }
`);
    expect(out).toContain("new Impl()");
  });

  it("type エイリアスは '= 式' が無くても、束縛が無ければ被覆チェックのエラーになる（2.1で緩和）", () => {
    expect(() =>
      transpileDisonToTS(`
type Handler = { run(): void };
class S { injectable dep: Handler; }
`)
    ).toThrow(/default initializer/);
  });

  it("abstract classは '= 式' が無くても、束縛が無ければ被覆チェックのエラーになる（2.1で緩和）", () => {
    expect(() =>
      transpileDisonToTS(`
abstract class Base { abstract greet(): string; }
class S { injectable dep: Base; }
`)
    ).toThrow(/default initializer/);
  });

  it("abstract classに '= 式' があれば成功し、new Base() は生成されない", () => {
    const out = transpileDisonToTS(`
abstract class Base { abstract greet(): string; }
class Concrete extends Base { greet() { return "hi"; } }
class S { injectable dep: Base = new Concrete(); }
`);
    expect(out).not.toContain("new Base()");
    expect(out).toContain("new Concrete()");
  });

  it("配列型に '= 式' が無いとパースエラーになる", () => {
    expect(() => transpileDisonToTS(`class S { injectable items: string[]; }`)).toThrow(/default initializer/);
  });

  it("ユニオン型に '= 式' が無いとパースエラーになる", () => {
    expect(() => transpileDisonToTS(`class S { injectable v: string | number; }`)).toThrow(/default initializer/);
  });

  it("関数型に '= 式' が無いとパースエラーになる", () => {
    expect(() =>
      transpileDisonToTS(`class S { injectable handler: (x: number) => void; }`)
    ).toThrow(/default initializer/);
  });

  it("関数型の '=>' は既定初期化式の区切りの '=' と正しく区別される", () => {
    const out = transpileDisonToTS(`
class S {
  injectable handler: (x: number) => void = (x) => { x; };
}
`);
    expect(out).toContain("(x: number) => void");
    expect(out).toContain("(x) => { x; }");
  });
});
