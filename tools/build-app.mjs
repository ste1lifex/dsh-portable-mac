// 一键构建 macOS 的 DSH.app zip：
//
//   node tools/build-app.mjs
//
// 流程（与 npm/pnpm 无关，只需要 Node 18+ 与系统 tar）：
//   1) fetch-runtime.mjs  下载 Electron（官方 Release）/ Node（nodejs.org）/ pnpm（npm registry）
//                         →  .cache/  +  runtime/node/  +  runtime/seed/
//   2) assemble.mjs       组装 DSH.app（保留符号链接）→ dist/DSH-mac-arm64.zip
//
// 常用参数：
//   --electron-zip <path>  用本地已有的 electron-v<ver>-darwin-arm64.zip（离线构建）
//   --node-dir <path>      用本地已有的 darwin-arm64 node 目录（含 bin/node）
//   --skip-fetch           直接用手头的 .cache/ 与 runtime/（离线构建）
//
// 提示：默认**不**打包离线依赖缓存（store.tar.gz，~264MB）。
//       若 runtime/store.tar.gz 存在，assemble 会自动把它一起打进包里。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, loadVersions, ensureElectron, ensureNode, ensurePnpm, ensureSeed, optionalStore, log } from './fetch-runtime.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const flag = (name) => process.argv.includes(name);

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 18) {
  console.error(`需要 Node 18 或更高版本（当前 ${process.version}）`);
  process.exit(2);
}

const v = loadVersions();
console.log(`=== 构建 DSH.app（Electron ${v.electron} / Node ${v.node} / pnpm ${v.pnpm} / DSH ${v.dshVersion}）===`);

if (!flag('--skip-fetch')) {
  console.log('\n[1/2] 准备运行时 ...');
  await ensureElectron(v, { electronZip: arg('--electron-zip') });
  await ensureNode(v, { nodeDir: arg('--node-dir') });
  await ensurePnpm(v);
  ensureSeed();
  optionalStore();
} else {
  console.log('\n[1/2] 跳过下载（--skip-fetch），直接使用现有 .cache/ 与 runtime/');
  for (const p of [path.join(ROOT, 'runtime', 'node', 'bin', 'node'), path.join(ROOT, 'runtime', 'seed')]) {
    if (!fs.existsSync(p)) { console.error(`缺少 ${p}，无法离线构建`); process.exit(2); }
  }
}

console.log('\n[2/2] 组装并打包 ...');
const r = spawnSync(process.execPath, [path.join(HERE, 'assemble.mjs')], { stdio: 'inherit' });
process.exit(r.status ?? 1);
