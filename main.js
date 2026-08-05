const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

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
      // sandbox:true blocks window.prompt() (used by several admin actions,
      // e.g. the "Delete All ..." confirmations) — it rejects instead of
      // showing a dialog. nodeIntegration:false + contextIsolation:true
      // already keep the page from touching Node/Electron internals.
      sandbox: false,
    },
  });

  win.webContents.on('did-finish-load', () => injectStatusBanner(win));
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'r') {
      forceRefresh(win);
    }
  });

  win.loadFile(htmlPath);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
