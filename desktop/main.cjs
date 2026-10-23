const { app, BrowserWindow, Menu, ipcMain, net, protocol, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const defaultServerUrl = 'https://curly-palm-tree-xrv479j4xw93vp67-3001.app.github.dev';
const wwwRoot = path.join(__dirname, 'www');
const configPath = () => path.join(app.getPath('userData'), 'desktop-config.json');
let mainWindow = null;
let settingsWindow = null;

protocol.registerSchemesAsPrivileged([
  { scheme: 'feenstra', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

function normalizeServerUrl(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an http:// or https:// address.');
  return url.origin;
}

function readServerUrl() {
  try {
    return normalizeServerUrl(JSON.parse(fs.readFileSync(configPath(), 'utf8')).serverUrl);
  } catch {
    return defaultServerUrl;
  }
}

function serveApp(request) {
  const { pathname } = new URL(request.url);
  const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const file = path.normalize(path.join(wwwRoot, relative));
  if (file !== wwwRoot && !file.startsWith(wwwRoot + path.sep)) {
    return new Response('Not found', { status: 404 });
  }
  const serverUrl = readServerUrl();
  if (relative === '/config.js') {
    const body = `window.APP_CONFIG = { apiBaseUrl: ${JSON.stringify(serverUrl)}, clientId: "", integrations: { myBuildings: { enabled: false } } };`;
    return new Response(body, { headers: { 'Content-Type': 'text/javascript' } });
  }
  if (relative === '/index.html') {
    const html = fs.readFileSync(file, 'utf8').replace("connect-src 'self'", `connect-src 'self' ${serverUrl}`);
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  return net.fetch(pathToFileURL(file).toString());
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Feenstra Building and OHS',
    webPreferences: {
      preload: path.join(__dirname, 'preload-app.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadURL('feenstra://app/index.html');
  mainWindow.on('closed', () => { mainWindow = null; });
}

function openSettings() {
  if (settingsWindow) return settingsWindow.focus();
  settingsWindow = new BrowserWindow({
    width: 480,
    height: 220,
    parent: mainWindow || undefined,
    modal: Boolean(mainWindow),
    resizable: false,
    minimizable: false,
    title: 'Server address',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

const reportsRoot = () => path.join(app.getPath('documents'), 'Feenstra Reports');

// Makes a value safe as a single Windows folder or file name.
function safeSegment(value, fallback) {
  let name = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim();
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) name = `_${name}`;
  return name || fallback;
}

function uniquePath(dir, base) {
  let candidate = path.join(dir, `${base}.pdf`);
  for (let n = 2; fs.existsSync(candidate); n += 1) candidate = path.join(dir, `${base} (${n}).pdf`);
  return candidate;
}

async function renderPdf(html) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feenstra-report-'));
  const tempFile = path.join(tempDir, 'report.html');
  fs.writeFileSync(tempFile, html);
  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  try {
    await printWindow.loadFile(tempFile);
    return await printWindow.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
  } finally {
    printWindow.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

ipcMain.handle('reports:save', async (event, report) => {
  if (event.sender !== mainWindow?.webContents) return { error: 'Not allowed.' };
  try {
    if (typeof report?.html !== 'string' || !report.html) throw new Error('The report is empty.');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(report.date) ? report.date : new Date().toISOString().slice(0, 10);
    const kind = safeSegment(report.kind, 'Report');
    const revision = Number(report.revision) > 1 ? ` (revision ${Math.floor(Number(report.revision))})` : '';
    const dir = path.join(reportsRoot(), safeSegment(report.building, 'Unassigned building'), kind);
    fs.mkdirSync(dir, { recursive: true });
    const file = uniquePath(dir, `${date} - ${kind}${revision}`);
    fs.writeFileSync(file, await renderPdf(report.html));
    return { ok: true, path: file };
  } catch (error) {
    return { error: `Could not save the report: ${error.message}` };
  }
});

ipcMain.handle('settings:get', (event) => {
  if (event.sender !== settingsWindow?.webContents) return null;
  return { serverUrl: readServerUrl() };
});

ipcMain.handle('settings:save', (event, value) => {
  if (event.sender !== settingsWindow?.webContents) return { error: 'Not allowed.' };
  try {
    fs.writeFileSync(configPath(), JSON.stringify({ serverUrl: normalizeServerUrl(value) }));
  } catch (error) {
    return { error: error instanceof TypeError ? 'Enter a valid address such as http://192.168.1.20:3001' : error.message };
  }
  settingsWindow.close();
  mainWindow?.reload();
  return { ok: true };
});

app.whenReady().then(() => {
  protocol.handle('feenstra', serveApp);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Open reports folder', click: () => { fs.mkdirSync(reportsRoot(), { recursive: true }); shell.openPath(reportsRoot()); } },
      { label: 'Server address…', click: openSettings },
      { type: 'separator' },
      { role: 'quit' }
    ] },
    { role: 'viewMenu' }
  ]));
  createMainWindow();
});

app.on('window-all-closed', () => app.quit());
