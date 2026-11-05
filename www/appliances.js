import { combinedReportHtml } from './appliance-report.mjs';
import { isManagerRole, isManagementRole } from './account-access.mjs';
import { auditHtml } from './appliance-audit.mjs';
import { captureCheckLocation } from './check-location.js';
import { takeMachinePhoto } from './machine-camera.js';
import { defaultModels, machineStatus, validateLaundryReport, partNumberLabel, partsForMachine, machineNumberKey } from './laundry.mjs';
import { assetPanel, wireAssetActions, benchmarkLabel } from './machine-assets.js';
import { scheduleHtml, wireSchedule } from './technician-schedule.js';
import { assertCanMove, assertVisitPoint, bookingWindow, localDay, visitProgress } from './technician-visits.mjs';
import { createCalendarState, calendarHtml } from './technician-calendar.mjs';
import { quotationPanel, wireQuotations } from './parts-quotes.js';

export function applianceTabs(role) {
  const tabs = [['schedule', 'Schedules / Bookings'], ['checks', 'Do checks'], ['reports', 'Saved reports'], ['assets', 'Machine assets']];
  if (isManagementRole(role)) tabs.push(['quotes', 'Supplier quotes'], ['parts', 'Parts catalogue'], ['locations', 'Building GPS']);
  if (isManagerRole(role)) tabs.push(['attendance', 'Attendance']);
  return tabs;
}

export function createApplianceView({ workspace, apiRequest, escapeHtml, isCurrent, getOwner, getUser, canManage, composeEmail, printDocument, alertError, draftStorage, draftKey }) {
  let parts = [];
  let selectedParts = [];
  let savedReports = [];
  let downloadedCopy = false;
  let checkStart = null;
  let startedElapsed = 0;
  let startedOffline = false;
  let entries = [];
  let capturedPhoto = null;
  let machineAudit = null;
  let reportDraftKey = '';
  let elapsedBefore = 0;
  let currentMachineStart = null;
  let currentMachineElapsed = 0;
  let renderGeneration = 0;
  let schedule = null;
  let activeVisitId = null;
  let activeTab = null;
  let navigationOwner = null;
  let calendar = createCalendarState();
  let availableProperties = [];
  let assetData = null;

  wireAssetActions({ workspace, apiRequest, isCurrent, getOwner, render, alertError });

  wireSchedule({ workspace, apiRequest, getUser, isCurrent, getOwner, getSchedule: () => schedule, render,
    getReports: () => savedReports, getProperties: () => availableProperties, escape: escapeHtml,
    getCalendar: () => calendar, refreshCalendar,
    captureLocation: captureCheckLocation, printDocument, alertError });
  const quotations = wireQuotations({ workspace, apiRequest, getOwner, isCurrent, getReports: () => savedReports,
    getProperties: () => availableProperties, escape: escapeHtml, composeEmail, printDocument, alertError });

  function reportForm() { return workspace.querySelector('#appliance-report-form'); }

  function selectTab(tab, focus = false) {
    if (!applianceTabs(getUser().role).some(([id]) => id === tab)) return;
    activeTab = tab;
    workspace.querySelectorAll('[data-appliance-tab]').forEach((button) => {
      const selected = button.dataset.applianceTab === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    });
    workspace.querySelectorAll('[data-appliance-panel]').forEach((panel) => { panel.hidden = panel.dataset.appliancePanel !== tab; });
  }

  function refreshCalendar() {
    const host = workspace.querySelector('[data-technician-calendar]');
    if (host) host.innerHTML = calendarHtml(schedule, savedReports, availableProperties, getUser(), calendar, escapeHtml);
  }

  workspace.addEventListener('keydown', (event) => {
    if (!isCurrent() || !event.target.matches('[data-appliance-tab]')) return;
    const buttons = [...workspace.querySelectorAll('[data-appliance-tab]')];
    let index = buttons.indexOf(event.target);
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') index = (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = buttons.length - 1;
    else return;
    event.preventDefault();
    selectTab(buttons[index].dataset.applianceTab, true);
  });

  async function persistDraft() {
    const form = reportForm();
    await draftStorage.set(reportDraftKey, {
      propertyId: form.elements.propertyId.value, applianceType: form.elements.applianceType.value,
      expectedCount: Number(form.elements.expectedCount.value), entries,
      checkStart, elapsed: elapsedBefore + performance.now() - startedElapsed, startedOffline,
      modelNumber: form.elements.modelNumber.value || defaultModels[form.elements.applianceType.value],
      visitId: activeVisitId
    });
  }

  function progress() {
    const form = reportForm();
    const total = Number(form.elements.expectedCount.value);
    workspace.querySelector('#machine-progress').textContent = `${entries.length} of ${total || '?'} checked - ${entries.filter((entry) => entry.status === 'needs_repair').length} need repair${total > entries.length ? ` - ${total - entries.length} not checked` : ''}`;
    workspace.querySelector('#checked-machines').innerHTML = entries.map((entry, index) => `<li>Machine ${escapeHtml(entry.machineNumber)} - ${machineStatus[entry.status]} <button type="button" class="button secondary" data-remove-machine="${index}">Recheck</button></li>`).join('');
    workspace.querySelector('#finish-laundry-report').disabled = !checkStart || entries.length < 1 || entries.length > total;
    workspace.querySelector('#machine-entry').disabled = !checkStart || entries.length >= total;
  }

  function resetMachine() {
    const form = reportForm();
    const previous = entries.at(-1);
    form.elements.machineNumber.value = previous && /^\d+$/.test(previous.machineNumber) ? String(Number(previous.machineNumber) + 1) : '';
    form.querySelectorAll('[name="status"]').forEach((input) => { input.checked = false; });
    form.elements.notes.value = '';
    selectedParts = [];
    capturedPhoto = null;
    machineAudit = null;
    currentMachineStart = previous?.checkAudit.completed || checkStart;
    currentMachineElapsed = performance.now();
    workspace.querySelector('#machine-photo-preview').hidden = true;
    workspace.querySelector('#machine-photo-status').textContent = 'Take a photo of this machine.';
    workspace.querySelector('#machine-repair-parts').hidden = true;
    fillMachineIdentity();
    partRows();
    progress();
    if (activeTab === 'checks' && !workspace.querySelector('#machine-entry').disabled) form.elements.machineNumber.focus();
  }

  function currentAsset() {
    const form = reportForm();
    return assetData?.assets.find((asset) => asset.active && asset.property_id === form.elements.propertyId.value
      && asset.appliance_type === form.elements.applianceType.value
      && asset.machine_key === machineNumberKey(form.elements.machineNumber.value));
  }

  function fillMachineIdentity() {
    const form = reportForm(), asset = currentAsset();
    const previous = entries.find((entry) => machineNumberKey(entry.machineNumber) === machineNumberKey(form.elements.machineNumber.value));
    form.elements.serialNumber.value = asset?.serial_number || previous?.serialNumber || '';
    form.elements.serialNumber.readOnly = !!asset;
    form.elements.replaceMachine.checked = false;
    form.elements.replaceMachine.disabled = !asset || !!asset.pending_sync;
    if (asset) form.elements.modelNumber.value = asset.model_number;
  }

  function reportBody(completed) {
    const form = reportForm();
    return {
      propertyId: form.elements.propertyId.value, applianceType: form.elements.applianceType.value, visitId: activeVisitId,
      expectedCount: Number(form.elements.expectedCount.value), entries,
      checkAudit: { started: checkStart, completed, durationMs: elapsedBefore + performance.now() - startedElapsed, offlineCompleted: startedOffline || navigator.onLine === false }
    };
  }

  function partRows() {
    const list = workspace.querySelector('#appliance-parts-list');
    if (!list) return;
    const applicable = partsForMachine(parts, reportForm()?.elements.applianceType.value);
    selectedParts = selectedParts.filter((selection) => applicable.some((part) => part.id === selection.id));
    list.innerHTML = applicable.map((part) => {
      const selected = selectedParts.find((item) => item.id === part.id);
      return `<li data-part-search="${escapeHtml(`${part.name} ${part.part_number}`.toLowerCase())}">
        <label class="inline-choice"><input type="checkbox" data-select-part="${escapeHtml(part.id)}" ${selected ? 'checked' : ''} /><span>${escapeHtml(part.name)}<br><strong>${escapeHtml(partNumberLabel(part))}</strong>
        ${canManage() && benchmarkLabel(part) ? `<br>${escapeHtml(benchmarkLabel(part))}` : ''}</span></label>
        <label>Qty<input aria-label="Quantity for ${escapeHtml(part.name)}" type="number" min="1" max="999" required value="${selected?.quantity || 1}" data-part-quantity="${escapeHtml(part.id)}" ${selected ? '' : 'disabled'} /></label></li>`;
    }).join('');
    workspace.querySelector('#appliance-part-count').textContent = `${selectedParts.length} part(s) selected`;
    filterParts();
  }

  function filterParts() {
    const query = (workspace.querySelector('#appliance-part-search')?.value || '').trim().toLowerCase();
    workspace.querySelectorAll('[data-part-search]').forEach((row) => {
      row.hidden = !query.split(/\s+/).every((word) => row.dataset.partSearch.includes(word));
    });
  }

  async function render() {
    const owner = getOwner();
    if (navigationOwner !== owner) {
      navigationOwner = owner;
      activeTab = null;
      calendar = createCalendarState();
    }
    const generation = ++renderGeneration;
    const current = () => isCurrent() && owner === getOwner() && generation === renderGeneration;
    selectedParts = [];
    checkStart = null;
    entries = [];
    capturedPhoto = null;
    machineAudit = null;
    elapsedBefore = 0;
    activeVisitId = null;
    reportDraftKey = draftKey();
    workspace.innerHTML = '<div class="storage-view"><h1>Appliance reports</h1><p role="status">Loading...</p></div>';
    quotations.reset();
    try {
      const [catalogue, reportResponse, { properties }, draft, downloadedSchedule, downloadedAssets] = await Promise.all([
        apiRequest('/api/appliance-parts'), apiRequest('/api/appliance-reports'), apiRequest('/api/properties'), draftStorage.get(reportDraftKey),
        apiRequest('/api/technician-schedule'), apiRequest('/api/appliance-assets')
      ]);
      if (!current()) return;
      schedule = downloadedSchedule;
      assetData = downloadedAssets;
      availableProperties = properties;
      const { reports } = reportResponse;
      savedReports = reports;
      downloadedCopy = !!reportResponse.offline_copy;
      parts = catalogue.parts;
      const activeParts = parts.filter((part) => part.active);
      workspace.innerHTML = `<div class="storage-view">
        <h1>Appliance reports</h1>
        <div class="appliance-tabs" role="tablist" aria-label="Appliance sections">${applianceTabs(getUser().role).map(([id, label]) =>
          `<button type="button" class="button secondary" role="tab" id="appliance-tab-${id}" aria-controls="appliance-panel-${id}" aria-selected="false" tabindex="-1" data-appliance-tab="${id}">${label}</button>`).join('')}</div>
        ${scheduleHtml(schedule, reports, properties, getUser(), escapeHtml, calendar)}
        ${assetPanel(assetData, canManage(), escapeHtml)}
        ${canManage() ? quotationPanel(properties, escapeHtml) : ''}
        <section class="storage-panel" id="appliance-panel-checks" role="tabpanel" aria-labelledby="appliance-tab-checks" data-appliance-panel="checks" hidden><h2>Do appliance checks</h2>
          <form id="appliance-report-form" class="storage-form">
            <fieldset id="laundry-setup"><legend>1. Choose report</legend>
            <label>Building<select name="propertyId" required><option value="">Choose a building</option>${properties.map((property) => `<option value="${escapeHtml(property.id)}">${escapeHtml(property.name)}</option>`).join('')}</select></label>
            ${getUser().role === 'technician' ? `<label>Visit<select name="visitId" required><option value="">Choose a booked or extra visit</option>
              ${schedule.visits.filter((visit) => !visit.cancelled_at && !visit.rebooked_as && visitProgress(visit, reports).status !== 'complete').map((visit) =>
                `<option value="${escapeHtml(visit.id)}" data-property="${escapeHtml(visit.property_id)}">${escapeHtml(visit.building_name || properties.find((item) => item.id === visit.property_id)?.name)} - ${escapeHtml(new Date(visit.starts_at).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' }))}</option>`).join('')}
              <option value="extra">Extra visit at selected building (notify MM)</option></select></label>` : ''}
            <label>Report<select name="applianceType"><option>Washer</option><option>Dryer</option></select></label>
            <label>How many machines are here?<input name="expectedCount" type="number" min="1" max="200" required /></label>
            <p>Count all washers OR all dryers present. Machines in use can be left unchecked; finish after saving the available machines.</p>
            <button type="button" class="button primary" id="start-appliance-check">Start check</button>
            </fieldset>
            <p id="appliance-check-status" role="status">Location is required. Only admin/MM can see location and time records.</p>
            <p id="machine-progress" role="status"></p>
            <fieldset id="machine-entry" disabled><legend>2. Check this machine</legend>
            <label>Machine number<input name="machineNumber" required maxlength="40" placeholder="Number on the machine" /></label>
            <label>Serial number<input name="serialNumber" required maxlength="100" placeholder="Required once for each physical machine" /></label>
            <label class="inline-choice"><input name="replaceMachine" type="checkbox" disabled /> Replace machine with a new serial (preserves retired machine history)</label>
            <details><summary>Model</summary><label>Model number<input name="modelNumber" required maxlength="150" value="${defaultModels.Washer}" /></label></details>
            <div class="machine-condition">
              <label><input type="radio" name="status" value="working" required /> Working</label>
              <label><input type="radio" name="status" value="needs_repair" required /> Needs repair</label>
            </div>
            <div id="machine-repair-parts" hidden><label>What needs repair? (optional)<textarea name="notes" maxlength="4000" rows="2"></textarea></label>
            <fieldset class="ticket-schedule"><legend>Parts needed - tick all that apply</legend>
              <label>Find parts<input id="appliance-part-search" type="search" placeholder="Search washer, dryer, model, part name or number" /></label>
              <p id="appliance-part-count" role="status"></p>
              <ul id="appliance-parts-list" class="appliance-parts-list"></ul>
              ${activeParts.length ? '' : '<p>No parts have been loaded yet. A manager can add parts to the catalogue below.</p>'}
            </fieldset>
            </div>
            <button type="button" id="take-machine-photo" class="button secondary">Take photo</button>
            <p id="machine-photo-status" role="status">Take a photo of this machine.</p>
            <img id="machine-photo-preview" alt="New camera photo of this machine" hidden />
            <button type="submit" class="button primary">Save machine / Next</button>
            </fieldset>
            <ul id="checked-machines"></ul>
            <button type="button" class="button primary" id="finish-laundry-report" disabled>3. Finish report</button>
            <button type="button" class="button secondary" id="discard-laundry-draft">Discard unfinished report</button>
            <p>Each saved machine stays on this device until you finish and upload this report.</p>
          </form>
        </section>
        <section class="storage-panel" id="appliance-panel-reports" role="tabpanel" aria-labelledby="appliance-tab-reports" data-appliance-panel="reports" hidden><h2>Saved reports</h2>
          ${canManage() && reports.length ? `<div class="appliance-export-actions"><button type="button" class="button secondary" data-select-reports>Select all / clear</button>
            <button type="button" class="button secondary" data-export-selected="full">Full report</button>
            <button type="button" class="button primary" data-export-selected="parts">Replacement parts report</button>
            <p>Select reports to include. Repeated parts are totalled, with building/machine references.</p></div>` : ''}
          ${reports.map((report) => `<div>${canManage() ? `<label class="inline-choice"><input type="checkbox" data-select-report="${escapeHtml(report.id)}" /> Include this report in export</label>` : ''}<details class="appliance-record"><summary>${escapeHtml(report.building_name)} · ${escapeHtml(report.appliance_type)} · ${report.entries ? `${report.entries.length} checked / ${report.expected_count} declared - ${report.entries.filter((entry) => entry.status === 'needs_repair').length} need repair` : escapeHtml(report.model_number)}</summary>
            ${report.pending_sync ? '<p role="status">Saved on this device - awaiting server confirmation.</p>' : ''}
            <p>${escapeHtml(report.technician_name)} · ${escapeHtml(new Date(report.created_at).toLocaleString())}</p>
            <p class="thread-message">${escapeHtml(report.fault)}</p><p class="thread-message">${escapeHtml(report.notes)}</p>
            ${report.entries ? report.entries.map((entry) => `<details><summary>Machine ${escapeHtml(entry.machineNumber)} - ${machineStatus[entry.status]}</summary><p>Serial: ${escapeHtml(entry.serialNumber || 'Not recorded (historical)')}</p><p>${escapeHtml(entry.modelNumber)} - ${escapeHtml(entry.notes)}</p>
              <ul>${entry.parts.map((part) => `<li>${escapeHtml(part.name)} · ${escapeHtml(partNumberLabel(part))} · Qty ${part.quantity}</li>`).join('')}</ul>
              ${/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(entry.photo?.data || '') ? `<img class="machine-evidence" src="${entry.photo.data}" alt="Machine ${escapeHtml(entry.machineNumber)} camera evidence" loading="lazy" />` : ''}
              ${canManage() ? auditHtml(entry.checkAudit, report.pending_sync ? null : report.created_at, escapeHtml) : ''}</details>`).join('') : `<ul>${report.parts.map((part) => `<li>${escapeHtml(part.name)} · ${escapeHtml(partNumberLabel(part))} · Qty ${part.quantity}</li>`).join('')}</ul>`}
            ${canManage() ? auditHtml(report.check_audit, report.pending_sync ? null : report.created_at, escapeHtml) : ''}
            <button type="button" class="button secondary" data-export-appliance="${escapeHtml(report.id)}">Full report</button>
            ${canManage() ? `<button type="button" class="button secondary" data-export-parts="${escapeHtml(report.id)}">Replacement parts report</button>` : ''}
          </details></div>`).join('') || '<p>No reports yet.</p>'}
        </section>
        ${canManage() ? `<section class="storage-panel" id="appliance-panel-parts" role="tabpanel" aria-labelledby="appliance-tab-parts" data-appliance-panel="parts" hidden><h2>Manage parts catalogue</h2>
          <p>Add a part by name now; leave its number blank if unknown. Open the part below to add the number later. Saved reports keep their original part details.</p>
          <form id="new-appliance-part" class="storage-form">
            <label>Machine type<select name="machineType"><option>Washer</option><option>Dryer</option><option>Combo</option></select></label>
            <label>Part name<input name="name" required maxlength="150" /></label>
            <label>Part number (optional - add later)<input name="partNumber" maxlength="100" placeholder="Leave blank if not yet known" /></label>
            <button type="submit" class="button primary">Add part</button>
          </form>
          ${parts.map((part) => `<details class="appliance-record"><summary>${escapeHtml(part.name)} · ${escapeHtml(partNumberLabel(part))}${part.active ? '' : ' (inactive)'}</summary>
            <p>${escapeHtml(benchmarkLabel(part))}</p>
            ${part.alternate_number ? `<p>Alternate / aftermarket number: ${escapeHtml(part.alternate_number)}</p>` : ''}
            <form class="storage-form edit-appliance-part" data-part-id="${escapeHtml(part.id)}">
              <label>Machine type<select name="machineType"><option value="">Choose type</option>${['Washer', 'Dryer', 'Combo'].map((type) => `<option ${part.machine_type === type ? 'selected' : ''}>${type}</option>`).join('')}</select></label>
              <label>Part name<input name="name" required maxlength="150" value="${escapeHtml(part.name)}" /></label>
              <label>Part number (optional - add later)<input name="partNumber" maxlength="100" value="${escapeHtml(part.part_number)}" /></label>
              <input type="hidden" name="supplier" value="${escapeHtml(part.supplier)}" />
              <label class="inline-choice"><input type="checkbox" name="active" ${part.active ? 'checked' : ''} /> Available to technicians</label>
              <button type="submit" class="button secondary">Save part</button>
            </form>
          </details>`).join('')}
        </section>` : ''}
      </div>`;
      partRows();
      const form = reportForm();
      if (draft?.checkStart) {
        form.elements.propertyId.value = draft.propertyId;
        if (!form.elements.propertyId.value) throw new Error('The saved laundry draft belongs to a building you cannot access. Contact your manager.');
        form.elements.applianceType.value = draft.applianceType;
        form.elements.expectedCount.value = draft.expectedCount;
        form.elements.modelNumber.value = draft.modelNumber;
        entries = draft.entries;
        checkStart = draft.checkStart;
        elapsedBefore = draft.elapsed;
        startedElapsed = performance.now();
        startedOffline = draft.startedOffline;
        activeVisitId = draft.visitId;
        if (getUser().role === 'technician') {
          form.elements.visitId.value = activeVisitId;
          const visit = schedule.visits.find((item) => item.id === activeVisitId);
          if (!visit || visit.cancelled_at || visit.property_id !== draft.propertyId) {
            throw Object.assign(new Error('This draft predates visit bookings, changed, or was cancelled. Discard it and start a current visit, or contact MM.'), { code: 'DRAFT_VISIT_UNAVAILABLE' });
          }
        }
        workspace.querySelector('#laundry-setup').disabled = true;
        workspace.querySelector('#appliance-check-status').textContent = 'Saved check restored. Continue with the next machine.';
      }
      const pinForm = workspace.querySelector('#technician-location-form');
      if (pinForm) pinForm.elements.propertyId.dispatchEvent(new Event('change', { bubbles: true }));
      const bookingForm = workspace.querySelector('#technician-booking-form');
      if (bookingForm) bookingForm.elements.propertyId.dispatchEvent(new Event('change', { bubbles: true }));
      selectTab(activeTab || (draft?.checkStart ? 'checks' : 'schedule'));
      if (activeTab === 'quotes') await quotations.load();
      resetMachine();
    } catch (error) {
      if (current()) workspace.innerHTML = `<div class="storage-view"><h1>Appliance reports</h1><p role="alert">${escapeHtml(error.message)}</p>${error.code === 'DRAFT_VISIT_UNAVAILABLE' ? '<button type="button" class="button secondary" id="discard-laundry-draft">Discard unavailable draft</button>' : ''}</div>`;
    }
  }

  function checkVisitLocation(location) {
    if (getUser().role !== 'technician') return;
    const form = reportForm();
    const visit = schedule.visits.find((item) => item.id === activeVisitId);
    assertVisitPoint(visit, location, schedule.locations.find((pin) => pin.property_id === form.elements.propertyId.value));
  }

  workspace.addEventListener('change', (event) => {
    if (event.target.name === 'visitId' && event.target.form?.id === 'appliance-report-form') {
      const property = event.target.selectedOptions[0]?.dataset.property;
      if (property) reportForm().elements.propertyId.value = property;
    }
    if (event.target.name === 'applianceType') {
      reportForm().elements.modelNumber.value = defaultModels[event.target.value];
      selectedParts = [];
      partRows();
    }
    if (['machineNumber', 'propertyId', 'applianceType'].includes(event.target.name) && event.target.form?.id === 'appliance-report-form') fillMachineIdentity();
    if (event.target.name === 'replaceMachine') {
      const form = reportForm();
      form.elements.serialNumber.readOnly = !event.target.checked && !!currentAsset();
      form.elements.serialNumber.value = event.target.checked ? '' : currentAsset()?.serial_number || '';
    }
    if (['machineNumber', 'modelNumber', 'serialNumber', 'replaceMachine', 'status'].includes(event.target.name)) {
      capturedPhoto = null;
      machineAudit = null;
      workspace.querySelector('#machine-photo-preview').hidden = true;
      workspace.querySelector('#machine-photo-status').textContent = 'Take a photo of this machine.';
    }
    if (event.target.name === 'status') {
      const needsRepair = event.target.value === 'needs_repair';
      workspace.querySelector('#machine-repair-parts').hidden = !needsRepair;
      if (!needsRepair) {
        selectedParts = [];
        reportForm().elements.notes.value = '';
        partRows();
      }
    }
    if (event.target.dataset.selectPart) {
      const id = event.target.dataset.selectPart;
      if (event.target.checked) selectedParts.push({ id, quantity: 1 });
      else selectedParts = selectedParts.filter((part) => part.id !== id);
      partRows();
      return;
    }
    if (!event.target.dataset.partQuantity) return;
    const part = selectedParts.find((item) => item.id === event.target.dataset.partQuantity);
    if (part) part.quantity = Number(event.target.value);
  });
  workspace.addEventListener('input', (event) => {
    if (event.target.id === 'appliance-part-search') filterParts();
    if (event.target.dataset.partQuantity) {
      const part = selectedParts.find((item) => item.id === event.target.dataset.partQuantity);
      if (part) part.quantity = Number(event.target.value);
    }
  });

  workspace.addEventListener('click', async (event) => {
    if (!isCurrent()) return;
    const tab = event.target.closest('[data-appliance-tab]');
    if (tab) { selectTab(tab.dataset.applianceTab); return; }
    const openChecks = event.target.closest('[data-check-visit]');
    if (openChecks) {
      if (checkStart && activeVisitId !== openChecks.dataset.checkVisit) {
        alertError(new Error('Finish or discard the current draft before choosing another visit.'), 'Unfinished check');
        return;
      }
      selectTab('checks');
      const form = reportForm();
      form.elements.visitId.value = openChecks.dataset.checkVisit;
      form.elements.visitId.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (event.target.closest('#discard-laundry-draft')) {
      if (!confirm('Discard this unfinished laundry report and its saved machine photos? Finished reports will not change.')) return;
      try {
        await draftStorage.set(reportDraftKey, null);
        await render();
      } catch (error) { alertError(error, 'Could not discard the unfinished report.'); }
      return;
    }
    const startButton = event.target.closest('#start-appliance-check');
    if (startButton) {
      startButton.disabled = true;
      checkStart = null;
      const status = workspace.querySelector('#appliance-check-status');
      status.textContent = 'Getting current location...';
      try {
        const form = reportForm();
        if (!form.elements.propertyId.reportValidity() || !form.elements.expectedCount.reportValidity()) return;
        const location = await captureCheckLocation();
        if (!isCurrent() || !startButton.isConnected) return;
        if (getUser().role === 'technician') {
          if (!form.elements.visitId.reportValidity()) return;
          const extra = form.elements.visitId.value === 'extra';
          const id = extra ? crypto.randomUUID() : form.elements.visitId.value;
          const visit = extra ? { id, property_id: form.elements.propertyId.value, ...bookingWindow({ date: localDay(location.capturedAt), allDay: true }) }
            : schedule.visits.find((item) => item.id === id);
          if (!visit || visit.property_id !== form.elements.propertyId.value) throw new Error('The selected visit belongs to another building.');
          assertCanMove(schedule.visits, savedReports, id);
          assertVisitPoint(visit, location, schedule.locations.find((pin) => pin.property_id === visit.property_id));
          const checked = await apiRequest('/api/technician-checkins', { method: 'POST', body: { id, propertyId: visit.property_id, extra: extra || visit.kind === 'extra', location } });
          if (!isCurrent() || !startButton.isConnected) return;
          activeVisitId = id;
          const index = schedule.visits.findIndex((item) => item.id === id);
          if (index >= 0) schedule.visits[index] = checked.visit;
          else schedule.visits.push(checked.visit);
        }
        checkStart = location;
        startedElapsed = performance.now();
        startedOffline = navigator.onLine === false;
        currentMachineStart = location;
        currentMachineElapsed = performance.now();
        elapsedBefore = 0;
        await persistDraft();
        workspace.querySelector('#laundry-setup').disabled = true;
        resetMachine();
        status.textContent = 'Check started. Select Working or Needs repair, take a photo, then Next.';
      } catch (error) {
        status.textContent = error.message;
        alertError(error, 'Could not start check.');
      } finally {
        startButton.disabled = false;
      }
      return;
    }
    const cameraButton = event.target.closest('#take-machine-photo');
    if (cameraButton) {
      const form = reportForm();
      if (!form.elements.machineNumber.reportValidity() || !form.elements.status.value) {
        alertError(new Error('Enter the machine number and tick Working or Needs repair first.'), 'Check this machine.');
        return;
      }
      form.inert = true;
      capturedPhoto = null;
      machineAudit = null;
      workspace.querySelector('#machine-photo-preview').hidden = true;
      workspace.querySelector('#machine-photo-status').textContent = 'Opening camera and capturing location...';
      try {
        const photo = await takeMachinePhoto(workspace);
        const completed = await captureCheckLocation();
        if (!isCurrent() || !form.isConnected) return;
        checkVisitLocation(completed);
        capturedPhoto = photo;
        machineAudit = {
          started: currentMachineStart, completed, durationMs: performance.now() - currentMachineElapsed,
          offlineCompleted: startedOffline || navigator.onLine === false
        };
        const preview = workspace.querySelector('#machine-photo-preview');
        preview.src = photo.data;
        preview.hidden = false;
        workspace.querySelector('#machine-photo-status').textContent = 'Photo taken. Press Save machine / Next.';
      } catch (error) {
        capturedPhoto = null;
        machineAudit = null;
        if (form.isConnected) workspace.querySelector('#machine-photo-status').textContent = error.message;
        alertError(error, 'Could not capture photo and location.');
      } finally {
        form.inert = false;
      }
      return;
    }
    const remove = event.target.closest('[data-remove-machine]');
    if (remove) {
      try {
        const index = Number(remove.dataset.removeMachine);
        const previous = entries[index];
        entries.splice(index, 1);
        try { await persistDraft(); }
        catch (error) { entries.splice(index, 0, previous); throw error; }
        resetMachine();
        reportForm().elements.machineNumber.value = previous.machineNumber;
        reportForm().elements.modelNumber.value = previous.modelNumber;
        fillMachineIdentity();
        reportForm().elements.serialNumber.value = previous.serialNumber || currentAsset()?.serial_number || '';
        if (previous.replaceAssetId) {
          reportForm().elements.replaceMachine.checked = true;
          reportForm().elements.serialNumber.readOnly = false;
        }
      } catch (error) { alertError(error, 'Could not update saved check.'); }
      return;
    }
    const finish = event.target.closest('#finish-laundry-report');
    if (finish) {
      const form = reportForm();
      form.inert = true;
      try {
        const completed = await captureCheckLocation();
        if (!isCurrent() || !form.isConnected) return;
        checkVisitLocation(completed);
        const body = validateLaundryReport(reportBody(completed));
        await apiRequest('/api/appliance-reports', { method: 'POST', body });
        await draftStorage.set(reportDraftKey, null);
        activeTab = 'reports';
        await render();
      } catch (error) { alertError(error, 'Could not finish report. Your saved machines remain on this device.'); }
      finally { form.inert = false; }
      return;
    }
    if (event.target.closest('[data-select-reports]') && canManage()) {
      const boxes = [...workspace.querySelectorAll('[data-select-report]')];
      const select = boxes.some((box) => !box.checked);
      boxes.forEach((box) => { box.checked = select; });
      return;
    }
    const combined = event.target.closest('[data-export-selected], [data-export-parts]');
    if (combined && canManage()) {
      try {
        const ids = combined.dataset.exportParts ? [combined.dataset.exportParts]
          : [...workspace.querySelectorAll('[data-select-report]:checked')].map((box) => box.dataset.selectReport);
        if (!ids.length || ids.length > 200) throw new Error('Select between 1 and 200 reports to export.');
        const reports = ids.map((id) => savedReports.find((report) => report.id === id));
        const mode = combined.dataset.exportSelected || 'parts';
        if (downloadedCopy || reports.some((report) => report.pending_sync)) {
          await printDocument(combinedReportHtml(reports.map((report) => ({ ...report, offline_copy: downloadedCopy })), mode, true), mode === 'parts' ? 'Replacement-parts' : 'Appliance-reports');
        } else {
          const { html, title } = await apiRequest('/api/appliance-reports/export', { method: 'POST', body: { ids, mode } });
          await printDocument(html, title);
        }
      } catch (error) { alertError(error, 'Could not export selected reports.'); }
      return;
    }
    const button = event.target.closest('[data-export-appliance]');
    if (!button) return;
    try {
      const { html, title } = await apiRequest(`/api/appliance-reports/${encodeURIComponent(button.dataset.exportAppliance)}/export`);
      await printDocument(html, title);
    } catch (error) {
      alertError(error, 'Could not export the appliance report.');
    }
  });

  workspace.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!isCurrent() || !form.matches('#appliance-report-form, #new-appliance-part, .edit-appliance-part')) return;
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(form));
      if (form.id === 'appliance-report-form') {
        if (!checkStart) throw new Error('Press Start check at the appliance before saving the report.');
        if (!capturedPhoto || !machineAudit) throw new Error('Take a new photo of this machine before pressing Next.');
        const entry = {
          machineNumber: values.machineNumber?.trim(), modelNumber: values.modelNumber?.trim(), status: values.status,
          serialNumber: form.elements.serialNumber.value.trim(),
          ...(values.replaceMachine === 'on' && currentAsset() ? { replaceAssetId: currentAsset().id } : {}),
          notes: values.status === 'needs_repair' ? values.notes : '', parts: selectedParts,
          photo: capturedPhoto, checkAudit: machineAudit
        };
        const next = [...entries, entry];
        if (next.length > Number(form.elements.expectedCount.value)) throw new Error('All declared machines have already been checked.');
        validateLaundryReport({ ...reportBody(machineAudit.completed), entries: next, expectedCount: next.length });
        entries = next;
        try { await persistDraft(); }
        catch (error) { entries = next.slice(0, -1); throw error; }
        resetMachine();
        return;
      } else if (form.id === 'new-appliance-part') {
        await apiRequest('/api/appliance-parts', { method: 'POST', body: values });
      } else {
        await apiRequest(`/api/appliance-parts/${encodeURIComponent(form.dataset.partId)}`, { method: 'PUT', body: { ...values, active: values.active === 'on' } });
      }
      await render();
    } catch (error) {
      alertError(error, 'Could not save.');
    } finally {
      submit.disabled = false;
    }
  });

  return { render };
}
