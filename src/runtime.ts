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
//
// 前方参照対応（docs/config-forward-reference.md）: 登録はFIFOキューに積まれ、
// レジストリを読むたびにドレインされる。キー式はサンクで渡され初回参照時まで
// 評価が遅延されるため、同一ファイル内で後方宣言されたクラスをconfigurationが
// 前方参照できる（TDZを踏まない）。seq比較により同一キーへの複数登録の最終状態は
// 常にソース実行順どおりになる。旧シグネチャ（bindType/registerOverride/
// __disonEnterScope/__disonBuildFrame）は互換のため残し、内部でキュー経由になる。

// スコープ対応に必要な import（AsyncLocalStorage）。生成物のファイル先頭に置く必要が
// あるため、宣言本体（generateRuntimeDeclarations）とは分けて提供する。単一ファイル
// モードでは core.ts が、複数ファイルモードでは共有ランタイムモジュールが先頭に付ける。
export const DISON_RUNTIME_IMPORTS = `import { AsyncLocalStorage } from "node:async_hooks";\n`;

// alsMode（docs/spec-audit-2026-07.md #7）:
//   - "node": 本物の AsyncLocalStorage を使う（要 node:async_hooks import）。ローカル
//     スコープを使うファイル・共有ランタイムモジュールはこちら。
//   - "stub": 同期変数によるスタブ。ローカルスコープを使わないファイルでは、alsの
//     ストアは__disonResolveInjectableの同期的なenter/restoreペアでしか触られないため
//     ただの変数と等価。node:async_hooks への依存が消え、ブラウザ等でも動く。
export function generateRuntimeDeclarations(
  exportKeyword: "" | "export ",
  alsMode: "node" | "stub" = "node"
): string {
  const E = exportKeyword;
  const alsDecl =
    alsMode === "node"
      ? `${E}const __dison_als = new AsyncLocalStorage<__DisonFrame | undefined>();\n`
      : `// AsyncLocalStorage stub: this file uses no local scopes, so the store is only\n` +
        `// touched synchronously (enter/restore pairs inside __disonResolveInjectable).\n` +
        `// A plain variable is equivalent, and it avoids importing the Node-only\n` +
        `// async-hooks module (the generated file also runs outside Node).\n` +
        `${E}const __dison_als = {\n` +
        `  _store: undefined as __DisonFrame | undefined,\n` +
        `  getStore(): __DisonFrame | undefined { return this._store; },\n` +
        `  enterWith(store: __DisonFrame | undefined): void { this._store = store; },\n` +
        `};\n`;
  return (
    `// --- registration queue (docs/config-forward-reference.md) ---\n` +
    `// Registrations are queued (with a global sequence number) and applied lazily the\n` +
    `// first time a registry is read. Key expressions are passed as thunks, so a\n` +
    `// configuration may forward-reference a class declared later in the same file\n` +
    `// without hitting the temporal dead zone. A thunk that still throws ReferenceError\n` +
    `// stays queued and is retried on the next read; seq comparison guarantees that the\n` +
    `// final state for a key always follows source execution order, and that a blocked\n` +
    `// entry never delays unrelated keys.\n` +
    `type __DisonFactory = () => any;\n` +
    `type __DisonKey = string | symbol | Function;\n` +
    `type __DisonSlot = { f: __DisonFactory; seq: number };\n` +
    `type __DisonPendingEntry =\n` +
    `  | { kind: "bind"; key: () => __DisonKey; f: __DisonFactory; seq: number }\n` +
    `  | { kind: "override"; cls: () => Function; prop: string; f: __DisonFactory; seq: number };\n` +
    `// One store shape shared by the global registries and every scope frame.\n` +
    `interface __DisonStore {\n` +
    `  binds: Map<__DisonKey, __DisonSlot>;\n` +
    `  overrides: WeakMap<Function, Record<string, __DisonSlot>>;\n` +
    `  pending: __DisonPendingEntry[];\n` +
    `}\n` +
    `interface __DisonFrame extends __DisonStore {\n` +
    `  parent: __DisonFrame | undefined;\n` +
    `}\n` +
    `let __dison_seq = 0;\n` +
    `function __disonPendBind(store: __DisonStore, key: () => __DisonKey, f: __DisonFactory): void {\n` +
    `  store.pending.push({ kind: "bind", key, f, seq: __dison_seq++ });\n` +
    `}\n` +
    `function __disonPendOverride(store: __DisonStore, cls: () => Function, prop: string, f: __DisonFactory): void {\n` +
    `  store.pending.push({ kind: "override", cls, prop, f, seq: __dison_seq++ });\n` +
    `}\n` +
    `// Drain a store's queue. Entries whose key thunk still hits the TDZ are kept and\n` +
    `// retried later; everything else is applied, newest-seq-wins per key.\n` +
    `function __disonApplyPending(store: __DisonStore): void {\n` +
    `  if (store.pending.length === 0) return;\n` +
    `  const remaining: __DisonPendingEntry[] = [];\n` +
    `  for (const e of store.pending) {\n` +
    `    let key: any;\n` +
    `    try {\n` +
    `      key = e.kind === "bind" ? e.key() : e.cls();\n` +
    `    } catch (err) {\n` +
    `      if (err instanceof ReferenceError) { remaining.push(e); continue; }\n` +
    `      throw err;\n` +
    `    }\n` +
    `    if (e.kind === "bind") {\n` +
    `      const cur = store.binds.get(key);\n` +
    `      if (cur === undefined || cur.seq < e.seq) store.binds.set(key, { f: e.f, seq: e.seq });\n` +
    `    } else {\n` +
    `      let rec = store.overrides.get(key);\n` +
    `      if (rec === undefined) { rec = {}; store.overrides.set(key, rec); }\n` +
    `      const cur = rec[e.prop];\n` +
    `      if (cur === undefined || cur.seq < e.seq) rec[e.prop] = { f: e.f, seq: e.seq };\n` +
    `    }\n` +
    `  }\n` +
    `  store.pending = remaining;\n` +
    `}\n\n` +
    `// --- scope infrastructure (docs/scoped-configuration.md) ---\n` +
    alsDecl +
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
    `// the delta). Within one class the frames are collected in reverse definition order,\n` +
    `// so when the same class body has several configurations for the same key, the LAST\n` +
    `// one wins (matching the last-assignment-wins intuition, and the behavior of\n` +
    `// sequential global registrations and nested local scopes).\n` +
    `function __disonClassScopes(cls: Function): __DisonFrame[] {\n` +
    `  const out: __DisonFrame[] = [];\n` +
    `  for (let c: any = cls; c && c !== Function.prototype && c !== Object; c = Object.getPrototypeOf(c)) {\n` +
    `    const own: __DisonFrame[] = [];\n` +
    `    for (const key of Object.getOwnPropertyNames(c)) {\n` +
    `      if (key.indexOf('__dison_classScope') === 0) own.push(c[key]);\n` +
    `    }\n` +
    `    for (let i = own.length - 1; i >= 0; i--) out.push(own[i]);\n` +
    `  }\n` +
    `  return out;\n` +
    `}\n` +
    `function __disonNewFrame(parent: __DisonFrame | undefined): __DisonFrame {\n` +
    `  return { binds: new Map(), overrides: new WeakMap(), pending: [], parent };\n` +
    `}\n` +
    `// Build a frame without entering it (used to initialize a class body static field).\n` +
    `// The setup callback receives key THUNKS, so a class-body configuration may reference\n` +
    `// classes declared later in the file (evaluated at the first lookup on the frame).\n` +
    `${E}function __disonBuildFrameLazy(\n` +
    `  setup: (bind: (key: () => __DisonKey, factory: __DisonFactory) => void, override: (cls: () => Function, prop: string, factory: __DisonFactory) => void) => void\n` +
    `): __DisonFrame {\n` +
    `  const frame = __disonNewFrame(undefined);\n` +
    `  setup(\n` +
    `    (key, factory) => { __disonPendBind(frame, key, factory); },\n` +
    `    (cls, prop, factory) => { __disonPendOverride(frame, cls, prop, factory); }\n` +
    `  );\n` +
    `  return frame;\n` +
    `}\n` +
    `// Backward-compatible variant taking eager key values (generated by older CLI versions).\n` +
    `${E}function __disonBuildFrame(\n` +
    `  setup: (bind: (key: __DisonKey, factory: __DisonFactory) => void, override: (cls: Function, prop: string, factory: __DisonFactory) => void) => void\n` +
    `): __DisonFrame {\n` +
    `  const frame = __disonNewFrame(undefined);\n` +
    `  setup(\n` +
    `    (key, factory) => { __disonPendBind(frame, () => key, factory); },\n` +
    `    (cls, prop, factory) => { __disonPendOverride(frame, () => cls, prop, factory); }\n` +
    `  );\n` +
    `  return frame;\n` +
    `}\n\n` +
    `// --- global registries ---\n` +
    `// Global dependency registry (per-property override). Keyed by the class itself\n` +
    `// so tsc catches a typo in the override target class name.\n` +
    `${E}const DI_REGISTRY = new WeakMap<Function, Record<string, __DisonSlot>>();\n` +
    `// Global type-replacement registry (bind). Key: class value (concrete class),\n` +
    `// companion/token Symbol, or type-name string. See docs/type-identity-matching.md.\n` +
    `${E}const TYPE_BINDINGS = new Map<__DisonKey, __DisonSlot>();\n` +
    `const __DISON_GLOBAL: __DisonStore = { binds: TYPE_BINDINGS, overrides: DI_REGISTRY, pending: [] };\n\n` +
    `// The Lazy variants take the key as a thunk (forward-reference safe); the plain\n` +
    `// variants keep the old eager-key signature for code generated by older CLI versions.\n` +
    `// bindTypeLazy<T> takes T as an explicit type argument, so tsc raises a compile error\n` +
    `// if the replacement factory isn't compatible with the original type.\n` +
    `${E}function bindTypeLazy<T>(key: () => __DisonKey, factory: () => T): void {\n` +
    `  __disonPendBind(__DISON_GLOBAL, key, factory);\n` +
    `}\n` +
    `${E}function bindType<T>(typeKey: __DisonKey, factory: () => T): void {\n` +
    `  __disonPendBind(__DISON_GLOBAL, () => typeKey, factory);\n` +
    `}\n` +
    `${E}function registerOverrideLazy(cls: () => Function, prop: string, factory: __DisonFactory): void {\n` +
    `  __disonPendOverride(__DISON_GLOBAL, cls, prop, factory);\n` +
    `}\n` +
    `${E}function registerOverride(cls: Function, prop: string, factory: __DisonFactory): void {\n` +
    `  __disonPendOverride(__DISON_GLOBAL, () => cls, prop, factory);\n` +
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
    `  map: { get(k: Function): Record<string, __DisonSlot> | undefined },\n` +
    `  chain: Function[], prop: string\n` +
    `): __DisonFactory | undefined {\n` +
    `  for (const c of chain) {\n` +
    `    const o = map.get(c);\n` +
    `    if (o && Object.prototype.hasOwnProperty.call(o, prop)) return o[prop].f;\n` +
    `  }\n` +
    `  return undefined;\n` +
    `}\n` +
    `// Look up an override in order: local frame chain (inner->outer) -> class scopes\n` +
    `// (child->parent) -> global (priority: local > class > global). Scope-major: each\n` +
    `// layer checks the whole class chain, so a nearer scope targeting a base class\n` +
    `// beats a farther scope targeting the subclass. Each store drains its queue first.\n` +
    `${E}function getOverride(cls: Function, prop: string): __DisonFactory | undefined {\n` +
    `  const chain = __disonClassChain(cls);\n` +
    `  for (let f = __dison_als.getStore(); f; f = f.parent) {\n` +
    `    __disonApplyPending(f);\n` +
    `    const hit = __disonChainLookup(f.overrides, chain, prop);\n` +
    `    if (hit) return hit;\n` +
    `  }\n` +
    `  if (__dison_classScopeCtx) for (const f of __dison_classScopeCtx) {\n` +
    `    __disonApplyPending(f);\n` +
    `    const hit = __disonChainLookup(f.overrides, chain, prop);\n` +
    `    if (hit) return hit;\n` +
    `  }\n` +
    `  __disonApplyPending(__DISON_GLOBAL);\n` +
    `  return __disonChainLookup(DI_REGISTRY, chain, prop);\n` +
    `}\n\n` +
    `const _resolvingTypeBindings = new Set<__DisonKey>();\n\n` +
    `// Look up a bind in order: local frame chain (inner->outer) -> class scopes (child->parent)\n` +
    `// -> global. __dison_classScopeCtx stays set throughout a resolution, so a bind chain inside\n` +
    `// a class scope (the recursion in resolveType) follows the class scope too.\n` +
    `// Each store drains its queue first.\n` +
    `function __disonLookupBind(typeKey: __DisonKey): __DisonFactory | undefined {\n` +
    `  for (let f = __dison_als.getStore(); f; f = f.parent) {\n` +
    `    __disonApplyPending(f);\n` +
    `    const b = f.binds.get(typeKey);\n` +
    `    if (b) return b.f;\n` +
    `  }\n` +
    `  if (__dison_classScopeCtx) for (const f of __dison_classScopeCtx) {\n` +
    `    __disonApplyPending(f);\n` +
    `    const b = f.binds.get(typeKey);\n` +
    `    if (b) return b.f;\n` +
    `  }\n` +
    `  __disonApplyPending(__DISON_GLOBAL);\n` +
    `  return TYPE_BINDINGS.get(typeKey)?.f;\n` +
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
    `function __disonEnterFrame(frame: __DisonFrame): { [Symbol.dispose](): void } {\n` +
    `  const prev = __dison_als.getStore();\n` +
    `  __dison_als.enterWith(frame);\n` +
    `  return { [Symbol.dispose]() { __dison_als.enterWith(prev); } };\n` +
    `}\n` +
    `// The setup callback receives key THUNKS (forward-reference safe within the block).\n` +
    `${E}function __disonEnterScopeLazy(\n` +
    `  setup: (bind: (key: () => __DisonKey, factory: __DisonFactory) => void, override: (cls: () => Function, prop: string, factory: __DisonFactory) => void) => void\n` +
    `): { [Symbol.dispose](): void } {\n` +
    `  const frame = __disonNewFrame(__dison_als.getStore());\n` +
    `  setup(\n` +
    `    (key, factory) => { __disonPendBind(frame, key, factory); },\n` +
    `    (cls, prop, factory) => { __disonPendOverride(frame, cls, prop, factory); }\n` +
    `  );\n` +
    `  return __disonEnterFrame(frame);\n` +
    `}\n` +
    `// Backward-compatible variant taking eager key values (generated by older CLI versions).\n` +
    `${E}function __disonEnterScope(\n` +
    `  setup: (bind: (key: __DisonKey, factory: __DisonFactory) => void, override: (cls: Function, prop: string, factory: __DisonFactory) => void) => void\n` +
    `): { [Symbol.dispose](): void } {\n` +
    `  const frame = __disonNewFrame(__dison_als.getStore());\n` +
    `  setup(\n` +
    `    (key, factory) => { __disonPendBind(frame, () => key, factory); },\n` +
    `    (cls, prop, factory) => { __disonPendOverride(frame, () => cls, prop, factory); }\n` +
    `  );\n` +
    `  return __disonEnterFrame(frame);\n` +
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
