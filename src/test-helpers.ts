import { transformSync } from "esbuild";
import { transpileDisonToTS } from "./core.js";

// 生成されたTypeScriptを実際に実行してランタイム挙動を検証するためのヘルパー。
// esbuildで型情報を取り除いてCommonJSとして実行する。生成コードは
// import/requireを含まないため、moduleとexportsだけ渡せば十分。
export function runGenerated(disonSource: string): any {
  const ts = transpileDisonToTS(disonSource);
  const { code } = transformSync(ts, { loader: "ts", format: "cjs" });
  const mod: { exports: any } = { exports: {} };
  const fn = new Function("module", "exports", code);
  fn(mod, mod.exports);
  return mod.exports;
}

// resolveType/bindTypeの呼び出しから照合キー文字列を抽出する。
// bind側は bindType<...>("key", ...) の形、injectable側は resolveType("key", ...) の形。
// bindType<T>のTはジェネリクスを含みうる（例: bindType<Repository<User>>(...)）ため、
// 正規表現で単純に ">" を探すと入れ子の "<...>" を誤って途中で閉じたものと
// 誤認識する。そのため角カッコの深さを数えて手動でスキャンする。
export function extractKeys(generatedTs: string): string[] {
  const keys: string[] = [];

  function readStringLiteral(s: string, start: number): { value: string; end: number } | null {
    if (s[start] !== '"') return null;
    let i = start + 1;
    let value = "";
    while (i < s.length && s[i] !== '"') {
      if (s[i] === "\\") {
        value += s[i + 1];
        i += 2;
      } else {
        value += s[i];
        i += 1;
      }
    }
    return { value, end: i + 1 };
  }

  let i = 0;
  while (i < generatedTs.length) {
    if (generatedTs.startsWith("resolveType(", i)) {
      const lit = readStringLiteral(generatedTs, i + "resolveType(".length);
      if (lit) {
        keys.push(lit.value);
        i = lit.end;
        continue;
      }
    }
    if (generatedTs.startsWith("bindType<", i)) {
      let j = i + "bindType<".length;
      let depth = 1;
      while (j < generatedTs.length && depth > 0) {
        if (generatedTs[j] === "<") depth++;
        else if (generatedTs[j] === ">") depth--;
        j++;
      }
      while (j < generatedTs.length && generatedTs[j] !== "(") j++;
      const lit = readStringLiteral(generatedTs, j + 1);
      if (lit) {
        keys.push(lit.value);
        i = lit.end;
        continue;
      }
    }
    i++;
  }

  return keys;
}
