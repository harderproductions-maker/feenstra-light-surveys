import { auditHtml } from './appliance-audit.mjs';
import { machineStatus, partNumberLabel } from './laundry.mjs';
import { reportDocument, reportContent, reportStyles, reportBadge } from './report-layout.mjs';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function reportOptions(report, includeAudit) {
  const entries = report.entries || [{
    machineNumber: 'Legacy entry', modelNumber: report.model_number, notes: [report.fault, report.notes].filter(Boolean).join('\n'), parts: report.parts || []
  }];
  const repairs = entries.filter((entry) => entry.status === 'needs_repair').length;
  const machines = entries.map((entry) => {
    const rows = entry.parts.map((part) => `<tr><td>${escapeHtml(part.name)}</td><td>${escapeHtml(partNumberLabel(part))}</td><td>${part.quantity}</td></tr>`).join('');
    const photo = typeof entry.photo?.data === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(entry.photo.data)
      ? `<figure><img alt="Camera evidence for machine ${escapeHtml(entry.machineNumber)}" src="${entry.photo.data}" /><figcaption>Machine ${escapeHtml(entry.machineNumber)} &middot; Camera evidence</figcaption></figure>` : '';
    return `<article class="machine-record"><h2>Machine ${escapeHtml(entry.machineNumber)}</h2>
      <p>${reportBadge(machineStatus[entry.status] || 'Historical report', entry.status === 'working' ? 'good' : entry.status === 'needs_repair' ? 'bad' : 'neutral')}</p>
      <p><strong>Model:</strong> ${escapeHtml(entry.modelNumber)} &middot; <strong>Serial:</strong> ${escapeHtml(entry.serialNumber || 'Not recorded (historical)')}</p>${entry.notes ? `<p class="notes">${escapeHtml(entry.notes)}</p>` : ''}${photo}
      <h3>Replacement parts</h3>
      <table><thead><tr><th>Part</th><th>Part number</th><th>Quantity</th></tr></thead><tbody>${rows || '<tr><td colspan="3">No replacement parts recorded.</td></tr>'}</tbody></table>
      ${includeAudit && entry.checkAudit ? `<div class="audit-record">${auditHtml(entry.checkAudit, report.pending_sync ? null : report.created_at, escapeHtml)}</div>` : ''}</article>`;
  }).join('');
  return {
    title: 'Appliance report', subtitle: report.building_name, category: 'Laundry & appliance inspection',
    metadata: [['Reference', report.id], ['Report date (UTC)', new Date(report.created_at).toISOString()],
      ['Technician', report.technician_name], ['Location / appliance', `Laundry room - ${report.appliance_type || 'Not recorded'}`]],
    summary: report.entries ? [['Machines checked', `${entries.length} / ${report.expected_count}`], ['Working', entries.filter((entry) => entry.status === 'working').length],
      ['Need repair', repairs], ['Parts required', entries.reduce((total, entry) => total + entry.parts.reduce((sum, part) => sum + part.quantity, 0), 0)]] : [],
    notice: report.pending_sync || report.offline_copy ? 'OFFLINE COPY - verify against the server before ordering.' : '',
    body: `${report.entries ? `<p>${entries.length} of ${escapeHtml(report.expected_count)} declared machines checked. ${repairs} need repair.</p>${report.expected_count > entries.length ? `<p>Not checked: ${report.expected_count - entries.length}. These machines have not been assessed.</p>` : ''}` : ''}
      ${machines}
      ${includeAudit ? `<div class="audit-record">${auditHtml(report.check_audit, report.pending_sync ? null : report.created_at, escapeHtml)}</div>` : ''}`
  };
}

export function reportHtml(report, includeAudit = false) {
  return reportDocument(reportOptions(report, includeAudit));
}

export function aggregateParts(reports) {
  const groups = new Map();
  for (const report of reports) {
    for (const entry of report.entries || [{ machineNumber: 'Legacy entry', modelNumber: report.model_number, parts: report.parts || [] }]) {
      for (const part of entry.parts) {
      const key = JSON.stringify([part.part_number || '', part.name, part.part_number ? null : part.id]);
      if (!groups.has(key)) groups.set(key, { name: part.name, part_number: part.part_number, quantity: 0, references: [] });
      const group = groups.get(key);
      group.quantity += part.quantity;
      group.references.push({
        building: report.building_name, machine: entry.machineNumber, model: entry.modelNumber,
        report: report.id, quantity: part.quantity
      });
      }
    }
  }
  return [...groups.values()].sort((a, b) => (a.part_number || '').localeCompare(b.part_number || '') || a.name.localeCompare(b.name));
}

export function combinedReportHtml(reports, mode, includeAudit = false) {
  if (!reports.length || !['full', 'parts'].includes(mode)) throw new Error('Choose reports and an export type.');
  if (mode === 'full') {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Full appliance reports</title>
      <style>${reportStyles}</style></head><body>
      ${reports.map((report) => `<section class="report-page">${reportContent(reportOptions(report, includeAudit))}</section>`).join('')}</body></html>`;
  }
  const parts = aggregateParts(reports);
  return reportDocument({
    title: 'Replacement parts report', category: 'Maintenance procurement',
    metadata: [['Prepared (UTC)', new Date().toISOString()], ['Scope', `${reports.length} selected appliance report(s)`]],
    summary: [['Selected reports', reports.length], ['Part lines', parts.length], ['Total quantity', parts.reduce((total, part) => total + part.quantity, 0)],
      ['Numbers pending', parts.filter((part) => !part.part_number).length]],
    notice: reports.some((report) => report.pending_sync || report.offline_copy) ? 'OFFLINE / PROVISIONAL COPY - verify pending reports before ordering.' : '',
    body: `<p>Quantities are combined by part number and description.</p>
    ${parts.some((part) => !part.part_number) ? '<aside class="report-notice">Part numbers marked pending must be confirmed before ordering. Historical report details are not updated when the catalogue changes.</aside>' : ''}
    <h2>Consolidated parts schedule</h2><table><thead><tr><th>Part number</th><th>Part</th><th>Total quantity</th><th>Building / machine / model / report reference</th></tr></thead><tbody>
    ${parts.map((part) => `<tr><td>${escapeHtml(partNumberLabel(part))}</td><td>${escapeHtml(part.name)}</td><td>${part.quantity}</td><td>${part.references.map((reference) => `${escapeHtml(reference.building)} / Machine ${escapeHtml(reference.machine)} / ${escapeHtml(reference.model)} / ${escapeHtml(reference.report)} (Qty ${reference.quantity})`).join('<br>')}</td></tr>`).join('') || '<tr><td colspan="4">No replacement parts recorded.</td></tr>'}
    </tbody></table>`
  });
}
