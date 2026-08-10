// =====================================================================
// 2. AST定義
// =====================================================================

export interface OverrideEntry {
  kind: "override";
  className: string;
  assignments: { prop: string; valueExpr: string }[];
}

export interface BindEntry {
  kind: "bind";
  // originalTypeName/replacementTypeName: 生成コードにそのまま出力する表示用テキスト
  // （ジェネリクスを含む元の書き方を保持。bindType<T>の型引数やnew式に使う）。
  // originalTypeKey/replacementTypeKey: 空白・コメントを除いた正規化済みキー
  // （TYPE_BINDINGSの照合に使う。injectable側のtypeKeyと同じ規則で作る）。
  originalTypeName: string;
  originalTypeKey: string;
  replacementTypeName: string;
  replacementTypeKey: string;
  // replacementArgs: "bind Original = Replacement(args);" の括弧内側の引数テキスト
  // （そのまま new Replacement(<args>) のコンストラクタ引数として出力する）。
  // 括弧を書かなかった場合（"bind Original = Replacement;"）や空括弧（"...()")の
  // 場合は undefined（＝ new Replacement() 相当）。照合キー（chaining）には含めない。
  // docs/bind-constructor-arguments.md 参照。
  replacementArgs?: string;
  // token: "bind Original as Token = Replacement;" のas句（トークンの識別子参照。
  // 複数ファイルにまたがる同名interface/型エイリアスの衝突をtokenで明示的に
  // 回避するために使う。指定時はoriginalTypeKeyの代わりにこの識別子参照を
  // bindTypeのキーとして使う。docs/bind-interface-token.md参照）。
  token?: string;
}

export type ConfigEntry = OverrideEntry | BindEntry;

// `provides` 節が列挙するキー。bind キー（型参照＋任意の as トークン）と
// override 対（クラス名.プロパティ名）の両方を扱う。
export type ProvidesKey =
  | { kind: "bind"; typeName: string; typeKey: string; token?: string }
  | { kind: "override"; className: string; prop: string };

// tokenPos: そのノードの先頭トークンの「元トークン列でのインデックス」。
// 静的解決（docs/static-resolution-design.md）が、トップレベルのフロー解析
// （配線文と実行文の前後関係）・囲みクラスの特定・blockContext参照に使う。
// raw ノードには不要（静的解決はトークン列側を直接走査する）。
export type Node =
  // tokenPos: raw も含め全ノードが元トークン列の索引を持つ。サブクラス別ゲッター
  // 再宣言（docs/subclass-getter-redeclaration.md §5）が、クラス本体の "{" の位置に
  // メンバを注入するために使う。
  | { kind: "raw"; text: string; tokenPos?: number }
  // configuration: name が undefined なら無名（auto-active、宣言的。
  // docs/scoped-configuration.md）。scope は構文位置で決まるレベル:
  //   - "global": トップレベル。名前付きは activate 関数、無名は即時グローバル適用。
  //   - "local": 関数/メソッド本体。無名のみ（フェーズ1）で、`using ... __disonEnterScope(...)`
  //     に脱糖されレキシカルなスコープに閉じる。
  //   - "class": クラス本体直下。無名のみ（フェーズ2）で、`static __dison_classScope_N =
  //     __disonBuildFrame(...)` に脱糖され、そのクラスのインスタンスの解決に効く。
  // asyncScope: scope==="local" で囲み関数がasyncの場合true。脱糖形に暗黙の
  // サスペンション（await null）を挿入して呼び出し元への漏れを防ぐ
  // （docs/async-local-scope.md）。
  // extendsNames: `configuration [Name] extends A, B { ... }` の継承元
  // （docs/configuration-inheritance.md）。名前で参照した configuration の
  // エントリを取り込む。無名に付けた場合は「その位置への展開」になる。
  // entries は書かれたとおりを保持し、平坦化はしない（パーサは他ファイルの
  // 親を解決できないため。平坦化は config-inheritance.ts が行う）。
  // extendsSelections: `configuration extends (cond ? A : B) { ... }` の実行時選択
  // （docs/activate-sugar-implementation.md §1）。文法は「条件木で葉は configuration
  // 名」に限定してあるため、候補集合（leaves）が静的に確定する。exprTemplate は
  // 葉を "{0}" "{1}" … に置換した条件式で、生成時に applier 参照へ埋め戻す。
  | {
      kind: "configuration";
      name?: string;
      extendsNames?: string[];
      extendsSelections?: { leaves: string[]; exprTemplate: string }[];
      // extendsFrom: `activate X from "./p";` 由来の specifier（名前 → パス）。
      // プロジェクト全体の名前解決より優先される（単一ファイルモードでの
      // クロスファイル参照手段。docs/activate-sugar-implementation.md §2.1）。
      extendsFrom?: Record<string, string>;
      // extendsExternal: 宣言がこのファイルから見えないことが正常な名前
      // （`import { activateX }` 経由で知っている configuration）。未解決を診断しない。
      extendsExternal?: string[];
      // providesKeys: `configuration P provides Repository, Service.repo { ... }` の
      // 宣言された表面（docs/configuration-provides.md）。「少なくともこれらを提供する」
      // という主張で、実効エントリ（extends 継承分を含む）との差分が transpile エラー。
      // キーの構文は bind 左辺と同じ規則なので、正規化もそのまま通せる。
      providesKeys?: ProvidesKey[];
      scope: "global" | "local" | "class";
      asyncScope?: boolean;
      entries: ConfigEntry[];
      tokenPos?: number;
    }
  // token: "injectable prop: Type as Token = ...;" のas句（bindと同じ役割）。
  | { kind: "injectable"; propName: string; typeName: string; typeKey: string; defaultExpr?: string; token?: string; tokenPos?: number }
  // token Name; -> export const Name = Symbol("Name"); に脱糖される
  // （docs/bind-interface-token.md）。
  | { kind: "token"; name: string }
  // fromPath: "activate Name from '...';" のfrom句（正規化済みの文字列値）。
  // 省略時（同一ファイル内 or 既にimport済みのconfigurationをactivateする
  // 場合）はundefined。
  | { kind: "activate"; name: string; fromPath?: string; tokenPos?: number }
  // configuration で包まない単独の override/bind。その場に書かれた位置で
  // 即座に実行される代入文として脱糖される（レキシカル変数を捕捉したい場合に使う）。
  | { kind: "standalone-override"; entry: OverrideEntry; tokenPos?: number }
  | { kind: "standalone-bind"; entry: BindEntry; tokenPos?: number };
