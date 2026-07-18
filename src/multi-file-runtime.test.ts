import { describe, it, expect } from "vitest";
import { transpileDisonToTS, DISON_RUNTIME_MODULE_SOURCE } from "./core";

describe("複数ファイル対応フェーズ1（docs/multi-file-support.md）", () => {
  it("既定（オプション省略）では従来通りランタイムをインライン生成する", () => {
    const out = transpileDisonToTS(`class Foo {}\nclass S { injectable dep: Foo; }`);
    expect(out).toContain("const DI_REGISTRY = new WeakMap");
    expect(out).not.toContain("import {");
  });

  it("runtimeModulePathを指定すると、インライン生成の代わりにimport文になる", () => {
    const out = transpileDisonToTS(`class Foo {}\nclass S { injectable dep: Foo; }`, {
      runtimeModulePath: "./dison-runtime",
    });
    expect(out).toContain('} from "./dison-runtime";');
    expect(out).toContain("DI_REGISTRY");
    expect(out).toContain("registerOverride");
    expect(out).not.toContain("const DI_REGISTRY = new WeakMap");
  });

  it("DISON_RUNTIME_MODULE_SOURCEは共有ランタイムに必要な要素をすべてexportする", () => {
    for (const name of ["DI_REGISTRY", "TYPE_BINDINGS", "bindType", "resolveType", "registerOverride", "getOverride"]) {
      expect(DISON_RUNTIME_MODULE_SOURCE).toContain(`export`);
      expect(DISON_RUNTIME_MODULE_SOURCE).toMatch(new RegExp(`export (const|function) ${name}\\b`));
    }
  });

  it("configurationはexportされ、他ファイルからimportできる形になる", () => {
    const out = transpileDisonToTS(`configuration Cfg {}`);
    expect(out).toContain("export function activateCfg()");
  });

  it("他ファイルからactivateXxxをimportしていれば、同一ファイルにconfiguration定義が無くてもactivateできる", () => {
    // configuration自体は別ファイル(configs.dis相当)にあり、このファイルは
    // import { activateTestConfig } from "./configs"; だけを持つ、という想定。
    expect(() =>
      transpileDisonToTS(`
import { activateTestConfig } from "./configs";
activate TestConfig;
`)
    ).not.toThrow();
  });

  it("importされていない未知のconfiguration名は従来通りパースエラーになる", () => {
    expect(() =>
      transpileDisonToTS(`
import { somethingElse } from "./configs";
activate TestConfig;
`)
    ).toThrow(/is not defined/);
  });
});
