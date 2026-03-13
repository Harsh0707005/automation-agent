const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');
const fs = require('fs');

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

  return ctx;
}

app.whenReady().then(() => {
  ipcMain.handle('get-device-context', getDeviceContext);

  ipcMain.handle('run-interactive-command', async (event, command) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    return await new Promise((resolve) => {
      try {
        const child = spawn(command, { shell: true });
        let stdout = '';
        let stderr = '';

        const sendStream = (stream, data) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send('command-stream', { stream, data: data.toString() });
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
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
