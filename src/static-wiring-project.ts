// =====================================================================
// 静的解決 フェーズ2: 複数ファイル（プロジェクト全体）の配線解析
// =====================================================================
//
// docs/static-resolution-design.md §8 の実装。複数ファイルモードは共有ランタイム
// （dison/runtime）を介して全ファイルの配線が同じレジストリに載るため、畳み込みの
// 判定はプロジェクト全体で行う必要がある。単一ファイル版（static-wiring.ts）との
// 主な違い:
//
//   - **モジュール評価順**: ES Modules の評価順（import グラフの DFS 後行順）を
//     静的に求め、全ファイルのトップレベル文をひとつの直列プログラムとみなして
//     フロー解析する。評価順が一意に定まらない場合（エントリ候補が複数・循環・
//     プロジェクト外の相対 import が挟まる等）は、順序に依存する配線をすべて
//     動的に落とす（L0＝配線が全く無いキーの畳み込みだけは順序と無関係に安全）。
//   - **キーの正準化**: 同じクラス/interface/token がファイルごとに別名で見える
//     ため、キーを「宣言ファイル::宣言名」へ正準化して照合する。由来を静的に
//     解決できない名前は「同名はすべて同一かもしれない」側に倒して合流させる
//     （taint の取りこぼしを防ぐ。過剰に畳まない方向なので健全）。
//   - **factory hoisting**: 勝者式の字句的な所属ファイル W と、ゲッターの
//     ファイル G が異なる場合、式を G へインライン出来ない（W のローカル宣言や
//     import を参照しうるため）。W 側に `export const __dison_factory_N = () =>
//     (式);` を生成し、G はそれを static import して直接呼ぶ。レジストリ探索は
//     発生しない。評価順を変えないため、G→W の import 追加が安全な場合
//     （W が元々 G より先に評価される、または W が import グラフ上 G の祖先）
//     のみ許可し、それ以外は動的に落とす。
//
// 生成側との受け渡しは ProjectFileWiring（ファイルごとのスライス）。injectable の
// 判定は AST 出現順のインデックスで渡す（CLI 側の解析と transpileDisonToTS 側の
// パースは同じ決定的順序になるため）。

import * as path from "path";
import { Lexer } from "./lexer.js";
import type { Token } from "./lexer.js";
import { Parser } from "./parser.js";
import type { Node, BindEntry, OverrideEntry, ConfigEntry } from "./ast.js";
import {
  collectDeclaredTypeKinds,
  collectImportBindings,
  collectBlockContext,
  trueInterfaceOrAliasNames,
  identityKeyableClassNames,
  isSimpleTypeShape,
  baseIdentifierOf,
  parseStringLiteralValue,
  type ImportBinding,
} from "./analysis.js";
import {
  collectTopLevelClasses,
  enclosingTopLevelClass,
  renderInjectedGetter,
  buildDisonStarts,
  analyzeWinnerExpr,
  analyzeTopLevel,
  collectExprMentions,
  DANGEROUS_GLOBALS,
  type TopLevelBarrier,
  type ClassInfo,
  type WiringDecision,
} from "./static-wiring.js";
import type { DisonFileInput } from "./collisions.js";
import {
  normalizeExtensionlessAbsolutePath,
  buildProjectClassIndex,
  buildProjectInterfaceIndex,
  computeCompanionPlanByFile,
  computeConfigExtendsPlanByFile,
} from "./collisions.js";
import { collectDiUsedTypeNames } from "./codegen.js";
import { flattenConfiguration, namedGlobalConfigurations, type ConfigurationNode } from "./config-inheritance.js";

export interface ProjectFileWiring {
  // このファイルの injectable ノード（AST 出現順）に対応する判定。
  decisionsByInjectableIndex: WiringDecision[];
  // プロジェクト全体で登録文を落とせるか（全 injectable が畳まれ、スコープも
  // 動的配線も無い場合のみ true。true なら全ファイルからレジストリが消える）。
  dropRegistrations: boolean;
  // このファイルが共有ランタイム（dison/runtime）の import を必要とするか。
  needsRuntimeImport: boolean;
  // このファイル末尾に出力する factory export（他ファイルのゲッターが直接呼ぶ）。
  factoryExports: { name: string; expr: string }[];
  // このファイル先頭に出力する factory import。
  factoryImports: { specifier: string; names: string[] }[];
  // --explain 用レポート（このファイルの injectable のみ）。
  report: string[];
  // サブクラス別ゲッター再宣言（docs/subclass-getter-redeclaration.md）。
  // このファイル内のクラス本体 "{" のトークン位置 → 注入するメンバ宣言。
  classMemberInjections: [number, string[]][];
}

// ---------------------------------------------------------------------
// ファイルごとの前処理
// ---------------------------------------------------------------------

interface FileAnalysis {
  file: DisonFileInput;
  norm: string;
  tokens: Token[];
  ast: Node[];
  classes: Map<string, ClassInfo>;
  // L2（フェーズ3b）: ファイル内の実行文（バリア）列と、トップレベル宣言の言及グラフ。
  barriers: TopLevelBarrier[];
  declMentions: Map<string, Set<string>>;
  isTopLevel: (idx: number) => boolean;
  importsByLocalName: Map<string, ImportBinding>;
  // このファイル自身で宣言された実体キー化可能クラス（具象＋abstract）。正準化で
  // 「宣言元ファイル」を決めるのに使う。localIdentityClasses はこれに value-import
  // されたプロジェクトクラスを加えたもの（キー分類用）。
  localDeclaredClasses: Set<string>;
  localIdentityClasses: Set<string>;
  localTrueInterfaces: Set<string>;
  localTokens: Set<string>;
  // トップレベル import/export-from の順序付き参照（評価順の構築に使う）。
  moduleRefs: { kind: "project"; norm: string } | { kind: "external-relative" } | { kind: "bare" };
  moduleRefList: ({ kind: "project"; norm: string } | { kind: "external-relative" } | { kind: "bare" })[];
  injectables: { node: Extract<Node, { kind: "injectable" }>; index: number; className: string | null }[];
  // ローカルスコープ configuration の有無（strict regime のゲート。クラススコープは
  // L1.5 で勝者計算に参加するため含めない）。
  localScopesExist: boolean;
}

// トップレベルの import / export-from 文から、順序付きのモジュール参照を集める。
// `import ... from "s"` / `import "s"` / `export ... from "s"` を対象にする
// （import は構文上どこに書かれてもモジュール先頭で評価されるが、相対順序は
// 文の出現順に一致する）。
function collectModuleRefs(
  tokens: Token[],
  projectNorms: Set<string>,
  fileDir: string
): FileAnalysis["moduleRefList"] {
  const refs: FileAnalysis["moduleRefList"] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "punct") {
      if (t.text === "{") depth++;
      else if (t.text === "}") depth--;
      continue;
    }
    if (depth !== 0) continue;
    if (t.type !== "ident" || (t.text !== "import" && t.text !== "export")) continue;
    // 文末（深さ0の ";"）までの範囲で `from "spec"`、または `import "spec"` を探す。
    let spec: string | null = null;
    let sawFrom = false;
    let j = i + 1;
    let brace = 0;
    for (; j < tokens.length; j++) {
      const u = tokens[j];
      if (u.type === "punct") {
        if (u.text === "{") brace++;
        else if (u.text === "}") brace--;
        else if (u.text === ";" && brace === 0) break;
        continue;
      }
      if (u.type === "ident" && u.text === "from" && brace === 0) sawFrom = true;
      else if (u.type === "string" && brace === 0) {
        // `from "spec"` の spec、または `import "spec"`（side-effect import）。
        if (sawFrom || t.text === "import") spec = parseStringLiteralValue(u.text);
      } else if (u.type === "keyword" || (u.type === "ident" && u.text === "class")) {
        // `export class ...` 等、from の無い export 宣言 → モジュール参照ではない。
        if (!sawFrom) break;
      }
    }
    if (spec !== null) {
      if (spec.startsWith(".")) {
        const norm = normalizeExtensionlessAbsolutePath(path.resolve(fileDir, spec));
        refs.push(projectNorms.has(norm) ? { kind: "project", norm } : { kind: "external-relative" });
      } else {
        refs.push({ kind: "bare" });
      }
    }
    i = j;
  }
  return refs;
}

// ---------------------------------------------------------------------
// キー・クラスの正準化
// ---------------------------------------------------------------------
//
// 正準 ID の形:
//   C::<宣言ファイル norm>::<宣言名>   … プロジェクト内で宣言されたクラス
//   C::PKG::<specifier>::<名前>        … 外部パッケージから value-import されたクラス
//   I::<宣言ファイル norm>::<宣言名>   … プロジェクト内の真 interface/型エイリアス（companion）
//   T::<宣言ファイル norm>::<名前>     … token 宣言
//   S::<正規化 typeKey>                … 文字列キー（共有レジストリでグローバル）
//   AMB::<名前>                        … 由来を静的に解決できない名前（同名を合流）
//
// AMB は「実は同一の実行時キーかもしれない」名前同士を同じバケットに落とすための
// もの。畳み込み判定はこのバケット単位で taint されるため、解決できない名前を
// 使った配線は同名の injectable をすべて動的側に倒す（過剰畳み込みの防止が目的で、
// 畳まない方向にしか作用しないので健全）。

function canonClass(fa: FileAnalysis, name: string): string {
  // 重要: 判定順は「このファイル自身の宣言」→「import 由来」の順。value-import された
  // プロジェクトクラスは localIdentityClasses（キー分類用の合成集合）には入っているが、
  // 正準ファイルは宣言元なので、import 解決を先に優先させてはならないのは
  // ローカル宣言だけ（同名 shadowing はパースエラー領域なので考えない）。
  if (fa.localDeclaredClasses.has(name) || fa.classes.has(name)) return `C::${fa.norm}::${name}`;
  const imp = fa.importsByLocalName.get(name);
  if (imp !== undefined) {
    if (imp.specifier.startsWith(".")) {
      const resolved = normalizeExtensionlessAbsolutePath(
        path.resolve(path.dirname(fa.file.path), imp.specifier)
      );
      return `C::${resolved}::${imp.importedName}`;
    }
    return `C::PKG::${imp.specifier}::${imp.importedName}`;
  }
  return `AMB::${name}`;
}

function canonKey(
  fa: FileAnalysis,
  typeKey: string,
  token: string | undefined,
  interfaceIndex: Map<string, Set<string>>
): string {
  if (token !== undefined) {
    // token は "Ident" または "Ident.prop"。ドット付きは由来を追えないので合流。
    if (token.includes(".")) return `AMB::${token}`;
    if (fa.localTokens.has(token)) return `T::${fa.norm}::${token}`;
    const imp = fa.importsByLocalName.get(token);
    if (imp !== undefined && imp.specifier.startsWith(".")) {
      const resolved = normalizeExtensionlessAbsolutePath(
        path.resolve(path.dirname(fa.file.path), imp.specifier)
      );
      return `T::${resolved}::${imp.importedName}`;
    }
    return `AMB::${token}`;
  }
  const base = baseIdentifierOf(typeKey);
  if (base !== typeKey) return `S::${typeKey}`; // ジェネリクス等の複合型は文字列キー
  // 実体キー化クラス（このファイル自身の宣言が最優先。import 由来は宣言元へ正準化）
  if (fa.localDeclaredClasses.has(base) || fa.classes.has(base)) return `C::${fa.norm}::${base}`;
  const imp = fa.importsByLocalName.get(base);
  if (imp !== undefined && imp.specifier.startsWith(".")) {
    const resolved = normalizeExtensionlessAbsolutePath(
      path.resolve(path.dirname(fa.file.path), imp.specifier)
    );
    // 宣言元でクラスなら identity、真 interface なら companion。
    if (interfaceIndex.get(resolved)?.has(imp.importedName)) return `I::${resolved}::${imp.importedName}`;
    return `C::${resolved}::${imp.importedName}`;
  }
  if (fa.localTrueInterfaces.has(base)) return `I::${fa.norm}::${base}`;
  if (imp !== undefined) return `C::PKG::${imp.specifier}::${imp.importedName}`;
  return `S::${typeKey}`; // 未宣言・未importの裸の識別子は文字列キーに落ちる（#4検出の対象外領域）
}

// ---------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------

export function computeProjectWiring(files: DisonFileInput[]): Map<string, ProjectFileWiring> {
  const projectNorms = new Set(files.map((f) => normalizeExtensionlessAbsolutePath(f.path)));
  const interfaceIndex = buildProjectInterfaceIndex(files);
  const classIndex = buildProjectClassIndex(files);
  // 生成コードが注入する import（companion / activate-from）も実際の評価順に影響する
  // ため、評価順の計算に含める（生成ファイルでは注入 import がユーザーの import より
  // 前に置かれる）。companion の対象はこのプランと同じ規則で決まる。
  const companionPlanByFile = computeCompanionPlanByFile(files);
  // `configuration ... extends X` がファイルを跨ぐ場合、生成側は activateX /
  // __dison_config_X の import を注入する。これも実際の評価順に影響するため含める。
  const configExtendsPlanByFile = computeConfigExtendsPlanByFile(files);

  const analyses: FileAnalysis[] = files.map((file) => {
    const tokens = new Lexer(file.source).tokenize();
    const typeKinds = collectDeclaredTypeKinds(tokens);
    const ast = new Parser(tokens, typeKinds).parseProgram();
    const blockContext = collectBlockContext(tokens);
    const classes = collectTopLevelClasses(tokens);
    const disonStarts = buildDisonStarts(tokens, ast);
    const { barriers, declMentions } = analyzeTopLevel(tokens, classes, disonStarts);
    const importsByLocalName = new Map(collectImportBindings(tokens).map((b) => [b.localName, b]));

    // value-import されたプロジェクトのクラスも実体キー化される（collisions.ts と同じ規則）。
    const localDeclaredClasses = new Set(identityKeyableClassNames(typeKinds));
    const localIdentityClasses = identityKeyableClassNames(typeKinds);
    for (const [localName, imp] of importsByLocalName) {
      if (imp.typeOnly || !imp.specifier.startsWith(".")) continue;
      const resolved = normalizeExtensionlessAbsolutePath(
        path.resolve(path.dirname(file.path), imp.specifier)
      );
      if (classIndex.get(resolved)?.has(imp.importedName)) localIdentityClasses.add(localName);
    }

    const localTokens = new Set<string>();
    for (const n of ast) if (n.kind === "token") localTokens.add(n.name);

    const injectables: FileAnalysis["injectables"] = [];
    let idx = 0;
    for (const n of ast) {
      if (n.kind !== "injectable") continue;
      const pos = n.tokenPos;
      let className: string | null = null;
      if (pos !== undefined) {
        for (const info of classes.values()) {
          if (pos > info.bodyStart && pos < info.bodyEnd) {
            let depth = 0;
            for (let j = info.bodyStart; j < pos; j++) {
              const u = tokens[j];
              if (u.type !== "punct") continue;
              if (u.text === "{") depth++;
              else if (u.text === "}") depth--;
            }
            if (depth === 1) className = info.name;
            break;
          }
        }
      }
      injectables.push({ node: n, index: idx++, className });
    }

    return {
      file,
      norm: normalizeExtensionlessAbsolutePath(file.path),
      tokens,
      ast,
      classes,
      barriers,
      declMentions,
      isTopLevel: (i: number) => blockContext.isTopLevel(i),
      importsByLocalName,
      localDeclaredClasses,
      localIdentityClasses,
      localTrueInterfaces: trueInterfaceOrAliasNames(typeKinds),
      localTokens,
      moduleRefs: { kind: "bare" }, // 未使用フィールド（moduleRefList を使う）
      moduleRefList: (() => {
        const refs: FileAnalysis["moduleRefList"] = [];
        const dir = path.dirname(file.path);
        const toRef = (spec: string): FileAnalysis["moduleRefList"][number] => {
          if (!spec.startsWith(".")) return { kind: "bare" };
          const norm = normalizeExtensionlessAbsolutePath(path.resolve(dir, spec));
          return projectNorms.has(norm) ? { kind: "project", norm } : { kind: "external-relative" };
        };
        // 1. companion import（生成コードがユーザー import より前に注入する）
        const plan = companionPlanByFile.get(file.path);
        if (plan !== undefined) {
          const diUsed = collectDiUsedTypeNames(ast);
          for (const [localName, info] of plan.companionImports) {
            if (diUsed.has(localName)) refs.push(toRef(info.specifier));
          }
        }
        // 2. activate-from の import（同じく注入される。AST 出現順・重複除去）
        const seenFrom = new Set<string>();
        for (const n of ast) {
          if (n.kind === "activate" && n.fromPath !== undefined && !seenFrom.has(n.fromPath)) {
            seenFrom.add(n.fromPath);
            refs.push(toRef(n.fromPath));
          }
        }
        // 3. extends の import（同じく注入される）
        for (const [, info] of configExtendsPlanByFile.get(file.path)?.extendsImports ?? []) {
          refs.push(toRef(info.specifier));
        }
        // 4. ユーザーソース上の import/export-from
        refs.push(...collectModuleRefs(tokens, projectNorms, dir));
        return refs;
      })(),
      injectables,
      localScopesExist: ast.some((n) => n.kind === "configuration" && n.scope === "local"),
    };
  });

  const byNorm = new Map(analyses.map((fa) => [fa.norm, fa]));

  // ---------------------------------------------------------------
  // モジュール評価順（import グラフ DFS）
  // ---------------------------------------------------------------

  const importedNorms = new Set<string>();
  for (const fa of analyses) {
    for (const ref of fa.moduleRefList) if (ref.kind === "project") importedNorms.add(ref.norm);
  }
  const roots = analyses.filter((fa) => !importedNorms.has(fa.norm));

  // 評価順が一意に定まらない場合の理由（null なら確定）。
  let orderAmbiguity: string | null = null;
  if (roots.length !== 1) {
    orderAmbiguity =
      roots.length === 0
        ? "the project import graph is cyclic, so module evaluation order is not statically determinable"
        : `multiple entry candidates (${roots.map((r) => r.file.path).join(", ")}), so module evaluation order is not statically determinable`;
  }

  // グローバル直列シーケンス: ファイル本体と「プロジェクト外の相対 import」バリア。
  type SeqItem = { kind: "body"; fa: FileAnalysis } | { kind: "external-barrier" };
  const sequence: SeqItem[] = [];
  if (orderAmbiguity === null) {
    const state = new Map<string, "visiting" | "done">();
    const visit = (fa: FileAnalysis): void => {
      const s = state.get(fa.norm);
      if (s !== undefined) {
        if (s === "visiting" && orderAmbiguity === null) {
          orderAmbiguity = "the project import graph is cyclic, so module evaluation order is not statically determinable";
        }
        return;
      }
      state.set(fa.norm, "visiting");
      for (const ref of fa.moduleRefList) {
        if (ref.kind === "project") {
          const dep = byNorm.get(ref.norm);
          if (dep !== undefined) visit(dep);
        } else if (ref.kind === "external-relative") {
          // プロジェクト外のローカルモジュール: 評価時に何を実行するか見えない
          // → その位置で任意コードが走るものとして扱う。
          sequence.push({ kind: "external-barrier" });
        }
      }
      state.set(fa.norm, "done");
      sequence.push({ kind: "body", fa });
    };
    visit(roots[0]);
    // 到達しなかったファイル（root から辿れない = 動的 import 等でのみ使われる）が
    // あれば、評価タイミング不明なので全体を曖昧扱いにする。
    if (orderAmbiguity === null && analyses.some((fa) => state.get(fa.norm) !== "done")) {
      orderAmbiguity = "some project files are not reachable from the entry module via static imports";
    }
  }

  const evalOrderIndex = new Map<string, number>();
  sequence.forEach((item, i) => {
    if (item.kind === "body") evalOrderIndex.set(item.fa.norm, i);
  });

  // dominates(W, G): import グラフ上、root から G へのすべての経路が W を通るか
  // （= G の評価は常に W の評価の内側で起きる）。factory hoisting の評価順ガードに
  // 使う。このとき G→W の import を追加しても、G の評価時点で W は常に評価中
  // （visiting）なので循環スキップされ、実際の評価順は一切変わらない。単に
  // 「W から G に到達できる」だけでは不十分（G が W を経由しない別経路でも
  // import されていると、追加した import が W の評価を繰り上げてしまい、
  // クラス宣言の初期化順が壊れる）。
  const dominates = (viaNorm: string, targetNorm: string): boolean => {
    if (roots.length !== 1) return false;
    if (viaNorm === targetNorm) return false;
    // root から viaNorm を通らずに targetNorm へ到達できなければ、viaNorm が支配する。
    const seen = new Set<string>([viaNorm]);
    const stack = [roots[0].norm];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === targetNorm) return false;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const fa = byNorm.get(cur);
      if (fa === undefined) continue;
      for (const ref of fa.moduleRefList) if (ref.kind === "project") stack.push(ref.norm);
    }
    return true;
  };

  // ---------------------------------------------------------------
  // 配線イベントと taint の収集（グローバル直列プログラムとして）
  // ---------------------------------------------------------------

  const injectablesByCanonClass = new Map<
    string,
    { fa: FileAnalysis; index: number; prop: string; node: Extract<Node, { kind: "injectable" }> }[]
  >();
  for (const fa of analyses) {
    for (const inj of fa.injectables) {
      if (inj.className === null) continue;
      const id = `C::${fa.norm}::${inj.className}`;
      let arr = injectablesByCanonClass.get(id);
      if (arr === undefined) {
        arr = [];
        injectablesByCanonClass.set(id, arr);
      }
      arr.push({ fa, index: inj.index, prop: inj.node.propName, node: inj.node });
    }
  }

  // configuration の継承（docs/configuration-inheritance.md）: 名前はプロジェクト全体で
  // 解決する（宣言元ファイルを伴うので、平坦化されたエントリはそれぞれ正しい home を持つ
  // → factory hoisting と評価順ガードがそのまま効く）。同名が複数ファイルにある場合は
  // 参照元ファイル内の宣言を優先する。
  const configDeclsByName = new Map<string, { node: ConfigurationNode; fa: FileAnalysis }[]>();
  for (const fa of analyses) {
    for (const [name, node] of namedGlobalConfigurations(fa.ast)) {
      let arr = configDeclsByName.get(name);
      if (arr === undefined) {
        arr = [];
        configDeclsByName.set(name, arr);
      }
      arr.push({ node, fa });
    }
  }
  const resolveConfig = (name: string, from: FileAnalysis) => {
    const cands = configDeclsByName.get(name);
    if (cands === undefined || cands.length === 0) return undefined;
    const own = cands.find((c) => c.fa.norm === from.norm) ?? cands[0];
    return { node: own.node, file: own.fa };
  };
  const flattenProject = (
    node: ConfigurationNode,
    fa: FileAnalysis
  ): { entry: ConfigEntry; fa: FileAnalysis }[] =>
    flattenConfiguration<FileAnalysis>(node, fa, resolveConfig).entries.map((fe) => ({
      entry: fe.entry,
      fa: fe.file,
    }));

  interface WiringEvent {
    entry: ConfigEntry;
    fa: FileAnalysis; // 式の字句的な所属ファイル
  }
  const events: WiringEvent[] = [];
  const keyTaint = new Map<string, string>();
  const overrideTaint = new Map<string, string>(); // `${canonClass} ${prop}` → 理由
  const blanketPropTaint = new Map<string, string>();
  const localScopesExist = analyses.some((fa) => fa.localScopesExist);
  // L1.5: クラスフレーム（正準クラスID → 定義順の (エントリ列, 所属ファイル)）。
  const classFramesByCanonClass = new Map<string, { entries: ConfigEntry[]; fa: FileAnalysis }[]>();
  let dynamicContextWiring = false;
  let postBarrierWiring = false;

  const chainCanonOf = (canonId: string): { ids: string[]; unknown: boolean } => {
    const ids: string[] = [];
    let unknown = false;
    let cur: string | undefined = canonId;
    const seen = new Set<string>();
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      ids.push(cur);
      const m = /^C::(.+)::([^:]+)$/.exec(cur);
      if (m === null) break; // PKG/AMB 等は辿れない（その ID までで鎖は終わり）
      const fa = byNorm.get(m[1]);
      const info = fa?.classes.get(m[2]);
      if (fa === undefined || info === undefined) break;
      if (info.opaqueHeritage) {
        unknown = true;
        break;
      }
      cur = info.baseName !== null ? canonClass(fa, info.baseName) : undefined;
    }
    return { ids, unknown };
  };

  // プロジェクト内の全宣言クラスの正準 ID 一覧（子孫探索・AMB 解決に使う）。
  const allDeclaredCanon: { canonId: string; fa: FileAnalysis; name: string }[] = [];
  for (const fa of analyses) {
    for (const name of fa.classes.keys()) {
      allDeclaredCanon.push({ canonId: `C::${fa.norm}::${name}`, fa, name });
    }
  }

  const taintOverrideEntry = (fa: FileAnalysis, entry: OverrideEntry, reason: string): void => {
    const targetCanon = canonClass(fa, entry.className);
    const targetDecl = /^C::(.+)::([^:]+)$/.exec(targetCanon);
    const targetInfo = targetDecl !== null ? byNorm.get(targetDecl[1])?.classes.get(targetDecl[2]) : undefined;
    if (targetInfo === undefined || targetInfo.opaqueHeritage) {
      for (const a of entry.assignments) {
        if (!blanketPropTaint.has(a.prop)) blanketPropTaint.set(a.prop, reason);
      }
      return;
    }
    const related = new Set<string>(chainCanonOf(targetCanon).ids);
    for (const { canonId } of allDeclaredCanon) {
      if (chainCanonOf(canonId).ids.includes(targetCanon)) related.add(canonId);
    }
    for (const cls of related) {
      for (const a of entry.assignments) {
        const k = `${cls} ${a.prop}`;
        if (!overrideTaint.has(k)) overrideTaint.set(k, reason);
      }
    }
  };

  const taintEntries = (fa: FileAnalysis, entries: ConfigEntry[], reason: string): void => {
    for (const e of entries) {
      if (e.kind === "bind") {
        const k = canonKey(fa, e.originalTypeKey, e.token, interfaceIndex);
        if (!keyTaint.has(k)) keyTaint.set(k, reason);
      } else {
        taintOverrideEntry(fa, e, reason);
      }
    }
  };

  // ---------------------------------------------------------------
  // フェーズ3b: グローバル mention バリア列（クロスファイル L2）
  // ---------------------------------------------------------------
  // 各ファイルの実行文バリア（analyzeTopLevel）を評価順に直列化し、単一ファイル L2 と
  // 同じ「言及の推移閉包が使いうるキー集合」でイベント単位に塞ぐ。閉包の識別子解決は
  // ファイル名前空間つき（(ファイル, 識別子) の組）で行い、プロジェクト内 import は
  // 宣言元ファイルの名前空間へ辿って続きを解決する。プロジェクト外の相対 import の
  // 束縛・危険なグローバル・継承鎖不明クラスに触れたら universal に落とす。

  const seqIdxByNorm = new Map<string, number>();
  interface ProjBarrier {
    seq: number; // 評価順（sequence のインデックス）
    pos: number; // ファイル内トークン位置（external は -1）
    universal: boolean;
    mentions: Set<string>;
    fa: FileAnalysis | null; // external バリアは null
  }
  const projBarriers: ProjBarrier[] = [];
  {
    let seq = 0;
    let universalSeen = false;
    for (const item of sequence) {
      if (item.kind === "external-barrier") {
        if (!universalSeen) {
          projBarriers.push({ seq, pos: -1, universal: true, mentions: new Set(), fa: null });
          universalSeen = true;
        }
      } else {
        seqIdxByNorm.set(item.fa.norm, seq);
        if (!universalSeen) {
          for (const b of item.fa.barriers) {
            projBarriers.push({ seq, pos: b.pos, universal: b.universal, mentions: b.mentions, fa: item.fa });
            if (b.universal) {
              universalSeen = true;
              break;
            }
          }
        }
      }
      seq++;
    }
  }

  const allBindsWithHome: { entry: BindEntry; fa: FileAnalysis }[] = [];
  const allOverridesWithHome: { entry: OverrideEntry; fa: FileAnalysis }[] = [];
  for (const fa of analyses) {
    for (const node of fa.ast) {
      const flat: { entry: ConfigEntry; fa: FileAnalysis }[] =
        node.kind === "configuration"
          ? node.extendsNames === undefined && node.extendsSelections === undefined
            ? node.entries.map((entry) => ({ entry, fa }))
            : flattenProject(node, fa) // 閉包は保守的に全葉を合併して見る
          : node.kind === "standalone-bind" || node.kind === "standalone-override"
          ? [{ entry: node.entry, fa }]
          : [];
      for (const { entry: e, fa: eFa } of flat) {
        if (e.kind === "bind") allBindsWithHome.push({ entry: e, fa: eFa });
        else allOverridesWithHome.push({ entry: e, fa: eFa });
      }
    }
  }

  interface BarrierUse {
    universal: boolean;
    keys: Set<string>; // 正準キー
    pairs: Set<string>; // `${正準クラスID} ${prop}`
  }
  const barrierUseCache = new Map<ProjBarrier, BarrierUse>();
  const computeBarrierUse = (b: ProjBarrier): BarrierUse => {
    const cached = barrierUseCache.get(b);
    if (cached !== undefined) return cached;
    let result: BarrierUse;
    if (b.universal || b.fa === null) {
      result = { universal: true, keys: new Set(), pairs: new Set() };
    } else {
      const keys = new Set<string>();
      const pairs = new Set<string>();
      // 識別子はファイル名前空間つきで解決する（norm と識別子名の組）。
      const seenIdents = new Set<string>();
      const seenClasses = new Set<string>();
      const pulledBinds = new Set<BindEntry>();
      const pulledOverrides = new Set<OverrideEntry>();
      const queue: { f: FileAnalysis; id: string }[] = [...b.mentions].map((id) => ({ f: b.fa!, id }));
      let universal = false;
      const enqueue = (f: FileAnalysis, id: string): void => {
        if (!seenIdents.has(`${f.norm}|${id}`)) queue.push({ f, id });
      };
      let progress = true;
      while (progress && !universal) {
        progress = false;
        while (queue.length > 0 && !universal) {
          const { f, id } = queue.pop()!;
          const sk = `${f.norm}|${id}`;
          if (seenIdents.has(sk)) continue;
          seenIdents.add(sk);
          progress = true;
          if (DANGEROUS_GLOBALS.has(id)) {
            universal = true;
            break;
          }
          const imp = f.importsByLocalName.get(id);
          if (imp !== undefined && imp.specifier.startsWith(".")) {
            const resolved = normalizeExtensionlessAbsolutePath(
              path.resolve(path.dirname(f.file.path), imp.specifier)
            );
            const target = byNorm.get(resolved);
            if (target === undefined) {
              // プロジェクト外の相対モジュール: 生成物を import し返して構築できる。
              universal = true;
              break;
            }
            enqueue(target, imp.importedName);
          }
          const dm = f.declMentions.get(id);
          if (dm !== undefined) for (const m of dm) enqueue(f, m);
          if (f.classes.has(id)) {
            const canonical = `C::${f.norm}::${id}`;
            if (!seenClasses.has(canonical)) {
              seenClasses.add(canonical);
              const chain = chainCanonOf(canonical);
              if (chain.unknown) {
                universal = true;
                break;
              }
              for (const X of chain.ids) {
                for (const m of injectablesByCanonClass.get(X) ?? []) {
                  if (isSimpleTypeShape(m.node.typeKey)) {
                    keys.add(canonKey(m.fa, m.node.typeKey, m.node.token, interfaceIndex));
                  }
                  for (const Y of chain.ids) pairs.add(`${Y} ${m.prop}`);
                }
              }
            }
          }
        }
        if (universal) break;
        for (const { entry, fa: hf } of allBindsWithHome) {
          if (pulledBinds.has(entry)) continue;
          if (!keys.has(canonKey(hf, entry.originalTypeKey, entry.token, interfaceIndex))) continue;
          pulledBinds.add(entry);
          progress = true;
          enqueue(hf, baseIdentifierOf(entry.replacementTypeKey));
          keys.add(canonKey(hf, entry.replacementTypeKey, undefined, interfaceIndex)); // チェーン継続キー
        }
        for (const { entry, fa: hf } of allOverridesWithHome) {
          if (pulledOverrides.has(entry)) continue;
          const targetCanon = canonClass(hf, entry.className);
          let hit = false;
          for (const a of entry.assignments) if (pairs.has(`${targetCanon} ${a.prop}`)) hit = true;
          if (!hit) continue;
          pulledOverrides.add(entry);
          progress = true;
          for (const a of entry.assignments) for (const m of collectExprMentions(a.valueExpr)) enqueue(hf, m);
        }
      }
      result = universal ? { universal: true, keys: new Set(), pairs: new Set() } : { universal: false, keys, pairs };
    }
    barrierUseCache.set(b, result);
    return result;
  };

  const barrierBefore = (b: ProjBarrier, evSeq: number, evPos: number): boolean =>
    b.seq < evSeq || (b.seq === evSeq && b.pos < evPos);

  const bindBlockedBy = (key: string, evSeq: number, evPos: number): string | null => {
    for (const b of projBarriers) {
      if (!barrierBefore(b, evSeq, evPos)) break;
      const u = computeBarrierUse(b);
      if (u.universal) return "wired after executable top-level code (in module evaluation order)";
      if (u.keys.has(key)) return "wired after an executable statement that may resolve this key";
    }
    return null;
  };
  const overrideBlockedBy = (fa: FileAnalysis, entry: OverrideEntry, evSeq: number, evPos: number): string | null => {
    const targetCanon = canonClass(fa, entry.className);
    for (const b of projBarriers) {
      if (!barrierBefore(b, evSeq, evPos)) break;
      const u = computeBarrierUse(b);
      if (u.universal) return "wired after executable top-level code (in module evaluation order)";
      for (const a of entry.assignments) {
        if (u.pairs.has(`${targetCanon} ${a.prop}`)) {
          return "wired after an executable statement that may resolve this property";
        }
      }
    }
    return null;
  };

  // エントリ単位で「先行バリアに塞がれていなければイベント、塞がれていれば taint」。
  // entryFa は式の字句的な所属ファイル（activate なら configuration の宣言ファイル）、
  // (evSeq, evPos) は登録が走る位置（activate ならその activate 文の位置）。
  // エントリごとに「宣言元ファイル」を伴う（継承で他ファイルから来たエントリは、その
  // ファイルの字句環境で評価される＝ home が違う）。
  const emitFlat = (
    flat: { entry: ConfigEntry; fa: FileAnalysis }[],
    evSeq: number,
    evPos: number,
    blockedSuffix: string
  ): void => {
    for (const { entry, fa: entryFa } of flat) {
      if (orderAmbiguity !== null) {
        postBarrierWiring = true;
        taintEntries(entryFa, [entry], orderAmbiguity);
        continue;
      }
      const blocked =
        entry.kind === "bind"
          ? bindBlockedBy(canonKey(entryFa, entry.originalTypeKey, entry.token, interfaceIndex), evSeq, evPos)
          : overrideBlockedBy(entryFa, entry, evSeq, evPos);
      if (blocked === null) {
        events.push({ entry, fa: entryFa });
      } else {
        postBarrierWiring = true;
        taintEntries(entryFa, [entry], blocked + blockedSuffix);
      }
    }
  };
  const taintFlat = (flat: { entry: ConfigEntry; fa: FileAnalysis }[], reason: string): void => {
    for (const { entry, fa } of flat) taintEntries(fa, [entry], reason);
  };

  // ファイル本体の処理（単一ファイル版の収集ループのプロジェクト合成版）。
  // イベントの位置は（評価順 seq, ファイル内トークン位置）で表し、フェーズ3b の
  // グローバル mention バリア列に対してエントリ単位で塞ぐ。
  const processBody = (fa: FileAnalysis): void => {
    const namedConfigs = new Map<string, Extract<Node, { kind: "configuration" }>>();
    for (const node of fa.ast) {
      if (node.kind === "configuration" && node.scope === "global" && node.name !== undefined) {
        namedConfigs.set(node.name, node);
      }
    }
    const evSeq = seqIdxByNorm.get(fa.norm) ?? 0;
    for (const node of fa.ast) {
      const pos = (node as { tokenPos?: number }).tokenPos ?? 0;
      if (node.kind === "configuration") {
        // 実行時選択（docs/activate-sugar-implementation.md §1.4）: 全葉を動的 taint。
        if (node.extendsSelections !== undefined) {
          for (const sel of node.extendsSelections) {
            const cands = sel.leaves.join(", ");
            for (const leaf of sel.leaves) {
              const decl = resolveConfig(leaf, fa);
              if (decl === undefined) continue;
              taintFlat(
                flattenProject(decl.node, decl.file),
                `configuration selected at runtime among {${cands}}`
              );
            }
          }
          dynamicContextWiring = true;
        }
        const effective =
          node.extendsNames === undefined && node.extendsSelections === undefined
            ? node.entries.map((entry) => ({ entry, fa }))
            : flattenProject({ ...node, extendsSelections: undefined }, fa);
        if (node.scope === "local") {
          taintFlat(effective, "bound in a local scope");
        } else if (node.scope === "class") {
          // L1.5: 囲みクラスが特定できればフレームとして勝者計算に参加させる。
          const encl = enclosingTopLevelClass(fa.tokens, fa.classes, pos);
          if (encl !== null) {
            const id = `C::${fa.norm}::${encl}`;
            let arr = classFramesByCanonClass.get(id);
            if (arr === undefined) {
              arr = [];
              classFramesByCanonClass.set(id, arr);
            }
            arr.push({ entries: effective.map((x) => x.entry), fa });
            for (const { entry: e, fa: eFa } of effective) {
              if (e.kind !== "override") continue;
              const tCanon = canonClass(eFa, e.className);
              const tDecl = /^C::(.+)::([^:]+)$/.exec(tCanon);
              const tInfo = tDecl !== null ? byNorm.get(tDecl[1])?.classes.get(tDecl[2]) : undefined;
              if (tInfo === undefined || tInfo.opaqueHeritage) {
                taintOverrideEntry(eFa, e, "class-scope override targets a class whose hierarchy is not statically analyzable");
              }
            }
          } else {
            taintFlat(effective, "bound in a class scope of a non-top-level class");
          }
        } else if (node.name === undefined) {
          emitFlat(effective, evSeq, pos, "");
        }
      } else if (node.kind === "activate") {
        // `activate Name from "path"` は相手ファイルの activate 関数の呼び出し。
        // 相手が同一プロジェクトなら、その configuration のエントリがこの位置で
        // 共有レジストリに登録される。
        let cfg: Extract<Node, { kind: "configuration" }> | undefined;
        let cfgFa: FileAnalysis | undefined;
        if (node.fromPath === undefined) {
          cfg = namedConfigs.get(node.name);
          cfgFa = fa;
          if (cfg === undefined) {
            // import された configuration（このファイルに定義が無い）→ 宣言元を探す。
            for (const [localName, imp] of fa.importsByLocalName) {
              if (localName === `activate${node.name}` && imp.specifier.startsWith(".")) {
                const resolved = normalizeExtensionlessAbsolutePath(
                  path.resolve(path.dirname(fa.file.path), imp.specifier)
                );
                const declFa = byNorm.get(resolved);
                cfgFa = declFa;
                cfg = declFa?.ast.find(
                  (n): n is Extract<Node, { kind: "configuration" }> =>
                    n.kind === "configuration" && n.scope === "global" && n.name === node.name
                );
              }
            }
          }
        } else {
          const resolved = normalizeExtensionlessAbsolutePath(
            path.resolve(path.dirname(fa.file.path), node.fromPath)
          );
          const declFa = byNorm.get(resolved);
          cfgFa = declFa;
          cfg = declFa?.ast.find(
            (n): n is Extract<Node, { kind: "configuration" }> =>
              n.kind === "configuration" && n.scope === "global" && n.name === node.name
          );
        }
        if (cfg === undefined || cfgFa === undefined) continue; // プロジェクト外 → 共有レジストリに触れない
        const cfgFlat = flattenProject(cfg, cfgFa);
        if (!fa.isTopLevel(pos)) {
          dynamicContextWiring = true;
          taintFlat(cfgFlat, "activated inside a function or conditional");
        } else {
          emitFlat(cfgFlat, evSeq, pos, " (before this activate)");
        }
      } else if (node.kind === "standalone-override" || node.kind === "standalone-bind") {
        const entry = node.kind === "standalone-override" ? node.entry : node.entry;
        if (!fa.isTopLevel(pos)) {
          dynamicContextWiring = true;
          taintEntries(fa, [entry], "wired inside a function");
        } else {
          emitFlat([{ entry, fa }], evSeq, pos, "");
        }
      }
    }
  };

  if (orderAmbiguity === null) {
    for (const item of sequence) {
      if (item.kind === "body") processBody(item.fa);
      // external-barrier は projBarriers 側に反映済み。
    }
  } else {
    for (const fa of analyses) processBody(fa);
  }

  // 最終配線状態（後勝ち = グローバル評価順）。
  const bindMap = new Map<string, { entry: BindEntry; fa: FileAnalysis; first: boolean }>();
  const overrideMap = new Map<string, Map<string, { expr: string; fa: FileAnalysis }>>();
  for (const ev of events) {
    if (ev.entry.kind === "bind") {
      const k = canonKey(ev.fa, ev.entry.originalTypeKey, ev.entry.token, interfaceIndex);
      bindMap.set(k, { entry: ev.entry, fa: ev.fa, first: !bindMap.has(k) });
    } else {
      const target = canonClass(ev.fa, ev.entry.className);
      let m = overrideMap.get(target);
      if (m === undefined) {
        m = new Map();
        overrideMap.set(target, m);
      }
      for (const a of ev.entry.assignments) m.set(a.prop, { expr: a.valueExpr, fa: ev.fa });
    }
  }

  // ---------------------------------------------------------------
  // injectable ごとの判定
  // ---------------------------------------------------------------

  const decisions = new Map<string, WiringDecision>(); // `${norm}#${index}` → 宣言クラスでの判定
  const winnerHome = new Map<string, FileAnalysis>(); // static 判定の勝者式の所属ファイル
  const decKey = (fa: FileAnalysis, index: number): string => `${fa.norm}#${index}`;
  // 受け手クラスごとの判定（サブクラス別ゲッター再宣言）。
  const recvDecisions = new Map<string, WiringDecision>();
  const recvHome = new Map<string, FileAnalysis>();
  const recvDeps = new Map<string, string[]>();
  const recvKey = (fa: FileAnalysis, index: number, recv: string): string =>
    `${fa.norm}#${index}@${recv}`;
  // root（正準クラス ID）を継承する全クラス（root 自身を含む）。
  const subtreeCanonOf = (root: string): string[] => {
    const out = [root];
    for (const { canonId } of allDeclaredCanon) {
      if (canonId === root) continue;
      const c = chainCanonOf(canonId);
      if (!c.unknown && c.ids.includes(root)) out.push(canonId);
    }
    return out;
  };
  // super.<prop> の使用（§4.1 のガード）。プロジェクト全体で見る。
  const superProps = new Set<string>();
  for (const fa of analyses) {
    for (let i = 0; i < fa.tokens.length; i++) {
      const t = fa.tokens[i];
      if (!(t.type === "ident" && t.text === "super")) continue;
      let dot = i + 1;
      while (dot < fa.tokens.length && (fa.tokens[dot].type === "whitespace" || fa.tokens[dot].type === "comment")) dot++;
      if (!(fa.tokens[dot]?.type === "punct" && fa.tokens[dot].text === ".")) continue;
      let prop = dot + 1;
      while (prop < fa.tokens.length && (fa.tokens[prop].type === "whitespace" || fa.tokens[prop].type === "comment")) prop++;
      if (fa.tokens[prop]?.type === "ident") superProps.add(fa.tokens[prop].text);
    }
  }

  // L1.5: フレーム列（実行時の消費順 = 正準チェイン順、同一クラス内は定義の逆順）。
  const frameSeq = (chainIds: string[]): { entries: ConfigEntry[]; fa: FileAnalysis }[] => {
    const out: { entries: ConfigEntry[]; fa: FileAnalysis }[] = [];
    for (const cls of chainIds) {
      const cfgs = classFramesByCanonClass.get(cls);
      if (cfgs === undefined) continue;
      for (let i = cfgs.length - 1; i >= 0; i--) out.push(cfgs[i]);
    }
    return out;
  };
  const frameOverrideWinner = (
    chainIds: string[],
    prop: string
  ): { expr: string; owner: string; fa: FileAnalysis } | undefined => {
    for (const frame of frameSeq(chainIds)) {
      for (const cls of chainIds) {
        let last: string | undefined;
        for (const e of frame.entries) {
          if (e.kind !== "override") continue;
          if (canonClass(frame.fa, e.className) !== cls) continue;
          for (const a of e.assignments) if (a.prop === prop) last = a.valueExpr;
        }
        if (last !== undefined) return { expr: last, owner: cls, fa: frame.fa };
      }
    }
    return undefined;
  };
  const frameBindLookup = (
    chainIds: string[],
    key: string
  ): { entry: BindEntry; fa: FileAnalysis } | undefined => {
    for (const frame of frameSeq(chainIds)) {
      let last: BindEntry | undefined;
      for (const e of frame.entries) {
        if (e.kind === "bind" && canonKey(frame.fa, e.originalTypeKey, e.token, interfaceIndex) === key) last = e;
      }
      if (last !== undefined) return { entry: last, fa: frame.fa };
    }
    return undefined;
  };

  for (const fa of analyses) {
    for (const inj of fa.injectables) {
      const { node, className } = inj;
      const decideFor = (recvCanon: string): { d: WiringDecision; home?: FileAnalysis } => {
        if (className === null) {
          return { d: { kind: "dynamic", reason: "enclosing class is not a top-level class declaration" } };
        }
        const selfCanon = recvCanon;
        const chain = chainCanonOf(selfCanon);
        if (chain.unknown) {
          return { d: { kind: "dynamic", reason: "class heritage is not statically analyzable (mixin or expression in extends)" } };
        }
        const blanket = blanketPropTaint.get(node.propName);
        if (blanket !== undefined) return { d: { kind: "dynamic", reason: blanket } };
        for (const cls of chain.ids) {
          const t = overrideTaint.get(`${cls} ${node.propName}`);
          if (t !== undefined) return { d: { kind: "dynamic", reason: t } };
        }
        // override 勝者: クラスフレーム層（scope-major: グローバルより優先。L1.5）
        const fw = frameOverrideWinner(chain.ids, node.propName);
        if (fw !== undefined) {
          return {
            d: { kind: "static", expr: `(${fw.expr})`, why: `class-scope override ${fw.owner.split("::").pop()}` },
            home: fw.fa,
          };
        }
        // override 勝者（child-wins）
        for (const cls of chain.ids) {
          const v = overrideMap.get(cls)?.get(node.propName);
          if (v !== undefined) {
            return {
              d: { kind: "static", expr: `(${v.expr})`, why: `override ${cls.split("::").pop()} (top-level wiring)` },
              home: v.fa,
            };
          }
        }
        // bind 勝者（チェイン終端まで。#5: 引数は終端のみ）
        if (isSimpleTypeShape(node.typeKey)) {
          const selfKey = canonKey(fa, node.typeKey, node.token, interfaceIndex);
          const kt = keyTaint.get(selfKey);
          if (kt !== undefined) return { d: { kind: "dynamic", reason: kt } };
          // ホップ毎に「クラスフレーム層 → グローバル層」の順で照合（L1.5）。
          const hopLookup = (key: string): { entry: BindEntry; fa: FileAnalysis; fromFrame: boolean } | undefined => {
            const fb = frameBindLookup(chain.ids, key);
            if (fb !== undefined) return { entry: fb.entry, fa: fb.fa, fromFrame: true };
            const gb = bindMap.get(key);
            return gb !== undefined ? { entry: gb.entry, fa: gb.fa, fromFrame: false } : undefined;
          };
          let hop = hopLookup(selfKey);
          if (hop !== undefined) {
            let usedFrame = hop.fromFrame;
            let chained = false;
            const visited = new Set<string>([selfKey]);
            while (true) {
              const nextKey = canonKey(hop.fa, hop.entry.replacementTypeKey, undefined, interfaceIndex);
              if (visited.has(nextKey)) {
                return { d: { kind: "dynamic", reason: "bind chain contains a cycle (kept dynamic so the runtime error surfaces)" } };
              }
              const kt2 = keyTaint.get(nextKey);
              if (kt2 !== undefined) return { d: { kind: "dynamic", reason: `chained through a key that is ${kt2}` } };
              const nxt = hopLookup(nextKey);
              if (nxt === undefined) break;
              visited.add(nextKey);
              hop = nxt;
              usedFrame ||= nxt.fromFrame;
              chained = true;
            }
            return {
              d: {
                kind: "static",
                expr: `new ${hop.entry.replacementTypeName}(${hop.entry.replacementArgs ?? ""})`,
                why: `bind ${node.typeKey} (${usedFrame ? "class-scope wiring" : "top-level wiring"}${chained ? ", chained" : ""})`,
              },
              home: hop.fa,
            };
          }
        }
        // 配線なし → 既定初期化式（L0。式は常に自ファイル）
        return {
          d: {
            kind: "static",
            expr: node.defaultExpr !== undefined ? `(${node.defaultExpr})` : `new ${node.typeName}()`,
            why: node.defaultExpr !== undefined ? "no wiring (default initializer)" : "no wiring (auto-constructed)",
          },
          home: fa,
        };
      };

      // 受け手クラスごとに判定する（docs/subclass-getter-redeclaration.md §2）。
      const recvs =
        className === null ? ["<none>"] : subtreeCanonOf(`C::${fa.norm}::${className}`);
      for (const recv of recvs) {
        const { d: d0, home } = decideFor(recv);
        const rk = recvKey(fa, inj.index, recv);
        let d = d0;
        if (d.kind === "static" && home !== undefined) {
          recvHome.set(rk, home);
          if (localScopesExist) {
            const analyzed = analyzeWinnerExpr(d.expr);
            if (analyzed === "opaque") {
              d = {
                kind: "dynamic",
                reason: "winner expression is not analyzable under scoped configurations in this project",
              };
            } else {
              recvDeps.set(rk, analyzed.deps.map((dep) => canonClass(home, dep)));
            }
          }
        }
        recvDecisions.set(rk, d);
      }
    }
  }

  // 推移的 taint の不動点（strict regime のみ。単一ファイル版 §3.2 と同じ理由）。
  if (localScopesExist) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const fa of analyses) {
        for (const inj of fa.injectables) {
          const recvs =
            inj.className === null ? ["<none>"] : subtreeCanonOf(`C::${fa.norm}::${inj.className}`);
          for (const recv of recvs) {
          const k = recvKey(fa, inj.index, recv);
          const d = recvDecisions.get(k)!;
          if (d.kind !== "static") continue;
          for (const depCanon of recvDeps.get(k) ?? []) {
            // AMB は同名のプロジェクトクラスすべてに合流させる。
            const candidates =
              depCanon.startsWith("AMB::")
                ? allDeclaredCanon.filter((c) => c.name === depCanon.slice(5)).map((c) => c.canonId)
                : [depCanon];
            for (const cand of candidates) {
              for (const cls of chainCanonOf(cand).ids) {
                for (const m of injectablesByCanonClass.get(cls) ?? []) {
                  // 構築されるのは cand なので、受け手は cand として引く。
                  const md =
                    recvDecisions.get(recvKey(m.fa, m.index, cand)) ??
                    recvDecisions.get(recvKey(m.fa, m.index, cls));
                  if (md !== undefined && md.kind === "dynamic") {
                    recvDecisions.set(k, {
                      kind: "dynamic",
                      reason: `depends on ${cand.split("::").pop()} whose injectable "${m.prop}" is dynamic`,
                    });
                    changed = true;
                  }
                }
              }
            }
            if (recvDecisions.get(k)!.kind === "dynamic") break;
          }
          }
        }
      }
    }
  }

  // --- 宣言クラスの判定と、分岐するサブクラスへの再宣言（§2）-----------------
  const sameDecision = (a: WiringDecision, b: WiringDecision): boolean =>
    a.kind === "dynamic" ? b.kind === "dynamic" : b.kind === "static" && a.expr === b.expr;

  // 注入する (受け手クラスの正準ID, 注入テキスト生成に必要な情報) の一覧。
  interface Injection {
    ownerCanon: string;
    ownerFa: FileAnalysis;
    ownerName: string;
    node: Extract<Node, { kind: "injectable" }>;
    decision: WiringDecision;
    home: FileAnalysis | undefined;
    fallbackFa: FileAnalysis;
  }
  const injectionsList: Injection[] = [];

  for (const fa of analyses) {
    for (const inj of fa.injectables) {
      const k = decKey(fa, inj.index);
      if (inj.className === null) {
        decisions.set(k, recvDecisions.get(recvKey(fa, inj.index, "<none>"))!);
        continue;
      }
      const selfCanon = `C::${fa.norm}::${inj.className}`;
      const own = recvDecisions.get(recvKey(fa, inj.index, selfCanon))!;
      const diverging: { recv: string; d: WiringDecision }[] = [];
      for (const recv of subtreeCanonOf(selfCanon)) {
        if (recv === selfCanon) continue;
        const d = recvDecisions.get(recvKey(fa, inj.index, recv))!;
        const m = /^C::(.+)::([^:]+)$/.exec(recv);
        const recvFa = m !== null ? byNorm.get(m[1]) : undefined;
        const info = m !== null ? recvFa?.classes.get(m[2]) : undefined;
        const baseCanon =
          info?.baseName !== undefined && info.baseName !== null && recvFa !== undefined
            ? canonClass(recvFa, info.baseName)
            : selfCanon;
        const bd = recvDecisions.get(recvKey(fa, inj.index, baseCanon)) ?? own;
        if (sameDecision(d, bd)) continue;
        diverging.push({ recv, d });
      }
      if (diverging.length > 0 && superProps.has(inj.node.propName)) {
        decisions.set(k, {
          kind: "dynamic",
          reason: `subtree winners diverge, and "super.${inj.node.propName}" is used (a re-declared getter would change what super returns)`,
        });
        continue;
      }
      decisions.set(k, own);
      if (own.kind === "static") {
        const h = recvHome.get(recvKey(fa, inj.index, selfCanon));
        if (h !== undefined) winnerHome.set(k, h);
      }
      for (const { recv, d } of diverging) {
        const m = /^C::(.+)::([^:]+)$/.exec(recv);
        const ownerFa = m !== null ? byNorm.get(m[1]) : undefined;
        if (m === null || ownerFa === undefined) continue; // 注入できない（§4.2）
        injectionsList.push({
          ownerCanon: recv,
          ownerFa,
          ownerName: m[2],
          node: inj.node,
          decision: d,
          home: recvHome.get(recvKey(fa, inj.index, recv)),
          fallbackFa: fa,
        });
      }
    }
  }

  // ---------------------------------------------------------------
  // factory hoisting（クロスファイル勝者）と評価順ガード
  // ---------------------------------------------------------------

  // import specifier の拡張子スタイル（プロジェクト内 import の多数決）。
  let jsExt = 0;
  let noExt = 0;
  for (const fa of analyses) {
    for (const [, imp] of fa.importsByLocalName) {
      if (!imp.specifier.startsWith(".")) continue;
      const resolved = normalizeExtensionlessAbsolutePath(
        path.resolve(path.dirname(fa.file.path), imp.specifier)
      );
      if (!projectNorms.has(resolved)) continue;
      if (imp.specifier.endsWith(".js")) jsExt++;
      else noExt++;
    }
  }
  const useJsExt = jsExt > noExt;

  const specifierFromTo = (from: FileAnalysis, to: FileAnalysis): string => {
    const toBase = to.norm; // 拡張子なし絶対パス
    let rel = path.relative(path.dirname(from.file.path), toBase).split(path.sep).join("/");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return useJsExt ? `${rel}.js` : rel;
  };

  const factoryExportsByNorm = new Map<string, { name: string; expr: string }[]>();
  const factoryNameByHomeExpr = new Map<string, string>();
  const factoryImportsByNorm = new Map<string, Map<string, Set<string>>>(); // norm → specifier → names
  let factoryCounter = 0;

  // 宣言クラスのゲッターと、注入するサブクラスのゲッターを同じ規則で処理する。
  interface HostedSite {
    hostFa: FileAnalysis;          // ゲッターが置かれるファイル
    get(): WiringDecision;
    set(d: WiringDecision): void;
    home: FileAnalysis | undefined;
    label: string;
  }
  const hostedSites: HostedSite[] = [];
  for (const fa of analyses) {
    for (const inj of fa.injectables) {
      const k = decKey(fa, inj.index);
      hostedSites.push({
        hostFa: fa,
        get: () => decisions.get(k)!,
        set: (d) => decisions.set(k, d),
        home: winnerHome.get(k),
        label: `${inj.className ?? "?"}.${inj.node.propName}`,
      });
    }
  }
  for (const injection of injectionsList) {
    hostedSites.push({
      hostFa: injection.ownerFa,
      get: () => injection.decision,
      set: (d) => { injection.decision = d; },
      home: injection.home,
      label: `${injection.ownerName}.${injection.node.propName}`,
    });
  }

  for (const site of hostedSites) {
    {
      const fa = site.hostFa;
      const d = site.get();
      if (d.kind !== "static") continue;
      const home = site.home;
      if (home === undefined || home.norm === fa.norm) continue; // 自ファイル → インライン
      // 評価順ガード: home が元々先に評価を終えている（import 追加は無効化される）、
      // または home が fa を支配している（fa の評価は常に home の評価の内側 →
      // 追加 import は循環スキップされ順序不変。中央設定ファイルが root の場合が典型）。
      const homeIdx = evalOrderIndex.get(home.norm);
      const faIdx = evalOrderIndex.get(fa.norm);
      const safe =
        (homeIdx !== undefined && faIdx !== undefined && homeIdx < faIdx) || dominates(home.norm, fa.norm);
      if (!safe) {
        site.set({
          kind: "dynamic",
          reason: `winner expression lives in ${home.file.path}, which cannot be imported without changing module evaluation order`,
        });
        continue;
      }
      const heKey = `${home.norm} ${d.expr}`;
      let name = factoryNameByHomeExpr.get(heKey);
      if (name === undefined) {
        name = `__dison_factory_${factoryCounter++}`;
        factoryNameByHomeExpr.set(heKey, name);
        let arr = factoryExportsByNorm.get(home.norm);
        if (arr === undefined) {
          arr = [];
          factoryExportsByNorm.set(home.norm, arr);
        }
        arr.push({ name, expr: d.expr });
      }
      const spec = specifierFromTo(fa, home);
      let bySpec = factoryImportsByNorm.get(fa.norm);
      if (bySpec === undefined) {
        bySpec = new Map();
        factoryImportsByNorm.set(fa.norm, bySpec);
      }
      let names = bySpec.get(spec);
      if (names === undefined) {
        names = new Set();
        bySpec.set(spec, names);
      }
      names.add(name);
      site.set({ kind: "static", expr: `${name}()`, why: `${d.why}; hoisted from ${home.file.path}` });
    }
  }

  // ---------------------------------------------------------------
  // needsRuntime と結果の組み立て
  // ---------------------------------------------------------------

  let anyDynamic = false;
  for (const d of decisions.values()) if (d.kind === "dynamic") anyDynamic = true;
  for (const injection of injectionsList) if (injection.decision.kind === "dynamic") anyDynamic = true;
  const needsRuntimeProject = anyDynamic || localScopesExist || dynamicContextWiring || postBarrierWiring;
  const dropRegistrations = !needsRuntimeProject;

  // 動的形の fallback が使う照合キー式。宣言元ファイルの戦略で組み立てる
  // （injectable の型注釈がそのファイルでどうキー化されるかに従う）。
  const canonKeyExpr = (fa: FileAnalysis, node: Extract<Node, { kind: "injectable" }>): string => {
    if (node.token !== undefined) return node.token;
    const base = baseIdentifierOf(node.typeKey);
    if (base !== node.typeKey) return JSON.stringify(node.typeKey);
    if (fa.localDeclaredClasses.has(base) || fa.classes.has(base)) return base;
    const imp = fa.importsByLocalName.get(base);
    if (imp !== undefined && !imp.typeOnly && imp.specifier.startsWith(".")) return base;
    if (fa.localTrueInterfaces.has(base) || fa.importsByLocalName.has(base)) return `__dison_token_${base}`;
    return JSON.stringify(node.typeKey);
  };

  const result = new Map<string, ProjectFileWiring>();
  for (const fa of analyses) {
    const decisionsByInjectableIndex: WiringDecision[] = fa.injectables.map(
      (inj) => decisions.get(decKey(fa, inj.index))!
    );
    const hasDynamicGetter = decisionsByInjectableIndex.some((d) => d.kind === "dynamic");
    const emitsRegistrations =
      !dropRegistrations &&
      fa.ast.some(
        (n) =>
          (n.kind === "configuration" && (n.scope !== "global" || n.entries.length > 0)) ||
          n.kind === "standalone-bind" ||
          n.kind === "standalone-override"
      );
    const line = (site: string, d: WiringDecision): string =>
      d.kind === "static"
        ? `${site.padEnd(24)} → ${d.expr.padEnd(28)} [static: ${d.why}]`
        : `${site.padEnd(24)} → ${"runtime lookup".padEnd(28)} [dynamic: ${d.reason}]`;
    const report: string[] = [];
    for (const inj of fa.injectables) {
      report.push(line(`${inj.className ?? "?"}.${inj.node.propName}`, decisions.get(decKey(fa, inj.index))!));
      // 再宣言したサブクラスは親の下にぶら下げて表示する（§7）。
      for (const x of injectionsList) {
        if (x.node !== inj.node) continue;
        report.push(line(`  └ ${x.ownerName}.${x.node.propName}`, x.decision));
      }
      void 0;
    }

    // このファイルに注入するメンバ（クラス本体 "{" のトークン位置ごと）。
    const injMap = new Map<number, string[]>();
    for (const x of injectionsList) {
      if (x.ownerFa.norm !== fa.norm) continue;
      const info = fa.classes.get(x.ownerName);
      if (info === undefined) continue;
      const finalDefault =
        x.node.defaultExpr !== undefined ? `(${x.node.defaultExpr})` : `new ${x.node.typeName}()`;
      const fallback = isSimpleTypeShape(x.node.typeKey)
        ? `resolveType(${canonKeyExpr(x.fallbackFa, x.node)}, () => ${finalDefault})`
        : finalDefault;
      const arr = injMap.get(info.bodyStart) ?? [];
      arr.push(renderInjectedGetter(x.node, x.ownerName, x.decision, fallback));
      injMap.set(info.bodyStart, arr);
    }
    result.set(fa.file.path, {
      decisionsByInjectableIndex,
      dropRegistrations,
      needsRuntimeImport: hasDynamicGetter || emitsRegistrations,
      factoryExports: factoryExportsByNorm.get(fa.norm) ?? [],
      factoryImports: [...(factoryImportsByNorm.get(fa.norm) ?? new Map<string, Set<string>>())].map(
        ([specifier, names]) => ({ specifier, names: [...names].sort() })
      ),
      report,
      classMemberInjections: [...injMap],
    });
  }
  return result;
}
