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
const dlg = $('dlg');

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
// 版本信息弹窗
// ---------------------------------------------------------------------------

let dialogText = '';

$('btn-info').addEventListener('click', async () => {
  const s = await window.dsh.getStatus();
  const logs = await window.dsh.readLogTail();
  applyStatus(s);

  $('i-shell').textContent = s.shellVersion ? 'v' + s.shellVersion : '(未知)';
  $('i-core').textContent = s.coreVersion ? '@deepseek-ai/dsh ' + s.coreVersion : '(未知)';
  $('i-port').textContent = String(s.port || '');
  $('i-home').textContent = s.home || 'dsh-home/';

  const plugins = (s.plugins || [])
    .map((p) => `<tr><td>${p.label}</td><td>${p.name} @ ${p.version}</td></tr>`)
    .join('');
  $('i-plugins').innerHTML = plugins || '<tr><td>(无)</td><td></td></tr>';

  const errLog = (logs && (logs.err || '').trim()) || '(空)';
  $('i-log').textContent = errLog;

  // 「复制全部」用的纯文本（与 Windows 版「复制全部」一致的做法）
  dialogText = [
    'DSH 版本信息',
    `桌面外壳：${$('i-shell').textContent}`,
    `核心：${$('i-core').textContent}`,
    `端口：${$('i-port').textContent}`,
    `数据目录：${$('i-home').textContent}`,
    '',
    '插件：',
    ...(s.plugins || []).map((p) => `  ${p.label}  ${p.name} @ ${p.version}`),
    '',
    '错误日志（末尾）：',
    errLog,
  ].join('\n');

  dlg.showModal();
});

$('btn-copy').addEventListener('click', async () => {
  const text = window.getSelection && String(window.getSelection()).trim()
    ? String(window.getSelection())
    : dialogText;
  const r = await window.dsh.copyText(text);
  const btn = $('btn-copy');
  btn.textContent = r && r.ok ? '已复制' : '复制失败';
  setTimeout(() => { btn.textContent = '复制全部'; }, 1200);
});

$('btn-close').addEventListener('click', () => dlg.close());

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
