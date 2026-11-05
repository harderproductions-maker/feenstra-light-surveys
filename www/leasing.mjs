import { sectionTabs, sectionPanel } from './section-navigation.mjs';
import { readDocumentRows } from './checklist-import.mjs';
import { leasingImportFields, leasingImportTable, leasingImportTypes, leasingImportUpdates, mappedLeasingRows, suggestedImportBuilding, suggestedImportKind } from './leasing-import.mjs';

export function createLeasingView({ workspace, apiRequest, getUser, getContext, escape: e, download, readers }) {
  let context, data, selected = null, detail = null, busy = false;
  let importTable, importRows, importName, importBatch;
  let importBuilding = '';
  const money = (value) => `R${(Number(value) / 100).toFixed(2)}`;
  const today = () => new Date().toISOString().slice(0, 10);
  const options = (rows, label, value = 'id', selectedValue = '') => '<option value="">Choose...</option>' + rows.map((row) =>
    `<option value="${e(row[value])}" ${row[value] === selectedValue ? 'selected' : ''}>${e(label(row))}</option>`).join('');
  const building = (id) => data.properties.find((row) => row.id === id)?.name || id;
  const importType = (kind) => leasingImportTypes.find(([id]) => id === kind)?.[1] || kind;
  const unitName = (id) => { const u = data.units.find((row) => row.id === id); return u ? `${building(u.property_id)} / ${u.unit_number}` : id; };
  const input = (label, name, value = '', type = 'text', attrs = '') => `<label>${label}<input name="${name}" type="${type}" value="${e(value ?? '')}" ${attrs} /></label>`;
  const amount = (label, name, value = 0) => input(label, name, Number(value) / 100, 'number', 'min="0" max="10000000" step="0.01" required');
  const status = (message) => { const el = workspace.querySelector('[data-leasing-status]'); if (el) el.textContent = message; };
  const toCents = (value) => {
    if (!/^\d+(?:\.\d{1,2})?$/.test(String(value))) throw new Error('Enter money with no more than two decimal places.');
    return Math.round(Number(value) * 100);
  };
  const formValues = (form) => Object.fromEntries(new FormData(form));
  async function action(work) {
    if (busy) return;
    const expected = getContext(); busy = true;
    workspace.querySelectorAll('button[type=submit]').forEach((el) => { el.disabled = true; });
    try { await work(); }
    catch (error) { if (expected === getContext()) status(error.message || 'Leasing action failed. Reconnect and retry.'); }
    finally { busy = false; if (expected === getContext()) workspace.querySelectorAll('button[type=submit]').forEach((el) => { el.disabled = false; }); }
  }
  const send = (path, body, method = 'POST') => apiRequest(`/api/leasing${path}`, { method, body });
  async function render(message = '') {
    const expected = getContext(); context = expected;
    workspace.innerHTML = '<p role="status">Loading leasing test workspace...</p>';
    try {
      const result = await apiRequest('/api/leasing');
      if (expected !== getContext()) return;
      data = result;
      if (selected && !data.leases.some((row) => row.id === selected)) selected = null;
      detail = selected ? await apiRequest(`/api/leasing/leases/${selected}`) : null;
      if (expected !== getContext()) return;
      const tabs = [['overview', 'Overview'], ...(data.canManage ? [['registers', 'Buildings & units'], ['tenants', 'Tenants']] : []),
        ['leases', 'Leases & documents'], ['billing', 'TEST billing'], ['schedule', 'Schedules & vacates'], ...(data.canManage ? [['import', 'Import existing data']] : [])];
      workspace.innerHTML = `<section class="leasing-view" data-section-group="leasing">
        <p class="eyebrow">LEASING TEST WORKSPACE</p><h1>Leasing &amp; tenant management</h1>
        <p role="note"><strong>TEST MODE: simulated rent and deposits only.</strong> No real collections or emails. Existing resident billing is not changed. Drawn signatures are auditable test acceptance, not certified digital signatures.</p>
        <div class="operation-actions"><button type="button" data-leasing-refresh>Refresh</button><button type="button" data-leasing-export="pdf">PDF report</button><button type="button" data-leasing-export="xlsx">Excel workbook</button></div>
        <p data-leasing-status role="status" aria-live="polite">${e(message)}</p>
        ${sectionTabs('leasing', 'Leasing sections', tabs)}
        <section ${sectionPanel('leasing', 'overview')}>${overview()}</section>
        ${data.canManage ? `<section ${sectionPanel('leasing', 'registers')}>${registers()}</section><section ${sectionPanel('leasing', 'tenants')}>${tenants()}</section>` : ''}
        <section ${sectionPanel('leasing', 'leases')}>${leases()}</section>
        <section ${sectionPanel('leasing', 'billing')}>${billing()}</section>
        <section ${sectionPanel('leasing', 'schedule')}>${schedule()}</section>
        ${data.canManage ? `<section ${sectionPanel('leasing', 'import')}>${importMarkup()}</section>` : ''}</section>`;
      importTable = null; importRows = null; importBatch = null;
      wireForms();
      if (detail) wireSignature();
    } catch (error) {
      if (expected === getContext()) workspace.innerHTML = `<p role="alert">${e(error.message || 'Could not load leasing.')}</p><button type="button" data-leasing-refresh>Retry</button>`;
    }
  }
  function overview() {
    const counts = data.units.reduce((result, u) => ({ ...result, [u.occupancy_state]: (result[u.occupancy_state] || 0) + 1 }), {});
    return `<h2>Overview &amp; reminders</h2><p>${data.units.length} units | ${data.tenants.length} tenants | ${data.leases.length} leases</p>
      <p>${Object.entries(counts).map(([state, count]) => `${e(state.replaceAll('_', ' '))}: ${count}`).join(' | ')}</p>
      <h3>Expiry reminders (next 90 days and overdue)</h3><ul>${data.reminders.map((r) => `<li>${e(r.leaseNumber)}: ends ${e(r.endsOn)}${r.noticeOn ? ` / notice to vacate ${e(r.noticeOn)}` : ''}</li>`).join('') || '<li>No expiring active leases.</li>'}</ul>
      <h3>Simulated arrears</h3><ul>${data.balances.filter((b) => b.balanceCents > 0).map((b) => `<li>${e(b.leaseNumber)}: ${money(b.balanceCents)} outstanding</li>`).join('') || '<li>No outstanding TEST balance.</li>'}</ul>
      <p>Reminders are in-app only. Use TEST billing to generate due monthly rent through today; it never posts into live billing or sends email. Monthly amounts are full-month, without proration.</p>
      <h3>Upcoming vacates &amp; works</h3><ul>${data.schedule.filter((s) => !['cancelled', 'completed'].includes(s.status)).map((s) => `<li>${e(s.starts_on)} - ${e(s.title)} (${e(s.kind)} / ${e(s.status)})</li>`).join('') || '<li>No planned work.</li>'}</ul>`;
  }
  function registers() {
    const admin = getUser().role === 'admin';
    return `<h2>Properties, buildings &amp; units</h2>
      ${admin ? `<details><summary>Add a portfolio</summary><form data-leasing-form="portfolio">${input('Portfolio name', 'name', '', 'text', 'required maxlength="160"')}<button type="submit">Add portfolio</button></form></details>
      <details><summary>Assign a building to a portfolio</summary><form data-leasing-form="building"><label>Building<select name="id" required>${options(data.properties, (p) => p.name)}</select></label>
      <label>Portfolio<select name="portfolioId">${options(data.portfolios, (p) => p.name)}</select></label><button type="submit">Save assignment</button></form></details>
      <p>Add buildings using Users &gt; Add a building. Existing buildings are reused, not duplicated.</p>` : ''}
      <ul>${data.properties.map((p) => `<li>${e(p.name)} / ${e(data.portfolios.find((f) => f.id === p.portfolio_id)?.name || 'No portfolio')}</li>`).join('')}</ul>
      <details><summary>Add a unit</summary><form data-leasing-form="unit"><label>Building<select name="propertyId" required>${options(data.properties, (p) => p.name)}</select></label>
      ${input('Unit number', 'number', '', 'text', 'required maxlength="80"')}${unitAuditFields()}${input('Description', 'description', '', 'text', 'maxlength="1000"')}<button type="submit">Add unit</button></form></details>
      <p>Audit status is the imported snapshot, not a lease or proof of current occupancy. Live occupancy is calculated from leases and manual states.</p>
      ${data.properties.map((p) => {
        const bays = (data.parking || []).filter((b) => b.property_id === p.id);
        return `<section><h3>${e(p.name)}: building audit (unit schedule)</h3><div style="overflow:auto"><table><thead><tr><th>Unit number</th><th>Floor</th><th>Unit type</th><th>Bedrooms</th><th>Bathrooms</th><th>Parking bays</th><th>Allocated bays (parking audit)</th><th>Floor area (m2)</th><th>Audit status</th><th>Live occupancy</th><th>Building</th></tr></thead><tbody>
      ${data.units.filter((u) => u.property_id === p.id).map((u) => `<tr>${[u.unit_number, u.floor, u.unit_type, u.bedrooms, u.bathrooms, u.parking_bays, u.allocated_parking_bays, u.floor_area, u.audit_status, u.occupancy_state, p.name].map((v) => `<td>${e(v ?? '')}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="11">No units imported for this building.</td></tr>'}</tbody></table></div>
      <h3>${e(p.name)}: parking audit</h3><div style="overflow:auto"><table><thead><tr><th>Bay number</th><th>Level</th><th>Bay type</th><th>Assigned unit</th><th>Status</th><th>Notes</th><th>Building</th></tr></thead><tbody>
      ${bays.map((b) => `<tr>${[b.bay_number, b.level, b.bay_type, b.unit_number, b.status, b.notes, p.name].map((v) => `<td>${e(v ?? '')}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="7">No parking bays imported for this building.</td></tr>'}</tbody></table></div></section>`;
      }).join('')}
      <details><summary>Add a parking bay</summary>${parkingForm()}</details>
      ${(data.parking || []).map((b) => `<details><summary>Parking bay ${e(b.bay_number)} / ${e(building(b.property_id))}${b.unit_number ? ` - unit ${e(b.unit_number)}` : ''}</summary>${parkingForm(b)}</details>`).join('')}
      ${data.units.map((u) => `<details><summary>Unit ${e(u.unit_number)} / ${e(building(u.property_id))} - ${e(u.occupancy_state.replaceAll('_', ' '))}</summary>
      <form data-leasing-form="unit-edit" data-id="${e(u.id)}" data-revision="${u.revision}">${input('Unit number', 'number', u.unit_number, 'text', 'required maxlength="80"')}
      ${input('Description', 'description', u.description, 'text', 'maxlength="1000"')}
      ${unitAuditFields(u)}
      <label>Manual state<select name="state">${[['', 'Automatic occupancy'], ['reserved', 'Reserved'], ['notice_given', 'Notice given'], ['maintenance', 'Maintenance / renovation']].map(([id, title]) =>
        `<option value="${id}" ${id === (u.manual_state || '') ? 'selected' : ''}>${title}</option>`).join('')}</select></label>
      ${input('State reason (required for manual state)', 'reason', u.state_reason, 'text', 'maxlength="2000"')}
      ${input('Reserved until (only for Reserved)', 'reservedUntil', u.reserved_until, 'date')}<button type="submit">Save unit</button></form></details>`).join('') || '<p>No units yet.</p>'}`;
  }
  function parkingForm(b = null) {
    const units = (propertyId) => data.units.filter((u) => !propertyId || u.property_id === propertyId);
    return `<form data-leasing-form="${b ? 'parking-edit' : 'parking'}" ${b ? `data-id="${e(b.id)}" data-revision="${b.revision}"` : ''}>
      ${b ? '' : `<label>Building<select name="propertyId" required>${options(data.properties, (p) => p.name)}</select></label>`}
      ${input('Bay number', 'bayNumber', b?.bay_number, 'text', 'required maxlength="80"')}${input('Level', 'level', b?.level, 'text', 'maxlength="80"')}
      ${input('Bay type', 'bayType', b?.bay_type, 'text', 'maxlength="100"')}
      <label>Assigned unit<select name="unitId"><option value="">Not assigned</option>${units(b?.property_id).map((u) => `<option value="${e(u.id)}" ${u.id === b?.unit_id ? 'selected' : ''}>${e(b ? u.unit_number : `${building(u.property_id)} / ${u.unit_number}`)}</option>`).join('')}</select></label>
      <label>Bay status<select name="status"><option value="">Automatic (allocated when assigned)</option>${['vacant', 'allocated', 'reserved', 'visitor', 'maintenance'].map((state) => `<option ${b?.status === state ? 'selected' : ''}>${state}</option>`).join('')}</select></label>
      ${input('Notes', 'notes', b?.notes, 'text', 'maxlength="1000"')}
      ${b ? '<label class="inline-choice"><input name="remove" type="checkbox" />Remove this bay from the parking audit</label>' : ''}
      <button type="submit">${b ? 'Save parking bay' : 'Add parking bay'}</button></form>`;
  }
  function unitAuditFields(u = {}) {
    return `${input('Floor', 'floor', u.floor, 'text', 'maxlength="80"')}${input('Unit type', 'unitType', u.unit_type, 'text', 'maxlength="100"')}
      ${input('Bedrooms', 'bedrooms', u.bedrooms, 'number', 'min="0" max="100" step="1"')}${input('Bathrooms', 'bathrooms', u.bathrooms, 'number', 'min="0" max="100" step="1"')}
      ${input('Parking bays', 'parkingBays', u.parking_bays, 'number', 'min="0" max="100" step="1"')}${input('Floor area (m2)', 'floorArea', u.floor_area, 'number', 'min="0" max="1000000" step="0.01"')}
      <label>Audit occupancy status<select name="status"><option value="">Not supplied</option>${['vacant', 'occupied', 'reserved', 'maintenance', 'notice_given'].map((state) => `<option value="${state}" ${u.audit_status === state ? 'selected' : ''}>${e(state.replaceAll('_', ' '))}</option>`).join('')}</select></label>`;
  }
  function tenantForm(t = null) {
    return `<form data-leasing-form="${t ? 'tenant-edit' : 'tenant'}" ${t ? `data-id="${e(t.id)}" data-revision="${t.revision}"` : ''}>
      <label>Building<select name="propertyId" required>${options(data.properties, (p) => p.name, 'id', t?.property_id)}</select></label>
      ${input('Tenant code', 'code', t?.tenant_code, 'text', 'required maxlength="80"')}
      ${input('First name', 'firstName', t?.first_name, 'text', 'required maxlength="100"')}${input('Last name', 'lastName', t?.last_name, 'text', 'required maxlength="100"')}
      ${input('Phone', 'phone', t?.phone, 'tel', 'maxlength="40"')}${input('Email', 'email', t?.email, 'email', 'maxlength="254"')}
      <label>Linked resident login (optional; required for tenant signing)<select name="userId">${options(data.users, (u) => `${u.name} (${u.email}) / ${u.unit_number}`, 'id', t?.user_id)}</select></label>
      <label>Status<select name="status">${['pending_approval', 'active', 'former'].map((s) => `<option ${s === t?.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <button type="submit">${t ? 'Save tenant' : 'Add tenant'}</button></form>`;
  }
  function tenants() {
    return `<h2>Tenants &amp; tenant codes</h2><p>Create student/tenant login accounts under Users, then link them here. A leasing profile alone does not create login credentials. Government ID documents are not requested in this test release.</p>
      <details><summary>Add tenant profile</summary>${tenantForm()}</details>
      ${data.tenants.map((t) => `<details><summary>${e(t.tenant_code)} - ${e(t.first_name)} ${e(t.last_name)} (${e(building(t.property_id))})</summary>${tenantForm(t)}</details>`).join('') || '<p>No tenant profiles.</p>'}`;
  }
  function leaseForm(l = null, renewal = false) {
    const start = renewal ? new Date(Date.parse(l.terminated_on || l.ends_on) + 86400000).toISOString().slice(0, 10) : l?.starts_on || today();
    const end = renewal ? '' : l?.ends_on || '';
    const chooseBuilding = getUser().role === 'admin' || data.properties.length > 1;
    const selectedProperty = data.units.find((unit) => unit.id === l?.unit_id)?.property_id || (chooseBuilding ? '' : data.properties[0]?.id || '');
    return `<form data-leasing-form="${l && !renewal ? 'lease-edit' : 'lease'}" ${l && !renewal ? `data-id="${e(l.id)}" data-revision="${l.revision}"` : ''}>
      ${renewal ? `<input type="hidden" name="renewedFromId" value="${e(l.id)}" />` : ''}
      ${input('Lease number', 'number', renewal ? `${l.lease_number}-R` : l?.lease_number, 'text', 'required maxlength="120"')}
      ${chooseBuilding ? `<label>Building<select name="propertyId" data-lease-building required>${options(data.properties, (p) => p.name, 'id', selectedProperty)}</select></label>`
        : `<input type="hidden" name="propertyId" value="${e(selectedProperty)}" />`}
      <label>Unit<select name="unitId" data-lease-unit required>${options(data.units, (u) => unitName(u.id), 'id', l?.unit_id)}</select></label>
      <fieldset><legend>Tenant(s) in the same building</legend>${data.tenants.filter((t) => t.status !== 'former').map((t) =>
        `<label class="inline-choice" data-lease-tenant-building="${e(t.property_id)}"><input type="checkbox" name="tenantIds" value="${e(t.id)}" ${l?.tenant_ids.includes(t.id) ? 'checked' : ''} />${e(t.tenant_code)} - ${e(t.first_name)} ${e(t.last_name)} / ${e(building(t.property_id))}</label>`).join('')}</fieldset>
      ${input('Start date', 'startsOn', start, 'date', 'required')}${input('End date', 'endsOn', end, 'date', 'required')}
      ${amount('Monthly rent (R)', 'rent', l?.monthly_rental_cents)}${amount('Deposit required (R)', 'deposit', l?.deposit_required_cents)}
      <label>Notes<textarea name="notes" maxlength="8000">${e(l?.notes || '')}</textarea></label>
      <button type="submit">${l && !renewal ? 'Save draft' : renewal ? 'Create renewal draft' : 'Create draft lease'}</button></form>`;
  }
  function leases() {
    return `<h2>Leases &amp; documents</h2>
      ${data.canManage ? `<details><summary>Create lease draft</summary>${leaseForm()}</details>
      ${getUser().role === 'admin' ? `<details><summary>Upload standard lease template (PDF or DOCX)</summary><form data-leasing-form="template-upload">
        <input type="file" name="document" accept=".pdf,.docx" required /><p>Upload your approved standard lease. The original is retained unchanged; this test module does not invent or certify legal terms.</p><button type="submit">Upload template</button></form></details>` : ''}
      <ul>${data.templates.map((t) => `<li>${e(t.original_name)} <button type="button" data-document="${e(t.id)}" data-name="${e(t.original_name)}">Download template</button></li>`).join('')}</ul>` : ''}
      <label>Open lease<select data-lease-selector>${options(data.leases, (l) => `${l.lease_number} / ${l.building_name} / ${l.unit_number} / ${l.status}`, 'id', selected)}</select></label>
      ${detail ? leaseDetail() : '<p>Select a lease to review its terms, documents, signatures and audit history.</p>'}`;
  }
  function leaseDetail() {
    const l = detail.lease, manager = data.canManage;
    return `<article data-lease-detail><h3>${e(l.lease_number)} - ${e(l.state)}</h3>
      <p>${e(l.starts_on)} to ${e(l.ends_on)} | Rent ${money(l.monthly_rental_cents)} | Required deposit ${money(l.deposit_required_cents)}</p>
      <p>${e(l.notes)}</p><p>Current version: ${l.revision} | <code style="overflow-wrap:anywhere">${e(detail.documentDigest)}</code></p>
      <div class="operation-actions"><button type="button" data-lease-export="pdf">Lease PDF &amp; audit</button><button type="button" data-lease-export="zip">Original documents + signed audit ZIP</button></div>
      ${manager && l.state === 'draft' ? `<details><summary>Edit draft terms</summary>${leaseForm(l)}</details>
      <form data-leasing-form="lease-action"><input type="hidden" name="action" value="activate" /><p>Activation reserves occupancy for these dates. Sign after activation, since changing the version invalidates earlier acceptance.</p><button type="submit">Activate test lease</button></form>` : ''}
      ${manager && l.state === 'active' ? `<details><summary>Notice or termination</summary><form data-leasing-form="lease-action">
      <label>Action<select name="action"><option value="notice">Record notice &amp; vacate schedule</option><option value="terminate">Terminate lease</option></select></label>
      ${input('Vacate / termination date', 'date', '', 'date', 'required')}${input('Reason', 'reason', '', 'text', 'required maxlength="2000"')}<button type="submit">Save lifecycle change</button></form></details>` : ''}
      ${manager && l.state !== 'draft' ? `<details><summary>Create renewal</summary>${leaseForm(l, true)}</details>` : ''}
      <h4>Lease documents</h4><ul>${detail.documents.map((d) => `<li>${e(d.original_name)} (${d.size} bytes)<button type="button" data-document="${e(d.id)}" data-name="${e(d.original_name)}">Download</button><small style="display:block;overflow-wrap:anywhere">SHA-256 ${e(d.sha256)}</small></li>`).join('') || '<li>No documents attached.</li>'}</ul>
      ${manager ? `<details><summary>Attach document or standard template</summary><form data-leasing-form="document-upload"><input type="file" name="document" accept=".pdf,.docx" required /><button type="submit">Upload document (max 25 MB)</button></form>
      ${data.templates.length ? `<form data-leasing-form="template-attach"><label>Template<select name="templateId" required>${options(data.templates, (t) => t.original_name)}</select></label><button type="submit">Attach unchanged template</button></form>` : ''}<p>Attachments create a new lease version. Earlier signatures remain in history but do not accept the new version.</p></details>` : ''}
      <h4>Electronic signatures</h4><p>Review and download every document before signing. Signing binds the displayed lease terms and document digests. Both parties must sign their own account; a manager cannot impersonate a tenant.</p>
      <ul>${detail.signatures.map((s) => `<li>${e(s.party)}: ${e(s.signer_name)} at ${e(s.signed_at)} - ${s.document_digest === detail.documentDigest ? 'CURRENT VERSION' : 'HISTORICAL VERSION'}</li>`).join('') || '<li>No signatures.</li>'}</ul>
      ${detail.documents.length && l.state !== 'terminated' ? `<form data-leasing-form="signature">${input('Your full name', 'name', getUser().name, 'text', 'required maxlength="160"')}
      <p>Signing as ${manager ? 'landlord representative' : 'linked tenant'}.</p><canvas data-signature width="600" height="180" style="border:1px solid currentColor;width:100%;max-width:600px;touch-action:none;background:white" aria-label="Draw your signature"></canvas>
      <button type="button" data-clear-signature>Clear drawing</button><label class="inline-choice"><input name="consent" type="checkbox" required />${e(detail.consent)}</label><button type="submit">Sign this version</button></form>` : ''}
      <details><summary>Audit history</summary><ul>${detail.events.map((ev) => `<li>${e(ev.created_at)} - ${e(ev.actor || '')}: ${e(ev.action)} ${e(JSON.stringify(ev.detail))}</li>`).join('')}</ul></details></article>`;
  }
  function billing() {
    const l = detail?.lease;
    return `<h2>Simulated rent, deposits &amp; billing</h2><p>Separate TEST ledger linked to the lease, tenant codes and existing resident login. It does not change the live Accounts &amp; billing ledger or collect money. No collection emails are sent.</p>
      <ul>${data.balances.map((b) => `<li>${e(b.leaseNumber)}: TEST balance ${money(b.balanceCents)} / deposit held ${money(b.depositCents)} of ${money(b.depositRequiredCents)}</li>`).join('')}</ul>
      ${!l ? '<p>Open a lease under Leases &amp; documents to manage its simulated ledger.</p>' : `<h3>${e(l.lease_number)}</h3>
      ${data.canManage && data.canBill ? `<details><summary>Generate due recurring rent &amp; charges</summary><form data-leasing-form="billing">
      ${input('Generate through date', 'through', today(), 'date', 'required')}<p>Full monthly rent, no proration. Re-running cannot duplicate a service month. Recurring billing is explicitly run in test mode.</p><button type="submit">Run simulated billing</button></form></details>
      ${l.state === 'draft' ? `<details><summary>Add recurring charge to draft</summary><form data-leasing-form="charge">${input('Description', 'description', '', 'text', 'required maxlength="500"')}
      ${amount('Amount (R)', 'amount')}<label>Frequency<select name="frequency"><option value="monthly">Monthly</option><option value="once_off">Once off</option></select></label>
      ${input('From', 'startsOn', l.starts_on, 'date', 'required')}${input('Through', 'endsOn', l.ends_on, 'date', 'required')}<button type="submit">Add charge</button></form></details>` : ''}
      <details><summary>Record simulated transaction</summary><form data-leasing-form="ledger"><label>Kind<select name="kind">${['charge', 'payment', 'credit', 'deposit_receipt', 'deposit_refund'].map((kind) => `<option>${kind}</option>`).join('')}</select></label>
      ${amount('Amount (R)', 'amount')}${input('Date', 'date', today(), 'date', 'required')}${input('Description / reference', 'description', '', 'text', 'required maxlength="500"')}<button type="submit">Record TEST transaction</button></form></details>` : ''}
      <h4>Recurring charge definitions</h4><ul>${(detail.charges || []).map((c) => `<li>${e(c.description)} / ${money(c.amount_cents)} / ${e(c.frequency)} / ${e(c.starts_on)} to ${e(c.ends_on)}</li>`).join('') || '<li>No extra charges.</li>'}</ul>
      ${data.ledger.filter((row) => row.lease_id === l.id).map((row) => `<article class="storage-panel"><p>${e(row.entry_date)} / ${e(row.kind)} / ${money(row.amount_cents)} / ${e(row.description)}${row.voided_at ? ` / VOID: ${e(row.void_reason)}` : ''}</p>
      ${!row.voided_at && data.canManage && data.canBill ? `<form data-leasing-form="void" data-entry="${e(row.id)}">${input('Void reason', 'reason', '', 'text', 'required maxlength="500"')}<button type="submit">Void TEST entry</button></form>` : ''}</article>`).join('')}`}`;
  }
  function schedule() {
    return `<h2>Schedules, vacates &amp; renovations</h2><p>Schedule events do not silently terminate a lease or change occupancy. Use unit state Maintenance for works and lease Notice/Terminate for tenancy changes.</p>
      ${data.canManage ? `<details><summary>Add scheduled work / visit / vacate</summary><form data-leasing-form="schedule">
      <label>Unit<select name="unitId" required>${options(data.units, (u) => unitName(u.id))}</select></label>
      <label>Lease (optional; must match unit)<select name="leaseId">${options(data.leases, (l) => l.lease_number)}</select></label>
      <label>Type<select name="kind">${['move_in', 'vacate', 'inspection', 'renovation', 'maintenance'].map((kind) => `<option>${kind}</option>`).join('')}</select></label>
      ${input('Title', 'title', '', 'text', 'required maxlength="160"')}${input('Starts', 'startsOn', today(), 'date', 'required')}${input('Ends', 'endsOn', today(), 'date', 'required')}
      ${input('Notes', 'notes', '', 'text', 'maxlength="2000"')}<button type="submit">Add schedule</button></form></details>` : ''}
      ${data.schedule.map((s) => `<details><summary>${e(s.starts_on)} to ${e(s.ends_on)} / Unit ${e(s.unit_number)} / ${e(s.kind)} / ${e(s.title)} (${e(s.status)})</summary>
      ${data.canManage ? `<form data-leasing-form="schedule-edit" data-id="${e(s.id)}" data-revision="${s.revision}">
      ${input('Starts', 'startsOn', s.starts_on, 'date', 'required')}${input('Ends', 'endsOn', s.ends_on, 'date', 'required')}
      <label>Status<select name="status">${['planned', 'in_progress', 'completed', 'cancelled'].map((v) => `<option ${v === s.status ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      ${input('Notes', 'notes', s.notes, 'text', 'maxlength="2000"')}<button type="submit">Save schedule</button></form>` : `<p>${e(s.notes)}</p>`}</details>`).join('') || '<p>No schedules.</p>'}`;
  }
  function importMarkup() {
    return `<h2>Import data from another system</h2><p>Upload an Excel workbook, PDF (including scanned pages), CSV or document. Extraction runs on this device. Map columns, edit the preview and explicitly review before saving. Nothing is imported directly from OCR without your confirmation.</p>
      <p>Choose what the file is: building audit, parking audit, tenant list, lease schedule, works schedule, opening balances or buildings list. Import in order: buildings (main admin only), building audit, parking audit, tenants, lease drafts, schedules, then opening TEST balances. Building names/IDs, unit numbers, tenant codes and lease numbers must match.
      <strong>Building and parking audits update automatically:</strong> re-importing a corrected audit updates existing units/bays with the same unit or bay number and adds new ones; blank cells keep the current value. Other registers never overwrite existing records. No login passwords are imported. Use YYYY-MM-DD dates and amounts such as 1500.00 (no currency signs or separators). Multiple tenant codes use semicolons.</p>
      <form data-leasing-form="import-read"><label>What is this file?<select name="kind">${leasingImportTypes.map(([kind, label]) => `<option value="${kind}" ${kind === 'units' ? 'selected' : ''}>${e(label)}</option>`).join('')}</select></label>
      <label>Building this file belongs to (assigned buildings only)<select name="propertyId" required>${options(data.properties, (p) => p.name)}</select></label>
      <p>Select the building explicitly, even if you have only one assignment. Building audits use Unit number as the first column: UnitNumber, Floor, UnitType, Bedrooms, Bathrooms, ParkingBays, FloorArea, Status. Parking audits use BayNumber, Level, BayType, AssignedUnit (unit number), Status, Notes. Every row must belong to the selected building; separate buildings need separate imports.</p>
      <label>File<input name="document" type="file" accept=".xlsx,.pdf,.csv,.tsv,.txt,.docx,.png,.jpg,.jpeg,.webp" required /></label>
      ${input('Worksheet number (Excel)', 'sheet', 1, 'number', 'min="1" required')}${input('Header row number (blank = detect automatically)', 'header', '', 'number', 'min="1"')}
      <button type="submit">Read file / OCR</button></form>
      <div data-leasing-import-map></div><div data-leasing-import-preview></div>`;
  }
  function showImportMapping() {
    workspace.querySelector('[data-leasing-import-map]').innerHTML = `<form data-leasing-form="import-map"><h3>Map ${importTable.rows.length} rows: ${e(importType(importTable.kind))}</h3>
      ${importTable.suggestedKind && importTable.suggestedKind !== importTable.kind ? `<p role="alert">The column headings look like a ${e(importType(importTable.suggestedKind))}, not a ${e(importType(importTable.kind))}. Check the file type selection before importing.</p>` : ''}
      ${leasingImportFields[importTable.kind].includes('building') ? `<label>Selected building (all rows must match)<select name="propertyId" required>${options(data.properties, (p) => p.name, 'id', importBuilding)}</select></label>
      <p>Header row: ${importTable.header}. Selected building: ${e(building(importBuilding))}. All preview rows will show this building.</p>` : ''}
      ${leasingImportFields[importTable.kind].map((field) => `<label>${e(field)}<select name="${field}"><option value="-1">Not mapped</option>${importTable.columns.map((column, i) =>
        `<option value="${i}" ${importTable.mapping[field] === i ? 'selected' : ''}>${e(column)}</option>`).join('')}</select></label>`).join('')}
      <button type="submit">Build editable preview</button></form>`;
    wireImportForm(workspace.querySelector('[data-leasing-form=import-map]'));
  }
  function showImportPreview() {
    const fields = leasingImportFields[importTable.kind], updates = leasingImportUpdates.includes(importTable.kind);
    const existing = (row) => {
      const key = String(importTable.kind === 'units' ? row.number : row.bayNumber).trim().toLowerCase();
      return (importTable.kind === 'units' ? data.units.map((u) => [u.property_id, u.unit_number]) : (data.parking || []).map((b) => [b.property_id, b.bay_number]))
        .some(([propertyId, number]) => propertyId === importBuilding && String(number).trim().toLowerCase() === key);
    };
    workspace.querySelector('[data-leasing-import-preview]').innerHTML = `<form data-leasing-form="import-save"><h3>Review every extracted row: ${e(importType(importTable.kind))} for ${e(building(importBuilding) || 'all assigned buildings')}</h3>
      <p>Original columns are retained for audit/export, including unmapped values. Correct OCR/table mistakes below or fix the source and read it again. Imports are atomic: any invalid/duplicate row rejects the entire batch.</p>
      ${updates ? '<p>Rows marked "Update existing" change the current record with the same number; blank cells keep current values.</p>' : ''}
      <div style="overflow:auto;max-height:480px"><table><thead><tr>${fields.map((field) => `<th>${e(field)}</th>`).join('')}${updates ? '<th>Action</th>' : ''}<th>Row</th></tr></thead><tbody>
      ${importRows.map((row, i) => `<tr data-import-row="${i}">${fields.map((field) => `<td><input aria-label="Row ${i + 1} ${e(field)}" data-import-field="${field}" value="${e(row[field])}" ${field === 'building' ? 'readonly' : ''} /></td>`).join('')}${updates ? `<td>${existing(row) ? 'Update existing' : 'New'}</td>` : ''}<td>${i + 1}</td></tr>`).join('')}</tbody></table></div>
      <label class="inline-choice"><input name="reviewed" type="checkbox" required />I reviewed all rows, field mappings and amounts. Import into the TEST leasing registers only.</label>
      <button type="submit">Import reviewed batch</button></form>`;
    wireImportForm(workspace.querySelector('[data-leasing-form=import-save]'));
  }
  function wireImportForm(form) {
    form.addEventListener('submit', importSubmit);
    if (form.dataset.leasingForm === 'import-read') {
      const updateBuilding = () => { form.elements.propertyId.required = leasingImportFields[form.elements.kind.value].includes('building'); };
      form.elements.kind.addEventListener('change', updateBuilding);
      updateBuilding();
    }
  }
  function importSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (context !== getContext()) return;
    void action(async () => {
      const expected = getContext(), values = formValues(form);
      if (form.dataset.leasingForm === 'import-read') {
        importTable = null; importRows = null; importBatch = null;
        workspace.querySelector('[data-leasing-import-map]').replaceChildren();
        workspace.querySelector('[data-leasing-import-preview]').replaceChildren();
        const file = form.elements.document.files[0];
        if (!file || file.size > 26214400) throw new Error('Choose a readable file up to 25 MB.');
        if (leasingImportFields[values.kind].includes('building') && !data.properties.some((p) => p.id === values.propertyId)) throw new Error('Select an assigned building for this file.');
        const progress = { set textContent(value) { if (expected === getContext()) status(value); } };
        const rows = await readDocumentRows(file, readers(progress, Number(values.sheet)));
        if (expected !== getContext()) return;
        const table = leasingImportTable(rows, values.kind, Number(values.header));
        const detectedBuilding = suggestedImportBuilding(table, file.name, data.properties);
        if (leasingImportFields[values.kind].includes('building') && detectedBuilding && detectedBuilding !== values.propertyId) throw new Error(`The report heading/filename identifies ${building(detectedBuilding)}, not the selected building. Check the file or selection.`);
        importTable = { ...table, suggestedKind: suggestedImportKind(rows) }; importBuilding = values.propertyId;
        importName = file.name; importBatch = crypto.randomUUID(); importRows = null;
        workspace.querySelector('[data-leasing-import-preview]').replaceChildren();
        showImportMapping(); status('File extracted. Check column mapping before building a preview.');
      } else if (form.dataset.leasingForm === 'import-map') {
        importRows = mappedLeasingRows(importTable, values, { properties: data.properties, propertyId: values.propertyId });
        importBuilding = values.propertyId || importBuilding;
        importBatch = crypto.randomUUID();
        showImportPreview(); status('Review and correct every row before importing.');
      } else {
        const rows = [...form.querySelectorAll('[data-import-row]')].map((row) => Object.fromEntries([...row.querySelectorAll('[data-import-field]')].map((el) => [el.dataset.importField, el.value.trim()])));
        const result = await send('/import', { kind: importTable.kind, batchId: importBatch, sourceName: importName, rows, propertyId: importBuilding,
          source: { columns: importTable.columns, rows: importTable.rows }, reviewed: values.reviewed === 'on' });
        if (expected !== getContext()) return;
        await render(`${importType(importTable.kind)}: ${result.created ?? result.imported} new and ${result.updated || 0} existing records updated. Registers, schedules and exports now show the changes.`);
      }
    });
  }
  function wireForms() {
    workspace.querySelectorAll('[data-leasing-form]').forEach((form) => {
      if (form.dataset.leasingForm.startsWith('import-')) { wireImportForm(form); return; }
      const buildingSelect = form.querySelector('[data-lease-building]');
      if (buildingSelect) {
        const unitSelect = form.querySelector('[data-lease-unit]');
        const filterBuildingOptions = () => {
          for (const option of unitSelect.options) {
            if (!option.value) continue;
            option.hidden = option.dataset.propertyId !== buildingSelect.value;
          }
          if (unitSelect.selectedOptions[0]?.hidden) unitSelect.value = '';
          for (const label of form.querySelectorAll('[data-lease-tenant-building]')) {
            label.hidden = label.dataset.leaseTenantBuilding !== buildingSelect.value;
            if (label.hidden) label.querySelector('input').checked = false;
          }
        };
        for (const option of unitSelect.options) {
          if (option.value) option.dataset.propertyId = data.units.find((unit) => unit.id === option.value)?.property_id || '';
        }
        buildingSelect.addEventListener('change', filterBuildingOptions);
        filterBuildingOptions();
      }
      form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (context !== getContext()) return;
      void action(async () => {
        const expected = getContext();
        const values = formValues(form), kind = form.dataset.leasingForm;
        const id = form.dataset.id, l = detail?.lease;
        const version = Number(form.dataset.revision);
        if (kind === 'portfolio') await send('/portfolios', values);
        else if (kind === 'building') await send(`/buildings/${encodeURIComponent(values.id)}`, values, 'PUT');
        else if (kind === 'unit') await send('/units', values);
        else if (kind === 'unit-edit') await send(`/units/${id}`, { ...values, revision: version }, 'PUT');
        else if (kind === 'parking') await send('/parking', values);
        else if (kind === 'parking-edit') await send(`/parking/${id}`, { ...values, remove: values.remove === 'on', revision: version }, 'PUT');
        else if (kind.startsWith('tenant')) await send(`/tenants${id ? `/${id}` : ''}`, { ...values, revision: version }, id ? 'PUT' : 'POST');
        else if (kind === 'lease' || kind === 'lease-edit') {
          const result = await send(`/leases${id ? `/${id}` : ''}`, { ...values, propertyId: values.propertyId,
            rentCents: toCents(values.rent), depositCents: toCents(values.deposit),
            tenantIds: new FormData(form).getAll('tenantIds'), revision: version }, id ? 'PUT' : 'POST');
          if (expected !== getContext()) return;
          selected = id || result.id;
        } else if (kind === 'lease-action') await send(`/leases/${l.id}/actions`, { ...values, revision: l.revision });
        else if (kind.endsWith('upload')) {
          const file = form.elements.document.files[0];
          if (!file || file.size > 26214400) throw new Error('Choose a PDF or DOCX up to 25 MB.');
          const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
          if (expected !== getContext()) return;
          for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
          await send('/documents', { name: file.name, contentType: file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            data: btoa(binary), ...(kind === 'document-upload' ? { leaseId: l.id, revision: l.revision } : {}) });
        } else if (kind === 'template-attach') await send(`/leases/${l.id}/template`, { ...values, revision: l.revision });
        else if (kind === 'signature') {
          const canvas = form.querySelector('canvas');
          if (canvas.dataset.drawn !== 'true') throw new Error('Draw your signature before signing.');
          await send(`/leases/${l.id}/sign`, { name: values.name, consent: values.consent === 'on', digest: detail.documentDigest, signature: canvas.toDataURL('image/png') });
        } else if (kind === 'billing') await send(`/leases/${l.id}/billing`, values);
        else if (kind === 'charge') await send(`/leases/${l.id}/charges`, { ...values, amountCents: toCents(values.amount) });
        else if (kind === 'ledger') await send(`/leases/${l.id}/ledger`, { ...values, amountCents: toCents(values.amount) });
        else if (kind === 'void') await send(`/leases/${l.id}/ledger/${form.dataset.entry}/void`, values);
        else if (kind === 'schedule') await send('/schedule', values);
        else if (kind === 'schedule-edit') await send(`/schedule/${id}`, { ...values, revision: version }, 'PUT');
        if (expected !== getContext()) return;
        await render('Saved in the leasing TEST workspace.');
      });
      });
    });
    workspace.querySelector('[data-lease-selector]')?.addEventListener('change', (event) => { selected = event.target.value || null; void render(); });
  }
  function wireSignature() {
    const canvas = workspace.querySelector('[data-signature]');
    if (!canvas) return;
    const ctx = canvas.getContext('2d'); ctx.lineWidth = 2; ctx.strokeStyle = '#111'; ctx.lineCap = 'round';
    let drawing = false;
    const point = (event) => {
      const rect = canvas.getBoundingClientRect();
      return [(event.clientX - rect.left) * canvas.width / rect.width, (event.clientY - rect.top) * canvas.height / rect.height];
    };
    canvas.addEventListener('pointerdown', (ev) => { drawing = true; canvas.setPointerCapture(ev.pointerId); ctx.beginPath(); ctx.moveTo(...point(ev)); });
    canvas.addEventListener('pointermove', (ev) => { if (!drawing) return; ctx.lineTo(...point(ev)); ctx.stroke(); canvas.dataset.drawn = 'true'; });
    canvas.addEventListener('pointerup', () => { drawing = false; });
    canvas.addEventListener('pointercancel', () => { drawing = false; });
    workspace.querySelector('[data-clear-signature]').addEventListener('click', () => { ctx.clearRect(0, 0, canvas.width, canvas.height); canvas.dataset.drawn = 'false'; });
  }
  workspace.addEventListener('click', (event) => {
    if (event.target.closest('[data-leasing-refresh]')) { void render(); return; }
    const button = event.target.closest('[data-leasing-export], [data-lease-export], [data-document]');
    if (!button || context !== getContext()) return;
    void action(async () => {
      if (button.dataset.document) await download(`/api/leasing/documents/${button.dataset.document}`, button.dataset.name);
      else {
        const format = button.dataset.leasingExport || button.dataset.leaseExport;
        await download(`/api/leasing/export/${format}${button.dataset.leaseExport ? `?leaseId=${selected}` : ''}`, `PrimeOps-Leasing-TEST.${format}`);
      }
    });
  });
  return { render };
}
