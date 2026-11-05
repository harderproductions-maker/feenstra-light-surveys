import catalog from './operations-catalog.json' with { type: 'json' };
import { isManagementRole } from './account-access.mjs';
import { sectionTabs, sectionPanel } from './section-navigation.mjs';
import { wireOperationTools } from './operations-tools.mjs';

export const operationIds = catalog.map((module) => module.id);
export function residentLabel(settings, plural = false, type) {
  const mode = settings?.residentMode || 'students';
  if (mode === 'both' && !type) return plural ? 'Students / tenants' : 'Student / tenant';
  const tenant = mode === 'tenants' || (mode === 'both' && type === 'tenant');
  return tenant ? (plural ? 'Tenants' : 'Tenant') : (plural ? 'Students' : 'Student');
}
export function residentTypeField(settings, selected = 'student') {
  return settings?.residentMode === 'both'
    ? `<label>Resident type<select name="residentType"><option value="student"${selected === 'student' ? ' selected' : ''}>Student</option><option value="tenant"${selected === 'tenant' ? ' selected' : ''}>Tenant</option></select></label>` : '';
}
export function createOperationsView({ workspace, apiRequest, getUser, getContext, escape, readers, printDocument, canCreateAssetTickets }) {
  let records = [], properties = [], module, context, editing = null, busy = false;
  const manager = () => isManagementRole(getUser()?.role);
  const tools = wireOperationTools({ workspace, apiRequest, getContext, run: (work) => action(work), refresh: render, readers, printDocument,
    getRecords: () => records, getProperties: () => properties, manager, canCreateAssetTickets });
  const text = (value) => String(value).replaceAll('_', ' ');
  const localInput = (iso) => {
    const date = new Date(iso);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  function fieldHtml(field) {
    const attributes = `name="${field.id}" ${field.required ? 'required' : ''} ${field.max ? `maxlength="${field.max}"` : ''}`;
    const input = field.type === 'select'
      ? `<select ${attributes}>${field.options.map((value) => `<option value="${value}">${escape(text(value))}</option>`).join('')}</select>`
      : field.type === 'textarea' ? `<textarea ${attributes} rows="3"></textarea>`
        : `<input ${attributes} type="${field.type}" ${field.type === 'number' ? 'min="0" step="any"' : ''} />`;
    return `<label>${escape(field.label)}${input}</label>`;
  }
  function transitions(row) {
    const options = module.transitions[row.status] || [];
    if (manager() || (module.id === 'assets' && getUser().role === 'maintenance_assistant')) return options;
    return module.id === 'residents' && row.created_by === getUser().id ? options.filter((status) => status === 'cancelled') : [];
  }
  function recordHtml(row) {
    return `<article class="storage-panel operation-record" data-operation-record="${escape(row.id)}">
      <h3>${escape(row.data.subject || row.data.visitorName || row.data.name || row.data.meterReference)}</h3>
      <p><strong>${escape(text(row.status))}</strong> · ${escape(row.building_name)} · ${escape(row.created_by_name)}${row.unit_number ? ` · Unit ${escape(row.unit_number)}` : ''}</p>
      <dl class="operation-details">${module.fields.map((field) => {
        const value = row.data[field.id];
        const formatted = value && field.type === 'datetime-local' ? new Date(value).toLocaleString() : value;
        return value === '' || value === undefined ? '' : `<div><dt>${escape(field.label)}</dt><dd>${escape(formatted)}</dd></div>`;
      }).join('')}</dl>
      ${tools.recordMarkup(row)}
      <div class="operation-actions">${transitions(row).map((status) => `<button class="button secondary" type="button" data-operation-status-change="${status}">${escape(text(status))}</button>`).join('')}
      ${manager() && ['assets', 'contractors'].includes(module.id) ? '<button class="button secondary" type="button" data-operation-edit>Edit details</button>' : ''}</div>
      <details><summary>History</summary><ul>${row.events.map((event) => `<li>${escape(text(event.action))} · ${escape(event.actor)} · ${escape(new Date(event.at).toLocaleString())}</li>`).join('')}</ul></details>
    </article>`;
  }
  async function render(kind, message = '') {
    const expected = getContext();
    const selected = catalog.find((item) => item.id === kind);
    if (!selected) throw new Error('Unknown operation type.');
    workspace.innerHTML = '<p role="status">Loading client operations...</p>';
    try {
      const [data, buildingData] = await Promise.all([apiRequest(`/api/operations/${kind}`), apiRequest('/api/properties')]);
      if (expected !== getContext()) return;
      module = selected; records = data.records; properties = buildingData.properties; context = expected; editing = null;
      const title = kind === 'residents' ? residentLabel(data.settings, true) : module.name;
      const id = `operation-${kind}`;
      const securityPhone = data.settings.securityPhone.replace(/[^+0-9]/g, '');
      workspace.innerHTML = `<section class="operations-view" data-operation="${kind}" data-section-group="${id}">
        <p class="eyebrow">${kind === 'residents' ? 'RESIDENT SERVICES' : 'OPERATIONS'}</p><h1>${escape(title)}</h1>
        <p>Records belong to a building. Only your assigned buildings are available. These screens require a connection.</p>
        ${kind === 'security' ? `<section class="storage-panel"><h2>Call security</h2>${securityPhone ? `<a class="button primary" href="tel:${escape(securityPhone)}">Call security: ${escape(data.settings.securityPhone)}</a>` : '<p>Your client administrator has not configured a security number. Ask the office for the correct contact.</p>'}
          <p>In-app messages/reports are handled by your client administrators and managers. They are not an emergency dispatch service; call for urgent assistance.</p></section>` : ''}
        ${kind === 'residents' ? '<p>Register an expected visitor. A client administrator/manager must approve the visit before check-in. They record arrival and departure.</p>' : ''}
        ${sectionTabs(id, `${title} sections`, [['register', kind === 'residents' ? 'Register visitor' : kind === 'security' ? 'Message / report' : 'Add record'], ['records', kind === 'residents' ? 'Visits & approvals' : kind === 'meters' ? 'Reading history' : 'Records']], manager() ? 'records' : 'register')}
        <p data-operation-status role="status">${escape(message)}</p>
        ${tools.markup(kind, records)}
        <section ${sectionPanel(id, 'register')}>
          <form class="account-create-form" data-operation-form>
            <label>Building<select name="propertyId" required>${properties.length !== 1 ? '<option value="">Choose an assigned building</option>' : ''}${properties.map((property) => `<option value="${escape(property.id)}">${escape(property.name)}</option>`).join('')}</select></label>
            ${module.fields.map(fieldHtml).join('')}
            ${kind === 'meters' ? '<label>Clear meter photo (optional)<input type="file" name="meterPhoto" accept="image/jpeg,image/png,image/webp" /></label>' : ''}
            <button class="button primary" type="submit">${kind === 'residents' ? 'Register visitor for approval' : 'Save record'}</button>
            <button class="button secondary" type="button" data-operation-cancel-edit hidden>Cancel edit</button>
          </form>
        </section><section ${sectionPanel(id, 'records')}>
          <label>Search records<input type="search" data-operation-search placeholder="Building, name, reference or status" /></label>
          <div data-operation-list>${records.map(recordHtml).join('') || '<p>No records yet.</p>'}</div>
        </section></section>`;
    } catch (error) {
      if (expected !== getContext()) return;
      workspace.innerHTML = `<h1>${escape(selected.name)}</h1><p role="alert">${escape(error.message || 'Client operations could not load. Reconnect and retry.')}</p><button class="button secondary" type="button" data-operation-retry="${kind}">Retry</button>`;
    }
  }
  async function action(work) {
    if (busy || context !== getContext()) return;
    const expected = context;
    busy = true;
    workspace.querySelectorAll('button, input, select, textarea').forEach((input) => { input.disabled = true; });
    try { await work(); }
    catch (error) {
      if (expected === getContext()) workspace.querySelector('[data-operation-status]').textContent = error.message || 'Could not save this record. Retry.';
    } finally {
      busy = false;
      if (expected === getContext()) {
        workspace.querySelectorAll('button, input, select, textarea').forEach((input) => { input.disabled = false; });
        if (editing) workspace.querySelector('[name=propertyId]').disabled = true;
      }
    }
  }
  workspace.addEventListener('submit', (event) => {
    if (!event.target.matches('[data-operation-form]')) return;
    event.preventDefault();
    if (context !== getContext()) return;
    const values = new FormData(event.target);
    const data = Object.fromEntries(module.fields.map((field) => {
      const value = values.get(field.id);
      return [field.id, field.type === 'number' ? (value === '' ? '' : Number(value)) : field.type === 'datetime-local' && value ? new Date(value).toISOString() : value];
    }));
    const kind = module.id, expected = context, record = editing;
    const files = [...(event.target.elements.meterPhoto?.files || [])];
    void action(async () => {
      const photos = files.length ? await tools.checkedPhotos(files) : [];
      if (expected !== getContext()) return;
      await apiRequest(`/api/operations/${kind}${record ? `/${record.id}` : ''}`, {
        method: record ? 'PUT' : 'POST',
        body: record ? { revision: record.revision, data } : { propertyId: values.get('propertyId'), data, photos }
      });
      if (expected === getContext()) await render(kind, 'Saved. Use Records to view the current status and history.');
    });
  });
  workspace.addEventListener('input', (event) => {
    if (!event.target.matches('[data-operation-search]')) return;
    const query = event.target.value.toLowerCase();
    workspace.querySelectorAll('[data-operation-record]').forEach((row) => { row.hidden = !row.textContent.toLowerCase().includes(query); });
  });
  workspace.addEventListener('click', (event) => {
    const retry = event.target.closest('[data-operation-retry]');
    if (retry) { void render(retry.dataset.operationRetry); return; }
    if (context !== getContext() || !workspace.querySelector('[data-operation]')) return;
    if (event.target.closest('[data-operation-cancel-edit]')) { void render(module.id); return; }
    const rowElement = event.target.closest('[data-operation-record]');
    const row = rowElement && records.find((record) => record.id === rowElement.dataset.operationRecord);
    if (!row) return;
    if (event.target.closest('[data-operation-edit]')) {
      editing = row;
      workspace.querySelector('[data-section-tab=register]').click();
      const form = workspace.querySelector('[data-operation-form]');
      form.elements.propertyId.value = row.property_id;
      form.elements.propertyId.disabled = true;
      for (const field of module.fields) form.elements[field.id].value = field.type === 'datetime-local' && row.data[field.id] ? localInput(row.data[field.id]) : row.data[field.id];
      form.querySelector('[type=submit]').textContent = 'Save changes';
      form.querySelector('[data-operation-cancel-edit]').hidden = false;
      return;
    }
    const change = event.target.closest('[data-operation-status-change]');
    if (change) {
      const kind = module.id, expected = context, status = change.dataset.operationStatusChange;
      void action(async () => {
        await apiRequest(`/api/operations/${kind}/${row.id}`, { method: 'PUT', body: { status, revision: row.revision } });
        if (expected === getContext()) await render(kind, 'Status updated.');
      });
    }
  });
  return { render };
}
