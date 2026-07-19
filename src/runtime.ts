// =====================================================================
// 共有ランタイムの前置き生成
// =====================================================================
//
// ランタイムの宣言部分を生成する。exportKeyword に "export " を渡すと各宣言が
// exportされる（複数ファイルで共有するランタイムモジュールとして使う場合）。
// 単一ファイルでインライン生成する場合は ""（空文字）を渡す。
//
// DI_REGISTRY（override用）/TYPE_BINDINGS（bind用）はグローバルな束縛レジストリ。
// クラスは実体（Function）、interface/型エイリアスは companion Symbol または文字列、
// as トークンはそのSymbolをキーにする（docs/type-identity-matching.md、
// docs/bind-interface-token.md）。
//
// スコープ対応（docs/scoped-configuration.md フェーズ1）: 非トップレベルの
// configuration はローカルスコープ（レキシカルなブロック）に閉じる。AsyncLocalStorage
// で現在のスコープフレーム（束縛の差分＋親フレーム）を持ち、getOverride/resolveType は
// 「現在のフレーム鎖（内→外）→ グローバル」の順に解決する。injectable は構築時に
// 現在のフレームを捕捉し、解決時にそのフレームへ再突入する（遅延構築される依存グラフ
// 全体が root の構築スコープに一貫して従う）。ローカルスコープは `using` 宣言で入り、
// 囲みブロックの終端で自動的に元に戻る（Symbol.dispose）。

// スコープ対応に必要な import（AsyncLocalStorage）。生成物のファイル先頭に置く必要が
// あるため、宣言本体（generateRuntimeDeclarations）とは分けて提供する。単一ファイル
// モードでは core.ts が、複数ファイルモードでは共有ランタイムモジュールが先頭に付ける。
export const DISON_RUNTIME_IMPORTS = `import { AsyncLocalStorage } from "node:async_hooks";\n`;

export function generateRuntimeDeclarations(exportKeyword: "" | "export "): string {
  const E = exportKeyword;
  return (
    `// --- scope infrastructure (docs/scoped-configuration.md) ---\n` +
    `type __DisonFactory = () => any;\n` +
    `type __DisonKey = string | symbol | Function;\n` +
    `interface __DisonFrame {\n` +
    `  binds: Map<__DisonKey, __DisonFactory>;\n` +
    `  overrides: WeakMap<Function, Record<string, __DisonFactory>>;\n` +
    `  parent: __DisonFrame | undefined;\n` +
    `}\n` +
    `${E}const __dison_als = new AsyncLocalStorage<__DisonFrame | undefined>();\n` +
    `// Current scope frame (undefined = global only). Captured by injectable at construction.\n` +
    `${E}function __disonCurrentScope(): __DisonFrame | undefined { return __dison_als.getStore(); }\n\n` +
    `// Class scopes (an anonymous configuration directly inside a class body).\n` +
    `// Unlike local scopes (als), a class scope is a static context that is only active\n` +
    `// while resolving an instance of that class, so it is kept in a synchronous module\n` +
    `// variable (not in als, so a dependency doesn't wrongly capture its parent's class\n` +
    `// scope). __disonResolveInjectable sets it for the duration of a resolution and\n` +
    `// restores it afterwards (correct nesting because resolution is synchronous). It stays\n` +
    `// set throughout a resolution, so bind chains inside a class scope are followed too.\n` +
    `let __dison_classScopeCtx: __DisonFrame[] | undefined;\n` +
    `// A class-body configuration is placed as a static __dison_classScope_N field. Walk\n` +
    `// this.constructor's prototype chain (child -> parent) and collect the fields each class\n` +
    `// owns (inheritance: a subclass inherits its parent's class scope and can override just\n` +
    `// the delta).\n` +
    `function __disonClassScopes(cls: Function): __DisonFrame[] {\n` +
    `  const out: __DisonFrame[] = [];\n` +
    `  for (let c: any = cls; c && c !== Function.prototype && c !== Object; c = Object.getPrototypeOf(c)) {\n` +
    `    for (const key of Object.getOwnPropertyNames(c)) {\n` +
    `      if (key.indexOf('__dison_classScope') === 0) out.push(c[key]);\n` +
    `    }\n` +
    `  }\n` +
    `  return out;\n` +
    `}\n` +
    `// Build a frame without entering it (used to initialize a class body static field).\n` +
    `${E}function __disonBuildFrame(\n` +
    `  setup: (bind: (key: __DisonKey, factory: __DisonFactory) => void, override: (cls: Function, prop: string, factory: __DisonFactory) => void) => void\n` +
    `): __DisonFrame {\n` +
    `  const frame: __DisonFrame = { binds: new Map(), overrides: new WeakMap(), parent: undefined };\n` +
    `  setup(\n` +
    `    (key, factory) => { frame.binds.set(key, factory); },\n` +
    `    (cls, prop, factory) => {\n` +
    `      let e = frame.overrides.get(cls);\n` +
    `      if (!e) { e = {}; frame.overrides.set(cls, e); }\n` +
    `      e[prop] = factory;\n` +
    `    }\n` +
    `  );\n` +
    `  return frame;\n` +
    `}\n\n` +
    `// --- global registries ---\n` +
    `// Global dependency registry (per-property override). Keyed by the class itself\n` +
    `// so tsc catches a typo in the override target class name.\n` +
    `${E}const DI_REGISTRY = new WeakMap<Function, Record<string, __DisonFactory>>();\n\n` +
    `${E}function registerOverride(cls: Function, prop: string, factory: __DisonFactory): void {\n` +
    `  let entry = DI_REGISTRY.get(cls);\n` +
    `  if (!entry) { entry = {}; DI_REGISTRY.set(cls, entry); }\n` +
    `  entry[prop] = factory;\n` +
    `}\n\n` +
    `// Override target matching walks the prototype chain of the receiver's class\n` +
    `// (child -> parent, child-wins): an override targeting a base class applies to\n` +
    `// subclass instances too, consistent with how injectable properties and class-scope\n` +
    `// configurations are inherited (docs/override-inheritance.md). Same stop condition\n` +
    `// as __disonClassScopes.\n` +
    `function __disonClassChain(cls: Function): Function[] {\n` +
    `  const out: Function[] = [];\n` +
    `  for (let c: any = cls; c && c !== Function.prototype && c !== Object; c = Object.getPrototypeOf(c)) out.push(c);\n` +
    `  return out;\n` +
    `}\n` +
    `// Match one override table against the class chain (child-wins).\n` +
    `function __disonChainLookup(\n` +
    `  map: { get(k: Function): Record<string, __DisonFactory> | undefined },\n` +
    `  chain: Function[], prop: string\n` +
    `): __DisonFactory | undefined {\n` +
    `  for (const c of chain) {\n` +
    `    const o = map.get(c);\n` +
    `    if (o && Object.prototype.hasOwnProperty.call(o, prop)) return o[prop];\n` +
    `  }\n` +
    `  return undefined;\n` +
    `}\n` +
    `// Look up an override in order: local frame chain (inner->outer) -> class scopes\n` +
    `// (child->parent) -> global (priority: local > class > global). Scope-major: each\n` +
    `// layer checks the whole class chain, so a nearer scope targeting a base class\n` +
    `// beats a farther scope targeting the subclass.\n` +
    `${E}function getOverride(cls: Function, prop: string): __DisonFactory | undefined {\n` +
    `  const chain = __disonClassChain(cls);\n` +
    `  for (let f = __dison_als.getStore(); f; f = f.parent) {\n` +
    `    const hit = __disonChainLookup(f.overrides, chain, prop);\n` +
    `    if (hit) return hit;\n` +
    `  }\n` +
    `  if (__dison_classScopeCtx) for (const f of __dison_classScopeCtx) {\n` +
    `    const hit = __disonChainLookup(f.overrides, chain, prop);\n` +
    `    if (hit) return hit;\n` +
    `  }\n` +
    `  return __disonChainLookup(DI_REGISTRY, chain, prop);\n` +
    `}\n\n` +
    `// Global type-replacement registry (bind). Key: class value (concrete class),\n` +
    `// companion/token Symbol, or type-name string. See docs/type-identity-matching.md.\n` +
    `${E}const TYPE_BINDINGS = new Map<__DisonKey, __DisonFactory>();\n` +
    `const _resolvingTypeBindings = new Set<__DisonKey>();\n\n` +
    `// bindType<T> takes T as an explicit type argument, so tsc raises a compile error\n` +
    `// if the replacement factory isn't compatible with the original type.\n` +
    `${E}function bindType<T>(typeKey: __DisonKey, factory: () => T): void {\n` +
    `  TYPE_BINDINGS.set(typeKey, factory);\n` +
    `}\n\n` +
    `// Look up a bind in order: local frame chain (inner->outer) -> class scopes (child->parent)\n` +
    `// -> global. __dison_classScopeCtx stays set throughout a resolution, so a bind chain inside\n` +
    `// a class scope (the recursion in resolveType) follows the class scope too.\n` +
    `function __disonLookupBind(typeKey: __DisonKey): __DisonFactory | undefined {\n` +
    `  for (let f = __dison_als.getStore(); f; f = f.parent) {\n` +
    `    const b = f.binds.get(typeKey);\n` +
    `    if (b) return b;\n` +
    `  }\n` +
    `  if (__dison_classScopeCtx) for (const f of __dison_classScopeCtx) {\n` +
    `    const b = f.binds.get(typeKey);\n` +
    `    if (b) return b;\n` +
    `  }\n` +
    `  return TYPE_BINDINGS.get(typeKey);\n` +
    `}\n\n` +
    `// Scope-aware bind resolution. bind chains (bind A = B; bind B = C; resolves A to C).\n` +
    `// Each hop of the chain also consults the current frame chain -> class -> global.\n` +
    `// A cycle raises a clear error.\n` +
    `${E}function resolveType<T>(typeKey: __DisonKey, defaultFactory: () => T): T {\n` +
    `  const bound = __disonLookupBind(typeKey);\n` +
    `  if (!bound) return defaultFactory();\n` +
    `  if (_resolvingTypeBindings.has(typeKey)) {\n` +
    `    const label = typeof typeKey === 'function' ? (typeKey.name || '<anonymous class>') : String(typeKey);\n` +
    `    throw new Error('Detected a circular "bind" reference ("' + label + '"). The bind chain loops back on itself.');\n` +
    `  }\n` +
    `  _resolvingTypeBindings.add(typeKey);\n` +
    `  try { return bound(); } finally { _resolvingTypeBindings.delete(typeKey); }\n` +
    `}\n\n` +
    `// injectable resolution. Re-enter the local scope captured at construction (scope) and set\n` +
    `// this's class scope (cls's prototype chain) for the duration of the resolution. Re-entering\n` +
    `// makes any dependency lazily constructed inside fallback run under the same local scope and\n` +
    `// capture it too (the whole graph follows root's construction scope). The class scope is not\n` +
    `// put in als, so a dependency never wrongly inherits this's class scope (it uses its own\n` +
    `// this.constructor's class scope). Priority: override > fallback (bind or default\n` +
    `// initializer), and within each: local > class > global.\n` +
    `${E}function __disonResolveInjectable<T>(scope: __DisonFrame | undefined, cls: Function, prop: string, fallback: () => T): T {\n` +
    `  const prevLocal = __dison_als.getStore();\n` +
    `  const prevClass = __dison_classScopeCtx;\n` +
    `  __dison_als.enterWith(scope);\n` +
    `  __dison_classScopeCtx = __disonClassScopes(cls);\n` +
    `  try {\n` +
    `    const ov = getOverride(cls, prop);\n` +
    `    return ov ? ov() : fallback();\n` +
    `  } finally {\n` +
    `    __dison_als.enterWith(prevLocal);\n` +
    `    __dison_classScopeCtx = prevClass;\n` +
    `  }\n` +
    `}\n\n` +
    `// Desugar target for a non-top-level configuration. Build a new frame whose parent is the\n` +
    `// current frame, populate its bind/override via setup, and enter it (enterWith). The return\n` +
    `// value has Symbol.dispose, so a \`using\` declaration restores the previous frame at the end\n` +
    `// of the enclosing block. setup uses the bind/override helpers to add the deltas.\n` +
    `${E}function __disonEnterScope(\n` +
    `  setup: (bind: (key: __DisonKey, factory: __DisonFactory) => void, override: (cls: Function, prop: string, factory: __DisonFactory) => void) => void\n` +
    `): { [Symbol.dispose](): void } {\n` +
    `  const frame: __DisonFrame = { binds: new Map(), overrides: new WeakMap(), parent: __dison_als.getStore() };\n` +
    `  setup(\n` +
    `    (key, factory) => { frame.binds.set(key, factory); },\n` +
    `    (cls, prop, factory) => {\n` +
    `      let e = frame.overrides.get(cls);\n` +
    `      if (!e) { e = {}; frame.overrides.set(cls, e); }\n` +
    `      e[prop] = factory;\n` +
    `    }\n` +
    `  );\n` +
    `  const prev = __dison_als.getStore();\n` +
    `  __dison_als.enterWith(frame);\n` +
    `  return { [Symbol.dispose]() { __dison_als.enterWith(prev); } };\n` +
    `}\n`
  );
}

// 複数ファイルでランタイム状態を共有するための共有ランタイムモジュールのソース。
// scripts/generate-runtime-module.tsがこれをsrc/generated-runtime.tsとして書き出し、
// tscがdist/にコンパイルすることで、"dison/runtime" として配布される
// （docs/packaging.md）。AsyncLocalStorage の import を先頭に付ける。
export const DISON_RUNTIME_MODULE_SOURCE: string =
  DISON_RUNTIME_IMPORTS +
  `// --- Dison shared runtime module ---\n` +
  `// Multiple generated files import this module to share runtime state\n` +
  `// such as DI_REGISTRY/TYPE_BINDINGS and the scope infrastructure.\n` +
  `// This file is auto-generated when the Dison package is built. Do not edit it by hand.\n\n` +
  generateRuntimeDeclarations("export ");
