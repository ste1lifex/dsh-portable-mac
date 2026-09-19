// DSH 桌面壳控制条逻辑（macOS / Electron）
// 与 Windows 版 DshDesktop 的行为对齐：外壳跟随内嵌界面的浅色/深色，
// 右下角显示 DeepSeek 官方余额，日志可选中复制。
const $ = (id) => document.getElementById(id);

const btnStart = $('btn-start');
const btnStop = $('btn-stop');
const btnRestart = $('btn-restart');
const btnBalance = $('btn-balance');
const dot = $('dot');
const statusEl = $('status');
const balanceEl = $('balance');

let running = false;
let busy = false;
let lastStatus = null;
let lastBalance = null;

function setBusy(v) {
  busy = v;
  btnStart.disabled = v || running;
  btnStop.disabled = v || !running;
  btnRestart.disabled = v;
}

function applyStatus(s) {
  if (!s) return;
  lastStatus = { ...(lastStatus || {}), ...s };
  running = !!s.running;
  dot.classList.toggle('on', running);
  statusEl.textContent = s.message || (running ? '运行中' : '未启动');
  statusEl.classList.toggle('err', /失败|错误|超时/.test(statusEl.textContent));
  statusEl.title = statusEl.textContent;
  setBusy(busy);
}

// ---------------------------------------------------------------------------
// 主题：主进程把内嵌界面（body[data-ds-dark-theme] + --dsw-alias-* 令牌）推过来
// ---------------------------------------------------------------------------

const TOKEN_VARS = {
  border2: '--border',
  label1: '--text-primary',
  label2: '--text-secondary',
  label3: '--text-dim',
  bgBase: '--window-bg',
};

function applyTheme(t) {
  if (!t) return;
  const light = !t.dark;
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  const root = document.documentElement.style;
  for (const name of Object.values(TOKEN_VARS)) root.removeProperty(name);
  const tokens = t.tokens || {};
  for (const [token, cssVar] of Object.entries(TOKEN_VARS)) {
    if (tokens[token]) root.setProperty(cssVar, tokens[token]);
  }
}

// ---------------------------------------------------------------------------
// 余额
// ---------------------------------------------------------------------------

function applyBalance(b) {
  if (!b) return;
  lastBalance = b;
  balanceEl.textContent = b.display || '—';
  btnBalance.classList.toggle('low', !!b.low);
  btnBalance.title = b.tooltip || 'DeepSeek 官方余额';
}

btnBalance.addEventListener('click', async () => {
  if (btnBalance.disabled) return;
  btnBalance.disabled = true;
  try { applyBalance(await window.dsh.refreshBalance()); }
  finally { btnBalance.disabled = false; }
});

// ---------------------------------------------------------------------------
// 服务控制
// ---------------------------------------------------------------------------

async function refresh() {
  const s = await window.dsh.getStatus();
  applyStatus(s);
  return s;
}

btnStart.addEventListener('click', async () => {
  setBusy(true);
  statusEl.textContent = '正在启动…';
  const r = await window.dsh.start();
  setBusy(false);
  await refresh();
  if (!r.ok) statusEl.textContent = '启动失败：' + r.error;
});

btnStop.addEventListener('click', async () => {
  setBusy(true);
  await window.dsh.stop();
  setBusy(false);
  await refresh();
});

btnRestart.addEventListener('click', async () => {
  setBusy(true);
  statusEl.textContent = '正在重启…';
  const r = await window.dsh.restart();
  setBusy(false);
  await refresh();
  if (!r.ok) statusEl.textContent = '重启失败：' + r.error;
});

$('btn-reload').addEventListener('click', () => window.dsh.reloadUi());
$('btn-browser').addEventListener('click', () => window.dsh.openBrowser());
$('btn-logs').addEventListener('click', () => window.dsh.openLogs());

// ---------------------------------------------------------------------------
// 版本信息：交给主进程单独开一个正常尺寸的窗口（version.html）
//
// 这里**不能**再用 <dialog>：本控制条是一个只有 46px 高的 WebContentsView，
// 而 dialog 的 UA 默认样式带 `max-height: calc(100% - 6px - 2em)`，
// 在 46px 的视口里算下来只剩约 8px —— 内容被压成一条缝，什么都读不到。
// ---------------------------------------------------------------------------

$('btn-info').addEventListener('click', () => window.dsh.showVersionInfo());

// ---------------------------------------------------------------------------
// 启动时先问一遍当前主题，避免浅色模式下先闪一下深色
// ---------------------------------------------------------------------------

window.dsh.onStatus(applyStatus);
window.dsh.onTheme(applyTheme);
window.dsh.onBalance(applyBalance);

(async () => {
  try { applyTheme(await window.dsh.getTheme()); } catch { /* 忽略 */ }
  try { applyBalance(await window.dsh.getBalance()); } catch { /* 忽略 */ }
  await refresh();
})();
