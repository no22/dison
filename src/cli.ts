#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { transpileDisonToTS, explainWiring, computeProjectWiring, findBindCollisions, findCrossFileKeyMismatches, computeIdentityKeyClassesByFile, computeCompanionPlanByFile } from './core.js'; // ※NodeNext環境のために.jsをつけます

// 複数ファイルの生成コードが共有ランタイム（DI_REGISTRY/TYPE_BINDINGS等）を
// importする際に使うパッケージのサブパス。@no22/disonパッケージ自身が
// この下に実体（src/generated-runtime.ts→dist/generated-runtime.js）を
// 配布しているため、変換対象のプロジェクトは"@no22/dison"を依存関係として
// インストールしている必要がある（docs/packaging.md）。パッケージ名が
// "@no22/dison"なのはnpmの類似名ポリシー（jison/bson/json等と類似と
// 判定された）により無scope名"dison"では公開できなかったため。
const RUNTIME_PACKAGE_SPECIFIER = '@no22/dison/runtime';

function outputPathFor(inputFile: string): string {
  const ext = path.extname(inputFile);
  return inputFile.replace(ext, '.ts');
}

// 単一ファイルの変換（従来通り）。ランタイムの前置き（DI_REGISTRY等）は
// 生成TSファイルにインラインされる。他ファイルとランタイム状態を共有する
// 必要が無い、これまで通りの使い方。
function transpileSingleFile(inputFile: string, opts: CliOptions): void {
  const sourceCode = fs.readFileSync(inputFile, 'utf-8');
  const generatedTS = transpileDisonToTS(sourceCode, { staticResolution: !opts.noStatic });
  const outputFile = outputPathFor(inputFile);
  fs.writeFileSync(outputFile, generatedTS, 'utf-8');
  console.log(`🎉 Success: ${inputFile} ➔ ${outputFile}`);

  // --explain: 静的解決の判定表を出力する（docs/static-resolution-design.md §7）。
  // 畳めなかった injectable にはその理由が付く。--no-static と併用した場合も
  // 解析自体は行う（静的解決を有効にしたらどう畳まれるかが分かる）。
  if (opts.explain) {
    const report = explainWiring(sourceCode);
    console.log(`📋 Static wiring for ${inputFile}:`);
    if (report.length === 0) {
      console.log('  (no injectables)');
    } else {
      for (const line of report) console.log(`  ${line}`);
    }
  }
}

// 複数ファイルの変換（複数ファイル対応フェーズ1・2、docs/multi-file-support.md、
// docs/bind-interface-token.md）。2段階の処理になっている：
//
//   1. 全入力ファイルを読み込み、bind/injectableの型名衝突を検出する
//      （findBindCollisions、案D）。1件でも見つかればどのファイルも
//      書き出さずに中断する（部分的に生成された不整合な状態を残さないため）。
//   2. 問題が無ければ、各ファイルを独立にトランスパイルする。ランタイムの
//      前置き（DI_REGISTRY/TYPE_BINDINGS等）は各生成ファイルが"dison/runtime"
//      パッケージから直接importする。これによりファイルを跨いだ
//      override/bind/activateが正しく効くようになる（1ファイルずつ独立に
//      トランスパイルすると、それぞれが自分専用のDI_REGISTRY/TYPE_BINDINGSを
//      持ってしまい、互いに影響しない）。以前はこのランタイムを出力先
//      ディレクトリにdison-runtime.tsとして毎回書き出していたが、disonの
//      パッケージ化に伴いパッケージ自身から読み込む方式に変更した
//      （docs/packaging.md）。
//
// 以前は共有ランタイム（dison-runtime.ts）をどのディレクトリに書き出すか
// 曖昧にならないよう、全入力ファイルが同一ディレクトリにあることを要求
// していた。パッケージ化（docs/packaging.md）でこの書き出し自体をやめ、
// "dison/runtime" パッケージから直接importする方式に変更したため、
// その制約の根拠は無くなった。各ファイルは自身のパスを基準に個別に
// 入出力されるため、異なるディレクトリの入力ファイルを混在させても良い。
function transpileMultipleFiles(inputFiles: string[], opts: CliOptions): void {
  const fileInputs = inputFiles.map((inputFile) => ({
    path: inputFile,
    source: fs.readFileSync(inputFile, 'utf-8'),
  }));

  const collisions = findBindCollisions(fileInputs);
  if (collisions.length > 0) {
    const details = collisions.map((c) => `  - ${c.message}`).join('\n');
    throw new Error(
      `Possible bind/injectable type-name collisions across files` +
        ` (${collisions.length}). No files were generated.\n${details}`
    );
  }

  // クロスファイルキー不一致（import忘れ・type-onlyインポートのクラス）の検出
  // （docs/cross-file-key-mismatch.md）。文字列キーに落ちた識別子が他ファイルの
  // identity/companionキー宣言と決して一致しない＝bind/overrideが黙って無効になる
  // ケースを、変換前にエラーとして報告する。
  const mismatches = findCrossFileKeyMismatches(fileInputs);
  if (mismatches.length > 0) {
    const details = mismatches.map((c) => `  - ${c.message}`).join('\n');
    throw new Error(
      `Cross-file key mismatches detected (${mismatches.length}):` +
        ` these bind/override/injectable keys can never match their declarations.` +
        ` No files were generated.\n${details}`
    );
  }

  console.log(`🎉 Using "${RUNTIME_PACKAGE_SPECIFIER}" as the shared runtime (the target project must have "dison" installed as a dependency).`);

  // 各ファイルが他のプロジェクトファイルからvalue-importしている具象クラスを解決し、
  // 宣言元ファイルと同じ実体キーを使うよう transpile に渡す（docs/type-identity-
  // matching.md 案A(a)。これが無いと、宣言側は実体キー・import側は文字列キーになり
  // 複数ファイルモードで bind がサイレントに効かなくなる）。
  const identityKeyClassesByFile = computeIdentityKeyClassesByFile(fileInputs);

  // 静的解決 フェーズ2（docs/static-resolution-design.md §8）: プロジェクト全体の
  // 配線を解析し、各ファイルの transpile に判定スライスを渡す。--no-static で無効化。
  const projectWiring = opts.noStatic ? undefined : computeProjectWiring(fileInputs);

  // interface/型エイリアスの companion Symbol 計画（案A(b)(c)）。宣言元ファイルが
  // DI利用される companion を emit・export し、import 側にはその import を注入する。
  const companionPlanByFile = computeCompanionPlanByFile(fileInputs);

  for (const file of fileInputs) {
    const companionPlan = companionPlanByFile.get(file.path);
    const generatedTS = transpileDisonToTS(file.source, {
      runtimeModulePath: RUNTIME_PACKAGE_SPECIFIER,
      identityKeyClasses: identityKeyClassesByFile.get(file.path),
      companionEmit: companionPlan?.companionEmit,
      companionImports: companionPlan?.companionImports,
      projectWiring: projectWiring?.get(file.path),
    });
    const outputFile = outputPathFor(file.path);
    fs.writeFileSync(outputFile, generatedTS, 'utf-8');
    console.log(`🎉 Success: ${file.path} ➔ ${outputFile}`);
  }

  // --explain: プロジェクト解析の判定表をファイルごとに出力する。
  if (opts.explain && projectWiring !== undefined) {
    for (const file of fileInputs) {
      const report = projectWiring.get(file.path)?.report ?? [];
      console.log(`📋 Static wiring for ${file.path}:`);
      if (report.length === 0) {
        console.log('  (no injectables)');
      } else {
        for (const line of report) console.log(`  ${line}`);
      }
    }
  }
}

interface CliOptions {
  noStatic: boolean;
  explain: boolean;
}

function main() {
  // 引数の取得 (例: npx tsx src/cli.ts test.dis / npx tsx src/cli.ts a.dis b.dis)
  // process.argv[0]はnode、[1]はスクリプトパス、[2]以降がユーザーが渡したファイル名
  const rawArgs = process.argv.slice(2);
  const opts: CliOptions = {
    noStatic: rawArgs.includes('--no-static'),
    explain: rawArgs.includes('--explain'),
  };
  const inputFiles = rawArgs.filter((a) => a !== '--no-static' && a !== '--explain');

  if (inputFiles.length === 0) {
    console.error("❌ Error: please specify an input file.");
    console.log("👉 Usage: dison [--no-static] [--explain] <file.dis> [<file2.dis> ...]");
    process.exit(1);
  }


  try {
    for (const inputFile of inputFiles) {
      if (!fs.existsSync(inputFile)) {
        console.error(`❌ Error: file '${inputFile}' not found.`);
        process.exit(1);
      }
    }

    if (inputFiles.length === 1) {
      transpileSingleFile(inputFiles[0]!, opts);
    } else {
      transpileMultipleFiles(inputFiles, opts);
    }
  } catch (error: any) {
    console.error("❌ Compilation failed:");
    console.error(error.message);
    process.exit(1);
  }
}

main();
