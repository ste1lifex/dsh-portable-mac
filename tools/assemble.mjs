// 组装 macOS 的 DSH.app 并打包成「保留 Unix 符号链接与权限位」的 zip
//
// 做法要点：
//  - 不解压 Electron（Windows 上无法创建符号链接），而是直接读它的 zip 条目，
//    把「已压缩数据」原样搬进新 zip（含 190MB 的 Electron Framework，避免重压缩）
//  - 14 个符号链接条目以真正的 Unix symlink 形式写入，macOS 解压时自动还原
//  - 只改最外层目录名 Electron.app -> DSH.app；内部可执行文件 / helper 名称保持
//    Electron 不变，以符合 Electron 内部期望（Info.plist 用 CFBundleExecutable=Electron，
//    显示名由 CFBundleName / CFBundleDisplayName 控制）

import fs from 'node:fs';
import path from 'node:path';
import { readZip, entryData, entryRaw, ZipWriter } from './ziputil.mjs';
import { ROOT, CACHE, RUNTIME, loadVersions, log } from './fetch-runtime.mjs';

const APP = 'DSH.app';
const OUT_DIR = path.join(ROOT, 'dist');
const OUT_ZIP = path.join(OUT_DIR, 'DSH-mac-arm64.zip');

const v = loadVersions();
const ELECTRON_ZIP = process.env.DSH_ELECTRON_ZIP
  ? path.resolve(process.env.DSH_ELECTRON_ZIP)
  : path.join(CACHE, `electron-v${v.electron}-darwin-arm64.zip`);
const APP_SRC = path.join(ROOT, 'src', 'app');
const INFO_PLIST = path.join(ROOT, 'src', 'Info.plist');
const ICNS = path.join(ROOT, 'src', 'DSH.icns');
const INSTALLER = path.join(ROOT, '安装.command');
const README = path.join(ROOT, '使用说明.md');

for (const [what, p] of [['Electron zip', ELECTRON_ZIP], ['Info.plist', INFO_PLIST], ['DSH.icns', ICNS],
                         ['壳源码 app/', APP_SRC], ['安装.command', INSTALLER], ['使用说明.md', README],
                         ['运行时 runtime/', RUNTIME]]) {
  if (!fs.existsSync(p)) {
    console.error(`缺少 ${what}：${p}`);
    process.exit(2);
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const w = new ZipWriter(OUT_ZIP);
const addedDirs = new Set();
const stats = { electron: 0, symlinks: 0, skipped: 0, shell: 0, runtime: 0, root: 0, big: 0 };
const BIG = 16 * 1024 * 1024;

function addDirOnce(name) {
  if (addedDirs.has(name)) return;
  addedDirs.add(name);
  w.addDir(name);
}

/** 递归把磁盘目录加入 zip。execNames 命中的文件名置 0755。 */
function addTree(baseDir, zipPrefix, execNames = new Set()) {
  const stack = [''];
  addDirOnce(zipPrefix.replace(/\/$/, ''));
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(baseDir, rel) : baseDir;
    for (const name of fs.readdirSync(abs)) {
      const childAbs = path.join(abs, name);
      const childRel = rel ? rel + '/' + name : name;
      const st = fs.statSync(childAbs);
      if (st.isDirectory()) {
        addDirOnce(zipPrefix + childRel);
        stack.push(childRel);
      } else {
        const zipName = zipPrefix + childRel;
        const mode = execNames.has(name) || execNames.has(childRel) ? 0o100755 : 0o100644;
        if (st.size > BIG) {
          w.addFileFromPath(zipName, childAbs, mode);
          stats.big++;
        } else {
          w.addBuffer(zipName, fs.readFileSync(childAbs), mode);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 1) Electron 主体
// ---------------------------------------------------------------------------
const el = readZip(ELECTRON_ZIP);
const SKIP = [
  /^Electron\.app\/Contents\/_CodeSignature\//,
  /^Electron\.app\/Contents\/Resources\/default_app\.asar$/,
  /^Electron\.app\/Contents\/Info\.plist$/,
];
const LICENSE_MAP = {
  'LICENSE': 'DSH.app/Contents/Resources/electron-licenses/LICENSE',
  'LICENSES.chromium.html': 'DSH.app/Contents/Resources/electron-licenses/LICENSES.chromium.html',
  'version': 'DSH.app/Contents/Resources/electron-licenses/version',
};

for (const e of el.entries) {
  if (SKIP.some((r) => r.test(e.name))) { stats.skipped++; continue; }

  let name = e.name;
  if (LICENSE_MAP[e.name]) {
    w.addBuffer(LICENSE_MAP[e.name], entryData(el, e), e.mode || 0o100644);
    stats.electron++;
    continue;
  }
  if (!name.startsWith('Electron.app')) { stats.skipped++; continue; }
  name = APP + name.slice('Electron.app'.length);

  if (e.isSymlink) {
    const target = entryData(el, e).toString('utf8');
    const fixed = target.replace(/Electron\.app/g, APP);
    w.addSymlink(name, fixed, e.mode || 0o120777);
    stats.symlinks++;
    continue;
  }
  if (e.isDir) { addDirOnce(name); stats.electron++; continue; }

  w.addRaw(name, entryRaw(el, e), e.method, e.crc, e.uncompSize, e.mode || 0o100644);
  stats.electron++;
}
log(`Electron: 搬运 ${stats.electron} 条（其中符号链接 ${stats.symlinks}），跳过 ${stats.skipped} 条`);

// ---------------------------------------------------------------------------
// 2) 应用信息 / 图标 / 桌面壳代码
// ---------------------------------------------------------------------------
addDirOnce(APP + '/Contents/Resources');
w.addBuffer(APP + '/Contents/Info.plist', fs.readFileSync(INFO_PLIST), 0o100644);
w.addBuffer(APP + '/Contents/Resources/DSH.icns', fs.readFileSync(ICNS), 0o100644);

addTree(APP_SRC, APP + '/Contents/Resources/app/');
stats.shell = 3 + fs.readdirSync(path.join(APP_SRC, 'toolbar')).length;
log(`桌面壳代码: ${stats.shell} 个文件`);

// ---------------------------------------------------------------------------
// 3) 运行时（node + seed + 可选 store.tar.gz）
// ---------------------------------------------------------------------------
addTree(RUNTIME, APP + '/Contents/Resources/runtime/', new Set(['node']));
const hasStore = fs.existsSync(path.join(RUNTIME, 'store.tar.gz'));
log(`运行时: node + seed${hasStore ? ' + store.tar.gz' : '（不含离线缓存 → 首启联网装依赖）'}`);

// ---------------------------------------------------------------------------
// 4) 根目录：安装助手 + 说明
// ---------------------------------------------------------------------------
w.addBuffer('安装.command', fs.readFileSync(INSTALLER), 0o100755);
w.addBuffer('使用说明.md', fs.readFileSync(README), 0o100644);
stats.root = 2;

// ---------------------------------------------------------------------------
const res = w.finalize();
console.log('\n=== 打包完成 ===');
console.log('输出:', OUT_ZIP);
console.log('条目总数:', res.count, res.count > 0xffff ? '(使用 ZIP64)' : '');
console.log('zip 大小:', (res.totalSize / 1048576).toFixed(1), 'MB');
console.log('大文件(流式写入):', stats.big, '个');

// 复核：重新读一遍输出 zip，确认符号链接与关键条目
const verify = readZip(OUT_ZIP);
const sym = verify.entries.filter((e) => e.isSymlink);
console.log('\n=== 复核输出 zip ===');
console.log('读回条目数:', verify.entries.length);
console.log('符号链接条目:', sym.length);
sym.slice(0, 3).forEach((e) => console.log(`  ${e.name} -> ${entryData(verify, e).toString('utf8')}`));
const hasInfo = verify.entries.some((e) => e.name === APP + '/Contents/Info.plist');
const hasIcns = verify.entries.some((e) => e.name === APP + '/Contents/Resources/DSH.icns');
const hasNode = verify.entries.some((e) => e.name === APP + '/Contents/Resources/runtime/node/bin/node');
const hasSeed = verify.entries.some((e) => e.name.startsWith(APP + '/Contents/Resources/runtime/seed/dsh-home/'));
const hasShell = verify.entries.some((e) => e.name === APP + '/Contents/Resources/app/main.js');
const hasInstaller = verify.entries.some((e) => e.name === '安装.command');
console.log('关键条目:', JSON.stringify({ hasInfo, hasIcns, hasShell, hasNode, hasSeed, hasInstaller, hasStore }));
const nodeEntry = verify.entries.find((e) => e.name === APP + '/Contents/Resources/runtime/node/bin/node');
if (nodeEntry) console.log('node 权限:', nodeEntry.mode.toString(8), '大小:', (nodeEntry.uncompSize / 1048576).toFixed(1), 'MB');
if (!hasNode || !hasSeed || !hasShell || !hasInstaller) {
  console.error('!! 关键条目缺失，打包结果不可用');
  process.exit(1);
}
console.log('\n完成。把 dist/DSH-mac-arm64.zip 作为 Release 资产上传即可（内含 安装.command 与 使用说明.md）。');
