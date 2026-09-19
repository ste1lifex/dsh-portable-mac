// 取运行时（Electron / Node / pnpm）并铺好 runtime\ 目录。
//
// 仓库里不放二进制：这里按 versions.json 从**官方源**下载，缓存到 .cache\，
// 之后重复构建直接复用（也可用 --electron-zip / --node-dir 指向本地已有的文件）。
//
//   Electron : https://github.com/electron/electron/releases  （官方 Release 资产）
//   Node     : https://nodejs.org/dist/v<ver>/node-v<ver>-darwin-arm64.tar.gz
//   pnpm     : https://registry.npmjs.org/pnpm/-/pnpm-<ver>.tgz
//
// 产物：
//   .cache/electron-v<ver>-darwin-arm64.zip   组装 .app 时直接读取（不解压）
//   runtime/node/bin/node                     darwin-arm64 Node 可执行文件
//   runtime/node/node_modules/pnpm/           随包 pnpm（纯 JS，跨平台）
//   runtime/seed/                             从仓库 seed/ 复制（首次启动展开的初始数据）

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const CACHE = path.join(ROOT, '.cache');
export const RUNTIME = path.join(ROOT, 'runtime');

export function log(...a) { console.log('[runtime]', ...a); }

export function loadVersions() {
  return JSON.parse(fs.readFileSync(path.join(HERE, 'versions.json'), 'utf8'));
}

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw new Error(`无法执行 ${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} 退出码 ${r.status}（参数：${args.join(' ')})`);
}

/** 需要 tar：Windows 10+ 自带 bsdtar，macOS / Linux 也有。 */
function requireTar() {
  const r = spawnSync('tar', ['--version'], { stdio: 'ignore' });
  if (r.error || r.status !== 0) {
    throw new Error('找不到 tar 命令。Windows 10/11 自带 bsdtar；若确实没有，可用 --node-dir 直接指向已有的 darwin-arm64 node 目录。');
  }
}

async function download(url, dest, { minBytes = 1024 } = {}) {
  if (exists(dest) && fs.statSync(dest).size >= minBytes) {
    log(`已缓存 ${path.relative(ROOT, dest)}（${(fs.statSync(dest).size / 1048576).toFixed(1)} MB）`);
    return dest;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  log(`下载 ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}：${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  const out = fs.createWriteStream(tmp);
  let got = 0, lastPct = -1;
  for await (const chunk of res.body) {
    got += chunk.length;
    out.write(chunk);
    if (total) {
      const pct = Math.floor((got / total) * 100);
      if (pct >= lastPct + 10) { lastPct = pct; log(`  ${pct}%（${(got / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB）`); }
    }
  }
  await new Promise((r) => out.end(r));
  if (got < minBytes) throw new Error(`下载内容过小（${got} 字节）：${url}`);
  fs.renameSync(tmp, dest);
  log(`完成 ${(got / 1048576).toFixed(1)} MB → ${path.relative(ROOT, dest)}`);
  return dest;
}

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name), d = path.join(dst, name);
    const st = fs.lstatSync(s);
    if (st.isSymbolicLink()) continue;              // 跨平台拷贝的符号链接不可靠，跳过
    if (st.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Electron：只需要 zip 本身（组装时直接搬运压缩数据，不解压）。 */
export async function ensureElectron(v, { electronZip } = {}) {
  const target = path.join(CACHE, `electron-v${v.electron}-darwin-arm64.zip`);
  if (electronZip) {
    if (!exists(electronZip)) throw new Error(`--electron-zip 指向的文件不存在：${electronZip}`);
    fs.mkdirSync(CACHE, { recursive: true });
    fs.copyFileSync(electronZip, target);
    log(`使用本地 Electron zip → ${path.relative(ROOT, target)}`);
    return target;
  }
  return await download(
    `https://github.com/electron/electron/releases/download/v${v.electron}/electron-v${v.electron}-darwin-arm64.zip`,
    target, { minBytes: 50 * 1048576 });
}

/** Node：只要 bin/node 一个文件。 */
export async function ensureNode(v, { nodeDir } = {}) {
  const nodeBin = path.join(RUNTIME, 'node', 'bin', 'node');
  if (exists(nodeBin) && fs.statSync(nodeBin).size > 30 * 1048576) {
    log(`已就绪 ${path.relative(ROOT, nodeBin)}（${(fs.statSync(nodeBin).size / 1048576).toFixed(1)} MB）`);
    return nodeBin;
  }
  fs.mkdirSync(path.dirname(nodeBin), { recursive: true });

  if (nodeDir) {
    const src = path.join(nodeDir, 'bin', 'node');
    if (!exists(src)) throw new Error(`--node-dir 下找不到 bin/node：${nodeDir}`);
    fs.copyFileSync(src, nodeBin);
    fs.chmodSync(nodeBin, 0o755);
    log(`使用本地 node → ${path.relative(ROOT, nodeBin)}`);
    return nodeBin;
  }

  requireTar();
  const tgz = await download(`https://nodejs.org/dist/v${v.node}/node-v${v.node}-darwin-arm64.tar.gz`,
    path.join(CACHE, `node-v${v.node}-darwin-arm64.tar.gz`), { minBytes: 20 * 1048576 });
  // 解到独立目录（tar 会连同 tarball 里的顶层目录一起建，所以不能再叫同名目录）
  const ex = path.join(CACHE, 'node-extract');
  fs.rmSync(ex, { recursive: true, force: true });
  fs.mkdirSync(ex, { recursive: true });
  log('解压 node 运行时 ...');
  const inner = `node-v${v.node}-darwin-arm64/bin/node`;   // tar 包内路径一律用 /（Windows 的 path.join 会给反斜杠，tar 不认）
  run('tar', ['-xzf', tgz, '-C', ex, inner]);
  const src = path.join(ex, ...inner.split('/'));
  if (!exists(src)) throw new Error(`node 解压后找不到 ${inner}（tar 行为异常）`);
  fs.copyFileSync(src, nodeBin);
  fs.chmodSync(nodeBin, 0o755);
  fs.rmSync(ex, { recursive: true, force: true });
  log(`node 就绪（${(fs.statSync(nodeBin).size / 1048576).toFixed(1)} MB）`);
  return nodeBin;
}

/** pnpm：纯 JS，从 npm registry 取 tarball 解到 node/node_modules/pnpm。 */
export async function ensurePnpm(v) {
  const cli = path.join(RUNTIME, 'node', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');
  if (exists(cli)) { log(`已就绪 ${path.relative(ROOT, cli)}`); return cli; }
  requireTar();
  const tgz = await download(`https://registry.npmjs.org/pnpm/-/pnpm-${v.pnpm}.tgz`,
    path.join(CACHE, `pnpm-${v.pnpm}.tgz`), { minBytes: 100 * 1024 });
  const ex = path.join(CACHE, `pnpm-${v.pnpm}`);
  fs.rmSync(ex, { recursive: true, force: true });
  fs.mkdirSync(ex, { recursive: true });
  log('解压 pnpm ...');
  run('tar', ['-xzf', tgz, '-C', ex]);
  const pkg = path.join(ex, 'package');
  if (!exists(pkg)) throw new Error('pnpm tarball 结构异常（没有 package/ 目录）');
  const dst = path.join(RUNTIME, 'node', 'node_modules', 'pnpm');
  fs.rmSync(dst, { recursive: true, force: true });
  copyTree(pkg, dst);
  // pnpm 的入口在不同版本分别是 bin/pnpm.mjs 或 bin/pnpm.cjs，两者都保留
  if (!exists(cli) && !exists(path.join(dst, 'bin', 'pnpm.cjs'))) {
    throw new Error('解压后的 pnpm 里找不到入口（bin/pnpm.mjs 或 bin/pnpm.cjs）');
  }
  fs.chmodSync(cli, 0o755);
  log('pnpm 就绪');
  return cli;
}

/** seed：把仓库里的 seed/ 复制成 runtime/seed（App 首启展开的初始数据）。 */
export function ensureSeed() {
  const src = path.join(ROOT, 'seed');
  const dst = path.join(RUNTIME, 'seed');
  if (!exists(src)) throw new Error(`缺少 seed/ 目录：${src}`);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name), d = path.join(dst, name);
    const st = fs.lstatSync(s);
    if (st.isDirectory()) copyTree(s, d);
    else if (st.isFile()) fs.copyFileSync(s, d);      // seed 根目录下还有 plugin-track.json / .env.example 这类单文件
    else log(`跳过 seed/${name}（非普通文件）`);
  }
  const n = countFiles(dst);
  if (n < 10) throw new Error(`seed 复制后只有 ${n} 个文件，像是复制失败了`);
  log(`seed 就绪（${n} 个文件）`);
  return dst;
}

/** 有 store.tar.gz 时一并带上（离线首启用；本仓库默认不带 → 首启联网装依赖）。 */
export function optionalStore() {
  const p = path.join(RUNTIME, 'store.tar.gz');
  if (exists(p)) { log(`检测到离线缓存 store.tar.gz（${(fs.statSync(p).size / 1048576).toFixed(0)} MB），将随包一起打包`); return p; }
  log('无 store.tar.gz → 目标机首次启动将联网安装依赖（功能相同，仅需网络）');
  return null;
}

export function countFiles(dir) {
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) n += countFiles(p); else n++;
  }
  return n;
}
