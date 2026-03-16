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
  // Snapshots for revert support
  saveSnapshots: (messageId, snapshots) => ipcRenderer.invoke('save-snapshots', messageId, snapshots),
  getSnapshots: (messageId) => ipcRenderer.invoke('get-snapshots', messageId),
  deleteSnapshots: (messageId) => ipcRenderer.invoke('delete-snapshots', messageId),
  restoreFileSnapshot: (filePath, originalContent, existed) => ipcRenderer.invoke('restore-file-snapshot', filePath, originalContent, existed),
  // Knowledge Index (runs entirely on user's device as local subprocess)
  knowledgeGetDataDir: () => ipcRenderer.invoke('knowledge-get-data-dir'),
  knowledgeScan: (directory) => ipcRenderer.invoke('knowledge-scan', directory),
  knowledgeSearch: (query, options) => ipcRenderer.invoke('knowledge-search', query, options),
  knowledgeStats: () => ipcRenderer.invoke('knowledge-stats'),
  knowledgeStatus: () => ipcRenderer.invoke('knowledge-status'),
  knowledgeClearAll: () => ipcRenderer.invoke('knowledge-clear-all'),
  knowledgePickRoot: () => ipcRenderer.invoke('knowledge-pick-root'),
  // Allowed search directories
  knowledgeGetAllowedDirs: () => ipcRenderer.invoke('knowledge-get-allowed-dirs'),
  knowledgeAddAllowedDir: () => ipcRenderer.invoke('knowledge-add-allowed-dir'),
  knowledgeRemoveAllowedDir: (dirPath) => ipcRenderer.invoke('knowledge-remove-allowed-dir', dirPath),
  onKnowledgeProgress: (handler) => {
    ipcRenderer.on('knowledge-progress', (_event, status) => {
      if (typeof handler === 'function') handler(status);
    });
  },
});
