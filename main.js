const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { execFileSync } = require('child_process');

const DEFAULT_APP_NAME = 'Unified Logistics HR Claims Dashboard';

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
  win.webContents
    .executeJavaScript(
      `(function(){
        var b = document.createElement('div');
        b.textContent = ${JSON.stringify(message)};
        b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#b45309;color:#fff;font:12px/1.4 sans-serif;padding:6px 12px;text-align:center;';
        document.body.appendChild(b);
      })();`
    )
    .catch(() => {});
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
// supported."). This shows a genuine native Windows input box instead,
// blocking synchronously just like a real prompt() would.
function showNativePrompt(message, defaultValue) {
  const title = deriveDialogTitle(message);
  const escape = (s) => String(s == null ? '' : s).replace(/'/g, "''");
  const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Console]::Out.Write([Microsoft.VisualBasic.Interaction]::InputBox('${escape(
    message
  )}', '${escape(title)}', '${escape(defaultValue)}'))`;
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8' }
    );
  } catch (err) {
    return '';
  }
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

async function createWindow() {
  const htmlPath = await resolveAppHtmlPath();
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // sandbox:true blocked window.confirm() dialogs entirely (used by the
      // "Delete All ..." admin actions). window.prompt() is a separate story
      // — see showNativePrompt below, Electron never implements it at all.
      // nodeIntegration:false + contextIsolation:true already keep the page
      // from touching Node/Electron internals, sandbox:false doesn't change that.
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
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
  event.returnValue = showNativePrompt(message, defaultValue);
});

app.whenReady().then(() => {
  app.setName(DEFAULT_APP_NAME);
  Menu.setApplicationMenu(null);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
