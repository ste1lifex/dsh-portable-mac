// DeepSeek Harness —— macOS 桌面壳（Electron 主进程）
// 对应 Windows 版 DshDesktop（WPF + WebView2）的同等职责：
//   1) 首次运行准备可写数据目录：~/Library/Application Support/DSH/
//      （macOS 的 App Translocation 会让从「下载」双击的 app 以只读路径运行，
//        因此绝不能把 node_modules / 会话 / 日志写进 app 包内）
//   2) 用随包 node + store 离线安装/校验依赖
//   3) 启动内嵌 DSH 服务，并把「带认证 token 的地址」装进窗口
//      （新版核心启用 Web 认证，直接访问裸地址会 401）
//   4) 提供控制条：启动/停止/重启/刷新/浏览器打开/日志/版本
//
// 包内（只读）：DSH.app/Contents/Resources/runtime/{node, store.tar.gz, seed}
// 包外（可写）：~/Library/Application Support/DSH/{app-npm, dsh-home, store, plugins, logs}

const { app, BrowserWindow, WebContentsView, ipcMain, shell, Menu, dialog, clipboard, nativeTheme } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const PORT = Number(process.env.DSH_PORT || 3099);
const RESOURCES = process.resourcesPath;
const RUNTIME = path.join(RESOURCES, 'runtime');
const NODE_BIN = path.join(RUNTIME, 'node', 'bin', 'node');
const PNPM_JS = path.join(RUNTIME, 'node', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');
const STORE_TAR = path.join(RUNTIME, 'store.tar.gz');
const SEED_DIR = path.join(RUNTIME, 'seed');

const SUPPORT = process.env.DSH_SUPPORT_DIR
  || path.join(os.homedir(), 'Library', 'Application Support', 'DSH');
const APP_NPM = path.join(SUPPORT, 'app-npm');
const DSH_HOME = path.join(SUPPORT, 'dsh-home');
const STORE_DIR = path.join(SUPPORT, 'store');
const PLUGINS_DIR = path.join(SUPPORT, 'plugins');
const LOGS = path.join(SUPPORT, 'logs');

const CORE_PKG = path.join(APP_NPM, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
const CORE_BIN = path.join(APP_NPM, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const WEB_PROFILE = path.join(DSH_HOME, 'profiles', 'web');
const OUT_LOG = path.join(LOGS, 'dsh-web.out.log');
const ERR_LOG = path.join(LOGS, 'dsh-web.err.log');

const TOOLBAR_HEIGHT = 46;

// Electron 默认把 userData 放在 ~/Library/Application Support/<CFBundleName>，
// 也就是会和我们自己的数据目录重名冲突。显式隔离到子目录，避免 Electron 的
// 缓存（Cache/GPUCache/Local Storage 等）混进用户数据里。
app.setPath('userData', path.join(SUPPORT, 'electron'));
try { fs.mkdirSync(path.join(SUPPORT, 'electron'), { recursive: true }); } catch { /* 稍后仍会再建 */ }

let win = null;
let toolbarView = null;
let contentView = null;
let versionWin = null;
let serverProc = null;
let weStartedServer = false;
let authenticatedUrl = null;
let lastStatus = { running: false, url: null, message: '未启动', phase: 'idle' };

// 外壳主题：默认跟随 macOS 外观，内嵌界面加载后以网页端的真实主题为准
let currentTheme = { dark: nativeTheme.shouldUseDarkColors, tokens: {} };
let pageThemeKnown = false;
let themeSent = '';
let versionThemeSent = '';

// DeepSeek 官方余额（右下角）
let currentBalance = { display: '—', tooltip: 'DeepSeek 官方余额\n正在查询…', low: false };
let balanceTimer = null;
let balanceBusy = false;
let lastBalanceAttempt = 0;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function log(...a) { console.log('[dsh-desktop]', ...a); }
function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function appendLog(file, chunk) { try { fs.appendFileSync(file, chunk); } catch { /* ignore */ } }

/**
 * 日志净化：pnpm / node 的输出里可能带 ANSI 颜色码、光标控制（\r、\b）、
 * 以及各类控制字符；原样塞进界面就会显示成「乱码」。
 * 这里统一剥掉转义序列与控制字符，只保留可见文本、换行和制表符。
 */
function sanitizeLog(text, maxLines = 40) {
  const s = String(text == null ? '' : text)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')   // CSI 序列（颜色、光标）
    .replace(/\x1b[@-Z\\-_]/g, '')               // 其余 Fe 转义
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC（如设置标题）
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '') // 控制字符（保留 \t \n \r）
    .replace(/\r\n?/g, '\n');                    // 统一换行，避免 \r 覆盖显示
  const lines = s.split('\n');
  return (lines.length > maxLines ? lines.slice(-maxLines) : lines).join('\n');
}

function chmodX(target) {
  try { if (fs.existsSync(target)) fs.chmodSync(target, 0o755); } catch (e) { log('chmod 失败', target, e.message); }
}

/** 跨平台拷贝会丢 Unix 可执行位，这里统一补齐。 */
function ensureExecutableBits() {
  chmodX(NODE_BIN);
  for (const p of [
    path.join(APP_NPM, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper'),
    path.join(WEB_PROFILE, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper'),
    path.join(SUPPORT, 'tools', 'pnpm'),
    path.join(SUPPORT, 'dsh'),
    path.join(SUPPORT, 'start-dsh.sh'),
    path.join(SUPPORT, 'stop-dsh.sh'),
  ]) chmodX(p);
}

function coreVersion() {
  const pkg = readJsonSafe(CORE_PKG);
  return pkg ? pkg.version : null;
}

function pluginVersions() {
  const track = readJsonSafe(path.join(SUPPORT, 'plugin-track.json'));
  const out = [];
  if (!track || !Array.isArray(track.plugins)) return out;
  for (const item of track.plugins) {
    const pkg = readJsonSafe(path.join(WEB_PROFILE, 'node_modules', item.name, 'package.json'));
    out.push({ name: item.name, label: item.label || item.name, version: pkg ? pkg.version : '(未安装)' });
  }
  return out;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, () => resolve(true));
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function urlFromLog() {
  try {
    const lines = fs.readFileSync(OUT_LOG, 'utf8').split('\n').filter((l) => l.startsWith('dsh web: '));
    if (!lines.length) return null;
    return lines[lines.length - 1].slice('dsh web: '.length).trim().split(/\s+/)[0] || null;
  } catch { return null; }
}

function setStatus(patch) {
  lastStatus = { ...lastStatus, ...patch };
  if (toolbarView && !toolbarView.webContents.isDestroyed()) {
    toolbarView.webContents.send('status', lastStatus);
  }
}

/**
 * 读取 app-npm/.env 并注入子进程环境。
 * 对应 Windows 版 start-dsh.ps1 的行为：核心不会自己读 .env，
 * 必须由启动方解析后以环境变量传给子进程（DSH_* 变量则禁止写在 .env 里）。
 */
function loadEnvFile() {
  const out = {};
  try {
    const text = fs.readFileSync(path.join(APP_NPM, '.env'), 'utf8');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const value = m[2].trim().replace(/^["']|["']$/g, '');
      if (value) out[m[1]] = value;
    }
  } catch { /* 没有 .env 就跳过 */ }
  return out;
}

// ---------------------------------------------------------------------------
// 主题：让外壳跟着内嵌 DSH 界面一起浅色/深色
//
// 与 Windows 版（DshDesktop\Theme.cs）同一套做法：读网页端的
// body[data-ds-dark-theme] / documentElement.style.colorScheme，并用「探针元素 +
// 计算样式」把 --dsw-alias-* 设计令牌解析成真实 rgb 后推给控制条；
// 网页还没起来（启动页）时先跟随 macOS 系统外观。
// ---------------------------------------------------------------------------

const THEME_PROBE = `(() => {
  const SENTINEL = 'rgba(1, 2, 3, 0.5)';
  const KEYS = {
    bgBase: '--dsw-alias-bg-base',
    border2: '--dsw-alias-border-l2',
    label1: '--dsw-alias-label-primary',
    label2: '--dsw-alias-label-secondary',
    label3: '--dsw-alias-label-tertiary'
  };
  const body = document.body;
  const html = document.documentElement;
  if (!body) return { known: false };
  const scheme = (html && html.style && html.style.colorScheme) || '';
  let dark = scheme === 'dark' || body.hasAttribute('data-ds-dark-theme');
  const known = scheme === 'dark' || scheme === 'light' || body.hasAttribute('data-ds-dark-theme');
  let probe = document.getElementById('__dsh_desktop_theme_probe');
  if (!probe) {
    probe = document.createElement('span');
    probe.id = '__dsh_desktop_theme_probe';
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0;pointer-events:none;';
    body.appendChild(probe);
  }
  const cs = getComputedStyle(probe);
  const tokens = {};
  for (const key in KEYS) {
    probe.style.color = 'var(' + KEYS[key] + ', ' + SENTINEL + ')';
    const value = cs.color;
    if (value && value !== SENTINEL && value !== 'rgb(1, 2, 3)') tokens[key] = value;
  }
  probe.style.color = '';
  return { known: known, dark: !!dark, tokens: tokens };
})()`;

function broadcastTheme() {
  if (win && !win.isDestroyed()) {
    win.setBackgroundColor(currentTheme.dark ? '#151517' : '#ffffff');
  }
  if (versionWin && !versionWin.isDestroyed()) {
    versionWin.setBackgroundColor(currentTheme.dark ? '#151517' : '#ffffff');
    const vpayload = JSON.stringify(currentTheme);
    if (vpayload !== versionThemeSent) {
      versionThemeSent = vpayload;
      versionWin.webContents.send('theme', currentTheme);
    }
  }
  if (!toolbarView || toolbarView.webContents.isDestroyed()) return;
  const payload = JSON.stringify(currentTheme);
  if (payload === themeSent) return;
  themeSent = payload;
  toolbarView.webContents.send('theme', currentTheme);
}

async function pollTheme() {
  if (contentView && !contentView.webContents.isDestroyed()) {
    try {
      const r = await contentView.webContents.executeJavaScript(THEME_PROBE, false);
      if (r && r.known === true) {
        pageThemeKnown = true;
        currentTheme = { dark: !!r.dark, tokens: r.tokens || {} };
      } else if (!pageThemeKnown) {
        currentTheme = { dark: nativeTheme.shouldUseDarkColors, tokens: {} };
      }
    } catch { /* 页面未就绪或已崩溃：保持上一次的值 */ }
  }
  broadcastTheme();
}

/**
 * Dock 图标跟随 macOS 外观（与 Windows 版按 SystemUsesLightTheme 切换同一思路）：
 * 深色用原图（黑底），浅色用黑底换成白底的那版。Finder / Launchpad 取的是包内
 * DSH.icns（深色那版，静态图标切换不了）。
 */
function applyDockIcon() {
  if (!app.dock) return;   // 只有 macOS 有 dock
  const file = nativeTheme.shouldUseDarkColors ? 'dock-dark.png' : 'dock-light.png';
  try { app.dock.setIcon(path.join(__dirname, file)); }
  catch (e) { log('设置 Dock 图标失败', e.message); }
}

// ---------------------------------------------------------------------------
// DeepSeek 官方余额（右下角）
//
// 与 Windows 版（Balance.cs）一致：GET /user/balance，优先取人民币那条；
// 启动查一次 → 每 5 分钟一次 → 切回窗口超过 60 秒补一次；失败降到 1 分钟重试。
// 密钥只从 DEEPSEEK_API_KEY 读，只进 Authorization 头，不写日志。
// ---------------------------------------------------------------------------

const BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance';
const BALANCE_OK_MS = 5 * 60 * 1000;
const BALANCE_RETRY_MS = 60 * 1000;
const BALANCE_STALE_MS = 60 * 1000;

function apiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  const fromFile = loadEnvFile().DEEPSEEK_API_KEY;
  return fromFile ? fromFile.trim() : '';
}

function broadcastBalance() {
  if (toolbarView && !toolbarView.webContents.isDestroyed()) {
    toolbarView.webContents.send('balance', currentBalance);
  }
}

function scheduleBalance(ms) {
  if (balanceTimer) clearTimeout(balanceTimer);
  balanceTimer = setTimeout(() => { refreshBalance(); }, ms);
}

function amount(info, name) {
  const v = Number(info && info[name]);
  return Number.isFinite(v) ? v : 0;
}

function fmtMoney(currency, value) {
  const symbol = String(currency || 'CNY').toUpperCase() === 'USD' ? '$' : '¥';
  return symbol + value.toFixed(2);
}

async function refreshBalance() {
  if (balanceBusy) return currentBalance;
  balanceBusy = true;
  lastBalanceAttempt = Date.now();
  const key = apiKey();

  if (!key) {
    currentBalance = {
      display: '—',
      tooltip: 'DeepSeek 官方余额不可用\n未找到 DEEPSEEK_API_KEY（app-npm/.env）',
      low: false,
    };
    broadcastBalance();
    balanceBusy = false;
    scheduleBalance(BALANCE_OK_MS);
    return currentBalance;
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let resp;
    try {
      resp = await fetch(BALANCE_ENDPOINT, {
        headers: { Authorization: `Bearer ${key}` },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      throw new Error(resp.status === 401 ? '密钥无效或已过期（401）' : `查询失败：HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
    if (!infos.length) throw new Error('接口未返回余额信息');

    // 官方会同时返回 USD / CNY 两条（USD 通常是 0），优先人民币
    const pick = infos.find((i) => String(i.currency).toUpperCase() === 'CNY') || infos[0];
    const total = amount(pick, 'total_balance');
    const granted = amount(pick, 'granted_balance');
    const toppedUp = amount(pick, 'topped_up_balance');
    const low = data.is_available !== true || total < 10;

    currentBalance = {
      display: fmtMoney(pick.currency, total),
      tooltip: 'DeepSeek 官方账户余额\n'
        + `总计 ${fmtMoney(pick.currency, total)}`
        + `（赠送 ${fmtMoney(pick.currency, granted)} + 充值 ${fmtMoney(pick.currency, toppedUp)}）\n`
        + (data.is_available === true ? '' : '余额不足，API 调用会被拒绝\n')
        + `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · 每 5 分钟自动刷新，点击立即刷新`,
      low,
    };
    broadcastBalance();
    scheduleBalance(BALANCE_OK_MS);
  } catch (e) {
    const reason = e && e.name === 'AbortError' ? '查询超时' : (e && e.message) || String(e);
    currentBalance = {
      display: '—',
      tooltip: `DeepSeek 官方余额不可用\n${reason}\n点击重试`,
      low: false,
    };
    broadcastBalance();
    log('余额查询失败', reason);
    scheduleBalance(BALANCE_RETRY_MS);
  } finally {
    balanceBusy = false;
  }
  return currentBalance;
}

// ---------------------------------------------------------------------------
// 首次运行：把只读包内资源展开到可写数据目录
// ---------------------------------------------------------------------------

function copyRecursive(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) copyRecursive(path.join(src, name), path.join(dest, name));
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    if (st.mode & 0o111) { try { fs.chmodSync(dest, 0o755); } catch { /* ignore */ } }
  }
}

function extractStoreTar() {
  // 用 macOS 自带的 tar（bsdtar）解压，避免在 JS 里造一个 tar 解析器
  const r = spawnSync('/usr/bin/tar', ['-xzf', STORE_TAR, '-C', SUPPORT], { stdio: 'pipe' });
  if (r.status !== 0) {
    throw new Error(`解压离线依赖缓存失败：${(r.stderr || '').toString().slice(0, 400)}`);
  }
}

// git 分发版出于体积考虑可能不带 store.tar.gz（264MB）。
// 缺少它不是致命错误：跳过离线缓存，交给 prepareDir 走联网安装。
function storeTarAvailable() {
  return fs.existsSync(STORE_TAR);
}

async function bootstrapSupport() {
  fs.mkdirSync(SUPPORT, { recursive: true });
  fs.mkdirSync(LOGS, { recursive: true });

  const needsSeed = !fs.existsSync(path.join(APP_NPM, 'pnpm-lock.yaml'))
    || !fs.existsSync(path.join(DSH_HOME, 'settings.yaml'));
  if (needsSeed) {
    setStatus({ phase: 'bootstrap', message: '首次运行：正在展开数据目录…' });
    for (const name of ['app-npm', 'dsh-home', 'plugins']) {
      const src = path.join(SEED_DIR, name);
      if (fs.existsSync(src)) copyRecursive(src, path.join(SUPPORT, name));
    }
    for (const name of ['plugin-track.json', '.env.example', 'tools', 'dsh', 'start-dsh.sh', 'stop-dsh.sh']) {
      const src = path.join(SEED_DIR, name);
      if (fs.existsSync(src)) copyRecursive(src, path.join(SUPPORT, name));
    }
  }

  if (!fs.existsSync(path.join(STORE_DIR, 'v11', 'index.db'))) {
    if (storeTarAvailable()) {
      setStatus({ phase: 'bootstrap', message: '首次运行：正在解压离线依赖缓存…' });
      extractStoreTar();
    } else {
      log('未随包提供 store.tar.gz，跳过离线缓存，依赖将联网安装');
      appendLog(OUT_LOG, '\n[desktop] 未随包提供 store.tar.gz，跳过离线缓存展开，依赖将联网获取\n');
      setStatus({ phase: 'install', message: '首次运行：无离线缓存，正在联网准备依赖…' });
    }
  }
}

// ---------------------------------------------------------------------------
// 依赖安装 / 校验（离线优先，失败再联网）
// ---------------------------------------------------------------------------

function installIsStale(dir) {
  const installed = path.join(dir, 'node_modules', '.pnpm', 'lock.yaml');
  const wanted = path.join(dir, 'pnpm-lock.yaml');
  if (!fs.existsSync(wanted)) return false;
  if (!fs.existsSync(installed)) return true;
  try {
    return Buffer.compare(fs.readFileSync(installed), fs.readFileSync(wanted)) !== 0;
  } catch { return true; }
}

function missingDeps(dir) {
  const pkg = readJsonSafe(path.join(dir, 'package.json'));
  if (!pkg || !pkg.dependencies) return [];
  return Object.keys(pkg.dependencies)
    .filter((n) => !fs.existsSync(path.join(dir, 'node_modules', n, 'package.json')));
}

function runPnpmInstall(dir, extra) {
  const env = { ...process.env, CI: 'true', PATH: `${path.dirname(NODE_BIN)}:${process.env.PATH || ''}` };
  const r = spawnSync(NODE_BIN, [PNPM_JS, 'install', ...extra, '--store-dir', STORE_DIR], {
    cwd: dir, env, stdio: 'pipe',
  });
  const out = `${(r.stdout || '').toString()}\n${(r.stderr || '').toString()}`;
  appendLog(OUT_LOG, out);
  return r.status === 0;
}

function prepareDir(dir, label) {
  const stale = installIsStale(dir);
  const miss = missingDeps(dir);
  if (!stale && miss.length === 0) return;

  setStatus({ phase: 'install', message: stale ? `${label}：检测到版本更新，正在重装…` : `${label}：正在恢复依赖…` });
  const offlineArgs = ['--offline', '--force', '--ignore-scripts', '--frozen-lockfile'];
  const didOffline = runPnpmInstall(dir, offlineArgs);
  if (didOffline && installIsStale(dir) === false && missingDeps(dir).length === 0) return;

  setStatus({ phase: 'install', message: `${label}：离线缓存不足，正在联网补齐…` });
  // 与离线路径保持一致地跳过构建脚本：原生模块随包提供预编译产物，
  // 联网补齐时不应触发 node-gyp（克隆到新机器上未必装了命令行工具）。
  runPnpmInstall(dir, ['--force', '--frozen-lockfile', '--ignore-scripts']);
  if (installIsStale(dir) || missingDeps(dir).length > 0) {
    throw new Error(`${label} 依赖准备失败，请检查网络后重试（日志：${OUT_LOG}）`);
  }
}

async function prepareDependencies() {
  if (!fs.existsSync(NODE_BIN)) throw new Error(`缺少随包 Node：${NODE_BIN}`);
  if (!fs.existsSync(PNPM_JS)) throw new Error(`缺少随包 pnpm：${PNPM_JS}`);

  prepareDir(APP_NPM, '核心');
  prepareDir(WEB_PROFILE, 'Web 插件');
  ensureExecutableBits();

  const v = coreVersion();
  appendLog(OUT_LOG, `\n===== ${new Date().toISOString()} 依赖就绪，核心版本 ${v} =====\n`);
  setStatus({ coreVersion: v });
  return v;
}

// ---------------------------------------------------------------------------
// 服务生命周期
// ---------------------------------------------------------------------------

async function startServer() {
  if (await portOpen(PORT)) {
    const url = urlFromLog() || `http://127.0.0.1:${PORT}`;
    authenticatedUrl = url;
    weStartedServer = false;
    setStatus({ running: true, url, message: '已连接到运行中的实例', phase: 'running' });
    return url;
  }
  if (!fs.existsSync(CORE_BIN)) throw new Error(`缺少 DSH 核心入口：${CORE_BIN}（依赖未就绪）`);

  // 新版核心启用 Web 认证：必须让核心自己打印带 token 的地址；
  // 桌面壳用 --no-open 阻止它另开浏览器，改由我们把该地址装进窗口。
  const args = [CORE_BIN, 'web', '--port', String(PORT), '--no-open'];
  const env = {
    ...process.env,
    ...loadEnvFile(),
    DSH_HOME,
    DSH_NO_UPDATE_CHECK: '1',
    PATH: `${path.dirname(NODE_BIN)}:${process.env.PATH || ''}`,
  };

  setStatus({ phase: 'starting', message: `正在启动服务（端口 ${PORT}）…` });

  return await new Promise((resolve, reject) => {
    let settled = false;
    const proc = spawn(NODE_BIN, args, { cwd: APP_NPM, env });
    serverProc = proc;
    weStartedServer = true;

    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('启动超时（60 秒未就绪），请查看日志。')); }
    }, 60000);

    const onData = (buf, isErr) => {
      const text = buf.toString();
      appendLog(isErr ? ERR_LOG : OUT_LOG, text);
      const m = text.match(/dsh web:\s+(http\S+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        authenticatedUrl = m[1];
        setStatus({ running: true, url: authenticatedUrl, message: '运行中', phase: 'running' });
        resolve(authenticatedUrl);
      }
    };
    proc.stdout.on('data', (b) => onData(b, false));
    proc.stderr.on('data', (b) => onData(b, true));
    proc.on('error', (err) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(err); }
    });
    proc.on('exit', (code) => {
      serverProc = null;
      if (!settled) {
        settled = true; clearTimeout(timer);
        reject(new Error(`服务进程退出（code=${code}），请查看日志。`));
      } else {
        setStatus({ running: false, message: `服务已停止（code=${code}）`, phase: 'stopped' });
      }
    });
  });
}

function stopServer() {
  const proc = serverProc;
  serverProc = null;
  if (proc) {
    try { proc.kill('SIGTERM'); } catch (e) { log('kill 失败', e.message); }
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 3000);
  }
  setStatus({ running: false, url: null, message: '已停止', phase: 'stopped' });
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function layoutViews() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  if (toolbarView) toolbarView.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT });
  if (contentView) contentView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) });
}

async function loadAppUi(url) {
  if (!contentView) return;
  try { await contentView.webContents.loadURL(url); } catch (e) { log('loadURL 失败', e.message); }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 880, minWidth: 900, minHeight: 600,
    title: 'DeepSeek Harness',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151517' : '#ffffff',
    show: false,
  });

  toolbarView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  contentView = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  win.contentView.addChildView(toolbarView);
  win.contentView.addChildView(contentView);
  layoutViews();
  win.on('resize', layoutViews);
  toolbarView.webContents.loadFile(path.join(__dirname, 'toolbar', 'toolbar.html'));
  contentView.webContents.loadFile(path.join(__dirname, 'loading.html'));

  // 切回窗口时，若距上次查询超过 60 秒就顺手刷一次余额（与 Windows 版一致）
  win.on('focus', () => {
    if (Date.now() - lastBalanceAttempt > BALANCE_STALE_MS) refreshBalance();
  });

  // 新文档开始加载：网页端主题还没回传前，先退回跟随 macOS 外观
  contentView.webContents.on('did-start-loading', () => { pageThemeKnown = false; });

  contentView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.includes(`127.0.0.1:${PORT}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // The host webContents never navigates; child WebContentsViews render the UI.
  // Show explicitly instead of waiting for the host ready-to-show event.
  win.show();
  win.focus();
  log('Window visible:', win.isVisible(), 'bounds:', win.getBounds());
  win.on('closed', () => { win = null; toolbarView = null; contentView = null; });
}

/**
 * 版本信息窗口。
 *
 * 不能用工具栏里的 <dialog>：工具栏是一个只有 TOOLBAR_HEIGHT(46px) 高的
 * WebContentsView，而浏览器给 dialog 的默认样式带
 * `max-height: calc(100% - 6px - 2em)` —— 在 46px 的视口里算下来只剩约 8px，
 * 内容被压成一条缝，用户什么都读不到（还会以为「乱码」）。
 * 所以单独开一个正常尺寸的窗口，文字可滚动、可选中复制。
 */
function showVersionInfo() {
  if (versionWin && !versionWin.isDestroyed()) {
    versionWin.show();
    versionWin.focus();
    versionWin.webContents.reload();
    return { ok: true };
  }

  versionWin = new BrowserWindow({
    width: 820, height: 680, minWidth: 560, minHeight: 380,
    title: 'DSH 版本信息',
    parent: win && !win.isDestroyed() ? win : undefined,
    show: false,
    backgroundColor: currentTheme.dark ? '#151517' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  versionWin.loadFile(path.join(__dirname, 'version.html'));
  versionWin.once('ready-to-show', () => versionWin.show());
  versionWin.on('closed', () => { versionWin = null; });
  return { ok: true };
}

function buildMenu() {
  // macOS 没有应用菜单时复制/粘贴等快捷键不可用，必须显式构建
  const template = [
    {
      label: 'DSH',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: '刷新界面', accelerator: 'CmdOrCtrl+R', click: () => contentView && contentView.webContents.reload() },
        { label: '在浏览器中打开', click: () => authenticatedUrl && shell.openExternal(authenticatedUrl) },
        { label: '打开数据目录', click: () => shell.openPath(SUPPORT) },
        { label: '打开日志目录', click: () => shell.openPath(LOGS) },
        { label: '版本信息…', click: () => showVersionInfo() },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: '退出 DSH' },
      ],
    },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// 启动流程（首次运行会先准备数据目录与依赖）
// ---------------------------------------------------------------------------

async function bootAndStart() {
  try {
    await bootstrapSupport();
    await prepareDependencies();
    const url = await startServer();
    await loadAppUi(url);
  } catch (e) {
    log('启动失败', e);
    setStatus({ running: false, phase: 'error', message: `启动失败：${e.message}` });
    dialog.showErrorBox('DSH 启动失败', `${e.message}\n\n数据目录：${SUPPORT}\n日志：${LOGS}`);
  }
}

function registerIpc() {
  ipcMain.handle('get-status', () => ({
    ...lastStatus, coreVersion: coreVersion(), plugins: pluginVersions(),
    port: PORT, home: DSH_HOME, support: SUPPORT,
    shellVersion: app.getVersion(),
  }));

  ipcMain.handle('get-theme', () => currentTheme);
  ipcMain.handle('get-balance', () => currentBalance);
  ipcMain.handle('refresh-balance', () => refreshBalance());
  ipcMain.handle('copy-text', (_event, text) => {
    try { clipboard.writeText(String(text == null ? '' : text)); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('start', async () => {
    try { const url = await startServer(); await loadAppUi(url); return { ok: true }; }
    catch (e) { setStatus({ running: false, message: `启动失败：${e.message}` }); return { ok: false, error: e.message }; }
  });

  ipcMain.handle('stop', () => { stopServer(); return { ok: true }; });

  ipcMain.handle('restart', async () => {
    try {
      stopServer();
      await new Promise((r) => setTimeout(r, 1200));
      const url = await startServer();
      await loadAppUi(url);
      return { ok: true };
    } catch (e) { setStatus({ running: false, message: `重启失败：${e.message}` }); return { ok: false, error: e.message }; }
  });

  ipcMain.handle('reload-ui', () => { if (contentView) contentView.webContents.reload(); return { ok: true }; });
  ipcMain.handle('open-browser', () => { if (authenticatedUrl) shell.openExternal(authenticatedUrl); return { ok: true }; });
  ipcMain.handle('open-logs', () => { shell.openPath(LOGS); return { ok: true }; });
  ipcMain.handle('show-version-info', () => showVersionInfo());

  ipcMain.handle('read-log-tail', () => {
    // 只读末尾 64KB：日志可能很大，整份读进来既慢又占内存。
    // 再经 sanitizeLog 剥掉 ANSI / 控制字符，避免界面里出现「乱码」。
    const read = (file) => {
      try {
        const st = fs.statSync(file);
        const start = Math.max(0, st.size - 64 * 1024);
        const len = st.size - start;
        if (len <= 0) return '';
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, start);
          return sanitizeLog(buf.toString('utf8'), 40);
        } finally { fs.closeSync(fd); }
      } catch { return ''; }
    };
    try {
      return { ok: true, err: read(ERR_LOG), out: read(OUT_LOG), logsDir: LOGS };
    } catch (e) { return { ok: false, error: e.message }; }
  });
}

// ---------------------------------------------------------------------------

/**
 * 找出「正在占用单实例锁」的那份 DSH。
 * Electron 把锁写成 userData/SingletonLock 符号链接，内容形如 `MacBookAir.lan-12345`。
 * 我们顺着这个 pid 反查它的可执行文件路径，好在弹窗里直接告诉用户关哪一个 ——
 * 否则用户只会看到「双击没反应」，根本不知道是另一个副本在跑。
 */
function findRunningInstance() {
  try {
    const lock = fs.readlinkSync(path.join(app.getPath('userData'), 'SingletonLock'));
    const pid = Number(String(lock).trim().split('-').pop());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const r = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    const command = String(r.stdout || '').trim();
    const m = command.match(/^(.+?\.app)\/Contents\/MacOS\//);
    return { pid, appPath: m ? m[1] : null, command };
  } catch { return null; }
}

if (!app.requestSingleInstanceLock()) {
  // 两份 DSH 共用同一个 userData 目录（~/Library/Application Support/DSH/electron），
  // 而单实例锁是按 userData 算的 —— 所以任何位置的两份 DSH.app 都抢同一把锁。
  // 抢不到就直接 app.quit() 的话，用户看到的是「双击完全没反应」，
  // 极容易误判成「包坏了 / 签名有问题」。这里必须显式说明。
  const other = findRunningInstance();
  const lines = [
    '已经有一个 DSH 在运行，所以这次启动被忽略了。',
    '',
    '两份 DSH 共用同一个数据目录，同一时间只能开一个：',
    '后启动的这一个拿不到锁，会直接退出（所以看起来「双击没反应」）。',
  ];
  if (other && other.appPath) {
    lines.push('', '正在运行的副本：', `    ${other.appPath}`, `    （进程 PID ${other.pid}）`);
  } else if (other) {
    lines.push('', `正在运行的进程：PID ${other.pid}`);
  }
  lines.push(
    '',
    '请先退出正在运行的 DSH，再重新打开这一个：',
    '  · 在它的窗口里按 ⌘Q；或',
    '  · 菜单栏「DSH」→「退出 DSH」；或',
    '  · 右键 Dock 里的 DSH 图标 →「退出」。',
    '',
    '确认退干净（Dock 里没有 DSH 图标）后，再重新双击本 App。',
    '',
    '提示：最好只保留一份 DSH.app。桌面 / 下载 / 应用程序各留一份会一直互相抢锁。',
  );
  try {
    dialog.showErrorBox('DSH 已经在运行', lines.join('\n'));
  } catch { /* 弹窗失败也要继续退出，不能卡住 */ }
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });

  app.on('activate', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    registerIpc();
    createWindow();
    toolbarView.webContents.once('did-finish-load', () => { bootAndStart(); });

    // 外壳主题：跟随 macOS 外观起步，网页端起来后以网页端为准
    nativeTheme.on('updated', () => {
      applyDockIcon();
      if (pageThemeKnown) return;
      currentTheme = { dark: nativeTheme.shouldUseDarkColors, tokens: {} };
      broadcastTheme();
    });
    applyDockIcon();
    pollTheme();
    setInterval(pollTheme, 1500);

    // 余额：启动查一次，之后按 5 分钟 / 失败 1 分钟自动刷新
    refreshBalance();
  });

  app.on('window-all-closed', () => { if (weStartedServer) stopServer(); app.quit(); });
  app.on('before-quit', () => { if (weStartedServer) stopServer(); });
}
