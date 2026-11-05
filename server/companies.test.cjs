const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { Client, Pool } = require('pg');
const { verifyToken, issueToken } = require('./license-token.cjs');

test('owner registration, company isolation, blank checklists and both renewal paths', { skip: !process.env.TEST_DATABASE_URL, timeout: 240000 }, async (t) => {
  const database = `fg_company_test_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  const legacyIds = require('../www/legacy-identifiers.json');
  const bootstrap = require('./bootstrap-client.json');
  const previous = new Client({ connectionString: url.href });
  await previous.connect();
  try {
    await previous.query(`CREATE TABLE ${legacyIds.registryTable} (
      code TEXT PRIMARY KEY,name TEXT NOT NULL,schema_name TEXT NOT NULL UNIQUE,
      test_renewal_enabled BOOLEAN NOT NULL DEFAULT FALSE,active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await previous.query(`INSERT INTO ${legacyIds.registryTable}(code,name,schema_name) VALUES($1,$2,'public')`, [bootstrap.code, bootstrap.name]);
  } finally { await previous.end(); }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-companies-'));
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const serverSecret = crypto.randomBytes(32).toString('hex');
  const child = spawn(process.execPath, ['server/index.cjs'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ADMIN_PORT: '0', ADMIN_HOST: '127.0.0.1', LICENSE_PUBLIC_KEY_FILE: '', DATABASE_URL: url.href, PORT: String(port), REPORTS_ROOT: path.join(directory, 'reports'),
      COMPANY_REPORTS_ROOT: path.join(directory, 'company-reports'), JWT_SECRET: serverSecret,
      ADMIN_EMAIL: 'admin', ADMIN_PASSWORD: 'test-password' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    await admin.end();
    await fs.rm(directory, { recursive: true, force: true });
  });
  for (let attempt = 0; !output.includes('private administration listening on'); attempt++) {
    if (attempt > 200 || child.exitCode !== null) throw new Error(output);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const base = `http://127.0.0.1:${port}`;
  const adminBase = `http://127.0.0.1:${output.match(/private administration listening on 127\.0\.0\.1:(\d+)/)[1]}`;
  async function request(route, { method = 'GET', body, token, company, status = 200, headers = {} } = {}) {
    const origin = route.startsWith('/api/license/owner') ? adminBase : base;
    const response = await fetch(`${origin}${company ? `/c/${company}` : ''}${route}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); }
    catch { throw new Error(`${route}: HTTP ${response.status}: ${text.slice(0, 300)}`); }
    assert.equal(response.status, status, `${route}: ${JSON.stringify(value)}`);
    return value;
  }
  const post = (route, body, options = {}) => request(route, { method: 'POST', body, ...options });
  async function activateFeatures(company, token, features = ['lighting', 'checks', 'tickets', 'appliances', 'billing']) {
    const pending = await post('/api/company-features/requests', { features }, { company, token });
    await post(`${ownerPath}/features-review`, { companyCode: company, requestId: pending.requestId, approve: true }, { token: owner });
  }
  const ownerPath = '/api/license/owner';
  const loginWindowStarted = Date.now();
  await request('/api/auth/me', { status: 423 });
  for (const route of ['/admin', '/admin/', '/admin/renderer.js', '/ADMIN/', '/api/license/owner/setup', '/API/LICENSE/OWNER/setup']) {
    assert.equal((await fetch(`${base}${route}`)).status, 404, `Public administrator route exposed: ${route}`);
  }
  const clientPage = await (await fetch(base)).text();
  assert(!/data-platform-admin|href=["'][^"']*\/admin\/?["']/.test(clientPage));
  const adminRedirect = await fetch(`${adminBase}/admin`, { redirect: 'manual' });
  assert.equal(adminRedirect.status, 302);
  assert.equal(adminRedirect.headers.get('location'), '/admin/');
  const adminPage = await fetch(`${adminBase}/admin/`);
  assert.equal(adminPage.status, 200);
  assert.equal(adminPage.headers.get('cache-control'), 'no-store');
  assert(adminPage.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert((await adminPage.text()).includes('PrimeOps administrator sign-in'));
  for (const asset of ['renderer.js', 'styles.css', 'icon.png']) {
    assert.equal((await fetch(`${adminBase}/admin/${asset}`)).status, 200);
  }
  for (const privateFile of ['main.cjs', 'preload.cjs', 'package.json']) {
    assert.equal((await fetch(`${adminBase}/admin/${privateFile}`)).status, 404);
  }
  assert.equal((await request(`${ownerPath}/setup`)).registered, false);
  await post(`${ownerPath}/register`, { adminUsername: 'admin', adminPassword: 'wrong', ownerUsername: 'owner', ownerPassword: 'owner-password-123' }, { status: 401 });
  await post(`${ownerPath}/register`, { adminUsername: 'admin', adminPassword: 'test-password', ownerUsername: 'owner', ownerPassword: 'owner-password-123', displayName: 'Platform Founder' }, { status: 201 });
  assert.equal((await request('/api/license')).ownerRegistered, true);
  const firstLicence = await request('/api/license');
  assert.equal(firstLicence.state, 'active');
  await post(`${ownerPath}/register`, { adminUsername: 'admin', adminPassword: 'test-password', ownerUsername: 'intruder', ownerPassword: 'intruder-password-123' }, { status: 409 });
  assert.equal((await request('/api/license')).token, firstLicence.token);
  await post(`${ownerPath}/login`, { username: 'admin', password: 'test-password' }, { status: 401 });
  const owner = (await post(`${ownerPath}/login`, { username: 'owner', password: 'owner-password-123' })).token;
  if (process.env.CHROMIUM) {
    await t.test('invoice setup guides creation and issued invoices reach the correct client in app', async (t) => {
      const company = 'INVOICE-DELIVERY';
      await post(`${ownerPath}/companies`, { code: company, name: 'Invoice Delivery Client',
        adminUsername: 'invoice-client', adminPassword: 'invoice-client-password-123' }, { token: owner, status: 201 });
      const clientToken = (await post('/api/auth/login', { email: 'invoice-client', password: 'invoice-client-password-123' }, { company })).token;
      const initial = await request(`${ownerPath}/accounts?companyCode=${company}`, { token: owner });
      assert.equal(initial.invoiceReadiness.seller.ready, false);
      assert.equal(initial.invoiceReadiness.client.ready, false);
      const day = new Date().toISOString().slice(0, 10);
      await post(`${ownerPath}/accounts/invoices`, { companyCode: company, revision: initial.company.revision,
        description: 'Test subscription', amount: '250.00', issuedOn: day, dueOn: day }, { token: owner, status: 409 });
      assert.equal((await request('/api/platform-account', { company, token: clientToken })).invoices.length, 0);
      const { cdp, evaluate, waitFor, errors } = await require('./browser-test-helper.cjs').browserSession(t, process.env.CHROMIUM, ['--headless']);
      await cdp('Page.navigate', { url: `${adminBase}/admin/` });
      await waitFor('document.querySelector("#login-section")?.hidden === false && !document.querySelector("#login button").disabled');
      await evaluate(`(async()=>{token=${JSON.stringify(owner)};await refresh('');showTab('home');})()`);
      await waitFor('!document.querySelector("#dashboard").hidden && !document.querySelector("#home-button").disabled');
      await evaluate(`document.querySelector('[data-tab=clients]').click();document.querySelector('[data-open-client="${company}"]').click()`);
      await waitFor(`document.querySelector('#company-code').textContent==='${company}' && !document.querySelector('#home-button').disabled`);
      await evaluate('document.querySelector("[data-tab=client-account]").click();document.querySelector("#invoice-editor").open=true');
      assert.match(await evaluate('document.querySelector("#invoice-readiness").textContent'), /Invoice setup required/);
      await evaluate('document.querySelector("[data-go=invoice-setup]").click()');
      await waitFor('!document.querySelector("#invoice-setup").hidden');
      await evaluate(`(() => {const form=document.querySelector('#invoice-settings-form');
        for(const [key,value] of Object.entries({legalName:'Test Invoicing Business',registrationNumber:'',vatNumber:'',address:'Test business address',email:'billing@example.test',phone:'',terms:'Pay through PrimeOps.',jurisdiction:'ZA',vatRegistered:'false',vatRate:'0'}))form.elements[key].value=value;
        form.requestSubmit();})()`);
      await waitFor('document.querySelector("#status").textContent.includes("Invoice seller details saved") && !document.querySelector("#home-button").disabled');
      await evaluate(`document.querySelector('[data-tab=clients]').click();document.querySelector('[data-open-client="${company}"]').click()`);
      await waitFor(`document.querySelector('#company-code').textContent==='${company}' && !document.querySelector('#home-button').disabled`);
      await evaluate('document.querySelector("[data-tab=client-account]").click();document.querySelector("#invoice-editor").open=true;document.querySelector("[data-open-debtor-profile]").click()');
      assert.equal(await evaluate('document.querySelector("#debtor-profile-editor").open'), true);
      await evaluate(`(() => {const form=document.querySelector('#debtor-profile-form');
        for(const [key,value] of Object.entries({legalName:'Invoice Delivery Client Ltd',registrationNumber:'',vatNumber:'',billingAddress:'Test client address',contactName:'Accounts',contactEmail:'client@example.test',contactPhone:'',paymentTermsDays:'30',internalNotes:'',vatRegistered:'false'}))form.elements[key].value=value;
        form.requestSubmit();})()`);
      await waitFor('document.querySelector("#invoice-readiness").textContent.includes("Ready to issue") && !document.querySelector("#home-button").disabled');
      await evaluate(`document.querySelector('#invoice-editor').open=true;document.querySelector('#invoice-form [name=amount]').value='250.00';document.querySelector('#invoice-form').requestSubmit()`);
      await waitFor('document.querySelector("#invoice-create-status").textContent.includes("Invoice created and available") && !document.querySelector("#home-button").disabled');
      const clientStatement = await request('/api/platform-account', { company, token: clientToken });
      assert.equal(clientStatement.invoices.length, 1);
      assert.equal(clientStatement.outstandingCents, 25000);
      assert.equal((await request(`${ownerPath}/accounts?companyCode=${company}`, { token: owner })).outstandingCents, 25000);
      assert.match(await evaluate('document.querySelector("#client-account-summary").textContent'), /250[,.]00/);
      assert.match(await evaluate('document.querySelector("#home-finances").textContent'), /250[,.]00/);
      assert.equal(clientStatement.invoices[0].amountCents, 25000);
      assert.equal(clientStatement.invoices[0].document.customer.legalName, 'Invoice Delivery Client Ltd');
      const downloads = path.join(directory, 'invoice-downloads');
      await fs.mkdir(downloads);
      await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
      const downloadName = `Invoice-${clientStatement.invoices[0].reference}.pdf`;
      async function waitForPdf(name) {
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            const bytes = await fs.readFile(path.join(downloads, name));
            if (bytes.subarray(0, 5).toString() === '%PDF-') return bytes;
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error('Invoice PDF download did not complete.');
      }
      await evaluate('document.querySelector("[data-download-owner-invoice]").click()');
      const ownerPdf = await waitForPdf(downloadName);
      assert(ownerPdf.length > 1000);
      await waitFor('!document.querySelector("#home-button").disabled');
      await fs.unlink(path.join(downloads, downloadName));
      const otherToken = (await post('/api/auth/login', { email: 'admin', password: 'test-password' })).token;
      assert.equal((await request('/api/platform-account', { token: otherToken })).invoices.length, 0);
      await request(`/api/platform-account/invoice/${clientStatement.invoices[0].id}`, { token: otherToken, status: 404 });
      await request(`/api/platform-account/invoice/${clientStatement.invoices[0].id}?format=pdf`, { token: otherToken, status: 404 });
      await cdp('Page.navigate', { url: base });
      await waitFor('!!document.querySelector("#auth-screen")');
      await evaluate(`localStorage.setItem('primeops-company-code','${company}');localStorage.setItem('primeops-token-${company}',${JSON.stringify(clientToken)})`);
      await cdp('Page.reload');
      await waitFor('document.querySelector("#app-shell")?.hidden===false');
      await waitFor('document.querySelector("[data-platform-account-summary]")?.textContent.includes("250")');
      await evaluate('document.querySelector("[data-open-platform-statement]").click()');
      await waitFor(`document.querySelector('#platform-account-dialog').textContent.includes('${clientStatement.invoices[0].reference}')`);
      await evaluate('document.querySelector("#platform-account-dialog [data-refresh-platform-statement]").click()');
      await waitFor('!!document.querySelector("#platform-account-dialog [data-view-platform-invoice]")');
      await evaluate('document.querySelector("#platform-account-dialog [data-download-platform-invoice]").click()');
      const clientPdf = await waitForPdf(downloadName);
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const parsed = await getDocument({ data: new Uint8Array(clientPdf), useSystemFonts: true }).promise;
      try {
        assert.equal(parsed.numPages, 1);
        const content = (await (await parsed.getPage(1)).getTextContent()).items.map((item) => item.str).join(' ');
        assert(content.includes('Invoice Delivery Client Ltd'));
        assert(content.includes(clientStatement.invoices[0].reference));
        assert.match(content, /250[,.]00/);
      } finally { await parsed.destroy(); }
      await waitFor('!document.querySelector("#platform-account-dialog [data-download-platform-invoice]").disabled');
      await evaluate('document.querySelector("#platform-account-dialog [data-view-platform-invoice]").click()');
      await waitFor('document.querySelector("#invoice-document-dialog").open');
      assert.match(await evaluate('document.querySelector("#invoice-document-dialog iframe").srcdoc'), /Invoice Delivery Client Ltd/);
      await evaluate(`document.querySelector('#close-invoice-document').click();
        document.querySelector('#platform-account-dialog [name=contactName]').value='Unsaved client contact'`);
      const current = await request(`${ownerPath}/accounts?companyCode=${company}`, { token: owner });
      assert.equal((await request('/api/platform-account/revision', { company, token: clientToken })).revision, current.company.revision);
      await request('/api/platform-account/revision', { token: clientToken, status: 401 });
      const submittedAt = Date.now();
      await post(`${ownerPath}/accounts/invoices`, { companyCode: company, revision: current.company.revision,
        reference: 'LIVE-REFRESH-TEST', description: 'Additional service', amount: '75.00', issuedOn: day, dueOn: day },
      { token: owner, status: 201 });
      for (let attempt = 0; attempt < 20; attempt++) {
        if (await evaluate('document.querySelector("#platform-account-dialog [data-platform-ledger]")?.textContent.includes("LIVE-REFRESH-TEST")')) break;
        if (attempt === 19) throw new Error('New invoice did not reach the open client statement within five seconds.');
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert(Date.now() - submittedAt < 5000, 'Submitted invoices must reach the visible client balance within five seconds');
      assert.equal(await evaluate('document.querySelector("#platform-account-dialog [name=contactName]").value'), 'Unsaved client contact');
      assert.match(await evaluate('document.querySelector("#platform-account-dialog [data-platform-ledger]").textContent'), /325[,.]00/);
      assert.match(await evaluate('document.querySelector("[data-platform-account-summary]").textContent'), /325[,.]00/);
      assert.deepEqual(errors, []);
    });
  }
  const invoiceSettings = await request(`${ownerPath}/invoice-settings`, { token: owner });
  await request(`${ownerPath}/invoice-settings`, { method: 'PUT', token: owner, body: { revision: invoiceSettings.revision,
    seller: { legalName: 'Test Invoicing Business', registrationNumber: '', vatNumber: '', address: 'Test business address',
      email: 'billing@example.test', phone: '', terms: 'Pay through PrimeOps.', jurisdiction: 'ZA', vatRegistered: false, vatBasisPoints: 0 } } });
  assert.equal((await fetch(`${base}${ownerPath}/dashboard`, { headers: { Authorization: `Bearer ${owner}`, 'X-Forwarded-For': '127.0.0.1' } })).status, 404);
  await request(`${ownerPath}/dashboard`, { status: 401 });
  const dashboard = await request(`${ownerPath}/dashboard`, { token: owner });
  assert.equal(dashboard.licence.state, 'active');
  assert.equal(dashboard.account.role, 'owner');
  assert.equal(dashboard.ownership.displayName, 'Platform Founder');
  assert.equal(dashboard.testRenewalEnabled, false);
  const publicKey = crypto.createPublicKey({ key: firstLicence.publicKey, format: 'jwk' });
  assert.equal(verifyToken(firstLicence.token, publicKey).systemId, firstLicence.systemId);
  await post(`${ownerPath}/issue`, { companyCode: 'FEENSTRA', baseTokenId: 'first-activation' }, { token: owner, status: 409 });
  const feenstraAdmin = (await post('/api/auth/login', { email: 'admin', password: 'test-password' })).token;
  await request(`${ownerPath}/dashboard`, { token: feenstraAdmin, status: 401 });
  assert((await request('/api/check-templates', { token: feenstraAdmin })).templates.length > 10);
  const adminCredentials = { adminUsername: 'same-admin', adminPassword: 'company-password-123' };
  for (const [code, name] of [['AFRICREST', 'Africrest'], ['BROLL', 'Broll Properties']]) {
    await post(`${ownerPath}/companies`, { code, name, ...adminCredentials }, { token: owner, status: 201 });
    const companyStatus = await request('/api/license', { company: code });
    assert.equal(companyStatus.state, 'active');
    assert.equal(companyStatus.companyName, name);
    const claims = verifyToken(companyStatus.token, publicKey);
    assert.equal(claims.previousId, null);
    assert.equal(claims.termStart, claims.issuedAt);
    assert.equal(claims.expiresAt, require('./license-token.cjs').nextYear(claims.issuedAt));
    await post('/api/auth/login', { email: 'same-admin', password: adminCredentials.adminPassword }, { company: code });
    await post(`${ownerPath}/issue`, { companyCode: code, baseTokenId: 'first-activation' }, { token: owner, status: 409 });
    assert.equal((await request('/api/license', { company: code })).token, companyStatus.token);
  }
  const originalLicence = await request('/api/license', { company: 'AFRICREST' });
  await post(`${ownerPath}/companies`, { code: 'AFRICREST', name: 'Duplicate', ...adminCredentials }, { token: owner, status: 409 });
  assert.equal((await request('/api/license', { company: 'AFRICREST' })).token, originalLicence.token);
  await request('/api/license', { company: 'UNKNOWN', status: 404 });
  const a = (await post('/api/auth/login', { email: 'same-admin', password: adminCredentials.adminPassword }, { company: 'AFRICREST' })).token;
  const b = (await post('/api/auth/login', { email: 'same-admin', password: adminCredentials.adminPassword }, { company: 'BROLL' })).token;
  await t.test('public client lookup accepts codes and company names before client licence selection', async () => {
    assert.equal((await post('/api/auth/company', { identifier: 'africrest' })).code, 'AFRICREST');
    assert.equal((await post('/api/auth/company', { identifier: 'broll properties' })).code, 'BROLL');
    await post('/api/auth/company', { identifier: 'Missing Client Name' }, { status: 404 });
    await post('/api/auth/company', { identifier: '' }, { status: 400 });
    await post('/api/auth/login', { email: 'same-admin', password: adminCredentials.adminPassword }, { company: 'BROLL' });
  });
  assert.deepEqual((await request('/api/auth/me', { company: 'AFRICREST', token: a })).user.companyFeatures, []);
  await request('/api/tickets', { company: 'AFRICREST', token: a, status: 403 });
  await activateFeatures('AFRICREST', a);
  await activateFeatures('BROLL', b);
  await request('/api/auth/me', { company: 'BROLL', token: a, status: 401 });
  await request('/api/auth/me', { company: 'AFRICREST', token: b, status: 401 });
  await request('/api/auth/me', { token: a, status: 401 });
  for (const [company, token] of [['AFRICREST', a], ['BROLL', b]]) {
    assert.deepEqual((await request('/api/properties', { company, token })).properties, []);
    assert.deepEqual((await request('/api/check-templates', { company, token })).templates, []);
    assert.deepEqual((await request('/api/tickets', { company, token })).tickets, []);
    assert.deepEqual((await request('/api/appliance-parts', { company, token })).parts, []);
    assert.deepEqual((await request('/api/workspace', { company, token })).data.properties, []);
    assert.equal((await request('/api/users', { company, token })).users.length, 1);
  }
  const property = (await post('/api/properties', { name: 'Africrest Only Building', city: 'Pretoria' }, { company: 'AFRICREST', token: a, status: 201 })).property;
  if (process.env.CHROMIUM) await t.test('client portal signs in by company name or code without switching companies and hides resident fields for office staff', async (t) => {
    const { cdp, evaluate, waitFor, errors } = await require('./browser-test-helper.cjs').browserSession(t, process.env.CHROMIUM, ['--headless']);
    await cdp('Page.navigate', { url: base });
    await waitFor('!document.querySelector("#auth-screen").hidden && !!document.querySelector("#login-form [name=company]").value');
    assert.equal(await evaluate('document.querySelector("#login-form [data-change-company]") === null'), true);
    await evaluate(`(() => {
      const form = document.querySelector('#login-form');
      form.elements.company.value = 'Africrest';
      form.elements.email.value = 'same-admin';
      form.elements.password.value = 'wrong-password';
      form.requestSubmit();
    })()`);
    await waitFor('!document.querySelector("#login-error").hidden && !document.querySelector("#login-form [type=submit]").disabled');
    assert.equal(await evaluate("localStorage.getItem('primeops-company-code')"), null);
    await evaluate(`document.querySelector('#login-form [name=password]').value = ${JSON.stringify(adminCredentials.adminPassword)}; document.querySelector('#login-form').requestSubmit()`);
    await waitFor('!document.querySelector("#app-shell").hidden');
    assert.equal(await evaluate("localStorage.getItem('primeops-company-code')"), 'AFRICREST');
    assert.equal(await evaluate(`Object.values(localStorage).some(value => value.includes(${JSON.stringify(adminCredentials.adminPassword)}))`), false);
    await evaluate('document.querySelector("[data-home-view=users]").click()');
    await waitFor('!!document.querySelector("#create-user-form [name=sections]")');
    await evaluate(`document.querySelector('#users-tab-create').click(); (() => {
      const role = document.querySelector('#create-user-form [name=role]');
      role.value = 'office_admin'; role.dispatchEvent(new Event('change', {bubbles:true}));
    })()`);
    assert.deepEqual(await evaluate(`(() => {
      const form = document.querySelector('#create-user-form');
      return { unitRequired: form.elements.unitNumber.required, unitDisabled: form.elements.unitNumber.disabled,
        unitHidden: form.elements.unitNumber.closest('[data-resident-field]').hidden,
        sections: [...form.querySelectorAll('[name=sections]:checked')].map(input => input.value).sort() };
    })()`), { unitRequired: false, unitDisabled: true, unitHidden: true, sections: ['billing', 'leasing'] });
    await evaluate('document.querySelector("#signout-button").click()');
    await waitFor('!document.querySelector("#auth-screen").hidden');
    await evaluate(`(() => {
      const form = document.querySelector('#login-form');
      form.elements.company.value = 'broll';
      form.elements.email.value = 'same-admin';
      form.elements.password.value = ${JSON.stringify(adminCredentials.adminPassword)};
      form.requestSubmit();
    })()`);
    await waitFor('!document.querySelector("#app-shell").hidden && localStorage.getItem("primeops-company-code")==="BROLL"');
    assert.deepEqual(errors, []);
  });
  assert(property.id);
  assert.equal((await request('/api/properties', { company: 'BROLL', token: b })).properties.length, 0);
  const template = { title: 'Africrest private check', propertyIds: [property.id], questions: [
    { label: 'Private question', type: 'yes-no-na', photo: true }
  ] };
  await request(`${ownerPath}/content?companyCode=AFRICREST`, { token: a, status: 401 });
  await post(`${ownerPath}/buildings`, { companyCode: 'AFRICREST', name: 'Forbidden' }, { token: a, status: 401 });
  await post(`${ownerPath}/checklists`, { companyCode: 'BROLL', ...template }, { token: owner, status: 403 });
  const created = await post('/api/check-templates', template, { company: 'AFRICREST', token: a, status: 201 });
  assert.equal((await request('/api/check-templates', { company: 'AFRICREST', token: a })).templates[0].title, template.title);
  assert.deepEqual((await request('/api/check-templates', { company: 'BROLL', token: b })).templates, []);
  await post('/api/check-templates', template, { company: 'BROLL', token: b, status: 403 });
  await request(`/api/check-templates/${created.id}/archive`, { company: 'BROLL', token: b, method: 'PUT', body: {}, status: 404 });
  const ticket = (await post('/api/tickets', { propertyId: property.id, unitNumber: 'A1', subject: 'Africrest only issue', description: 'Private', tags: ['General'] },
    { company: 'AFRICREST', token: a, status: 201 })).ticket;
  assert(ticket.id);
  assert.equal((await request('/api/tickets', { company: 'BROLL', token: b })).tickets.length, 0);
  await request(`/api/tickets/${ticket.id}/photo`, { company: 'BROLL', token: b, status: 404 });
  const feenstraFolder = await request('/api/settings/reports', { token: feenstraAdmin });
  const aFolder = await request('/api/settings/reports', { company: 'AFRICREST', token: a });
  const bFolder = await request('/api/settings/reports', { company: 'BROLL', token: b });
  assert.notEqual(aFolder.root, bFolder.root);
  assert(!aFolder.root.startsWith(`${feenstraFolder.root}${path.sep}`));
  const foreignLicence = await request('/api/license', { company: 'AFRICREST' });
  await post('/api/license/activate', { token: foreignLicence.token }, { company: 'BROLL', status: 400 });
  const claim = verifyToken(foreignLicence.token, publicKey);
  const renewalBody = { mode: 'request', username: 'same-admin', password: adminCredentials.adminPassword, baseTokenId: claim.id };
  await post('/api/license/renew', { ...renewalBody, mode: 'test' }, { company: 'AFRICREST', status: 403 });
  const pending = await post('/api/license/renew', renewalBody, { company: 'AFRICREST' });
  const same = await post('/api/license/renew', renewalBody, { company: 'AFRICREST' });
  assert.equal(same.requestId, pending.requestId);
  const approved = await post(`${ownerPath}/issue`, { companyCode: 'AFRICREST', baseTokenId: claim.id, requestId: pending.requestId }, { token: owner });
  assert.equal(verifyToken(approved.token, publicKey).termStart, claim.expiresAt);
  await post(`${ownerPath}/issue`, { companyCode: 'AFRICREST', baseTokenId: claim.id, requestId: pending.requestId }, { token: owner, status: 409 });
  await request(`${ownerPath}/settings`, { token: owner, method: 'PUT', body: { companyCode: 'AFRICREST', testRenewalEnabled: true } });
  assert.equal((await request('/api/license', { company: 'AFRICREST' })).testRenewalEnabled, true);
  assert.equal((await request('/api/license', { company: 'BROLL' })).testRenewalEnabled, false);
  const nextId = verifyToken(approved.token, publicKey).id;
  const renewed = await post('/api/license/renew', { ...renewalBody, mode: 'test', baseTokenId: nextId }, { company: 'AFRICREST' });
  assert.equal(renewed.status, 'approved');
  assert.equal(verifyToken(renewed.licence.token, publicKey).previousId, nextId);
  await post('/api/license/renew', { ...renewalBody, mode: 'test', baseTokenId: nextId }, { company: 'AFRICREST', status: 409 });
  const databaseClient = new Client({ connectionString: url.href });
  await databaseClient.connect();
  try {
    const { rows } = await databaseClient.query('SELECT private_key_encrypted FROM licence_owner');
    assert(!rows[0].private_key_encrypted.includes('PRIVATE KEY'));
    await t.test('failed first-token registration rolls back company, main admin and schema', async () => {
      const schemas = async () => (await databaseClient.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'company_%' ORDER BY nspname")).rows;
      const before = await schemas();
      await databaseClient.query("UPDATE licence_owner SET private_key_encrypted='invalid-key'");
      try {
        await post(`${ownerPath}/companies`, { code: 'FAILED', name: 'Must roll back', ...adminCredentials }, { token: owner, status: 503 });
        assert.deepEqual((await databaseClient.query("SELECT code FROM companies WHERE code='FAILED'")).rows, []);
        assert.deepEqual(await schemas(), before);
      } finally {
        await databaseClient.query('UPDATE licence_owner SET private_key_encrypted=$1', [rows[0].private_key_encrypted]);
      }
    });
    assert.equal((await databaseClient.query('SELECT to_regclass($1) AS previous', [`public.${legacyIds.registryTable}`])).rows[0].previous, null);
    const { rows: company } = await databaseClient.query("SELECT schema_name FROM companies WHERE code='AFRICREST'");
    const schema = company[0].schema_name;
    await databaseClient.query(`UPDATE "${schema}".system_licence SET last_seen=NOW()+INTERVAL '1 hour'`);
    await request('/api/auth/me', { company: 'AFRICREST', token: a, status: 423 });
    await request('/api/auth/me', { company: 'BROLL', token: b });
    await databaseClient.query(`UPDATE "${schema}".system_licence SET last_seen=NOW()`);
    const expiring = 'EXPIRED';
    await post(`${ownerPath}/companies`, { code: expiring, name: 'Expired test company', ...adminCredentials }, { token: owner, status: 201 });
    const expiredStatus = await request('/api/license', { company: expiring });
    const [iv, tag, encrypted] = rows[0].private_key_encrypted.split('.').map((part) => Buffer.from(part, 'base64url'));
    const cipher = crypto.createDecipheriv('aes-256-gcm',
      Buffer.from(crypto.hkdfSync('sha256', serverSecret, 'PrimeOps-owner', 'signing-key-encryption-v1', 32)), iv);
    cipher.setAuthTag(tag);
    const signingKey = crypto.createPrivateKey(Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8'));
    const oldIv = crypto.randomBytes(12);
    const oldCipher = crypto.createCipheriv('aes-256-gcm',
      Buffer.from(crypto.hkdfSync('sha256', serverSecret, legacyIds.ownerKeySalt, 'signing-key-encryption-v1', 32)), oldIv);
    const oldData = Buffer.concat([oldCipher.update(signingKey.export({ type: 'pkcs8', format: 'pem' })), oldCipher.final()]);
    await databaseClient.query('UPDATE licence_owner SET private_key_encrypted=$1,key_version=1',
      [[oldIv, oldCipher.getAuthTag(), oldData].map((part) => part.toString('base64url')).join('.')]);
    const expiredToken = issueToken(signingKey, expiredStatus.systemId, null, new Date('2020-01-01T00:00:00.000Z'));
    const { rows: expiredCompany } = await databaseClient.query('SELECT schema_name FROM companies WHERE code=$1', [expiring]);
    await databaseClient.query(`UPDATE "${expiredCompany[0].schema_name}".system_licence SET token=$1`, [expiredToken]);
    assert.equal((await request('/api/license', { company: expiring })).state, 'expired');
    await post('/api/auth/login', { email: 'same-admin', password: adminCredentials.adminPassword }, { company: expiring, status: 423 });
    const expiredBase = verifyToken(expiredToken, publicKey).id;
    const recovery = await post('/api/license/renew', { ...renewalBody, baseTokenId: expiredBase }, { company: expiring });
    const recovered = await post(`${ownerPath}/issue`, { companyCode: expiring, baseTokenId: expiredBase, requestId: recovery.requestId }, { token: owner });
    assert.equal(recovered.licence.state, 'active');
    await post('/api/auth/login', { email: 'same-admin', password: adminCredentials.adminPassword }, { company: expiring });
  } finally { await databaseClient.end(); }
  await t.test('subscription limits count all active users and serialize concurrent creation and approvals', async () => {
    assert.equal((await request('/api/subscription', { token: feenstraAdmin })).plan, 'operations');
    assert.equal((await request('/api/subscription', { company: 'AFRICREST', token: a })).plan, 'basic');
    await post(`${ownerPath}/companies`, { code: 'TIERS', name: 'Subscription Test', ...adminCredentials }, { token: owner, status: 201 });
    const registeredLicence = await request('/api/license', { company: 'TIERS' });
    const token = (await post('/api/auth/login', { email: adminCredentials.adminUsername, password: adminCredentials.adminPassword }, { company: 'TIERS' })).token;
    const options = { company: 'TIERS', token };
    await activateFeatures('TIERS', token);
    const building = (await post('/api/properties', { name: 'Plan Building' }, { ...options, status: 201 })).property;
    const body = (index) => ({ email: `member-${index}`, name: `Member ${index}`, role: 'technician', password: 'test-password', propertyIds: [building.id] });
    for (let index = 0; index < 8; index++) await post('/api/users', body(index), { ...options, status: 201 });
    const race = await Promise.all([8, 9].map(async (index) => {
      const response = await fetch(`${base}/c/TIERS/api/users`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body(index)),
        signal: AbortSignal.timeout(15000)
      });
      return { status: response.status, body: await response.json() };
    }));
    assert.deepEqual(race.map((item) => item.status).sort(), [201, 409]);
    assert.equal((await request('/api/subscription', options)).activeUsers, 10);
    await post('/api/users', body(10), { ...options, status: 409, headers: { 'X-Operation-ID': crypto.randomUUID() } });
    const technician = (await post('/api/auth/login', { email: 'member-0', password: 'test-password' }, { company: 'TIERS' })).token;
    await post('/api/subscription/requests', { plan: 'operations' }, { company: 'TIERS', token: technician, status: 403 });
    await request(`${ownerPath}/subscription?companyCode=TIERS`, { token, status: 401 });
    await request(`${ownerPath}/subscription`, { token, method: 'PUT', body: { companyCode: 'TIERS', plan: 'operations' }, status: 401 });
    await post('/api/subscription/requests', { plan: 'invalid' }, { ...options, status: 400 });
    const pending = await post('/api/subscription/requests', { plan: 'building-managers' }, options);
    assert.equal((await post('/api/subscription/requests', { plan: 'building-managers' }, options)).requestId, pending.requestId);
    await post('/api/subscription/requests', { plan: 'operations' }, { ...options, status: 409 });
    await request(`${ownerPath}/subscription`, { token: owner, method: 'PUT',
      body: { companyCode: 'BROLL', plan: 'building-managers', requestId: pending.requestId }, status: 409 });
    assert.equal((await request('/api/subscription', options)).plan, 'basic');
    await request(`${ownerPath}/subscription`, { token: owner, method: 'PUT',
      body: { companyCode: 'TIERS', plan: 'building-managers', requestId: pending.requestId } });
    await request(`${ownerPath}/subscription`, { token: owner, method: 'PUT',
      body: { companyCode: 'TIERS', plan: 'building-managers', requestId: pending.requestId }, status: 409 });
    for (let index = 10; index < 20; index++) await post('/api/users', body(index), { ...options, status: 201 });
    await post('/api/users', body(20), { ...options, status: 409 });
    const account = (await request('/api/users', options)).users.find((item) => item.email === 'member-0');
    await request(`/api/users/${account.id}`, { ...options, method: 'PUT', body: { ...body(0), active: false } });
    await post('/api/users', body(20), { ...options, status: 201 });
    await request(`/api/users/${account.id}`, { ...options, method: 'PUT', body: { ...body(0), active: true }, status: 409 });
    await request(`${ownerPath}/subscription`, { token: owner, method: 'PUT', body: { companyCode: 'TIERS', plan: 'basic' }, status: 409 });
    const declined = await post('/api/subscription/requests', { plan: 'basic' }, options);
    await post(`${ownerPath}/subscription-decline`, { companyCode: 'TIERS', requestId: declined.requestId }, { token: owner });
    await post(`${ownerPath}/subscription-decline`, { companyCode: 'TIERS', requestId: declined.requestId }, { token: owner, status: 409 });
    await post('/api/subscription/requests', { plan: 'operations' }, options);
    await request(`${ownerPath}/subscription`, { token: owner, method: 'PUT', body: { companyCode: 'TIERS', plan: 'operations' } });
    await post('/api/users', body(21), { ...options, status: 201 });
    assert.equal((await request('/api/subscription', options)).activeUsers, 21);
    assert.equal((await request('/api/license', { company: 'TIERS' })).token, registeredLicence.token);
    assert.equal((await request('/api/subscription', { company: 'BROLL', token: b })).plan, 'basic');
    assert.equal((await request('/api/subscription', { token: feenstraAdmin })).plan, 'operations');
  });
  await t.test('company features require approval, initial setup is free and later additions cost R100 each', async () => {
    const token = (await post('/api/auth/login', { email: 'same-admin', password: adminCredentials.adminPassword }, { company: 'EXPIRED' })).token;
    const options = { company: 'EXPIRED', token };
    assert.equal((await request('/api/company-features', options)).catalog.length, 11);
    await post('/api/company-features/requests', { features: [] }, { ...options, status: 400 });
    await post('/api/company-features/requests', { features: ['unknown'] }, { ...options, status: 400 });
    await post('/api/company-features/requests', { features: ['tickets', 'tickets'] }, { ...options, status: 400 });
    const initial = await post('/api/company-features/requests', { features: ['tickets'] }, options);
    assert.equal(initial.feeCents, 0);
    assert.equal((await post('/api/company-features/requests', { features: ['tickets'] }, options)).requestId, initial.requestId);
    await request('/api/tickets', { ...options, status: 403 });
    await post(`${ownerPath}/features-review`, { companyCode: 'BROLL', requestId: initial.requestId, approve: true }, { token: owner, status: 409 });
    await post(`${ownerPath}/features-review`, { companyCode: 'EXPIRED', requestId: initial.requestId, approve: true }, { token: a, status: 401 });
    await post(`${ownerPath}/features-review`, { companyCode: 'EXPIRED', requestId: initial.requestId, approve: true }, { token: owner });
    assert.deepEqual((await request('/api/auth/me', options)).user.companyFeatures, ['tickets']);
    await request('/api/tickets', options);
    await request('/api/check-templates', { ...options, status: 403 });
    const extra = await post('/api/company-features/requests', { features: ['checks', 'appliances'], feeCents: 0 }, options);
    assert.equal(extra.feeCents, 20000);
    await post(`${ownerPath}/features-review`, { companyCode: 'EXPIRED', requestId: extra.requestId, approve: false }, { token: owner });
    await request('/api/check-templates', { ...options, status: 403 });
    const retry = await post('/api/company-features/requests', { features: ['checks'] }, options);
    assert.equal(retry.feeCents, 10000);
    await post(`${ownerPath}/features-review`, { companyCode: 'EXPIRED', requestId: retry.requestId, approve: true }, { token: owner });
    await request('/api/check-templates', options);
    await post(`${ownerPath}/features-review`, { companyCode: 'EXPIRED', requestId: retry.requestId, approve: true }, { token: owner, status: 409 });
    await post('/api/company-features/requests', { features: ['checks'] }, { ...options, status: 400 });
    assert.equal((await request('/api/company-features', { company: 'BROLL', token: b })).enabled.length, 5);
  });
  await t.test('new operations keep client, role, host and multi-building boundaries with visitor approval', async (t) => {
    await post(`${ownerPath}/companies`, { code: 'OPERATIONS', name: 'Operations Test Client', ...adminCredentials }, { token: owner, status: 201 });
    const token = (await post('/api/auth/login', { email: adminCredentials.adminUsername, password: adminCredentials.adminPassword }, { company: 'OPERATIONS' })).token;
    const options = { company: 'OPERATIONS', token };
    const operationIds = ['security', 'residents', 'meters', 'assets', 'incidents', 'contractors'];
    for (const id of operationIds) await request(`/api/operations/${id}`, { ...options, status: 403 });
    await post('/api/company-features/requests', { features: operationIds }, { ...options, status: 400 });
    await activateFeatures('OPERATIONS', token, operationIds.slice(0, 5));
    await activateFeatures('OPERATIONS', token, ['contractors']);
    const buildings = [];
    for (const name of ['North', 'South', 'Restricted']) buildings.push((await post('/api/properties', { name }, { ...options, status: 201 })).property);
    const originalSettings = await request('/api/company-settings', options);
    assert.equal(originalSettings.residentMode, 'students');
    let settings = await request('/api/company-settings', { ...options, method: 'PUT', body: {
      revision: originalSettings.revision, residentMode: 'both', securityPhone: '+27 12 345 6789'
    } });
    await request('/api/company-settings', { ...options, method: 'PUT', body: { ...settings, securityPhone: 'javascript:alert(1)' }, status: 400 });
    await request('/api/company-settings', { ...options, method: 'PUT', body: originalSettings, status: 409 });
    assert.equal((await request('/api/company-settings', { company: 'BROLL', token: b })).residentMode, 'students');
    const account = async (email, role, propertyIds, extra = {}) => {
      const body = { email, name: email, password: 'operation-password-123', role, propertyIds, unitNumber: 'Unit 101', ...extra };
      const { user } = await post('/api/users', body, { ...options, status: 201 });
      return { user, body, token: (await post('/api/auth/login', { email, password: body.password }, { company: 'OPERATIONS' })).token };
    };
    const host = await account('resident-host', 'user', [buildings[0].id], { residentType: 'tenant' });
    const neighbour = await account('resident-neighbour', 'user', [buildings[0].id]);
    const mm = await account('building-manager', 'maintenance_manager', [buildings[0].id], { sections: [...operationIds, 'tickets'] });
    const ma = await account('building-worker', 'maintenance_assistant', buildings.slice(0, 2).map((building) => building.id));
    const hostOptions = { company: 'OPERATIONS', token: host.token };
    const mmOptions = { company: 'OPERATIONS', token: mm.token };
    assert.equal((await request('/api/auth/me', hostOptions)).user.residentType, 'tenant');
    assert.deepEqual((await request('/api/properties', hostOptions)).properties.map((building) => building.id), [buildings[0].id]);
    assert.deepEqual((await request('/api/properties', { company: 'OPERATIONS', token: ma.token })).properties.map((building) => building.id).sort(), buildings.slice(0, 2).map((building) => building.id).sort());
    for (const resident of [host, neighbour]) {
      await post('/api/users', { ...resident.body, email: `invalid-${resident.body.email}`, propertyIds: buildings.slice(0, 2).map((building) => building.id) }, { ...options, status: 400 });
      await request(`/api/users/${resident.user.id}`, { ...options, method: 'PUT',
        body: { ...resident.body, propertyIds: buildings.slice(0, 2).map((building) => building.id) }, status: 400 });
      assert.deepEqual((await request('/api/users', options)).users.find((user) => user.id === resident.user.id).property_ids, [buildings[0].id]);
    }
    await request(`/api/users/${ma.user.id}`, { ...options, method: 'PUT', body: { ...ma.body, role: 'user' }, status: 400 });
    await request('/api/company-settings', { ...mmOptions, method: 'PUT', body: settings, status: 403 });
    const visitor = { visitorName: 'Expected Visitor', expectedAt: new Date(Date.now() + 86400000).toISOString(), purpose: 'Visiting the tenant', phone: '' };
    const visit = (await post('/api/operations/residents', { propertyId: buildings[0].id, data: visitor, createdBy: neighbour.user.id }, { ...hostOptions, status: 201 })).record;
    assert.equal(visit.created_by, host.user.id);
    assert.equal(visit.status, 'pending');
    await post('/api/operations/residents', { propertyId: buildings[2].id, data: visitor }, { ...hostOptions, status: 403 });
    await post('/api/operations/residents', { propertyId: buildings[1].id, data: { ...visitor, visitorName: 'South Visitor' } }, { ...hostOptions, status: 403 });
    await post('/api/operations/residents', { propertyId: buildings[1].id, data: { ...visitor, visitorName: 'South Visitor' } }, { ...options, status: 201 });
    assert.equal((await request('/api/operations/residents', mmOptions)).records.length, 1);
    assert.equal((await request('/api/operations/residents', { company: 'OPERATIONS', token: neighbour.token })).records.length, 0);
    await request(`/api/operations/residents/${visit.id}`, { ...hostOptions, method: 'PUT', body: { status: 'approved', revision: 1 }, status: 403 });
    await request(`/api/operations/residents/${visit.id}`, { ...mmOptions, method: 'PUT', body: { status: 'checked_in', revision: 1 }, status: 409 });
    let current = visit;
    for (const status of ['approved', 'checked_in', 'checked_out']) {
      current = (await request(`/api/operations/residents/${visit.id}`, { ...mmOptions, method: 'PUT', body: { status, revision: current.revision } })).record;
    }
    await request(`/api/operations/residents/${visit.id}`, { ...mmOptions, method: 'PUT', body: { status: 'checked_in', revision: 1 }, status: 409 });
    assert.deepEqual((await request('/api/operations/residents', hostOptions)).records.find((row) => row.id === visit.id).events.map((event) => event.action), ['pending', 'approved', 'checked_in', 'checked_out']);
    const security = (await post('/api/operations/security', { propertyId: buildings[0].id, data: { kind: 'report', subject: 'Gate report', description: 'Please check the gate.', priority: 'urgent' } }, { ...hostOptions, status: 201 })).record;
    assert.equal((await request('/api/operations/security', mmOptions)).records[0].id, security.id);
    assert.equal((await request('/api/operations/security', { company: 'OPERATIONS', token: neighbour.token })).records.length, 0);
    await request(`/api/operations/security/${security.id}`, { ...mmOptions, method: 'PUT', body: { revision: 1, status: 'resolved' } });
    const meter = { meterReference: 'W1', meterType: 'water', reading: 0, unit: 'm3', readAt: new Date().toISOString() };
    await post('/api/operations/meters', { propertyId: buildings[0].id, data: meter }, { ...hostOptions, status: 403 });
    await post('/api/operations/meters', { propertyId: buildings[0].id, data: meter }, { company: 'OPERATIONS', token: ma.token, status: 201 });
    await post('/api/operations/meters', { propertyId: buildings[0].id, data: { ...meter, reading: -1 } }, { ...mmOptions, status: 400 });
    const assetData = { assetTag: 'A-1', name: 'Pump', category: 'Water', notes: 'Initial condition' };
    const asset = (await post('/api/operations/assets', { propertyId: buildings[0].id, data: assetData }, { ...mmOptions, status: 201 })).record;
    await post('/api/operations/assets', { propertyId: buildings[0].id, data: assetData }, { ...mmOptions, status: 409 });
    await request(`/api/operations/assets/${asset.id}`, { ...mmOptions, method: 'PUT', body: { revision: 1, data: { ...assetData, notes: 'Service required' } } });
    await request(`/api/operations/assets/${asset.id}`, { company: 'OPERATIONS', token: ma.token, method: 'PUT', body: { revision: 2, status: 'maintenance' } });
    const trackingDay = new Date().toISOString().slice(0, 10);
    const importRows = [
      { propertyId: buildings[0].id, data: { assetTag: 'IMPORT-PUMP', name: 'Imported pump', category: 'Plant', inspectionIntervalDays: 30, nextInspectionOn: trackingDay },
        source: { columns: ['Tag', 'Name', 'Manufacturer'], cells: ['IMPORT-PUMP', 'Imported pump', 'Original manufacturer'] } },
      { propertyId: buildings[1].id, data: { assetTag: 'IMPORT-GATE', name: 'Imported gate', category: 'Security' } }
    ];
    await post('/api/operations/assets/import', { reviewed: false, assets: importRows }, { ...options, status: 400 });
    await post('/api/operations/assets/import', { reviewed: true, assets: importRows }, { ...mmOptions, status: 403 });
    assert.equal((await request('/api/operations/assets', options)).records.some((row) => row.data.assetTag.startsWith('IMPORT-')), false);
    await post('/api/operations/assets/import', { reviewed: true, assets: importRows }, { company: 'OPERATIONS', token: ma.token, status: 403 });
    await post('/api/operations/assets/import', { reviewed: true, assets: importRows }, { ...options, status: 201 });
    await post('/api/operations/assets/import', { reviewed: true, assets: importRows }, { ...options, status: 409 });
    let imported = (await request('/api/operations/assets', options)).records.find((row) => row.data.assetTag === 'IMPORT-PUMP');
    let history = await request(`/api/operations/assets/${imported.id}/history`, options);
    assert(history.checklist.questions.length >= 5);
    assert(history.checklist.questions.some((question) => question.label.includes('seals')));
    assert.equal(history.asset.asset_source.cells[2], 'Original manufacturer');
    const workerOptions = { company: 'OPERATIONS', token: ma.token };
    const inspection = { revision: imported.revision, kind: 'inspection', happenedOn: trackingDay, notes: 'Seal leaking',
      condition: 'poor', answers: Object.fromEntries(history.checklist.questions.map((question, index) => [question.id, index === 1 ? 'fail' : 'pass'])) };
    await post(`/api/operations/assets/${imported.id}/activity`, { ...inspection, answers: {} }, { ...workerOptions, status: 400 });
    await post(`/api/operations/assets/${imported.id}/activity`, { ...inspection, photos: ['data:image/jpeg;base64,YWJj'] }, { ...workerOptions, status: 400 });
    await post(`/api/operations/assets/${imported.id}/activity`, inspection, { ...workerOptions, status: 201 });
    await post(`/api/operations/assets/${imported.id}/activity`, inspection, { ...workerOptions, status: 409 });
    history = await request(`/api/operations/assets/${imported.id}/history`, options);
    const recordedInspection = history.history.find((entry) => entry.kind === 'inspection');
    assert.equal(recordedInspection.detail.answers[history.checklist.questions[1].id], 'fail');
    assert.equal(history.asset.data.condition, 'poor');
    const expectedNext = new Date(`${trackingDay}T00:00:00Z`); expectedNext.setUTCDate(expectedNext.getUTCDate() + 30);
    assert.equal(history.asset.data.nextInspectionOn, expectedNext.toISOString().slice(0, 10));
    const newChecklist = { title: 'Revised pump inspection', questions: [{ label: 'New inspection point', type: 'yes-no-na', photo: false }] };
    await request(`/api/operations/assets/${imported.id}/checklist`, { ...workerOptions, method: 'PUT', body: { revision: history.asset.revision, checklist: newChecklist }, status: 403 });
    await request(`/api/operations/assets/${imported.id}/checklist`, { ...mmOptions, method: 'PUT', body: { revision: history.asset.revision, checklist: newChecklist } });
    history = await request(`/api/operations/assets/${imported.id}/history`, options);
    assert.equal(history.checklist.title, 'Revised pump inspection');
    assert.deepEqual(history.history.find((entry) => entry.id === recordedInspection.id).detail.checklist, recordedInspection.detail.checklist);
    const workRequest = { propertyId: buildings[0].id, unitNumber: 'Plant room', subject: 'Repair imported pump', description: 'Inspection found a leaking seal.',
      tags: ['General', 'Asset'], assetId: imported.id, assetActivityId: recordedInspection.id };
    await post('/api/tickets', workRequest, { ...mmOptions, status: 403 });
    await activateFeatures('OPERATIONS', token, ['tickets']);
    await post('/api/tickets', { ...workRequest, assetActivityId: crypto.randomUUID() }, { ...mmOptions, status: 404 });
    const work = (await post('/api/tickets', workRequest, { ...mmOptions, status: 201 })).ticket;
    await post('/api/tickets', workRequest, { ...mmOptions, status: 409 });
    assert.equal((await request(`/api/operations/assets/${imported.id}/history`, options)).tickets[0].id, work.id);
    const linkedTicket = (await request('/api/tickets', options)).tickets.find((ticket) => ticket.id === work.id);
    assert.equal(linkedTicket.asset_snapshot.assetTag, 'IMPORT-PUMP');
    await request(`/api/tickets/${work.id}/assignment`, { ...mmOptions, method: 'PUT', body: { assistantId: ma.user.id } });
    await request(`/api/tickets/${work.id}/status`, { ...workerOptions, method: 'PUT', body: { status: 'out_of_stock' } });
    assert.equal((await request(`/api/operations/assets/${imported.id}/history`, options)).tickets[0].status, 'out_of_stock');
    await post(`/api/operations/assets/${imported.id}/transfer`, { revision: history.asset.revision, propertyId: buildings[1].id, location: 'South plant room', reason: 'Moved equipment' }, { ...mmOptions, status: 403 });
    await post(`/api/operations/assets/${imported.id}/transfer`, { revision: history.asset.revision, propertyId: buildings[1].id, location: 'South plant room', reason: 'Moved equipment' }, { ...options });
    await request(`/api/operations/assets/${imported.id}/history`, { ...mmOptions, status: 404 });
    history = await request(`/api/operations/assets/${imported.id}/history`, options);
    assert.equal(history.asset.id, imported.id);
    assert(history.history.some((entry) => entry.kind === 'transfer' && entry.detail.fromBuilding === 'North' && entry.detail.toBuilding === 'South'));
    assert(history.history.some((entry) => entry.id === recordedInspection.id));
    assert.equal((await request('/api/tickets', options)).tickets.find((ticket) => ticket.id === work.id).property_id, buildings[0].id);
    const timeReading = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
    const energy = { meterReference: 'ENERGY-1', meterType: 'electricity', reading: 100.1, unit: 'kWh', readAt: timeReading(4) };
    const firstReading = (await post('/api/operations/meters', { propertyId: buildings[0].id, data: energy }, { ...workerOptions, status: 201 })).record;
    await post('/api/operations/meters', { propertyId: buildings[0].id, data: energy }, { ...workerOptions, status: 409 });
    await post('/api/operations/meters', { propertyId: buildings[0].id, data: { ...energy, readAt: timeReading(3), reading: 130.45 } }, { ...workerOptions, status: 201 });
    let readings = (await request('/api/operations/meters', options)).records.filter((row) => row.data.meterReference === 'ENERGY-1');
    assert.equal(readings.find((row) => row.data.reading === 130.45).consumption, 30.35);
    assert.equal(readings.find((row) => row.id === firstReading.id).consumption, null);
    await post('/api/operations/meters', { propertyId: buildings[0].id, data: { ...energy, readAt: timeReading(2), reading: 1 } }, { ...workerOptions, status: 400 });
    await post('/api/operations/meters', { propertyId: buildings[0].id, data: { ...energy, readAt: timeReading(2), reading: 1, reset: 'yes' } }, { ...workerOptions, status: 400 });
    await post('/api/operations/meters', { propertyId: buildings[0].id, data: { ...energy, readAt: timeReading(2), reading: 1, reset: 'yes', notes: 'Meter replaced' } }, { ...workerOptions, status: 201 });
    readings = (await request('/api/operations/meters', options)).records;
    assert.equal(readings.find((row) => row.data.meterReference === 'ENERGY-1' && row.data.reading === 1).consumption, null);
    await post('/api/operations/meters', { propertyId: buildings[0].id, data: { ...energy, readAt: timeReading(1), unit: 'MWh' } }, { ...workerOptions, status: 400 });
    await post('/api/operations/meters', { propertyId: buildings[0].id, data: { ...energy, readAt: new Date(Date.now() + 3600000).toISOString() } }, { ...workerOptions, status: 400 });
    const incidentData = { subject: 'Water leak', description: 'A leak needs inspection.', occurredAt: new Date().toISOString(), priority: 'normal' };
    const incident = (await post('/api/operations/incidents', { propertyId: buildings[0].id, data: incidentData }, { ...hostOptions, status: 201 })).record;
    await request(`/api/operations/incidents/${incident.id}`, { ...mmOptions, method: 'PUT', body: { revision: 1, status: 'investigating' } });
    const contractorData = { name: 'Plumbing Services', trade: 'Plumbing', contactPerson: 'Office', phone: '0123456789', startsOn: '2026-11-03', endsOn: '2026-11-10' };
    const contractor = (await post('/api/operations/contractors', { propertyId: buildings[0].id, data: contractorData }, { ...mmOptions, status: 201 })).record;
    await request(`/api/operations/contractors/${contractor.id}`, { ...mmOptions, method: 'PUT', body: { revision: 1, data: { ...contractorData, endsOn: '2026-11-12' } } });
    await request('/api/operations/contractors', { company: 'OPERATIONS', token: ma.token, status: 403 });
    await request(`/api/operations/assets/${asset.id}`, { company: 'BROLL', token: b, method: 'PUT', body: { revision: 3, status: 'retired' }, status: 403 });
    await request('/api/operations/security', { company: 'BROLL', token, status: 401 });
    settings = await request('/api/company-settings', { ...options, method: 'PUT', body: { ...settings, residentMode: 'tenants' } });
    const tenant = await account('automatic-tenant', 'user', [buildings[0].id]);
    assert.equal(tenant.user.resident_type, 'tenant');
    await request('/api/company-settings', { ...options, method: 'PUT', body: { ...settings, residentMode: 'both' } });
    if (process.env.CHROMIUM) {
      const { cdp, evaluate, waitFor, errors } = await require('./browser-test-helper.cjs').browserSession(t, process.env.CHROMIUM, ['--headless']);
      await cdp('Page.navigate', { url: base });
      await waitFor('document.querySelector("#auth-screen")?.hidden === false');
      await evaluate(`localStorage.setItem("primeops-company-code","OPERATIONS"); localStorage.setItem("primeops-token-OPERATIONS",${JSON.stringify(token)})`);
      await cdp('Page.reload');
      await waitFor('document.querySelector("#app-shell")?.hidden === false && !!document.querySelector("[data-home-view=residents]")');
      for (const id of operationIds) assert.equal(await evaluate(`document.querySelector('[data-view="${id}"]').hidden`), false);
      assert.equal(await evaluate('document.querySelector("[data-view=residents]").textContent.trim()'), 'Students / tenants');
      await evaluate('document.querySelector("[data-company-features]").click()');
      await waitFor('!!document.querySelector("[data-company-settings]")');
      await evaluate(`document.querySelector("[data-company-settings]").closest("details").open=true;
        document.querySelector("[data-company-settings] [name=residentMode]").value="tenants";
        document.querySelector("[data-company-settings]").requestSubmit()`);
      await waitFor('document.querySelector("[data-feature-status]")?.textContent==="Client settings saved." && document.querySelector("[data-view=residents]").textContent.trim()==="Tenants"');
      assert.equal(await evaluate('document.querySelector("[data-view=residents]").textContent.trim()'), 'Tenants');
      await evaluate(`document.querySelector("[data-company-settings]").closest("details").open=true;
        document.querySelector("[data-company-settings] [name=residentMode]").value="both";
        document.querySelector("[data-company-settings]").requestSubmit()`);
      await waitFor('document.querySelector("[data-view=residents]").textContent.trim()==="Students / tenants" && document.querySelector("[data-feature-status]")?.textContent==="Client settings saved."');
      await evaluate('document.querySelector("[data-close-features]").click()');
      await evaluate('document.querySelector("[data-home-view=security]").click()');
      await waitFor('!!document.querySelector("[data-operation=security] a[href^=\\"tel:\\"]")');
      assert.equal(await evaluate('document.querySelector("[data-operation=security] a").getAttribute("href")'), 'tel:+27123456789');
      await evaluate('document.querySelector("[data-view=residents]").click()');
      await waitFor('!!document.querySelector("[data-operation=residents]")');
      await evaluate(`document.querySelector("[data-section-tab=register]").click();
        document.querySelector("[data-operation-form] [name=propertyId]").value=${JSON.stringify(buildings[0].id)};
        document.querySelector("[data-operation-form] [name=visitorName]").value="Browser Visitor";
        document.querySelector("[data-operation-form] [name=expectedAt]").value="2026-11-04T10:00";
        document.querySelector("[data-operation-form] [name=purpose]").value="Visit office";
        document.querySelector("[data-operation-form]").requestSubmit()`);
      await waitFor('document.querySelector("[data-operation-status]")?.textContent.includes("Saved.") && !document.querySelector("[data-operation-form] button").disabled');
      await evaluate('document.querySelector("[data-section-tab=records]").click()');
      const browserVisit = (await request('/api/operations/residents', options)).records.find((row) => row.data.visitorName === 'Browser Visitor');
      await evaluate(`document.querySelector('[data-operation-record="${browserVisit.id}"] [data-operation-status-change=approved]').click()`);
      await waitFor('document.querySelector("[data-operation-status]")?.textContent==="Status updated."');
      assert.equal((await request('/api/operations/residents', options)).records.find((row) => row.id === browserVisit.id).status, 'approved');
      await evaluate('document.querySelector("[data-view=meters]").click()');
      await waitFor('!!document.querySelector("[data-operation=meters]")');
      await evaluate(`document.querySelector("[data-section-tab=register]").click();
        document.querySelector("[data-operation-form] [name=propertyId]").value=${JSON.stringify(buildings[0].id)};
        document.querySelector("[data-operation-form] [name=meterReference]").value="BROWSER-ZERO";
        document.querySelector("[data-operation-form] [name=reading]").value="0";
        document.querySelector("[data-operation-form] [name=unit]").value="kWh";
        document.querySelector("[data-operation-form] [name=readAt]").value="2026-11-03T10:00";
        (() => { const canvas=document.createElement('canvas');canvas.width=80;canvas.height=80;const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,80,80);ctx.fillStyle='black';ctx.fillText('0 kWh',5,40);
          const bytes=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0)), transfer=new DataTransfer();
          transfer.items.add(new File([bytes],'meter.png',{type:'image/png'}));document.querySelector('[name=meterPhoto]').files=transfer.files; })();
        document.querySelector("[data-operation-form]").requestSubmit()`);
      await waitFor('document.querySelector("[data-operation-status]")?.textContent.includes("Saved.")');
      assert.equal((await request('/api/operations/meters', options)).records.find((row) => row.data.meterReference === 'BROWSER-ZERO').data.reading, 0);
      const browserMeter = (await request('/api/operations/meters', options)).records.find((row) => row.data.meterReference === 'BROWSER-ZERO');
      assert.equal(browserMeter.photo_count, 1);
      assert.equal(browserMeter.data.photos, undefined);
      assert((await request(`/api/operations/meters/${browserMeter.id}/photos`, options)).photos[0].startsWith('data:image/jpeg;base64,'));
      await evaluate(`document.querySelector('[data-section-tab=records]').click();document.querySelector('[data-meter-photo="${browserMeter.id}"]').click()`);
      await waitFor('!!document.querySelector("[data-meter-photo-list] img") && !document.querySelector("[data-operation-report]").disabled');
      await evaluate('document.querySelector("[data-view=assets]").click()');
      await waitFor('!!document.querySelector("[data-read-assets]")');
      const importBook = new (require('exceljs').Workbook)();
      importBook.addWorksheet('Assets').addRows([['Asset tag', 'Asset name', 'Building', 'Manufacturer'],
        ['BROWSER-PUMP', 'Browser pump', 'North', 'Original brand'], ['BROWSER-GATE', 'Browser gate', 'South', 'Another brand']]);
      const importBuffer = Buffer.from(await importBook.xlsx.writeBuffer()).toString('base64');
      await evaluate(`(() => {const input=document.querySelector('[data-asset-file]'),transfer=new DataTransfer();
        input.closest('details').open=true;transfer.items.add(new File([Uint8Array.from(atob(${JSON.stringify(importBuffer)}),c=>c.charCodeAt(0))],'Assets.xlsx'));
        input.files=transfer.files;document.querySelector('[data-read-assets]').click();})()`);
      await waitFor('!!document.querySelector("[data-asset-map]") && !document.querySelector("[data-read-assets]").disabled');
      await evaluate('document.querySelector("[data-asset-map]").requestSubmit()');
      await waitFor('document.querySelectorAll("[data-import-row]").length===2 && !document.querySelector("[data-read-assets]").disabled');
      assert.equal(await evaluate('document.querySelector("[name=assetTag-0]").value'), 'BROWSER-PUMP');
      await evaluate('document.querySelector("[data-save-assets] [name=reviewed]").checked=true;document.querySelector("[data-save-assets]").requestSubmit()');
      await waitFor('document.querySelector("[data-operation-status]").textContent.includes("2 assets imported") && !document.querySelector("[data-operation-report]").disabled');
      const browserAsset = (await request('/api/operations/assets', options)).records.find((row) => row.data.assetTag === 'BROWSER-PUMP');
      assert.equal(browserAsset.asset_source.cells[3], 'Original brand');
      await evaluate(`document.querySelector('[data-open-asset="${browserAsset.id}"]').click()`);
      await waitFor('!!document.querySelector("[data-asset-activity]") && !document.querySelector("[data-operation-report]").disabled');
      await evaluate(`document.querySelector('[data-asset-checklist]').closest('details').open=true;
        document.querySelector('[data-asset-checklist-file]').dispatchEvent(new Event('focus'));`);
      await evaluate(`(() => { const canvas=document.createElement('canvas');canvas.width=1400;canvas.height=220;
        const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1400,220);ctx.fillStyle='black';ctx.font='36px Arial';
        ctx.fillText('Inspect pump casing',40,70);ctx.fillText('Check seals for leaks',40,150);
        const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0))],'Pump-checklist.png',{type:'image/png'}));
        const input=document.querySelector('[data-asset-checklist-file]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await waitFor('document.querySelector("[data-operation-status]").textContent.includes("Checklist extracted") && !document.querySelector("[data-operation-report]").disabled');
      assert((await evaluate('document.querySelector("[data-asset-checklist] [name=questions]").value')).toLowerCase().includes('pump'));
      await evaluate(`document.querySelector('[data-asset-checklist]').closest('details').open=true;document.querySelector('[data-asset-checklist]').requestSubmit()`);
      await waitFor('document.querySelector("[data-operation-status]").textContent.includes("Inspection checklist saved") && !!document.querySelector("[data-asset-activity]") && !document.querySelector("[data-operation-report]").disabled');
      await evaluate(`(() => {const form=document.querySelector('[data-asset-activity]');
        form.querySelectorAll('[name^=answer-]').forEach(input=>input.value='yes');form.elements.condition.value='poor';form.elements.notes.value='Seal needs repair';
        const canvas=document.createElement('canvas');canvas.width=80;canvas.height=80;canvas.getContext('2d').fillRect(0,0,80,80);
        const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0))],'pump.png',{type:'image/png'}));
        form.elements.photos.files=transfer.files;form.requestSubmit();})()`);
      await waitFor('document.querySelector("[data-operation-status]").textContent.includes("Work saved") && !!document.querySelector("[data-asset-activity]") && !document.querySelector("[data-operation-report]").disabled');
      let browserHistory = await request(`/api/operations/assets/${browserAsset.id}/history`, options);
      assert.equal(browserHistory.history.find((entry) => entry.kind === 'inspection').detail.photos.length, 1);
      assert.equal(browserHistory.asset.data.condition, 'poor');
      await evaluate(`(() => {const form=document.querySelector('[data-asset-ticket]');form.closest('details').open=true;
        form.elements.activityId.selectedIndex=1;form.elements.description.value='Inspection found a leaking seal';form.requestSubmit();})()`);
      await waitFor('document.querySelector("[data-operation-status]").textContent.includes("Maintenance ticket created") && !!document.querySelector("[data-asset-activity]") && !document.querySelector("[data-operation-report]").disabled');
      browserHistory = await request(`/api/operations/assets/${browserAsset.id}/history`, options);
      assert.equal(browserHistory.tickets.length, 1);
      assert(browserHistory.tickets[0].activityId);
      await evaluate(`(() => {const form=document.querySelector('[data-asset-transfer]');form.closest('details').open=true;
        form.elements.propertyId.value=${JSON.stringify(buildings[1].id)};form.elements.location.value='South pump room';form.elements.reason.value='Equipment moved';form.requestSubmit();})()`);
      await waitFor('document.querySelector("[data-operation-status]").textContent.includes("Asset transferred") && !!document.querySelector("[data-asset-activity]") && !document.querySelector("[data-operation-report]").disabled');
      assert.equal((await request(`/api/operations/assets/${browserAsset.id}/history`, options)).asset.property_id, buildings[1].id);
      await evaluate('document.querySelector("[data-view=tickets]").click()');
      await waitFor('!!document.querySelector("[data-ticket-thread]")');
      assert((await evaluate(`document.querySelector('[data-ticket-thread="${browserHistory.tickets[0].id}"]').textContent`)).includes('BROWSER-PUMP'));
      await evaluate('document.querySelector("[data-view=assets]").click()');
      await waitFor('!!document.querySelector("[data-operation=assets]")');
      await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), true);
      await cdp('Emulation.clearDeviceMetricsOverride');
      await evaluate('document.querySelector("#signout-button").click()');
      await waitFor('document.querySelector("#auth-screen")?.hidden === false');
      await evaluate(`document.querySelector("#login-form [name=email]").value="resident-host"; document.querySelector("#login-form [name=password]").value="operation-password-123"; document.querySelector("#login-form").requestSubmit()`);
      await waitFor('document.querySelector("#app-shell")?.hidden === false && !!document.querySelector("[data-home-view=residents]")');
      await evaluate('document.querySelector("[data-home-view=residents]").click()');
      await waitFor('!!document.querySelector("[data-operation-form]")');
      assert.equal(await evaluate('document.querySelector("[data-operation-form] [name=propertyId]").options.length'), 1);
      assert.equal(await evaluate('document.querySelectorAll("[data-operation-status-change=approved]").length'), 0);
      await evaluate('document.querySelector("#signout-button").click()');
      await waitFor('document.querySelector("#auth-screen")?.hidden === false');
      await evaluate(`document.querySelector("#login-form [name=email]").value="resident-neighbour"; document.querySelector("#login-form [name=password]").value="operation-password-123"; document.querySelector("#login-form").requestSubmit()`);
      await waitFor('document.querySelector("#app-shell")?.hidden === false && !!document.querySelector("[data-home-view=residents]")');
      await evaluate('document.querySelector("[data-home-view=residents]").click()');
      await waitFor('!!document.querySelector("[data-operation-form]")');
      assert.equal(await evaluate('document.querySelector("[data-operation-form] [name=propertyId]").value'), buildings[0].id);
      assert.equal(await evaluate('document.querySelector("[data-operation-form] [name=propertyId]").options.length'), 1);
      assert.deepEqual(errors, []);
    }
  });
  if (process.env.CHROMIUM) {
    await t.test('client user creation gives visible validation and imports real checklist files into saved tables', async (t) => {
      await post(`${ownerPath}/companies`, { code: 'FILES', name: 'Files and Accounts Test', ...adminCredentials }, { token: owner, status: 201 });
      const token = (await post('/api/auth/login', { email: adminCredentials.adminUsername, password: adminCredentials.adminPassword }, { company: 'FILES' })).token;
      const options = { company: 'FILES', token };
      await activateFeatures('FILES', token, ['checks', 'tickets']);
      const properties = [];
      for (const name of ['East Building', 'West Building']) properties.push((await post('/api/properties', { name }, { ...options, status: 201 })).property);
      const { cdp, evaluate, waitFor, errors } = await require('./browser-test-helper.cjs').browserSession(t, process.env.CHROMIUM, ['--headless']);
      await cdp('Page.navigate', { url: base });
      await waitFor('document.querySelector("#auth-screen")?.hidden === false');
      await evaluate(`localStorage.setItem("primeops-company-code","FILES"); localStorage.setItem("primeops-token-FILES",${JSON.stringify(token)})`);
      await cdp('Page.reload');
      await waitFor('document.querySelector("#app-shell")?.hidden === false && !!document.querySelector("[data-home-view=users]")');
      await evaluate('document.querySelector("[data-home-view=users]").click()');
      await waitFor('document.querySelectorAll("#create-user-form [name=propertyIds]").length===2');
      await evaluate('document.querySelector("#users-tab-create").click(); document.querySelector("#create-user-form").requestSubmit()');
      await waitFor('document.querySelector("#user-management-status").textContent.includes("Name:")');
      await evaluate(`(() => { const form=document.querySelector("#create-user-form");
        form.elements.name.value="New tenant"; form.elements.email.value="new-resident";
        form.elements.password.value="resident-password"; form.elements.unitNumber.value="E-12"; form.requestSubmit(); })()`);
      await waitFor('document.querySelector("#user-management-status").textContent.includes("Choose at least one assigned building")');
      assert.equal(await evaluate('document.querySelector("#create-user-panel-access").hidden'), false);
      assert.equal(await evaluate('document.querySelectorAll("#create-user-form [name=propertyIds][type=radio]").length'), 2);
      await evaluate(`document.querySelector("#create-user-form [name=propertyIds]").checked=true; document.querySelector("#create-user-form").requestSubmit()`);
      await waitFor('document.querySelector("#user-management-status").textContent.includes("Account created.") && !document.querySelector("#create-user-form [type=submit]").disabled');
      const user = (await request('/api/users', options)).users.find((account) => account.email === 'new-resident');
      assert.deepEqual(user.property_ids, [properties[0].id]);
      await post('/api/auth/login', { email: 'new-resident', password: 'resident-password' }, { company: 'FILES' });
      await evaluate(`(() => {
        const form=[...document.querySelectorAll(".managed-user-form")].find(form=>form.elements.email.value==="new-resident");
        form.closest("details").open=true;
        form.elements.name.value="Renamed resident"; form.requestSubmit();
      })()`);
      await waitFor('document.querySelector("#user-management-status").textContent==="Account updated." && document.querySelector("#user-list").textContent.includes("Renamed resident")');
      const renamed = (await request('/api/users', options)).users.find((account) => account.id === user.id);
      assert.equal(renamed.name, 'Renamed resident');
      assert.equal(renamed.email, user.email);
      assert.deepEqual(renamed.property_ids, user.property_ids);
      const renamedLogin = await post('/api/auth/login', { email: 'new-resident', password: 'resident-password' }, { company: 'FILES' });
      assert.equal(renamedLogin.user.name, 'Renamed resident');
      await evaluate(`document.querySelector("#users-tab-create").click();
        const form=document.querySelector("#create-user-form"); form.elements.role.value="maintenance_assistant";
        form.elements.role.dispatchEvent(new Event("change",{bubbles:true}));
        form.elements.name.value="New worker"; form.elements.email.value="new-worker"; form.elements.password.value="worker-password";
        form.querySelectorAll("[name=propertyIds]").forEach(input=>input.checked=true); form.requestSubmit()`);
      await waitFor('document.querySelector("#user-management-status").textContent.includes("Account created.") && [...document.querySelectorAll(".managed-user-form")].some(form=>form.elements.email.value==="new-worker")');
      assert.equal((await request('/api/users', options)).users.find((account) => account.email === 'new-worker').unit_number, '');
      assert.deepEqual((await request('/api/users', options)).users.find((account) => account.email === 'new-worker').property_ids.sort(), properties.map((property) => property.id).sort());
      await evaluate('document.querySelector("[data-view=checks]").click()');
      await waitFor('!!document.querySelector("[data-manage-checklists]")');
      const workbook = new (require('exceljs').Workbook)();
      workbook.addWorksheet('Checklist').addRows([['Question', 'Location', 'Result'], ['Inspect safety lighting', 'Entrance', ''], ['Check escape doors', 'Hall', '']]);
      const zip = new (require('jszip'))();
      zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl>${[['Question', 'Location'], ['Inspect safety lighting', 'Entrance'], ['Check escape doors', 'Hall']].map((row) => `<w:tr>${row.map((cell) => `<w:tc><w:p><w:r><w:t>${cell}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('')}</w:tbl></w:body></w:document>`);
      const stream = 'BT /F1 12 Tf 50 740 Td (Question) Tj 300 0 Td (Location) Tj ET\nBT /F1 12 Tf 50 710 Td (Inspect safety lighting) Tj 300 0 Td (Entrance) Tj ET\nBT /F1 12 Tf 50 680 Td (Check escape doors) Tj 300 0 Td (Hall) Tj ET';
      const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
        `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
      let pdf = '%PDF-1.4\n'; const offsets = [0];
      objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
      const xref = Buffer.byteLength(pdf);
      pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
      const fixtures = [
        ['csv', Buffer.from('Question,Location,Result\nInspect safety lighting,Entrance,\nCheck escape doors,Hall,\n')],
        ['xlsx', Buffer.from(await workbook.xlsx.writeBuffer())],
        ['docx', await zip.generateAsync({ type: 'nodebuffer' })],
        ['pdf', Buffer.from(pdf)],
        ['txt', Buffer.from('Inspect safety lighting\nCheck escape doors')],
        ['json', Buffer.from(JSON.stringify({ title: 'JSON fixture', questions: [{ label: 'Inspect safety lighting', type: 'yes-no-na', photo: false }, { label: 'Check escape doors', type: 'text', photo: false }] }))]
      ];
      for (const [extension, buffer] of fixtures) {
        await evaluate('document.querySelector("[data-manage-checklists]").click()');
        await evaluate(`(() => { const input=document.querySelector("[data-import-template]"), transfer=new DataTransfer();
          transfer.items.add(new File([Uint8Array.from(atob(${JSON.stringify(buffer.toString('base64'))}), c=>c.charCodeAt(0))], "Fixture.${extension}"));
          input.files=transfer.files; input.dispatchEvent(new Event("change",{bubbles:true})); })()`);
        await waitFor('document.querySelector("[data-template-status]").textContent.includes("Created 2 editable questions")');
        assert.equal(await evaluate('document.querySelectorAll(".template-editor-question").length'), 2);
        if (['csv', 'xlsx', 'docx', 'pdf'].includes(extension)) assert((await evaluate('document.querySelector("[data-template-source]").textContent')).includes('Imported spreadsheet preview'));
        if (extension === 'csv') {
          await evaluate(`const cell=document.querySelector('[data-source-row="0"][data-source-cell="1"]'); cell.value="Edited entrance"; cell.dispatchEvent(new Event("input",{bubbles:true}))`);
        }
        await evaluate(`document.querySelector("#checklist-template-form [name=title]").value="Imported ${extension}";
          document.querySelectorAll("#checklist-template-form [name=propertyIds]").forEach(input=>input.checked=true);
          document.querySelector("#checklist-template-form").requestSubmit()`);
        await waitFor('!document.querySelector("#checklist-template-dialog").open');
        const saved = (await request('/api/check-templates', options)).templates.find((template) => template.title === `Imported ${extension}`);
        assert.equal(saved.questions.length, 2);
        if (extension === 'csv') {
          assert.deepEqual(saved.sourceColumns, ['Question', 'Location', 'Result']);
          assert.deepEqual(saved.questions[0].sourceCells, ['Inspect safety lighting', 'Edited entrance', '']);
        }
        if (['xlsx', 'docx', 'pdf'].includes(extension)) assert.equal(saved.questions[0].sourceCells[1], 'Entrance');
      }
      await evaluate('document.querySelector("[data-manage-checklists]").click()');
      await evaluate(`(async () => {
        const canvas=document.createElement("canvas"); canvas.width=1400; canvas.height=300;
        const context=canvas.getContext("2d"); context.fillStyle="white"; context.fillRect(0,0,1400,300);
        context.fillStyle="black"; context.font="40px Arial"; context.fillText("Inspect safety lighting",40,90); context.fillText("Check escape doors",40,180);
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png")), transfer=new DataTransfer();
        transfer.items.add(new File([blob],"Scanned-checklist.png",{type:"image/png"}));
        const input=document.querySelector("[data-import-template]"); input.files=transfer.files; input.dispatchEvent(new Event("change",{bubbles:true}));
      })()`);
      await waitFor('document.querySelector("[data-template-status]").textContent.includes("Created 2 editable questions")');
      assert.match(await evaluate('document.querySelector("[data-question-label]").value'), /safety lighting/i);
      await evaluate('document.querySelector("[data-close-templates]").click()');
      const csvTemplate = (await request('/api/check-templates', options)).templates.find((template) => template.title === 'Imported csv');
      await evaluate(`document.querySelector('[data-action="select-property"][data-property-id="${properties[0].id}"]').click();
        document.querySelector('[data-action="start-property-template"][data-template-id="${csvTemplate.id}"]').click()`);
      await waitFor('!!document.querySelector("#monthly-template-form .import-sheet")');
      assert.deepEqual(await evaluate('[...document.querySelectorAll("#monthly-template-form .import-sheet th")].map(cell=>cell.textContent)'), ['Question', 'Location', 'Result', 'Checklist answer / evidence']);
      assert((await evaluate('document.querySelector("#monthly-template-form .import-sheet").textContent')).includes('Edited entrance'));
      const storedRun = (await request('/api/workspace', options)).data.buildingChecks.find((project) => project.templateId === csvTemplate.id);
      assert.deepEqual(storedRun.sourceColumns, csvTemplate.sourceColumns);
      assert.deepEqual(storedRun.checks[0].sourceCells, csvTemplate.questions[0].sourceCells);
      assert.deepEqual(errors, []);
    });
    await t.test('locked browser licence dialog stays visible and interactive through activation and renewal', async (t) => {
      const databaseClient = new Client({ connectionString: url.href });
      await databaseClient.connect();
      const original = await request('/api/license', { company: 'BROLL' });
      try {
        const { rows } = await databaseClient.query("SELECT schema_name FROM companies WHERE code='BROLL'");
        const schema = rows[0].schema_name;
        await databaseClient.query(`UPDATE "${schema}".system_licence SET token=NULL`);
        const { cdp, evaluate, waitFor, errors } = await require('./browser-test-helper.cjs').browserSession(t, process.env.CHROMIUM, ['--headless']);
        async function click(selector) {
          const point = await evaluate(`(() => {
            const element=document.querySelector(${JSON.stringify(selector)});
            element.scrollIntoView({block:'center'});
            const rect=element.getBoundingClientRect();
            return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
          })()`);
          await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
          await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
        }
        await cdp('Page.navigate', { url: base });
        await waitFor('document.querySelector("#auth-screen").hidden===false');
        await evaluate("localStorage.setItem('primeops-company-code','BROLL')");
        await cdp('Page.reload');
        await waitFor('!document.querySelector("#auth-screen").hidden && document.querySelector("#licence-renewal-options").hidden===false');
        await click('#auth-screen [data-open-licence]');
        await waitFor('document.querySelector("#licence-dialog").open && document.querySelector("#licence-dialog").checkVisibility()');
        assert.equal(await evaluate('document.querySelector("#licence-dialog").closest("[hidden]")'), null);
        await click('#licence-renewal-form [name=username]');
        await cdp('Input.insertText', { text: adminCredentials.adminUsername });
        assert.equal(await evaluate('document.querySelector("#licence-renewal-form [name=username]").value'), adminCredentials.adminUsername);
        await evaluate("document.querySelector('#licence-renewal-form [name=password]').value='wrong-password'");
        await click('#licence-renewal-form [value=request]');
        await waitFor('document.querySelector("#licence-status").textContent.includes("active MM or administrator") && !document.querySelector("#licence-renewal-form [value=request]").disabled');
        await evaluate(`document.querySelector('#licence-renewal-form [name=password]').value=${JSON.stringify(adminCredentials.adminPassword)}`);
        await click('#licence-renewal-form [value=request]');
        await waitFor('document.querySelector("#licence-status").textContent==="Renewal requested."');
        assert.equal(await evaluate('document.querySelector("#licence-dialog").checkVisibility()'), true);
        await click('#licence-close');
        await waitFor('!document.querySelector("#licence-dialog").open');
        await click('#auth-screen [data-open-licence]');
        await click('#licence-dialog details summary');
        await evaluate("document.querySelector('#licence-form [name=token]').value='invalid-token'");
        await click('#licence-form [type=submit]');
        await waitFor('document.querySelector("#licence-status").textContent.includes("valid signed licence token") && !document.querySelector("#licence-form [type=submit]").disabled');
        await evaluate(`document.querySelector('#licence-form [name=token]').value=${JSON.stringify(original.token)}`);
        await click('#licence-form [type=submit]');
        await waitFor('!document.querySelector("#licence-dialog").open && !document.querySelector("#auth-screen").hidden && document.querySelector("#licence-screen").hidden');
        await request(`${ownerPath}/settings`, { token: owner, method: 'PUT', body: { companyCode: 'BROLL', testRenewalEnabled: true } });
        await databaseClient.query(`UPDATE "${schema}".system_licence SET token=NULL`);
        await cdp('Page.reload');
        await waitFor('!document.querySelector("#auth-screen").hidden && document.querySelector("#licence-renewal-options").hidden===false');
        await click('#auth-screen [data-open-licence]');
        await evaluate(`document.querySelector('#licence-renewal-form [name=username]').value=${JSON.stringify(adminCredentials.adminUsername)};
          document.querySelector('#licence-renewal-form [name=password]').value=${JSON.stringify(adminCredentials.adminPassword)}`);
        await click('#licence-test-renew');
        await waitFor('!document.querySelector("#licence-dialog").open && !document.querySelector("#auth-screen").hidden && document.querySelector("#licence-screen").hidden');
        assert.equal((await request('/api/license', { company: 'BROLL' })).state, 'active');
        assert.deepEqual(errors, []);
      } finally {
        const { rows } = await databaseClient.query("SELECT schema_name FROM companies WHERE code='BROLL'");
        await databaseClient.query(`UPDATE "${rows[0].schema_name}".system_licence SET token=$1`, [original.token]);
        await databaseClient.query("UPDATE companies SET test_renewal_enabled=FALSE WHERE code='BROLL'");
        await databaseClient.end();
      }
    });
    await t.test('legacy device database and settings migrate without losing the original queued data', async (t) => {
      const { cdp, evaluate, waitFor } = await require('./browser-test-helper.cjs').browserSession(t, process.env.CHROMIUM, ['--headless']);
      await cdp('Page.navigate', { url: base });
      await waitFor('!document.querySelector("#auth-screen").hidden');
      const legacy = require('../www/legacy-identifiers.json');
      const fixture = { jobs: [{ id: 'preserved-job', state: 'pending', body: { name: 'Pending offline record' } }], photos: { one: 'data:image/jpeg;base64,abc' } };
      await evaluate(`(async () => {
        localStorage.setItem(${JSON.stringify(legacy.companyCodeKey)},'AFRICREST');
        localStorage.setItem(${JSON.stringify(legacy.storagePrefix + '-theme')},'light');
        await new Promise((resolve,reject)=>{
          const request=indexedDB.open(${JSON.stringify(legacy.storagePrefix + '-AFRICREST')},1);
          request.onupgradeneeded=()=>request.result.createObjectStore('workspace');
          request.onerror=()=>reject(request.error);
          request.onsuccess=()=>{
            const db=request.result, transaction=db.transaction('workspace','readwrite');
            transaction.objectStore('workspace').put(${JSON.stringify(fixture)},'preserved-offline-data');
            transaction.oncomplete=()=>{db.close();resolve();};
            transaction.onerror=()=>reject(transaction.error);
          };
        });
      })()`);
      await cdp('Page.reload');
      await waitFor('!document.querySelector("#auth-screen").hidden && localStorage.getItem("primeops-company-code")==="AFRICREST"');
      const read = (name) => evaluate(`new Promise((resolve,reject)=>{
        const request=indexedDB.open(${JSON.stringify(name)});
        request.onsuccess=()=>{const db=request.result, read=db.transaction('workspace','readonly').objectStore('workspace').get('preserved-offline-data');
          read.onsuccess=()=>{db.close();resolve(read.result);};read.onerror=()=>reject(read.error);};
        request.onerror=()=>reject(request.error);
      })`);
      assert.deepEqual(await read('primeops-AFRICREST'), fixture);
      assert.deepEqual(await read(`${legacy.storagePrefix}-AFRICREST`), fixture);
      assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
    });
    await t.test('company sign-in, custom checklist builder/import and offline company switching', async (t) => {
      const { cdp, evaluate, waitFor, errors } = await require('./browser-test-helper.cjs').browserSession(t, process.env.CHROMIUM, ['--headless']);
      await cdp('Page.navigate', { url: base });
      await waitFor('document.querySelector("#auth-screen")?.hidden===false');
      await evaluate(`(() => {
        localStorage.setItem('primeops-company-code','AFRICREST');
        localStorage.setItem('primeops-token-AFRICREST',${JSON.stringify(a)});
      })()`);
      await cdp('Page.reload');
      await waitFor('document.querySelector("#app-shell")?.hidden === false');
      await evaluate('document.querySelector("[data-subscribe]").click()');
      await waitFor('!!document.querySelector("[data-request-plan=building-managers]")');
      const plans = await evaluate('document.querySelector("#subscription-dialog").textContent');
      assert(plans.includes('5-10 users') && plans.includes('11-20 users') && plans.includes('Unlimited users'));
      await evaluate('document.querySelector("[data-request-plan=building-managers]").click()');
      await waitFor('document.querySelector("#subscription-dialog").textContent.includes("awaiting owner approval")');
      assert.equal((await request('/api/subscription', { company: 'AFRICREST', token: a })).plan, 'basic');
      await evaluate('document.querySelector("[data-close-subscription]").click()');
      await evaluate('document.querySelector(\'[data-view="checks"]\').click()');
      assert(!(await evaluate('document.querySelector("#workspace").textContent')).includes('Hatfield Studios'));
      assert((await evaluate('document.querySelector("#workspace").textContent')).includes('Africrest Only Building'));
      await evaluate('document.querySelector("[data-manage-checklists]").click()');
      await waitFor('document.querySelector("#checklist-template-dialog").open');
      await evaluate(`(() => {
        const form=document.querySelector('#checklist-template-form');
        form.elements.title.value='Browser created checklist';
        form.elements.companyWide.checked=true;
        form.querySelector('[data-question-label]').value='Check emergency lights';
        form.querySelector('[data-question-type]').value='yes-no-na';
        form.requestSubmit();
      })()`);
      await waitFor('!document.querySelector("#checklist-template-dialog").open');
      await evaluate(`document.querySelector('[data-action="select-property"]').click()`);
      await waitFor('document.querySelector("#workspace").textContent.includes("Browser created checklist")');
      const createdTemplate = (await request('/api/check-templates', { company: 'AFRICREST', token: a })).templates.find((item) => item.title === 'Browser created checklist');
      await evaluate(`document.querySelector('[data-template-id="${createdTemplate.id}"]').click()`);
      await waitFor('!!document.querySelector("#monthly-template-form")');
      assert((await evaluate('document.querySelector("#monthly-template-form").textContent')).includes('Check emergency lights'));
      await evaluate(`document.querySelector('[data-action="property-checklists"]').click(); document.querySelector('[data-manage-checklists]').click()`);
      await evaluate(`(() => {
        const data={title:'Imported private checklist',questions:[{label:'Imported water check',type:'text',photo:false}]};
        const transfer=new DataTransfer();
        transfer.items.add(new File([JSON.stringify(data)],'private-check.json',{type:'application/json'}));
        const input=document.querySelector('[data-import-template]');
        input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
      })()`);
      await waitFor('document.querySelector("#checklist-template-form [name=title]").value==="Imported private checklist"');
      await evaluate(`document.querySelector('#checklist-template-form [name=companyWide]').checked=true;
        document.querySelector('#checklist-template-form').requestSubmit()`);
      await waitFor('!document.querySelector("#checklist-template-dialog").open');
      assert((await request('/api/check-templates', { company: 'AFRICREST', token: a })).templates.some((item) => item.title === 'Imported private checklist'));
      const workbook = new (require('exceljs').Workbook)();
      const sheet = workbook.addWorksheet('Checklist');
      sheet.addRows([['Question', 'Type', 'Photo'], ['Excel fire door check', 'yes-no-na', 'yes']]);
      const excel = Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64');
      await evaluate(`document.querySelector('[data-manage-checklists]').click();
        (() => {
          const transfer=new DataTransfer();
          transfer.items.add(new File([Uint8Array.from(atob(${JSON.stringify(excel)}),c=>c.charCodeAt(0))],
            'Fire checks.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
          const input=document.querySelector('[data-import-template]');
          input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
        })()`);
      await waitFor('document.querySelector("#checklist-template-form [name=title]").value==="Fire checks"');
      assert.equal(await evaluate('document.querySelector("[data-question-photo]").checked'), true);
      await evaluate(`document.querySelector('#checklist-template-form [name=companyWide]').checked=true;
        document.querySelector('#checklist-template-form').requestSubmit()`);
      await waitFor('!document.querySelector("#checklist-template-dialog").open');
      assert((await request('/api/check-templates', { company: 'AFRICREST', token: a })).templates.some((item) =>
        item.title === 'Fire checks' && item.questions[0].label === 'Excel fire door check'));
      await request(`/api/check-templates/${createdTemplate.id}/archive`, { company: 'AFRICREST', token: a, method: 'PUT', body: {} });
      await cdp('Page.reload');
      await waitFor('document.querySelector("#app-shell")?.hidden === false');
      await evaluate('document.querySelector(\'[data-view="checks"]\').click()');
      await evaluate(`document.querySelector('[data-action="select-property"]').click()`);
      await waitFor('document.querySelector("#workspace").textContent.includes("Browser created checklist")');
      assert.equal(await evaluate(`!!document.querySelector('[data-template-id="${createdTemplate.id}"]')`), false);
      await evaluate(`document.querySelector('[data-action="open-check-project"]').click()`);
      await waitFor('!!document.querySelector("#monthly-template-form")');
      assert((await evaluate('document.querySelector("#monthly-template-form").textContent')).includes('Check emergency lights'));
      assert.deepEqual((await request('/api/check-templates', { company: 'BROLL', token: b })).templates, []);
      await cdp('Network.enable');
      await cdp('Network.setBlockedURLs', { urls: [`${base}/c/AFRICREST/api/*`] });
      await cdp('Page.reload', { ignoreCache: false });
      await waitFor('document.querySelector("#app-shell")?.hidden===false');
      await evaluate('document.querySelector(\'[data-view="checks"]\').click()');
      assert((await evaluate('document.querySelector("#workspace").textContent')).includes('Africrest Only Building'));
      await cdp('Network.setBlockedURLs', { urls: [] });
      await evaluate(`localStorage.setItem('primeops-company-code','BROLL');
        localStorage.setItem('primeops-token-BROLL',${JSON.stringify(b)})`);
      await cdp('Page.reload');
      await waitFor('!document.querySelector("#app-shell").hidden');
      await evaluate('document.querySelector(\'[data-view="checks"]\').click()');
      const blank = await evaluate('document.querySelector("#workspace").textContent');
      assert(blank.includes('No buildings yet'));
      assert(!blank.includes('Africrest') && !blank.includes('Hatfield'));
      const featureUser = (await post('/api/auth/login', { email: 'same-admin', password: adminCredentials.adminPassword }, { company: 'EXPIRED' })).token;
      await evaluate(`localStorage.setItem('primeops-company-code','EXPIRED');
        localStorage.setItem('primeops-token-EXPIRED',${JSON.stringify(featureUser)})`);
      await cdp('Page.reload');
      await waitFor('document.querySelector("#app-shell")?.hidden === false');
      assert.equal(await evaluate('document.querySelector(".module-nav [data-view=appliances]").hidden'), true);
      await evaluate('document.querySelector("[data-company-features]").click()');
      await waitFor('!!document.querySelector("[data-feature-form]")');
      await evaluate('document.querySelector("[name=features][value=billing]").checked=true; document.querySelector("[data-feature-form]").dispatchEvent(new Event("change",{bubbles:true}))');
      assert((await evaluate('document.querySelector("[data-feature-total]").textContent')).includes('R100'));
      await evaluate('document.querySelector("[data-feature-form]").requestSubmit()');
      await waitFor('document.querySelector("#company-features-dialog").textContent.includes("Awaiting approval")');
      assert.equal((await request('/api/company-features', { company: 'EXPIRED', token: featureUser })).requests[0].feeCents, 10000);
      assert.deepEqual(errors, []);
    });
  }
  if (process.env.CHROMIUM) {
    await t.test('browser platform owner manages clients and team in the PrimeOps theme', async (t) => {
      const databaseClient = new Client({ connectionString: url.href });
      await databaseClient.connect();
      const original = await request('/api/license');
      try {
        await databaseClient.query('UPDATE system_licence SET token=NULL WHERE id=1');
        const { cdp, evaluate, waitFor, errors } = await require('./browser-test-helper.cjs').browserSession(t, process.env.CHROMIUM, ['--headless']);
        await cdp('Page.navigate', { url: `${adminBase}/admin/` });
        await waitFor('document.querySelector("#login-section")?.hidden === false && !document.querySelector("#login button").disabled');
        assert.equal(await evaluate('document.querySelector("#connect").hidden'), true);
        assert.equal(await evaluate('document.querySelector("h1").textContent'), 'PrimeOps Administration');
        await evaluate(`document.querySelector('#login [name=username]').value='owner';
          document.querySelector('#login [name=password]').value='wrong-password';
          document.querySelector('#login').requestSubmit()`);
        await waitFor('document.querySelector("#status").textContent.includes("username or password is incorrect") && !document.querySelector("#login button").disabled');
        await evaluate(`document.querySelector('#login [name=password]').value='owner-password-123';
          document.querySelector('#login').requestSubmit()`);
        await waitFor('!document.querySelector("#dashboard").hidden && !document.querySelector("#home-button").disabled');
        assert.equal(await evaluate('document.querySelector("#home").hidden'), false);
        assert.equal(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim()'), '#070618');
        assert.equal(await evaluate('document.querySelector("[data-tab=staff]").hidden'), false);
        assert((await evaluate('document.querySelector("#platform-identity").textContent')).includes('PrimeOps owner: Platform Founder'));
        assert(!(await evaluate('document.querySelector("body").innerText')).includes('Owner (client)'));
        await evaluate('document.querySelector("#theme-toggle").click()');
        assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
        await evaluate('document.querySelector("#theme-toggle").click()');
        await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
        await cdp('Emulation.clearDeviceMetricsOverride');
        assert.equal(await evaluate('document.querySelector("#company")'), null);
        assert.equal(await evaluate('document.querySelector("#client-context").hidden'), true);
        assert.equal(await evaluate('document.querySelector("#client-navigation").hidden'), true);
        const platformData = await request(`${ownerPath}/dashboard?scope=platform`, { token: owner });
        assert.equal(platformData.licence, undefined);
        assert.equal(platformData.companyCode, undefined);
        await evaluate('document.querySelector("[data-tab=licensing]").click()');
        assert.equal(await evaluate('document.querySelector("#home").hidden'), false);
        await evaluate(`document.querySelector('[data-tab=new-company]').click();
          document.querySelector('#company-form [name=name]').value='Browser Client Owner';
          document.querySelector('#company-form [name=code]').value='WEB-OWNER';
          document.querySelector('#company-form [name=adminUsername]').value='client-owner';
          document.querySelector('#company-form [name=adminPassword]').value='client-owner-password-123';
          document.querySelector('#company-form').requestSubmit()`);
        await waitFor('!document.querySelector("#clients").hidden && !!document.querySelector("[data-open-client=WEB-OWNER]") && !document.querySelector("#home-button").disabled');
        assert.equal(await evaluate('document.querySelector("#client-context").hidden'), true);
        await evaluate('document.querySelector("[data-open-client=WEB-OWNER]").click()');
        await waitFor('document.querySelector("#company-code").textContent==="WEB-OWNER" && !document.querySelector("#issue").disabled');
        assert.equal(await evaluate('document.querySelector("#client-context").hidden'), false);
        assert.equal(await evaluate('document.querySelector("#open-client-name").textContent'), 'Browser Client Owner');
        const registered = await request('/api/license', { company: 'WEB-OWNER' });
        assert.equal(registered.state, 'active');
        const clientOwner = (await post('/api/auth/login', { email: 'client-owner', password: 'client-owner-password-123' }, { company: 'WEB-OWNER' })).token;
        await request(`${ownerPath}/dashboard`, { token: clientOwner, status: 401 });
        await post(`${ownerPath}/companies`, { code: 'UNAUTHORISED', name: 'Must not create', ...adminCredentials }, { token: clientOwner, status: 401 });
        await evaluate('document.querySelector("#issue").click()');
        await waitFor('document.querySelector("#status").textContent.includes("Annual licence activated") && !document.querySelector("#issue").disabled');
        const renewed = await request('/api/license', { company: 'WEB-OWNER' });
        assert.equal(verifyToken(renewed.token, publicKey).termStart, verifyToken(registered.token, publicKey).expiresAt);
        assert.equal(await evaluate('document.querySelector("#client-access-form [name=startsAt]").value'),
          verifyToken(renewed.token, publicKey).issuedAt.slice(0, 19));
        const manualStart = new Date(Date.now() - 86400000).toISOString().slice(0, 19);
        const manualEnd = new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 19);
        await evaluate(`document.querySelector("#client-access-form").closest("details").open=true;
          document.querySelector("#client-access-form [name=active]").checked=false;
          document.querySelector("#client-access-form [name=startsAt]").value=${JSON.stringify(manualStart)};
          document.querySelector("#client-access-form [name=expiresAt]").value=${JSON.stringify(manualEnd)};
          document.querySelector("#client-access-form [name=reason]").value="Manual browser status/date test";
          document.querySelector("#client-access-form").requestSubmit()`);
        await waitFor('document.querySelector("#licence-state").textContent==="inactive" && !document.querySelector("#issue").disabled');
        const custom = verifyToken((await request('/api/license', { company: 'WEB-OWNER' })).token, publicKey);
        assert.equal(custom.termStart, `${manualStart}.000Z`);
        assert.equal(custom.expiresAt, `${manualEnd}.000Z`);
        assert.equal(await evaluate('document.querySelector("#client-access-form [name=expiresAt]").value'), manualEnd);
        await evaluate(`document.querySelector("#client-access-form [name=active]").checked=true;
          document.querySelector("#client-access-form [name=reason]").value="Reactivate browser test client";
          document.querySelector("#client-access-form").requestSubmit()`);
        await waitFor('document.querySelector("#licence-state").textContent==="active" && !document.querySelector("#issue").disabled');
        await evaluate(`document.querySelector('[data-tab=content]').click();
          document.querySelector('#building-form [name=name]').value='Browser Owner Building';
          document.querySelector('#building-form [name=city]').value='Pretoria';
          document.querySelector('#building-form').requestSubmit()`);
        await waitFor('document.querySelector("#buildings").textContent.includes("Browser Owner Building") && !document.querySelector("#add-question").disabled');
        await evaluate(`document.querySelector('#owner-checklist-form [name=title]').value='Browser Owner Checklist';
          document.querySelector('#questions [data-label]').value='Client building check';
          document.querySelector('#owner-checklist-form').requestSubmit()`);
        await waitFor('document.querySelector("#checklists").textContent.includes("Browser Owner Checklist") && !document.querySelector("#home-button").disabled');
        await evaluate(`document.querySelector("#close-client").click()`);
        assert.equal(await evaluate('document.querySelector("#client-context").hidden'), true);
        assert.equal(await evaluate('document.querySelector("#owner-checklist-form [name=title]").value'), '');
        await evaluate('document.querySelector("#issue").click()');
        await waitFor('document.querySelector("#status").textContent.includes("Open a client account first") && !document.querySelector("#home-button").disabled');
        await evaluate(`document.querySelector("[data-open-client=BROLL]").click()`);
        await waitFor('document.querySelector("#company-code").textContent==="BROLL" && !document.querySelector("#home-button").disabled');
        assert.equal(await evaluate('document.querySelector("#buildings").textContent'), '');
        assert.equal(await evaluate('document.querySelector("#checklists").textContent'), '');
        await evaluate(`document.querySelector('[data-tab=staff]').click();
          document.querySelector('#staff-form [name=displayName]').value='Web Staff';
          document.querySelector('#staff-form [name=username]').value='web-staff';
          document.querySelector('#staff-form [name=password]').value='web-staff-password-123';
          document.querySelector('#staff-form').requestSubmit()`);
        await waitFor('document.querySelector("#staff-list").textContent.includes("Web Staff") && !document.querySelector("#home-button").disabled');
        assert.equal(await evaluate('document.querySelector("#client-context").hidden'), true);
        assert.equal(await evaluate('document.querySelector("#client-navigation").hidden'), true);
        assert((await evaluate('document.querySelector("#platform-owner").textContent')).includes('Platform Founder'));
        await evaluate('document.querySelector("[data-staff-toggle]").click()');
        await waitFor('document.querySelector("#staff-list").textContent.includes("Inactive") && !document.querySelector("#home-button").disabled');
        await evaluate('document.querySelector("#home-button").click()');
        assert.equal(await evaluate('document.querySelector("#home").hidden'), false);
        await evaluate(`(() => {
          const originalFetch = window.fetch;
          window.fetch = async (...args) => {
            const response = await originalFetch(...args);
            if (String(args[0]).includes('/api/license/owner/dashboard')) {
              const data = await response.json();
              delete data.account;
              window.fetch = originalFetch;
              return new Response(JSON.stringify(data), {status:200,headers:{'Content-Type':'application/json'}});
            }
            return response;
          };
          document.querySelector('[data-open-client=BROLL]').click();
        })()`);
        await waitFor('document.querySelector("#status").textContent.includes("valid platform account details") && !document.querySelector("#login button").disabled');
        await waitFor('!document.querySelector("#login-section").hidden && document.querySelector("#dashboard").hidden');
        assert.equal(await evaluate('document.querySelector("[data-tab=staff]").hidden'), true);
        assert.equal(await evaluate(`fetch('/api/license/owner/dashboard').then(response=>response.status)`), 401);
        assert.equal(await evaluate('localStorage.length'), 1);
        assert.equal(await evaluate('localStorage.getItem("primeops-admin-theme")'), 'dark');
        await cdp('Page.reload');
        await waitFor('!document.querySelector("#login-section").hidden && document.querySelector("#dashboard").hidden');
        assert.deepEqual(errors, []);
      } finally {
        await databaseClient.query('UPDATE system_licence SET token=$1 WHERE id=1', [original.token]);
        await databaseClient.end();
      }
    });
  }
  if (process.env.ELECTRON) {
    await t.test('native owner app connects, lists companies and registers a blank company', async (t) => {
      const { evaluate, waitFor, errors } = await require('./browser-test-helper.cjs').browserSession(t, process.env.ELECTRON,
        [path.join(__dirname, '..', 'owner-app')], { electron: true });
      await waitFor('document.readyState==="complete" && !!window.ownerApp && !!document.querySelector("#connect")');
      await evaluate(`document.querySelector('#connect [name=server]').value=${JSON.stringify(adminBase)};
        document.querySelector('#connect').requestSubmit()`);
      await waitFor('!document.querySelector("#login-section").hidden');
      await evaluate(`document.querySelector('#login [name=username]').value='owner';
        document.querySelector('#login [name=password]').value='owner-password-123';
        document.querySelector('#login').requestSubmit()`);
      await waitFor('!document.querySelector("#dashboard").hidden && !document.querySelector("#home-button").disabled');
      const expectedCompanies = (await request(`${ownerPath}/dashboard`, { token: owner })).companies.map((company) => company.code).sort();
      assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-open-client]")].map(button=>button.dataset.openClient).sort()'), expectedCompanies);
      if (process.env.CHROMIUM) {
        await evaluate(`document.querySelector("[data-tab=clients]").click(); document.querySelector("[data-open-client=AFRICREST]").click()`);
        await waitFor('document.querySelector("#company-code").textContent==="AFRICREST" && !document.querySelector("#home-button").disabled');
        await evaluate('document.querySelector("[data-tab=subscriptions]").click()');
        await waitFor('!!document.querySelector("[data-subscription-review=approve]")');
        await evaluate('document.querySelector("[data-subscription-review=approve]").click()');
        await waitFor('document.querySelector("#subscription-current").textContent.includes("Building Managers") && !document.querySelector("#home-button").disabled');
        assert.equal((await request('/api/subscription', { company: 'AFRICREST', token: a })).plan, 'building-managers');
      }
      await evaluate(`document.querySelector('[data-tab="new-company"]').click();
        document.querySelector('#company-form [name=name]').value='Owner UI Test';
        document.querySelector('#company-form [name=code]').value='OWNER-UI';
        document.querySelector('#company-form [name=adminUsername]').value='ui-admin';
        document.querySelector('#company-form [name=adminPassword]').value='ui-admin-password-123';
        document.querySelector('#company-form [name=subscriptionPlan]').value='operations';
        document.querySelector('#company-form').requestSubmit()`);
      await waitFor('!document.querySelector("#clients").hidden && !!document.querySelector("[data-open-client=OWNER-UI]") && !document.querySelector("#home-button").disabled');
      await evaluate('document.querySelector("[data-open-client=OWNER-UI]").click()');
      await waitFor('document.querySelector("#company-code").textContent==="OWNER-UI" && !document.querySelector("#issue").disabled');
      const registeredLicence = await request('/api/license', { company: 'OWNER-UI' });
      assert.equal(registeredLicence.state, 'active');
      assert.equal(await evaluate('document.querySelector("#issue").textContent'), 'Renew licence for one year');
      await post('/api/auth/login', { email: 'ui-admin', password: 'ui-admin-password-123' }, { company: 'OWNER-UI' });
      assert.equal((await request(`${ownerPath}/subscription?companyCode=OWNER-UI`, { token: owner })).plan, 'operations');
      await evaluate('document.querySelector("#issue").click()');
      await waitFor('document.querySelector("#status").textContent.includes("Annual licence activated") && !document.querySelector("#issue").disabled');
      const renewedLicence = await request('/api/license', { company: 'OWNER-UI' });
      assert.equal(renewedLicence.state, 'active');
      assert.equal(verifyToken(renewedLicence.token, publicKey).termStart, verifyToken(registeredLicence.token, publicKey).expiresAt);
      await evaluate(`document.querySelector('[data-tab=content]').click();
        document.querySelector('#building-form [name=name]').value='Owner added building';
        document.querySelector('#building-form [name=city]').value='Pretoria';
        document.querySelector('#building-form').requestSubmit()`);
      await waitFor('document.querySelector("#buildings").textContent.includes("Owner added building") && !document.querySelector("#add-question").disabled');
      await evaluate(`document.querySelector('#owner-checklist-form [name=title]').value='Owner custom checklist';
        document.querySelector('#questions [data-label]').value='Owner created question';
        document.querySelector('#owner-checklist-form').requestSubmit()`);
      await waitFor('document.querySelector("#checklists").textContent.includes("Owner custom checklist")');
      const companyAdmin = (await post('/api/auth/login', { email: 'ui-admin', password: 'ui-admin-password-123' }, { company: 'OWNER-UI' })).token;
      const selectedFeatures = await post('/api/company-features/requests', { features: ['checks'] }, { company: 'OWNER-UI', token: companyAdmin });
      assert.equal(selectedFeatures.feeCents, 0);
      await evaluate(`document.querySelector("#close-client").click(); document.querySelector("[data-open-client=OWNER-UI]").click()`);
      await waitFor('!document.querySelector("#home-button").disabled && !!document.querySelector("[data-feature-review=true]")');
      await evaluate('document.querySelector("[data-tab=features]").click(); document.querySelector("[data-feature-review=true]").click()');
      await waitFor('document.querySelector("#features-active").textContent.includes("Building checks") && !document.querySelector("#home-button").disabled');
      assert.equal((await request('/api/properties', { company: 'OWNER-UI', token: companyAdmin })).properties[0].name, 'Owner added building');
      assert.equal((await request('/api/check-templates', { company: 'OWNER-UI', token: companyAdmin })).templates[0].title, 'Owner custom checklist');
      await evaluate(`document.querySelector('[data-tab=client-account]').click();
        document.querySelector('#debtor-profile-form').closest('details').open=true;
        document.querySelector('#debtor-profile-form [name=legalName]').value='Native debtor profile';
        document.querySelector('#debtor-profile-form [name=billingAddress]').value='Native billing address';
        document.querySelector('#debtor-profile-form [name=contactEmail]').value='native@example.test';
        document.querySelector('#debtor-profile-form [name=vatRegistered]').value='false';
        document.querySelector('#debtor-profile-form').requestSubmit()`);
      await waitFor('document.querySelector("#status").textContent==="Debtor profile saved." && !document.querySelector("#home-button").disabled');
      assert.equal((await request(`${ownerPath}/accounts?companyCode=OWNER-UI`, { token: owner })).company.debtorProfile.legalName, 'Native debtor profile');
      const nativeDay = new Date().toISOString().slice(0, 10);
      await evaluate(`document.querySelector('#invoice-editor').open=true;
        document.querySelector('#invoice-form [name=reference]').value='NATIVE-INV';
        document.querySelector('#invoice-form [name=description]').value='Native test invoice';
        document.querySelector('#invoice-form [name=amount]').value='10.00';
        document.querySelector('#invoice-form [name=issuedOn]').value=${JSON.stringify(nativeDay)};
        document.querySelector('#invoice-form [name=dueOn]').value=${JSON.stringify(nativeDay)};
        document.querySelector('#invoice-form').requestSubmit()`);
      await waitFor('document.querySelector("#account-invoices").textContent.includes("NATIVE-INV") && !document.querySelector("#home-button").disabled');
      await evaluate('document.querySelector("#account-invoices [data-view-owner-invoice]").click()');
      await waitFor('document.querySelector("#owner-invoice-dialog").open');
      assert((await evaluate('document.querySelector("#owner-invoice-dialog iframe").contentDocument.body.innerText')).includes('Native debtor profile'));
      await evaluate('document.querySelector("#close-owner-invoice").click()');
      await evaluate('[...document.querySelectorAll("#account-invoices button")].find(button=>button.textContent==="Email / retry email").click()');
      await waitFor('document.querySelector("#status").textContent.includes("no email was sent") && !document.querySelector("#home-button").disabled');
      await evaluate(`document.querySelector('#payment-form').closest('details').open=true;
        document.querySelector('#payment-form [name=invoiceId]').selectedIndex=1;
        document.querySelector('#payment-form [name=reference]').value='NATIVE-PAY';
        document.querySelector('#payment-form [name=amount]').value='10.00';
        document.querySelector('#payment-form [name=paidOn]').value=${JSON.stringify(nativeDay)};
        document.querySelector('#payment-form').requestSubmit()`);
      await waitFor('document.querySelector("#account-payments").textContent.includes("NATIVE-PAY") && !document.querySelector("#home-button").disabled');
      await evaluate(`document.querySelector('[data-tab=operators]').click();document.querySelector('#refresh-operators').click()`);
      await waitFor('document.querySelector("#status").textContent==="Client operators refreshed." && !document.querySelector("#home-button").disabled');
      await evaluate('document.querySelector("[data-tab=invoice-setup]").click()');
      await waitFor('!document.querySelector("#invoice-setup").hidden');
      assert.equal(await evaluate('document.querySelector("#invoice-settings-form [name=legalName]").value'), 'Test Invoicing Business');
      await evaluate('document.querySelector("#invoice-settings-form").requestSubmit()');
      await waitFor('document.querySelector("#status").textContent.includes("Invoice seller details saved") && !document.querySelector("#home-button").disabled');
      assert.deepEqual((await request('/api/properties', { company: 'BROLL', token: b })).properties, []);
      assert.deepEqual(errors, []);
    });
  }
  await t.test('platform accounts track actual payments, block arrears and require password-confirmed supervisor agreements', async () => {
    const company = 'BILL-TEST';
    await post(`${ownerPath}/companies`, { code: company, name: 'Billing Test Client', ...adminCredentials }, { token: owner, status: 201 });
    const clientToken = (await post('/api/auth/login', { email: 'same-admin', password: adminCredentials.adminPassword }, { company })).token;
    await post(`${ownerPath}/buildings`, { companyCode: company, name: 'Billing Building', city: 'Pretoria' }, { token: owner, status: 201 });
    const property = (await request('/api/properties', { token: clientToken, company })).properties[0];
    const worker = (await post('/api/users', { name: 'Billing worker', email: 'billing-worker', password: 'worker-password',
      role: 'maintenance_assistant', propertyIds: [property.id] }, { company, token: clientToken, status: 201 })).user;
    assert(worker.id);
    const workerToken = (await post('/api/auth/login', { email: 'billing-worker', password: 'worker-password' }, { company })).token;
    await activateFeatures(company, clientToken, ['tickets', 'checks']);
    await post(`${ownerPath}/buildings`, { companyCode: company, name: 'Billing South', city: 'Pretoria' }, { token: owner, status: 201 });
    const propertyIds = (await request('/api/properties', { token: clientToken, company })).properties.map((building) => building.id);
    const supervisor = (await post(`${ownerPath}/staff`, { displayName: 'Accounts Supervisor', username: 'accounts-supervisor',
      password: 'supervisor-password-123', role: 'supervisor' }, { token: owner, status: 201 })).staff;
    const login = await post(`${ownerPath}/login`, { username: 'accounts-supervisor', password: 'supervisor-password-123' });
    assert.equal(login.account.role, 'supervisor');
    const supervisorToken = login.token;
    assert.equal((await request(`${ownerPath}/dashboard?scope=platform`, { token: supervisorToken })).account.role, 'supervisor');
    await request(`${ownerPath}/staff`, { token: supervisorToken, status: 403 });
    const accountant = (await post(`${ownerPath}/staff`, { displayName: 'Payment Administrator', username: 'payment-admin',
      password: 'payment-admin-password' }, { token: owner, status: 201 })).staff;
    const accountantToken = (await post(`${ownerPath}/login`, { username: accountant.username, password: 'payment-admin-password' })).token;
    const statement = () => request(`${ownerPath}/accounts?companyCode=${company}`, { token: owner });
    let account = await statement();
    assert.equal(account.company.testAccount, false);
    // Keep this manual-ledger scenario separate from automatic monthly issuance.
    account = await request(`${ownerPath}/accounts/plan`, { method: 'PUT', token: owner,
      body: { companyCode: company, revision: account.company.revision, monthlyFee: '450.00', startsOn: '2100-01', endsOn: '' } });
    const profile = { legalName: 'Billing Test Client Ltd', registrationNumber: 'TEST-REG', vatNumber: 'TEST-VAT',
      billingAddress: 'Test billing address', contactName: 'Accounts department', contactEmail: 'accounts@example.test',
      contactPhone: '', paymentTermsDays: 14, internalNotes: 'Internal collection instructions', vatRegistered: false };
    await request(`${ownerPath}/accounts/profile`, { method: 'PUT', body: { companyCode: company, revision: account.company.revision, profile }, token: accountantToken, status: 403 });
    await request(`${ownerPath}/accounts/profile`, { method: 'PUT', body: { companyCode: company, revision: account.company.revision, profile: { ...profile, contactEmail: 'invalid' } }, token: supervisorToken, status: 400 });
    account = await request(`${ownerPath}/accounts/profile`, { method: 'PUT', body: { companyCode: company, revision: account.company.revision, profile }, token: supervisorToken });
    assert.deepEqual(account.company.debtorProfile, profile);
    assert.equal((await request('/api/platform-account', { company, token: clientToken })).company.debtorProfile.internalNotes, undefined);
    const operators = () => request(`${ownerPath}/operators?companyCode=${company}`, { token: supervisorToken });
    await request(`${ownerPath}/operators`, { token: supervisorToken, status: 400 });
    const newOperator = { companyCode: company, email: 'platform-created-manager', name: 'Platform created manager',
      password: 'platform-created-password', role: 'building_manager', propertyIds, sections: ['tickets'], adminRights: false };
    await post(`${ownerPath}/operators`, newOperator, { token: clientToken, status: 401 });
    await post(`${ownerPath}/operators`, { ...newOperator, propertyIds: [] }, { token: supervisorToken, status: 400 });
    await post(`${ownerPath}/operators`, { ...newOperator, propertyIds: ['foreign-building'] }, { token: supervisorToken, status: 400 });
    const createdOperator = (await post(`${ownerPath}/operators`, newOperator, { token: supervisorToken, status: 201 })).user;
    assert.deepEqual([...createdOperator.property_ids].sort(), [...propertyIds].sort());
    const createdSession = await post('/api/auth/login', { email: newOperator.email, password: newOperator.password }, { company });
    assert.equal((await request('/api/auth/me', { company, token: createdSession.token })).user.role, 'building_manager');
    assert.deepEqual((await request('/api/properties', { company, token: createdSession.token })).properties.map((row) => row.id).sort(), [...propertyIds].sort());
    await post(`${ownerPath}/operators`, newOperator, { token: supervisorToken, status: 409 });
    let operator = (await operators()).users.find((user) => user.id === worker.id);
    assert(!JSON.stringify(operator).includes('password'));
    let operatorBody = { ...operator, companyCode: company, role: 'maintenance_manager', propertyIds, sections: ['tickets'], adminRights: false };
    await request(`${ownerPath}/operators/${worker.id}`, { method: 'PUT', token: supervisorToken, body: operatorBody });
    assert.equal((await request('/api/auth/me', { company, token: workerToken })).user.role, 'maintenance_manager');
    assert.equal((await request('/api/properties', { company, token: workerToken })).properties.length, 2);
    await request('/api/users', { company, token: workerToken, status: 403 });
    await request(`${ownerPath}/operators/${worker.id}`, { method: 'PUT', token: supervisorToken, body: operatorBody, status: 409 });
    operator = (await operators()).users.find((user) => user.id === worker.id);
    operatorBody = { ...operator, companyCode: company, role: 'user', unitNumber: 'D1', propertyIds, sections: null, adminRights: false };
    await request(`${ownerPath}/operators/${worker.id}`, { method: 'PUT', token: supervisorToken, body: operatorBody, status: 403 });
    await request(`${ownerPath}/operators/${worker.id}`, { method: 'PUT', token: supervisorToken, body: { ...operatorBody, propertyIds: ['foreign-building'] }, status: 403 });
    await request(`${ownerPath}/operators/${worker.id}`, { method: 'PUT', token: supervisorToken, body: { ...operatorBody, propertyIds: [property.id] }, status: 403 });
    assert.equal((await request('/api/properties', { company, token: workerToken })).properties.length, 2);
    await request(`${ownerPath}/operators/${worker.id}`, { method: 'PUT', token: supervisorToken, body: { ...operatorBody, companyCode: 'BROLL', role: 'maintenance_manager', propertyIds: [property.id] }, status: 404 });
    const mainAdmin = (await operators()).users.find((user) => user.role === 'admin');
    await request(`${ownerPath}/operators/${mainAdmin.id}`, { method: 'PUT', token: supervisorToken,
      body: { ...mainAdmin, companyCode: company, role: 'maintenance_manager', propertyIds, sections: null, adminRights: false }, status: 404 });
    operator = (await operators()).users.find((user) => user.id === worker.id);
    await request(`${ownerPath}/operators/${worker.id}`, { method: 'PUT', token: supervisorToken,
      body: { ...operator, companyCode: company, role: 'maintenance_assistant', propertyIds: [property.id], sections: null, adminRights: false } });
    const before = await request(`${ownerPath}/accounts`, { token: owner });
    const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
    const invoiceBody = { companyCode: company, revision: account.company.revision, reference: 'INV-OVERDUE', description: 'PrimeOps monthly service',
      amount: '1500.25', issuedOn: day(-30), dueOn: day(-20) };
    await post(`${ownerPath}/accounts/invoices`, invoiceBody, { token: accountantToken, status: 403 });
    await post(`${ownerPath}/accounts/invoices`, invoiceBody, { token: clientToken, status: 401 });
    account = await post(`${ownerPath}/accounts/invoices`, invoiceBody, { token: supervisorToken, status: 201 });
    const invoice = account.invoices[0];
    assert.equal(account.blocked, true);
    assert.equal(account.arrearsCents, 150025);
    assert.equal(account.incomeCents, 0);
    assert.equal((await request('/api/auth/me', { company, token: clientToken })).user.billingBlocked, true);
    assert.equal((await request('/api/properties', { company, token: clientToken, status: 423 })).code, 'ACCOUNT_ARREARS');
    await post('/api/properties', { name: 'Denied building' }, { company, token: clientToken, status: 423 });
    await post('/api/properties', { name: 'Denied offline replay' }, { company, token: clientToken, headers: { 'X-Operation-ID': crypto.randomUUID() }, status: 423 });
    await request('/api/workspace', { company, token: workerToken, status: 423 });
    await request('/api/platform-account', { company, token: workerToken, status: 403 });
    const publicStatement = await request('/api/platform-account', { company, token: clientToken });
    assert.equal(publicStatement.arrearsCents, 150025);
    assert.equal(publicStatement.events, undefined);
    assert.equal(publicStatement.invoices[0].createdBy, undefined);
    assert.equal((await request('/api/platform-account', { company: 'BROLL', token: b })).outstandingCents, 0);
    await request('/api/platform-account', { company: 'BROLL', token: clientToken, status: 401 });
    await request('/api/properties', { company: 'BROLL', token: b });
    await post(`${ownerPath}/accounts/payments`, { companyCode: company, revision: account.company.revision, invoiceId: invoice.id,
      reference: 'TOO-MUCH', amount: '1500.26', paidOn: day(0) }, { token: accountantToken, status: 400 });
    const extension = { companyCode: company, revision: account.company.revision, until: new Date(Date.now() + 86400000).toISOString(),
      reason: 'Agreed instalment date', password: 'supervisor-password-123' };
    await post(`${ownerPath}/accounts/extension`, extension, { token: accountantToken, status: 403 });
    await post(`${ownerPath}/accounts/extension`, { ...extension, password: 'wrong-password' }, { token: supervisorToken, status: 403 });
    account = await post(`${ownerPath}/accounts/extension`, extension, { token: supervisorToken });
    assert.equal(account.blocked, false);
    assert.equal(account.arrearsCents, 150025);
    assert.equal((await request('/api/platform-account', { company, token: clientToken })).company.overrideReason, undefined);
    await request('/api/properties', { company, token: clientToken });
    // Expiry is enforced from stored dates without a scheduler or server restart.
    const databaseClient = new Client({ connectionString: url.href });
    await databaseClient.connect();
    try { await databaseClient.query("UPDATE companies SET billing_override_until=NOW()-INTERVAL '1 second' WHERE code=$1", [company]); }
    finally { await databaseClient.end(); }
    await request('/api/properties', { company, token: clientToken, status: 423 });
    account = await statement();
    const pay = { companyCode: company, revision: account.company.revision, invoiceId: invoice.id, reference: 'BANK-1', amount: '500.25', paidOn: day(0) };
    const concurrent = await Promise.all([
      fetch(`${adminBase}${ownerPath}/accounts/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accountantToken}` }, body: JSON.stringify(pay) }),
      fetch(`${adminBase}${ownerPath}/accounts/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accountantToken}` }, body: JSON.stringify({ ...pay, reference: 'BANK-OTHER' }) })
    ]);
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [201, 409]);
    account = await statement();
    assert.equal(account.payments.length, 1);
    assert.equal(account.incomeCents, 50025);
    assert.equal(account.arrearsCents, 100000);
    assert.equal(account.blocked, true);
    await post(`${ownerPath}/accounts/payments`, { ...pay, revision: account.company.revision, reference: account.payments[0].reference },
      { token: accountantToken, status: 409 });
    const paid = account.payments[0];
    await post(`${ownerPath}/accounts/correction`, { companyCode: company, revision: account.company.revision, kind: 'payment', id: paid.id,
      reason: 'Wrong payment entry', password: 'payment-admin-password' }, { token: accountantToken, status: 403 });
    account = await post(`${ownerPath}/accounts/correction`, { companyCode: company, revision: account.company.revision, kind: 'payment', id: paid.id,
      reason: 'Wrong payment entry', password: 'supervisor-password-123' }, { token: supervisorToken });
    assert.equal(account.incomeCents, 0);
    assert.equal(account.payments[0].reversedAt !== null, true);
    account = await post(`${ownerPath}/accounts/payments`, { ...pay, revision: account.company.revision, reference: 'BANK-SETTLED', amount: '1500.25' }, { token: accountantToken, status: 201 });
    assert.equal(account.blocked, false);
    assert.equal(account.outstandingCents, 0);
    assert.equal(account.incomeCents, 150025);
    await request('/api/properties', { company, token: clientToken });
    const totals = await request(`${ownerPath}/accounts`, { token: accountantToken });
    assert.equal(totals.incomeCents - before.incomeCents, 150025);
    assert.equal(totals.monthIncomeCents - before.monthIncomeCents, 150025);
    assert.equal(account.events.filter((event) => event.action === 'payment').length, 2);
    assert.equal(account.events.find((event) => event.action === 'extension').actorRole, 'supervisor');
    assert(!JSON.stringify(account.events).includes('password-123'));
    await post(`${ownerPath}/accounts/correction`, { companyCode: company, revision: account.company.revision, kind: 'invoice', id: invoice.id,
      reason: 'Cannot void a paid invoice', password: 'supervisor-password-123' }, { token: supervisorToken, status: 409 });
    account = await post(`${ownerPath}/accounts/invoices`, { ...invoiceBody, revision: account.company.revision, reference: 'INV-VOID', amount: '1.00' },
      { token: owner, status: 201 });
    const voidId = account.invoices.find((item) => item.reference === 'INV-VOID').id;
    account = await post(`${ownerPath}/accounts/correction`, { companyCode: company, revision: account.company.revision, kind: 'invoice', id: voidId,
      reason: 'Duplicate invoice', password: 'owner-password-123' }, { token: owner });
    assert.equal(account.blocked, false);
    assert.equal(account.invoicedCents, 150025);
    await request(`${ownerPath}/staff/${supervisor.id}`, { token: owner, method: 'PUT', body: { active: true, role: 'administrator' } });
    await request(`${ownerPath}/accounts`, { token: supervisorToken, status: 401 });
    const downgraded = await post(`${ownerPath}/login`, { username: 'accounts-supervisor', password: 'supervisor-password-123' });
    assert.equal(downgraded.account.role, 'administrator');
    await post(`${ownerPath}/accounts/extension`, { ...extension, revision: account.company.revision }, { token: downgraded.token, status: 403 });
    await request(`${ownerPath}/staff/${supervisor.id}`, { token: owner, method: 'PUT', body: { active: true, role: 'supervisor' } });
    if (process.env.CHROMIUM) {
      const { cdp, evaluate, waitFor, errors } = await require('./browser-test-helper.cjs').browserSession(t, process.env.CHROMIUM, ['--headless']);
      await cdp('Page.navigate', { url: `${adminBase}/admin/` });
      await waitFor('document.querySelector("#login-section")?.hidden === false && !document.querySelector("#login button").disabled');
      await evaluate(`document.querySelector('#login [name=username]').value='accounts-supervisor';
        document.querySelector('#login [name=password]').value='supervisor-password-123';document.querySelector('#login').requestSubmit()`);
      await waitFor('!document.querySelector("#dashboard").hidden && !document.querySelector("#home-button").disabled');
      assert.equal(await evaluate('document.querySelector("#home-role").textContent'), 'Supervisor');
      assert((await evaluate('document.querySelector("#home-finances").textContent')).includes('Income received'));
      await evaluate(`document.querySelector('[data-tab=accounts]').click();document.querySelector('[data-open-billing="${company}"]').click()`);
      await waitFor('!document.querySelector("#client-account").hidden && !document.querySelector("#home-button").disabled');
      assert.equal(await evaluate('document.querySelector("#extension-editor").hidden'), false);
      await evaluate(`document.querySelector('#debtor-profile-form').closest('details').open=true;
        document.querySelector('#debtor-profile-form [name=contactPhone]').value='TEST-PHONE';
        document.querySelector('#debtor-profile-form').requestSubmit()`);
      await waitFor('document.querySelector("#status").textContent==="Debtor profile saved." && !document.querySelector("#home-button").disabled');
      assert.equal((await statement()).company.debtorProfile.contactPhone, 'TEST-PHONE');
      await evaluate(`(() => {document.querySelector('[data-tab=operators]').click();
        const row=document.querySelector('[data-operator="${worker.id}"]');row.open=true;
        const form=row.querySelector('[name=role]').form;form.elements.role.value='maintenance_manager';form.elements.role.dispatchEvent(new Event('change',{bubbles:true}));
        form.querySelectorAll('[name=propertyIds]').forEach(input=>input.checked=true);
        form.elements.customSections.checked=true;form.querySelectorAll('[name=sections]').forEach(input=>input.checked=input.value==='tickets');
        form.requestSubmit();})()`);
      await waitFor('document.querySelector("#status").textContent.includes("Operator role") && !document.querySelector("#home-button").disabled');
      const savedOperator = (await request('/api/auth/me', { company, token: workerToken })).user;
      assert.equal(savedOperator.role, 'maintenance_manager');
      assert.equal(savedOperator.propertyIds.length, 2);
      assert.deepEqual(savedOperator.sections, ['tickets']);
      await evaluate(`document.querySelector('[data-tab=client-account]').click()`);
      await evaluate(`(() => {document.querySelector('#invoice-editor').open=true;
        const form=document.querySelector('#invoice-form');form.elements.reference.value='INV-BROWSER';form.elements.description.value='Browser invoice';
        form.elements.amount.value='250.00';form.elements.issuedOn.value=${JSON.stringify(day(-30))};form.elements.dueOn.value=${JSON.stringify(day(-20))};form.requestSubmit();})()`);
      await waitFor('document.querySelector("#account-invoices").textContent.includes("INV-BROWSER") && !document.querySelector("#home-button").disabled');
      assert((await evaluate('document.querySelector("#client-account-summary").textContent')).includes('Blocked for arrears'));
      await cdp('Page.navigate', { url: base });
      await waitFor('document.querySelector("#auth-screen")?.hidden === false');
      await evaluate(`localStorage.setItem('primeops-company-code',${JSON.stringify(company)})`);
      await cdp('Page.reload');
      await waitFor('document.readyState==="complete" && document.querySelector("#auth-screen")?.hidden === false && document.querySelector("#licence-expiry").textContent!=="Not activated" && document.querySelector("[data-company-name]").textContent==="Billing Test Client"');
      await evaluate(`document.querySelector('#login-form [name=email]').value='same-admin';document.querySelector('#login-form [name=password]').value='company-password-123';document.querySelector('#login-form').requestSubmit()`);
      await waitFor('document.querySelector("#platform-account-screen")?.hidden === false && document.querySelector("#platform-account-screen [data-platform-statement]").textContent.includes("INV-BROWSER")');
      assert.equal(await evaluate('document.querySelector("#app-shell").hidden'), true);
      assert.equal(await evaluate('document.querySelector("#platform-account-screen [data-client-billing]")!==null'), true);
      account = await statement();
      const nextSupervisor = (await post(`${ownerPath}/login`, { username: 'accounts-supervisor', password: 'supervisor-password-123' })).token;
      account = await post(`${ownerPath}/accounts/extension`, { ...extension, revision: account.company.revision }, { token: nextSupervisor });
      await evaluate('document.querySelector("#recheck-platform-account").click()');
      await waitFor('document.querySelector("#app-shell")?.hidden === false && document.querySelector("#platform-account-screen").hidden');
      await evaluate('document.querySelector("#platform-account-button").click()');
      await waitFor('document.querySelector("#platform-account-dialog").open && document.querySelector("#platform-account-dialog [data-platform-statement]").textContent.includes("INV-BROWSER")');
      assert.deepEqual(errors, []);
      account = await post(`${ownerPath}/accounts/extension`, { ...extension, revision: account.company.revision, until: null }, { token: nextSupervisor });
      assert.equal(account.blocked, true);
      assert.equal((await request('/api/properties', { company, token: clientToken, status: 423 })).code, 'ACCOUNT_ARREARS');
    }
  });
  await t.test('owner forecasts monthly income and tracks overdue clients and prepaid credit without double counting', async () => {
    const company = 'FORECAST';
    await post(`${ownerPath}/companies`, { code: company, name: 'Forecast Test Client', ...adminCredentials }, { token: owner, status: 201 });
    const clientToken = (await post('/api/auth/login', { email: 'same-admin', password: adminCredentials.adminPassword }, { company })).token;
    const cashier = (await post(`${ownerPath}/staff`, { displayName: 'Forecast cashier', username: 'forecast-cashier',
      password: 'forecast-cashier-password' }, { token: owner, status: 201 })).staff;
    const cashierToken = (await post(`${ownerPath}/login`, { username: cashier.username, password: 'forecast-cashier-password' })).token;
    const statement = () => request(`${ownerPath}/accounts?companyCode=${company}`, { token: owner });
    const dateNow = new Date();
    const day = dateNow.toISOString().slice(0, 10);
    const firstMonth = day.slice(0, 7);
    const offsetMonth = (offset) => new Date(Date.UTC(dateNow.getUTCFullYear(), dateNow.getUTCMonth() + offset, 1)).toISOString().slice(0, 7);
    let account = await statement();
    await request('/api/platform-account/profile', { method: 'PUT', company, token: clientToken, body: { revision: account.company.revision,
      profile: { legalName: 'Forecast Test Client', registrationNumber: '', vatNumber: '', billingAddress: 'Test billing address',
        contactName: 'Accounts', contactEmail: 'client@example.test', contactPhone: '', vatRegistered: false } } });
    account = await statement();
    const initialTotals = await request(`${ownerPath}/accounts`, { token: owner });
    assert.equal(account.forecast.projectedCents, 540000);
    const plan = { companyCode: company, revision: account.company.revision, monthlyFee: '450.00', startsOn: firstMonth, endsOn: '' };
    await request(`${ownerPath}/accounts/plan`, { method: 'PUT', body: plan, token: cashierToken, status: 403 });
    await request(`${ownerPath}/accounts/plan`, { method: 'PUT', body: { ...plan, startsOn: 'invalid' }, token: owner, status: 400 });
    await request(`${ownerPath}/accounts/plan`, { method: 'PUT', body: { ...plan, endsOn: offsetMonth(-1) }, token: owner, status: 400 });
    await request(`${ownerPath}/accounts/plan`, { method: 'PUT', body: { ...plan, monthlyFee: '100.00' }, token: owner, status: 409 });
    account = await request(`${ownerPath}/accounts/plan`, { method: 'PUT', body: plan, token: owner });
    assert.equal(account.forecast.projectedCents, 540000);
    assert.equal(account.forecast.projectedCollectionCents, 540000);
    assert.equal(account.invoices.length, 0);
    const advance = { companyCode: company, revision: account.company.revision, reference: 'ADVANCE-1', amount: '1350.00', paidOn: day };
    account = await post(`${ownerPath}/accounts/prepayments`, advance, { token: cashierToken, status: 201 });
    assert.equal(account.incomeCents, 135000);
    assert.equal(account.prepaidCents, 135000);
    assert.equal(account.forecast.coveredThrough, offsetMonth(2));
    assert.equal(account.forecast.coveredMonths, 3);
    assert.equal(account.forecast.projectedCollectionCents, 405000);
    const firstCredit = account.credits[0];
    await post(`${ownerPath}/accounts/prepayments`, advance, { token: cashierToken, status: 409 });
    await post(`${ownerPath}/accounts/prepayments`, { ...advance, revision: account.company.revision }, { token: cashierToken, status: 409 });
    await post(`${ownerPath}/accounts/prepayments`, { ...advance, revision: account.company.revision, reference: 'INVALID', amount: '0' }, { token: cashierToken, status: 400 });
    const invoice = { companyCode: company, revision: account.company.revision, reference: 'FORECAST-MONTH-1', description: 'Monthly fee',
      amount: '450.00', issuedOn: day, dueOn: day, serviceMonth: firstMonth };
    account = await post(`${ownerPath}/accounts/invoices`, invoice, { token: owner, status: 201 });
    const firstInvoice = account.invoices[0];
    assert.equal(firstInvoice.serviceMonth, `${firstMonth}-01`);
    assert.equal(firstInvoice.paidCents, 45000);
    assert.equal(firstInvoice.outstandingCents, 0);
    assert.equal(account.prepaidCents, 90000);
    assert.equal(account.incomeCents, 135000);
    assert.equal(account.monthIncomeCents, 135000);
    assert.equal(account.forecast.projectedCents, 540000);
    assert.equal(account.forecast.projectedCollectionCents, 405000);
    await post(`${ownerPath}/accounts/invoices`, { ...invoice, revision: account.company.revision, reference: 'DUPLICATE-MONTH' }, { token: owner, status: 409 });
    await post(`${ownerPath}/accounts/payments`, { companyCode: company, revision: account.company.revision, invoiceId: firstInvoice.id,
      reference: 'ADVANCE-1', amount: '1.00', paidOn: day }, { token: cashierToken, status: 409 });
    await post(`${ownerPath}/accounts/correction`, { companyCode: company, revision: account.company.revision, kind: 'payment', id: account.payments[0].id,
      reason: 'Must reverse original advance', password: 'owner-password-123' }, { token: owner, status: 409 });
    const old = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
    account = await post(`${ownerPath}/accounts/invoices`, { ...invoice, revision: account.company.revision, reference: 'OLDER-EXTRA',
      serviceMonth: '', amount: '1125.00', issuedOn: old, dueOn: old }, { token: owner, status: 201 });
    assert.equal(account.prepaidCents, 0);
    assert.equal(account.arrearsCents, 22500);
    assert.equal(account.blocked, true);
    assert.equal(account.daysOverdue, 20);
    const overdueTotals = await request(`${ownerPath}/accounts`, { token: owner });
    assert(overdueTotals.accounts.find((client) => client.code === company).arrearsCents > 0);
    assert.equal(overdueTotals.incomeCents - initialTotals.incomeCents, 135000);
    account = await post(`${ownerPath}/accounts/prepayments`, { ...advance, revision: account.company.revision, reference: 'ADVANCE-2', amount: '2025.00' }, { token: cashierToken, status: 201 });
    assert.equal(account.arrearsCents, 0);
    assert.equal(account.blocked, false);
    assert.equal(account.prepaidCents, 180000);
    assert.equal(account.forecast.coveredThrough, offsetMonth(4));
    assert.equal(account.incomeCents, 337500);
    const publicStatement = await request('/api/platform-account', { company, token: clientToken });
    assert.equal(publicStatement.prepaidCents, 180000);
    assert.equal(publicStatement.credits[0].createdBy, undefined);
    assert.equal((await request('/api/platform-account', { company: 'BROLL', token: b })).prepaidCents, 0);
    // Reversing the original advance also reverses its allocations, then remaining valid credit is reapplied.
    account = await post(`${ownerPath}/accounts/correction`, { companyCode: company, revision: account.company.revision, kind: 'credit', id: firstCredit.id,
      reason: 'Advance receipt correction', password: 'owner-password-123' }, { token: owner });
    assert.equal(account.incomeCents, 202500);
    assert.equal(account.prepaidCents, 45000);
    assert.equal(account.arrearsCents, 0);
    assert.equal(account.forecast.coveredThrough, offsetMonth(1));
    assert(account.events.some((event) => event.action === 'prepayment_reversed'));
    const totals = await request(`${ownerPath}/accounts`, { token: owner });
    assert.equal(totals.incomeCents - initialTotals.incomeCents, 202500);
    assert.equal(totals.prepaidCents - initialTotals.prepaidCents, 45000);
    assert.equal(totals.forecast.projectedCents - initialTotals.forecast.projectedCents, 0);
    assert(totals.prepaidClients > 0);
    if (process.env.CHROMIUM) {
      const { cdp, evaluate, waitFor, errors } = await require('./browser-test-helper.cjs').browserSession(t, process.env.CHROMIUM, ['--headless']);
      await cdp('Page.navigate', { url: `${adminBase}/admin/` });
      await waitFor('document.querySelector("#login-section")?.hidden === false && !document.querySelector("#login button").disabled');
      await evaluate(`document.querySelector('#login [name=username]').value='owner';
        document.querySelector('#login [name=password]').value='owner-password-123';document.querySelector('#login').requestSubmit()`);
      await waitFor('!document.querySelector("#dashboard").hidden && !document.querySelector("#home-button").disabled');
      assert((await evaluate('document.querySelector("#home-finances").textContent')).includes('Projected charges'));
      assert((await evaluate('document.querySelector("#home-prepaid").textContent')).includes('Forecast Test Client'));
      assert.equal(await evaluate('document.querySelectorAll("#home-forecast strong").length'), 12);
      await evaluate(`document.querySelector('[data-tab=accounts]').click();
        document.querySelector('#account-filter').value='prepaid';document.querySelector('#account-filter').dispatchEvent(new Event('change'));
        document.querySelector('#accounts-list [data-open-billing="${company}"]').click()`);
      await waitFor('!document.querySelector("#client-account").hidden && !document.querySelector("#home-button").disabled');
      await evaluate(`document.querySelector('#forecast-plan-editor').open=true;document.querySelector('#forecast-plan-form [name=monthlyFee]').value='450.00';document.querySelector('#forecast-plan-form').requestSubmit()`);
      await waitFor('document.querySelector("#status").textContent==="Monthly forecast saved." && !document.querySelector("#home-button").disabled');
      assert.equal((await statement()).company.monthlyFeeCents, 45000);
      await evaluate(`document.querySelector('#prepayment-form').closest('details').open=true;
        document.querySelector('#prepayment-form [name=reference]').value='BROWSER-ADVANCE';
        document.querySelector('#prepayment-form [name=amount]').value='500.00';document.querySelector('#prepayment-form').requestSubmit()`);
      await waitFor('document.querySelector("#account-credits").textContent.includes("BROWSER-ADVANCE") && !document.querySelector("#home-button").disabled');
      account = await statement();
      assert.equal(account.incomeCents, 252500);
      assert.equal(account.prepaidCents, 95000);
      await evaluate(`document.querySelector('[data-tab=home]').click()`);
      assert((await evaluate('document.querySelector("#home-prepaid").textContent')).includes('Forecast Test Client'));
      assert.equal(await evaluate('document.querySelector("#client-context").hidden'), true);
      assert.deepEqual(errors, []);
    }
  });
  await t.test('Payfast validates hosted checkout notifications, isolates clients and retains late money as credit', async (t) => {
    const company = 'CARDTEST', day = new Date().toISOString().slice(0, 10);
    await post(`${ownerPath}/companies`, { code: company, name: 'Card Test Client', ...adminCredentials }, { token: owner, status: 201 });
    const token = (await post('/api/auth/login', { email: 'same-admin', password: adminCredentials.adminPassword }, { company })).token;
    let account = await request('/api/platform-account', { company, token });
    await request('/api/platform-account/profile', { method: 'PUT', company, token, body: { revision: account.company.revision,
      profile: { legalName: 'Card Client', registrationNumber: '', vatNumber: '', billingAddress: 'Card client address',
        contactName: 'Accounts', contactEmail: 'card@example.test', contactPhone: '', vatRegistered: false } } });
    account = await request(`${ownerPath}/accounts?companyCode=${company}`, { token: owner });
    account = await post(`${ownerPath}/accounts/invoices`, { companyCode: company, revision: account.company.revision, reference: '',
      description: 'Card service', amount: '100.00', issuedOn: day, dueOn: day }, { token: owner, status: 201 });
    const invoice = account.invoices[0];
    assert.match(invoice.reference, /^PO-\d{6,}$/);
    assert.equal(account.delivery.status, 'not_configured');
    assert((await request(`/api/platform-account/invoice/${invoice.id}`, { company, token })).html.includes('Card Client'));
    await request(`/api/platform-account/invoice/${invoice.id}`, { company: 'BROLL', token: b, status: 404 });
    const originalDocument = invoice.document;
    await request('/api/platform-account/profile', { method: 'PUT', company, token, body: { revision: account.company.revision,
      profile: { legalName: 'Changed Client Name', registrationNumber: '', vatNumber: '', billingAddress: 'Changed address',
        contactName: '', contactEmail: 'changed@example.test', contactPhone: '', vatRegistered: false } } });
    assert.deepEqual((await request(`${ownerPath}/accounts?companyCode=${company}`, { token: owner })).invoices[0].document, originalDocument);
    const pool = new Pool({ connectionString: url.href });
    t.after(() => pool.end());
    const express = require('express'), app = express();
    app.use(express.json());
    let selectedCompany = company, role = 'admin', validRemote = true, sandbox = false, remoteCalls = 0;
    const config = { merchantId: '10000100', merchantKey: 'test-key', passphrase: 'test-passphrase', origin: 'https://app.example.test',
      base: 'https://www.payfast.co.za', sandbox: false };
    const companies = { current: () => ({ code: selectedCompany }) };
    const accounts = require('./platform-accounts.cjs').createPlatformAccounts({ pool, companies });
    const { createPayfast, signature } = require('./payfast.cjs');
    const service = createPayfast({ pool, companies, platformAccounts: accounts, getConfiguration: () => ({ ...config, sandbox }),
      fetchRemote: async (target, options) => {
        remoteCalls++; assert.equal(target, 'https://www.payfast.co.za/eng/query/validate');
        assert.equal(options.redirect, 'error');
        assert(!options.body.includes('signature='));
        return { ok: true, text: async () => validRemote ? 'VALID' : 'INVALID' };
      } });
    service.mountNotify(app);
    service.mountClient(app, { authenticate: (req, _res, next) => { req.user = { role }; next(); } });
    const listener = app.listen(0, '127.0.0.1'); await once(listener, 'listening');
    t.after(() => new Promise((resolve) => { listener.closeAllConnections(); listener.close(resolve); }));
    const origin = `http://127.0.0.1:${listener.address().port}`;
    const checkout = async () => {
      const response = await fetch(`${origin}/api/platform-account/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: invoice.id, amount: '0.01', companyCode: 'BROLL' }) });
      return { status: response.status, data: await response.json() };
    };
    const first = await checkout();
    assert.equal(first.status, 201); assert.equal(first.data.fields.amount, '100.00');
    assert.equal(first.data.action, 'https://www.payfast.co.za/eng/process');
    assert.equal(first.data.fields.signature, signature(Object.entries(first.data.fields), config.passphrase));
    role = 'maintenance_manager'; assert.equal((await checkout()).status, 403); role = 'admin';
    selectedCompany = 'BROLL'; assert.equal((await checkout()).status, 404); selectedCompany = company;
    const payload = { m_payment_id: first.data.fields.m_payment_id, pf_payment_id: '9912345', payment_status: 'COMPLETE',
      merchant_id: config.merchantId, amount_gross: '100.00' };
    const notify = async (data, sig) => {
      const params = new URLSearchParams({ ...data, signature: sig ?? signature(Object.entries(data), config.passphrase) });
      return fetch(`${origin}/api/payments/payfast/notify`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
    };
    assert.equal((await notify(payload, '0'.repeat(32))).status, 403); assert.equal(remoteCalls, 0);
    assert.equal((await notify({ ...payload, merchant_id: 'different' })).status, 400);
    assert.equal((await notify({ ...payload, amount_gross: '0.01' })).status, 409);
    validRemote = false; assert.equal((await notify(payload)).status, 503); validRemote = true;
    assert.equal((await accounts.statement(company)).outstandingCents, 10000);
    const current = await accounts.statement(company);
    await post(`${ownerPath}/accounts/payments`, { companyCode: company, revision: current.company.revision, invoiceId: invoice.id,
      reference: 'BANK-DURING-CHECKOUT', amount: '25.00', paidOn: day }, { token: owner, status: 201 });
    const concurrent = await Promise.all([notify(payload), notify(payload)]);
    assert.deepEqual(concurrent.map((response) => response.status), [200, 200]);
    account = await accounts.statement(company);
    assert.equal(account.outstandingCents, 0); assert.equal(account.incomeCents, 12500); assert.equal(account.prepaidCents, 2500);
    assert.equal(account.credits.length, 1); assert.equal(account.events.filter((event) => event.action === 'card_payment').length, 1);
    assert.equal((await notify({ ...payload, pf_payment_id: '9912346' })).status, 409);
    // Sandbox test callbacks never add cash, allocate credit or settle real invoices.
    await pool.query(`INSERT INTO public.platform_checkouts(id,company_code,invoice_id,amount_cents,sandbox) VALUES($1,$2,$3,10000,true)`,
      [payload.m_payment_id = crypto.randomUUID(), company, invoice.id]);
    sandbox = true;
    assert.equal((await notify({ ...payload, pf_payment_id: '9912347' })).status, 200);
    assert.equal((await notify({ ...payload, pf_payment_id: '9912347' })).status, 200);
    account = await accounts.statement(company); assert.equal(account.incomeCents, 12500); assert.equal(account.credits.length, 1);
    if (process.env.CHROMIUM) {
      const { cdp, evaluate, waitFor, errors } = await require('./browser-test-helper.cjs').browserSession(t, process.env.CHROMIUM, ['--headless']);
      await cdp('Page.navigate', { url: base });
      await waitFor('document.querySelector("#auth-screen")?.hidden === false');
      await evaluate(`localStorage.setItem('primeops-company-code',${JSON.stringify(company)})`);
      await cdp('Page.reload');
      await waitFor('document.querySelector("#auth-screen")?.hidden === false && document.querySelector("[data-company-name]")?.textContent==="Card Test Client" && document.querySelector("#licence-expiry").textContent!=="Not activated"');
      await evaluate(`document.querySelector('#login-form [name=email]').value='same-admin';document.querySelector('#login-form [name=password]').value='company-password-123';document.querySelector('#login-form').requestSubmit()`);
      await waitFor('document.querySelector("#app-shell")?.hidden === false');
      await evaluate('document.querySelector("#platform-account-button").click()');
      await waitFor('!!document.querySelector("#platform-account-dialog [data-client-billing]")');
      await evaluate('document.querySelector("#platform-account-dialog [data-client-billing]").closest("details").open=true');
      const JSZip = require('jszip'), zip = new JSZip();
      zip.file('word/document.xml', `<w:document xmlns:w="urn:test"><w:body>${['Legal name: Uploaded Client Ltd', 'Billing address: 17 Uploaded Road',
        'Accounts email: uploaded@example.test'].map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
      const filename = path.join(directory, 'client-billing.docx');
      await fs.writeFile(filename, await zip.generateAsync({ type: 'nodebuffer' }));
      const { root } = await cdp('DOM.getDocument');
      const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: '#platform-account-dialog [data-billing-document]' });
      await cdp('DOM.setFileInputFiles', { nodeId, files: [filename] });
      await waitFor('document.querySelector("#platform-account-dialog [data-billing-status]").textContent.includes("Document read.")');
      assert.equal(await evaluate('document.querySelector("#platform-account-dialog [name=legalName]").value'), 'Uploaded Client Ltd');
      assert.equal(await evaluate('document.querySelector("#platform-account-dialog [name=reviewed]").checked'), false);
      await evaluate(`(() => {const form=document.querySelector('#platform-account-dialog [data-client-billing]');form.elements.vatRegistered.value='false';form.elements.reviewed.checked=true;form.requestSubmit();})()`);
      await waitFor('document.querySelector("#platform-account-dialog [name=legalName]")?.value==="Uploaded Client Ltd" && document.querySelector("#platform-account-dialog [name=reviewed]")?.checked===false');
      assert.equal((await accounts.statement(company)).company.debtorProfile.legalName, 'Uploaded Client Ltd');
      await evaluate('document.querySelector("#platform-account-dialog [data-view-platform-invoice]").click()');
      await waitFor('document.querySelector("#invoice-document-dialog")?.open === true');
      assert((await evaluate('document.querySelector("#invoice-document-dialog iframe").contentDocument.body.innerText')).includes('Card Client'));
      assert(!(await evaluate('document.querySelector("#invoice-document-dialog iframe").contentDocument.body.innerText')).includes('Uploaded Client Ltd'));
      assert.deepEqual(errors, []);
    }
  });
  await t.test('PrimeOps staff are separate from clients and only the owner manages their access', async () => {
    const companyBefore = await request('/api/subscription', { company: 'BROLL', token: b });
    const currentLicence = await request('/api/license', { company: 'BROLL' });
    await request(`${ownerPath}/staff`, { token: b, status: 401 });
    await post(`${ownerPath}/staff`, { displayName: 'Staff Admin', username: 'owner', password: 'staff-password-123' }, { token: owner, status: 409 });
    await post(`${ownerPath}/staff`, { displayName: 'Staff Admin', username: 'staff-admin', password: 'short' }, { token: owner, status: 400 });
    await post(`${ownerPath}/staff`, { displayName: 'Staff Admin', username: 'staff-admin', password: 'staff-password-123', role: 'owner' }, { token: owner, status: 400 });
    const staff = (await post(`${ownerPath}/staff`, { displayName: 'Staff Admin', username: 'staff-admin', password: 'staff-password-123' }, { token: owner, status: 201 })).staff;
    await post(`${ownerPath}/staff`, { displayName: 'Duplicate', username: 'STAFF-ADMIN', password: 'staff-password-123' }, { token: owner, status: 409 });
    assert.equal(staff.role, 'administrator');
    assert(!JSON.stringify(staff).includes('password'));
    const login = await post(`${ownerPath}/login`, { username: 'staff-admin', password: 'staff-password-123' });
    assert.equal(login.account.role, 'administrator');
    const token = login.token;
    const staffDashboard = await request(`${ownerPath}/dashboard`, { token });
    assert.equal(staffDashboard.account.displayName, 'Staff Admin');
    assert.equal(staffDashboard.ownership.displayName, 'Platform Founder');
    await request(`${ownerPath}/staff`, { token, status: 403 });
    await post(`${ownerPath}/staff`, { displayName: 'Unauthorised', username: 'other-staff', password: 'other-staff-password' }, { token, status: 403 });
    await request(`${ownerPath}/staff/${staff.id}`, { token, method: 'PUT', body: { active: false }, status: 403 });
    await request(`${ownerPath}/staff/owner`, { token: owner, method: 'PUT', body: { active: false }, status: 400 });
    await request(`${ownerPath}/staff/${staff.id}`, { token: owner, method: 'PUT', body: { active: true, role: 'owner' }, status: 400 });
    if (process.env.CHROMIUM) {
      const { cdp, evaluate, waitFor, errors } = await require('./browser-test-helper.cjs').browserSession(t, process.env.CHROMIUM, ['--headless']);
      await cdp('Page.navigate', { url: `${adminBase}/admin/` });
      await waitFor('document.querySelector("#login-section")?.hidden === false && !document.querySelector("#login button").disabled');
      await evaluate(`document.querySelector('#login [name=username]').value='staff-admin';
        document.querySelector('#login [name=password]').value='staff-password-123';
        document.querySelector('#login').requestSubmit()`);
      await waitFor('!document.querySelector("#dashboard").hidden && !document.querySelector("#home-button").disabled');
      assert.equal(await evaluate('document.querySelector("[data-tab=staff]").hidden'), true);
      assert.equal(await evaluate('document.querySelector("#team-card").hidden'), true);
      assert.equal(await evaluate('document.querySelector("#home-role").textContent'), 'Administrator');
      assert((await evaluate('document.querySelector("#platform-identity").textContent')).includes('PrimeOps owner: Platform Founder'));
      assert.deepEqual(errors, []);
    }
    await post(`${ownerPath}/companies`, { code: 'STAFF-CLIENT', name: 'Client Registered by Staff', ...adminCredentials }, { token, status: 201 });
    const active = await request('/api/license', { company: 'STAFF-CLIENT' });
    assert.equal(active.state, 'active');
    const renewal = await post(`${ownerPath}/issue`, { companyCode: 'STAFF-CLIENT', baseTokenId: verifyToken(active.token, publicKey).id }, { token });
    assert.equal(verifyToken(renewal.token, publicKey).termStart, verifyToken(active.token, publicKey).expiresAt);
    for (const enabled of [false, true]) {
      const current = await request('/api/license', { company: 'STAFF-CLIENT' });
      await request(`${ownerPath}/client-access`, { token, method: 'PUT', body: {
        companyCode: 'STAFF-CLIENT', baseTokenId: verifyToken(current.token, publicKey).id, active: enabled,
        startsAt: new Date(Date.now() - 86400000).toISOString(),
        expiresAt: verifyToken(renewal.token, publicKey).expiresAt, reason: 'Platform administrator access adjustment'
      } });
      assert.equal((await request('/api/license', { company: 'STAFF-CLIENT' })).state, enabled ? 'active' : 'inactive');
    }
    await request(`${ownerPath}/password`, { token, method: 'PUT', body: { currentPassword: 'staff-password-123', newPassword: 'staff-changed-password-123' } });
    await request(`${ownerPath}/dashboard`, { token, status: 401 });
    await post(`${ownerPath}/login`, { username: 'staff-admin', password: 'staff-password-123' }, { status: 401 });
    const databaseClient = new Client({ connectionString: url.href });
    await databaseClient.connect();
    try {
      const { rows } = await databaseClient.query('SELECT session_version,password_hash FROM platform_staff WHERE id=$1', [staff.id]);
      assert(await require('bcryptjs').compare('staff-changed-password-123', rows[0].password_hash));
      const staffToken = require('jsonwebtoken').sign({ version: rows[0].session_version },
        Buffer.from(crypto.hkdfSync('sha256', serverSecret, 'PrimeOps-owner', 'owner-session-v1', 32)),
        { subject: `staff:${staff.id}`, issuer: 'primeops-licence-owner', algorithm: 'HS256', expiresIn: '2h' });
      await request(`${ownerPath}/dashboard`, { token: staffToken });
      await request(`${ownerPath}/staff/${staff.id}`, { token: owner, method: 'PUT', body: { active: false } });
      await request(`${ownerPath}/dashboard`, { token: staffToken, status: 401 });
      await request(`${ownerPath}/staff/${staff.id}`, { token: owner, method: 'PUT', body: { active: true, password: 'reset-staff-password-123' } });
      await request(`${ownerPath}/dashboard`, { token: staffToken, status: 401 });
      assert(await require('bcryptjs').compare('reset-staff-password-123', (await databaseClient.query('SELECT password_hash FROM platform_staff WHERE id=$1', [staff.id])).rows[0].password_hash));
      await assert.rejects(require('./reset-platform-admin.cjs').resetAdministrator(databaseClient, 'staff-admin', 'cannot-collide-password'), /staff member/);
    } finally { await databaseClient.end(); }
    const listed = await request(`${ownerPath}/staff`, { token: owner });
    assert.equal(listed.owner.displayName, 'Platform Founder');
    assert(listed.staff.some((user) => user.id === staff.id && user.active));
    assert.equal((await request('/api/subscription', { company: 'BROLL', token: b })).activeUsers, companyBefore.activeUsers);
    assert.equal((await request('/api/license', { company: 'BROLL' })).token, currentLicence.token);
    await request(`${ownerPath}/dashboard`, { token: owner });
  });
  await t.test('manual client status and signed dates enforce access without affecting other clients', async () => {
    await post(`${ownerPath}/companies`, { code: 'ACCESS-DATES', name: 'Manual Access Test', ...adminCredentials }, { token: owner, status: 201 });
    const original = await request('/api/license', { company: 'ACCESS-DATES' });
    const other = await request('/api/license', { company: 'BROLL' });
    const tokenId = (licence) => verifyToken(licence.token, publicKey).id;
    const now = Date.now();
    const startsAt = new Date(now - 86400000).toISOString();
    const expiresAt = new Date(now + 90 * 86400000).toISOString();
    const body = { companyCode: 'ACCESS-DATES', active: false, startsAt, expiresAt, baseTokenId: tokenId(original), reason: 'Manual suspension for testing' };
    await request(`${ownerPath}/client-access`, { token: b, method: 'PUT', body, status: 401 });
    await request(`${ownerPath}/client-access`, { token: owner, method: 'PUT', body: { ...body, expiresAt: startsAt }, status: 400 });
    await request(`${ownerPath}/client-access`, { token: owner, method: 'PUT', body: { ...body, reason: '' }, status: 400 });
    await request(`${ownerPath}/client-access`, { token: owner, method: 'PUT', body });
    const inactive = await request('/api/license', { company: 'ACCESS-DATES' });
    assert.equal(inactive.state, 'inactive');
    assert.equal(verifyToken(inactive.token, publicKey).active, false);
    await post('/api/auth/login', { email: adminCredentials.adminUsername, password: adminCredentials.adminPassword }, { company: 'ACCESS-DATES', status: 423 });
    await post('/api/license/renew', { mode: 'test', username: adminCredentials.adminUsername, password: adminCredentials.adminPassword, baseTokenId: tokenId(inactive) }, { company: 'ACCESS-DATES', status: 423 });
    await post(`${ownerPath}/issue`, { companyCode: 'ACCESS-DATES', baseTokenId: tokenId(inactive) }, { token: owner, status: 409 });
    const platform = await request(`${ownerPath}/dashboard?scope=platform`, { token: owner });
    assert.equal(platform.companies.find((client) => client.code === 'ACCESS-DATES').active, false);
    assert.equal((await request(`${ownerPath}/dashboard?companyCode=ACCESS-DATES`, { token: owner })).licence.state, 'inactive');
    await request(`${ownerPath}/client-access`, { token: owner, method: 'PUT', body: { ...body, active: true }, status: 409 });
    const update = async (changes) => {
      const current = await request('/api/license', { company: 'ACCESS-DATES' });
      await request(`${ownerPath}/client-access`, { token: owner, method: 'PUT', body: { ...body, active: true, baseTokenId: tokenId(current), ...changes } });
      return request('/api/license', { company: 'ACCESS-DATES' });
    };
    assert.equal((await update({ startsAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-02-01T00:00:00.000Z' })).state, 'expired');
    assert.equal((await update({ startsAt: new Date(now + 86400000).toISOString() })).state, 'scheduled');
    await post('/api/auth/login', { email: adminCredentials.adminUsername, password: adminCredentials.adminPassword }, { company: 'ACCESS-DATES', status: 423 });
    const active = await update({});
    assert.equal(active.state, 'active');
    assert.equal(verifyToken(active.token, publicKey).termStart, startsAt);
    assert.equal(verifyToken(active.token, publicKey).expiresAt, expiresAt);
    const user = (await post('/api/auth/login', { email: adminCredentials.adminUsername, password: adminCredentials.adminPassword }, { company: 'ACCESS-DATES' })).token;
    await post('/api/license/activate', { token: original.token }, { company: 'ACCESS-DATES', status: 400 });
    assert.equal((await request('/api/license', { company: 'BROLL' })).token, other.token);
    const client = new Client({ connectionString: url.href });
    await client.connect();
    try {
      const { rows } = await client.query("SELECT schema_name FROM companies WHERE code='ACCESS-DATES'");
      assert.equal((await client.query(`SELECT COUNT(*)::INTEGER AS count FROM "${rows[0].schema_name}".licence_adjustments`)).rows[0].count, 4);
      assert.equal((await client.query(`SELECT changed_by FROM "${rows[0].schema_name}".licence_adjustments LIMIT 1`)).rows[0].changed_by, 'owner');
      assert.equal((await client.query(`SELECT COUNT(*)::INTEGER AS count FROM "${rows[0].schema_name}".app_users`)).rows[0].count, 1);
      const table = `"${rows[0].schema_name}".licence_adjustments`;
      await client.query(`ALTER TABLE ${table} ADD CONSTRAINT test_audit_failure CHECK(reason <> 'rollback-test')`);
      try {
        await request(`${ownerPath}/client-access`, { token: owner, method: 'PUT',
          body: { ...body, baseTokenId: tokenId(active), reason: 'rollback-test' }, status: 503 });
        assert.equal((await request('/api/license', { company: 'ACCESS-DATES' })).token, active.token);
        assert.equal((await client.query("SELECT active FROM companies WHERE code='ACCESS-DATES'")).rows[0].active, true);
        await request('/api/auth/me', { company: 'ACCESS-DATES', token: user });
      } finally { await client.query(`ALTER TABLE ${table} DROP CONSTRAINT test_audit_failure`); }
    } finally { await client.end(); }
    let primary = await request('/api/license');
    for (const enabled of [false, true]) {
      await request(`${ownerPath}/client-access`, { token: owner, method: 'PUT', body: {
        ...body, companyCode: bootstrap.code, baseTokenId: tokenId(primary), active: enabled
      } });
      primary = await request('/api/license');
      assert.equal(primary.state, enabled ? 'active' : 'inactive');
      await request(`${ownerPath}/dashboard?scope=platform`, { token: owner });
      if (!enabled) await request('/api/auth/me', { status: 423 });
    }
  });
  await t.test('local platform password reset preserves client accounts and licences and revokes old sessions', async () => {
    // Keep recovery assertions outside the preceding sign-in rate-limit window.
    await new Promise((resolve) => setTimeout(resolve, 61000));
    const databaseClient = new Client({ connectionString: url.href });
    await databaseClient.connect();
    try {
      const { resetAdministrator } = require('./reset-platform-admin.cjs');
      const before = (await databaseClient.query('SELECT public_key,private_key_encrypted FROM licence_owner WHERE id=1')).rows[0];
      const licence = await request('/api/license', { company: 'BROLL' });
      await assert.rejects(resetAdministrator(databaseClient, 'primeops-admin', 'short'), /12-72 bytes/);
      assert.equal(await resetAdministrator(databaseClient, 'primeops-admin', 'new-platform-password-123'), 'primeops-admin');
      assert.deepEqual((await databaseClient.query('SELECT public_key,private_key_encrypted FROM licence_owner WHERE id=1')).rows[0], before);
      assert.equal((await request('/api/license', { company: 'BROLL' })).token, licence.token);
      await request(`${ownerPath}/dashboard`, { token: owner, status: 401 });
      await post(`${ownerPath}/login`, { username: 'owner', password: 'owner-password-123' }, { status: 401 });
      const administrator = (await post(`${ownerPath}/login`, { username: 'primeops-admin', password: 'new-platform-password-123' })).token;
      await request(`${ownerPath}/dashboard`, { token: administrator });
      await request(`${ownerPath}/password`, { method: 'PUT', body: { currentPassword: 'new-platform-password-123', newPassword: 'changed-platform-password-123' }, status: 401 });
      await request(`${ownerPath}/password`, { token: b, method: 'PUT', body: { currentPassword: adminCredentials.adminPassword, newPassword: 'changed-platform-password-123' }, status: 401 });
      await request(`${ownerPath}/password`, { token: administrator, method: 'PUT', body: { currentPassword: 'wrong-password', newPassword: 'changed-platform-password-123' }, status: 403 });
      await request(`${ownerPath}/password`, { token: administrator, method: 'PUT', body: { currentPassword: 'new-platform-password-123', newPassword: 'short' }, status: 400 });
      await request(`${ownerPath}/password`, { token: administrator, method: 'PUT', body: { currentPassword: 'new-platform-password-123', newPassword: 'new-platform-password-123' }, status: 400 });
      if (process.env.CHROMIUM) {
        const { cdp, evaluate, waitFor, errors } = await require('./browser-test-helper.cjs').browserSession(t, process.env.CHROMIUM, ['--headless']);
        await cdp('Page.navigate', { url: `${adminBase}/admin/` });
        await waitFor('document.querySelector("#login-section")?.hidden === false && !document.querySelector("#login button").disabled');
        await evaluate(`document.querySelector('#login [name=username]').value='primeops-admin';
          document.querySelector('#login [name=password]').value='new-platform-password-123';
          document.querySelector('#login').requestSubmit()`);
        await waitFor('!document.querySelector("#dashboard").hidden && !document.querySelector("#home-button").disabled');
        await evaluate(`document.querySelector('[data-tab=security]').click();
          document.querySelector('#password-form [name=currentPassword]').value='new-platform-password-123';
          document.querySelector('#password-form [name=newPassword]').value='changed-platform-password-123';
          document.querySelector('#password-form [name=confirmPassword]').value='mismatch-password-123';
          document.querySelector('#password-form').requestSubmit()`);
        await waitFor('document.querySelector("#status").textContent==="New passwords do not match." && !document.querySelector("#password-form button").disabled');
        await evaluate(`document.querySelector('#password-form [name=confirmPassword]').value='changed-platform-password-123';
          document.querySelector('#password-form').requestSubmit()`);
        await waitFor('!document.querySelector("#login-section").hidden && document.querySelector("#status").textContent.includes("Administrator password changed")');
        assert.deepEqual(errors, []);
      } else {
        await request(`${ownerPath}/password`, { token: administrator, method: 'PUT', body: { currentPassword: 'new-platform-password-123', newPassword: 'changed-platform-password-123' } });
      }
      await request(`${ownerPath}/dashboard`, { token: administrator, status: 401 });
      await post(`${ownerPath}/login`, { username: 'primeops-admin', password: 'new-platform-password-123' }, { status: 401 });
      await post(`${ownerPath}/login`, { username: 'primeops-admin', password: 'changed-platform-password-123' });
      assert.deepEqual((await databaseClient.query('SELECT public_key,private_key_encrypted FROM licence_owner WHERE id=1')).rows[0], before);
      assert.equal((await request('/api/license', { company: 'BROLL' })).token, licence.token);
      await post('/api/auth/login', { email: 'same-admin', password: adminCredentials.adminPassword }, { company: 'BROLL' });
    } finally { await databaseClient.end(); }
  });
});
