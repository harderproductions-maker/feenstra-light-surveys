import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportDocument, reportContent, reportBadge, reportStyles } from './report-layout.mjs';
import { reportHtml, combinedReportHtml } from './appliance-report.mjs';

test('report documents embed the purple brand and print layout without network dependencies', () => {
  const html = reportDocument({
    title: 'Inspection', subtitle: 'North building', category: 'Maintenance',
    metadata: [['Inspector', 'Example Inspector'], ['Date', '30 Oct 2026']],
    summary: [['Checked', 4], ['Needs attention', 2]],
    notice: 'OFFLINE COPY', body: '<h2>Findings</h2><p>Recorded evidence</p>', footer: 'Verify the applicable standard.'
  });
  for (const text of ['lang="en"', 'PRIMEOPS', '#3a2aa8', '@page{size:A4;margin:15mm}', 'table-header-group',
    'print-color-adjust:exact', 'report-metadata', 'Example Inspector', 'Needs attention', 'OFFLINE COPY', 'Recorded evidence', 'Verify the applicable standard.']) {
    assert(html.includes(text), text);
  }
  assert(!/<script|<link|@import|https?:\/\//i.test(html));
  assert(html.includes('<svg class="report-mark"'));
  assert(!html.includes('class="report-mark">PO'));
  assert(!reportStyles.includes('.entry{break-inside:avoid'));
});

test('all report labels, metadata, notices and summary values are escaped', () => {
  const unsafe = '<script>alert("unsafe")</script>';
  const html = reportDocument({
    title: unsafe, subtitle: unsafe, category: unsafe,
    metadata: [[unsafe, unsafe]], summary: [[unsafe, unsafe]], notice: unsafe, footer: unsafe
  });
  assert(!html.includes('<script>'));
  assert.equal((html.match(/&lt;script&gt;/g) || []).length, 12);
  assert(reportBadge(unsafe, '" onclick="alert(1)').includes('class="report-badge neutral"'));
  assert(!reportBadge(unsafe).includes('<script>'));
  assert(!reportContent({ title: 'Empty' }).includes('class="summary"'));
  assert(reportContent({ title: 'Empty', metadata: [['Inspector', null]] }).includes('Not recorded'));
});

const reports = [{
  id: 'DEMO-01', building_name: 'Example building', technician_name: 'Example Technician',
  appliance_type: 'Washer', created_at: '2026-10-30T09:00:00Z', expected_count: 2, offline_copy: true,
  entries: [
    { machineNumber: '1', modelNumber: 'Washer model', status: 'working', notes: 'No faults.', parts: [] },
    { machineNumber: '2', modelNumber: 'Washer model', status: 'needs_repair', notes: 'Replace belt.', parts: [{ name: 'Belt', part_number: 'P-100', quantity: 2 }] }
  ]
}];

test('appliance summaries retain findings, status, quantities and offline warnings', () => {
  const html = reportHtml(reports[0]);
  for (const text of ['report-header', 'report-badge good', 'report-badge bad', '2 / 2', 'Need repair', 'Replace belt.', 'P-100',
    'OFFLINE COPY', 'DEMO-01', 'Example Technician', '2026-10-30T09:00:00.000Z']) assert(html.includes(text), text);
  assert(!html.includes('Check audit'));
});

test('combined full reports reuse the branded layout and start each report on a fresh page', () => {
  const html = combinedReportHtml([...reports, { ...reports[0], id: 'DEMO-02' }], 'full');
  assert.equal((html.match(/<section class="report-page">/g) || []).length, 2);
  assert.equal((html.match(/<header class="report-header">/g) || []).length, 2);
  assert.equal((html.match(/<style>/g) || []).length, 1);
  assert(html.includes('.report-page+.report-page{break-before:page}'));
  assert(html.includes('DEMO-01'));
  assert(html.includes('DEMO-02'));
});

test('procurement reports preserve quantities and source references in the new layout', () => {
  const html = combinedReportHtml(reports, 'parts');
  for (const text of ['Maintenance procurement', 'Consolidated parts schedule', '<td>2</td>',
    'Example building / Machine 2 / Washer model / DEMO-01', 'PROVISIONAL']) assert(html.includes(text), text);
});
