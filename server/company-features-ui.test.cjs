const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const { browserSession } = require('./browser-test-helper.cjs');
const catalog = require('../www/feature-catalog.json');

test('company feature picker lists every feature and scrolls on desktop and mobile', {
  skip: !process.env.CHROMIUM, timeout: 60000
}, async (t) => {
  const styles = await fs.readFile(path.join(__dirname, '../www/styles.css'));
  const moduleSource = await fs.readFile(path.join(__dirname, '../www/company-features.mjs'));
  const server = http.createServer((req, res) => {
    if (req.url === '/styles.css') {
      res.setHeader('Content-Type', 'text/css'); res.end(styles); return;
    }
    if (req.url === '/company-features.mjs') {
      res.setHeader('Content-Type', 'text/javascript'); res.end(moduleSource); return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
      <link rel="stylesheet" href="/styles.css"></head><body>
      <button data-company-features>Features</button><script type="module">
      import { wireCompanyFeatures } from '/company-features.mjs';
      const catalog = ${JSON.stringify(catalog)};
      window.submitted = [];
      window.removed = [];
      window.enabled = ['lighting'];
      window.pending = null;
      window.simulated = [];
      window.refreshes = 0;
      wireCompanyFeatures({
        apiRequest: async (url, options) => {
          if (url === '/api/company-settings') return { revision: 1, residentMode: 'students', securityPhone: '' };
          if (url === '/api/company-features/simulate-payment') {
            window.simulated.push(options.body);
            window.pending = { ...window.pending, simulatedPaymentStatus: 'paid', simulatedPaidCents: 10000 };
            return {};
          }
          if (url === '/api/company-features/remove') {
            window.removed.push(options.body.features);
            window.enabled = window.enabled.filter(id => !options.body.features.includes(id));
            return {};
          }
          if (options?.method === 'POST') { window.submitted.push(options.body.features); return {}; }
          return { catalog, enabled: window.enabled, setupComplete: true, extraFeatureFeeCents: 10000, requests: window.pending ? [window.pending] : [] };
        },
        getUser: () => ({ role: 'admin' }), getContext: () => 'test-client',
        refreshUser: async () => { window.refreshes++; },
        escape: (value) => String(value).replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))
      });
      window.ready = true;
      </script></body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const { cdp, evaluate, waitFor, errors } = await browserSession(t, process.env.CHROMIUM, ['--headless']);
  await cdp('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await waitFor('window.ready');
  for (const [width, height] of [[1280, 720], [390, 600], [640, 360]]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await evaluate('document.querySelector("[data-company-features]").click()');
    await waitFor('!!document.querySelector("[data-feature-form]")');
    assert.deepEqual(await evaluate('[...document.querySelectorAll("[name=features]")].map(input=>input.value)'), catalog.map((item) => item.id));
    const bounds = await evaluate(`(() => {
      const dialog = document.querySelector('#company-features-dialog'), body = dialog.querySelector('.company-features-body');
      const rect = dialog.getBoundingClientRect(), scroll = body.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, width: rect.width,
        overflowing: body.scrollHeight > body.clientHeight, horizontalOverflow: body.scrollWidth > body.clientWidth,
        x: scroll.x + scroll.width/2, y: scroll.y + scroll.height/2 };
    })()`);
    assert(bounds.top >= 0 && bounds.bottom <= height, `Dialog must fit ${width}x${height}`);
    assert(bounds.width <= width);
    assert.equal(bounds.overflowing, true);
    assert.equal(bounds.horizontalOverflow, false);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: bounds.x, y: bounds.y, deltaX: 0, deltaY: 2000 });
    await waitFor('document.querySelector(".company-features-body").scrollTop > 0');
    await evaluate('document.querySelector(".company-features-body").focus()');
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
    await waitFor(`(() => {
      const last = document.querySelector('[name=features][value=contractors]').getBoundingClientRect();
      const body = document.querySelector('.company-features-body').getBoundingClientRect();
      return last.top >= body.top && last.bottom <= body.bottom;
    })()`);
    assert.equal(await evaluate('document.querySelector("[name=features][value=lighting]").disabled'), false);
    await evaluate(`document.querySelector('[name=features][value=contractors]').click()`);
    assert.match(await evaluate('document.querySelector("[data-feature-total]").textContent'), /1 selected.*R100/);
    await evaluate('document.querySelector("[data-feature-form]").requestSubmit()');
    await waitFor(`window.submitted.length === ${[720, 600, 360].indexOf(height) + 1}`);
    assert.deepEqual(await evaluate('window.submitted.at(-1)'), ['contractors']);
    await evaluate('document.querySelector("[data-close-features]").click()');
    assert.equal(await evaluate('document.querySelector("#company-features-dialog").open'), false);
  }
  await evaluate('document.querySelector("[data-company-features]").click()');
  await waitFor('!!document.querySelector("[data-feature-form]")');
  await evaluate('document.querySelector("[name=features][value=lighting]").click()');
  assert.match(await evaluate('document.querySelector("[data-feature-total]").textContent'), /0 selected.*1 to remove.*R0/);
  const refreshes = await evaluate('window.refreshes');
  await evaluate('document.querySelector("[data-feature-form]").requestSubmit()');
  await waitFor('document.querySelector("[data-feature-status]").textContent.includes("Feature selections saved")');
  assert.deepEqual(await evaluate('window.removed'), [['lighting']]);
  assert.deepEqual(await evaluate('window.enabled'), []);
  assert.equal(await evaluate('window.refreshes'), refreshes + 1);
  assert.equal(await evaluate('document.querySelector("[name=features][value=lighting]").checked'), false);
  await evaluate('document.querySelector("[data-close-features]").click()');
  await evaluate(`window.pending = { id: '00000000-0000-4000-8000-000000000001', status: 'pending', feeCents: 10000, simulatedPaymentStatus: 'unpaid', simulatedPaidCents: 0 };
    document.querySelector("[data-company-features]").click()`);
  await waitFor('!!document.querySelector("[data-simulate-feature-payment=\\"success\\"]")');
  await evaluate('document.querySelector("[data-simulate-feature-payment=\\"success\\"]").click()');
  await waitFor('window.simulated.length === 1 && document.querySelector("[data-feature-status]").textContent.includes("owner approval is still required")');
  assert.deepEqual(await evaluate('window.simulated[0]'), { requestId: '00000000-0000-4000-8000-000000000001', outcome: 'success' });
  assert.deepEqual(await evaluate('window.enabled'), []);
  assert.deepEqual(errors, []);
});
