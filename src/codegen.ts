// =====================================================================
// 4. CodeGenerator
// =====================================================================

import type { Node, OverrideEntry, BindEntry } from "./ast.js";
import { isSimpleTypeShape, baseIdentifierOf } from "./analysis.js";
import type { WiringTable } from "./static-wiring.js";

// bind/injectable の照合キーをどう決めるかの戦略。型の種別に応じてキーが変わる。
export interface KeyStrategy {
  // その裸の識別子が「実行時に値を持つクラス（具象 or abstract）」か。true なら
  // クラスの実体参照をキーにする（docs/type-identity-matching.md 案A(a)）。ローカル
  // 宣言のクラス、または複数ファイルモードで他プロジェクトファイルからvalue-import
  // された具象/abstract クラス。
  isIdentityClass: (id: string) => boolean;
  // その裸の識別子が「companion Symbol でキー化する真の interface/型エイリアス」なら、
  // キーに使う companion 識別子（例 "__dison_token_IRepo"）を返す。そうでなければ
  // undefined（docs/type-identity-matching.md 案A(b)）。ローカル宣言の interface で
  // DI利用されるもの、または他プロジェクトファイルからimportした interface。
  companionRefOf: (id: string) => string | undefined;
}

// companion Symbol の識別子名。宣言元ファイルの emit 名と、import 側の参照名が
// 一致する必要があるため、型名の決定的関数にする（利用者コードと衝突しにくい接頭辞）。
export function companionName(typeName: string): string {
  return `__dison_token_${typeName}`;
}

// bind/injectable の照合キー式を組み立てる。優先順位:
//   1. "as <トークン>" 句があればそのトークン参照（最優先。利用者の明示指定）。
//   2. ジェネリクスを含まない裸の識別子で「実行時に値を持つクラス（具象/abstract）」
//      なら、クラスの実体参照（識別子そのもの）。実行時に値を持つため複数ファイルに
//      またがる同名クラスが別の実体として自動的に区別され、手動tokenなしで衝突しない
//      （案A(a)）。なお bind 左辺のタイプミスは実体キーの有無に関わらず bindType<T> の
//      型引数が元々検出するため、これは実体キー化の固有の利得ではない。
//   3. 裸の識別子で「真の interface/型エイリアス（実行時に値が無い）」なら、宣言ごとに
//      自動生成した companion Symbol の識別子（案A(b)）。これも同名でも別 Symbol 値
//      として区別され、手動tokenなしで衝突しない。
//   4. それ以外（外部パッケージ由来の型、または具体的な型引数を持つジェネリクス）は
//      正規化済みの型名文字列。ジェネリクスは型引数の区別（Repository<User> 対
//      Repository<Admin>）を保つため文字列が必要。外部由来の型は companion を
//      import できないため文字列（衝突回避は従来の token/as に委ねる）。
export function keyExprFor(typeKey: string, token: string | undefined, strategy: KeyStrategy): string {
  if (token !== undefined) return token;
  const base = baseIdentifierOf(typeKey);
  if (base !== typeKey) return JSON.stringify(typeKey); // ジェネリクス等の複合型は文字列
  if (strategy.isIdentityClass(base)) return base;
  const companion = strategy.companionRefOf(base);
  if (companion !== undefined) return companion;
  return JSON.stringify(typeKey);
}

// override 1件分のDI_REGISTRY代入文を生成する。configuration内（関数本体に
// 収集される場合）と、configurationで包まない単独のoverride（その場に直接
// 出力される場合）の両方から共有される。
// local=false: グローバルレジストリへ登録（registerOverrideLazy）。local=true: ローカル
// スコープフレームへ登録（__disonOverride。__disonEnterScopeLazy の setup 内で使う）。
// 対象クラスはサンク（() => Class）で渡し、評価を初回参照時まで遅延する
// （後方宣言クラスへの前方参照を可能にする。docs/config-forward-reference.md）。
function generateOverrideEntryLines(entry: OverrideEntry, local: boolean): string[] {
  // entry.className はクラスの実体を指す識別子としてそのまま埋め込む
  // （文字列リテラルにはしない）。キーがクラスの実体そのものなので、className が
  // スコープ内に存在しない（タイプミス・importし忘れ）場合は tsc が "Cannot find name"
  // として検出する（サンク内でも同様に検出される）。
  const fn = local ? "__disonOverride" : "registerOverrideLazy";
  return entry.assignments.map(
    (a) => `  ${fn}(() => ${entry.className}, "${a.prop}", () => (${a.valueExpr}));`
  );
}

// bind 1件分のbindType呼び出し文を生成する（generateOverrideEntryLinesと同様、
// configuration内・単独bindの両方から共有される）。
//
// 型（クラス/インターフェース/型エイリアス/abstract class、ジェネリクスの
// 具体的なインスタンス化を含む）単位の横断的な差し替え。
//
// 型安全性: bindType<T> の型引数に差し替え元の型を明示的に指定することで、
// 差し替え先のfactoryがその型と互換でなければ tsc がコンパイルエラーにする。
// 差し替え元はインターフェースや型エイリアスでもよい（型引数としてのみ使われ、
// 実行時の値としては要求されないため）。差し替え先は `new` で実体化する必要が
// あるため、実質的に具象クラスに限定される（インターフェースを指定すると
// `new` の時点でtscがエラーにする）。ジェネリクスの具体的なインスタンス化
// （例: Repository<User>）も通常の型表現としてそのまま型引数・new式に渡せる。
//
// 照合キー（originalTypeKey/replacementTypeKey）は空白・コメントを除いた
// 正規化済みの文字列を使う。injectable側のresolveTypeキーと同じ規則
// （parseTypeExpr/parseGenericTypeRefのtypeKey生成）で作っているため、
// 書き方の空白差（"Repository<User>" 対 "Repository <User>" など）に
// 影響されずに一致する。ただし"as <トークン>"句が指定されている場合は、
// 文字列キーの代わりにそのトークンの識別子参照をそのままキーとして使う
// （複数ファイルにまたがる同名interface/型エイリアスの衝突を避けるため。
// docs/bind-interface-token.md）。
//
// 連鎖: 差し替え先クラス自身がさらに bind されている可能性があるので、
// 直接 new せず resolveType を介して再帰的に解決する。
// （bind A = B; bind B = C; と書けば、Aの解決は最終的にCまで辿る）
// local=false: グローバル TYPE_BINDINGS へ登録（bindTypeLazy<T>）。local=true: ローカル
// スコープフレームへ登録（__disonBind。__disonEnterScopeLazy の setup 内で使う）。
// bindTypeLazy<T> は型引数で差し替え先の型互換を tsc に検査させるが、__disonBind は
// 型引数を取れないため、代わりに factory の返り値型注釈 `(): OrigType =>` で同じ検査を
// 得る（差し替え先が OrigType と非互換なら tsc がエラーにする）。
// 左辺キーはサンク（() => Key）で渡し、評価を初回参照時まで遅延する
// （後方宣言クラスへの前方参照を可能にする。docs/config-forward-reference.md）。
// 差し替え先キーは factory 内にあり元々遅延評価される。
function generateBindEntryLines(entry: BindEntry, strategy: KeyStrategy, local: boolean): string[] {
  const originalKeyExpr = keyExprFor(entry.originalTypeKey, entry.token, strategy);
  // 差し替え先（replacement）は `new` で実体化される具象クラスなので、それ自身が
  // さらに bind の左辺になっている場合の連鎖解決キーも、左辺と同じ規則で決める
  // （具象クラスなら実体参照、そうでなければ文字列/companion）。左辺と同じ戦略を使う
  // ことで、ある型が「bindの左辺」と「別のbindの差し替え先」の両方に現れてもキーが一致する。
  const replacementKeyExpr = keyExprFor(entry.replacementTypeKey, undefined, strategy);
  // "bind Original = Replacement(args)" のコンストラクタ引数（あれば）を new 式に渡す。
  const args = entry.replacementArgs ?? "";
  const factory = `resolveType(${replacementKeyExpr}, () => new ${entry.replacementTypeName}(${args}))`;
  return [
    local
      ? `  __disonBind(() => ${originalKeyExpr}, (): ${entry.originalTypeName} => ${factory});`
      : `  bindTypeLazy<${entry.originalTypeName}>(() => ${originalKeyExpr}, () => ${factory});`,
  ];
}

// configuration を構文位置に応じて生成する（docs/scoped-configuration.md）:
//   - local（関数/メソッド本体・無名）: `using __dison_scope_N = __disonEnterScope(...)` に
//     脱糖。囲みブロックの終端で自動的に元のスコープへ戻る（Symbol.dispose）。
//   - class（クラス本体直下・無名）: `static __dison_classScope_N = __disonBuildFrame(...)` に
//     脱糖。そのクラス（のインスタンス）の解決チェインに入る（プロトタイプ鎖で継承される）。
//   - global 名前付き: `export function activateName() {...}`（activate で有効化）。
//   - global 無名: auto-active。即時にグローバルへ適用する呼び出しをその場に出す。
// scopeId は複数の local/class configがあっても衝突しない連番（class は static フィールド名の
// 一意性に、local は using 変数名の一意性に使う）。
function generateConfiguration(
  node: Extract<Node, { kind: "configuration" }>,
  strategy: KeyStrategy,
  scopeId: number,
  wiring: WiringTable | undefined
): string {
  // 静的解決で「登録を読む者がいない」と証明された場合、グローバル configuration の
  // 登録文は出力しない（ランタイム前置きごと消えるため、残すとコンパイルも通らない）。
  // dropRegistrations が真になるのは local/class スコープが存在しないファイルだけ
  // なので、この分岐はグローバル形（名前付き/無名）にしか到達しない。
  if (wiring?.dropRegistrations === true && (node.scope === "global" || node.scope === "class")) {
    if (node.scope === "global" && node.name !== undefined) {
      // activate 呼び出し側の形（activateName()）は変えないため、空の関数を残す。
      return `export function activate${node.name}() {\n}`;
    }
    // 無名グローバル / クラススコープ: 配線は畳んだゲッターに焼き込まれており、
    // フレームを読む者はいない（L1.5）。static フィールドごと出力しない。
    return "";
  }
  // local と class は「フレームへ差分を積む」形（__disonBind/__disonOverride）を共有する。
  const frameForm = node.scope === "local" || node.scope === "class";
  const lines: string[] = [];
  for (const entry of node.entries) {
    if (entry.kind === "override") {
      lines.push(...generateOverrideEntryLines(entry, frameForm));
    } else {
      lines.push(...generateBindEntryLines(entry, strategy, frameForm));
    }
  }
  if (node.scope === "local") {
    // 無名ローカル configuration。__disonEnterScope の setup で __disonBind/__disonOverride を
    // 使ってフレームへ差分を積む。`using` で受けるのでブロック終端で自動的に戻る。
    // async関数内では (await null, ...) で一度中断してから enterWith することで、
    // スコープを関数専有のマイクロタスク実行に隔離し呼び出し元への漏れを防ぐ
    // （暗黙のサスペンションポイント。docs/async-local-scope.md §2）。
    const enter =
      `__disonEnterScopeLazy((__disonBind, __disonOverride) => {\n` +
      `${lines.join("\n")}\n})`;
    return node.asyncScope === true
      ? `using __dison_scope_${scopeId} = (await null, ${enter});`
      : `using __dison_scope_${scopeId} = ${enter};`;
  }
  if (node.scope === "class") {
    // 無名クラス configuration。クラス本体の static フィールドとしてフレームを構築する。
    // __disonClassScopes が this.constructor のプロトタイプ鎖からこの static を集める。
    return (
      `static __dison_classScope_${scopeId} = __disonBuildFrameLazy((__disonBind, __disonOverride) => {\n` +
      `${lines.join("\n")}\n});`
    );
  }
  if (node.name !== undefined) {
    // 名前付きグローバル。export しておくと他ファイルから import して activate できる
    // （docs/multi-file-support.md フェーズ1）。単一ファイルでもexportは無害。
    return `export function activate${node.name}() {\n${lines.join("\n")}\n}`;
  }
  // 無名グローバル: auto-active。その場に即時適用する呼び出しを出す。
  return lines.join("\n");
}

function generateInjectable(
  node: Extract<Node, { kind: "injectable" }>,
  strategy: KeyStrategy,
  wiring: WiringTable | undefined
): string {
  const { propName: p, typeName: t, typeKey: k, defaultExpr, token } = node;

  // 静的解決（docs/static-resolution-design.md）: 配線がトランスパイル時に確定した
  // injectable は、レジストリを経由せず勝者式へ直接畳み込む。遅延性（式の評価は
  // 初回アクセス時）とインスタンス単位のキャッシュは従来の形をそのまま保つ。
  // スコープ捕捉フィールド（__dison_scope_*）は不要になるため出力しない
  // （畳めた injectable の解決はスコープに依存しないことが証明済みのため）。
  const decision = wiring?.decisions.get(node);
  if (decision !== undefined && decision.kind === "static") {
    return [
      ``,
      `  private _${p}?: ${t};`,
      `  get ${p}(): ${t} {`,
      `    if (!this._${p}) {`,
      `      this._${p} = ${decision.expr};`,
      `    }`,
      `    return this._${p}!;`,
      `  }`,
      ``,
    ].join("\n");
  }
  const simpleShape = isSimpleTypeShape(k);

  // パーサ（parseInjectable）が「危険な型（isRiskyInjectableType）には
  // defaultExpr が必須」であることを既に強制しているため、ここでは
  // defaultExpr が無ければ安全な型（new T() で問題なく生成できる）と
  // 分かっている。危険な型の判定・強制ロジックをここで再度持たない。
  const finalDefault = defaultExpr !== undefined ? `(${defaultExpr})` : `new ${t}()`;

  // bind (TYPE_BINDINGS) は型注釈が識別子（＋ジェネリクス）の形をしていれば
  // 試みる。interfaceや型エイリアスも文字列キーとして扱えるため、これ自体は
  // コンパイル上安全。実際にbindされていなければ finalDefault にフォールバック
  // する。優先順位: プロパティ単位の override > 型単位の bind > 宣言済みの既定
  // 初期化式。照合キーは keyExprFor が決める（bind側と同じ規則: 実行時に値を持つ
  // クラスは実体参照、真の interface/型エイリアスは companion Symbol、ジェネリクスや
  // 外部由来の型は正規化済みの typeKey 文字列、"as <トークン>"句があればそのトークン
  // 参照）。bind側とキー生成規則をそろえることで、injectableの型注釈とbindの左辺が
  // 同じキーで一致する。
  const keyExpr = keyExprFor(k, token, strategy);
  const fallback = simpleShape ? `resolveType(${keyExpr}, () => ${finalDefault})` : finalDefault;

  // 構築時にその時点のスコープ（ローカルフレーム、無ければグローバル）を捕捉する
  // （docs/scoped-configuration.md フェーズ1）。__disonResolveInjectable が解決時に
  // このスコープへ再突入し、override > fallback（bind/既定初期化式）の順で解決する。
  // 再突入により、fallback 内で遅延構築される依存の new も同じスコープの下で走る。
  // 捕捉フィールドは injectable ごとに1つ（同じ値だが重複宣言を避けるため名前を分ける）。
  //
  // strictモードでは `if (!this._x) { this._x = f(); }` の後の `return this._x;` は
  // 途中で挟まる関数呼び出しによりnarrowingが無効化され `T | undefined` とみなされて
  // コンパイルエラーになる。そのため末尾で `!` を付けて確実に非undefined型として返す。
  return [
    ``,
    `  private readonly __dison_scope_${p} = __disonCurrentScope();`,
    `  private _${p}?: ${t};`,
    `  get ${p}(): ${t} {`,
    `    if (!this._${p}) {`,
    `      this._${p} = __disonResolveInjectable(this.__dison_scope_${p}, this.constructor, "${p}", () => ${fallback});`,
    `    }`,
    `    return this._${p}!;`,
    `  }`,
    ``,
  ].join("\n");
}

// activate Name from "path"; がAST全体に複数現れる場合の、importローカル名
// （エイリアス）の割り当て。exportedNameは相手ファイルで実際にexportされて
// いる名前（常に "activate" + configName）、aliasはこのファイル内で使う
// ローカル名（衝突時はexportedNameと異なる）。
export interface FromActivateBinding {
  exportedName: string;
  alias: string;
  path: string;
}

// (name, path) の組ごとにimport時のエイリアスを割り当てる。同じ組み合わせは
// 同じエイリアスを再利用する（1つのimportにまとめる）。異なるpathが同じ
// configuration名を持つ場合（複数ファイルにたまたま同名のconfigurationが
// ある場合）は、エイリアスに連番を振って衝突を避ける
// （docs/activate-from-syntax.md参照）。
export function resolveFromActivateBindings(nodes: Node[]): Map<string, FromActivateBinding> {
  const byKey = new Map<string, FromActivateBinding>();
  const aliasOwner = new Map<string, string>(); // alias -> それを最初に使ったpath

  for (const node of nodes) {
    if (node.kind !== "activate" || node.fromPath === undefined) continue;
    const key = `${node.name}::${node.fromPath}`;
    if (byKey.has(key)) continue;

    const exportedName = `activate${node.name}`;
    let alias = exportedName;
    let suffix = 2;
    while (aliasOwner.has(alias) && aliasOwner.get(alias) !== node.fromPath) {
      alias = `${exportedName}_${suffix}`;
      suffix++;
    }
    aliasOwner.set(alias, node.fromPath);
    byKey.set(key, { exportedName, alias, path: node.fromPath });
  }

  return byKey;
}

// resolveFromActivateBindingsの結果からimport文をまとめて生成する。
// ES Modulesのimportはファイル先頭にしか書けないため、"activate ... from"が
// ソース中のどこに現れても、importはここでまとめてファイル先頭に出力し、
// 各activateノード自体は呼び出し文だけを残す（generate関数のactivateの
// 分岐を参照）。
export function generateFromImportStatements(bindings: Map<string, FromActivateBinding>): string {
  if (bindings.size === 0) return "";
  const lines = [...bindings.values()].map(({ exportedName, alias, path }) => {
    const spec = alias === exportedName ? exportedName : `${exportedName} as ${alias}`;
    return `import { ${spec} } from ${JSON.stringify(path)};`;
  });
  return lines.join("\n") + "\n\n";
}

// DI利用される真の interface/型エイリアスのうち、このファイルで宣言されているものに
// 対して companion Symbol を emit する（案A(b)）。宣言ごとに一意な Symbol を作ることで、
// 複数ファイルにまたがる同名 interface が別の値として区別される。トップに巻き上げて
// よい（Symbol を作るだけで interface 宣言を参照しないため）。names は emit する
// ローカル宣言名の配列。
export function generateCompanionDeclarations(names: string[]): string {
  if (names.length === 0) return "";
  const lines = names.map(
    (name) => `export const ${companionName(name)} = Symbol(${JSON.stringify(name)});`
  );
  return lines.join("\n") + "\n\n";
}

// 他プロジェクトファイルで宣言された interface/型エイリアスを DI で使う場合に、その
// companion Symbol を import する文を生成する（案A(c)）。import 側のローカル型名が
// 宣言元の元名と違う（`import { IFoo as Bar }`）場合は、companion も
// `{ __dison_token_IFoo as __dison_token_Bar }` の形で取り込み、キーとしては
// ローカル名側（__dison_token_Bar）を使う。ES Modules の import はファイル先頭に
// しか置けないため、まとめてここで生成して前置きに出す。
export interface CompanionImport {
  localName: string; // このファイルでの型名
  originalName: string; // 宣言元ファイルでの元の export 名
  specifier: string; // import 元
}

export function generateCompanionImportStatements(imports: CompanionImport[]): string {
  if (imports.length === 0) return "";
  const lines = imports.map(({ localName, originalName, specifier }) => {
    const exportedSym = companionName(originalName);
    const localSym = companionName(localName);
    const spec = exportedSym === localSym ? exportedSym : `${exportedSym} as ${localSym}`;
    return `import { ${spec} } from ${JSON.stringify(specifier)};`;
  });
  return lines.join("\n") + "\n";
}

// AST から「DIで実際に使われている型名（裸の識別子部分）」を集める。
// 対象は injectable の型注釈と bind の左辺（差し替え元）。bind の差し替え先は常に
// `new` される具象クラスで companion 対象にならないため含めない。companion を emit
// すべきローカル interface の絞り込み（DI利用のもののみ emit）や、複数ファイルの
// companion 計画（docs/type-identity-matching.md 案A(b) 案2）で使う。
export function collectDiUsedTypeNames(nodes: Node[]): Set<string> {
  const names = new Set<string>();
  const addBind = (e: BindEntry) => names.add(baseIdentifierOf(e.originalTypeKey));
  for (const node of nodes) {
    if (node.kind === "injectable") {
      if (isSimpleTypeShape(node.typeKey)) names.add(baseIdentifierOf(node.typeKey));
    } else if (node.kind === "configuration") {
      for (const e of node.entries) if (e.kind === "bind") addBind(e);
    } else if (node.kind === "standalone-bind") {
      addBind(node.entry);
    }
  }
  return names;
}

export function generate(
  nodes: Node[],
  fromBindings: Map<string, FromActivateBinding>,
  strategy: KeyStrategy,
  wiring?: WiringTable
): string {
  let out = "";
  // local/class 無名 configuration の連番（using 変数名 / static フィールド名の衝突回避）。
  let scopeCounter = 0;
  for (const node of nodes) {
    switch (node.kind) {
      case "raw":
        out += node.text;
        break;
      case "configuration":
        out += generateConfiguration(
          node,
          strategy,
          node.scope === "local" || node.scope === "class" ? scopeCounter++ : -1,
          wiring
        );
        break;
      case "injectable":
        out += generateInjectable(node, strategy, wiring);
        break;
      case "token":
        // 複数箇所（複数ファイルにまたがる場合も含む）から安定して参照
        // される共有の一意な値として、Symbolを生成する
        // （docs/bind-interface-token.md）。
        out += `export const ${node.name} = Symbol(${JSON.stringify(node.name)});`;
        break;
      case "activate":
        if (node.fromPath !== undefined) {
          const binding = fromBindings.get(`${node.name}::${node.fromPath}`)!;
          out += `${binding.alias}();`;
        } else {
          out += `activate${node.name}();`;
        }
        break;
      case "standalone-override":
        // configurationで包まないため関数宣言にせず、その場に直接グローバルへの
        // 代入文として出力する（書かれた位置で即座に実行される）。
        // 登録を読む者がいないと証明済みなら出力しない（静的解決）。
        if (wiring?.dropRegistrations !== true) {
          out += generateOverrideEntryLines(node.entry, false).join("\n");
        }
        break;
      case "standalone-bind":
        if (wiring?.dropRegistrations !== true) {
          out += generateBindEntryLines(node.entry, strategy, false).join("\n");
        }
        break;
    }
  }
  return out;
}
