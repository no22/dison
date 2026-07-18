// =====================================================================
// 共有ランタイムの前置き生成
// =====================================================================

// ランタイムの宣言部分（DI_REGISTRY/TYPE_BINDINGS/bindType/resolveType/
// registerOverride/getOverride）を生成する。exportKeyword に "export " を渡すと
// 各宣言がexportされる（複数ファイルで共有するランタイムモジュールとして使う
// 場合）。単一ファイルでインライン生成する場合は ""（空文字）を渡す。
//
// DI_REGISTRY（override用）はクラス名の文字列ではなく、クラスの実体そのものを
// キーにする（WeakMap<Function, ...>）。理由:
//   - override対象のクラス名が実際にスコープ内に存在するか（importし忘れ・
//     タイプミスがないか）をtsc自身が「名前が見つからない」エラーとして
//     検出できるようになる（従来は文字列一致だったため、タイプミスしても
//     一切検出されずDI_REGISTRY["Typo"]という誰も参照しないエントリを
//     静かに作るだけだった）。
//   - 複数ファイルにまたがって同名クラスが存在しても、参照そのものが
//     キーになるため衝突しない（docs/multi-file-support.md参照）。
//
// TYPE_BINDINGS（bind用）は従来通り型名の文字列でキー化する。bindの左辺は
// interface/型エイリアスもあり得るが、これらは実行時に値を持たないため
// DI_REGISTRYと同じ手法（実体参照でのキー化）が使えない。複数ファイルに
// またがるinterface/型エイリアスの名前衝突は未解決の課題として残る
// （docs/multi-file-support.md 3.4節）。
export function generateRuntimeDeclarations(exportKeyword: "" | "export "): string {
  return (
    `// Global dependency registry (per-property override).\n` +
    `// Keying on the class itself (not its name) lets tsc catch a typo in the\n` +
    `// override target class name as a "Cannot find name" error.\n` +
    `${exportKeyword}const DI_REGISTRY = new WeakMap<Function, Record<string, () => any>>();\n\n` +
    `${exportKeyword}function registerOverride(cls: Function, prop: string, factory: () => any): void {\n` +
    `  let entry = DI_REGISTRY.get(cls);\n` +
    `  if (!entry) {\n` +
    `    entry = {};\n` +
    `    DI_REGISTRY.set(cls, entry);\n` +
    `  }\n` +
    `  entry[prop] = factory;\n` +
    `}\n\n` +
    `${exportKeyword}function getOverride(cls: Function, prop: string): (() => any) | undefined {\n` +
    `  return DI_REGISTRY.get(cls)?.[prop];\n` +
    `}\n\n` +
    `// Global type-replacement registry (bind).\n` +
    `// The key is either a type-name string (class, interface, or type alias name)\n` +
    `// or a Symbol explicitly given via an "as <token>" clause (used to avoid\n` +
    `// name collisions between same-named interfaces/type aliases across files).\n` +
    `${exportKeyword}const TYPE_BINDINGS = new Map<string | symbol, () => any>();\n` +
    `const _resolvingTypeBindings = new Set<string | symbol>();\n\n` +
    `// bindType<T> takes T as an explicit type argument, so tsc raises a\n` +
    `// compile error if the replacement factory isn't compatible with the\n` +
    `// original type. T may be an interface or type alias (used only as a\n` +
    `// type argument).\n` +
    `${exportKeyword}function bindType<T>(typeKey: string | symbol, factory: () => T): void {\n` +
    `  TYPE_BINDINGS.set(typeKey, factory);\n` +
    `}\n\n` +
    `// Resolves a value by recursively walking TYPE_BINDINGS. bind chains\n` +
    `// (e.g. bind A = B; bind B = C; makes resolving A eventually reach C).\n` +
    `// A cycle (A -> B -> A) raises a clear error instead of a stack overflow.\n` +
    `${exportKeyword}function resolveType<T>(typeKey: string | symbol, defaultFactory: () => T): T {\n` +
    `  const bound = TYPE_BINDINGS.get(typeKey);\n` +
    `  if (!bound) return defaultFactory();\n` +
    `  if (_resolvingTypeBindings.has(typeKey)) {\n` +
    `    throw new Error('Detected a circular "bind" reference ("' + String(typeKey) + '"). The bind chain loops back on itself.');\n` +
    `  }\n` +
    `  _resolvingTypeBindings.add(typeKey);\n` +
    `  try {\n` +
    `    return bound();\n` +
    `  } finally {\n` +
    `    _resolvingTypeBindings.delete(typeKey);\n` +
    `  }\n` +
    `}\n`
  );
}

// 複数ファイルでランタイム状態（DI_REGISTRY/TYPE_BINDINGS）を共有するための
// 共有ランタイムモジュールのソース。scripts/generate-runtime-module.tsが
// これをsrc/generated-runtime.tsとして書き出し、tscがdist/にコンパイルする
// ことで、"dison/runtime" として配布される（docs/packaging.md）。
export const DISON_RUNTIME_MODULE_SOURCE: string =
  `// --- Dison shared runtime module ---\n` +
  `// Multiple generated files import this module to share runtime state\n` +
  `// such as DI_REGISTRY/TYPE_BINDINGS.\n` +
  `// This file is auto-generated when the Dison package is built. Do not edit it by hand.\n\n` +
  generateRuntimeDeclarations("export ");
