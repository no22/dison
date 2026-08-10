// =====================================================================
// configuration の継承（extends）の解決と平坦化
// =====================================================================
//
// docs/configuration-inheritance.md の実装。`configuration [Name] extends A, B { ... }`
// の継承元を解決し、実効エントリ列へ平坦化する。
//
//   flatten(C) = [...flatten(P1), ...flatten(P2), ..., ...own(C)]
//
// 同一キーは後勝ち。これで「子が親に勝つ」「右の親が左の親に勝つ」が両方得られ、
// 既存の登録順（seq）規則とも一致する。
//
// 平坦化されたエントリは「由来（宣言元 configuration 名）」と「宣言元ファイル」を
// 伴う。由来は兄弟衝突の検出に、宣言元ファイルは静的解決の factory hoisting に使う。

import type { ConfigEntry, Node, ProvidesKey } from "./ast.js";

// override エントリのキー正規化に使う共通形（対象クラス正準 ID とプロパティの組）。
export function overridePairKeys(className: string, entry: Extract<ConfigEntry, { kind: "override" }>): string[] {
  return entry.assignments.map((a) => `override ${className} ${a.prop}`);
}

export type ConfigurationNode = Extract<Node, { kind: "configuration" }>;

// 名前付き configuration の宣言（どのファイルのものか付き）。
export interface ConfigDecl<F> {
  node: ConfigurationNode;
  file: F;
}

// 名前 → 宣言 のリゾルバ。単一ファイルモードはローカル宣言のみ、複数ファイル
// モードはプロジェクト全体を解決する（呼び出し側が与える）。
export type ConfigResolver<F> = (name: string, from: F) => ConfigDecl<F> | undefined;

// 平坦化済みの1エントリ。
export interface FlatEntry<F> {
  entry: ConfigEntry;
  // 式の字句的な所属ファイル（factory hoisting の home）。
  file: F;
  // このエントリを宣言した configuration 名（無名なら undefined）。兄弟衝突の判定に使う。
  origin: string | undefined;
}

export interface ConfigDiagnostic {
  message: string;
}

export interface FlattenResult<F> {
  entries: FlatEntry<F>[];
  diagnostics: ConfigDiagnostic[];
}

// キー正規化。bind は照合キー文字列、override は (対象クラス, プロパティ) の組。
// 単一ファイル（keyExprFor ベース）と複数ファイル（canonKey ベース）で規則が違うため、
// 呼び出し側から関数として受け取る（二重実装を避ける）。
export interface KeyNormalizer<F> {
  bindKey(entry: Extract<ConfigEntry, { kind: "bind" }>, file: F): string;
  overrideKeys(entry: Extract<ConfigEntry, { kind: "override" }>, file: F): string[];
}

/**
 * configuration を平坦化する。`extends` の循環と、兄弟（互いに継承関係にない親）が
 * 同じキーを別々に束縛する衝突を診断として返す。
 *
 * 衝突判定は「由来（宣言元 configuration 名）」で行うため、菱形継承
 * （C extends A, B で A/B がともに Base から継いだ束縛）は衝突にならない。
 * 子自身が同じキーを上書きしていれば、その時点で曖昧さは解消するので衝突にしない。
 */
export function flattenConfiguration<F>(
  node: ConfigurationNode,
  file: F,
  resolve: ConfigResolver<F>,
  // 省略すると兄弟衝突の検出を行わない（解析器はエントリ列だけを必要とするため）。
  keys?: KeyNormalizer<F>
): FlattenResult<F> {
  const diagnostics: ConfigDiagnostic[] = [];
  const seenDiagnostics = new Set<string>();
  const pushDiag = (message: string): void => {
    if (seenDiagnostics.has(message)) return;
    seenDiagnostics.add(message);
    diagnostics.push({ message });
  };

  // 祖先関係の判定に使う「configuration 名 → その祖先集合」。
  const ancestorsOf = new Map<string, Set<string>>();

  const collectAncestors = (name: string, from: F, stack: string[]): Set<string> => {
    const cached = ancestorsOf.get(name);
    if (cached !== undefined) return cached;
    const out = new Set<string>();
    const decl = resolve(name, from);
    if (decl !== undefined) {
      for (const parent of decl.node.extendsNames ?? []) {
        if (stack.includes(parent)) continue; // 循環は flatten 側で報告
        out.add(parent);
        for (const a of collectAncestors(parent, decl.file, [...stack, parent])) out.add(a);
      }
    }
    ancestorsOf.set(name, out);
    return out;
  };

  const isAncestor = (maybeAncestor: string, of: string, from: F): boolean =>
    collectAncestors(of, from, [of]).has(maybeAncestor);

  const out: FlatEntry<F>[] = [];
  const visiting: string[] = [];

  const walk = (n: ConfigurationNode, f: F, origin: string | undefined): void => {
    // 実行時選択の葉は「どれが選ばれるか不明」なので、解析上は全葉を合併して扱う
    // （静的解決側は全葉を動的 taint にする。docs/activate-sugar-implementation.md §1.4）。
    for (const sel of n.extendsSelections ?? []) {
      for (const leaf of sel.leaves) {
        if (visiting.includes(leaf)) continue;
        const decl = resolve(leaf, f);
        if (decl === undefined) {
          pushDiag(
            `configuration "${leaf}" in an "extends (...)" selection could not be resolved. ` +
              `Declare it in this file, or pass the file that declares it to the CLI as well.`
          );
          continue;
        }
        visiting.push(leaf);
        walk(decl.node, decl.file, leaf);
        visiting.pop();
      }
    }
    for (const parentName of n.extendsNames ?? []) {
      if (visiting.includes(parentName)) {
        pushDiag(
          `configuration "${parentName}" is part of an "extends" cycle (${[...visiting, parentName].join(" -> ")}).`
        );
        continue;
      }
      const decl = resolve(parentName, f);
      if (decl === undefined) {
        // `activate X from "./p"` 由来（extendsFrom で specifier が明示されている）の
        // 場合、その configuration の中身は意図的に読まない仕様なので未解決は正常
        // （docs/activate-from-syntax.md／activate-sugar-implementation.md §2.1）。
        // 生成側は import と呼び出しを出すだけで、エントリは見えないまま。
        if (n.extendsFrom?.[parentName] !== undefined) continue;
        // `import { activateX } from "..."` だけがある場合も、その configuration の
        // 中身は見えないのが仕様（docs/multi-file-support.md）。未解決は正常。
        if (n.extendsExternal?.includes(parentName) === true) continue;
        pushDiag(
          `configuration "${parentName}" in the "extends" clause of ${
            origin !== undefined ? `configuration "${origin}"` : "an anonymous configuration"
          } could not be resolved. Declare it in this file, or pass the file that declares it to the CLI as well.`
        );
        continue;
      }
      visiting.push(parentName);
      walk(decl.node, decl.file, parentName);
      visiting.pop();
    }
    for (const entry of n.entries) out.push({ entry, file: f, origin });
  };

  walk(node, file, node.name);

  // --- 兄弟衝突の検出 ---
  // 同一キーに複数の由来があり、どれも互いに祖先関係になく、かつ子自身
  // （= 最後の由来である node 自身のエントリ）が上書きしていない場合はエラー。
  const byKey = new Map<string, FlatEntry<F>[]>();
  if (keys === undefined) return { entries: out, diagnostics };
  for (const fe of out) {
    const ks =
      fe.entry.kind === "bind"
        ? [keys.bindKey(fe.entry, fe.file)]
        : keys.overrideKeys(fe.entry, fe.file);
    for (const k of ks) {
      let arr = byKey.get(k);
      if (arr === undefined) {
        arr = [];
        byKey.set(k, arr);
      }
      arr.push(fe);
    }
  }

  const selfOrigin = node.name;
  for (const [, group] of byKey) {
    if (group.length < 2) continue;
    // 自分自身（展開先の configuration）が同じキーを持っていれば、そこで曖昧さは解消。
    const resolvedBySelf = group.some((g) => g.origin === selfOrigin);
    if (resolvedBySelf) continue;
    const origins = [...new Set(group.map((g) => g.origin).filter((o): o is string => o !== undefined))];
    if (origins.length < 2) continue; // 同じ由来（菱形の共通祖先など）→ 衝突ではない
    // 互いに祖先関係にある組は「子が親を上書き」なので衝突ではない。
    for (let i = 0; i < origins.length; i++) {
      for (let j = i + 1; j < origins.length; j++) {
        const a = origins[i];
        const b = origins[j];
        if (isAncestor(a, b, file) || isAncestor(b, a, file)) continue;
        // 両方を継承する configuration が同じキーを書いていれば、そこで曖昧さは
        // 解消済み（例: Both extends Left, Right { bind K = ... } を activate した場合、
        // 展開元が無名でも Both が解決している）。
        if (origins.some((o) => isAncestor(a, o, file) && isAncestor(b, o, file))) continue;
        const label = group[0].entry.kind === "bind"
          ? `bind "${(group[0].entry as Extract<ConfigEntry, { kind: "bind" }>).originalTypeName}"`
          : `override "${(group[0].entry as Extract<ConfigEntry, { kind: "override" }>).className}"`;
        pushDiag(
          `configurations "${a}" and "${b}" both wire ${label}, and neither extends the other. ` +
            `${selfOrigin !== undefined ? `configuration "${selfOrigin}"` : "The extending configuration"} must wire it explicitly to say which one wins.`
        );
      }
    }
  }

  return { entries: out, diagnostics };
}

/**
 * ファイル内の名前付きグローバル configuration を名前で引ける Map にする。
 */
export function namedGlobalConfigurations(ast: Node[]): Map<string, ConfigurationNode> {
  const out = new Map<string, ConfigurationNode>();
  for (const node of ast) {
    if (node.kind === "configuration" && node.scope === "global" && node.name !== undefined) {
      out.set(node.name, node);
    }
  }
  return out;
}

/**
 * 「フレーム形の applier（__dison_config_X）を emit すべき configuration 名」を求める。
 * ローカル/クラススコープへの展開（`configuration extends X {}` が関数本体やクラス本体に
 * 書かれた場合）だけが applier を必要とする。グローバルへの展開は activateX() 呼び出しで
 * 足りる（docs/configuration-inheritance.md §3.2）。
 *
 * 継承は推移するため、applier が要る configuration の祖先にも applier が要る。
 */
export function configurationsNeedingApplier(
  ast: Node[],
  resolveLocal: (name: string) => ConfigurationNode | undefined
): Set<string> {
  const needed = new Set<string>();
  const addWithAncestors = (name: string, stack: string[]): void => {
    if (needed.has(name) || stack.includes(name)) return;
    needed.add(name);
    const decl = resolveLocal(name);
    for (const parent of decl?.extendsNames ?? []) addWithAncestors(parent, [...stack, name]);
  };
  for (const node of ast) {
    if (node.kind !== "configuration") continue;
    // 実行時選択（extends (...)）は葉を**値として**参照するため、位置がグローバルでも
    // applier が要る（docs/activate-sugar-implementation.md §1.3）。
    for (const sel of node.extendsSelections ?? []) {
      for (const leaf of sel.leaves) addWithAncestors(leaf, []);
    }
    if (node.scope === "global") continue; // グローバル展開は activateX() で足りる
    for (const name of node.extendsNames ?? []) addWithAncestors(name, []);
  }
  return needed;
}

/**
 * ファイル内の全 configuration について継承を平坦化し、循環・兄弟衝突の診断を集める。
 * 呼び出し側（core.ts / CLI）がこれをエラーとして報告する。
 */
export function collectInheritanceDiagnostics<F>(
  ast: Node[],
  file: F,
  resolve: ConfigResolver<F>,
  keys: KeyNormalizer<F>
): ConfigDiagnostic[] {
  const out: ConfigDiagnostic[] = [];
  const seen = new Set<string>();
  for (const node of ast) {
    if (node.kind !== "configuration") continue;
    if (node.extendsNames === undefined) continue;
    for (const d of flattenConfiguration(node, file, resolve, keys).diagnostics) {
      if (seen.has(d.message)) continue;
      seen.add(d.message);
      out.push(d);
    }
  }
  return out;
}


/**
 * `provides` 節の検査（docs/configuration-provides.md）。
 *
 * 宣言された集合 ⊆ 実効エントリのキー集合、を検査する。実効エントリは平坦化済み
 * （`extends` で継いだ分を含む）。実行時選択 `extends (cond ? A : B)` は
 * **全葉の積集合**（どの葉が選ばれても提供される分だけ）を実効とみなす
 * ——docs/activate-sugar-implementation.md §1.5 の被覆チェックと同一の規則。
 *
 * providesKeyOf: 宣言キーを正規化する関数（bind は keyExprFor/canonKey と同じ規則で、
 * override は「対象クラス正準ID プロパティ」）。呼び出し側が単一ファイル用/プロジェクト
 * 用のどちらかを渡す。
 */
export function findProvidesViolations<F>(
  ast: Node[],
  file: F,
  resolve: ConfigResolver<F>,
  keys: KeyNormalizer<F>,
  providesKeyOf: (key: ProvidesKey, file: F) => string
): ConfigDiagnostic[] {
  const out: ConfigDiagnostic[] = [];
  const seen = new Set<string>();
  const push = (message: string): void => {
    if (seen.has(message)) return;
    seen.add(message);
    out.push({ message });
  };

  // configuration の実効キー集合（平坦化済みエントリを正規化したもの）。
  const effectiveKeysOf = (node: ConfigurationNode, f: F): Set<string> => {
    const set = new Set<string>();
    for (const fe of flattenConfiguration(node, f, resolve).entries) {
      if (fe.entry.kind === "bind") set.add(keys.bindKey(fe.entry, fe.file));
      else for (const k of keys.overrideKeys(fe.entry, fe.file)) set.add(k);
    }
    return set;
  };

  for (const node of ast) {
    if (node.kind !== "configuration") continue;
    const declared = node.providesKeys;
    if (declared === undefined || declared.length === 0) continue;

    const label =
      node.name !== undefined ? `configuration "${node.name}"` : "this configuration";

    // 静的な extends と自身のエントリ（選択形の葉は含めない）。
    const staticKeys = effectiveKeysOf({ ...node, extendsSelections: undefined }, file);

    // 選択形は葉ごとに実効集合を出し、積集合だけを保証とみなす。
    // 葉ごとの内訳はエラーメッセージ（どの葉が欠けているか）に使う。
    const leafSets: { leaf: string; keys: Set<string> }[] = [];
    for (const sel of node.extendsSelections ?? []) {
      for (const leaf of sel.leaves) {
        const decl = resolve(leaf, file);
        leafSets.push({ leaf, keys: decl === undefined ? new Set() : effectiveKeysOf(decl.node, decl.file) });
      }
    }

    for (const key of declared) {
      const norm = providesKeyOf(key, file);
      const shown =
        key.kind === "bind" ? key.typeName + (key.token !== undefined ? ` as ${key.token}` : "") : `${key.className}.${key.prop}`;
      if (staticKeys.has(norm)) continue;

      if (leafSets.length > 0) {
        const missing = leafSets.filter((l) => !l.keys.has(norm));
        if (missing.length === 0) continue; // 全葉が提供 → 積集合に入る
        const rows = leafSets
          .map((l) => `    ${l.leaf} ${l.keys.has(norm) ? "provides it" : "does NOT provide it"}`)
          .join("\n");
        push(
          `${label} declares that it provides "${shown}", but the runtime selection can pick a ` +
            `configuration that does not provide it:\n${rows}`
        );
        continue;
      }

      push(
        `${label} declares that it provides "${shown}", but nothing in it (or in the ` +
          `configurations it extends) wires that key. Add the wiring, or remove "${shown}" ` +
          `from the "provides" clause.`
      );
    }
  }
  return out;
}
