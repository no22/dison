// =====================================================================
// injectable の束縛被覆チェック（既定初期化式の省略を許すための検査）
// =====================================================================
//
// docs/injectable-default-relaxation.md の実装。
//
// `injectable repo: IRepository;`（new できない単純形の型・既定初期化式なし）は、
// **構文的に無条件な束縛**がそのキーに存在する場合にだけ書ける。無ければ transpile
// エラーにする（解決失敗を実行時エラーにしない、という監査以来の原則）。
//
// 「構文的に無条件」= 位置・バリア・評価順に依存しない性質だけで判定する（§1.2）:
//   1. トップレベルの無名 configuration の bind
//   2. トップレベルの standalone bind
//   3. トップレベル（条件分岐の外）の activate X — X の平坦化済みエントリ
//   4. トップレベル（条件分岐の外）の configuration extends X {} — 同上
//   5. 受け手クラスの継承鎖上にあるクラススコープ configuration の bind
//   6. 同じ (受け手クラス鎖, プロパティ) への上記スコープの override
//
// 静的解決が「畳めるか」とは独立（畳めるかを合法性の判定に使うと、無関係な編集で
// ビルドが壊れる。§1.1）。

import * as path from "path";
import { Lexer } from "./lexer.js";
import type { Token } from "./lexer.js";
import { Parser } from "./parser.js";
import type { Node, ConfigEntry } from "./ast.js";
import {
  collectDeclaredTypeKinds,
  collectImportBindings,
  collectBlockContext,
  trueInterfaceOrAliasNames,
  identityKeyableClassNames,
  isNonNewableSimpleType,
  baseIdentifierOf,
  type DeclaredTypeKinds,
} from "./analysis.js";
import { flattenConfiguration, namedGlobalConfigurations, type ConfigurationNode } from "./config-inheritance.js";
import { collectTopLevelClasses, enclosingTopLevelClass, type ClassInfo } from "./static-wiring.js";
import type { DisonFileInput, BindCollisionDiagnostic } from "./collisions.js";
import { normalizeExtensionlessAbsolutePath } from "./collisions.js";

interface FileState {
  path: string;
  norm: string;
  tokens: Token[];
  ast: Node[];
  typeKinds: DeclaredTypeKinds;
  classes: Map<string, ClassInfo>;
  isTopLevel: (idx: number) => boolean;
  importsByLocalName: Map<string, { importedName: string; specifier: string }>;
  namedConfigs: Map<string, ConfigurationNode>;
}

function analyze(file: DisonFileInput): FileState {
  const tokens = new Lexer(file.source).tokenize();
  const typeKinds = collectDeclaredTypeKinds(tokens);
  const ast = new Parser(tokens, typeKinds).parseProgram();
  const blockContext = collectBlockContext(tokens);
  return {
    path: file.path,
    norm: normalizeExtensionlessAbsolutePath(file.path),
    tokens,
    ast,
    typeKinds,
    classes: collectTopLevelClasses(tokens),
    isTopLevel: (i: number) => blockContext.isTopLevel(i),
    importsByLocalName: new Map(
      collectImportBindings(tokens).map((b) => [b.localName, { importedName: b.importedName, specifier: b.specifier }])
    ),
    namedConfigs: namedGlobalConfigurations(ast),
  };
}

// 型名を「宣言サイト」へ正規化する。プロジェクト内で宣言が特定できれば
// "<宣言ファイル>::<名前>"、できなければ名前そのもの（外部型・未解決）。
// injectable 側と bind 側で同じ関数を通すことで、別名 import 越しでも一致する。
function declSiteOf(fs: FileState, name: string, byNorm: Map<string, FileState>): string {
  const declaresLocally =
    fs.typeKinds.classNames.has(name) || fs.typeKinds.nonNewableTypeNames.has(name);
  if (declaresLocally) return `${fs.norm}::${name}`;
  const imp = fs.importsByLocalName.get(name);
  if (imp !== undefined && imp.specifier.startsWith(".")) {
    const resolved = normalizeExtensionlessAbsolutePath(path.resolve(path.dirname(fs.path), imp.specifier));
    if (byNorm.has(resolved)) return `${resolved}::${imp.importedName}`;
  }
  return name;
}

/**
 * 既定初期化式を省略した injectable のうち、無条件な束縛が見つからないものを報告する。
 * ファイル1件で呼べば単一ファイルモード、複数件で呼べばプロジェクト全体の検査になる。
 */
export function findUnboundInjectables(files: DisonFileInput[]): BindCollisionDiagnostic[] {
  const states = files.map(analyze);
  const byNorm = new Map(states.map((s) => [s.norm, s]));

  // --- 無条件に適用される束縛の収集 ---
  // グローバル層: 宣言サイトの集合（bind）と (クラス宣言サイト, プロパティ) の集合（override）。
  const globalBoundKeys = new Set<string>();
  const globalOverridePairs = new Set<string>();
  // クラススコープ層: クラス宣言サイト → 束縛キー / プロパティ。
  const classBoundKeys = new Map<string, Set<string>>();
  const classOverridePairs = new Map<string, Set<string>>();

  const resolveConfig = (name: string, from: FileState) => {
    const own = from.namedConfigs.get(name);
    if (own !== undefined) return { node: own, file: from };
    for (const s of states) {
      const n = s.namedConfigs.get(name);
      if (n !== undefined) return { node: n, file: s };
    }
    return undefined;
  };

  const flatten = (node: ConfigurationNode, fs: FileState): { entry: ConfigEntry; fs: FileState }[] =>
    flattenConfiguration<FileState>(node, fs, resolveConfig).entries.map((fe) => ({
      entry: fe.entry,
      fs: fe.file,
    }));

  const addGlobal = (flat: { entry: ConfigEntry; fs: FileState }[]): void => {
    for (const { entry, fs } of flat) {
      if (entry.kind === "bind") {
        globalBoundKeys.add(declSiteOf(fs, baseIdentifierOf(entry.originalTypeKey), byNorm));
        if (entry.token !== undefined) globalBoundKeys.add(`token::${entry.token}`);
      } else {
        const cls = declSiteOf(fs, entry.className, byNorm);
        for (const a of entry.assignments) globalOverridePairs.add(`${cls} ${a.prop}`);
      }
    }
  };
  const addClassScope = (
    ownerDeclSite: string,
    flat: { entry: ConfigEntry; fs: FileState }[]
  ): void => {
    for (const { entry, fs } of flat) {
      if (entry.kind === "bind") {
        let s = classBoundKeys.get(ownerDeclSite);
        if (s === undefined) {
          s = new Set();
          classBoundKeys.set(ownerDeclSite, s);
        }
        s.add(declSiteOf(fs, baseIdentifierOf(entry.originalTypeKey), byNorm));
        if (entry.token !== undefined) s.add(`token::${entry.token}`);
      } else {
        let s = classOverridePairs.get(ownerDeclSite);
        if (s === undefined) {
          s = new Set();
          classOverridePairs.set(ownerDeclSite, s);
        }
        for (const a of entry.assignments) s.add(a.prop);
      }
    }
  };

  for (const fs of states) {
    for (const node of fs.ast) {
      const pos = (node as { tokenPos?: number }).tokenPos ?? 0;
      if (node.kind === "configuration") {
        const flat =
          node.extendsNames === undefined && node.extendsSelections === undefined
            ? node.entries.map((entry) => ({ entry, fs }))
            : flatten({ ...node, extendsSelections: undefined }, fs);
        // 実行時選択は「どの葉が選ばれても束縛される」キーだけが保証される。
        // 全葉の平坦化結果の**積集合**を取る（docs/activate-sugar-implementation.md §1.5）。
        if (node.extendsSelections !== undefined && node.scope === "global" && node.name === undefined) {
          for (const sel of node.extendsSelections) {
            const perLeaf = sel.leaves.map((leaf) => {
              const decl = resolveConfig(leaf, fs);
              return decl === undefined ? [] : flatten(decl.node, decl.file);
            });
            if (perLeaf.length === 0 || perLeaf.some((l) => l.length === 0)) continue;
            const keyOf = (x: { entry: ConfigEntry; fs: FileState }): string =>
              x.entry.kind === "bind"
                ? `bind ${declSiteOf(x.fs, baseIdentifierOf(x.entry.originalTypeKey), byNorm)}${x.entry.token ?? ""}`
                : `override ${declSiteOf(x.fs, x.entry.className, byNorm)}`;
            const common = perLeaf[0].filter((x) =>
              perLeaf.every((leafEntries) => leafEntries.some((y) => keyOf(y) === keyOf(x)))
            );
            addGlobal(common);
          }
        }
        if (node.scope === "global" && node.name === undefined) {
          addGlobal(flat); // 1・4: 無名グローバル（extends 付きも含む）は auto-active
        } else if (node.scope === "class") {
          const owner = enclosingTopLevelClass(fs.tokens, fs.classes, pos);
          if (owner !== null) addClassScope(`${fs.norm}::${owner}`, flat); // 5・6
        }
        // 名前付きグローバルの定義自体は無条件ではない（activate されて初めて効く）。
      } else if (node.kind === "activate") {
        if (!fs.isTopLevel(pos)) continue; // 条件分岐・関数内 → 無条件ではない
        if (node.fromPath !== undefined) {
          const resolved = normalizeExtensionlessAbsolutePath(
            path.resolve(path.dirname(fs.path), node.fromPath)
          );
          const declFs = byNorm.get(resolved);
          const cfg = declFs?.namedConfigs.get(node.name);
          if (declFs !== undefined && cfg !== undefined) addGlobal(flatten(cfg, declFs)); // 3
          continue;
        }
        const decl = resolveConfig(node.name, fs);
        if (decl !== undefined) addGlobal(flatten(decl.node, decl.file)); // 3
      } else if (node.kind === "standalone-bind") {
        if (fs.isTopLevel(pos)) addGlobal([{ entry: node.entry, fs }]); // 2
      } else if (node.kind === "standalone-override") {
        if (fs.isTopLevel(pos)) addGlobal([{ entry: node.entry, fs }]);
      }
    }
  }

  // --- injectable 側の検査 ---
  const diagnostics: BindCollisionDiagnostic[] = [];

  for (const fs of states) {
    const chainOf = (className: string): string[] => {
      const out: string[] = [];
      let cur: string | undefined = className;
      const seen = new Set<string>();
      while (cur !== undefined && !seen.has(cur)) {
        seen.add(cur);
        out.push(`${fs.norm}::${cur}`);
        const info = fs.classes.get(cur);
        if (info === undefined || info.opaqueHeritage) break;
        cur = info.baseName ?? undefined;
      }
      return out;
    };

    for (const node of fs.ast) {
      if (node.kind !== "injectable") continue;
      if (node.defaultExpr !== undefined) continue;
      if (!isNonNewableSimpleType(node.typeKey, fs.typeKinds)) continue; // new できる型は対象外

      const keySite =
        node.token !== undefined
          ? `token::${node.token}`
          : declSiteOf(fs, baseIdentifierOf(node.typeKey), byNorm);
      if (globalBoundKeys.has(keySite)) continue;

      const owner = node.tokenPos !== undefined ? enclosingTopLevelClass(fs.tokens, fs.classes, node.tokenPos) : null;
      const chain = owner !== null ? chainOf(owner) : [];
      if (chain.some((c) => globalOverridePairs.has(`${c} ${node.propName}`))) continue;
      if (chain.some((c) => classBoundKeys.get(c)?.has(keySite) === true)) continue;
      if (chain.some((c) => classOverridePairs.get(c)?.has(node.propName) === true)) continue;

      const where = owner !== null ? `class ${owner}` : "a class";
      diagnostics.push({
        name: node.propName,
        message:
          `${fs.path}: injectable "${node.propName}" of ${where} has type "${node.typeName}", which cannot be ` +
          `created with "new", and no binding for it is guaranteed to be active. ` +
          `Add a default initializer (injectable ${node.propName}: ${node.typeName} = <expression>;), ` +
          `or bind it unconditionally, e.g. a top-level "configuration { bind ${node.typeName} = <Implementation>; }".`,
      });
    }
  }

  return diagnostics;
}
