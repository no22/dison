// =====================================================================
// 複数ファイルにまたがる bind/injectable の型名衝突検出（案D）
// =====================================================================

import * as path from "path";
import { Lexer } from "./lexer.js";
import type { BindEntry } from "./ast.js";
import { collectDeclaredTypeKinds, collectImportOrigins, isSimpleTypeShape, baseIdentifierOf } from "./analysis.js";
import { Parser } from "./parser.js";

export interface DisonFileInput {
  path: string;
  source: string;
}

export interface BindCollisionDiagnostic {
  name: string;
  message: string;
}

interface CollisionOccurrence {
  file: string;
  describe: string;
  hasToken: boolean;
  originKey: string | null;
  originLabel: string;
}

// ファイルパスを「絶対パス化し、拡張子を除いた」形に正規化する。
// findBindCollisionsで、あるファイルのローカル宣言と、それを相対パスで
// 正しくimportしている別ファイルとを同じ実体として一致させるために使う
// （拡張子（.dis/.ts/無し）の書き方の違いを吸収する）。
function normalizeExtensionlessAbsolutePath(filePath: string): string {
  const abs = path.resolve(filePath);
  const ext = path.extname(abs);
  return ext ? abs.slice(0, -ext.length) : abs;
}

/**
 * 複数の.disファイルを横断して、`bind`の左辺や`injectable`の型注釈に
 * 使われている型名（クラス/interface/型エイリアスを問わない）の衝突を
 * 検出する（docs/bind-interface-token.md、案D）。
 *
 * 各ファイルをそれぞれパースし、候補となる型名（bindの左辺、および
 * 識別子＋ジェネリクスの形をしたinjectableの型注釈）ごとに、その出現が
 * 「このファイル自身のローカル宣言」か「importならそのspecifier文字列」
 * かという由来を集める。同じ型名について異なる由来が2つ以上見つかった
 * 場合、"as <トークン>" 句が付いていない出現箇所すべてを診断として
 * 返す（衝突が無い、または全出現箇所にトークンが付いていれば空配列）。
 *
 * この検証は複数ファイルの情報が揃って初めて意味を持つため、単一ファイルの
 * `transpileDisonToTS`自体はこのチェックを行わない（CLIが複数ファイルを
 * 処理する際にこの関数を呼び出す）。
 */
export function findBindCollisions(files: DisonFileInput[]): BindCollisionDiagnostic[] {
  const occurrencesByName = new Map<string, CollisionOccurrence[]>();

  for (const file of files) {
    const tokens = new Lexer(file.source).tokenize();
    const typeKinds = collectDeclaredTypeKinds(tokens);
    const importOrigins = collectImportOrigins(tokens);
    const ast = new Parser(tokens, typeKinds).parseProgram();

    const originOf = (name: string): { key: string; label: string } | null => {
      if (typeKinds.classNames.has(name) || typeKinds.nonNewableTypeNames.has(name)) {
        return { key: `P::${normalizeExtensionlessAbsolutePath(file.path)}`, label: `local declaration in ${file.path}` };
      }
      const spec = importOrigins.get(name);
      if (spec !== undefined) {
        if (spec.startsWith(".")) {
          // 相対importは、importしている側のファイルの位置を基準に解決し、
          // 拡張子を除いた絶対パスに正規化する。これにより、あるファイルの
          // ローカル宣言と、それを相対パスで正しくimportしている別ファイルとが、
          // 同じ実体として一致するようになる（無関係な由来だと誤検出しない）。
          const resolved = path.resolve(path.dirname(file.path), spec);
          return {
            key: `P::${normalizeExtensionlessAbsolutePath(resolved)}`,
            label: `import of "${spec}" (from ${file.path})`,
          };
        }
        // bareなパッケージ指定子（"some-package"等）は解決しようがないため、
        // 指定子の文字列そのものを由来とする（異なるパッケージ名は
        // 意図的に別の由来として扱う。docs/bind-interface-token.md 2.4節）。
        return { key: `PKG::${spec}`, label: `import from "${spec}"` };
      }
      return null;
    };

    const record = (name: string, describe: string, hasToken: boolean) => {
      const origin = originOf(name);
      const list = occurrencesByName.get(name) ?? [];
      list.push({
        file: file.path,
        describe,
        hasToken,
        originKey: origin ? origin.key : null,
        originLabel: origin ? origin.label : "unknown origin",
      });
      occurrencesByName.set(name, list);
    };

    const visitBindEntry = (entry: BindEntry, describe: string) => {
      const base = baseIdentifierOf(entry.originalTypeKey);
      record(base, describe, entry.token !== undefined);
    };

    for (const node of ast) {
      if (node.kind === "injectable") {
        if (isSimpleTypeShape(node.typeKey)) {
          record(baseIdentifierOf(node.typeKey), `injectable "${node.propName}"`, node.token !== undefined);
        }
      } else if (node.kind === "configuration") {
        for (const entry of node.entries) {
          if (entry.kind === "bind") {
            visitBindEntry(entry, `bind "${entry.originalTypeName}" inside configuration "${node.name}"`);
          }
        }
      } else if (node.kind === "standalone-bind") {
        visitBindEntry(node.entry, `a standalone bind "${node.entry.originalTypeName}"`);
      }
    }
  }

  const diagnostics: BindCollisionDiagnostic[] = [];

  for (const [name, occurrences] of occurrencesByName) {
    // トークン済みの出現は文字列キーの共有プールから既に抜けているため、
    // 衝突判定・報告のどちらにおいても対象から除外する
    // （そのファイルは既に安全なので、他のファイルが後からトークンを
    // 使い始めても再度フラグされない）。
    const untokened = occurrences.filter((o) => !o.hasToken);
    const distinctOriginKeys = new Set(
      untokened.map((o) => o.originKey).filter((k): k is string => k !== null)
    );
    if (distinctOriginKeys.size <= 1) continue; // 由来が1つ（または不明のみ）なら衝突なし

    const originsDescription = [...new Set(untokened.map((o) => o.originLabel))].join(" / ");
    for (const occ of untokened) {
      diagnostics.push({
        name,
        message:
          `${occ.file}'s ${occ.describe}: type "${name}" is used from multiple origins (${originsDescription})` +
          ` and may collide across files.` +
          ` Use "as <token>" to disambiguate explicitly.`,
      });
    }
  }

  return diagnostics;
}
