// =====================================================================
// 静的解決（配線のトランスパイル時確定とレジストリ消去）
// =====================================================================
//
// docs/static-resolution-design.md フェーズ1（単一ファイル・L0+L1）の実装。
//
// 各 injectable（= (クラス, プロパティ) 単位のゲッター）について、「プログラムの
// どの時点で解決されても同じ勝者になる」ことを証明できた場合に、その勝者式へ
// 直接畳み込む（WiringTable の decision が "static"）。証明できない場合は従来
// 通りのレジストリ経由の生成に落とす（"dynamic"。reason は --explain がそのまま
// 印字する）。
//
// 判定の骨子:
//   - L0: キーに配線が一切無い → 既定初期化式に畳む。
//   - L1: 配線（無名グローバル config／トップレベル無条件 activate／トップレベル
//     standalone）がすべて「最初の実行可能なトップレベル文（バリア）」より前に
//     ある → 最終配線状態に畳む。
//   - 動的 taint: ローカル/クラススコープの配線、関数・分岐内の activate/
//     standalone、バリア後のトップレベル配線、解析不能な式、サブクラスでの
//     勝者分岐、などに触れるキー/(クラス,プロパティ) は畳まない。
//   - 推移的 taint（strict regime）: ローカル/クラススコープがファイル内に存在する
//     場合のみ、勝者式が構築するクラスの依存閉包まで全て静的であることを要求する
//     （設計 §3.2。スコープ再突入の捕捉差を塞ぐ）。スコープが全く無いファイルでは
//     捕捉は観測不能なのでこの検査を省く。

import type { Token } from "./lexer.js";
import { Lexer } from "./lexer.js";
import type { Node, OverrideEntry, BindEntry, ConfigEntry } from "./ast.js";
import { keyExprFor, type KeyStrategy } from "./codegen.js";
import { isSimpleTypeShape, baseIdentifierOf, collectImportBindings, type ImportBinding } from "./analysis.js";
import { flattenConfiguration } from "./config-inheritance.js";

export type WiringDecision =
  | { kind: "static"; expr: string; why: string }
  | { kind: "dynamic"; reason: string };

export interface WiringTable {
  // キーは injectable の AST ノード（オブジェクト同一性）。codegen が参照する。
  decisions: Map<Node, WiringDecision>;
  // ランタイム前置き（レジストリ等）が必要か。false なら prelude を一切出さない。
  needsRuntime: boolean;
  // true なら登録文（bindTypeLazy / registerOverrideLazy 等）を出力しない
  // （読む者がいないと証明済み）。needsRuntime の否定と一致する。
  dropRegistrations: boolean;
  // --explain 用の整形済みレポート（1 injectable 1行）。
  report: string[];
  // サブクラス別ゲッター再宣言（docs/subclass-getter-redeclaration.md）。
  // クラス本体の "{" トークン位置 → そこへ注入するメンバ宣言テキスト。
  classMemberInjections: Map<number, string[]>;
}

// ---------------------------------------------------------------------
// トップレベルクラスのスキャン
// ---------------------------------------------------------------------

export interface ClassInfo {
  name: string;
  // extends 句が単純な識別子ならその名前。extends 無しは null。
  baseName: string | null;
  // extends 句が単純な識別子でない（mixin 呼び出し等）→ 継承鎖を静的に辿れない。
  opaqueHeritage: boolean;
  bodyStart: number; // "{" のトークンインデックス
  bodyEnd: number; // 対応する "}" のトークンインデックス
  // クラス本体に static ブロック / 初期化式つき static フィールドがある
  // （クラス宣言文の評価時に任意コードが走る）→ バリア扱いにする。
  staticHazard: boolean;
}

const isTrivia = (t: Token): boolean => t.type === "whitespace" || t.type === "comment";

function nextSig(tokens: Token[], i: number): number {
  let j = i;
  while (j < tokens.length && isTrivia(tokens[j])) j++;
  return j;
}

// openIdx（"{"）に対応する "}" のインデックスを返す。見つからなければ末尾。
export function matchBrace(tokens: Token[], openIdx: number): number {
  let depth = 0;
  for (let j = openIdx; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.type !== "punct") continue;
    if (t.text === "{") depth++;
    else if (t.text === "}") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return tokens.length - 1;
}

// fromIdx から「ブレース/パーレン/角括弧すべて深さ0」の ";" までスキャンして
// そのインデックスを返す（";" 自体の位置。見つからなければ末尾）。
function scanToStatementEnd(tokens: Token[], fromIdx: number): number {
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  for (let j = fromIdx; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.type !== "punct") continue;
    if (t.text === "{") brace++;
    else if (t.text === "}") brace--;
    else if (t.text === "(") paren++;
    else if (t.text === ")") paren--;
    else if (t.text === "[") bracket++;
    else if (t.text === "]") bracket--;
    else if (t.text === ";" && brace === 0 && paren === 0 && bracket === 0) return j;
  }
  return tokens.length - 1;
}

// クラス本体（bodyStart..bodyEnd）の直下メンバに「宣言評価時にコードが走る」
// static 初期化があるかを判定する。static メソッド・アクセサ・引数なしの
// `static x;` は該当しない。
function detectStaticHazard(tokens: Token[], bodyStart: number, bodyEnd: number): boolean {
  let depth = 0;
  for (let j = bodyStart; j <= bodyEnd; j++) {
    const t = tokens[j];
    if (t.type === "punct") {
      if (t.text === "{") depth++;
      else if (t.text === "}") depth--;
      continue;
    }
    if (depth !== 1) continue;
    if (t.type === "ident" && t.text === "static") {
      let k = nextSig(tokens, j + 1);
      if (tokens[k]?.type === "punct" && tokens[k].text === "{") return true; // static ブロック
      // 修飾子・名前を読み飛ばし、最初に出会う記号で分類する:
      //   "(" → メソッド（無害） / "=" → 初期化式つきフィールド（バリア） /
      //   ";" → 初期化なしフィールド（無害） / それ以外 → 保守的にバリア
      while (k <= bodyEnd) {
        const u = tokens[k];
        if (u.type === "punct") {
          if (u.text === "(") break; // メソッド
          if (u.text === "<") {
            // ジェネリクスメソッドの型パラメータ → "(" が続くはず。無害側に倒す。
            break;
          }
          if (u.text === "=") return true;
          if (u.text === ";") break;
          if (u.text === ":") {
            // 型注釈。この後の "=" を探し続ける。
            k = nextSig(tokens, k + 1);
            continue;
          }
          return true; // 想定外の記号 → 保守的にバリア
        }
        k = nextSig(tokens, k + 1);
      }
    }
  }
  return false;
}

// トップレベル（ブレース深さ0）の `class Name [extends Base]` 宣言を収集する。
export function collectTopLevelClasses(tokens: Token[]): Map<string, ClassInfo> {
  const classes = new Map<string, ClassInfo>();
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "punct") {
      if (t.text === "{") depth++;
      else if (t.text === "}") depth--;
      continue;
    }
    if (depth !== 0) continue;
    if (t.type !== "ident" || t.text !== "class") continue;
    const nameIdx = nextSig(tokens, i + 1);
    const nameTok = tokens[nameIdx];
    if (nameTok?.type !== "ident") continue; // クラス式など。名前が無ければ対象外。
    // ヘッダ（型パラメータ・extends/implements 句）を "{" まで走査する。
    let baseName: string | null = null;
    let opaqueHeritage = false;
    let angle = 0;
    let paren = 0;
    let j = nameIdx + 1;
    for (; j < tokens.length; j++) {
      const u = tokens[j];
      if (u.type === "punct") {
        if (u.text === "<") angle++;
        else if (u.text === ">") angle = Math.max(0, angle - 1);
        else if (u.text === "(") paren++;
        else if (u.text === ")") paren--;
        else if (u.text === "{" && angle === 0 && paren === 0) break;
        continue;
      }
      if (u.type === "ident" && u.text === "extends" && angle === 0 && paren === 0) {
        const bIdx = nextSig(tokens, j + 1);
        const bTok = tokens[bIdx];
        if (bTok?.type === "ident") {
          // 単純な識別子か（直後が呼び出し "(" や "." なら mixin/式 → opaque）。
          const afterIdx = nextSig(tokens, bIdx + 1);
          const after = tokens[afterIdx];
          if (after?.type === "punct" && (after.text === "(" || after.text === ".")) {
            opaqueHeritage = true;
          } else {
            baseName = bTok.text;
          }
        } else {
          opaqueHeritage = true;
        }
      }
    }
    if (j >= tokens.length) continue;
    const bodyStart = j;
    const bodyEnd = matchBrace(tokens, bodyStart);
    classes.set(nameTok.text, {
      name: nameTok.text,
      baseName,
      opaqueHeritage,
      bodyStart,
      bodyEnd,
      staticHazard: detectStaticHazard(tokens, bodyStart, bodyEnd),
    });
    i = bodyEnd; // 本体をスキップ（depth はカウントしていないので手動で飛ばす）
  }
  return classes;
}


// tokenPos がトップレベルクラス本体の「直下」（相対深さ1）にある場合、そのクラス名を
// 返す（injectable / クラススコープ configuration の囲みクラス特定に使う。メソッド内の
// ネストクラス由来を外側クラスへ誤帰属させない）。
export function enclosingTopLevelClass(
  tokens: Token[],
  classes: Map<string, ClassInfo>,
  pos: number
): string | null {
  for (const info of classes.values()) {
    if (pos > info.bodyStart && pos < info.bodyEnd) {
      let depth = 0;
      for (let j = info.bodyStart; j < pos; j++) {
        const u = tokens[j];
        if (u.type !== "punct") continue;
        if (u.text === "{") depth++;
        else if (u.text === "}") depth--;
      }
      return depth === 1 ? info.name : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// バリア（最初の実行可能なトップレベル文）の検出
// ---------------------------------------------------------------------

// dison ノードのソース上の終端トークンインデックスを求める。
function disonNodeEnd(tokens: Token[], node: Node): number {
  const pos = (node as { tokenPos?: number }).tokenPos!;
  switch (node.kind) {
    case "configuration": {
      // "configuration [Name] { ... }" → 本体 "{" を探して対応 "}" まで。
      let j = pos;
      while (j < tokens.length && !(tokens[j].type === "punct" && tokens[j].text === "{")) j++;
      return matchBrace(tokens, j);
    }
    case "standalone-override": {
      // "override Name { ... }" → 本体 "{" の対応 "}" まで。
      let j = pos;
      while (j < tokens.length && !(tokens[j].type === "punct" && tokens[j].text === "{")) j++;
      return matchBrace(tokens, j);
    }
    case "activate":
    case "standalone-bind":
    case "token":
    case "injectable":
      return scanToStatementEnd(tokens, pos);
    default:
      return pos;
  }
}

// const/let/var 宣言の初期化式が「評価してもコードが走らない」形か
// （リテラル・識別子参照・オブジェクト/配列リテラルのみ。呼び出し "(",
// "new"、埋め込み付きテンプレートを含まない）。
function isInertInitializer(tokens: Token[], fromIdx: number, endIdx: number): boolean {
  for (let j = fromIdx; j < endIdx; j++) {
    const t = tokens[j];
    if (t.type === "ident" && t.text === "new") return false;
    if (t.type === "punct" && t.text === "(") return false;
    if (t.type === "string" && t.text.startsWith("`") && t.text.includes("${")) return false;
  }
  return true;
}

// トークン列をトップレベルで走査し、最初の「実行可能な文」（バリア）の
// トークンインデックスを返す。見つからなければ Infinity。
// dison ノード（配線文・宣言）は disonStarts でスキップ・分類する。
export function findFirstBarrier(
  tokens: Token[],
  classes: Map<string, ClassInfo>,
  disonStarts: Map<number, Node>
): number {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === "eof") break;
    if (isTrivia(t)) {
      i++;
      continue;
    }

    // dison ノード → 配線または宣言。バリアではないのでスキップ。
    const dn = disonStarts.get(i);
    if (dn !== undefined) {
      i = disonNodeEnd(tokens, dn) + 1;
      continue;
    }

    if (t.type === "punct" && t.text === ";") {
      i++;
      continue;
    }

    if (t.type === "ident" || t.type === "keyword") {
      const w = t.text;
      if (w === "import") {
        i = scanToStatementEnd(tokens, i) + 1;
        continue;
      }
      if (w === "export") {
        const k = nextSig(tokens, i + 1);
        if (tokens[k]?.type === "ident" && tokens[k].text === "default") return i; // export default <式> → バリア
        i = k; // 続きを分類
        continue;
      }
      if (w === "abstract") {
        i = nextSig(tokens, i + 1); // "abstract class ..." → class の分類へ
        continue;
      }
      if (w === "class") {
        const nameIdx = nextSig(tokens, i + 1);
        const nameTok = tokens[nameIdx];
        if (nameTok?.type !== "ident") return i; // クラス式相当 → バリア
        const info = classes.get(nameTok.text);
        if (info === undefined) return i; // スキャンと不整合 → 保守的にバリア
        if (info.staticHazard) return i; // static 初期化があるクラス宣言 → バリア
        i = info.bodyEnd + 1;
        continue;
      }
      if (w === "interface") {
        let j = nextSig(tokens, i + 1);
        while (j < tokens.length && !(tokens[j].type === "punct" && tokens[j].text === "{")) j++;
        i = matchBrace(tokens, j) + 1;
        continue;
      }
      if (w === "type") {
        const k = nextSig(tokens, i + 1);
        if (tokens[k]?.type === "ident") {
          i = scanToStatementEnd(tokens, i) + 1;
          continue;
        }
        return i;
      }
      if (w === "function" || w === "async") {
        let j = i;
        if (w === "async") {
          const k = nextSig(tokens, j + 1);
          if (!(tokens[k]?.type === "ident" && tokens[k].text === "function")) return i; // async 即時呼び出し等 → バリア
          j = k;
        }
        // "function [*] name (...) [: type] { ... }" → 本体をスキップ
        while (j < tokens.length && !(tokens[j].type === "punct" && tokens[j].text === "{")) j++;
        i = matchBrace(tokens, j) + 1;
        continue;
      }
      if (w === "enum") {
        let j = nextSig(tokens, i + 1);
        while (j < tokens.length && !(tokens[j].type === "punct" && tokens[j].text === "{")) j++;
        i = matchBrace(tokens, j) + 1;
        continue;
      }
      if (w === "const" || w === "let" || w === "var") {
        const k = nextSig(tokens, i + 1);
        if (tokens[k]?.type === "ident" && tokens[k].text === "enum") {
          let j = k;
          while (j < tokens.length && !(tokens[j].type === "punct" && tokens[j].text === "{")) j++;
          i = matchBrace(tokens, j) + 1;
          continue;
        }
        const end = scanToStatementEnd(tokens, i);
        if (isInertInitializer(tokens, i, end)) {
          i = end + 1;
          continue;
        }
        return i;
      }
      return i; // その他の実行文（式文・if・for・await 等）→ バリア
    }

    return i; // 想定外のトークンで始まる文 → バリア
  }
  return Infinity;
}

// ---------------------------------------------------------------------
// 配線イベントと taint の収集
// ---------------------------------------------------------------------

interface WiringEvent {
  entry: ConfigEntry;
  pos: number; // ソース順（activate ならその activate 文の位置）
}

// キーの taint 理由（キー文字列 → 理由）。
type TaintMap = Map<string, string>;

// (クラス名, プロパティ) の override taint。"クラス名 プロパティ" → 理由。
const relKey = (cls: string, prop: string): string => `${cls} ${prop}`;

// ---------------------------------------------------------------------
// 勝者式の依存解析（strict regime 用）
// ---------------------------------------------------------------------

// 式を字句解析し、「解決時に評価してもよく、構築するクラスが列挙できる」形なら
// 構築クラス名（new の対象）を返す。呼び出し・アロー・埋め込みテンプレート等を
// 含む式は "opaque"（strict regime では畳まない）。
export function analyzeWinnerExpr(expr: string): { deps: string[] } | "opaque" {
  const tokens = new Lexer(expr).tokenize();
  const deps: string[] = [];
  const sig: Token[] = tokens.filter((t) => !isTrivia(t) && t.type !== "eof");
  for (let j = 0; j < sig.length; j++) {
    const t = sig[j];
    if (t.type === "ident" && (t.text === "await" || t.text === "yield")) return "opaque";
    if (t.type === "string" && t.text.startsWith("`") && t.text.includes("${")) return "opaque";
    if (t.type === "punct" && t.text === "=") {
      // "=>"（アロー）は保守的に opaque。単独の "=" も式中では想定外なので opaque。
      return "opaque";
    }
    if (t.type === "ident" && t.text === "new") {
      const n = sig[j + 1];
      if (n?.type !== "ident") return "opaque";
      deps.push(n.text);
      // new Ident の直後の "(" は許可（コンストラクタ呼び出し）。型引数 <...> を
      // 挟む場合もそのまま通す（中の型名は値評価されない）。
      continue;
    }
    if (t.type === "punct" && t.text === "(") {
      // 直前が「new の対象識別子」または型引数の閉じ ">" 以外の呼び出しは opaque。
      const prev = sig[j - 1];
      const prev2 = sig[j - 2];
      const isCtorCall =
        prev?.type === "ident" && prev2?.type === "ident" && prev2.text === "new";
      const isGenericCtorTail = prev?.type === "punct" && prev.text === ">";
      if (!isCtorCall && !isGenericCtorTail) return "opaque";
    }
  }
  return { deps };
}


// ---------------------------------------------------------------------
// L2: mention 解析（docs/static-resolution-design.md §2 フェーズ3）
// ---------------------------------------------------------------------
//
// L1 は「最初の実行可能文」以降の配線を一律に動的へ落としていた。L2 はバリア文を
// 「言及した識別子から到達できるクラス／キーの集合の使用」として扱い、無関係な
// キーの配線が実行文の後に来ることを許す（02-bind-and-generics の ChainConfig が
// 畳めるようになる）。健全性の根拠: クラスを構築するにはどこかのコードがその
// 識別子に言及しなければならず、値がどう受け渡されても「言及の推移閉包」を辿れば
// 構築されうるクラスをすべて覆える。例外はグローバルオブジェクト経由・eval・
// 動的 import・埋め込みテンプレート（字句解析が中身を丸呑みするため言及が見えない）・
// プロジェクト外の相対モジュール（このファイルを import し返してクラスを構築できる）
// で、これらを含む文は従来どおり「全キーのバリア」に落とす。

// 言及として数えない構文語（TS の文法キーワード・修飾子・プリミティブ型名）。
// 漏れがあっても「余計な識別子が言及扱いになる」だけで、解決できなければ何も
// 引き込まないため健全性には影響しない。
const MENTION_STOPLIST = new Set([
  "class", "function", "extends", "implements", "const", "let", "var", "new", "return",
  "if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue",
  "try", "catch", "finally", "throw", "typeof", "instanceof", "in", "of", "this", "super",
  "true", "false", "null", "undefined", "void", "delete", "yield", "await", "async",
  "static", "get", "set", "export", "import", "from", "as", "is", "keyof", "readonly",
  "public", "private", "protected", "abstract", "namespace", "declare", "satisfies",
  "interface", "type", "enum", "string", "number", "boolean", "any", "unknown", "never",
  "object", "symbol", "bigint",
]);

// 閉包に現れたら解析を諦める識別子（任意の値・コードへ到達できるため）。
export const DANGEROUS_GLOBALS = new Set(["globalThis", "window", "self", "eval", "Function"]);

// トークン範囲内の識別子言及を集める。
function collectIdents(tokens: Token[], from: number, to: number, out: Set<string>): void {
  for (let j = from; j <= to && j < tokens.length; j++) {
    const t = tokens[j];
    if (t.type === "ident" && !MENTION_STOPLIST.has(t.text)) out.add(t.text);
  }
}

// 式テキスト（override の値式など）の識別子言及を集める。
export function collectExprMentions(expr: string): Set<string> {
  const out = new Set<string>();
  const toks = new Lexer(expr).tokenize();
  collectIdents(toks, 0, toks.length - 1, out);
  return out;
}

export interface TopLevelBarrier {
  pos: number;
  // true: この文は解析不能（制御フロー・埋め込みテンプレート・動的 import 等）で、
  // すべてのキーのバリアとして扱う。universal バリア以降のバリアは収集しない
  // （以降の配線はすべてこのバリアで塞がれるため）。
  universal: boolean;
  mentions: Set<string>;
}

// トップレベルを1回走査して、(a) 実行可能文（バリア）の列と、(b) トップレベル宣言の
// 言及グラフ（名前 → その宣言本体が言及する識別子）を作る。宣言グラフは universal
// バリア以降も最後まで集める（それ以前のバリアの閉包が、後方巻き上げされた関数
// 宣言などを参照しうるため）。
export function analyzeTopLevel(
  tokens: Token[],
  classes: Map<string, ClassInfo>,
  disonStarts: Map<number, Node>
): { barriers: TopLevelBarrier[]; declMentions: Map<string, Set<string>> } {
  const barriers: TopLevelBarrier[] = [];
  const declMentions = new Map<string, Set<string>>();
  let universalSeen = false;

  const addDecl = (name: string, from: number, to: number): void => {
    let s = declMentions.get(name);
    if (s === undefined) {
      s = new Set();
      declMentions.set(name, s);
    }
    collectIdents(tokens, from, to, s);
  };

  const pushBarrier = (pos: number, universal: boolean, from: number, to: number): void => {
    if (universalSeen) return;
    const mentions = new Set<string>();
    if (!universal) collectIdents(tokens, from, to, mentions);
    barriers.push({ pos, universal, mentions });
    if (universal) universalSeen = true;
  };

  // 文の範囲に「言及が見えない実行コード」を含みうるトークンがあるか
  // （埋め込みテンプレート・動的 import）。あればその文は universal バリア。
  const hasHiddenCode = (from: number, to: number): boolean => {
    for (let j = from; j <= to && j < tokens.length; j++) {
      const t = tokens[j];
      if (t.type === "string" && t.text.startsWith("`") && t.text.includes("${")) return true;
      if (t.type === "ident" && t.text === "import") {
        const k = nextSig(tokens, j + 1);
        if (tokens[k]?.type === "punct" && tokens[k].text === "(") return true;
      }
    }
    return false;
  };

  // 単文（深さ0のブレースを含まず ";" で終わる）の終端を探す。ブレース文
  // （if/for/ブロック等）なら null（→ universal バリア）。
  const scanSimpleStatementEnd = (from: number): number | null => {
    let brace = 0;
    let paren = 0;
    let bracket = 0;
    for (let j = from; j < tokens.length; j++) {
      const t = tokens[j];
      if (t.type !== "punct") continue;
      if (t.text === "{") {
        if (paren === 0 && bracket === 0 && brace === 0) return null; // 文レベルのブロック
        brace++;
      } else if (t.text === "}") brace--;
      else if (t.text === "(") paren++;
      else if (t.text === ")") paren--;
      else if (t.text === "[") bracket++;
      else if (t.text === "]") bracket--;
      else if (t.text === ";" && brace === 0 && paren === 0 && bracket === 0) return j;
    }
    return null;
  };

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === "eof") break;
    if (isTrivia(t)) {
      i++;
      continue;
    }
    const dn = disonStarts.get(i);
    if (dn !== undefined) {
      i = disonNodeEnd(tokens, dn) + 1;
      continue;
    }
    if (t.type === "punct" && t.text === ";") {
      i++;
      continue;
    }
    if (t.type === "ident" || t.type === "keyword") {
      const w = t.text;
      if (w === "import") {
        i = scanToStatementEnd(tokens, i) + 1;
        continue;
      }
      if (w === "export") {
        const k = nextSig(tokens, i + 1);
        if (tokens[k]?.type === "ident" && tokens[k].text === "default") {
          pushBarrier(i, true, i, i); // export default <式> → universal
          i = scanToStatementEnd(tokens, i) + 1;
          continue;
        }
        i = k;
        continue;
      }
      if (w === "abstract") {
        i = nextSig(tokens, i + 1);
        continue;
      }
      if (w === "class") {
        const nameIdx = nextSig(tokens, i + 1);
        const nameTok = tokens[nameIdx];
        const info = nameTok?.type === "ident" ? classes.get(nameTok.text) : undefined;
        if (info === undefined) {
          pushBarrier(i, true, i, i); // クラス式・スキャン不整合 → universal
          i = scanToStatementEnd(tokens, i) + 1;
          continue;
        }
        addDecl(info.name, i, info.bodyEnd);
        if (info.staticHazard) pushBarrier(i, true, i, i); // static 初期化つき宣言 → universal
        i = info.bodyEnd + 1;
        continue;
      }
      if (w === "interface") {
        let j = nextSig(tokens, i + 1);
        while (j < tokens.length && !(tokens[j].type === "punct" && tokens[j].text === "{")) j++;
        i = matchBrace(tokens, j) + 1;
        continue;
      }
      if (w === "type") {
        const k = nextSig(tokens, i + 1);
        if (tokens[k]?.type === "ident") {
          i = scanToStatementEnd(tokens, i) + 1;
          continue;
        }
        pushBarrier(i, true, i, i);
        i = scanToStatementEnd(tokens, i) + 1;
        continue;
      }
      if (w === "function" || w === "async") {
        let j = i;
        if (w === "async") {
          const k = nextSig(tokens, j + 1);
          if (!(tokens[k]?.type === "ident" && tokens[k].text === "function")) {
            // async 即時実行など → 実行文として扱う（下の実行文分岐へ）
            const end = scanSimpleStatementEnd(i);
            if (end === null || hasHiddenCode(i, end)) {
              pushBarrier(i, true, i, i);
              i = end !== null ? end + 1 : matchBrace(tokens, (() => { let m = i; while (m < tokens.length && !(tokens[m].type === "punct" && tokens[m].text === "{")) m++; return m; })()) + 1;
            } else {
              pushBarrier(i, false, i, end);
              i = end + 1;
            }
            continue;
          }
          j = k;
        }
        // 関数宣言: 名前 → 本体言及（巻き上げにより後方からも参照される）
        const nameIdx = nextSig(tokens, j + 1);
        let nameEnd = nameIdx;
        if (tokens[nameIdx]?.type === "punct" && tokens[nameIdx].text === "*") nameEnd = nextSig(tokens, nameIdx + 1);
        while (j < tokens.length && !(tokens[j].type === "punct" && tokens[j].text === "{")) j++;
        const bodyEnd = matchBrace(tokens, j);
        if (tokens[nameEnd]?.type === "ident") addDecl(tokens[nameEnd].text, i, bodyEnd);
        i = bodyEnd + 1;
        continue;
      }
      if (w === "enum") {
        let j = nextSig(tokens, i + 1);
        while (j < tokens.length && !(tokens[j].type === "punct" && tokens[j].text === "{")) j++;
        i = matchBrace(tokens, j) + 1;
        continue;
      }
      if (w === "const" || w === "let" || w === "var") {
        const k = nextSig(tokens, i + 1);
        if (tokens[k]?.type === "ident" && tokens[k].text === "enum") {
          let j = k;
          while (j < tokens.length && !(tokens[j].type === "punct" && tokens[j].text === "{")) j++;
          i = matchBrace(tokens, j) + 1;
          continue;
        }
        const end = scanToStatementEnd(tokens, i);
        // 宣言された名前（と巻き添えの識別子）→ 文の言及。粗いが健全
        // （余計な対応は閉包を広げる方向にしか働かない）。
        {
          const names = new Set<string>();
          collectIdents(tokens, i, end, names);
          for (const n of names) addDecl(n, i, end);
        }
        if (!isInertInitializer(tokens, i, end)) {
          // 初期化式が実行コードを含む → mention バリア（言及は文全体）。
          pushBarrier(i, hasHiddenCode(i, end), i, end);
        }
        i = end + 1;
        continue;
      }
      // その他の実行文（式文・if・for・await 等）
      {
        const end = scanSimpleStatementEnd(i);
        if (end === null || hasHiddenCode(i, end === null ? i : end)) {
          pushBarrier(i, true, i, i);
          // 文の終端が取れない（ブロック文等）→ ブレースまで飛んで matchBrace で越える
          let m = i;
          while (m < tokens.length && !(tokens[m].type === "punct" && tokens[m].text === "{") && !(tokens[m].type === "punct" && tokens[m].text === ";")) m++;
          i = tokens[m]?.text === "{" ? matchBrace(tokens, m) + 1 : m + 1;
        } else {
          pushBarrier(i, false, i, end);
          i = end + 1;
        }
        continue;
      }
    }
    pushBarrier(i, true, i, i); // 想定外のトークン → universal
    i = scanToStatementEnd(tokens, i) + 1;
  }
  return { barriers, declMentions };
}


// 分岐したサブクラスへ注入するゲッターのテキスト（docs/subclass-getter-redeclaration.md §3）。
// バッキングフィールドはクラス別の一意名にする（基底と同名の private を派生で再宣言
// すると tsc が TS2415 にするため）。
export function renderInjectedGetter(
  node: Extract<Node, { kind: "injectable" }>,
  recvClass: string,
  d: WiringDecision,
  fallbackExpr: string
): string {
  const p = node.propName;
  const t = node.typeName;
  const f = `_${p}_${recvClass}`;
  if (d.kind === "static") {
    return [
      ``,
      `  private ${f}?: ${t};`,
      `  get ${p}(): ${t} {`,
      `    if (!this.${f}) {`,
      `      this.${f} = ${d.expr};`,
      `    }`,
      `    return this.${f}!;`,
      `  }`,
    ].join("\n");
  }
  return [
    ``,
    `  private readonly __dison_scope_${f} = __disonCurrentScope();`,
    `  private ${f}?: ${t};`,
    `  get ${p}(): ${t} {`,
    `    if (!this.${f}) {`,
    `      this.${f} = __disonResolveInjectable(this.__dison_scope_${f}, this.constructor, "${p}", () => ${fallbackExpr});`,
    `    }`,
    `    return this.${f}!;`,
    `  }`,
  ].join("\n");
}

// dison ノードの開始位置マップ（バリア検出でスキップに使う）。
// token ノードは tokenPos を持たないが、トップレベル宣言で Symbol を作るだけ
// なのでバリアにならない。findFirstBarrier は "token" キーワードを知らないため、
// ここで開始位置を補う（AST 順に元トークン列から探す）。
export function buildDisonStarts(tokens: Token[], ast: Node[]): Map<number, Node> {
  const disonStarts = new Map<number, Node>();
  for (const node of ast) {
    // raw ノードも tokenPos を持つ（クラス本体への注入用）が、ここで登録するのは
    // DSL 構文のノードだけ。raw を入れると全トークンが「読み飛ばす対象」になり
    // バリア検出が機能しなくなる。
    if (node.kind === "raw") continue;
    const pos = (node as { tokenPos?: number }).tokenPos;
    if (pos !== undefined) disonStarts.set(pos, node);
  }
  let searchFrom = 0;
  for (const node of ast) {
    if (node.kind !== "token") continue;
    for (let j = searchFrom; j < tokens.length; j++) {
      if (tokens[j].type === "keyword" && tokens[j].text === "token") {
        const a = nextSig(tokens, j + 1);
        const b = nextSig(tokens, a + 1);
        if (
          tokens[a]?.type === "ident" &&
          tokens[a].text === node.name &&
          tokens[b]?.type === "punct" &&
          tokens[b].text === ";"
        ) {
          disonStarts.set(j, node);
          searchFrom = j + 1;
          break;
        }
      }
    }
  }
  return disonStarts;
}

// ---------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------

export function computeWiringTable(
  tokens: Token[],
  ast: Node[],
  strategy: KeyStrategy,
  isTopLevel: (idx: number) => boolean
): WiringTable {
  const classes = collectTopLevelClasses(tokens);

  const disonStarts = buildDisonStarts(tokens, ast);

  // L2 mention 解析（フェーズ3）: バリアを「言及の推移閉包が使いうるキーの集合」として
  // 扱い、無関係なキーの配線が実行文の後に来ることを許す。
  const { barriers, declMentions } = analyzeTopLevel(tokens, classes, disonStarts);
  const importsByLocalName = new Map(collectImportBindings(tokens).map((b) => [b.localName, b]));

  // 名前付きグローバル configuration の定義（activate 時にエントリ列を引く）。
  const namedConfigs = new Map<string, Extract<Node, { kind: "configuration" }>>();
  for (const node of ast) {
    if (node.kind === "configuration" && node.scope === "global" && node.name !== undefined) {
      namedConfigs.set(node.name, node);
    }
  }

  const injectables: { node: Extract<Node, { kind: "injectable" }>; className: string | null }[] = [];
  for (const node of ast) {
    if (node.kind !== "injectable") continue;
    const pos = node.tokenPos;
    const className = pos !== undefined ? enclosingTopLevelClass(tokens, classes, pos) : null;
    injectables.push({ node, className });
  }

  const injectablesByClass = new Map<string, Extract<Node, { kind: "injectable" }>[]>();
  for (const { node, className } of injectables) {
    if (className === null) continue;
    let arr = injectablesByClass.get(className);
    if (arr === undefined) {
      arr = [];
      injectablesByClass.set(className, arr);
    }
    arr.push(node);
  }

  // configuration の継承（docs/configuration-inheritance.md）: 解析は平坦化済みの
  // 実効エントリ列に対して行う。単一ファイルなので親はローカル宣言のみ解決できる
  // （解決できない親は無視 = そのエントリは見えない → 保守的に畳まない方向に働く）。
  const flattenLocal = (n: Extract<Node, { kind: "configuration" }>): ConfigEntry[] =>
    flattenConfiguration<undefined>(n, undefined, (name) => {
      const decl = namedConfigs.get(name);
      return decl !== undefined ? { node: decl, file: undefined } : undefined;
    }).entries.map((fe) => fe.entry);

  // 収集結果
  const events: WiringEvent[] = [];
  const keyTaint: TaintMap = new Map();
  const overrideTaint = new Map<string, string>(); // relKey → 理由
  const blanketPropTaint = new Map<string, string>(); // プロパティ名 → 理由（対象クラス不明の override）
  // strict regime（勝者式の解析可否＋推移的 taint。設計 §3.2）はローカルスコープの
  // 存在だけで発動する。クラススコープは als に乗らず、解決のたびに受け手自身の鎖の
  // フレームへ置き換えられるため（runtime.ts __disonResolveInjectable）、捕捉差を
  // 生まない＝strict regime を要求しない（L1.5）。
  let localScopesExist = false;
  let dynamicContextWiring = false;
  let postBarrierWiring = false;

  // L1.5: クラススコープ configuration はレキシカル（クラス本体に静的に結び付き、
  // 受け手の継承鎖のフレームだけが解決に効く）ので、taint ではなく勝者計算の層として
  // 参加させる。クラス名 → 定義順の configuration エントリ列。
  const classFramesByClass = new Map<string, ConfigEntry[][]>();

  const bindKeyOf = (e: BindEntry): string => keyExprFor(e.originalTypeKey, e.token, strategy);

  const chainNamesOf = (cls: string): { names: string[]; unknown: boolean } => {
    const names: string[] = [];
    let unknown = false;
    let cur: string | undefined = cls;
    const seen = new Set<string>();
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      names.push(cur);
      const info = classes.get(cur);
      if (info === undefined) break; // 未宣言（import 等）: 名前までは鎖に含める
      if (info.opaqueHeritage) {
        unknown = true;
        break;
      }
      cur = info.baseName ?? undefined;
    }
    return { names, unknown };
  };

  // override entry を taint として登録する（動的文脈・バリア後などの理由つき）。
  const taintOverrideEntry = (entry: OverrideEntry, reason: string): void => {
    const target = classes.get(entry.className);
    if (target === undefined || target.opaqueHeritage) {
      // 対象が未宣言 or 継承鎖不明 → プロパティ名で全クラスを taint（設計 §3.2）。
      for (const a of entry.assignments) {
        if (!blanketPropTaint.has(a.prop)) blanketPropTaint.set(a.prop, reason);
      }
      return;
    }
    // 対象の祖先・子孫いずれのゲッターにも効きうるため、両方向の関係クラスを taint。
    const related = new Set<string>(chainNamesOf(entry.className).names);
    for (const name of classes.keys()) {
      if (chainNamesOf(name).names.includes(entry.className)) related.add(name);
    }
    for (const cls of related) {
      for (const a of entry.assignments) {
        const k = relKey(cls, a.prop);
        if (!overrideTaint.has(k)) overrideTaint.set(k, reason);
      }
    }
  };

  const taintEntries = (entries: ConfigEntry[], reason: string): void => {
    for (const e of entries) {
      if (e.kind === "bind") {
        const k = bindKeyOf(e);
        if (!keyTaint.has(k)) keyTaint.set(k, reason);
      } else {
        taintOverrideEntry(e, reason);
      }
    }
  };

  // ---------------------------------------------------------------
  // L2: バリアごとの「使いうるキー／(クラス,プロパティ)」の閉包計算
  // ---------------------------------------------------------------
  // 言及識別子から出発し、(a) トップレベル宣言の言及、(b) 閉包内クラスの継承鎖の
  // injectable が持つキーと override 対、(c) それらのキーへの bind の差し替え先、
  // (d) 該当する override の値式の言及、を不動点まで辿る。危険な識別子
  // （グローバルオブジェクト・eval・プロジェクト外の相対 import 束縛）に触れたら
  // universal に落とす。
  const allBinds: BindEntry[] = [];
  const allOverrides: OverrideEntry[] = [];
  for (const node of ast) {
    const entries: ConfigEntry[] =
      node.kind === "configuration"
        ? node.extendsNames === undefined
          ? node.entries
          : flattenLocal(node)
        : node.kind === "standalone-bind" || node.kind === "standalone-override"
        ? [node.entry]
        : [];
    for (const e of entries) {
      if (e.kind === "bind") allBinds.push(e);
      else allOverrides.push(e);
    }
  }

  interface BarrierUse {
    universal: boolean;
    keys: Set<string>;
    pairs: Set<string>; // relKey(クラス名, prop)
  }

  const computeBarrierUse = (b: TopLevelBarrier): BarrierUse => {
    if (b.universal) return { universal: true, keys: new Set(), pairs: new Set() };
    const keys = new Set<string>();
    const pairs = new Set<string>();
    const seenIdents = new Set<string>();
    const seenClasses = new Set<string>();
    const pulledBinds = new Set<BindEntry>();
    const pulledOverrides = new Set<OverrideEntry>();
    const identQueue: string[] = [...b.mentions];
    let universal = false;

    const enqueue = (id: string): void => {
      if (!seenIdents.has(id)) identQueue.push(id);
    };

    let progress = true;
    while (progress && !universal) {
      progress = false;
      while (identQueue.length > 0 && !universal) {
        const id = identQueue.pop()!;
        if (seenIdents.has(id)) continue;
        seenIdents.add(id);
        progress = true;
        if (DANGEROUS_GLOBALS.has(id)) {
          universal = true;
          break;
        }
        const imp = importsByLocalName.get(id);
        if (imp !== undefined && imp.specifier.startsWith(".")) {
          // プロジェクト外の相対モジュールの束縛: そのモジュールはこのファイル
          // （生成物）を import し返してクラスを構築できるため解析不能。
          universal = true;
          break;
        }
        const dm = declMentions.get(id);
        if (dm !== undefined) for (const m of dm) enqueue(m);
        if (classes.has(id) && !seenClasses.has(id)) {
          seenClasses.add(id);
          const chain = chainNamesOf(id);
          if (chain.unknown) {
            universal = true;
            break;
          }
          for (const X of chain.names) {
            for (const inj of injectablesByClass.get(X) ?? []) {
              if (isSimpleTypeShape(inj.typeKey)) {
                keys.add(keyExprFor(inj.typeKey, inj.token, strategy));
              }
              for (const Y of chain.names) pairs.add(relKey(Y, inj.propName));
            }
          }
        }
      }
      if (universal) break;
      for (const be of allBinds) {
        if (pulledBinds.has(be)) continue;
        if (!keys.has(bindKeyOf(be))) continue;
        pulledBinds.add(be);
        progress = true;
        enqueue(baseIdentifierOf(be.replacementTypeKey));
        keys.add(keyExprFor(be.replacementTypeKey, undefined, strategy)); // チェーン継続キー
      }
      for (const oe of allOverrides) {
        if (pulledOverrides.has(oe)) continue;
        let hit = false;
        for (const a of oe.assignments) if (pairs.has(relKey(oe.className, a.prop))) hit = true;
        if (!hit) continue;
        pulledOverrides.add(oe);
        progress = true;
        for (const a of oe.assignments) for (const m of collectExprMentions(a.valueExpr)) enqueue(m);
      }
    }
    return universal ? { universal: true, keys: new Set(), pairs: new Set() } : { universal: false, keys, pairs };
  };

  const barrierUses: BarrierUse[] = barriers.map(computeBarrierUse);

  // pos より前のバリアがキー K を使いうるなら、その理由を返す（使わなければ null）。
  const bindBlockedBy = (key: string, pos: number): string | null => {
    for (let bi = 0; bi < barriers.length; bi++) {
      if (barriers[bi].pos >= pos) break;
      const u = barrierUses[bi];
      if (u.universal) return "wired after executable top-level code";
      if (u.keys.has(key)) return "wired after an executable statement that may resolve this key";
    }
    return null;
  };
  const overrideBlockedBy = (entry: OverrideEntry, pos: number): string | null => {
    for (let bi = 0; bi < barriers.length; bi++) {
      if (barriers[bi].pos >= pos) break;
      const u = barrierUses[bi];
      if (u.universal) return "wired after executable top-level code";
      for (const a of entry.assignments) {
        if (u.pairs.has(relKey(entry.className, a.prop))) {
          return "wired after an executable statement that may resolve this property";
        }
      }
    }
    return null;
  };

  // エントリ単位で「先行バリアに塞がれていなければイベント、塞がれていれば taint」。
  const emitEntries = (entries: ConfigEntry[], pos: number, blockedSuffix: string): void => {
    for (const entry of entries) {
      const blocked = entry.kind === "bind" ? bindBlockedBy(bindKeyOf(entry), pos) : overrideBlockedBy(entry, pos);
      if (blocked === null) {
        events.push({ entry, pos });
      } else {
        postBarrierWiring = true;
        taintEntries([entry], blocked + blockedSuffix);
      }
    }
  };

  for (const node of ast) {
    const pos = (node as { tokenPos?: number }).tokenPos ?? 0;
    if (node.kind === "configuration") {
      const effective = node.extendsNames === undefined ? node.entries : flattenLocal(node);
      if (node.scope === "local") {
        localScopesExist = true;
        taintEntries(effective, "bound in a local scope");
      } else if (node.scope === "class") {
        // L1.5: 囲みクラスが特定できればフレームとして勝者計算に参加させる。
        // 特定できない（関数内のネストクラス等）場合は従来どおり保守的に taint。
        const encl = enclosingTopLevelClass(tokens, classes, pos);
        if (encl !== null) {
          let arr = classFramesByClass.get(encl);
          if (arr === undefined) {
            arr = [];
            classFramesByClass.set(encl, arr);
          }
          arr.push(effective);
          // 対象クラスが未宣言/継承鎖不明の override エントリは、未知のサブクラス
          // 関係を静的に否定できないため従来どおりブランケット taint に落とす。
          for (const e of effective) {
            if (e.kind !== "override") continue;
            const t = classes.get(e.className);
            if (t === undefined || t.opaqueHeritage) {
              taintOverrideEntry(e, "class-scope override targets a class whose hierarchy is not statically analyzable");
            }
          }
        } else {
          taintEntries(effective, "bound in a class scope of a non-top-level class");
        }
      } else if (node.name === undefined) {
        // 無名グローバル: その位置で登録される。先行バリアが使いうるキーだけ動的に落とす。
        emitEntries(effective, pos, "");
      }
      // 名前付きグローバルの定義自体はイベントではない（activate が担う）。
    } else if (node.kind === "activate") {
      if (node.fromPath !== undefined) continue; // 単一ファイルでは外部レジストリ行き（効果なし）
      const cfg = namedConfigs.get(node.name);
      if (cfg === undefined) continue; // import された configuration → 外部レジストリ行き
      const cfgEntries = flattenLocal(cfg);
      if (!isTopLevel(pos)) {
        dynamicContextWiring = true;
        taintEntries(cfgEntries, "activated inside a function or conditional");
      } else {
        emitEntries(cfgEntries, pos, " (before this activate)");
      }
    } else if (node.kind === "standalone-override" || node.kind === "standalone-bind") {
      const entry = node.kind === "standalone-override" ? node.entry : node.entry;
      if (!isTopLevel(pos)) {
        dynamicContextWiring = true;
        taintEntries([entry], "wired inside a function");
      } else {
        emitEntries([entry], pos, "");
      }
    }
  }

  // 最終配線状態（プレバリアのイベントのみ・後勝ち）。
  const bindMap = new Map<string, BindEntry>();
  const overrideMap = new Map<string, Map<string, string>>(); // クラス名 → prop → 値式
  for (const ev of events) {
    if (ev.entry.kind === "bind") {
      bindMap.set(bindKeyOf(ev.entry), ev.entry);
    } else {
      let m = overrideMap.get(ev.entry.className);
      if (m === undefined) {
        m = new Map();
        overrideMap.set(ev.entry.className, m);
      }
      for (const a of ev.entry.assignments) m.set(a.prop, a.valueExpr);
    }
  }

  // ---------------------------------------------------------------
  // injectable ごとの判定
  // ---------------------------------------------------------------

  const decisions = new Map<Node, WiringDecision>();
  const depsOf = new Map<Node, string[]>(); // static 判定の勝者式が構築するクラス（strict regime 用）

  // L1.5: chain(C) のフレーム列（実行時の消費順 = 子→親、同一クラス内は定義の逆順。
  // runtime.ts __disonClassScopes と同じ順序）。
  const frameSeq = (chainNames: string[]): ConfigEntry[][] => {
    const out: ConfigEntry[][] = [];
    for (const cls of chainNames) {
      const cfgs = classFramesByClass.get(cls);
      if (cfgs === undefined) continue;
      for (let i = cfgs.length - 1; i >= 0; i--) out.push(cfgs[i]);
    }
    return out;
  };
  // フレーム層の override 照合（getOverride と同じ: フレーム順に、フレーム内では
  // 受け手チェイン順の child-wins。同一フレーム内の同一 (対象, prop) は後勝ち）。
  const frameOverrideWinner = (
    chainNames: string[],
    prop: string
  ): { expr: string; owner: string } | undefined => {
    for (const frame of frameSeq(chainNames)) {
      for (const cls of chainNames) {
        let last: string | undefined;
        for (const e of frame) {
          if (e.kind !== "override" || e.className !== cls) continue;
          for (const a of e.assignments) if (a.prop === prop) last = a.valueExpr;
        }
        if (last !== undefined) return { expr: last, owner: cls };
      }
    }
    return undefined;
  };
  // フレーム層の bind 照合（__disonLookupBind と同じ: フレーム順に、フレーム内は後勝ち）。
  const frameBindLookup = (chainNames: string[], key: string): BindEntry | undefined => {
    for (const frame of frameSeq(chainNames)) {
      let last: BindEntry | undefined;
      for (const e of frame) {
        if (e.kind === "bind" && bindKeyOf(e) === key) last = e;
      }
      if (last !== undefined) return last;
    }
    return undefined;
  };

  // 受け手クラス recv ごとに勝者を決める（docs/subclass-getter-redeclaration.md §2）。
  // className は injectable が宣言されたクラス、recv は解決の受け手（= 自身または子孫）。
  const decideFor = (
    node: Extract<Node, { kind: "injectable" }>,
    className: string | null,
    recv: string
  ): WiringDecision => {
    {
      if (className === null) {
        return { kind: "dynamic", reason: "enclosing class is not a top-level class declaration" };
      }
      const chain = chainNamesOf(recv);
      if (chain.unknown) {
        return { kind: "dynamic", reason: "class heritage is not statically analyzable (mixin or expression in extends)" };
      }
      // blanket taint（対象クラス不明の override があるプロパティ）
      const blanket = blanketPropTaint.get(node.propName);
      if (blanket !== undefined) {
        return { kind: "dynamic", reason: blanket };
      }
      // override taint（継承関係クラス × 同名プロパティが動的文脈で配線されうる）
      for (const cls of chain.names) {
        const t = overrideTaint.get(relKey(cls, node.propName));
        if (t !== undefined) return { kind: "dynamic", reason: t };
      }
      const rk = overrideTaint.get(relKey(className, node.propName));
      if (rk !== undefined) return { kind: "dynamic", reason: rk };

      // override 勝者: クラスフレーム層（scope-major: グローバルより優先。L1.5）
      const fw = frameOverrideWinner(chain.names, node.propName);
      if (fw !== undefined) {
        return { kind: "static", expr: `(${fw.expr})`, why: `class-scope override ${fw.owner}` };
      }
      // override 勝者（child-wins: チェインの手前ほど優先）
      for (const cls of chain.names) {
        const m = overrideMap.get(cls);
        const v = m?.get(node.propName);
        if (v !== undefined) {
          return {
            kind: "static",
            expr: `(${v})`,
            why: `override ${cls} (top-level wiring)`,
          };
        }
      }

      // bind 勝者（チェイン終端まで辿る。#5: 引数は終端のみ有効）。
      // codegen は simpleShape のときだけ resolveType（bind 参加）を出すので、
      // ここでも同じ条件でのみ bind を照合する（非単純型は override か既定式のみ）。
      const selfKey = keyExprFor(node.typeKey, node.token, strategy);
      if (isSimpleTypeShape(node.typeKey)) {
        const kt = keyTaint.get(selfKey);
        if (kt !== undefined) return { kind: "dynamic", reason: kt };
        // ホップ毎に「クラスフレーム層 → グローバル層」の順で照合する（L1.5。
        // __dison_classScopeCtx は解決の間セットされ続けるため、チェーンの再帰も
        // 受け手のフレームを見る——runtime.ts __disonLookupBind と同じ規則）。
        const hopLookup = (key: string): { entry: BindEntry; fromFrame: boolean } | undefined => {
          const fb = frameBindLookup(chain.names, key);
          if (fb !== undefined) return { entry: fb, fromFrame: true };
          const gb = bindMap.get(key);
          return gb !== undefined ? { entry: gb, fromFrame: false } : undefined;
        };
        let hop = hopLookup(selfKey);
        if (hop !== undefined) {
          let usedFrame = hop.fromFrame;
          let chained = false;
          const visited = new Set<string>([selfKey]);
          while (true) {
            const nextKey = keyExprFor(hop.entry.replacementTypeKey, undefined, strategy);
            if (visited.has(nextKey)) {
              return { kind: "dynamic", reason: "bind chain contains a cycle (kept dynamic so the runtime error surfaces)" };
            }
            const kt2 = keyTaint.get(nextKey);
            if (kt2 !== undefined) return { kind: "dynamic", reason: `chained through a key that is ${kt2}` };
            const nxt = hopLookup(nextKey);
            if (nxt === undefined) break;
            visited.add(nextKey);
            hop = nxt;
            usedFrame ||= nxt.fromFrame;
            chained = true;
          }
          return {
            kind: "static",
            expr: `new ${hop.entry.replacementTypeName}(${hop.entry.replacementArgs ?? ""})`,
            why: `bind ${node.typeKey} (${usedFrame ? "class-scope wiring" : "top-level wiring"}${chained ? ", chained" : ""})`,
          };
        }
      }

      // 配線なし → 既定初期化式（L0）
      return {
        kind: "static",
        expr: node.defaultExpr !== undefined ? `(${node.defaultExpr})` : `new ${node.typeName}()`,
        why: node.defaultExpr !== undefined ? "no wiring (default initializer)" : "no wiring (auto-constructed)",
      };
    }
  };

  // --- 受け手クラスごとの判定（サブクラス別ゲッター再宣言。§2）---------------
  // decisionAt: injectable ノード → 受け手クラス名 → 判定。
  const decisionAt = new Map<Node, Map<string, WiringDecision>>();
  const depsAt = new Map<string, string[]>();
  const depsKey = (node: Node, recv: string): string => `${injectables.findIndex((i) => i.node === node)}|${recv}`;

  // root を継承する全クラス（root 自身を含む）。
  const subtreeOf = (root: string): string[] => {
    const out = [root];
    for (const name of classes.keys()) {
      if (name === root) continue;
      const c = chainNamesOf(name);
      if (!c.unknown && c.names.includes(root)) out.push(name);
    }
    return out;
  };

  // super.<prop> がソース中に現れるか（§4.1 のガード）。現れる場合、その
  // プロパティは再宣言してはならない（super が基底のゲッターを呼ぶようになり、
  // 受け手の勝者を返す現行挙動と食い違う）。
  const superProps = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!(t.type === "ident" && t.text === "super")) continue;
    const dot = nextSig(tokens, i + 1);
    if (!(tokens[dot]?.type === "punct" && tokens[dot].text === ".")) continue;
    const prop = nextSig(tokens, dot + 1);
    if (tokens[prop]?.type === "ident") superProps.add(tokens[prop].text);
  }

  for (const { node, className } of injectables) {
    const recvs = className === null ? ["<none>"] : subtreeOf(className);
    const m = new Map<string, WiringDecision>();
    for (const recv of recvs) {
      let d = decideFor(node, className, recv);
      if (d.kind === "static" && localScopesExist) {
        const analyzed = analyzeWinnerExpr(d.expr);
        if (analyzed === "opaque") {
          d = {
            kind: "dynamic",
            reason: "winner expression is not analyzable under scoped configurations in this file",
          };
        } else {
          depsAt.set(depsKey(node, recv), analyzed.deps);
        }
      }
      m.set(recv, d);
    }
    decisionAt.set(node, m);
  }

  // 推移的 taint の不動点（strict regime のみ。設計 §3.2）:
  // 勝者式が構築するクラス T の injectable（受け手 T で解決したもの）が dynamic なら、
  // このゲッターも dynamic に降格する（構築時スコープ捕捉の差が観測されうるため）。
  if (localScopesExist) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const { node } of injectables) {
        for (const [recv, d] of decisionAt.get(node)!) {
          if (d.kind !== "static") continue;
          for (const dep of depsAt.get(depsKey(node, recv)) ?? []) {
            if (!classes.has(dep)) continue; // 未宣言（import 等）は別モジュールの解決系
            let demoted: WiringDecision | undefined;
            for (const cls of chainNamesOf(dep).names) {
              for (const m of injectablesByClass.get(cls) ?? []) {
                // 構築されるのは dep なので、受け手は dep として引く。
                const md = decisionAt.get(m)?.get(dep) ?? decisionAt.get(m)?.get(cls);
                if (md !== undefined && md.kind === "dynamic") {
                  demoted = {
                    kind: "dynamic",
                    reason: `depends on ${dep} whose injectable "${m.propName}" is dynamic`,
                  };
                }
              }
            }
            if (demoted !== undefined) {
              decisionAt.get(node)!.set(recv, demoted);
              changed = true;
              break;
            }
          }
        }
      }
    }
  }

  // --- 宣言クラスの判定と、分岐するサブクラスへの再宣言 ---------------------
  const sameDecision = (a: WiringDecision, b: WiringDecision): boolean =>
    a.kind === "dynamic" ? b.kind === "dynamic" : b.kind === "static" && a.expr === b.expr;

  // 動的形の fallback（codegen.generateInjectable と同じ規則）。
  const fallbackExprOf = (node: Extract<Node, { kind: "injectable" }>): string => {
    const finalDefault =
      node.defaultExpr !== undefined ? `(${node.defaultExpr})` : `new ${node.typeName}()`;
    return isSimpleTypeShape(node.typeKey)
      ? `resolveType(${keyExprFor(node.typeKey, node.token, strategy)}, () => ${finalDefault})`
      : finalDefault;
  };

  const classMemberInjections = new Map<number, string[]>();
  // レポート用: 実際に注入した (宣言ノード → [受け手クラス, 判定]) の記録。
  const injectedFor = new Map<Node, { recv: string; d: WiringDecision }[]>();
  const addInjection = (cls: string, text: string): void => {
    const info = classes.get(cls);
    if (info === undefined) return;
    const arr = classMemberInjections.get(info.bodyStart) ?? [];
    arr.push(text);
    classMemberInjections.set(info.bodyStart, arr);
  };

  for (const { node, className } of injectables) {
    const byRecv = decisionAt.get(node)!;
    if (className === null) {
      decisions.set(node, byRecv.get("<none>")!);
      continue;
    }
    const own = byRecv.get(className)!;
    const diverging = [...byRecv].filter(
      ([recv]) => recv !== className && !sameDecision(byRecv.get(recv)!, byRecv.get(classes.get(recv)?.baseName ?? className)!)
    );
    if (diverging.length > 0 && superProps.has(node.propName)) {
      // §4.1: super.<prop> があると再宣言は挙動を変える。従来どおり単一ゲッターを
      // 動的に落とす（受け手ごとの解決はランタイムが行う）。
      decisions.set(node, {
        kind: "dynamic",
        reason: `subtree winners diverge, and "super.${node.propName}" is used (a re-declared getter would change what super returns)`,
      });
      continue;
    }
    decisions.set(node, own);
    for (const [recv, d] of diverging) {
      addInjection(recv, renderInjectedGetter(node, recv, d, fallbackExprOf(node)));
      const arr = injectedFor.get(node) ?? [];
      arr.push({ recv, d });
      injectedFor.set(node, arr);
    }
  }

  // ---------------------------------------------------------------
  // needsRuntime とレポート
  // ---------------------------------------------------------------

  let anyDynamic = false;
  for (const d of decisions.values()) if (d.kind === "dynamic") anyDynamic = true;

  const needsRuntime = anyDynamic || localScopesExist || dynamicContextWiring || postBarrierWiring;

  const report: string[] = [];
  const line = (site: string, d: WiringDecision): string =>
    d.kind === "static"
      ? `${site.padEnd(24)} → ${d.expr.padEnd(28)} [static: ${d.why}]`
      : `${site.padEnd(24)} → ${"runtime lookup".padEnd(28)} [dynamic: ${d.reason}]`;
  for (const { node, className } of injectables) {
    report.push(line(`${className ?? "?"}.${node.propName}`, decisions.get(node)!));
    // 再宣言したサブクラスは親の下にぶら下げて表示する（§7）。
    for (const { recv, d } of injectedFor.get(node) ?? []) {
      report.push(line(`  └ ${recv}.${node.propName}`, d));
    }
  }

  return {
    decisions,
    needsRuntime,
    dropRegistrations: !needsRuntime,
    report,
    classMemberInjections,
  };
}
