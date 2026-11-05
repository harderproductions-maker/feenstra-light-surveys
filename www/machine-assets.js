import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { downloadQuoteFile } from './parts-quotes.js';

export function benchmarkLabel(part) {
  if (!Array.isArray(part.benchmark_prices) || !part.benchmark_prices.length) return '';
  return `Benchmark: ${part.benchmark_prices.map(({ supplier, price }) => `${supplier}: ${Number(price).toFixed(2)}`).join(' / ')}`;
}

export function assetPanel(data, canManage, escape) {
  const name = (id) => data.properties.find((property) => property.id === id)?.name || id;
  return `<section class="storage-panel" id="appliance-panel-assets" role="tabpanel" aria-labelledby="appliance-tab-assets" data-appliance-panel="assets" hidden>
    <h2>Machine asset management</h2>
    <p>Register a serial on the first machine check. Later checks reuse it. Choose Replace machine during a check for a new machine; the retired machine keeps its history.</p>
    ${data.offline_copy ? '<p role="status">Downloaded snapshot - reconnect to refresh totals or record orders/replacements.</p>' : ''}
    <p>Breakdowns count separate repair episodes. Repeated checks while still broken count once, until a Working check closes the episode. Requested parts are not orders or confirmed replacements.</p>
    ${data.unlinkedChecks ? `<p>${data.unlinkedChecks} historical checks have no serial-linked asset and are excluded from machine breakdown totals.</p>` : ''}
    ${canManage ? '<button type="button" class="button primary" data-asset-export>Download Excel report (one tab per building)</button>' : ''}
    <h3>Buildings ranked by breakdowns</h3>
    <ul>${data.buildings.map((building) => `<li><strong>${escape(name(building.property_id))}</strong>: ${building.breakdowns} breakdowns;
      ${building.needs_repair} active machines need repair; ${building.active} active machines</li>`).join('') || '<li>No registered machines yet.</li>'}</ul>
    ${data.properties.map((property) => `<details class="appliance-record"><summary>${escape(property.name)}</summary>
      <h3>Machines</h3>
      ${data.machines.filter((machine) => machine.property_id === property.id).map((machine) => `<details><summary>
        ${escape(machine.appliance_type)} ${escape(machine.machine_number)} - Serial ${escape(machine.serial_number)}${machine.active ? '' : ' (retired)'}</summary>
        <p>Model ${escape(machine.model_number)}; ${escape(machine.status)}; ${machine.breakdowns} breakdowns; ${machine.inspections} checks.</p>
        <p>Parts: ${machine.requested} requested / ${machine.ordered} ordered / ${machine.replaced} replaced.</p>
        <ul>${data.reports.flatMap((report) => (report.entries || []).filter((entry) => entry.assetId === machine.id).map((entry) =>
          `<li>${escape(new Date(entry.checkAudit?.completed?.capturedAt || report.created_at).toLocaleString())} - ${escape(entry.status)} - Report ${escape(report.id)}</li>`)).join('')}</ul>
      </details>`).join('') || '<p>No machines registered.</p>'}
      <h3>Frequently requested / ordered / replaced parts</h3>
      <ul>${(data.buildings.find((building) => building.property_id === property.id)?.parts || []).map((part) =>
        `<li>${escape(part.name)} (${escape(part.part_number || 'Pending')}): ${part.requested} requested / ${part.ordered} ordered / ${part.replaced} replaced</li>`).join('') || '<li>No parts recorded.</li>'}</ul>
      <h3>Record orders and fitted parts</h3>
      <p>Only MMs/admins record orders. Technicians and managers can confirm ordered parts fitted. A connection is required.</p>
      ${data.requests.filter((request) => request.property_id === property.id).map((request) => `<form class="storage-form asset-part-action"
        data-report="${escape(request.report_id)}" data-asset="${escape(request.asset_id)}" data-part="${escape(request.part_id)}">
        <p>Machine ${escape(request.machine_number)} / Serial ${escape(request.serial_number)}: ${escape(request.name)} (${escape(request.part_number || 'Pending')})<br>
        Report ${escape(request.report_id)}: ${request.requested} requested / ${request.ordered} ordered / ${request.replaced} replaced</p>
        <label>Action<select name="action">${canManage ? '<option value="ordered">Mark ordered</option>' : ''}<option value="replaced">Confirm fitted / replaced</option></select></label>
        <label>Quantity<input name="quantity" type="number" min="1" max="999" value="1" required /></label>
        <button type="submit" class="button secondary">Record action</button>
      </form>`).join('') || '<p>No serial-linked part requests.</p>'}
    </details>`).join('')}
  </section>`;
}

export function wireAssetActions({ workspace, apiRequest, isCurrent, getOwner, render, alertError }) {
  workspace.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!isCurrent() || !form.matches('.asset-part-action')) return;
    event.preventDefault();
    const owner = getOwner();
    form.inert = true;
    try {
      const body = {
        reportId: form.dataset.report, assetId: form.dataset.asset, partId: form.dataset.part,
        action: form.elements.action.value, quantity: Number(form.elements.quantity.value)
      };
      const signature = JSON.stringify(body);
      if (form.dataset.operationBody !== signature) {
        form.dataset.operationBody = signature;
        form.dataset.operationId = crypto.randomUUID();
      }
      await apiRequest('/api/appliance-assets/parts', { method: 'POST', headers: { 'X-Operation-ID': form.dataset.operationId }, body });
      if (isCurrent() && owner === getOwner()) await render();
    } catch (error) { alertError(error, 'Could not record part action. Connect to the server and try again.'); }
    finally { form.inert = false; }
  });
  workspace.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-asset-export]');
    if (!isCurrent() || !button) return;
    const owner = getOwner();
    button.disabled = true;
    try {
      const file = await apiRequest('/api/appliance-assets/export');
      if (!isCurrent() || owner !== getOwner()) return;
      if (Capacitor.isNativePlatform()) {
        const saved = await Filesystem.writeFile({ path: file.filename, data: file.base64, directory: Directory.Cache });
        if (!isCurrent() || owner !== getOwner()) return;
        await Share.share({ title: 'Machine asset report', url: saved.uri, dialogTitle: 'Save or share Excel workbook' });
        return;
      }
      const bytes = Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0));
      downloadQuoteFile(bytes, file.filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    } catch (error) { alertError(error, 'Could not download Excel report. A server connection is required.'); }
    finally { button.disabled = false; }
  });
}
