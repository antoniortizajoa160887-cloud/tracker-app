const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

// Uses the GitHub Contents API (not raw.githubusercontent.com) because that
// raw host sits behind a CDN that can serve a stale cached copy for a while
// after a push. The API's cache is much shorter-lived (~60s).
const REMOTE_HTML_URL =
  'https://api.github.com/repos/antoniortizajoa160887-cloud/tracker-app/contents/index.html?ref=main';
const FETCH_TIMEOUT_MS = 8000;

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
    return cachedPath;
  } catch (err) {
    console.error('Could not fetch latest index.html, falling back:', err.message);
    if (fs.existsSync(cachedPath)) {
      return cachedPath;
    }
    return path.join(__dirname, 'index.html');
  }
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
      sandbox: true,
    },
  });

  win.loadFile(htmlPath);
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
