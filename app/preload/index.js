const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getDeviceContext: () => ipcRenderer.invoke('get-device-context'),
});
