import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { sectionTabs, sectionPanel, resetSectionTabs } from './section-navigation.mjs';
import { isManagementRole, isManagerRole } from './account-access.mjs';

const source = await fs.readFile(new URL('./app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function renderTickets()');
const end = source.indexOf('\nasync function stopTicketCamera()', start);
const renderer = source.slice(start, end);
const statuses = ['submitted', 'assigned', 'in_progress', 'awaiting_stock', 'awaiting_access', 'out_of_stock', 'contractor', 'completed'];
const tickets = statuses.map((status) => ({
  id: `ticket-${status}`, status, subject: `Subject ${status}`, property_id: 'building',
  building_name: 'Example building', unit_number: 'A1', description: 'Inspection required',
  created_by_name: 'Student', created_at: '2026-10-30T09:00:00Z', updated_at: '2026-10-30T10:00:00Z',
  events: [{ event: 'Reply', actor: 'Manager', at: '2026-10-30T10:00:00Z', detail: 'History preserved' }],
  ...(status === 'completed' ? { completed_at: '2026-10-30T10:00:00Z', has_completion_photo: true } : {})
}));

function setup({ list = 'active', role = 'maintenance_manager', records = tickets, offline = false } = {}) {
  resetSectionTabs();
  const calls = [];
  const context = vm.createContext({
    ticketFormDirty: true, currentView: 'tickets', ticketListView: list, ticketRecords: [], isManagementRole, isManagerRole,
    ticketSignature: '', currentUser: { role }, state: { properties: [{ id: 'building', name: 'Example building' }] }, sectionTabs, sectionPanel,
    openTicketThreads: new Set(['ticket-completed']), workspace: { innerHTML: '' },
    escapeHtml: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    formatDateTime: (value) => value, ticketStatusLabels: { completed: 'Completed', in_progress: 'In progress' },
    apiRequest: async (path) => {
      calls.push(path);
      return path === '/api/tickets' ? { tickets: structuredClone(records), offline_copy: offline } : { assistants: [] };
    }
  });
  vm.runInContext(renderer, context);
  return { context, calls, render: () => context.renderTickets() };
}

test('active ticket inbox excludes completed work but keeps every unfinished status', async () => {
  const app = setup();
  await app.render();
  const html = app.context.workspace.innerHTML;
  assert(!html.includes('data-ticket-thread="ticket-completed"'));
  for (const status of statuses.filter((status) => status !== 'completed')) {
    assert(html.includes(`data-ticket-thread="ticket-${status}"`), status);
  }
  assert(html.includes('Active tickets (7)'));
  assert(html.includes('Archive (1)'));
  assert(html.includes('data-ticket-list="active" aria-pressed="true"'));
  assert.equal(app.context.ticketRecords.length, 8);
  assert(app.context.ticketSignature.includes('ticket-completed'));
  assert.equal(app.calls.filter((path) => path.startsWith('/api/ticket-assignees')).length, 1);
});

test('ticket creators see assignment and assistant name in the collapsed heading, including in-progress work', async () => {
  for (const role of ['user', 'maintenance_manager', 'admin', 'maintenance_assistant']) {
    const records = [{ ...tickets.find((ticket) => ticket.status === 'in_progress'),
      assigned_to: 'assistant', assigned_to_name: '<Alex & Team>' }];
    const app = setup({ role, records });
    await app.render();
    const html = app.context.workspace.innerHTML;
    const summary = html.slice(html.indexOf('<summary>'), html.indexOf('</summary>'));
    assert(summary.includes('Assigned to Maintenance Assistant:'));
    assert(summary.includes('&lt;Alex &amp; Team>'));
    assert(summary.includes('In progress'));
    assert(!summary.includes('<Alex'));
    assert.equal(html.includes('<option value="in_progress">In progress</option>'), ['admin', 'maintenance_manager'].includes(role));
  }
});

test('archive retains completed ticket details, history and photo without fetching assignment choices', async () => {
  for (const role of ['admin', 'maintenance_manager', 'maintenance_assistant', 'user']) {
    const app = setup({ list: 'archive', role });
    await app.render();
    const html = app.context.workspace.innerHTML;
    assert(html.includes('Completed ticket archive'));
    assert.match(html, /data-ticket-thread="ticket-completed"[^>]*\bopen/);
    assert(!html.includes('data-ticket-thread="ticket-assigned"'));
    assert(html.includes('History preserved'));
    assert(html.includes('data-ticket-photo="ticket-completed"'));
    assert(!html.includes('class="ticket-assignment-form"'));
    assert(!html.includes('data-ticket-capture='));
    assert(html.includes('Archive (1)'));
    assert.deepEqual(app.calls, ['/api/tickets']);
  }
});

test('offline completion moves a pending ticket to archive without dropping its evidence', async () => {
  const app = setup({ records: [tickets[1]], offline: true });
  await app.render();
  assert(app.context.workspace.innerHTML.includes('data-ticket-thread="ticket-assigned"'));
  const completed = { ...tickets.at(-1), id: 'ticket-assigned', pending_sync: true };
  app.context.apiRequest = async () => ({ tickets: [completed], offline_copy: true });
  await app.render();
  assert(!app.context.workspace.innerHTML.includes('data-ticket-thread="ticket-assigned"'));
  assert(app.context.workspace.innerHTML.includes('Active tickets (0)'));
  assert(app.context.workspace.innerHTML.includes('Archive (1)'));
  app.context.ticketListView = 'archive';
  await app.render();
  const html = app.context.workspace.innerHTML;
  assert(html.includes('data-ticket-thread="ticket-assigned"'));
  assert(html.includes('Saved on this device - not yet confirmed by the server.'));
  assert(html.includes('data-ticket-photo="ticket-assigned"'));
  assert(html.includes('History preserved'));
});

test('each list has its own empty state', async () => {
  for (const list of ['active', 'archive']) {
    const app = setup({ list, records: [] });
    await app.render();
    assert(app.context.workspace.innerHTML.includes(list === 'archive'
      ? 'No completed tickets in the archive yet.' : 'No active tickets. Completed work is available in Archive.'));
  }
});

test('an earlier request cannot replace the selected list after switching', async () => {
  const app = setup();
  let release;
  app.context.apiRequest = () => new Promise((resolve) => { release = resolve; });
  const activeRequest = app.render();
  app.context.ticketListView = 'archive';
  app.context.workspace.innerHTML = 'Archive selected';
  release({ tickets: structuredClone(tickets) });
  await activeRequest;
  assert.equal(app.context.workspace.innerHTML, 'Archive selected');
});
