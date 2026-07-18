// "dison/runtime" サブパスとして配布する共有ランタイムモジュールの実体
// （src/generated-runtime.ts）を、DISON_RUNTIME_MODULE_SOURCE（src/runtime.ts）
// から書き出す。ビルドの最初のステップとして実行し、その後tscがdist/に
// コンパイルする（docs/packaging.md）。
//
// 情報源はDISON_RUNTIME_MODULE_SOURCEのみとし、このファイル自体は手で
// 編集しない（src/generated-runtime.tsは.gitignoreされたビルド成果物）。
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { DISON_RUNTIME_MODULE_SOURCE } from "../src/runtime";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(scriptDir, "..", "src", "generated-runtime.ts");
fs.writeFileSync(outPath, DISON_RUNTIME_MODULE_SOURCE, "utf-8");
console.log(`🎉 Generated the shared runtime module: ${outPath}`);
