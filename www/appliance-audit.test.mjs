import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAudit, auditReview, auditHtml } from './appliance-audit.mjs';
import { reportHtml, combinedReportHtml } from './appliance-report.mjs';

const point = { latitude: -25.75, longitude: 28.19, accuracy: 10, capturedAt: '2026-10-30T08:00:00.000Z', mocked: false };
const audit = {
  started: point, completed: { ...point, capturedAt: '2026-10-30T08:03:00.000Z' },
  durationMs: 180000, offlineCompleted: false
};

test('requires complete valid location evidence and rejects mock locations', () => {
  assert.deepEqual(validateAudit(audit), audit);
  for (const invalid of [
    null, {}, { ...audit, durationMs: -1 }, { ...audit, durationMs: '123' },
    { ...audit, offlineCompleted: 'false' }, { ...audit, completed: null },
    ...[
      { latitude: 91 }, { longitude: -181 }, { accuracy: -1 }, { accuracy: null },
      { latitude: '0' }, { capturedAt: 'bad' }, { mocked: true }, { mocked: undefined },
      { capturedAt: '2026-10-30T07:59:00Z' }
    ].map((change) => ({ ...audit, completed: { ...audit.completed, ...change } }))
  ]) assert.throws(() => validateAudit(invalid));
  assert(!('verified' in validateAudit({ ...audit, verified: true })));
});

test('flags offline, upload delay, clock changes and poor accuracy without claiming verification', () => {
  assert(auditReview(null).includes('Legacy'));
  assert(auditReview(audit).includes('Pending server receipt'));
  assert(!auditReview(audit, '2026-10-30T08:08:00Z').includes('Delayed upload'));
  assert(auditReview(audit, '2026-10-30T08:08:01Z').includes('Delayed upload'));
  assert(auditReview(audit, '2026-10-30T08:00:00Z').includes('ahead'));
  assert(auditReview({ ...audit, offlineCompleted: true }, '2026-10-30T08:04:00Z').includes('Completed offline'));
  assert(auditReview({ ...audit, completed: { ...audit.completed, accuracy: 101 } }).includes('Low location accuracy'));
  assert(auditReview({ ...audit, durationMs: 0 }).includes('elapsed time disagree'));
  assert(auditReview(audit).includes('does not verify physical presence'));
});

test('audit is excluded from default exports and parts orders, included only by manager renderer opt-in', () => {
  const report = { id: 'r', parts: [], created_at: '2026-10-30T08:04:00Z', check_audit: audit };
  assert(!reportHtml(report).includes('28.19'));
  assert(reportHtml(report, true).includes('28.19'));
  assert(!combinedReportHtml([report], 'full').includes('28.19'));
  assert(combinedReportHtml([report], 'full', true).includes('28.19'));
  assert(!combinedReportHtml([report], 'parts', true).includes('28.19'));
  const escape = (value) => String(value).replaceAll('<', '&lt;');
  assert(auditHtml(audit, '<unsafe>', escape).includes('&lt;unsafe>'));
});
