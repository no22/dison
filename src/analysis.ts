// =====================================================================
// トークン列に対する事前解析（Parser本体を経由せずに動く軽量な事前スキャン群）
// =====================================================================
//
// ここに集めた関数は、いずれも「トークン列を1回舐めるだけの、Parserを
// 構築しなくても呼べる」解析。Parserの補助（activateのタイプミス検出、
// injectableの危険な型判定、構文的な位置制約の判定）と、複数ファイルを
// 横断する衝突検出（collisions.ts）の両方から使われる。

import type { Token } from "./lexer.js";

// whitespace/comment を飛ばした上で「意味のある」トークンを覗き見る。
export function nextSignificantToken(tokens: Token[], fromIdx: number): Token | null {
  let j = fromIdx;
  while (j < tokens.length && (tokens[j].type === "whitespace" || tokens[j].type === "comment")) j++;
  return j < tokens.length ? tokens[j] : null;
}

// nextSignificantToken の逆方向版。あるトークンの直前にある「意味のある」
// トークン（whitespace/comment以外）を覗き見る。`abstract class X` の
// `abstract` を検出するために使う。
export function prevSignificantToken(tokens: Token[], fromIdx: number): Token | null {
  let j = fromIdx;
  while (j >= 0 && (tokens[j].type === "whitespace" || tokens[j].type === "comment")) j--;
  return j >= 0 ? tokens[j] : null;
}

// 文字列リテラルトークンの生テキスト（クォート込み）から実際の文字列値を
// 取り出す（クォートを剥がし、簡易的にエスケープを解決する）。
// "activate Name from '...';" のパス文字列を正規化されたキーとして扱う
// ために使う（"./configs" と './configs' のようなクォートスタイルの
// 違いを同一視するため）。
export function parseStringLiteralValue(tokenText: string): string {
  const inner = tokenText.slice(1, -1);
  return inner.replace(/\\(.)/g, (_match, ch: string) => {
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      default:
        return ch;
    }
  });
}

// ソース全体のトークン列から、定義されている `configuration` の名前を
// あらかじめすべて収集しておく。`activate ConfigName;` のタイプミス検出のために使う。
// 生成後のTSでは `function activateXxx() {}` は巻き上げられるため、
// ソース内で activate が configuration より前に書かれていても問題なく動作する。
// そのため検証も「ファイル全体」を対象に行う。
export function collectConfigurationNames(tokens: Token[]): Set<string> {
  const names = new Set<string>();
  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx];
    if (t.type === "keyword" && t.text === "configuration") {
      let j = idx + 1;
      while (j < tokens.length && (tokens[j].type === "whitespace" || tokens[j].type === "comment")) j++;
      if (j < tokens.length && tokens[j].type === "ident") {
        names.add(tokens[j].text);
      }
    }
  }
  return names;
}

// 複数ファイル対応（docs/multi-file-support.md）: `configuration`が別ファイルで
// 定義され、`import { activateTestConfig } from "./configs";`のように
// importされている場合も、`activate TestConfig;`を有効なものとして扱えるように
// する。importの波カッコの中に現れる識別子のうち "activate" で始まるものを
// 拾い、その接尾辞（ConfigName部分）を収集する。
//
// これはヒューリスティックであり、`import { activateFoo as bar }`のような
// エイリアス（実際にこのファイルで使えるローカルな名前は"bar"であって
// "activateFoo"ではない）までは正確に判定していない
// （他のヒューリスティックと同様の既知の限界）。存在しない名前を実際に
// importしてしまった場合の検出は、このDison独自のタイプミス検出ではなく
// tsc自身の「モジュールに該当するエクスポートがない」エラーに委ねる。
export function collectImportedConfigurationNames(tokens: Token[]): Set<string> {
  const names = new Set<string>();
  const ACTIVATE_PREFIX = "activate";

  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx];
    if (t.type !== "ident" || t.text !== "import") continue;

    let j = idx + 1;
    while (j < tokens.length && !(tokens[j].type === "punct" && (tokens[j].text === "{" || tokens[j].text === ";"))) {
      j++;
    }
    if (!(j < tokens.length && tokens[j].type === "punct" && tokens[j].text === "{")) continue;

    j++;
    while (j < tokens.length && !(tokens[j].type === "punct" && tokens[j].text === "}")) {
      const specTok = tokens[j];
      if (specTok.type === "ident" && specTok.text.startsWith(ACTIVATE_PREFIX) && specTok.text.length > ACTIVATE_PREFIX.length) {
        names.add(specTok.text.slice(ACTIVATE_PREFIX.length));
      }
      j++;
    }
  }

  return names;
}

// 複数ファイルにまたがる bind/injectable の型名衝突検出（案D、
// docs/bind-interface-token.md）で使う。import文をスキャンし、
// "ローカルで使える名前 -> import specifier文字列" のマップを作る。
// import { X, Y as Z } from "spec"; の形から、Xは"spec"、Zも"spec"
// （エイリアス後のローカル名で記録する）というように収集する。
//
// これはヒューリスティックであり、`import * as NS from "spec"`のような
// 名前空間importや、`{ }`を伴わない形は捕捉できない（該当する名前は
// 「由来不明」として衝突検出の対象から除外される。誤検出を避けるため
// 安全側に倒す方針は他のヒューリスティックと同じ）。
export function collectImportOrigins(tokens: Token[]): Map<string, string> {
  const origins = new Map<string, string>();

  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx];
    if (t.type !== "ident" || t.text !== "import") continue;

    let j = idx + 1;
    while (j < tokens.length && !(tokens[j].type === "punct" && (tokens[j].text === "{" || tokens[j].text === ";"))) {
      j++;
    }
    if (!(j < tokens.length && tokens[j].type === "punct" && tokens[j].text === "{")) continue;

    let depth = 1;
    j++;
    const specStart = j;
    while (j < tokens.length && depth > 0) {
      if (tokens[j].type === "punct" && tokens[j].text === "{") depth++;
      else if (tokens[j].type === "punct" && tokens[j].text === "}") depth--;
      if (depth > 0) j++;
    }
    const braceEnd = j; // '}' のインデックス

    let k = braceEnd + 1;
    while (k < tokens.length && (tokens[k].type === "whitespace" || tokens[k].type === "comment")) k++;
    if (!(k < tokens.length && tokens[k].type === "ident" && tokens[k].text === "from")) continue;
    k++;
    while (k < tokens.length && (tokens[k].type === "whitespace" || tokens[k].type === "comment")) k++;
    if (!(k < tokens.length && tokens[k].type === "string")) continue;
    const specifier = parseStringLiteralValue(tokens[k].text);

    // specStart..braceEnd の中の "IDENT (as IDENT)?" をカンマ区切りで読む
    let p = specStart;
    let pendingName: string | null = null;
    let pendingAlias: string | null = null;
    const flush = () => {
      if (pendingName !== null) {
        origins.set(pendingAlias ?? pendingName, specifier);
      }
      pendingName = null;
      pendingAlias = null;
    };
    while (p < braceEnd) {
      const specTok = tokens[p];
      if (specTok.type === "ident" && specTok.text === "as") {
        p++;
        while (p < braceEnd && (tokens[p].type === "whitespace" || tokens[p].type === "comment")) p++;
        if (p < braceEnd && tokens[p].type === "ident") {
          pendingAlias = tokens[p].text;
        }
      } else if (specTok.type === "punct" && specTok.text === ",") {
        flush();
      } else if (specTok.type === "ident" && pendingName === null) {
        pendingName = specTok.text;
      }
      p++;
    }
    flush();
  }

  return origins;
}

// 複数ファイルの実体キー一致（docs/type-identity-matching.md 案A(a)）で使う。
// collectImportOrigins より詳しい情報を返す import スキャナ。各 named import に
// ついて「このファイルで使えるローカル名」「相手ファイルでの元のexport名」
// 「import specifier」「型onlyインポートか」を収集する。value-importされた
// 具象クラスを実体キー化の対象に含めるかどうかの判定に使う。
//
// collectImportOrigins（衝突検出用、localName->specifier のみ）とは別関数として
// 追加している（既存の呼び出し側の挙動を変えないため）。
// `import type { X } from "spec"` は typeOnly=true として、`import { type X, Y }` の
// X のような inline type modifier も個別に typeOnly=true として記録する
// （型onlyなインポートは実行時に値を持たないため、実体参照キーには使えない）。
export interface ImportBinding {
  localName: string;
  importedName: string;
  specifier: string;
  typeOnly: boolean;
}

export function collectImportBindings(tokens: Token[]): ImportBinding[] {
  const bindings: ImportBinding[] = [];

  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx];
    if (t.type !== "ident" || t.text !== "import") continue;

    // "import" の直後が "type" なら、この import 全体が型onlyインポート。
    const afterImport = nextSignificantToken(tokens, idx + 1);
    const wholeTypeOnly = afterImport !== null && afterImport.type === "ident" && afterImport.text === "type";

    let j = idx + 1;
    while (j < tokens.length && !(tokens[j].type === "punct" && (tokens[j].text === "{" || tokens[j].text === ";"))) {
      j++;
    }
    if (!(j < tokens.length && tokens[j].type === "punct" && tokens[j].text === "{")) continue;

    let depth = 1;
    j++;
    const specStart = j;
    while (j < tokens.length && depth > 0) {
      if (tokens[j].type === "punct" && tokens[j].text === "{") depth++;
      else if (tokens[j].type === "punct" && tokens[j].text === "}") depth--;
      if (depth > 0) j++;
    }
    const braceEnd = j; // '}' のインデックス

    let k = braceEnd + 1;
    while (k < tokens.length && (tokens[k].type === "whitespace" || tokens[k].type === "comment")) k++;
    if (!(k < tokens.length && tokens[k].type === "ident" && tokens[k].text === "from")) continue;
    k++;
    while (k < tokens.length && (tokens[k].type === "whitespace" || tokens[k].type === "comment")) k++;
    if (!(k < tokens.length && tokens[k].type === "string")) continue;
    const specifier = parseStringLiteralValue(tokens[k].text);

    // specStart..braceEnd の中の "(type)? IDENT (as IDENT)?" をカンマ区切りで読む。
    let p = specStart;
    let importedName: string | null = null;
    let alias: string | null = null;
    let inlineTypeOnly = false;
    let sawAs = false;
    const flush = () => {
      if (importedName !== null) {
        bindings.push({
          localName: alias ?? importedName,
          importedName,
          specifier,
          typeOnly: wholeTypeOnly || inlineTypeOnly,
        });
      }
      importedName = null;
      alias = null;
      inlineTypeOnly = false;
      sawAs = false;
    };
    while (p < braceEnd) {
      const specTok = tokens[p];
      if (specTok.type === "whitespace" || specTok.type === "comment") {
        p++;
        continue;
      }
      if (specTok.type === "punct" && specTok.text === ",") {
        flush();
      } else if (specTok.type === "ident" && specTok.text === "as") {
        sawAs = true;
      } else if (specTok.type === "ident" && specTok.text === "type" && importedName === null) {
        // 名前より前に現れる "type" は inline type modifier（import { type X }）。
        inlineTypeOnly = true;
      } else if (specTok.type === "ident") {
        if (sawAs) alias = specTok.text;
        else if (importedName === null) importedName = specTok.text;
      }
      p++;
    }
    flush();
  }

  return bindings;
}

// `injectable` の型注釈が「new で自動生成できない型」（interface/型エイリアス/
// abstract class）かどうかを判定するための簡易ヒューリスティック。`class` /
// `interface` / `type` / `abstract` はDisonの予約語ではなく普通のTSキーワード
// なので、素通しされるRawトークン列の中に "ident" として現れる。それを軽く
// スキャンし、名前だけ拾い集める。
// （`export default class {}` のような無名クラスなど、一部の宣言形式は
//  この簡易スキャンでは捕捉できない点に注意。ただしこれは実害が小さい:
//  無名クラスはこのファイル内で型として参照する名前を持たないため
//  injectableの型注釈に使われる経路がなく、`const X = class {}` のような
//  クラス式のXは、そもそもTypeScript自体がXを型として使うことを拒否する
//  （'X' refers to a value, but is being used as a type here）ため、
//  Disonの分類が誤っていてもtsc自身が即座に検出する。詳細は
//  docs/static-injectable-detection.md 参照）
export interface DeclaredTypeKinds {
  classNames: Set<string>;
  nonNewableTypeNames: Set<string>; // interface / type エイリアス / abstract class（new 不可）
  // nonNewableTypeNames のうち abstract class のもの。abstract class は new 不可だが
  // 実行時に値（クラス）を持つため、bind/injectable の照合キーとしてはクラスの実体を
  // そのまま使える（実体キー化。docs/type-identity-matching.md 案A(a)）。真の
  // interface/型エイリアス（実行時に値が無く companion Symbol でキー化するもの。
  // 案A(b)）と区別するために保持する。
  abstractClassNames: Set<string>;
}

export function collectDeclaredTypeKinds(tokens: Token[]): DeclaredTypeKinds {
  const classNames = new Set<string>();
  const nonNewableTypeNames = new Set<string>();
  const abstractClassNames = new Set<string>();

  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx];
    if (t.type !== "ident") continue;

    if (t.text === "class") {
      const nameTok = nextSignificantToken(tokens, idx + 1);
      if (!nameTok || nameTok.type !== "ident") continue;

      const prevTok = prevSignificantToken(tokens, idx - 1);
      const isAbstract = prevTok !== null && prevTok.type === "ident" && prevTok.text === "abstract";
      if (isAbstract) {
        // abstract class は new 不可能なので nonNewableTypeNames に入れる（injectable の
        // 既定初期化式必須判定＝isRiskyInjectableType のため）。ただし実行時には値を
        // 持つので、companion ではなく実体キー化の対象として abstractClassNames にも
        // 記録する（同名の非abstract classが別途あれば宣言マージ扱い）。
        nonNewableTypeNames.add(nameTok.text);
        abstractClassNames.add(nameTok.text);
      } else {
        classNames.add(nameTok.text);
      }
    } else if (t.text === "interface" || t.text === "type") {
      const nameTok = nextSignificantToken(tokens, idx + 1);
      if (nameTok && nameTok.type === "ident") nonNewableTypeNames.add(nameTok.text);
    }
  }

  return { classNames, nonNewableTypeNames, abstractClassNames };
}

// 実行時に値を持たない「真の interface / 型エイリアス」の名前集合を返す
// （nonNewableTypeNames から abstract class を除いたもの）。companion Symbol で
// キー化する対象（docs/type-identity-matching.md 案A(b)）。
export function trueInterfaceOrAliasNames(kinds: DeclaredTypeKinds): Set<string> {
  const result = new Set<string>();
  for (const name of kinds.nonNewableTypeNames) {
    if (!kinds.abstractClassNames.has(name)) result.add(name);
  }
  return result;
}

// bind/injectable の照合キーに実体参照（クラスの値）を使える名前集合を返す
// （具象クラス ∪ abstract class。どちらも実行時に値を持つ）。
export function identityKeyableClassNames(kinds: DeclaredTypeKinds): Set<string> {
  return new Set<string>([...kinds.classNames, ...kinds.abstractClassNames]);
}

// 型注釈が「単純な型参照（＋ジェネリクス）」の形かどうかを判定する。
// 例: "SqlUserRepository" / "IUserRepository" / "Repository<User>" は true。
// 一方 "User[]"（配列型）、"A | B"（ユニオン型）、"(x: number) => void"（関数型）
// などは false になる。これはあくまで構文上の形の判定であり、
// クラスかインターフェースかまでは区別しない（それは isRiskyInjectableType で行う）。
export function isSimpleTypeShape(typeName: string): boolean {
  return /^[A-Za-z_$][\w$]*(\s*<[\s\S]+>)?$/.test(typeName.trim());
}

// 型注釈の先頭の識別子部分だけを取り出す（ジェネリクス部分を除く）。
// 例: "Repository<User>" -> "Repository"
export function baseIdentifierOf(typeName: string): string {
  const m = typeName.trim().match(/^([A-Za-z_$][\w$]*)/);
  return m ? m[1] : typeName.trim();
}

// injectableの型が「new で自動生成できない危険な型」かどうかを判定する。
// 危険な型は injectable 宣言で "= <式>" による既定初期化式が構文的に
// 必須になる（パーサがこの関数を使って強制する）。
//
//   - 配列型・ユニオン型・関数型など（isSimpleTypeShapeがfalse）は常に危険。
//   - 単純な識別子の形でも、このファイル内で interface / type エイリアス /
//     abstract class として宣言されていると判定できた場合は危険
//     （宣言マージで同名の非abstract classが別途あれば安全側に倒す）。
export function isRiskyInjectableType(typeKey: string, typeKinds: DeclaredTypeKinds): boolean {
  if (!isSimpleTypeShape(typeKey)) return true;
  const base = baseIdentifierOf(typeKey);
  return typeKinds.nonNewableTypeNames.has(base) && !typeKinds.classNames.has(base);
}

// injectable / configuration / 単独のoverride・bind は、それぞれ生成されるコードの
// 形（クラスメンバ宣言／関数宣言／ただの代入文）によって、構文的に置ける位置が
// 異なる。この判定のため、トークン列全体を1回スキャンし、各トークン位置について
// 「トップレベルか」「直近の囲みブロックがクラス本体かどうか」を事前計算する。
//
//   - injectable: クラス本体の直下（private/get/setを生成するため、それ以外の
//     位置ではtscが構文エラーにする）
//   - configuration: トップレベルのみ（function宣言を生成するため。将来の
//     複数ファイル対応や、静的な「定義済みconfiguration名」前提（activateの
//     タイプミス検出）を壊さないため、あえて関数の中も許可しない）
//   - 単独のoverride/bind（configurationで包まないもの）: ただの代入文を
//     生成するため、文が書ける場所ならどこでも良いが、クラス本体の直下だけは
//     不可（クラスメンバの位置には代入文を置けないため）
//
// クラス本体の判定はヒューリスティック（`class`という識別子トークンの直後に
// 現れる最初の "{" をそのクラスの本体開始とみなす）。`class`がTSキーワードとして
// 使われるとき、それに続く波カッコで純粋な波カッコ以外（オブジェクトリテラル等）が
// `class`とその本体の間に挟まることは通常の宣言構文上あり得ないため、この単純な
// 追跡で十分。ただし `{ class: 1 }` のようなオブジェクトリテラルのプロパティ名としての
// `class`（直後が ':'）だけは誤検出しないよう明示的に除外している
// （`obj.class = ...` のようなメンバアクセスの誤検出までは対応していない。
// 他のヒューリスティック（collectDeclaredTypeKinds等）と同様の既知の限界）。
export interface BlockContext {
  isTopLevel(idx: number): boolean;
  isDirectClassBodyChild(idx: number): boolean;
}

export function collectBlockContext(tokens: Token[]): BlockContext {
  const depthAt: number[] = new Array(tokens.length);
  const isClassBodyAt: boolean[] = new Array(tokens.length);

  const blockStack: boolean[] = []; // 各要素: そのブロックがクラス本体ならtrue
  let sawClassKeyword = false;

  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx];
    depthAt[idx] = blockStack.length;
    isClassBodyAt[idx] = blockStack.length > 0 ? blockStack[blockStack.length - 1] : false;

    if (t.type === "ident" && t.text === "class") {
      const next = nextSignificantToken(tokens, idx + 1);
      const isObjectKeyShorthand = next !== null && next.type === "punct" && next.text === ":";
      if (!isObjectKeyShorthand) {
        sawClassKeyword = true;
      }
    } else if (t.type === "punct" && t.text === "{") {
      blockStack.push(sawClassKeyword);
      sawClassKeyword = false;
    } else if (t.type === "punct" && t.text === "}") {
      blockStack.pop();
    }
  }

  return {
    isTopLevel: (idx) => (depthAt[idx] ?? 0) === 0,
    isDirectClassBodyChild: (idx) => isClassBodyAt[idx] ?? false,
  };
}
