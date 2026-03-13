const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getDeviceContext: () => ipcRenderer.invoke('get-device-context'),
  runInteractiveCommand: (command) => ipcRenderer.invoke('run-interactive-command', command),
  onCommandStream: (handler) => {
    ipcRenderer.on('command-stream', (_event, msg) => {
      if (typeof handler === 'function') handler(msg);
    });
  },
});
