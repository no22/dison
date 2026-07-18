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
  // token: "bind Original as Token = Replacement;" のas句（トークンの識別子参照。
  // 複数ファイルにまたがる同名interface/型エイリアスの衝突をtokenで明示的に
  // 回避するために使う。指定時はoriginalTypeKeyの代わりにこの識別子参照を
  // bindTypeのキーとして使う。docs/bind-interface-token.md参照）。
  token?: string;
}

export type ConfigEntry = OverrideEntry | BindEntry;

export type Node =
  | { kind: "raw"; text: string }
  | { kind: "configuration"; name: string; entries: ConfigEntry[] }
  // token: "injectable prop: Type as Token = ...;" のas句（bindと同じ役割）。
  | { kind: "injectable"; propName: string; typeName: string; typeKey: string; defaultExpr?: string; token?: string }
  // token Name; -> export const Name = Symbol("Name"); に脱糖される
  // （docs/bind-interface-token.md）。
  | { kind: "token"; name: string }
  // fromPath: "activate Name from '...';" のfrom句（正規化済みの文字列値）。
  // 省略時（同一ファイル内 or 既にimport済みのconfigurationをactivateする
  // 場合）はundefined。
  | { kind: "activate"; name: string; fromPath?: string }
  // configuration で包まない単独の override/bind。その場に書かれた位置で
  // 即座に実行される代入文として脱糖される（レキシカル変数を捕捉したい場合に使う）。
  | { kind: "standalone-override"; entry: OverrideEntry }
  | { kind: "standalone-bind"; entry: BindEntry };
