import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildingQuoteRequests, quoteEmailDraft, quoteMailto, validateQuoteContacts, validQuoteEmail } from './parts-quotes.mjs';
import { projectView } from './offline-views.mjs';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

const properties = [{ id: 'a', name: 'North' }, { id: 'b', name: 'South' }];
const contacts = properties.map((property) => ({ property_id: property.id, email: `${property.id}@building.example`,
  suppliers: [{ name: 'Supplier one', email: 'one@supplier.example' }, { name: 'Supplier two', email: 'two@supplier.example' }] }));
const report = (id, propertyId, quantity) => ({ id, property_id: propertyId, building_name: 'untrusted label', created_at: '2026-10-30',
  entries: [{ machineNumber: '12', modelNumber: 'Model', parts: [{ id: 'part', name: 'Belt', part_number: 'B100', quantity }] }] });

test('quotation requests keep each building separate and aggregate item quantities with machine and report references', () => {
  const requests = buildingQuoteRequests([report('one', 'a', 2), report('two', 'a', 3), report('three', 'b', 4)], contacts, properties);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].replyTo, 'a@building.example');
  assert(requests[0].text.includes('Quantity: 5'));
  assert(requests[0].text.includes('Machine 12; model Model; report one'));
  assert(!requests[0].text.includes('report three'));
  assert(!requests[0].html.includes('South'));
  assert(!requests[0].html.includes('untrusted label'));
  assert(requests[1].text.includes('Quantity: 4'));
});

test('every supplier email uses Bcc alone, never exposes another supplier, and directs replies to the building', () => {
  const [request] = buildingQuoteRequests([report('one', 'a', 2)], contacts, properties);
  for (const supplier of request.suppliers) {
    const url = new URL(quoteMailto(request, supplier));
    assert.equal(decodeURIComponent(url.pathname), request.replyTo);
    assert.equal(url.searchParams.get('bcc'), supplier.email);
    assert.equal(url.searchParams.get('cc'), null);
    const other = request.suppliers.find((item) => item.email !== supplier.email);
    assert(!quoteMailto(request, supplier).includes(encodeURIComponent(other.email)));
    const draft = quoteEmailDraft(request, supplier);
    assert(draft.startsWith(`To: ${request.replyTo}\r\nBcc: ${supplier.email}\r\nReply-To: ${request.replyTo}\r\n`));
    assert(!draft.includes(other.email));
    assert(!draft.includes('\r\nCc:'));
    assert(draft.includes('Content-Disposition: attachment; filename="Parts-quote-North.html"'));
    assert(draft.includes('X-Unsent: 1'));
    const plainBase64 = draft.split('Content-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0];
    assert(Buffer.from(plainBase64, 'base64').toString('utf8').includes('Send your quotation directly to the BUILDING EMAIL: a@building.example'));
  }
});

test('email draft attachment retains UTF-8 parts text and escapes building HTML', () => {
  const p = [{ id: 'a', name: '<North> & café' }];
  const [request] = buildingQuoteRequests([report('one', 'a', 2)], contacts, p);
  const draft = quoteEmailDraft(request, request.suppliers[0]);
  const htmlBase64 = draft.split('Content-Transfer-Encoding: base64\r\n\r\n')[2].split('\r\n--')[0];
  const html = Buffer.from(htmlBase64, 'base64').toString('utf8');
  assert(html.includes('&lt;North&gt; &amp; café'));
  assert(!html.includes('<North>'));
});

test('invalid recipients, duplicate supplier emails and header injection are rejected', () => {
  for (const invalid of [
    { email: 'not-an-email', suppliers: [] },
    { email: 'ok@building.example\r\nBcc: bad@example.com', suppliers: [] },
    { email: 'ok@building.example', suppliers: [{ name: 'Bad\nName', email: 'bad@example.com' }] },
    { email: 'ok@building.example', suppliers: [{ name: 'One', email: 'a@example.com' }, { name: 'Two', email: 'A@example.com' }] },
    { email: 'ok@building.example', suppliers: [{ name: 'One', email: 'a@example.com,b@example.com' }] }
  ]) assert.throws(() => validateQuoteContacts(invalid));
  assert.deepEqual(validateQuoteContacts({ email: ' building@example.com ', suppliers: [{ name: ' Supplier ', email: 'supplier@example.com' }] }),
    { email: 'building@example.com', suppliers: [{ name: 'Supplier', email: 'supplier@example.com' }] });
});

test('requests require accessible buildings, configured contacts and actual parts, and retain offline warnings', () => {
  assert.throws(() => buildingQuoteRequests([], contacts, properties), /Select/);
  assert.throws(() => buildingQuoteRequests([report('one', 'outside', 1)], contacts, properties), /unavailable building/);
  assert.throws(() => buildingQuoteRequests([report('one', 'a', 1)], [], properties), /building quotation email/);
  assert.throws(() => buildingQuoteRequests([{ ...report('one', 'a', 1), entries: [] }], contacts, properties), /no parts/);
  const [pending] = buildingQuoteRequests([{ ...report('one', 'a', 1), pending_sync: true }], contacts, properties);
  assert(pending.provisional);
  assert(pending.text.includes('PROVISIONAL'));
  assert(pending.html.includes('PROVISIONAL'));
});

test('offline supplier contacts are scoped to assigned buildings and never available to technicians', () => {
  const cache = { '/api/building-quote-contacts': { value: { contacts } } };
  assert.deepEqual(projectView('/api/building-quote-contacts', cache, [], { role: 'maintenance_manager', propertyIds: ['a'] }).contacts.map((contact) => contact.property_id), ['a']);
  assert.throws(() => projectView('/api/building-quote-contacts', cache, [], { role: 'technician', propertyIds: ['a'] }), /Manager access/);
});

test('Android composer puts only the building in To and the individual supplier in Bcc', async () => {
  const source = await fs.readFile(new URL('../android-src/SupplierEmailPlugin.java', import.meta.url), 'utf8');
  assert(source.includes('send.putExtra(Intent.EXTRA_EMAIL, new String[] { to })'));
  assert(source.includes('send.putExtra(Intent.EXTRA_BCC, new String[] { bcc })'));
  assert(!source.includes('Intent.EXTRA_CC'));
  assert(source.includes('send.putExtra(Intent.EXTRA_STREAM, uri)'));
  assert(source.includes('Intent.FLAG_GRANT_READ_URI_PERMISSION'));
});

test('desktop mail handler only accepts building To and single supplier Bcc from the app window', async () => {
  const source = await fs.readFile(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  const handlers = new Map(), opened = [];
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = {}; }
    loadURL() {}
  }
  const electron = {
    app: { getPath: () => '/tmp', setPath() {}, whenReady: () => ({ then() {} }), on() {} },
    BrowserWindow: Window, protocol: { registerSchemesAsPrivileged() {} },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    shell: { openExternal: async (url) => opened.push(url) }
  };
  const context = vm.createContext({ require: (name) => name === 'electron' ? electron : importBuiltin(name),
    __dirname: '/tmp', URL, Response });
  function importBuiltin(name) {
    if (name === 'fs') return { existsSync: () => false };
    if (name === './www/legacy-identifiers.json') return { desktopProfile: 'Previous test profile', desktopScheme: 'previous-test' };
    if (name === 'os') return {};
    if (name === 'path') return { join: (...parts) => parts.join('/') };
    if (name === 'url') return {};
    throw new Error(`Unexpected dependency ${name}`);
  }
  // Use the real email validator without requiring an Electron installation.
  const executable = source.replace("const { validQuoteEmail } = await import('./www/parts-quotes.mjs');",
    'const validQuoteEmail = suppliedValidator;');
  context.suppliedValidator = validQuoteEmail;
  vm.runInContext(executable, context);
  vm.runInContext('createMainWindow(); globalThis.sender = mainWindow.webContents;', context);
  const handler = handlers.get('quotes:open-email');
  const [request] = buildingQuoteRequests([report('one', 'a', 2)], contacts, properties);
  const valid = quoteMailto(request, request.suppliers[0]);
  assert((await handler({ sender: {} }, valid)).error);
  assert((await handler({ sender: context.sender }, 'https://example.com')).error);
  assert((await handler({ sender: context.sender }, `${valid}&cc=other%40supplier.example`)).error);
  assert.equal((await handler({ sender: context.sender }, valid)).ok, true);
  assert.equal(opened.length, 1);
});
