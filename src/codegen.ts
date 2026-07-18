// =====================================================================
// 4. CodeGenerator
// =====================================================================

import type { Node, OverrideEntry, BindEntry } from "./ast.js";
import { isSimpleTypeShape } from "./analysis.js";

// override 1件分のDI_REGISTRY代入文を生成する。configuration内（関数本体に
// 収集される場合）と、configurationで包まない単独のoverride（その場に直接
// 出力される場合）の両方から共有される。
function generateOverrideEntryLines(entry: OverrideEntry): string[] {
  // entry.className はクラスの実体を指す識別子としてそのまま埋め込む
  // （文字列リテラルにはしない）。registerOverride がクラスの実体そのものを
  // キーにするため、className がスコープ内に存在しない（タイプミス・
  // importし忘れ）場合は tsc が "Cannot find name" として検出する。
  return entry.assignments.map(
    (a) => `  registerOverride(${entry.className}, "${a.prop}", () => (${a.valueExpr}));`
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
function generateBindEntryLines(entry: BindEntry): string[] {
  const originalKeyExpr = entry.token !== undefined ? entry.token : JSON.stringify(entry.originalTypeKey);
  const replacementKey = JSON.stringify(entry.replacementTypeKey);
  return [
    `  bindType<${entry.originalTypeName}>(${originalKeyExpr}, () => resolveType(${replacementKey}, () => new ${entry.replacementTypeName}()));`,
  ];
}

function generateConfiguration(node: Extract<Node, { kind: "configuration" }>): string {
  const lines: string[] = [];
  for (const entry of node.entries) {
    if (entry.kind === "override") {
      lines.push(...generateOverrideEntryLines(entry));
    } else {
      lines.push(...generateBindEntryLines(entry));
    }
  }
  // export しておくことで、他ファイルから import { activateName } して
  // activate をクロスファイルで使えるようにする（docs/multi-file-support.md
  // フェーズ1。単一ファイル利用時もexportは無害で、同一ファイル内から
  // 従来通り呼び出せる）。
  return `export function activate${node.name}() {\n${lines.join("\n")}\n}`;
}

function generateInjectable(node: Extract<Node, { kind: "injectable" }>): string {
  const { propName: p, typeName: t, typeKey: k, defaultExpr, token } = node;
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
  // 初期化式。照合キーには typeName ではなく正規化済みの typeKey を使う
  // （bind側のキー生成と同じ規則にそろえ、空白の書き方差で一致しなくなるのを
  // 防ぐ。詳細はファイル冒頭のヘッダーコメント参照）。"as <トークン>"句が
  // 指定されている場合は、文字列キーの代わりにそのトークンの識別子参照を
  // そのままキーとして使う（docs/bind-interface-token.md）。
  const keyExpr = token !== undefined ? token : JSON.stringify(k);
  const fallback = simpleShape ? `resolveType(${keyExpr}, () => ${finalDefault})` : finalDefault;

  // strictモードでは `if (!this._x) { this._x = f(); }` の後の `return this._x;` は
  // 途中で挟まる関数呼び出し（factory()）によりnarrowingが無効化され、
  // `T | undefined` のままとみなされてコンパイルエラーになる。
  // そのためローカル変数を経由して確実に非undefined型として返す。
  return [
    ``,
    `  private _${p}?: ${t};`,
    `  get ${p}(): ${t} {`,
    `    if (!this._${p}) {`,
    `      const factory = getOverride(this.constructor, "${p}");`,
    `      this._${p} = factory ? factory() : ${fallback};`,
    `    }`,
    `    return this._${p}!;`,
    `  }`,
    `  set ${p}(value: ${t}) { this._${p} = value; }`,
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

export function generate(nodes: Node[], fromBindings: Map<string, FromActivateBinding>): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "raw":
        out += node.text;
        break;
      case "configuration":
        out += generateConfiguration(node);
        break;
      case "injectable":
        out += generateInjectable(node);
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
        // configurationで包まないため関数宣言にせず、その場に直接
        // 代入文として出力する（書かれた位置で即座に実行される）。
        out += generateOverrideEntryLines(node.entry).join("\n");
        break;
      case "standalone-bind":
        out += generateBindEntryLines(node.entry).join("\n");
        break;
    }
  }
  return out;
}
