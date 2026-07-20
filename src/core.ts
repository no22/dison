/**
 * Dison言語 トランスパイラ 公開API
 * -----------------------------------------------------------
 * 方針:
 *   1. Lexer   : ソース全体をトークン列に分解する（./lexer）。
 *                文字列リテラルとコメントは中身ごと1トークンとして
 *                丸呑みするため、その中の `{` や `injectable` などの
 *                文字列がDSLキーワードとして誤検出されることはない。
 *   2. Parser  : トークン列を読み、`configuration` / `override` /
 *                `injectable` だけを構造的に解釈する（./parser）。
 *                それ以外はすべて Raw ノードとして完全にそのまま通す
 *                （改行・スペース・コメントも100%保持）。
 *   3. CodeGen : ASTからTypeScriptソースを再構築する（./codegen）。
 *
 * このファイルは各モジュール（lexer/ast/analysis/parser/codegen/runtime/
 * collisions）を束ね、公開API（transpileDisonToTS、findBindCollisions等）
 * を提供する薄い入り口。実装の詳細はそれぞれのモジュールを参照。
 * -----------------------------------------------------------
 *
 * 注意（override代入値のセマンティクス）:
 *   `override` ブロック内の `プロパティ = 式;` の右辺は、
 *   TypeScriptの式としてそのまま評価されます。クラス名を
 *   インスタンス化したい場合は必ず `new ClassName()` と明記してください。
 *
 *     database = MockUserRepository;      // ✗ クラスの「参照」そのものが入る
 *                                          //   (this.database.findById が
 *                                          //   存在せず実行時エラーになる)
 *     database = new MockUserRepository(); // ○ 意図通りインスタンスが入る
 *
 *   `new` の書き忘れを自動補完する変換は行っていません
 *   （意図的な設計判断。関数呼び出し式やファクトリ式などを
 *   自由に書けるようにするため、単純な識別子だけを特別扱いしない方針）。
 *
 * configurationの有効化:
 *   `activateXxx()` を直接呼ぶ代わりに、専用構文 `activate ConfigName;` を
 *   使うことを推奨します（`activateConfigName();` に変換されます）。
 *   存在しないconfiguration名を指定した場合はパース時にエラーになります。
 *
 *     configuration TestConfig { ... }
 *     activate TestConfig;   // OK
 *     activate TypoConfig;   // ✗ パースエラー（定義されていない）
 *
 *   他ファイルのconfigurationをactivateする場合、`activate Name from
 *   "path";` という構文で、利用者が`activateName`という生成後の関数名を
 *   意識せずに済む（複数ファイル対応フェーズ2、docs/activate-from-syntax.md）。
 *
 *     activate TestConfig from "./configs";
 *
 *   `from`句が使われている場合、対応する`import { activateTestConfig }
 *   from "./configs";`をファイル先頭にまとめて出力し（ES Modulesの
 *   importはファイル先頭にしか書けないため）、`activate`が書かれた位置
 *   自体には呼び出し文だけを残す。異なるパスが同じconfiguration名を
 *   持つ場合はエイリアス（`activateTestConfig_2`等）で衝突を自動的に
 *   回避する。`from`がある場合、Dison側ではそのパス先の中身を読まない
 *   ため存在確認はできず、タイプミス検出は`tsc`自身のimport解決に委ねる
 *   （`from`が無い場合は従来通り同一ファイル内の定義/importで検証する）。
 *
 *   `activate`は関数呼び出し文に脱糖されるため、injectable/configuration
 *   のような「宣言」と違い文が書ける場所ならどこでも良いが、クラス本体の
 *   直下（メソッドの外）だけは書けない（単独override/bindと同じ制約。
 *   以前はこの構造的位置制約作業（後述）で見落としていた既存バグだった）。
 *
 * クラス単位の横断的な差し替え（bind）:
 *   `override` はクラス内の特定プロパティ1つだけを差し替えるのに対し、
 *   `bind` は「その型が要求される場所すべて」を横断的に差し替える。
 *   右辺は override と異なり任意の式ではなく、単一の型参照（具象クラス、
 *   ジェネリクス可）＋任意のコンストラクタ引数リストのみを許可し、
 *   トランスパイラが自動的に `new Replacement(args)` を補う（引数は省略可。
 *   docs/bind-constructor-arguments.md）。
 *
 *     configuration TestConfig {
 *       bind SqlUserRepository = MockUserRepository;
 *       bind Repository = PostgresRepository("postgres://...");  // 引数あり
 *     }
 *
 *   左辺（差し替え元）はクラスだけでなく interface / type エイリアスも許可される。
 *   実行時には存在しない型でも、TypeScript の型引数としてのみ扱うことで
 *   問題なく渡せる。右辺は `new` で実体化する必要があるため、実質的に
 *   具象クラスに限定される（interfaceを右辺に書くとtscがコンパイルエラーにする）。
 *
 *     interface IUserRepository { findById(id: string): void; }
 *     configuration TestConfig {
 *       bind IUserRepository = SqlUserRepository;
 *     }
 *
 *   型安全性は自前で検証せず、生成される `bindType<T>()` 呼び出しの
 *   ジェネリクス（明示的な型引数）をTypeScript自身の型チェッカーに委ねている。
 *   差し替え先クラスが差し替え元と型互換でなければ tsc がコンパイルエラーにする。
 *
 *   ジェネリクス対応: 左辺・右辺とも `Repository<User>` のような、具体的な
 *   型引数を指定した閉じたジェネリクスを書ける（`Repository<T>` のように
 *   任意の型引数に適用されるオープンジェネリクスのバインドは非対応。
 *   docs/bind-generics.md 参照）。
 *
 *     configuration TestConfig {
 *       bind Repository<User> = SqlUserRepository;
 *       bind Repository<Admin> = SqlAdminRepository;
 *     }
 *
 *   照合キーの正規化: injectable の型注釈も bind の左辺・右辺も、
 *   TYPE_BINDINGS に登録・参照する際のキーは「空白・コメントを除いた
 *   トークン列を連結した正規化済みの文字列」を使う（`typeKey`。生成コードの
 *   型注釈として出力する文字列 `typeName` とは別に保持している）。単一の
 *   識別子には内部に空白が入り得ないため元々問題にならなかったが、
 *   ジェネリクスは複数トークンからなる型注釈なので、正規化しないと
 *   `Repository<User>` と `Repository <User>` のような書き方の違いだけで
 *   bind が一致しなくなる（サイレントに効かなくなる）バグを生む。
 *
 *   連鎖: bind は連鎖する。`bind A = B;` と `bind B = C;` を両方書くと、
 *   `A` の解決は実行時に `resolveType` を再帰的に辿って最終的に `C` まで到達する
 *   （どちらを先に書いても構わない。循環している場合は分かりやすいエラーになる）。
 *
 *   優先順位: プロパティ単位の override ＞ 型単位の bind ＞ 宣言済みの既定初期化式
 *   （後述）。
 *
 *   activate同士の実行順序に依存する点は変更していない。複数の configuration が
 *   同じ型を bind/override した場合、後から activate した方が勝つ。
 *
 * injectableの既定初期化式（危険な型には "= <式>" が必須）:
 *   `injectable prop: Type;` は `new Type()` を自動生成するが、これは
 *   Typeが「単純な識別子（＋ジェネリクス）の形」かつ「このファイル内で
 *   interface/type/abstract classとして宣言されていない」場合にのみ安全
 *   （それ以外は new できずコンパイルエラーになる、または bind/override が
 *   無ければ実行時エラーになる、という問題があった）。
 *
 *   そこで「危険な型」（配列型・ユニオン型・関数型、または interface/
 *   type エイリアス/abstract classと判定された識別子型）については、
 *   `= <式>` による既定初期化式を構文的に必須にした。無い場合は
 *   パース時に `DisonParseError` になる。安全な型（通常のクラス型）には
 *   同じ `= <式>` 構文を任意で使える（コンストラクタ引数を渡したい場合など）。
 *   従来通り省略した場合は `new Type()` が自動生成される。
 *
 *     injectable repo: IUserRepository = new SqlUserRepositoryImpl(); // OK
 *     injectable repo: IUserRepository;                               // ✗ パースエラー
 *     injectable database: SqlUserRepository;                         // OK（省略可、new SqlUserRepository()）
 *     injectable database: SqlUserRepository = new SqlUserRepository(cfg); // OK（明示も可）
 *
 *   既定初期化式の右辺は override と同じ規約（自動で `new` を補わない、
 *   任意のTS式をそのまま評価する）に揃えている。
 *
 *   abstract class も interface/type と同様に「危険な型」として扱う
 *   （`new AbstractClass()` は tsc が常にコンパイルエラーにするため）。
 *   ただし同名の非abstractな `class` 宣言が別途あれば（TSの宣言マージ）
 *   実際には new 可能なので「危険な型」からは除外する。
 *
 * 構文的に置ける位置の制約:
 *   `injectable` / `configuration` はそれぞれ生成物の形（クラスメンバ宣言 /
 *   関数宣言）が特定の構文的位置でしか有効にならないため、それ以外の位置に
 *   書かれた場合はパース時に `DisonParseError` になる（以前は無制限に
 *   受理してしまい、tscの分かりにくいエラーの壁として現れていた）。
 *
 *     - `injectable`: クラス本体の直下（メソッドの中は不可）
 *     - `configuration`: トップレベルのみ（関数・クラスの中は不可）
 *     - `activate`: 制限なし（条件分岐や関数の中で呼び分けてよい）
 *
 *   判定は `collectBlockContext` によるヒューリスティックな事前スキャン
 *   （トークン列全体を1回舐め、各位置の波カッコの深さと、直近の囲みブロックが
 *   クラス本体かどうかを記録する）に基づく。
 *
 * configurationで包まない単独のoverride/bind:
 *   `override`/`bind` の中身は（`configuration`と違い）ただの代入文
 *   （`DI_REGISTRY[...] = ...;` / `bindType<...>(...)`）に脱糖されるため、
 *   宣言と違って構文的な位置の制約を受けない。そこで `configuration { ... }`
 *   で包まずに単独で書くことも許可している。書かれた位置でそのまま
 *   即座に実行される代入文になるため、関数・メソッドのレキシカルスコープに
 *   ある変数を自然に捕捉できる。
 *
 *     function createHarness(label: string) {
 *       class Tagged extends Base { tag = label; }
 *       override S {
 *         dep = new Tagged();   // label をクロージャで捕捉できる
 *       }
 *       return new S();
 *     }
 *
 *   これが無いと、同じことをするには `DI_REGISTRY["S"]["dep"] = ...` という
 *   生の実装詳細をユーザーに直接書かせることになり、Disonの目的
 *   （ServiceLocator的な実装戦略を言語セマンティクスの下に隠す）に反してしまう。
 *   単独のoverride/bindは、`configuration`同様クラス本体の直下だけは
 *   書けない（代入文を置ける位置ではないため）。
 *
 * bind/injectableの照合キー（型の種別で決まる）:
 *   `bind`/`injectable`の照合キーは型の種別で決まる（docs/type-identity-matching.md
 *   案A、codegenのkeyExprFor）:
 *     - 実行時に値を持つクラス（具象 or abstract）→ クラスの実体（Function）。案A(a)。
 *     - 真の interface/型エイリアス（実行時に値が無い）→ 宣言ごとに自動生成した
 *       companion Symbol（__dison_token_<型名>）。案A(b)。
 *     - 外部パッケージ由来の型、または具体的な型引数を持つジェネリクス
 *       （Repository<User>）→ 正規化済みの型名文字列（typeKey）。
 *     - "as <トークン>"句があればそのトークン参照が最優先（利用者の明示上書き）。
 *   クラスの実体キー化は`override`の`DI_REGISTRY`（WeakMap<Function>）と同じ発想。
 *   クラス値・companion Symbol いずれも「複数ファイルにまたがる同名の型が別の実体
 *   として自動的に区別され、手動tokenなしで衝突しなくなる」のが狙い。複数ファイル
 *   モードでは、宣言側とimport側でキーが食い違わないよう、CLIが他ファイルから
 *   importされたクラス（実体キー）・interface/型エイリアス（companion）を解決して
 *   各ファイルの transpile に渡す（computeIdentityKeyClassesByFile／
 *   computeCompanionPlanByFile）。companion は DI利用されるものだけ emit し、他ファイル
 *   の型を使う側にはその companion の import を注入する（案A(c)）。
 *
 * bindのinterface/型エイリアス問題への対応（"as <トークン>" / token）:
 *   プロジェクト内で宣言される interface/型エイリアスは上記 companion で自動的に
 *   衝突回避されるが、**外部パッケージ由来**の interface/型エイリアスは、そのパッケージが
 *   companion をexportしていないため自動配線できず、文字列キーのままになる。単一
 *   ファイルでは問題にならないが、複数ファイルで共有ランタイムモジュールを使う場合
 *   （docs/multi-file-support.md）、互いに無関係な2ファイルが同名の外部interfaceを
 *   別パッケージから import しているだけで、一方の`bind`がもう一方を汚染してしまう
 *   （元々の再現例はローカル宣言だったが、それは companion で解消済み。
 *   docs/bind-interface-token.md 1節）。この残った外部型のケースに以下のtoken対応が
 *   必要（docs/type-identity-matching.md 案A(b) の「残る境界」）。
 *
 *   対応として、`injectable`/`bind`の左辺に任意の `as <トークン>` 句を
 *   追加できるようにした。トークンは`token Name;`という新しい構文
 *   （`export const Name = Symbol("Name");`に脱糖される。トップレベル
 *   にのみ書ける）で作った、複数箇所から安定して参照される共有の値。
 *   指定すると、型名の文字列の代わりにそのトークンの識別子参照が
 *   照合キーになる（`TYPE_BINDINGS`は`Map<string | symbol, ...>`）。
 *
 *     token IRepositoryToken;
 *     injectable repo: IRepository as IRepositoryToken = new Impl();
 *     bind IRepository as IRepositoryToken = Mock;
 *
 *   トークンは複数箇所（複数ファイルにまたがる場合も含む）から常に
 *   同じ値を参照する必要があるため、`as Symbol("X")`のようにその場で
 *   新しい値を作ってはいけない（呼ぶたびに異なる値になり一致しなくなる）。
 *   `as`句の文法もこれを踏まえ、識別子＋任意の".プロパティ"という
 *   制限された形のみ許可し、任意の式・呼び出し式は許可していない。
 *
 *   さらに`findBindCollisions`（複数ファイルを横断する別関数。CLIが
 *   複数ファイルを処理する際にのみ呼ばれる）が、`bind`/`injectable`で
 *   実際に使われている型名について、宣言・importの由来（ローカル宣言か、
 *   importならそのspecifier）を比較し、由来が食い違う（=衝突しうる）
 *   箇所でトークンが使われていなければビルドエラーにする。これにより
 *   利用者が衝突の存在に気づかずサイレントに汚染される、という事態を
 *   防いでいる。詳細は docs/bind-interface-token.md 参照。
 * -----------------------------------------------------------
 */

import { Lexer } from "./lexer.js";
import { collectDeclaredTypeKinds, trueInterfaceOrAliasNames, identityKeyableClassNames } from "./analysis.js";
import { Parser } from "./parser.js";
import {
  generate,
  resolveFromActivateBindings,
  generateFromImportStatements,
  generateCompanionDeclarations,
  generateCompanionImportStatements,
  collectDiUsedTypeNames,
  companionName,
  type KeyStrategy,
  type CompanionImport,
} from "./codegen.js";
import { generateRuntimeDeclarations, DISON_RUNTIME_MODULE_SOURCE, DISON_RUNTIME_IMPORTS } from "./runtime.js";
import { findBindCollisions, findCrossFileKeyMismatches, computeIdentityKeyClassesByFile, computeCompanionPlanByFile } from "./collisions.js";
import type { DisonFileInput, BindCollisionDiagnostic, CompanionImportInfo } from "./collisions.js";

export interface TranspileOptions {
  // 指定すると、ランタイムの前置き（DI_REGISTRY等）をインライン生成する代わりに、
  // このパスからimportする文を生成する（複数ファイルでランタイム状態を共有する
  // ため）。省略時は従来通りインラインで生成する（単一ファイル利用の挙動）。
  runtimeModulePath?: string;

  // bind/injectable の照合キーに「実体参照（クラスの値そのもの）」を使ってよい
  // クラス識別子の追加集合（docs/type-identity-matching.md 案A(a)）。
  // このファイル内でconcrete classとして宣言されたものは常に実体キー化されるため、
  // ここに渡す必要はない。複数ファイルモードで、他のプロジェクトファイルから
  // value-importされた具象クラス（このファイルではローカル宣言として見えないが、
  // 宣言元ファイルと実体キーを一致させる必要があるもの）をCLIが解決して渡す。
  // 省略時（単一ファイル利用）はローカル宣言の具象クラスのみが実体キー化される。
  // 具象クラスに加え、このファイルのローカル abstract class も常に実体キー化される
  // （abstract class は new 不可だが実行時に値を持つため）。
  identityKeyClasses?: Iterable<string>;

  // このファイルで宣言された真の interface/型エイリアスのうち、companion Symbol を
  // 追加で emit すべき名前（docs/type-identity-matching.md 案A(b)）。このファイル内で
  // DI利用（bind左辺/injectable型）される interface は常に emit されるため、ここに
  // 渡すのは「他ファイルで DI利用されるが、このファイル自身では使っていない」ローカル
  // 宣言の名前（複数ファイルモードでCLIが解決して渡す）。省略時（単一ファイル利用）は
  // ローカルの DI利用 interface だけが emit される。
  companionEmit?: Iterable<string>;

  // 他プロジェクトファイルで宣言された interface/型エイリアスを DI で使う場合に、その
  // companion Symbol を import して照合キーに使うための情報（案A(c)）。キーはこの
  // ファイルでのローカル型名。複数ファイルモードでCLIが解決して渡す（単一ファイル利用
  // では空 = 外部由来の型は文字列キーにフォールバック）。
  companionImports?: Map<string, CompanionImportInfo>;
}

/**
 * Dison言語のソースコードを受け取り、完全に動作するTypeScriptコードに変換する。
 * DSL構文（configuration / override / injectable / activate / bind）以外の部分は、
 * トークナイザ＋パーサを経由してもなお100%元の文字列のまま出力される。
 */
export function transpileDisonToTS(sourceCode: string, options: TranspileOptions = {}): string {
  const tokens = new Lexer(sourceCode).tokenize();
  const typeKinds = collectDeclaredTypeKinds(tokens);
  const ast = new Parser(tokens, typeKinds).parseProgram();
  const fromBindings = resolveFromActivateBindings(ast);

  // 実体キー化してよいクラス識別子の集合 = このファイルのローカル具象クラス
  // ＋ローカル abstract class ∪ 呼び出し側が渡した集合（複数ファイルモードで
  // value-importされたプロジェクトのクラス）。裸の識別子かつこの集合に含まれる型
  // だけが実体参照でキー化される（docs/type-identity-matching.md 案A(a)）。
  const identityKeyClasses = identityKeyableClassNames(typeKinds);
  for (const name of options.identityKeyClasses ?? []) identityKeyClasses.add(name);
  const isIdentityClass = (id: string) => identityKeyClasses.has(id);

  // companion Symbol でキー化する真の interface/型エイリアス（案A(b)）。
  //   - ローカル宣言の真の interface/型エイリアス → このファイルで emit した companion。
  //   - 他プロジェクトファイルから import したもの（options.companionImports）→ import
  //     した companion。
  // どちらもキーには companionName(ローカル型名) を使う（宣言側の emit 名と import 側の
  // ローカル別名が一致するよう、codegen 側で import 文にエイリアスを付ける）。
  const localTrueInterfaces = trueInterfaceOrAliasNames(typeKinds);
  const companionImports = options.companionImports ?? new Map<string, CompanionImportInfo>();
  const companionRefOf = (id: string): string | undefined => {
    if (localTrueInterfaces.has(id) || companionImports.has(id)) return companionName(id);
    return undefined;
  };

  const strategy: KeyStrategy = { isIdentityClass, companionRefOf };
  const body = generate(ast, fromBindings, strategy);

  // emit する companion = このファイルで DI利用されるローカル真 interface
  // ∪ 呼び出し側が渡した追加分（他ファイルで DI利用されるローカル宣言）。
  const diUsed = collectDiUsedTypeNames(ast);
  const companionEmitNames = new Set<string>();
  for (const name of localTrueInterfaces) {
    if (diUsed.has(name)) companionEmitNames.add(name);
  }
  for (const name of options.companionEmit ?? []) {
    if (localTrueInterfaces.has(name)) companionEmitNames.add(name);
  }

  // import する companion = このファイルで DI利用される、他ファイル由来の interface。
  const companionImportList: CompanionImport[] = [];
  for (const [localName, info] of companionImports) {
    if (diUsed.has(localName)) {
      companionImportList.push({ localName, originalName: info.originalName, specifier: info.specifier });
    }
  }

  // ランタイム前置き（docs/spec-audit-2026-07.md #7）:
  //   - 複数ファイルモード: 生成ファイル自身は AsyncLocalStorage を参照しない
  //     （als は共有ランタイムモジュール側にある）ため、node:async_hooks の import は
  //     生成ファイルには出さない。
  //   - 単一ファイルモード: ローカルスコープの configuration を使うファイルだけが
  //     本物の AsyncLocalStorage（node:async_hooks）を必要とする。使わないファイルは
  //     同期スタブでインライン生成し、Node 以外のランタイムでも動く生成物にする。
  const usesLocalScope = ast.some((n) => n.kind === "configuration" && n.scope === "local");
  const header = `// --- Auto-generated TypeScript code ---\n\n`;
  const prelude = options.runtimeModulePath
    ? `${header}import {\n` +
      `  bindTypeLazy,\n  resolveType,\n  registerOverrideLazy,\n` +
      `  __disonCurrentScope,\n  __disonResolveInjectable,\n  __disonEnterScopeLazy,\n  __disonBuildFrameLazy,\n` +
      `} from ${JSON.stringify(options.runtimeModulePath)};\n\n`
    : usesLocalScope
    ? `${header}${DISON_RUNTIME_IMPORTS}\n${generateRuntimeDeclarations("", "node")}\n`
    : `${header}\n${generateRuntimeDeclarations("", "stub")}\n`;

  // ES Modules の import はファイル先頭にしか書けないため、import 系（companion import、
  // "activate ... from" の import）を前置きの直後にまとめて出す。companion の const 宣言
  // （export const __dison_token_X = Symbol(...)）は import ではないので、すべての import
  // の後・生成本体の前に置く。
  const companionImportsStr = generateCompanionImportStatements(companionImportList);
  const fromImports = generateFromImportStatements(fromBindings);
  const companionDecls = generateCompanionDeclarations([...companionEmitNames]);

  return prelude + companionImportsStr + fromImports + companionDecls + body;
}

// 公開API: 複数ファイル対応（docs/multi-file-support.md、
// docs/bind-interface-token.md）。CLIが複数ファイルを一括処理する際に使う。
export { DISON_RUNTIME_MODULE_SOURCE, findBindCollisions, findCrossFileKeyMismatches, computeIdentityKeyClassesByFile, computeCompanionPlanByFile };
export type { DisonFileInput, BindCollisionDiagnostic, CompanionImportInfo };
