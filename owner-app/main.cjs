const { app, BrowserWindow, ipcMain, net } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
let window;
const requestedProfile = app.commandLine.getSwitchValue('user-data-dir');
if (requestedProfile) app.setPath('userData', path.resolve(requestedProfile));
const home = pathToFileURL(path.join(__dirname, 'index.html')).href;
ipcMain.handle('owner:request', async (event, input) => {
  if (event.sender !== window?.webContents || event.senderFrame.url !== home) throw new Error('Not allowed.');
  const url = new URL(input.server);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Use HTTPS, or localhost for testing.');
  }
  if (!/^\/api\/license\/owner\/(setup|register|login|password|invoice-settings|staff(?:\/[0-9a-f-]{36})?|operators(?:\/[0-9a-f-]{36}(?:\/password)?)?|accounts(?:\/(?:invoice|send|profile|plan|prepayments|invoices|payments|extension|correction))?|dashboard|settings|issue|decline|client-access|companies|content|buildings|checklists|subscription|subscription-decline|features|features-review)(\?(?:companyCode=[A-Z0-9-]+(?:&id=[0-9a-f-]{36}(?:&format=pdf)?)?|scope=platform))?$/.test(input.path)
      || !['GET', 'POST', 'PUT'].includes(input.method) || JSON.stringify(input.body || {}).length > 512000) throw new Error('Invalid owner request.');
  try {
    const response = await net.fetch(`${url.origin}${input.path}`, {
      method: input.method,
      headers: { 'Content-Type': 'application/json', ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}) },
      body: input.method === 'GET' ? undefined : JSON.stringify(input.body || {}),
      signal: AbortSignal.timeout(/^\/api\/license\/owner\/accounts\/(?:invoices|send)$/.test(input.path) ? 45000 : 20000), redirect: 'error'
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error('Server did not return JSON. Check its address and availability.'); }
    return { status: response.status, data };
  } catch (error) {
    console.error('Owner server request failed:', error.message);
    throw new Error(`Could not connect: ${error.message}`);
  }
});
app.whenReady().then(() => {
  window = new BrowserWindow({ width: 1000, height: 800, minWidth: 700, title: 'PrimeOps Owner', icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== home) event.preventDefault(); });
  window.loadFile(path.join(__dirname, 'index.html'));
});
app.on('window-all-closed', () => app.quit());
