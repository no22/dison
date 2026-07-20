import { describe, it, expect } from "vitest";
import { transpileDisonToTS, DISON_RUNTIME_MODULE_SOURCE } from "./core";

describe("複数ファイル対応フェーズ1（docs/multi-file-support.md）", () => {
  it("既定（オプション省略）ではランタイムをインライン生成する", () => {
    const out = transpileDisonToTS(`class Foo {}\nclass S { injectable dep: Foo; }`);
    // ランタイムの宣言本体がインラインされる（関数定義がある）。
    expect(out).toContain("const DI_REGISTRY = new WeakMap");
    expect(out).toContain("function __disonEnterScope");
    // ローカルスコープを使わないファイルは AsyncLocalStorage の同期スタブでインライン
    // 生成され、node:async_hooks への import は付かない（監査#7）。ランタイム本体を
    // 別モジュールから import もしない。
    expect(out).not.toContain("node:async_hooks");
    expect(out).not.toMatch(/} from "\.\//);
  });

  it("runtimeModulePathを指定すると、ランタイム本体はインラインせずそのパスからimportする", () => {
    const out = transpileDisonToTS(`class Foo {}\nclass S { injectable dep: Foo; }`, {
      runtimeModulePath: "./dison-runtime",
    });
    expect(out).toContain('} from "./dison-runtime";');
    expect(out).toContain("registerOverride");
    expect(out).toContain("__disonResolveInjectable");
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
