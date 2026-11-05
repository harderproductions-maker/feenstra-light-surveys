import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAtBuilding, assertVisitPoint, assertCanMove, bookingWindow, localDay, visitProgress, attendance, attendanceHtml } from './technician-visits.mjs';
import { createOfflineStore } from './offline.mjs';
import { validateLaundryReport } from './laundry.mjs';

const boundary = { property_id: 'p', latitude: -25.75, longitude: 28.19, radius: 100 };
const point = (changes = {}) => ({ latitude: boundary.latitude, longitude: boundary.longitude, accuracy: 8,
  capturedAt: '2026-10-30T08:00:00.000Z', mocked: false, ...changes });
const visit = { id: 'one', technician_id: 'tech', property_id: 'p', kind: 'booking',
  ...bookingWindow({ date: '2026-10-30', startTime: '08:00', endTime: '12:00' }), started_at: point().capturedAt };

test('undated postponement is not a missed appointment and cannot receive check evidence', () => {
  const postponed = { ...visit, started_at: null, booking_status: 'postponed', cancelled_at: visit.starts_at };
  assert.equal(visitProgress(postponed, [], '2099-01-01').status, 'postponed');
  const summary = attendance([postponed], [], '2099-01-01');
  assert.equal(summary.totals.appointments, 0);
  assert.equal(summary.totals.missedAppointments, 0);
  assert.equal(summary.totals.missedDays, 0);
  assert.throws(() => assertVisitPoint(postponed, point(), boundary), /unavailable or cancelled/);
});

test('whole-day and timed bookings use South African dates including midnight boundaries', () => {
  assert.deepEqual(bookingWindow({ date: '2026-10-30', allDay: true }), { starts_at: '2026-10-29T22:00:00.000Z', ends_at: '2026-10-30T22:00:00.000Z' });
  assert.equal(visit.starts_at, '2026-10-30T06:00:00.000Z');
  assert.equal(localDay('2026-10-29T22:30:00Z'), '2026-10-30');
  for (const body of [
    { date: '2026-02-30', allDay: true }, { date: '2026-10-30', startTime: '12:00', endTime: '08:00' },
    { date: '2026-10-30', startTime: '25:00', endTime: '26:00' }
  ]) assert.throws(() => bookingWindow(body), /valid date|end time/);
});

test('GPS boundary includes accuracy margin and rejects wrong building, poor GPS, missing pin and mock locations', () => {
  assert.equal(assertAtBuilding(point(), boundary), 0);
  const longitudeOffset = 80 / (111195 * Math.cos(boundary.latitude * Math.PI / 180));
  assert(assertAtBuilding(point({ longitude: boundary.longitude + longitudeOffset }), boundary) < 81);
  assert.throws(() => assertAtBuilding(point({ longitude: boundary.longitude + longitudeOffset, accuracy: 25 }), boundary), /outside/);
  assert.throws(() => assertAtBuilding(point({ latitude: -25.76 }), boundary), /outside/);
  assert.throws(() => assertAtBuilding(point({ accuracy: 51 }), boundary), /accuracy/);
  assert.throws(() => assertAtBuilding(point({ mocked: true }), boundary), /non-mock/);
  assert.throws(() => assertAtBuilding(point(), null), /GPS pin/);
});

test('check-in and each evidence point must be inside the booked time, not merely the correct day', () => {
  assert.doesNotThrow(() => assertVisitPoint(visit, point({ capturedAt: visit.starts_at }), boundary));
  assert.throws(() => assertVisitPoint(visit, point({ capturedAt: visit.ends_at }), boundary), /booked day and time/);
  assert.throws(() => assertVisitPoint(visit, point({ capturedAt: '2026-10-30T05:59:59Z' }), boundary), /booked day and time/);
  assert.throws(() => assertVisitPoint({ ...visit, cancelled_at: '2026-10-30' }, point(), boundary), /cancelled/);
});

test('both server-confirmed checks are required before moving, and rebooking preserves old misses', () => {
  const reports = [{ visit_id: visit.id, appliance_type: 'Washer' }];
  assert.throws(() => assertCanMove([visit], reports, 'other'), /both Washer and Dryer/);
  reports.push({ visit_id: visit.id, appliance_type: 'Dryer', pending_sync: true });
  assert.throws(() => assertCanMove([visit], reports, 'other'), /sync first/);
  reports[1].pending_sync = false;
  assert.doesNotThrow(() => assertCanMove([visit], reports, 'other'));
  assert.equal(visitProgress(visit, reports).status, 'complete');
  const history = attendance([{ ...visit, rebooked_as: 'new' }, { ...visit, id: 'none' }], [], '2026-10-31T12:00:00Z');
  assert.equal(history.totals.missedAppointments, 2);
  assert.equal(history.totals.missedDays, 1);
  assert.equal(history.totals.incompleteChecks, 4);
  assert.doesNotThrow(() => assertCanMove([{ ...visit, rebooked_as: 'new' }], [], 'new'));
});

test('attendance separates missed days, appointments, incomplete visits and missing checks, without counting cancelled or extra visits as misses', () => {
  const visits = [visit, { ...visit, id: 'two' }, { ...visit, id: 'extra', kind: 'extra' },
    { ...visit, id: 'cancelled', cancelled_at: '2026-10-30' }];
  const data = attendance(visits, [{ visit_id: 'two', appliance_type: 'Washer' }], '2026-10-31');
  assert.deepEqual(data.totals, { appointments: 2, missedAppointments: 1, missedDays: 1, incompleteAppointments: 1, incompleteChecks: 3 });
  const html = attendanceHtml(data, '2026-10-01', '2026-10-31');
  assert(html.includes('Maintenance managers only'));
  assert(html.includes('Washer, Dryer'));
  const withManual = attendanceHtml({ ...data, absences: [{
    technician_name: '<Tech>', building_name: 'North', scope: 'day', absence_date: '2026-10-30',
    note: '<script>Absent</script>', recorded_by_name: 'Manager', recorded_at: visit.starts_at
  }] }, '2026-10-01', '2026-10-31');
  assert(withManual.includes('Manually recorded: did not report to work'));
  assert(withManual.includes('&lt;script&gt;Absent&lt;/script&gt;'));
  assert(!withManual.includes('<script>'));
});

test('offline check-in survives restart and links queued reports, while GPS checks still reject the wrong building', async () => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  const records = new Map(), user = { id: 'tech', role: 'technician', propertyIds: ['p'] };
  const schedule = { visits: [visit], locations: [boundary], technicians: [] };
  const storage = { get: async (key) => structuredClone(records.get(key)), set: async (key, value) => records.set(key, structuredClone(value)) };
  const send = async (path) => {
    if (path === '/api/technician-schedule') return structuredClone(schedule);
    if (path === '/api/appliance-reports') return { reports: [] };
    if (path === '/api/appliance-parts') return { parts: [] };
    if (path === '/api/appliance-assets') return { properties: [], assets: [], reports: [], events: [], machines: [], buildings: [], requests: [], unlinkedChecks: 0 };
    if (path === '/api/properties') return { properties: [{ id: 'p', name: 'Building' }] };
    throw new Error(`Unexpected ${path}`);
  };
  const create = () => createOfflineStore({ storage, send, getUser: () => user, getServer: () => 'server', notify: () => {} });
  const store = create();
  await store.warm();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  await assert.rejects(() => store.request('/api/technician-checkins', { method: 'POST',
    body: { id: visit.id, propertyId: 'p', extra: false, location: point({ longitude: 28.21 }) } }), /outside/);
  const checkin = await store.request('/api/technician-checkins', { method: 'POST',
    body: { id: visit.id, propertyId: 'p', extra: false, location: point() } });
  assert.equal(checkin.queued, true);
  const reopened = create();
  assert.equal((await reopened.request('/api/technician-schedule')).visits[0].started_at, point().capturedAt);
  const body = {
    propertyId: 'p', visitId: visit.id, applianceType: 'Washer', expectedCount: 1,
    checkAudit: { started: point(), completed: point(), durationMs: 0, offlineCompleted: true },
    entries: [{ machineNumber: '1', serialNumber: 'SERIAL-1', modelNumber: 'Model', status: 'working', parts: [], notes: '',
      photo: { data: 'data:image/jpeg;base64,/9j/2Q==', source: 'camera', capturedAt: point().capturedAt },
      checkAudit: { started: point(), completed: point(), durationMs: 0, offlineCompleted: true } }]
  };
  assert.equal(validateLaundryReport(body).visitId, visit.id);
  assert.equal((await reopened.request('/api/appliance-reports', { method: 'POST', body })).queued, true);
  assert.equal((await reopened.request('/api/appliance-reports')).reports[0].visit_id, visit.id);
  const bad = structuredClone(body);
  bad.entries[0].checkAudit.completed.longitude = 28.21;
  await assert.rejects(() => reopened.request('/api/appliance-reports', { method: 'POST', body: bad }), /outside/);
});
