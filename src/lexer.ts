// =====================================================================
// 1. Lexer（トークナイザ）
// =====================================================================
//
// ソース全体をトークン列に分解する。文字列リテラルとコメントは中身ごと
// 1トークンとして丸呑みするため、その中の `{` や `injectable` などの
// 文字列がDSLキーワードとして誤検出されることはない。

export type TokenType = "whitespace" | "comment" | "string" | "ident" | "keyword" | "punct" | "eof";

export interface Token {
  type: TokenType;
  text: string;
  pos: number; // ソース内の開始位置（エラー表示用）
}

// DSLとして特別扱いする予約語。
// これら以外の識別子は普通の ident として扱われ、無条件にパススルーされる。
export const KEYWORDS = new Set(["configuration", "override", "injectable", "activate", "bind", "token"]);

export class Lexer {
  private readonly src: string;
  private i = 0;
  private readonly tokens: Token[] = [];

  constructor(src: string) {
    this.src = src;
  }

  tokenize(): Token[] {
    while (this.i < this.src.length) {
      const start = this.i;
      const ch = this.src[this.i];

      // --- 空白・改行 ---
      if (/\s/.test(ch)) {
        while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
        this.emit("whitespace", start);
        continue;
      }

      // --- 行コメント ---
      if (ch === "/" && this.src[this.i + 1] === "/") {
        while (this.i < this.src.length && this.src[this.i] !== "\n") this.i++;
        this.emit("comment", start);
        continue;
      }

      // --- ブロックコメント ---
      if (ch === "/" && this.src[this.i + 1] === "*") {
        this.i += 2;
        while (this.i < this.src.length && !(this.src[this.i] === "*" && this.src[this.i + 1] === "/")) {
          this.i++;
        }
        this.i = Math.min(this.i + 2, this.src.length);
        this.emit("comment", start);
        continue;
      }

      // --- 文字列リテラル（'..' "..", `..`。テンプレートの ${..} 入れ子にも対応） ---
      if (ch === '"' || ch === "'" || ch === "`") {
        const quote = ch;
        this.i++;
        while (this.i < this.src.length && this.src[this.i] !== quote) {
          if (this.src[this.i] === "\\") {
            this.i += 2; // エスケープ文字はまとめて読み飛ばす
            continue;
          }
          if (quote === "`" && this.src[this.i] === "$" && this.src[this.i + 1] === "{") {
            // テンプレートリテラル内の ${ ... } はネスト深度を数えて丸ごとスキップする
            this.i += 2;
            let depth = 1;
            while (this.i < this.src.length && depth > 0) {
              if (this.src[this.i] === "{") depth++;
              else if (this.src[this.i] === "}") depth--;
              this.i++;
            }
            continue;
          }
          this.i++;
        }
        this.i++; // 閉じクォート
        this.emit("string", start);
        continue;
      }

      // --- 識別子 / 予約語 ---
      if (/[A-Za-z_$]/.test(ch)) {
        while (this.i < this.src.length && /[A-Za-z0-9_$]/.test(this.src[this.i])) this.i++;
        const text = this.src.slice(start, this.i);
        this.tokens.push({ type: KEYWORDS.has(text) ? "keyword" : "ident", text, pos: start });
        continue;
      }

      // --- それ以外は1文字ずつ記号トークンとして扱う ---
      this.i++;
      this.emit("punct", start);
    }
    this.tokens.push({ type: "eof", text: "", pos: this.i });
    return this.tokens;
  }

  private emit(type: TokenType, start: number): void {
    this.tokens.push({ type, text: this.src.slice(start, this.i), pos: start });
  }
}
