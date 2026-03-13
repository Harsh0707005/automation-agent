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
  // Memory (desktop-side storage only)
  getMemory: () => ipcRenderer.invoke('get-memory'),
  saveMemory: (chunks) => ipcRenderer.invoke('save-memory', chunks),
  addMemoryChunks: (chunks) => ipcRenderer.invoke('add-memory-chunks', chunks),
  deleteMemoryChunk: (id) => ipcRenderer.invoke('delete-memory-chunk', id),
});
