const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getDeviceContext: () => ipcRenderer.invoke('get-device-context'),
  runInteractiveCommand: (command, cmdId) => ipcRenderer.invoke('run-interactive-command', command, cmdId),
  onCommandStream: (handler) => {
    ipcRenderer.on('command-stream', (_event, msg) => {
      if (typeof handler === 'function') handler(msg);
    });
  },
  // Conversation history (desktop-side storage only)
  listConversations: () => ipcRenderer.invoke('list-conversations'),
  getConversation: (id) => ipcRenderer.invoke('get-conversation', id),
  saveConversation: (conv) => ipcRenderer.invoke('save-conversation', conv),
  deleteConversation: (id) => ipcRenderer.invoke('delete-conversation', id),
});
