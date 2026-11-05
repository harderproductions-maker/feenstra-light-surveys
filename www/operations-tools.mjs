import { assetTable, mappedAssets, assetImportFields } from './asset-import.mjs';
import { readDocumentRows, importChecklistFile } from './checklist-import.mjs';
import { prepareProfilePhoto } from './profile-photo.mjs';
import { reportDocument, reportEscape as e } from './report-layout.mjs';
const accept = '.xlsx,.docx,.pdf,.csv,.tsv,.txt,.png,.jpg,.jpeg,.webp';
const day = () => new Date().toISOString().slice(0, 10);
export function assetDue(record, today = day()) {
  const due = record.data.nextInspectionOn;
  return record.status === 'retired' || !due ? '' : due < today ? 'OVERDUE inspection' : due === today ? 'Inspection due today' : `Next inspection ${due}`;
}
export function operationsReport(kind, records, detail) {
  const source = detail?.asset.asset_source;
  const body = `<table><thead><tr><th>Building</th><th>${kind === 'assets' ? 'Asset / tag' : 'Meter / type'}</th><th>${kind === 'assets' ? 'Status / condition / location' : 'Reading / consumption'}</th><th>${kind === 'assets' ? 'Inspection due' : 'Date / notes'}</th></tr></thead><tbody>${records.map((row) => `<tr><td>${e(row.building_name)}</td><td>${e(kind === 'assets' ? `${row.data.name} / ${row.data.assetTag}` : `${row.data.meterReference} / ${row.data.meterType}`)}</td><td>${e(kind === 'assets' ? `${row.status} / ${row.data.condition || 'unknown'} / ${row.data.location}` : `${row.data.reading} ${row.data.unit}; consumption ${row.consumption ?? 'not available'}`)}</td><td>${e(kind === 'assets' ? row.data.nextInspectionOn || 'Not scheduled' : `${row.data.readAt} / ${row.data.notes}`)}</td></tr>`).join('')}</tbody></table>
    ${source ? `<h2>Original imported asset row</h2><table><thead><tr>${source.columns.map((value) => `<th>${e(value)}</th>`).join('')}</tr></thead><tbody><tr>${source.cells.map((value) => `<td>${e(value)}</td>`).join('')}</tr></tbody></table>` : ''}
    ${detail?.tickets?.length ? `<h2>Linked work orders</h2><table><thead><tr><th>Job</th><th>Status</th><th>Completed</th></tr></thead><tbody>${detail.tickets.map((ticket) => `<tr><td>${e(ticket.subject)}</td><td>${e(ticket.status)}</td><td>${e(ticket.completedAt || 'Not completed')}</td></tr>`).join('')}</tbody></table>` : ''}
    ${detail ? `<h2>Current inspection checklist</h2><ol>${detail.checklist.questions.map((question) => `<li>${e(question.label)}</li>`).join('')}</ol><h2>Asset history</h2>${detail.history.map((entry) => `<section class="entry"><h3>${e(entry.kind)} / ${e(entry.happenedOn)} / ${e(entry.actor)}</h3><p>${e(entry.detail.notes || entry.detail.reason || '')}</p>
      ${entry.detail.fromBuilding ? `<p>${e(entry.detail.fromBuilding)} / ${e(entry.detail.fromLocation)} to ${e(entry.detail.toBuilding)} / ${e(entry.detail.toLocation)}</p>` : ''}
      ${entry.detail.checklist && entry.detail.answers ? `<table><tbody>${entry.detail.checklist.questions.map((question) => `<tr><th>${e(question.label)}</th><td>${e(entry.detail.answers[question.id])}</td></tr>`).join('')}</tbody></table>` : ''}
      ${(entry.detail.photos || []).map((photo) => `<figure><img src="${e(photo)}" alt="Asset evidence" /></figure>`).join('')}</section>`).join('')}` : ''}`;
  return reportDocument({ title: kind === 'assets' ? 'Asset register & inspection report' : 'Meter readings & consumption',
    category: 'Operations report', metadata: [['Generated', new Date().toISOString()], ['Scope', 'Your currently assigned buildings']],
    summary: [['Records', records.length], ...(kind === 'assets' ? [['Overdue inspections', records.filter((row) => assetDue(row).startsWith('OVERDUE')).length]] : [])],
    notice: kind === 'assets' ? 'Generated checklists are editable starting points, not equipment-specific safety certification. Review manufacturer requirements and use competent inspectors.' : 'Consumption is the difference between consecutive cumulative readings in the same units. First readings and recorded resets have no calculated consumption.',
    body });
}
export function wireOperationTools({ workspace, apiRequest, getContext, run: runAction, refresh, readers, printDocument, getRecords, getProperties, manager, canCreateAssetTickets }) {
  let context, kind, table, preview, selected, draft;
  const status = (message) => { const target = workspace.querySelector('[data-operation-status]'); if (target) target.textContent = message; };
  const current = () => context === getContext() && workspace.querySelector('[data-operation]')?.dataset.operation === kind;
  const run = (work) => {
    const expected = getContext();
    return runAction(() => work(() => expected === getContext() && current()));
  };
  const readerOptions = (sheet = 1) => {
    const expected = getContext();
    return readers({ set textContent(value) { if (expected === getContext() && current()) status(value); } }, sheet);
  };
  const checkedPhotos = async (files) => {
    if (files.length > 5) throw new Error('Choose at most five evidence photos.');
    return Promise.all(files.map((file) => prepareProfilePhoto(file, { maxDimension: 1280, maxBytes: 500 * 1024 })));
  };
  function markup(module, records) {
    kind = module; context = getContext(); table = null; preview = null; selected = null; draft = null;
    if (!['assets', 'meters'].includes(kind)) return '';
    const due = records.filter((row) => assetDue(row).startsWith('OVERDUE')).length;
    return `<section class="storage-panel"><h2>${kind === 'assets' ? 'Asset inspections & tracking' : 'Cumulative meter readings'}</h2>
      <p>${kind === 'assets' ? `${due} overdue inspection(s). Open an asset to inspect it, log faults/repairs, view evidence and print its history. Due reminders are in-app; no background email is sent.` : 'Electricity, water and gas: use the same reference/type/units each time. Consumption compares consecutive readings. A lower value requires an explicit reset/replacement and notes. Readings are saved chronologically.'}</p>
      <button type="button" class="button secondary" data-operation-report>Print / save ${kind === 'assets' ? 'asset register' : 'meter report'}</button>
      ${kind === 'assets' && manager() ? `<details><summary>Import assets from spreadsheet / document / scan</summary>
      <p>One row per physical asset. Upload Excel, Word, PDF/scans, images, CSV or text; local OCR reads scanned pages. Review column mapping and every asset before saving. Unsupported/unreadable content must be corrected, not guessed. Import one worksheet at a time; split quantities into individually tagged assets.</p>
      <input type="file" data-asset-file accept="${accept}" /><label>Excel worksheet number<input type="number" data-asset-sheet min="1" value="1" /></label><label>Header row number<input type="number" data-asset-header min="1" value="1" /></label>
      <button type="button" class="button secondary" data-read-assets>Read file / OCR</button><div data-asset-mapping></div><div data-asset-preview></div></details>` : ''}
      <div data-asset-detail></div></section>`;
  }
  function recordMarkup(row) {
    if (row.kind === 'assets') return `<p><strong>${e(assetDue(row))}</strong></p><button type="button" class="button secondary" data-open-asset="${e(row.id)}">Inspect / work history / report</button>`;
    if (row.kind === 'meters') return `<p>Previous: ${e(row.previousReading ?? 'First reading')} ${e(row.previousReading === null ? '' : row.data.unit)} / Consumption: <strong>${e(row.consumption ?? 'Not calculated')} ${e(row.consumption === null ? '' : row.data.unit)}</strong></p>
      ${row.readingWarning ? `<p role="alert">${e(row.readingWarning)}</p>` : ''}${row.photo_count ? `<button type="button" class="button secondary" data-meter-photo="${e(row.id)}">View meter photo</button><div data-meter-photo-list></div>` : ''}`;
    return '';
  }
  function mappingHtml() {
    const properties = getProperties();
    workspace.querySelector('[data-asset-mapping]').innerHTML = `<form data-asset-map><h3>Map columns (${table.rows.length} assets)</h3>
      ${assetImportFields.map((field) => `<label>${e(field)}<select name="${field}"><option value="-1">Not mapped</option>${table.columns.map((label, index) => `<option value="${index}"${table.mapping[field] === index ? ' selected' : ''}>${e(label)}</option>`).join('')}</select></label>`).join('')}
      <label>Building if not mapped<select name="building"><option value="">Choose building</option>${properties.map((property) => `<option value="${e(property.id)}"${properties.length === 1 ? ' selected' : ''}>${e(property.name)}</option>`).join('')}</select></label>
      <label>Category if not mapped<input name="categoryDefault" value="General" /></label><label>Inspection interval in days (0 disables recurring schedule)<input type="number" name="interval" min="0" max="3650" value="30" required /></label><label>First inspection due<input name="nextDue" type="date" value="${day()}" required /></label>
      <button class="button secondary">Create editable preview</button></form>
      <details><summary>Extracted table / OCR text</summary><pre>${e([table.columns, ...table.rows].map((row) => row.join(' | ')).join('\n'))}</pre></details>`;
  }
  function previewHtml() {
    workspace.querySelector('[data-asset-preview]').innerHTML = `<form data-save-assets><h3>Review ${preview.length} assets</h3><p>Each asset receives an editable starting checklist. Original columns are retained with the asset, including columns not mapped below.</p>
      ${preview.map((row, index) => `<fieldset data-import-row="${index}"><legend>Asset ${index + 1}</legend><label>Building<select name="building-${index}">${getProperties().map((property) => `<option value="${e(property.id)}"${property.id === row.propertyId ? ' selected' : ''}>${e(property.name)}</option>`).join('')}</select></label>
      ${['assetTag', 'name', 'category', 'serialNumber', 'location', 'notes'].map((field) => `<label>${field}<input name="${field}-${index}" value="${e(row.data[field])}"${['assetTag', 'name', 'category'].includes(field) ? ' required' : ''} /></label>`).join('')}</fieldset>`).join('')}
      <label class="inline-choice"><input type="checkbox" name="reviewed" required />I reviewed the OCR/column mapping, buildings and individual asset details.</label><button class="button primary">Import assets &amp; create inspection checklists</button></form>`;
  }
  function questionInput(question) {
    const name = `answer-${question.id}`, choices = { 'pass-fail-na': ['pass', 'fail', 'na'], 'yes-no': ['yes', 'no'], 'yes-no-na': ['yes', 'no', 'na'] };
    const options = choices[question.type];
    return `<label>${e(question.label)}${options ? `<select name="${e(name)}"><option value="">Choose answer</option>${options.map((option) => `<option>${option}</option>`).join('')}</select>` : question.type === 'textarea' ? `<textarea name="${e(name)}" maxlength="4000"></textarea>` : `<input name="${e(name)}" type="${['number', 'rating'].includes(question.type) ? 'number' : question.type === 'date' ? 'date' : 'text'}"${question.type === 'number' ? ' step="any"' : question.type === 'rating' ? ' min="0" max="10"' : ''} />`}</label>`;
  }
  function detailHtml() {
    const asset = selected.asset;
    workspace.querySelector('[data-asset-detail]').innerHTML = `<hr><h2>${e(asset.data.name)} / ${e(asset.data.assetTag)}</h2><p>${e(assetDue(asset))} / Revision ${asset.revision}</p>
      <button type="button" class="button secondary" data-asset-report>Print / save asset history report</button>
      ${canCreateAssetTickets() ? `<details><summary>Create linked maintenance ticket</summary><p>This uses the existing maintenance inbox, assignment and completion process. No duplicate ticket is created for the same inspection/fault.</p>
      <form data-asset-ticket><label>Source inspection / fault<select name="activityId"><option value="">General asset issue</option>${selected.history.filter((entry) => ['inspection', 'fault'].includes(entry.kind) && !selected.tickets.some((ticket) => ticket.activityId === entry.id)).map((entry) => `<option value="${e(entry.id)}">${e(entry.kind)} / ${e(entry.happenedOn)} / ${e(entry.detail.notes || 'Inspection')}</option>`).join('')}</select></label>
      <label>Ticket title<input name="subject" maxlength="160" value="${e(`Asset: ${asset.data.name}`.slice(0, 160))}" required /></label><label>Unit / location<input name="unitNumber" maxlength="80" value="${e((asset.data.location || 'Common area').slice(0, 80))}" required /></label><label>Issue description<textarea name="description" maxlength="4000" required></textarea></label><button class="button primary">Create maintenance ticket</button></form></details>
      <h3>Linked work orders</h3>${selected.tickets.length ? `<ul>${selected.tickets.map((ticket) => `<li>${e(ticket.subject)} / ${e(ticket.status.replaceAll('_', ' '))}${ticket.completedAt ? ` / Completed ${e(ticket.completedAt)}` : ''}</li>`).join('')}</ul>` : '<p>No linked tickets visible in your maintenance/building access.</p>'}` : ''}
      ${asset.status === 'retired' ? '<p>This asset is retired. Reactivate it before recording new work.</p>' : `<form data-asset-activity>
      <label>Work type<select name="kind"><option value="inspection">Inspection</option><option value="fault">Fault report</option><option value="repair">Repair</option><option value="maintenance">Maintenance</option></select></label>
      <label>Date completed<input name="happenedOn" type="date" max="${day()}" value="${day()}" required /></label>
      <div data-inspection-questions><h3>${e(selected.checklist.title)}</h3>${selected.checklist.questions.map(questionInput).join('')}
      <label>Inspected condition<select name="condition">${['good', 'fair', 'poor', 'unserviceable'].map((option) => `<option>${option}</option>`).join('')}</select></label>
      <label>Next inspection (blank uses configured interval)<input name="nextInspectionOn" type="date" /></label></div>
      <label>Notes / faults / work performed<textarea name="notes" maxlength="4000"></textarea></label><label>Evidence photos (up to 5)<input type="file" name="photos" accept="image/jpeg,image/png,image/webp" multiple /></label><button class="button primary">Save work &amp; evidence</button></form>`}
      ${manager() ? `<details><summary>Edit / import this asset's checklist</summary><p>Review manufacturer requirements before use. Imported answer types and source columns are preserved when question count is unchanged; changing question count creates Pass/Fail/N/A questions.</p>
      <input type="file" data-asset-checklist-file accept="${accept},.json" /><form data-asset-checklist><label>Checklist title<input name="title" value="${e(draft.title)}" maxlength="150" required /></label>
      <label>Questions (one per line)<textarea name="questions" rows="8" required>${e(draft.questions.map((question) => question.label).join('\n'))}</textarea></label><button class="button secondary">Save checklist</button></form></details>
      <details><summary>Transfer asset</summary><form data-asset-transfer><label>Destination building<select name="propertyId">${getProperties().map((property) => `<option value="${e(property.id)}"${property.id === asset.property_id ? ' selected' : ''}>${e(property.name)}</option>`).join('')}</select></label>
      <label>Destination location<input name="location" maxlength="150" required /></label><label>Transfer reason<textarea name="reason" maxlength="2000" required></textarea></label><button class="button secondary">Transfer &amp; retain history</button></form></details>` : ''}
      <h3>Work / transfer / checklist history</h3>${selected.history.map((entry) => `<article class="storage-panel"><strong>${e(entry.kind)} / ${e(entry.happenedOn)} / ${e(entry.actor)}</strong><p>${e(entry.detail.notes || entry.detail.reason || '')}</p>
      ${entry.detail.fromBuilding ? `<p>${e(entry.detail.fromBuilding)} / ${e(entry.detail.fromLocation)} to ${e(entry.detail.toBuilding)} / ${e(entry.detail.toLocation)}</p>` : ''}
      ${entry.detail.answers ? `<dl>${entry.detail.checklist.questions.map((question) => `<dt>${e(question.label)}</dt><dd>${e(entry.detail.answers[question.id])}</dd>`).join('')}</dl>` : ''}
      ${(entry.detail.photos || []).map((photo) => `<img class="operation-evidence" src="${e(photo)}" alt="Work evidence" loading="lazy" />`).join('')}</article>`).join('') || '<p>No recorded work yet.</p>'}`;
  }
  async function open(id) {
    const expected = getContext(), detail = await apiRequest(`/api/operations/assets/${id}/history`);
    if (!current() || expected !== getContext()) return;
    selected = detail; draft = structuredClone(detail.checklist); detailHtml();
  }
  workspace.addEventListener('change', (event) => {
    if (!current()) return;
    if (event.target.matches('[data-asset-activity] [name=kind]')) workspace.querySelector('[data-inspection-questions]').hidden = event.target.value !== 'inspection';
    if (!event.target.matches('[data-asset-checklist-file]') || !event.target.files[0]) return;
    const file = event.target.files[0];
    void run(async (valid) => {
      const imported = await importChecklistFile(file, { ...readerOptions(), status });
      if (!valid()) return;
      draft = imported; detailHtml(); status('Checklist extracted. Review/edit it and save; it is not saved yet.');
    });
  });
  workspace.addEventListener('click', (event) => {
    if (!current()) return;
    if (event.target.closest('[data-read-assets]')) {
      const file = workspace.querySelector('[data-asset-file]').files[0];
      const sheet = Number(workspace.querySelector('[data-asset-sheet]').value), header = Number(workspace.querySelector('[data-asset-header]').value);
      void run(async (valid) => {
        if (!file || !Number.isInteger(sheet) || sheet < 1 || !Number.isInteger(header) || header < 1) throw new Error('Choose a document and valid worksheet/header row numbers.');
        status('Reading document. Scans use local OCR; please wait...');
        const rows = await readDocumentRows(file, readerOptions(sheet));
        if (!valid()) return;
        table = assetTable(rows.slice(header - 1)); preview = null;
        workspace.querySelector('[data-asset-preview]').replaceChildren(); mappingHtml(); status('Read complete. Confirm mappings and create the editable preview.');
      });
    }
    const asset = event.target.closest('[data-open-asset]');
    if (asset) void run(() => open(asset.dataset.openAsset));
    if (event.target.closest('[data-operation-report]')) void run(() => printDocument(operationsReport(kind, getRecords()), `${kind}-report-${day()}`));
    if (event.target.closest('[data-asset-report]') && selected) void run(() => printDocument(operationsReport('assets', getRecords().filter((row) => row.id === selected.asset.id), selected), `asset-${day()}`));
    const meter = event.target.closest('[data-meter-photo]');
    if (meter) void run(async (valid) => {
      const data = await apiRequest(`/api/operations/meters/${meter.dataset.meterPhoto}/photos`);
      if (valid() && meter.isConnected) meter.parentElement.querySelector('[data-meter-photo-list]').innerHTML = data.photos.map((photo) => `<img class="operation-evidence" src="${e(photo)}" alt="Meter reading evidence" />`).join('');
    });
  });
  workspace.addEventListener('submit', (event) => {
    if (!current()) return;
    const form = event.target, values = new FormData(form);
    if (!form.matches('[data-asset-map],[data-save-assets],[data-asset-activity],[data-asset-checklist],[data-asset-transfer],[data-asset-ticket]')) return;
    event.preventDefault();
    if (form.matches('[data-asset-map]')) {
      void run(async (valid) => {
        preview = mappedAssets(table, Object.fromEntries(assetImportFields.map((field) => [field, Number(values.get(field))])), getProperties(),
          { propertyId: values.get('building'), category: values.get('categoryDefault'), intervalDays: Number(values.get('interval')), nextInspectionOn: values.get('nextDue') });
        if (valid()) { previewHtml(); status('Review the imported assets and confirm before saving.'); }
      }); return;
    }
    if (form.matches('[data-save-assets]')) {
      const assets = preview.map((row, index) => ({ ...row, propertyId: values.get(`building-${index}`), data: { ...row.data,
        ...Object.fromEntries(['assetTag', 'name', 'category', 'serialNumber', 'location', 'notes'].map((field) => [field, values.get(`${field}-${index}`)])) } }));
      void run(async (valid) => {
        await apiRequest('/api/operations/assets/import', { method: 'POST', body: { reviewed: values.get('reviewed') === 'on', assets } });
        if (valid()) await refresh('assets', `${assets.length} assets imported with inspection checklists. Open each asset to review requirements and inspect.`);
      }); return;
    }
    const record = selected?.asset;
    if (!record) return;
    const id = record.id, revision = record.revision;
    if (form.matches('[data-asset-ticket]')) {
      const body = { propertyId: record.property_id, subject: values.get('subject'), description: values.get('description'),
        unitNumber: values.get('unitNumber'), tags: ['General', 'Asset'], assetId: id, assetActivityId: values.get('activityId') || undefined };
      void run(async (valid) => {
        await apiRequest('/api/tickets', { method: 'POST', body });
        if (valid()) { await refresh('assets', 'Maintenance ticket created. Assign and complete it in Maintenance tickets.'); if (valid()) await open(id); }
      });
    } else if (form.matches('[data-asset-activity]')) {
      const files = [...form.elements.photos.files];
      const body = { kind: values.get('kind'), happenedOn: values.get('happenedOn'), notes: values.get('notes'),
        condition: values.get('condition'), nextInspectionOn: values.get('nextInspectionOn'), revision,
        answers: Object.fromEntries(selected.checklist.questions.map((question) => [question.id, values.get(`answer-${question.id}`)])) };
      void run(async (valid) => {
        body.photos = await checkedPhotos(files);
        if (!valid()) return;
        await apiRequest(`/api/operations/assets/${id}/activity`, { method: 'POST', body });
        if (valid()) { await refresh('assets', 'Work saved with evidence, checklist snapshot and history.'); if (valid()) await open(id); }
      });
    } else if (form.matches('[data-asset-checklist]')) {
      const labels = String(values.get('questions')).split(/\r?\n/).map((label) => label.trim()).filter(Boolean);
      const sameSize = labels.length === draft.questions.length;
      const checklist = { title: values.get('title'), questions: labels.map((label, index) => sameSize ? { ...draft.questions[index], label } : { label, type: 'pass-fail-na', photo: false }),
        ...(sameSize && draft.sourceColumns ? { sourceColumns: draft.sourceColumns } : {}) };
      void run(async (valid) => {
        await apiRequest(`/api/operations/assets/${id}/checklist`, { method: 'PUT', body: { revision, checklist } });
        if (valid()) { await refresh('assets', 'Inspection checklist saved; previous inspection snapshots are unchanged.'); if (valid()) await open(id); }
      });
    } else if (form.matches('[data-asset-transfer]')) {
      const body = { revision, propertyId: values.get('propertyId'), location: values.get('location'), reason: values.get('reason') };
      void run(async (valid) => {
        await apiRequest(`/api/operations/assets/${id}/transfer`, { method: 'POST', body });
        if (valid()) { await refresh('assets', 'Asset transferred. Identity and history retained.'); if (valid()) await open(id); }
      });
    }
  });
  return { markup, recordMarkup, checkedPhotos };
}
