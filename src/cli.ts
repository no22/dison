#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { transpileDisonToTS, findBindCollisions } from './core.js'; // ※NodeNext環境のために.jsをつけます

// 複数ファイルの生成コードが共有ランタイム（DI_REGISTRY/TYPE_BINDINGS等）を
// importする際に使うパッケージのサブパス。disonパッケージ自身がこの下に
// 実体（src/generated-runtime.ts→dist/generated-runtime.js）を配布している
// ため、変換対象のプロジェクトは"dison"を依存関係としてインストールして
// いる必要がある（docs/packaging.md）。
const RUNTIME_PACKAGE_SPECIFIER = 'dison/runtime';

function outputPathFor(inputFile: string): string {
  const ext = path.extname(inputFile);
  return inputFile.replace(ext, '.ts');
}

// 単一ファイルの変換（従来通り）。ランタイムの前置き（DI_REGISTRY等）は
// 生成TSファイルにインラインされる。他ファイルとランタイム状態を共有する
// 必要が無い、これまで通りの使い方。
function transpileSingleFile(inputFile: string): void {
  const sourceCode = fs.readFileSync(inputFile, 'utf-8');
  const generatedTS = transpileDisonToTS(sourceCode);
  const outputFile = outputPathFor(inputFile);
  fs.writeFileSync(outputFile, generatedTS, 'utf-8');
  console.log(`🎉 Success: ${inputFile} ➔ ${outputFile}`);
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
// 現状は簡略化のため、すべての入力ファイルが同一ディレクトリにあることを
// 前提にしている。
function transpileMultipleFiles(inputFiles: string[]): void {
  const dirs = new Set(inputFiles.map((f) => path.dirname(path.resolve(f))));
  if (dirs.size > 1) {
    throw new Error(
      `When passing multiple files, they must currently all be in the same directory` +
        ` (directories given: ${[...dirs].join(', ')})`
    );
  }

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

  console.log(`🎉 Using "${RUNTIME_PACKAGE_SPECIFIER}" as the shared runtime (the target project must have "dison" installed as a dependency).`);

  for (const file of fileInputs) {
    const generatedTS = transpileDisonToTS(file.source, { runtimeModulePath: RUNTIME_PACKAGE_SPECIFIER });
    const outputFile = outputPathFor(file.path);
    fs.writeFileSync(outputFile, generatedTS, 'utf-8');
    console.log(`🎉 Success: ${file.path} ➔ ${outputFile}`);
  }
}

function main() {
  // 引数の取得 (例: npx tsx src/cli.ts test.dis / npx tsx src/cli.ts a.dis b.dis)
  // process.argv[0]はnode、[1]はスクリプトパス、[2]以降がユーザーが渡したファイル名
  const inputFiles = process.argv.slice(2);

  if (inputFiles.length === 0) {
    console.error("❌ Error: please specify an input file.");
    console.log("👉 Usage: dison <file.dis> [<file2.dis> ...]");
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
      transpileSingleFile(inputFiles[0]!);
    } else {
      transpileMultipleFiles(inputFiles);
    }
  } catch (error: any) {
    console.error("❌ Compilation failed:");
    console.error(error.message);
    process.exit(1);
  }
}

main();
