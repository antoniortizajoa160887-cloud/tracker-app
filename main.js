const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { autoUpdater } = require('electron-updater');

const DEFAULT_APP_NAME = 'Unified Logistics HR Claims Dashboard';
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

// Uses the GitHub Contents API (not raw.githubusercontent.com) because that
// raw host sits behind a CDN that can serve a stale cached copy for a while
// after a push. The API's cache is much shorter-lived (~60s).
const REMOTE_HTML_URL =
  'https://api.github.com/repos/antoniortizajoa160887-cloud/tracker-app/contents/index.html?ref=main';
const FETCH_TIMEOUT_MS = 8000;

let lastFetchInfo = { source: 'unknown', timestamp: null, error: null };

function fetchRemoteHtml(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const options = {
      timeout: FETCH_TIMEOUT_MS,
      headers: {
        Accept: 'application/vnd.github.raw',
        'User-Agent': 'unified-logistics-hr-dashboard-desktop',
      },
    };
    const req = https.get(url, options, (res) => {
      if (
        [301, 302, 307, 308].includes(res.statusCode) &&
        res.headers.location &&
        redirectsLeft > 0
      ) {
        res.resume();
        resolve(fetchRemoteHtml(res.headers.location, redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Unexpected status ${res.statusCode}`));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
  });
}

// Pulls the latest index.html from the repo on every launch, caching the last
// successful fetch so the app still opens offline. Falls back to the copy
// bundled at build time if nothing has ever been fetched successfully.
async function resolveAppHtmlPath() {
  const cachedPath = path.join(app.getPath('userData'), 'index.html');
  try {
    const html = await fetchRemoteHtml(REMOTE_HTML_URL);
    if (!html || html.length < 1000) {
      throw new Error('Fetched content looks too small, ignoring');
    }
    fs.writeFileSync(cachedPath, html, 'utf8');
    lastFetchInfo = { source: 'live', timestamp: new Date().toISOString(), error: null };
    return cachedPath;
  } catch (err) {
    if (fs.existsSync(cachedPath)) {
      lastFetchInfo = { source: 'cached', timestamp: new Date().toISOString(), error: err.message };
      return cachedPath;
    }
    lastFetchInfo = { source: 'bundled', timestamp: new Date().toISOString(), error: err.message };
    return path.join(__dirname, 'index.html');
  }
}

function injectStatusBanner(win) {
  const { source, error } = lastFetchInfo;
  if (source === 'live') return;
  const label =
    source === 'cached'
      ? 'Showing last downloaded version — could not reach GitHub just now'
      : 'Showing the version bundled with the installer — could not reach GitHub';
  const detail = error ? ` (${error})` : '';
  const message = `${label}${detail} — press Ctrl+Shift+R to retry`;
  showBanner(win, message, '#b45309');
}

// Electron's native confirm()/prompt() dialogs title themselves after
// app.getName() (from package.json's "name" field) — the page has no way to
// influence that itself. We override confirm/prompt in the page to derive a
// title from the dialog's message text, set it via IPC just before showing
// the dialog, then restore the default name once it closes.
function deriveDialogTitle(message) {
  const m = String(message || '');
  const patterns = [
    [/delete all routes/i, 'Delete All Routes'],
    [/delete all claims/i, 'Delete All Claims'],
    [/delete all charges/i, 'Delete All Charges'],
    [/delete all users/i, 'Delete All Users'],
    [/reset all data/i, 'Reset All Data'],
    [/reset system/i, 'System Reset'],
    [/new password/i, 'Reset Password'],
  ];
  for (const [re, title] of patterns) {
    if (re.test(m)) return title;
  }
  const firstLine = m.split('\n')[0].replace(/[:?]\s*$/, '').trim();
  if (firstLine && firstLine.length <= 60) return firstLine;
  return DEFAULT_APP_NAME;
}

// Electron never implemented window.prompt() (alert/confirm map to real
// native dialogs; prompt() just rejects with "prompt() is and will not be
// supported."). This shows a small modal window with our own input field
// instead. An earlier version of this shelled out to powershell.exe to run
// a native VB InputBox — that got silently blocked by Windows' "Check apps
// and files" (SmartScreen) reputation check on the child process, which is
// exactly the "inputs don't work unless I turn security off" report this
// replaces. A window created by the already-running app isn't a new
// executable launch, so it isn't subject to that check at all.
function buildPromptHtml(message, defaultValue) {
  const escapeHtml = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin:0; font-family: -apple-system, "Segoe UI", sans-serif; background:#1e293b; color:#e2e8f0; padding:18px 20px; box-sizing:border-box; -webkit-user-select:none; }
  p { margin:0 0 10px; font-size:13px; white-space:pre-wrap; }
  input { width:100%; box-sizing:border-box; padding:8px 10px; font-size:13px; border-radius:6px; border:1px solid #475569; background:#0f172a; color:#e2e8f0; outline:none; }
  input:focus { border-color:#10b981; }
  .buttons { margin-top:16px; display:flex; justify-content:flex-end; gap:8px; }
  button { padding:7px 16px; border-radius:6px; border:none; font-size:13px; cursor:pointer; }
  #ok { background:#10b981; color:#04120c; font-weight:600; }
  #cancel { background:#334155; color:#e2e8f0; }
</style></head>
<body>
  <p>${escapeHtml(message)}</p>
  <input id="val" />
  <div class="buttons">
    <button id="cancel">Cancel</button>
    <button id="ok">OK</button>
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    const input = document.getElementById('val');
    input.value = ${JSON.stringify(String(defaultValue == null ? '' : defaultValue))};
    input.focus();
    input.select();
    function respond(value) { ipcRenderer.send('native-prompt-response', value); }
    document.getElementById('ok').addEventListener('click', () => respond(input.value));
    document.getElementById('cancel').addEventListener('click', () => respond(null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') respond(input.value);
      if (e.key === 'Escape') respond(null);
    });
  </script>
</body></html>`;
}

function showNativePromptAsync(message, defaultValue) {
  return new Promise((resolve) => {
    const title = deriveDialogTitle(message);
    const promptWin = new BrowserWindow({
      width: 440,
      height: 190,
      parent: mainWindow || undefined,
      modal: !!mainWindow,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      title,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('native-prompt-response', onResponse);
      resolve(value);
      if (!promptWin.isDestroyed()) promptWin.close();
    };
    const onResponse = (event, value) => finish(value);
    ipcMain.on('native-prompt-response', onResponse);
    promptWin.on('closed', () => finish(null));

    promptWin.once('ready-to-show', () => promptWin.show());
    promptWin.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(buildPromptHtml(message, defaultValue))
    );
  });
}

function injectDialogTitleOverride(win) {
  win.webContents
    .executeJavaScript(
      `(function(){
        if (window.__dialogTitleOverrideInstalled) return;
        window.__dialogTitleOverrideInstalled = true;
        var titleBridge = window.__dialogTitleBridge;
        var promptBridge = window.__nativePromptBridge;
        var origConfirm = window.confirm;
        window.confirm = function(message) {
          if (titleBridge) titleBridge.setTitle(message);
          try { return origConfirm.call(window, message); }
          finally { if (titleBridge) titleBridge.setTitle(null); }
        };
        window.prompt = function(message, defaultValue) {
          if (!promptBridge) return null;
          return promptBridge.prompt(message, defaultValue);
        };
      })();`
    )
    .catch(() => {});
}

async function forceRefresh(win) {
  const cachedPath = path.join(app.getPath('userData'), 'index.html');
  try {
    fs.unlinkSync(cachedPath);
  } catch (err) {
    // no cached copy to remove, that's fine
  }
  const htmlPath = await resolveAppHtmlPath();
  await win.loadFile(htmlPath);
}

let mainWindow = null;

async function createWindow() {
  const htmlPath = await resolveAppHtmlPath();
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // sandbox:true blocked window.confirm() dialogs entirely (used by the
      // "Delete All ..." admin actions). window.prompt() is a separate story
      // — see showNativePromptAsync below, Electron never implements it at all.
      // nodeIntegration:false + contextIsolation:true already keep the page
      // from touching Node/Electron internals, sandbox:false doesn't change that.
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.on('did-finish-load', () => {
    injectStatusBanner(win);
    injectDialogTitleOverride(win);
  });
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'r') {
      forceRefresh(win);
    }
  });

  win.loadFile(htmlPath);
}

ipcMain.on('set-dialog-title', (event, message) => {
  app.setName(message ? deriveDialogTitle(message) : DEFAULT_APP_NAME);
  event.returnValue = true;
});

ipcMain.on('native-prompt', (event, message, defaultValue) => {
  // Deliberately not setting event.returnValue synchronously here — Electron
  // keeps the renderer's sendSync call blocked until it's assigned, however
  // long that takes, so it's safe to resolve this later once the user
  // actually answers the modal (verified empirically, not just assumed).
  showNativePromptAsync(message, defaultValue).then((value) => {
    event.returnValue = value;
  });
});

function showBanner(win, message, background) {
  win.webContents
    .executeJavaScript(
      `(function(){
        var b = document.createElement('div');
        b.textContent = ${JSON.stringify(message)};
        b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:${background};color:#fff;font:12px/1.4 sans-serif;padding:6px 12px;text-align:center;';
        document.body.appendChild(b);
      })();`
    )
    .catch(() => {});
}

// Updates the app itself (this main.js/preload.js/package.json bundle), not
// index.html — that's handled separately above. Every release that should
// reach installed users this way needs its package.json "version" bumped;
// electron-updater compares versions, not file contents.
function setupAutoUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', () => {
    if (mainWindow) {
      showBanner(
        mainWindow,
        'An app update was downloaded — restarting in 10 seconds to finish installing...',
        '#15803d'
      );
    }
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 10000);
  });

  autoUpdater.on('error', (err) => {
    console.error('autoUpdater error:', err == null ? err : err.message);
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.error('Initial update check failed:', err.message);
  });
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('Periodic update check failed:', err.message);
    });
  }, UPDATE_CHECK_INTERVAL_MS);
}

app.whenReady().then(() => {
  app.setName(DEFAULT_APP_NAME);
  Menu.setApplicationMenu(null);
  createWindow();
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
