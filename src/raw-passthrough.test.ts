import { describe, it, expect } from "vitest";
import { transpileDisonToTS } from "./core";

describe("Rawパススルー", () => {
  it("DSL構文を含まない通常のTypeScriptコードは1文字も変更されない", () => {
    const src = `
class Foo {
  greet(): string {
    return "hi"; // コメントもそのまま
  }
}
const x = 1;
`;
    expect(transpileDisonToTS(src)).toContain(src);
  });

  it("injectable/activate/bind/override/configurationという名前の変数やメソッドは誤検出されない", () => {
    const src = `
class Service {
  injectable(): void {}
  activate(x: number): number { return x; }
}
const bind = 1;
const override = 2;
const configuration = { key: "value" };
`;
    expect(transpileDisonToTS(src)).toContain(src);
  });
});
