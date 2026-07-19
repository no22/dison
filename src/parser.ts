// =====================================================================
// 3. Parser
// =====================================================================

import type { Token } from "./lexer.js";
import type { Node, OverrideEntry, BindEntry, ConfigEntry } from "./ast.js";
import {
  type DeclaredTypeKinds,
  type BlockContext,
  collectConfigurationNames,
  collectImportedConfigurationNames,
  collectBlockContext,
  isRiskyInjectableType,
  parseStringLiteralValue,
} from "./analysis.js";

export class DisonParseError extends Error {
  constructor(message: string, pos: number) {
    super(`Dison syntax error (position ${pos}): ${message}`);
  }
}

export class Parser {
  private readonly tokens: Token[];
  private readonly knownConfigNames: Set<string>;
  private readonly typeKinds: DeclaredTypeKinds;
  private readonly blockContext: BlockContext;
  private pos = 0;

  constructor(tokens: Token[], typeKinds: DeclaredTypeKinds) {
    this.tokens = tokens;
    // 同一ファイル内で定義されたconfigurationと、他ファイルからimportされた
    // configuration（複数ファイル対応、docs/multi-file-support.md）の両方を
    // 「既知のconfiguration名」として扱う。
    this.knownConfigNames = new Set([
      ...collectConfigurationNames(tokens),
      ...collectImportedConfigurationNames(tokens),
    ]);
    this.typeKinds = typeKinds;
    this.blockContext = collectBlockContext(tokens);
  }

  private peek(offset = 0): Token {
    return this.tokens[this.pos + offset] ?? this.tokens[this.tokens.length - 1];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private isTrivia(t: Token): boolean {
    return t.type === "whitespace" || t.type === "comment";
  }

  private skipTrivia(): void {
    while (this.isTrivia(this.peek())) this.next();
  }

  // whitespace/comment を飛ばした上で offset 番目に「意味のある」トークンを覗き見る
  private peekSignificant(offset = 0): Token {
    let idx = this.pos;
    let count = 0;
    while (idx < this.tokens.length) {
      const t = this.tokens[idx];
      if (!this.isTrivia(t)) {
        if (count === offset) return t;
        count++;
      }
      idx++;
    }
    return this.tokens[this.tokens.length - 1];
  }

  private expectPunct(text: string, context: string): void {
    const t = this.next();
    if (!(t.type === "punct" && t.text === text)) {
      throw new DisonParseError(`Expected "${text}" but found "${t.text}" (${context})`, t.pos);
    }
  }

  parseProgram(): Node[] {
    const nodes: Node[] = [];
    while (this.peek().type !== "eof") {
      const t = this.peek();

      if (this.isTrivia(t)) {
        nodes.push({ kind: "raw", text: this.next().text });
        continue;
      }

      if (t.type === "keyword" && t.text === "configuration" && this.looksLikeConfiguration()) {
        nodes.push(this.parseConfiguration());
        continue;
      }

      if (t.type === "keyword" && t.text === "injectable" && this.looksLikeInjectable()) {
        nodes.push(this.parseInjectable());
        continue;
      }

      if (t.type === "keyword" && t.text === "activate" && this.looksLikeActivate()) {
        nodes.push(this.parseActivate());
        continue;
      }

      if (t.type === "keyword" && t.text === "token" && this.looksLikeToken()) {
        nodes.push(this.parseToken());
        continue;
      }

      // configuration で包まない単独の override/bind。「その場で即座に実行される」
      // 代入文として脱糖されるため、文が書ける場所ならどこでも良い
      // （関数・メソッドの中でレキシカル変数を捕捉したい場合に使う）。
      // ただしクラス本体の直下（メソッドの外）だけは、代入文を置ける位置ではない
      // ため不可（クラス内の override/bind は必ず configuration { ... } の中に
      // 書く前提で、parseConfiguration側でのみ処理される）。
      if (t.type === "keyword" && t.text === "override" && this.looksLikeOverride()) {
        if (this.blockContext.isDirectClassBodyChild(this.pos)) {
          throw new DisonParseError(
            `A standalone "override" cannot be placed directly inside a class body (put it inside a method, or at the top level / inside a function)`,
            t.pos
          );
        }
        const entry = this.parseOverride("a standalone override");
        nodes.push({ kind: "standalone-override", entry });
        continue;
      }

      if (t.type === "keyword" && t.text === "bind" && this.looksLikeBind()) {
        if (this.blockContext.isDirectClassBodyChild(this.pos)) {
          throw new DisonParseError(
            `A standalone "bind" cannot be placed directly inside a class body (put it inside a method, or at the top level / inside a function)`,
            t.pos
          );
        }
        const entry = this.parseBind("a standalone bind");
        nodes.push({ kind: "standalone-bind", entry });
        continue;
      }

      // DSLキーワードに該当しないトークンはすべて無傷でパススルー
      nodes.push({ kind: "raw", text: this.next().text });
    }
    return nodes;
  }

  // "configuration IDENT {" の形になっているかを先読みで確認する。
  // 単に "configuration" という名前の変数・メソッドが使われているだけの場合は
  // この判定に失敗し、通常の raw トークンとして扱われる
  // （looksLikeInjectable/looksLikeActivateと同じパターン）。
  private looksLikeConfiguration(): boolean {
    const a = this.peekSignificant(1);
    const b = this.peekSignificant(2);
    return a.type === "ident" && b.type === "punct" && b.text === "{";
  }

  // "token IDENT ;" の形になっているかを先読みで確認する。
  // 単に "token" という名前の変数・メソッドが使われているだけの場合は
  // この判定に失敗し、通常の raw トークンとして扱われる。
  private looksLikeToken(): boolean {
    const a = this.peekSignificant(1);
    const b = this.peekSignificant(2);
    return a.type === "ident" && b.type === "punct" && b.text === ";";
  }

  // token Name; -> export const Name = Symbol("Name"); に脱糖される
  // （docs/bind-interface-token.md）。"as <トークン>" 句で参照される値は、
  // 複数箇所（複数ファイルにまたがる場合も含む）から安定して参照される
  // 共有の定数でなければならないため、configurationと同様にトップレベル
  // にのみ書ける（exportはトップレベルの宣言にしか付けられないため）。
  private parseToken(): Node {
    if (!this.blockContext.isTopLevel(this.pos)) {
      throw new DisonParseError(
        `"token" can only be placed at the top level (not inside a function or class)`,
        this.peek().pos
      );
    }
    this.next(); // 'token'
    this.skipTrivia();
    const nameTok = this.next();
    if (nameTok.type !== "ident") {
      throw new DisonParseError(`Expected a name in the "token" declaration but found "${nameTok.text}"`, nameTok.pos);
    }
    this.skipTrivia();
    this.expectPunct(";", `token "${nameTok.text}"`);
    return { kind: "token", name: nameTok.text };
  }

  // "override IDENT {" の形になっているかを先読みで確認する
  // （configuration内のoverrideと同じ判定基準）。
  private looksLikeOverride(): boolean {
    const a = this.peekSignificant(1);
    const b = this.peekSignificant(2);
    return a.type === "ident" && b.type === "punct" && b.text === "{";
  }

  // "bind IDENT" の直後が '='（差し替え先の直接指定）か '<'（ジェネリクスの
  // 型引数）になっているかを先読みで確認する。
  private looksLikeBind(): boolean {
    const a = this.peekSignificant(1);
    if (a.type !== "ident") return false;
    const b = this.peekSignificant(2);
    return b.type === "punct" && (b.text === "=" || b.text === "<");
  }

  // "injectable IDENT : <型注釈> ;" の形になっているかを先読みで確認する。
  // 型注釈は配列型・ユニオン型・ジェネリクス・関数型など任意の形式を許容するため、
  // ここでは「プロパティ名の直後に ':' が続くか」だけを見て判定する。
  // 単に "injectable" という名前の変数・メソッドが使われているだけの場合は
  // この判定に失敗し、通常の raw トークンとして扱われる。
  private looksLikeInjectable(): boolean {
    const a = this.peekSignificant(1);
    const b = this.peekSignificant(2);
    return a.type === "ident" && b.type === "punct" && b.text === ":";
  }

  private parseInjectable(): Node {
    // injectable はクラスメンバ宣言（private/get/set）を生成するため、
    // クラス本体の直下（メソッドの外）以外では構文的に無効になる。
    if (!this.blockContext.isDirectClassBodyChild(this.pos)) {
      throw new DisonParseError(
        `"injectable" can only be placed directly inside a class body (not inside a method or at the top level)`,
        this.peek().pos
      );
    }
    this.next(); // 'injectable'
    this.skipTrivia();
    const propTok = this.next();
    if (propTok.type !== "ident") {
      throw new DisonParseError(`Expected a property name in the "injectable" declaration but found "${propTok.text}"`, propTok.pos);
    }
    this.skipTrivia();
    this.expectPunct(":", `injectable "${propTok.text}"`);
    this.skipTrivia();
    const { typeName, typeKey } = this.parseTypeExpr(propTok.text);

    // "as <トークン>" は任意。複数ファイルにまたがる同名interface/型エイリアスの
    // 衝突をトークンで明示的に回避するために使う（docs/bind-interface-token.md）。
    const token = this.parseOptionalAsToken(`injectable "${propTok.text}"`);

    // parseTypeExpr はトップレベルの ';' か '=' の直前で止まる（消費しない）。
    // '=' があれば既定初期化式が書かれているとみなして読み進める。
    let defaultExpr: string | undefined;
    const terminator = this.peek();
    if (terminator.type === "punct" && terminator.text === "=") {
      this.next(); // '='
      this.skipTrivia();
      defaultExpr = this.parseInjectableDefaultExpr(propTok.text);
    } else {
      this.expectPunct(";", `injectable "${propTok.text}"`);
    }

    // 危険な型（new で自動生成できない型）には既定初期化式が構文的に必須。
    // 安全な型（通常のクラス型）は省略可（従来通り new Type() が自動生成される）。
    // 判定には正規化済みキー（typeKey）を使う（空白・コメントの影響を受けない）。
    if (defaultExpr === undefined && isRiskyInjectableType(typeKey, this.typeKinds)) {
      throw new DisonParseError(
        `injectable "${propTok.text}" has type "${typeName}", which cannot be auto-constructed` +
          ` (interface / type alias / abstract class, or an array/union/function type, etc.).` +
          ` A default initializer "= <expr>" is required. Example: injectable ${propTok.text}: ${typeName} = new ConcreteClass();`,
        propTok.pos
      );
    }

    return { kind: "injectable", propName: propTok.text, typeName, typeKey, defaultExpr, token };
  }

  // "as <トークン>" 句を任意で読み取る。トークンは複数箇所（injectable/bind）から
  // 安定して参照される共有値でなければならないため、識別子＋任意の".プロパティ"
  // という制限された形のみ許可する（呼び出し式や任意の式は許可しない。
  // "as Symbol('X')"のようにその場で新しい値を作ってしまうと、参照するたびに
  // 異なる値になり、衝突回避という目的そのものを果たせなくなるため）。
  private parseOptionalAsToken(context: string): string | undefined {
    const maybeAs = this.peek();
    if (!(maybeAs.type === "ident" && maybeAs.text === "as")) return undefined;
    this.next(); // 'as'
    this.skipTrivia();

    const nameTok = this.next();
    if (nameTok.type !== "ident") {
      throw new DisonParseError(`An identifier for the token is required after "as" in ${context}`, nameTok.pos);
    }
    let text = nameTok.text;

    while (true) {
      this.skipTrivia();
      const dot = this.peek();
      if (!(dot.type === "punct" && dot.text === ".")) break;
      this.next(); // '.'
      this.skipTrivia();
      const propTok = this.next();
      if (propTok.type !== "ident") {
        throw new DisonParseError(`An identifier is required after "." in the "as" token reference in ${context}`, propTok.pos);
      }
      text += "." + propTok.text;
    }

    this.skipTrivia();
    return text;
  }

  // injectableの既定初期化式 "= <式>" の <式> 部分を、次のトップレベル ";" まで
  // 丸ごと式として取り込む形で解析する。override の代入式パース（parseAssignment）
  // と同じロジック（括弧・波カッコ・角カッコの深さを数えて中の ";" には反応しない）。
  // override と同じ規約で、自動で "new" は補わない（任意のTS式をそのまま評価する）。
  private parseInjectableDefaultExpr(propName: string): string {
    let depth = 0;
    const exprParts: string[] = [];

    while (true) {
      const t = this.peek();
      if (t.type === "eof") {
        throw new DisonParseError(`The default initializer of injectable "${propName}" is not terminated with ";"`, t.pos);
      }
      if (t.type === "punct" && (t.text === "(" || t.text === "[" || t.text === "{")) depth++;
      if (t.type === "punct" && (t.text === ")" || t.text === "]" || t.text === "}")) depth--;

      if (t.type === "punct" && t.text === ";" && depth === 0) {
        this.next();
        break;
      }
      exprParts.push(this.next().text);
    }

    const expr = exprParts.join("").trim();
    if (expr === "") {
      throw new DisonParseError(`The default initializer of injectable "${propName}" is empty`, this.peek().pos);
    }
    return expr;
  }

  // "activate IDENT ;" または "activate IDENT from ..." の形になっているかを
  // 先読みで確認する。from句の詳細（文字列リテラルかどうか等）はここでは
  // 確認せず、parseActivate本体に委ねる。
  private looksLikeActivate(): boolean {
    const a = this.peekSignificant(1);
    const b = this.peekSignificant(2);
    if (a.type !== "ident") return false;
    if (b.type === "punct" && b.text === ";") return true;
    if (b.type === "ident" && b.text === "from") return true;
    return false;
  }

  private parseActivate(): Node {
    // activate はただの関数呼び出し文に脱糖されるため、injectable/configuration
    // のような「宣言」と違い文が書ける場所ならどこでも良いが、クラス本体の
    // 直下（メソッドの外）だけは代入文・呼び出し文を置ける位置ではないため
    // 不可（単独override/bindと同じ制約）。
    if (this.blockContext.isDirectClassBodyChild(this.pos)) {
      throw new DisonParseError(
        `"activate" cannot be placed directly inside a class body (put it inside a method, or at the top level / inside a function)`,
        this.peek().pos
      );
    }

    this.next(); // 'activate'
    this.skipTrivia();
    const nameTok = this.next();
    if (nameTok.type !== "ident") {
      throw new DisonParseError(`Expected a configuration name in the "activate" statement but found "${nameTok.text}"`, nameTok.pos);
    }
    this.skipTrivia();

    // "from <文字列リテラル>" は任意。他ファイルのconfigurationを
    // activateする場合に使う（複数ファイル対応フェーズ2、
    // docs/activate-from-syntax.md）。"from"はLexerの予約語にはしておらず、
    // ここでのみ文脈的に認識する（TypeScript自身のimport構文における
    // "from"と同じ扱い）。
    let fromPath: string | undefined;
    const maybeFrom = this.peek();
    if (maybeFrom.type === "ident" && maybeFrom.text === "from") {
      this.next(); // 'from'
      this.skipTrivia();
      const pathTok = this.next();
      if (pathTok.type !== "string") {
        throw new DisonParseError(
          `A string literal path is required after "from" in activate "${nameTok.text}"`,
          pathTok.pos
        );
      }
      // クォートスタイル（"..." と '...'）の違いを同一視するため、
      // 生テキストではなく実際の文字列値を正規化済みキーとして使う
      // （bindのジェネリクス対応で発見した「表示用テキストと正規化済み
      // キーを分ける」のと同種の対策）。
      fromPath = parseStringLiteralValue(pathTok.text);
      this.skipTrivia();
    }

    this.expectPunct(";", `activate "${nameTok.text}"`);

    // タイプミス検出: fromが無い場合のみ、同一ファイル内の定義または
    // import済みの名前（docs/multi-file-support.md）で存在確認する。
    // fromがある場合はDison側でパス先のファイルの中身を読まないため
    // 検証できず、tsc自身のimport解決に委ねる
    // （docs/activate-from-syntax.md参照）。
    if (fromPath === undefined && !this.knownConfigNames.has(nameTok.text)) {
      const known = [...this.knownConfigNames].join(", ") || "(none)";
      throw new DisonParseError(
        `configuration "${nameTok.text}" is not defined. Defined configurations: ${known}`,
        nameTok.pos
      );
    }

    return { kind: "activate", name: nameTok.text, fromPath };
  }

  // 型注釈を "次のトップレベル ; または =（既定初期化式の開始）まで" 丸ごと
  // 取り込む形で解析する。これにより配列型（User[]）、ユニオン/交差型（A | B）、
  // ジェネリクス（Repository<User>、Map<string, Array<User>>）、関数型
  // （(x: number) => void）などTypeScriptのプロパティ型注釈として
  // 一般的に書ける形式をすべて素通しできる。
  //
  // ';' も '=' も消費せずに止まる（呼び出し側の parseInjectable が、
  // 次のトークンが '=' か ';' かを見て既定初期化式の有無を判断する）。
  //
  // 深さの数え方は2系統に分けている:
  //   - bracketDepth: ( ) [ ] { } の対応関係
  //   - angleDepth  : ジェネリクスの < >
  // ただし "=>" のアロー記法は2箇所で特別扱いする必要がある:
  //   - '>' 側: 直前の '=' に隣接している場合はジェネリクスの閉じではなく
  //     アロー演算子の一部とみなし、angleDepth のカウントには影響させない。
  //   - '=' 側: 直後に '>' が隙間なく続く場合は関数型の "=>" の一部であり、
  //     既定初期化式の区切りの '=' ではないので型注釈の一部として読み進める。
  //
  // 表示用テキスト（typeName、空白・コメントを含む元の書き方をそのまま保持）と、
  // 正規化済みキー（typeKey、空白・コメントトークンを除いて連結したもの）の
  // 両方を返す。typeKeyは TYPE_BINDINGS の照合や危険な型の判定に使う
  // （bindの左辺・右辺のキー化（parseGenericTypeRef）と同じ規則）。
  private parseTypeExpr(propName: string): { typeName: string; typeKey: string } {
    let bracketDepth = 0;
    let angleDepth = 0;
    const displayParts: string[] = [];
    const keyParts: string[] = [];

    while (true) {
      const t = this.peek();
      if (t.type === "eof") {
        throw new DisonParseError(`The type annotation of injectable "${propName}" is not terminated with ";" or "="`, t.pos);
      }

      if (t.type === "punct" && (t.text === "(" || t.text === "[" || t.text === "{")) bracketDepth++;
      if (t.type === "punct" && (t.text === ")" || t.text === "]" || t.text === "}")) bracketDepth--;

      if (t.type === "punct" && t.text === "<") {
        angleDepth++;
      } else if (t.type === "punct" && t.text === ">") {
        // 直前のトークンが隣接する '=' の場合は "=>" の一部なのでカウントしない
        const prev = this.tokens[this.pos - 1];
        const isArrowTail = prev && prev.type === "punct" && prev.text === "=" && prev.pos + prev.text.length === t.pos;
        if (!isArrowTail && angleDepth > 0) angleDepth--;
      }

      if (bracketDepth === 0 && angleDepth === 0 && t.type === "punct" && t.text === ";") {
        break; // 消費しない
      }

      if (bracketDepth === 0 && angleDepth === 0 && t.type === "punct" && t.text === "=") {
        const next = this.tokens[this.pos + 1];
        const isArrowHead = next && next.type === "punct" && next.text === ">" && t.pos + t.text.length === next.pos;
        if (!isArrowHead) {
          break; // 既定初期化式の区切り。消費しない
        }
        // "=>" の一部なので通常のトークンとして読み進める
      }

      // "as <トークン>" 句の区切り。型注釈の中で "as" が正当に現れることは
      // 無い（マップ型の "as" 節や型アサーションの "as" はどちらも
      // bracketDepth/angleDepth 0 の位置には現れない）ため、単純に識別子
      // "as" で判定してよい。
      if (bracketDepth === 0 && angleDepth === 0 && t.type === "ident" && t.text === "as") {
        break; // 消費しない
      }

      const consumed = this.next();
      displayParts.push(consumed.text);
      if (consumed.type !== "whitespace" && consumed.type !== "comment") {
        keyParts.push(consumed.text);
      }
    }

    const typeName = displayParts.join("").trim();
    if (typeName === "") {
      throw new DisonParseError(`The type annotation of injectable "${propName}" is empty`, this.peek().pos);
    }
    const typeKey = keyParts.join("");
    return { typeName, typeKey };
  }

  private parseConfiguration(): Node {
    // configuration は function 宣言を生成するため、また「定義済み
    // configuration名」という静的な前提（activateのタイプミス検出、5節参照）
    // を壊さないため、トップレベルにのみ書ける。
    if (!this.blockContext.isTopLevel(this.pos)) {
      throw new DisonParseError(
        `"configuration" can only be placed at the top level (not inside a function or class). If you just want a standalone override/bind at this spot, write it without wrapping it in a configuration.`,
        this.peek().pos
      );
    }
    const startTok = this.next(); // 'configuration'
    this.skipTrivia();
    const nameTok = this.peek();
    if (nameTok.type !== "ident") {
      throw new DisonParseError(`Expected a configuration name but found "${nameTok.text}"`, nameTok.pos);
    }
    const name = this.next().text;
    this.skipTrivia();
    this.expectPunct("{", `configuration "${name}"`);

    const entries: ConfigEntry[] = [];

    while (true) {
      this.skipTrivia();
      const t = this.peek();
      if (t.type === "punct" && t.text === "}") {
        this.next();
        break;
      }
      if (t.type === "eof") {
        throw new DisonParseError(`Closing "}" for configuration "${name}" not found`, startTok.pos);
      }
      if (t.type === "keyword" && t.text === "override") {
        entries.push(this.parseOverride(`configuration "${name}"`));
        continue;
      }
      if (t.type === "keyword" && t.text === "bind") {
        entries.push(this.parseBind(`configuration "${name}"`));
        continue;
      }
      throw new DisonParseError(
        `Only override / bind declarations are allowed inside configuration "${name}" (found "${t.text}")`,
        t.pos
      );
    }

    return { kind: "configuration", name, entries };
  }

  // context: エラーメッセージに埋め込む文脈の説明。configuration内で呼ばれる
  // 場合は `configuration "${name}"`、単独のoverideとして呼ばれる場合は
  // "単独の override" のように、呼び出し側が完成した句を渡す。
  private parseOverride(context: string): OverrideEntry {
    const startTok = this.next(); // 'override'
    this.skipTrivia();
    const classTok = this.peek();
    if (classTok.type !== "ident") {
      throw new DisonParseError(`Expected the target class name for override but found "${classTok.text}"`, classTok.pos);
    }
    const className = this.next().text;
    this.skipTrivia();
    this.expectPunct("{", `override "${className}"（${context}）`);

    const assignments: { prop: string; valueExpr: string }[] = [];

    while (true) {
      this.skipTrivia();
      const t = this.peek();
      if (t.type === "punct" && t.text === "}") {
        this.next();
        break;
      }
      if (t.type === "eof") {
        throw new DisonParseError(`Closing "}" for override "${className}" not found`, startTok.pos);
      }
      assignments.push(this.parseAssignment(className));
    }

    return { kind: "override", className, assignments };
  }

  // "bind OriginalType = ReplacementType(args?);" を解析する。
  // override とは異なり、bind は「型を型で差し替える」という用途に限定する
  // ため、左辺・右辺とも単一の型参照（識別子＋任意のジェネリクス）のみを
  // 許可する（isSimpleTypeShapeが許容する形と同じ範囲。injectableの
  // resolveType呼び出しがこの形の型にしか使われないため、それ以上広げても
  // 意味がない）。差し替え先には任意でコンストラクタ引数
  // `Replacement(args)` を後置でき、`new Replacement(args)` として生成される
  // （docs/bind-constructor-arguments.md）。引数は照合キー（chaining）には
  // 含めない（キーは型名のまま）。
  // context: parseOverrideと同じ規約（呼び出し側が完成した句を渡す）。
  private parseBind(context: string): BindEntry {
    this.next(); // 'bind'
    this.skipTrivia();
    const original = this.parseGenericTypeRef(`bind's original type (${context})`);
    this.skipTrivia();

    // "as <トークン>" は任意。複数ファイルにまたがる同名interface/型エイリアスの
    // 衝突をトークンで明示的に回避するために使う（docs/bind-interface-token.md）。
    const token = this.parseOptionalAsToken(`bind "${original.display}"`);

    this.expectPunct("=", `bind "${original.display}" (${context})`);
    this.skipTrivia();
    const replacement = this.parseGenericTypeRef(`bind "${original.display}"'s replacement type (${context})`);
    this.skipTrivia();

    // 差し替え先の型参照の直後に "(" があれば、コンストラクタ引数リスト。
    // 型参照の直後の "(" は関数呼び出し（＝コンストラクタ引数）としか解釈
    // しようがないため曖昧さは無い（docs/bind-constructor-arguments.md）。
    const replacementArgs = this.parseOptionalCallArgs(`bind "${original.display}" = "${replacement.display}"`);
    this.skipTrivia();

    this.expectPunct(";", `bind "${original.display}" = "${replacement.display}"`);

    return {
      kind: "bind",
      originalTypeName: original.display,
      originalTypeKey: original.key,
      replacementTypeName: replacement.display,
      replacementTypeKey: replacement.key,
      replacementArgs,
      token,
    };
  }

  // 差し替え先の直後の "( ... )" を任意で読み取り、括弧内側の引数テキストを返す。
  // 括弧が無ければ undefined、空括弧 "()" も undefined（＝ new Replacement() 相当）。
  // 外側の "(" から対応する ")" まで、()[]{} の深さを数えて取り込むため、入れ子の
  // 括弧やアロー関数本体 `{...}`、引数内の ";" も1つの引数リストとして正しく扱える
  // （parseAssignment と同じ深さカウント方式）。
  private parseOptionalCallArgs(context: string): string | undefined {
    const open = this.peek();
    if (!(open.type === "punct" && open.text === "(")) return undefined;
    this.next(); // '('
    let depth = 1;
    const parts: string[] = [];
    while (true) {
      const t = this.peek();
      if (t.type === "eof") {
        throw new DisonParseError(`The argument list of ${context} is not closed with a matching ")"`, open.pos);
      }
      if (t.type === "punct" && (t.text === ")" || t.text === "]" || t.text === "}")) {
        depth--;
        if (depth === 0) {
          this.next(); // 対応する ')' を消費（引数テキストには含めない）
          break;
        }
      } else if (t.type === "punct" && (t.text === "(" || t.text === "[" || t.text === "{")) {
        depth++;
      }
      parts.push(this.next().text);
    }
    const args = parts.join("").trim();
    return args === "" ? undefined : args;
  }

  // bindの左辺・右辺で使う「識別子 ＋ 任意の <...>」を読み取る。injectableの
  // 型注釈パーサ（parseTypeExpr）と違い、配列型・ユニオン型・関数型などは
  // 対象外（isSimpleTypeShapeが許容する形にそろえる）。
  // 表示用テキスト（display、元の書き方をそのまま保持。bindType<T>の型引数や
  // new式に使う）と正規化済みキー（key、空白・コメントを除いて連結したもの。
  // TYPE_BINDINGSの照合に使う）の両方を返す。ジェネリクス型引数の中に
  // "=>"（関数型）が含まれるケースの '>' も、parseTypeExprと同じ
  // isArrowTail判定で正しく区別する。
  private parseGenericTypeRef(context: string): { display: string; key: string } {
    const nameTok = this.peek();
    if (nameTok.type !== "ident") {
      throw new DisonParseError(`Expected a type name in ${context} but found "${nameTok.text}"`, nameTok.pos);
    }
    this.next();
    const displayParts: string[] = [nameTok.text];
    const keyParts: string[] = [nameTok.text];

    if (this.peekSignificant(0).type === "punct" && this.peekSignificant(0).text === "<") {
      // 識別子と '<' の間にある空白・コメントはdisplayにだけ積む
      while (this.isTrivia(this.peek())) {
        const trivia = this.next();
        displayParts.push(trivia.text);
      }
      let angleDepth = 0;
      do {
        const t = this.peek();
        if (t.type === "eof") {
          throw new DisonParseError(`The generic type argument in ${context} is not closed with a matching ">" for "<"`, t.pos);
        }
        if (t.type === "punct" && t.text === "<") {
          angleDepth++;
        } else if (t.type === "punct" && t.text === ">") {
          const prev = this.tokens[this.pos - 1];
          const isArrowTail = prev && prev.type === "punct" && prev.text === "=" && prev.pos + prev.text.length === t.pos;
          if (!isArrowTail) angleDepth--;
        }
        const consumed = this.next();
        displayParts.push(consumed.text);
        if (consumed.type !== "whitespace" && consumed.type !== "comment") {
          keyParts.push(consumed.text);
        }
      } while (angleDepth > 0);
    }

    return { display: displayParts.join(""), key: keyParts.join("") };
  }

  // "prop = <式>;" を解析する。<式> は次のトップレベル ";" までを丸ごと式として
  // 取り込むため、識別子だけでなく関数呼び出しやオブジェクトリテラルなども許容できる。
  // 括弧・波カッコ・角カッコの中の ";" には反応しないよう深度を数える。
  private parseAssignment(className: string): { prop: string; valueExpr: string } {
    const propTok = this.next();
    if (propTok.type !== "ident") {
      throw new DisonParseError(
        `Expected a property name inside override "${className}" but found "${propTok.text}"`,
        propTok.pos
      );
    }
    this.skipTrivia();
    this.expectPunct("=", `override "${className}".${propTok.text}`);

    let depth = 0;
    const exprParts: string[] = [];

    while (true) {
      const t = this.peek();
      if (t.type === "eof") {
        throw new DisonParseError(
          `The assignment expression of override "${className}".${propTok.text} is not terminated with ";"`,
          propTok.pos
        );
      }
      if (t.type === "punct" && (t.text === "(" || t.text === "[" || t.text === "{")) depth++;
      if (t.type === "punct" && (t.text === ")" || t.text === "]" || t.text === "}")) depth--;

      if (t.type === "punct" && t.text === ";" && depth === 0) {
        this.next(); // 消費するだけで結果には含めない
        break;
      }
      exprParts.push(this.next().text);
    }

    const valueExpr = exprParts.join("").trim();
    if (valueExpr === "") {
      throw new DisonParseError(`The assignment expression of override "${className}".${propTok.text} is empty`, propTok.pos);
    }
    return { prop: propTok.text, valueExpr };
  }
}
