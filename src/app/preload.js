// 控制条与主进程之间的安全桥接（contextIsolation 下只暴露必要方法）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dsh', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  start: () => ipcRenderer.invoke('start'),
  stop: () => ipcRenderer.invoke('stop'),
  restart: () => ipcRenderer.invoke('restart'),
  reloadUi: () => ipcRenderer.invoke('reload-ui'),
  openBrowser: () => ipcRenderer.invoke('open-browser'),
  openLogs: () => ipcRenderer.invoke('open-logs'),
  readLogTail: () => ipcRenderer.invoke('read-log-tail'),
  onStatus: (cb) => {
    ipcRenderer.on('status', (_event, status) => cb(status));
  },

  // 主题：跟随内嵌 DSH 界面的浅色/深色（含皮肤设计令牌）
  getTheme: () => ipcRenderer.invoke('get-theme'),
  onTheme: (cb) => {
    ipcRenderer.on('theme', (_event, theme) => cb(theme));
  },

  // DeepSeek 官方余额
  getBalance: () => ipcRenderer.invoke('get-balance'),
  refreshBalance: () => ipcRenderer.invoke('refresh-balance'),
  onBalance: (cb) => {
    ipcRenderer.on('balance', (_event, balance) => cb(balance));
  },

  // 复制到系统剪贴板（走主进程，免去网页剪贴板权限）
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
});
