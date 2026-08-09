// =====================================================================
// 複数ファイルにまたがる bind/injectable の型名衝突検出（案D）
// =====================================================================

import * as path from "path";
import { Lexer } from "./lexer.js";
import type { BindEntry } from "./ast.js";
import {
  collectDeclaredTypeKinds,
  collectImportOrigins,
  collectImportBindings,
  trueInterfaceOrAliasNames,
  identityKeyableClassNames,
  isSimpleTypeShape,
  baseIdentifierOf,
} from "./analysis.js";
import { collectDiUsedTypeNames } from "./codegen.js";
import { collectInheritanceDiagnostics, overridePairKeys } from "./config-inheritance.js";
import { Parser } from "./parser.js";

export interface DisonFileInput {
  path: string;
  source: string;
}

// 他プロジェクトファイルで宣言された interface/型エイリアスを DI で使う際、その
// companion Symbol をどこから import するかの情報（docs/type-identity-matching.md
// 案A(c)）。originalName は宣言元ファイルでの元の export 名（import 側で
// `import { IFoo as Bar }` とエイリアスされていても、companion の名前は元名で決まる）。
export interface CompanionImportInfo {
  specifier: string;
  originalName: string;
}

// 複数ファイルモードで各ファイルの transpile に渡す companion 計画（案A(b)(c)）。
export interface CompanionPlan {
  // このファイルで emit すべき companion（ローカル宣言の真 interface/型エイリアスの
  // うち、プロジェクト内のどこかで DI利用されるもの）。
  companionEmit: Set<string>;
  // このファイルで DI利用される、他プロジェクトファイル由来の interface/型エイリアス。
  // キーはこのファイルでのローカル型名。
  companionImports: Map<string, CompanionImportInfo>;
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
export function normalizeExtensionlessAbsolutePath(filePath: string): string {
  const abs = path.resolve(filePath);
  const ext = path.extname(abs);
  return ext ? abs.slice(0, -ext.length) : abs;
}

// 全入力ファイルから「正規化パス -> そのファイルで宣言された実体キー化可能な
// クラス名（具象 ＋ abstract）の集合」のインデックスを作る。value-importされた
// クラスの実体キー解決に使う。abstract class も実行時に値を持つので含める。
export function buildProjectClassIndex(files: DisonFileInput[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const file of files) {
    const tokens = new Lexer(file.source).tokenize();
    const kinds = collectDeclaredTypeKinds(tokens);
    index.set(normalizeExtensionlessAbsolutePath(file.path), identityKeyableClassNames(kinds));
  }
  return index;
}

// 全入力ファイルから「正規化パス -> そのファイルで宣言された真の interface/型
// エイリアス名の集合」のインデックスを作る（abstract class は含めない＝実体キー側）。
// companion Symbol でキー化する型のクロスファイル解決に使う（案A(b)(c)）。
export function buildProjectInterfaceIndex(files: DisonFileInput[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const file of files) {
    const tokens = new Lexer(file.source).tokenize();
    const kinds = collectDeclaredTypeKinds(tokens);
    index.set(normalizeExtensionlessAbsolutePath(file.path), trueInterfaceOrAliasNames(kinds));
  }
  return index;
}

// あるファイルが「他のプロジェクトファイルから import している真の interface/型
// エイリアス」を、ローカル名 -> {specifier, 元名} で返す。companion は値として別途
// import するため、interface 自体が型onlyインポート（import type）でも対象にする
// （実体キー化するクラスと違い、値importである必要がない。案A(b)(c)）。
export function importedProjectInterfaceLocalNames(
  file: DisonFileInput,
  interfaceIndex: Map<string, Set<string>>
): Map<string, CompanionImportInfo> {
  const result = new Map<string, CompanionImportInfo>();
  const tokens = new Lexer(file.source).tokenize();
  for (const imp of collectImportBindings(tokens)) {
    if (!imp.specifier.startsWith(".")) continue; // 外部パッケージは companion が無いので対象外
    const resolved = normalizeExtensionlessAbsolutePath(path.resolve(path.dirname(file.path), imp.specifier));
    const interfaces = interfaceIndex.get(resolved);
    if (interfaces && interfaces.has(imp.importedName)) {
      result.set(imp.localName, { specifier: imp.specifier, originalName: imp.importedName });
    }
  }
  return result;
}

// あるファイルが「他のプロジェクトファイルからvalue-importしている具象クラス」の
// ローカル名の集合を返す（型onlyインポートや外部パッケージ由来は除く）。
// 宣言元ファイルはそのクラスをローカル宣言として実体キー化するので、import側も
// 同じ実体（ES Modulesの共有束縛）を実体キーにすることで、複数ファイルにまたがる
// bind/injectableが同じキーで一致する（docs/type-identity-matching.md 案A(a)）。
export function importedProjectClassLocalNames(
  file: DisonFileInput,
  classIndex: Map<string, Set<string>>
): Set<string> {
  const names = new Set<string>();
  const tokens = new Lexer(file.source).tokenize();
  for (const imp of collectImportBindings(tokens)) {
    if (imp.typeOnly) continue; // 型onlyインポートは実行時に値が無く実体キーに使えない
    if (!imp.specifier.startsWith(".")) continue; // 外部パッケージは解決しない
    const resolved = normalizeExtensionlessAbsolutePath(path.resolve(path.dirname(file.path), imp.specifier));
    const classes = classIndex.get(resolved);
    if (classes && classes.has(imp.importedName)) names.add(imp.localName);
  }
  return names;
}

/**
 * 複数ファイルモードで、各ファイルの `transpileDisonToTS` に渡す「実体キー化する
 * 追加クラス識別子」の集合を計算する（docs/type-identity-matching.md 案A(a)）。
 *
 * ローカル宣言の具象クラスは `transpileDisonToTS` 側が typeKinds から自動的に
 * 実体キー化するため、ここには含めない。ここで返すのは「他のプロジェクトファイルから
 * value-importされた具象クラスのローカル名」だけ。これにより、宣言元ファイル
 * （ローカル実体キー化）と、それをimportして使う側ファイルの双方が、同じクラス実体を
 * キーに使うようになり、複数ファイルモードでのキー食い違い（サイレントに bind が
 * 効かなくなる回帰）を防ぐ。
 */
export function computeIdentityKeyClassesByFile(files: DisonFileInput[]): Map<string, Set<string>> {
  const classIndex = buildProjectClassIndex(files);
  const result = new Map<string, Set<string>>();
  for (const file of files) {
    result.set(file.path, importedProjectClassLocalNames(file, classIndex));
  }
  return result;
}

/**
 * 複数ファイルモードで、各ファイルの `transpileDisonToTS` に渡す companion 計画を
 * 計算する（docs/type-identity-matching.md 案A(b)(c)）。
 *
 * 真の interface/型エイリアスは実行時に値を持たないため、宣言ごとに一意な companion
 * Symbol を自動生成してキーにする。emit は「プロジェクト内のどこかで DI利用される」
 * ものだけに絞る（案2）。宣言元ファイルが companion を emit・export し、それを
 * import して使う側ファイルには companion の import を注入する。
 *
 * 返り値: ファイルパス -> CompanionPlan（emit するローカル名の集合、import する
 * 他ファイル由来 interface のローカル名 -> {specifier, 元名}）。
 */
export function computeCompanionPlanByFile(files: DisonFileInput[]): Map<string, CompanionPlan> {
  const interfaceIndex = buildProjectInterfaceIndex(files);

  // 各ファイルの前処理（トークン化・パース・ローカル真interface・import解決・DI利用集合）。
  interface Pre {
    file: DisonFileInput;
    normPath: string;
    localTrueInterfaces: Set<string>;
    importedInterfaces: Map<string, CompanionImportInfo>;
    diUsed: Set<string>;
  }
  const pre: Pre[] = files.map((file) => {
    const tokens = new Lexer(file.source).tokenize();
    const kinds = collectDeclaredTypeKinds(tokens);
    const ast = new Parser(tokens, kinds).parseProgram();
    return {
      file,
      normPath: normalizeExtensionlessAbsolutePath(file.path),
      localTrueInterfaces: trueInterfaceOrAliasNames(kinds),
      importedInterfaces: importedProjectInterfaceLocalNames(file, interfaceIndex),
      diUsed: collectDiUsedTypeNames(ast),
    };
  });

  // プロジェクト全体で DI利用される interface/型エイリアスの「宣言」の集合
  // （declKey = 正規化パス::元名）。ローカル利用・import 利用の両方から集める。
  const globalDiUsedDecls = new Set<string>();
  for (const p of pre) {
    for (const name of p.diUsed) {
      if (p.localTrueInterfaces.has(name)) {
        globalDiUsedDecls.add(`${p.normPath}::${name}`);
      } else {
        const imp = p.importedInterfaces.get(name);
        if (imp) {
          const declPath = normalizeExtensionlessAbsolutePath(
            path.resolve(path.dirname(p.file.path), imp.specifier)
          );
          globalDiUsedDecls.add(`${declPath}::${imp.originalName}`);
        }
      }
    }
  }

  const result = new Map<string, CompanionPlan>();
  for (const p of pre) {
    // emit: このファイルのローカル真interfaceのうち、プロジェクト内のどこかで DI利用
    // されるもの。
    const companionEmit = new Set<string>();
    for (const name of p.localTrueInterfaces) {
      if (globalDiUsedDecls.has(`${p.normPath}::${name}`)) companionEmit.add(name);
    }
    // import: このファイルで DI利用される、他ファイル由来の interface。
    const companionImports = new Map<string, CompanionImportInfo>();
    for (const [localName, info] of p.importedInterfaces) {
      if (p.diUsed.has(localName)) companionImports.set(localName, info);
    }
    result.set(p.file.path, { companionEmit, companionImports });
  }
  return result;
}

/**
 * 複数ファイルモードのクロスファイルキー不一致検出（docs/cross-file-key-mismatch.md、
 * 仕様監査2026-07 #4）。
 *
 * このファイルで文字列キーに落ちる（またはキー評価が失敗し続ける）裸の識別子が、
 * 他のプロジェクトファイルでは identity（クラス実体）/companion Symbol でキー化される
 * 宣言を持つ場合、キーは決して一致せず bind/override が黙って無効になる。これを
 * transpile時エラーとして検出する。
 *
 * 対象サイト: bindの左辺・差し替え先、override対象クラス、injectableの型注釈
 * （いずれも "as トークン" なしの裸の識別子のみ）。判定:
 *   - ローカル宣言あり / value-import済み → 安全（identity/companion側でキー化）。
 *   - type-only import されたプロジェクトのクラス → エラー（実体キーには値が必要。
 *     "type" を外すよう案内）。interface の type-only import は companion の既存機構
 *     （importedProjectInterfaceLocalNames が typeOnly も対象にする）で解決されるので安全。
 *   - importなしで他プロジェクトファイルにクラス/interface宣言あり → エラー
 *     （importするか as トークンを案内）。
 *   - どこにも宣言なし → 対象外（外部パッケージ型の文字列キーは正当。純粋な
 *     タイプミスは従来どおりtscの担当。const代入クラス等ヒューリスティックで
 *     追えない宣言形への誤検出を避けるための線引き）。
 */
export function findCrossFileKeyMismatches(files: DisonFileInput[]): BindCollisionDiagnostic[] {
  const classIndex = buildProjectClassIndex(files);
  const interfaceIndex = buildProjectInterfaceIndex(files);
  const diagnostics: BindCollisionDiagnostic[] = [];

  for (const file of files) {
    const tokens = new Lexer(file.source).tokenize();
    const typeKinds = collectDeclaredTypeKinds(tokens);
    const ast = new Parser(tokens, typeKinds).parseProgram();
    const normSelf = normalizeExtensionlessAbsolutePath(file.path);

    // このファイル内に何らかの宣言がある名前（クラス/abstract/interface/型エイリアス）。
    // ローカル宣言があればそのファイル内では identity/companion 側でキー化される。
    const localNames = new Set([...typeKinds.classNames, ...typeKinds.nonNewableTypeNames]);
    const importsByLocalName = new Map(collectImportBindings(tokens).map((b) => [b.localName, b]));

    // 他プロジェクトファイルで name を宣言しているファイルを探す。
    const declaredElsewhere = (name: string): { file: string; kind: "class" | "interface" }[] => {
      const out: { file: string; kind: "class" | "interface" }[] = [];
      for (const g of files) {
        const normG = normalizeExtensionlessAbsolutePath(g.path);
        if (normG === normSelf) continue;
        if (classIndex.get(normG)?.has(name)) out.push({ file: g.path, kind: "class" });
        else if (interfaceIndex.get(normG)?.has(name)) out.push({ file: g.path, kind: "interface" });
      }
      return out;
    };

    const check = (typeKey: string, hasToken: boolean, site: string): void => {
      if (hasToken) return;
      const name = baseIdentifierOf(typeKey);
      if (name !== typeKey) return; // ジェネリクス等の複合型は文字列キーが正当
      if (localNames.has(name)) return;
      const imp = importsByLocalName.get(name);
      if (imp !== undefined && !imp.typeOnly) return; // value-import済み（外部パッケージ含め安全）

      if (imp !== undefined && imp.typeOnly) {
        // type-only import: 宣言元がプロジェクトのクラスの場合のみ問題
        // （interfaceのtype-only importはcompanion機構が解決する。外部パッケージは文字列キーで一貫）。
        if (!imp.specifier.startsWith(".")) return;
        const resolved = normalizeExtensionlessAbsolutePath(
          path.resolve(path.dirname(file.path), imp.specifier)
        );
        if (classIndex.get(resolved)?.has(imp.importedName)) {
          diagnostics.push({
            name,
            message:
              `${file.path}'s ${site}: "${name}" is imported type-only from "${imp.specifier}", ` +
              `but it is a class matched by identity there — an identity key needs the runtime value. ` +
              `Remove "type" from the import.`,
          });
        }
        return;
      }

      // importなし: 他プロジェクトファイルの宣言と同名なら、文字列キーは決して一致しない。
      const decls = declaredElsewhere(name);
      if (decls.length === 0) return;
      const where = decls.map((d) => `${d.file} (as a ${d.kind})`).join(", ");
      diagnostics.push({
        name,
        message:
          `${file.path}'s ${site}: "${name}" is declared in ${where} and matched by ` +
          `${decls[0].kind === "class" ? "class identity" : "a companion Symbol"} there, ` +
          `but this file neither declares nor imports it, so it would fall back to a string key ` +
          `that can never match. Import it from the declaring file, or key both sides explicitly ` +
          `with "as <token>".`,
      });
    };

    const visitBind = (entry: BindEntry, label: string): void => {
      check(entry.originalTypeKey, entry.token !== undefined, `bind "${entry.originalTypeName}" (${label})`);
      check(entry.replacementTypeKey, false, `bind replacement "${entry.replacementTypeName}" (${label})`);
    };

    for (const node of ast) {
      if (node.kind === "injectable") {
        check(node.typeKey, node.token !== undefined, `injectable "${node.propName}"`);
      } else if (node.kind === "configuration") {
        const label = node.name !== undefined ? `configuration "${node.name}"` : "anonymous configuration";
        for (const entry of node.entries) {
          if (entry.kind === "bind") visitBind(entry, label);
          else check(entry.className, false, `override "${entry.className}" (${label})`);
        }
      } else if (node.kind === "standalone-bind") {
        visitBind(node.entry, "standalone");
      } else if (node.kind === "standalone-override") {
        check(node.entry.className, false, `override "${node.entry.className}" (standalone)`);
      }
    }
  }

  return diagnostics;
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

  // 実体キー化される具象/abstractクラス、および companion Symbol でキー化される
  // interface/型エイリアスは、文字列キーの共有プールに載らないため衝突しない
  // （前者は宣言ごとに別の実体、後者は宣言ごとに別の Symbol がキーになる）。よって
  // 衝突検出の対象から除外する。残るのは文字列キーのまま（外部パッケージ由来の
  // interface/型エイリアスなど、companion を import できないもの）だけ。
  // (docs/type-identity-matching.md 案A(a)(b))。
  const classIndex = buildProjectClassIndex(files);
  const interfaceIndex = buildProjectInterfaceIndex(files);

  for (const file of files) {
    const tokens = new Lexer(file.source).tokenize();
    const typeKinds = collectDeclaredTypeKinds(tokens);
    const importOrigins = collectImportOrigins(tokens);
    const ast = new Parser(tokens, typeKinds).parseProgram();

    // このファイルで実体キー化される裸のクラス識別子（ローカル具象＋abstract ∪
    // value-importされたプロジェクトのクラス）。
    const identityClasses = identityKeyableClassNames(typeKinds);
    for (const n of importedProjectClassLocalNames(file, classIndex)) identityClasses.add(n);

    // このファイルで companion Symbol でキー化される裸の interface/型エイリアス識別子
    // （ローカル宣言の真interface ∪ 他プロジェクトファイル由来の import）。
    const companionTypes = trueInterfaceOrAliasNames(typeKinds);
    for (const localName of importedProjectInterfaceLocalNames(file, interfaceIndex).keys()) {
      companionTypes.add(localName);
    }

    // 型が実体参照 or companion でキー化されるか（＝文字列プールに載らず衝突対象外か）。
    // キー化は「as トークンなし」かつ「ジェネリクスを含まない裸の識別子」のときだけ
    // 効く。keyExprFor（codegen）と同じ条件。
    const isNonStringKeyed = (typeKey: string, hasToken: boolean): boolean => {
      if (hasToken) return false;
      const base = baseIdentifierOf(typeKey);
      if (base !== typeKey) return false;
      return identityClasses.has(base) || companionTypes.has(base);
    };

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
      // 実体キー or companion でキー化される bind 左辺は衝突しないので記録しない。
      if (isNonStringKeyed(entry.originalTypeKey, entry.token !== undefined)) return;
      const base = baseIdentifierOf(entry.originalTypeKey);
      record(base, describe, entry.token !== undefined);
    };

    for (const node of ast) {
      if (node.kind === "injectable") {
        // 実体キー or companion でキー化される injectable 型は衝突しないので記録しない。
        if (isSimpleTypeShape(node.typeKey) && !isNonStringKeyed(node.typeKey, node.token !== undefined)) {
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


/**
 * 複数ファイルモードで、`configuration ... extends X` がファイルを跨ぐ場合の計画
 * （docs/configuration-inheritance.md §3.2）。companion 計画と同じ位置づけで CLI が計算し、
 * 各ファイルの transpile に渡す。
 *
 *   - applierEmit: そのファイルが export すべき applier（__dison_config_X）の名前。
 *     他ファイルのローカル/クラススコープへ展開される configuration が対象。
 *   - extendsImports: そのファイルが import すべき参照（フレーム展開なら applier、
 *     グローバル展開なら activateX）。
 */
export interface ConfigExtendsPlan {
  applierEmit: Set<string>;
  extendsImports: Map<string, { specifier: string; needsApplier: boolean }>;
}

export function computeConfigExtendsPlanByFile(files: DisonFileInput[]): Map<string, ConfigExtendsPlan> {
  interface Pre {
    file: DisonFileInput;
    norm: string;
    ast: ReturnType<Parser["parseProgram"]>;
    named: Map<string, Extract<ReturnType<Parser["parseProgram"]>[number], { kind: "configuration" }>>;
  }
  const pre: Pre[] = files.map((file) => {
    const tokens = new Lexer(file.source).tokenize();
    const kinds = collectDeclaredTypeKinds(tokens);
    const ast = new Parser(tokens, kinds).parseProgram();
    const named = new Map<string, any>();
    for (const n of ast) {
      if (n.kind === "configuration" && n.scope === "global" && n.name !== undefined) named.set(n.name, n);
    }
    return { file, norm: normalizeExtensionlessAbsolutePath(file.path), ast, named };
  });

  const declOf = (name: string, from: Pre): Pre | undefined =>
    from.named.has(name) ? from : pre.find((p) => p.named.has(name));

  const result = new Map<string, ConfigExtendsPlan>();
  for (const p of pre) result.set(p.file.path, { applierEmit: new Set(), extendsImports: new Map() });

  // `activate X from "./p"` が指定した specifier（脱糖後は configuration の extendsFrom）。
  const explicitFrom = new Map<string, string>();
  for (const p of pre) {
    for (const n of p.ast) {
      if (n.kind !== "configuration") continue;
      for (const [name, spec] of Object.entries((n as any).extendsFrom ?? {})) {
        explicitFrom.set(`${p.norm}::${name}`, spec as string);
      }
    }
  }

  // 参照を辿り、必要な applier / import を積む。継承は推移するので親も辿る。
  const need = (name: string, from: Pre, asApplier: boolean, stack: string[]): void => {
    if (stack.includes(name)) return;
    const decl = declOf(name, from);
    if (decl === undefined) return;
    if (asApplier) result.get(decl.file.path)!.applierEmit.add(name);
    if (decl.norm !== from.norm) {
      // `activate X from "./p"` 由来の specifier があればそれを優先する
      // （利用者が明示したパス。docs/activate-sugar-implementation.md §2.1）。
      const explicit = explicitFrom.get(`${from.norm}::${name}`);
      const rel = explicit ?? relativeSpecifier(from.file.path, decl.norm);
      const plan = result.get(from.file.path)!;
      const existing = plan.extendsImports.get(name);
      plan.extendsImports.set(name, {
        specifier: rel,
        needsApplier: asApplier || existing?.needsApplier === true,
      });
    }
    // 親も同じ形（applier が要るなら親の applier も要る）で辿る。
    const node = decl.named.get(name)!;
    for (const parent of node.extendsNames ?? []) need(parent, decl, asApplier, [...stack, name]);
  };

  for (const p of pre) {
    for (const n of p.ast) {
      if (n.kind !== "configuration") continue;
      const frameForm = n.scope !== "global";
      for (const parent of n.extendsNames ?? []) need(parent, p, frameForm, []);
    }
  }
  return result;
}

// import specifier を組み立てる（プロジェクト内 import の拡張子スタイルは
// 静的解決側と同様に "./x" 形を既定にする）。
function relativeSpecifier(fromFile: string, toNorm: string): string {
  let rel = path.relative(path.dirname(fromFile), toNorm).split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}


/**
 * 複数ファイルモードでの configuration 継承の診断（未解決の親・循環・兄弟衝突）。
 * docs/configuration-inheritance.md §2.2/§2.3。
 */
export function findConfigInheritanceDiagnostics(files: DisonFileInput[]): BindCollisionDiagnostic[] {
  interface Pre {
    file: DisonFileInput;
    norm: string;
    ast: ReturnType<Parser["parseProgram"]>;
    named: Map<string, any>;
    identityClasses: Set<string>;
    companionTypes: Set<string>;
  }
  const classIndex = buildProjectClassIndex(files);
  const interfaceIndex = buildProjectInterfaceIndex(files);
  const pre: Pre[] = files.map((file) => {
    const tokens = new Lexer(file.source).tokenize();
    const kinds = collectDeclaredTypeKinds(tokens);
    const ast = new Parser(tokens, kinds).parseProgram();
    const named = new Map<string, any>();
    for (const n of ast) {
      if (n.kind === "configuration" && n.scope === "global" && n.name !== undefined) named.set(n.name, n);
    }
    const identityClasses = identityKeyableClassNames(kinds);
    for (const n of importedProjectClassLocalNames(file, classIndex)) identityClasses.add(n);
    const companionTypes = trueInterfaceOrAliasNames(kinds);
    for (const localName of importedProjectInterfaceLocalNames(file, interfaceIndex).keys()) {
      companionTypes.add(localName);
    }
    return { file, norm: normalizeExtensionlessAbsolutePath(file.path), ast, named, identityClasses, companionTypes };
  });

  const resolve = (name: string, from: Pre) => {
    const own = from.named.get(name);
    if (own !== undefined) return { node: own, file: from };
    const other = pre.find((p) => p.named.has(name));
    return other !== undefined ? { node: other.named.get(name)!, file: other } : undefined;
  };

  // キーはプロジェクト横断で比較できる形（宣言ファイル::名前）に寄せる。
  const declSite = (p: Pre, name: string): string => {
    if (p.identityClasses.has(name) || p.companionTypes.has(name)) {
      const tokens = new Lexer(p.file.source).tokenize();
      for (const imp of collectImportBindings(tokens)) {
        if (imp.localName !== name || !imp.specifier.startsWith(".")) continue;
        const resolved = normalizeExtensionlessAbsolutePath(
          path.resolve(path.dirname(p.file.path), imp.specifier)
        );
        if (classIndex.has(resolved) || interfaceIndex.has(resolved)) return `${resolved}::${imp.importedName}`;
      }
      return `${p.norm}::${name}`;
    }
    return name;
  };

  const diagnostics: BindCollisionDiagnostic[] = [];
  const seen = new Set<string>();
  for (const p of pre) {
    for (const d of collectInheritanceDiagnostics<Pre>(p.ast, p, resolve, {
      bindKey: (entry, f) => `bind ${declSite(f, baseIdentifierOf(entry.originalTypeKey))}${entry.token ?? ""}`,
      overrideKeys: (entry, f) => overridePairKeys(declSite(f, entry.className), entry),
    })) {
      const message = `${p.file.path}: ${d.message}`;
      if (seen.has(message)) continue;
      seen.add(message);
      diagnostics.push({ name: "configuration", message });
    }
  }
  return diagnostics;
}
