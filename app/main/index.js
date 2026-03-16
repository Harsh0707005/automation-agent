const { app, BrowserWindow, screen, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const readline = require('readline');

const RENDERER_PATH = path.join(__dirname, '..', 'renderer');
const PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'index.js');

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width,
    height,
    x: screen.getPrimaryDisplay().workArea.x,
    y: screen.getPrimaryDisplay().workArea.y,
    backgroundColor: '#0d0d0d',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: PRELOAD_PATH,
    },
  });
  win.loadFile(path.join(RENDERER_PATH, 'index.html'));
}

const MACOS_VERSION_NAMES = {
  '10': 'Snow Leopard', '11': 'Big Sur', '12': 'Monterey', '13': 'Ventura',
  '14': 'Sonoma', '15': 'Sequoia', '16': 'Tahoe',
};

function getDeviceContext() {
  const ctx = {
    platform: process.platform,
    os_release: os.release(),
    arch: process.arch,
    hostname: os.hostname(),
    cpus: os.cpus().length,
    total_memory_mb: Math.round(os.totalmem() / (1024 * 1024)),
    free_memory_mb: Math.round(os.freemem() / (1024 * 1024)),
    node_version: process.version,
  };

  if (process.platform === 'darwin') {
    try {
      const productName = execSync('sw_vers -productName', { encoding: 'utf8', timeout: 2000 }).trim();
      const productVersion = execSync('sw_vers -productVersion', { encoding: 'utf8', timeout: 2000 }).trim();
      const major = productVersion.split('.')[0];
      const versionName = MACOS_VERSION_NAMES[major] || productVersion;
      ctx.os_name = `${productName} ${versionName}`;
      ctx.os_version = productVersion;
      ctx.chip = process.arch === 'arm64' ? 'Apple Silicon' : 'Intel';
    } catch (_) {
      ctx.os_name = 'macOS';
      ctx.chip = process.arch === 'arm64' ? 'Apple Silicon' : 'Intel';
    }
  } else if (process.platform === 'win32') {
    try {
      const cmd = 'powershell -NoProfile -Command "(Get-ItemProperty \'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\').ProductName"';
      const name = execSync(cmd, { encoding: 'utf8', timeout: 3000 }).trim();
      const ver = execSync('powershell -NoProfile -Command "(Get-ItemProperty \'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\').DisplayVersion"', { encoding: 'utf8', timeout: 3000 }).trim().replace(/\s*$/, '');
      ctx.os_name = name + (ver ? ` ${ver}` : '');
      ctx.os_version = os.release();
    } catch (_) {
      const r = os.release();
      ctx.os_name = r.startsWith('10.0') ? 'Windows 10/11' : `Windows ${r}`;
      ctx.os_version = r;
    }
  } else if (process.platform === 'linux') {
    try {
      const buf = fs.readFileSync('/etc/os-release', 'utf8');
      const lines = buf.split('\n').filter(Boolean);
      let pretty = '';
      let name = '';
      let versionId = '';
      for (const line of lines) {
        const pm = line.match(/^PRETTY_NAME="(.+)"$/);
        if (pm) { pretty = pm[1]; break; }
      }
      if (!pretty) {
        for (const line of lines) {
          if (line.startsWith('NAME="')) name = line.replace(/^NAME="|"$/g, '');
          if (line.startsWith('VERSION_ID="')) versionId = line.replace(/^VERSION_ID="|"$/g, '');
        }
      }
      ctx.os_name = pretty || (name + (versionId ? ` ${versionId}` : '')) || 'Linux';
      if (versionId && !pretty) ctx.os_version = versionId;
    } catch (_) {
      ctx.os_name = 'Linux';
      ctx.os_version = os.release();
    }
  }

  ctx.home_dir = os.homedir();
  ctx.cwd = process.cwd();

  return ctx;
}

function getConversationsDir() {
  const dir = path.join(app.getPath('userData'), 'conversations');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getMemoryFile() {
  return path.join(app.getPath('userData'), 'memory.json');
}

function getKnowledgeDir() {
  const dir = path.join(app.getPath('userData'), 'knowledge');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getKnowledgeConfigFile() {
  return path.join(getKnowledgeDir(), 'config.json');
}

function readKnowledgeConfig() {
  const file = getKnowledgeConfigFile();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeKnowledgeConfig(config) {
  const file = getKnowledgeConfigFile();
  try {
    fs.writeFileSync(file, JSON.stringify(config), 'utf8');
  } catch (_) {
    // ignore
  }
}

function getKnowledgeRootDir() {
  const cfg = readKnowledgeConfig();
  const root = typeof cfg.rootDir === 'string' && cfg.rootDir ? cfg.rootDir : os.homedir();
  return root;
}

function setKnowledgeRootDir(rootDir) {
  const cfg = readKnowledgeConfig();
  writeKnowledgeConfig({ ...cfg, rootDir });
}

// ─── Allowed Search Directories ──────────────────────────────────────────────
// Persisted list of directories the agent is allowed to search/access.
// Stored in knowledge/config.json under "allowedDirs".

function getAllowedDirs() {
  const cfg = readKnowledgeConfig();
  return Array.isArray(cfg.allowedDirs) ? cfg.allowedDirs : [];
}

function setAllowedDirs(dirs) {
  const cfg = readKnowledgeConfig();
  writeKnowledgeConfig({ ...cfg, allowedDirs: dirs });
}

function addAllowedDir(dirPath) {
  const resolved = path.resolve(dirPath);
  const dirs = getAllowedDirs();
  if (!dirs.includes(resolved) && fs.existsSync(resolved)) {
    dirs.push(resolved);
    setAllowedDirs(dirs);
  }
  return dirs;
}

function removeAllowedDir(dirPath) {
  const resolved = path.resolve(dirPath);
  const dirs = getAllowedDirs().filter((d) => d !== resolved);
  setAllowedDirs(dirs);
  return dirs;
}

function getSnapshotsDir() {
  const dir = path.join(app.getPath('userData'), 'snapshots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readMemory() {
  const file = getMemoryFile();
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return []; }
}

// ─── Local Knowledge Indexer Process ─────────────────────────────────────────
// Runs entirely on the user's machine as a child process. Never touches the backend.

let indexerProcess = null;
let indexerReady = false;
let pendingRequests = new Map(); // id -> {resolve, reject, timeout}
let requestIdCounter = 0;
let lastKnowledgeStatus = { active: false, phase: 'idle' };

function getIndexerPythonPath() {
  // Use the backend venv's Python since it has all dependencies installed
  const repoRoot = path.join(__dirname, '..', '..');
  const venvPython = path.join(repoRoot, 'backend', 'venv', 'bin', 'python');
  if (fs.existsSync(venvPython)) return venvPython;
  // Fallback: try system python
  return 'python3';
}

function startIndexerProcess() {
  if (indexerProcess) return;

  const dataDir = getKnowledgeDir();
  const repoRoot = path.join(__dirname, '..', '..');
  const pythonPath = getIndexerPythonPath();

  console.log('[knowledge] spawning local indexer process');
  indexerProcess = spawn(pythonPath, ['-m', 'backend.knowledge.cli', dataDir], {
    cwd: repoRoot,
    env: { ...process.env, PYTHONPATH: repoRoot, PYTHONUNBUFFERED: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const rl = readline.createInterface({ input: indexerProcess.stdout });
  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);

      // Progress updates are pushed without a request ID
      if (msg.type === 'progress') {
        lastKnowledgeStatus = { ...msg, active: msg.phase !== 'idle' && msg.phase !== 'watching' };
        // Forward to renderer
        const win = BrowserWindow.getAllWindows()[0];
        if (win && !win.isDestroyed()) {
          win.webContents.send('knowledge-progress', lastKnowledgeStatus);
        }
        return;
      }

      if (msg.type === 'ready') {
        indexerReady = true;
        console.log('[knowledge] indexer process ready');
        return;
      }

      // Response to a command — resolve the oldest pending request for this cmd
      for (const [id, entry] of pendingRequests) {
        if (entry.cmd === msg.cmd || !msg.cmd) {
          clearTimeout(entry.timeout);
          pendingRequests.delete(id);
          entry.resolve(msg);
          return;
        }
      }
    } catch (_) {
      // Non-JSON output, ignore
    }
  });

  indexerProcess.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (text) console.error('[knowledge:stderr]', text);
  });

  indexerProcess.on('close', (code) => {
    console.log('[knowledge] indexer process exited with code', code);
    indexerProcess = null;
    indexerReady = false;
    // Reject all pending requests
    for (const [id, entry] of pendingRequests) {
      clearTimeout(entry.timeout);
      entry.reject(new Error('Indexer process exited'));
    }
    pendingRequests.clear();
  });

  indexerProcess.on('error', (err) => {
    console.error('[knowledge] failed to spawn indexer:', err.message);
    indexerProcess = null;
    indexerReady = false;
  });
}

function sendToIndexer(command, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!indexerProcess || !indexerReady) {
      return reject(new Error('Indexer not ready'));
    }
    const id = ++requestIdCounter;
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('Indexer request timed out'));
    }, timeoutMs);
    pendingRequests.set(id, { resolve, reject, timeout, cmd: command.cmd });
    indexerProcess.stdin.write(JSON.stringify(command) + '\n');
  });
}

function stopIndexerProcess() {
  if (!indexerProcess) return;
  try {
    indexerProcess.stdin.write(JSON.stringify({ cmd: 'shutdown' }) + '\n');
    // Give it 8 seconds to save FAISS + checkpoint SQLite before force-killing
    setTimeout(() => {
      if (indexerProcess) {
        indexerProcess.kill();
        indexerProcess = null;
      }
    }, 8000);
  } catch (_) {
    if (indexerProcess) indexerProcess.kill();
    indexerProcess = null;
  }
}

function clearKnowledgeData() {
  const dir = getKnowledgeDir();
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    // Preserve config so the chosen root directory persists across clears
    if (entry === 'config.json') continue;
    const p = path.join(dir, entry);
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch (_e) {
      // ignore individual delete errors
    }
  }
}

async function startKnowledgeIndexing(rootDirOverride) {
  startIndexerProcess();

  // Wait for indexer to be ready
  let attempts = 0;
  while (!indexerReady && attempts < 60) {
    await new Promise((r) => setTimeout(r, 500));
    attempts++;
  }
  if (!indexerReady) {
    console.error('[knowledge] indexer did not become ready in time');
    return;
  }

  const rootDir = rootDirOverride || getKnowledgeRootDir();
  console.log('[knowledge] starting indexing for', rootDir);

  try {
    await sendToIndexer({ cmd: 'scan_async', directory: rootDir });
  } catch (e) {
    console.error('[knowledge] failed to start scan:', e.message);
  }

  try {
    await sendToIndexer({ cmd: 'watch', directories: [rootDir] });
  } catch (e) {
    console.error('[knowledge] failed to start watcher:', e.message);
  }
}

// ─── App Ready ───────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  ipcMain.handle('get-device-context', getDeviceContext);

  ipcMain.handle('list-conversations', () => {
    const dir = getConversationsDir();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const convs = [];
    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        convs.push({ id: d.id, title: d.title, createdAt: d.createdAt, updatedAt: d.updatedAt });
      } catch (_) {}
    }
    return convs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  });

  ipcMain.handle('get-conversation', (_, id) => {
    const dir = getConversationsDir();
    const file = path.join(dir, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  });

  ipcMain.handle('save-conversation', (_, conv) => {
    const dir = getConversationsDir();
    fs.writeFileSync(path.join(dir, `${conv.id}.json`), JSON.stringify(conv), 'utf8');
    return true;
  });

  ipcMain.handle('delete-conversation', (_, id) => {
    const dir = getConversationsDir();
    const file = path.join(dir, `${id}.json`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  });

  ipcMain.handle('get-memory', () => readMemory());

  ipcMain.handle('save-memory', (_, chunks) => {
    fs.writeFileSync(getMemoryFile(), JSON.stringify(chunks), 'utf8');
    return true;
  });

  ipcMain.handle('add-memory-chunks', (_, newChunks) => {
    if (!Array.isArray(newChunks) || newChunks.length === 0) return true;
    const existing = readMemory();
    const normalize = (s) => String(s?.content ?? s).trim().replace(/\s+/g, ' ').toLowerCase();
    const seen = new Set(existing.map((c) => normalize(c)));
    const toAdd = newChunks.filter((c) => {
      const key = normalize(c);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (toAdd.length === 0) return true;
    fs.writeFileSync(getMemoryFile(), JSON.stringify([...existing, ...toAdd]), 'utf8');
    return true;
  });

  ipcMain.handle('delete-memory-chunk', (_, id) => {
    const updated = readMemory().filter((c) => c.id !== id);
    fs.writeFileSync(getMemoryFile(), JSON.stringify(updated), 'utf8');
    return true;
  });

  ipcMain.handle('save-snapshots', (_, messageId, newSnapshots) => {
    const dir = getSnapshotsDir();
    const file = path.join(dir, `${messageId}.json`);
    let existing = [];
    if (fs.existsSync(file)) {
      try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_e) {}
    }
    fs.writeFileSync(file, JSON.stringify([...existing, ...newSnapshots]), 'utf8');
    return true;
  });

  ipcMain.handle('get-snapshots', (_, messageId) => {
    const file = path.join(getSnapshotsDir(), `${messageId}.json`);
    if (!fs.existsSync(file)) return [];
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_e) { return []; }
  });

  ipcMain.handle('delete-snapshots', (_, messageId) => {
    const file = path.join(getSnapshotsDir(), `${messageId}.json`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  });

  ipcMain.handle('restore-file-snapshot', (_, filePath, originalContent, existed) => {
    try {
      if (!existed) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } else {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, originalContent, 'utf8');
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // -- Knowledge Index IPC Handlers (local subprocess, no backend) --

  ipcMain.handle('knowledge-get-data-dir', () => getKnowledgeDir());

  ipcMain.handle('knowledge-scan', async (_, directory) => {
    try {
      return await sendToIndexer({ cmd: 'scan', directory }, 300000);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('knowledge-search', async (_, query, options) => {
    try {
      return await sendToIndexer({
        cmd: 'search',
        query,
        mode: options?.mode || 'hybrid',
        extension: options?.extension || null,
        directory: options?.directory || null,
        top_k: options?.top_k || 10,
      }, 15000);
    } catch (e) {
      return { ok: false, error: e.message, results: [] };
    }
  });

  ipcMain.handle('knowledge-status', async () => {
    // Return cached status from progress events (no round-trip needed)
    return { ok: true, ...lastKnowledgeStatus };
  });

  ipcMain.handle('knowledge-stats', async () => {
    try {
      return await sendToIndexer({ cmd: 'stats' }, 5000);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('knowledge-clear-all', async () => {
    try {
      stopIndexerProcess();
      clearKnowledgeData();
      await startKnowledgeIndexing().catch((e) => {
        console.error('[knowledge] restart after clear failed:', e.message);
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('knowledge-pick-root', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
      const result = await dialog.showOpenDialog(win, {
        title: 'Choose folder to index for Knowledge',
        properties: ['openDirectory'],
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { ok: false, canceled: true };
      }
      const rootDir = result.filePaths[0];
      setKnowledgeRootDir(rootDir);
      stopIndexerProcess();
      clearKnowledgeData();
      await startKnowledgeIndexing(rootDir).catch((e) => {
        console.error('[knowledge] restart after root change failed:', e.message);
      });
      return { ok: true, rootDir };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ─── Allowed Search Directories IPC ──────────────────────────────────────

  ipcMain.handle('knowledge-get-allowed-dirs', () => {
    return { ok: true, dirs: getAllowedDirs() };
  });

  ipcMain.handle('knowledge-add-allowed-dir', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
      const result = await dialog.showOpenDialog(win, {
        title: 'Add directory to agent search scope',
        properties: ['openDirectory', 'multiSelections'],
      });
      if (result.canceled || !result.filePaths?.length) {
        return { ok: false, canceled: true };
      }
      let dirs = getAllowedDirs();
      for (const p of result.filePaths) {
        dirs = addAllowedDir(p);
      }
      return { ok: true, dirs };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('knowledge-remove-allowed-dir', (_, dirPath) => {
    const dirs = removeAllowedDir(dirPath);
    return { ok: true, dirs };
  });

  ipcMain.handle('run-interactive-command', async (event, command, cmdId) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    return await new Promise((resolve) => {
      try {
        const child = spawn(command, { shell: true });
        let stdout = '';
        let stderr = '';

        const sendStream = (stream, data) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send('command-stream', { stream, data: data.toString(), cmdId });
          }
        };

        child.stdout.on('data', (data) => {
          stdout += data.toString();
          sendStream('stdout', data);
        });
        child.stderr.on('data', (data) => {
          stderr += data.toString();
          sendStream('stderr', data);
        });

        const finalize = (code, err) => {
          if (err) {
            resolve({ stdout, stderr: String(err), returncode: -1 });
          } else {
            resolve({ stdout, stderr, returncode: typeof code === 'number' ? code : 0 });
          }
        };

        child.on('error', (err) => finalize(undefined, err));
        child.on('close', (code) => finalize(code, null));
      } catch (err) {
        resolve({ stdout: '', stderr: String(err), returncode: -1 });
      }
    });
  });

  createWindow();

  // Start local knowledge indexer after a short delay
  setTimeout(() => {
    startKnowledgeIndexing().catch((e) => {
      console.error('[knowledge] startup indexing failed:', e.message);
    });
  }, 3000);
});

app.on('before-quit', () => {
  stopIndexerProcess();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
