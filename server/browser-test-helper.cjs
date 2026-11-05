const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

async function browserSession(t, executable, args, { electron = false } = {}) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-company-browser-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let display;
  if (electron) {
    display = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1280x900x24'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const [value] = await once(display.stdout, 'data');
    env.DISPLAY = `:${String(value).trim()}`;
  }
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const debugPort = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(executable, [
    ...args, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, ...(electron ? [] : ['about:blank'])
  ], { stdio: ['ignore', 'ignore', 'pipe'], env });
  let log = '', ws;
  child.stderr.on('data', (data) => { log += data; });
  t.after(async () => {
    ws?.close();
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    if (display?.exitCode === null) { display.kill(); await once(display, 'exit'); }
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  for (let attempt = 0; !log.includes('DevTools listening on'); attempt++) {
    if (attempt > 200 || child.exitCode !== null) throw new Error(`Browser start failed: ${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const port = log.match(/ws:\/\/127\.0\.0\.1:(\d+)/)[1];
  let page;
  for (let attempt = 0; !page; attempt++) {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    page = pages.find((item) => item.type === 'page');
    if (attempt > 100) throw new Error('No browser page available.');
    if (!page) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await once(ws, 'open');
  let nextId = 0;
  const pending = new Map(), errors = [];
  ws.addEventListener('message', ({ data }) => {
    const result = JSON.parse(data);
    if (result.id) {
      const callback = pending.get(result.id);
      if (!callback) return;
      pending.delete(result.id);
      if (result.error) callback.reject(new Error(JSON.stringify(result.error)));
      else callback.resolve(result.result);
    }
    if (result.method === 'Runtime.exceptionThrown') errors.push(result.params.exceptionDetails);
  });
  function cdp(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function waitFor(expression) {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await evaluate(`document.readyState !== 'loading' && !!document.body && (${expression})`)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Condition failed: ${expression}; ${await evaluate('document.body.innerText.slice(0,2000)')}; errors: ${JSON.stringify(errors)}`);
  }
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  return { cdp, evaluate, waitFor, errors };
}
module.exports = { browserSession };
