'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const call = (ch, arg) => ipcRenderer.invoke(ch, arg);
contextBridge.exposeInMainWorld('pool', {
  state: () => call('state'),
  onState: fn => ipcRenderer.on('state', (_e, s) => fn(s)),
  addKeys: (text, tier, name) => call('add-keys', { text, tier, name }),
  rename: (id, name) => call('rename', { id, name }),
  setTier: (id, tier) => call('set-tier', { id, tier }),
  move: (id, dir) => call('move', { id, dir }),
  remove: id => call('remove', { id }),
  wake: id => call('wake', { id }),
  test: id => call('test', { id }),
  copy: text => call('copy', text),
  setAutoStart: on => call('set-autostart', on),
  openExternal: url => call('open-external', url),
  retryPort: () => call('retry-port'),
  setCredit: (id, amount, day, remaining) => call('set-credit', { id, amount, day, remaining }),
  clearCalib: id => call('clear-calib', { id }),
  report: () => call('report'),
  exportCsv: () => call('export-csv'),
  setTheme: t => call('set-theme', t),
  checkUpdate: () => call('check-update'),
  applyUpdate: () => call('apply-update'),
  chooseDataDir: () => call('choose-data-dir'),
  clearDataDir: () => call('clear-data-dir'),
  openDataDir: () => call('open-data-dir'),
  takeover: () => call('takeover'),
});
