import { reportDocument, reportEscape as escape } from './report-layout.mjs';

export const visitTimezone = 'Africa/Johannesburg';
export const requiredChecks = ['Washer', 'Dryer'];

export function localDay(value = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Choose a valid date.');
  return new Intl.DateTimeFormat('en-CA', { timeZone: visitTimezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function bookingWindow({ date, allDay, startTime, endTime }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('Choose a booking date.');
  const start = allDay ? '00:00' : startTime;
  const end = allDay ? '00:00' : endTime;
  if (![start, end].every((time) => /^\d{2}:\d{2}$/.test(time || ''))) throw new Error('Choose a start and end time.');
  const begins = new Date(`${date}T${start}:00+02:00`);
  const ends = new Date(`${date}T${end}:00+02:00`);
  if (allDay) ends.setTime(ends.getTime() + 86400000);
  if (!Number.isFinite(begins.getTime()) || !Number.isFinite(ends.getTime()) || localDay(begins) !== date || ends <= begins) {
    throw new Error('Choose a valid date and an end time after the start time.');
  }
  return { starts_at: begins.toISOString(), ends_at: ends.toISOString() };
}

export function validateBoundary(value) {
  if (!value || !Number.isFinite(value.latitude) || Math.abs(value.latitude) > 90
      || !Number.isFinite(value.longitude) || Math.abs(value.longitude) > 180
      || !Number.isFinite(value.radius) || value.radius < 20 || value.radius > 500) {
    throw new Error('Set a building GPS pin and radius between 20 and 500 metres before checking here.');
  }
  return { latitude: value.latitude, longitude: value.longitude, radius: value.radius };
}

export function assertAtBuilding(location, boundary) {
  const pin = validateBoundary(boundary);
  if (!location || !Number.isFinite(location.latitude) || Math.abs(location.latitude) > 90
      || !Number.isFinite(location.longitude) || Math.abs(location.longitude) > 180
      || !Number.isFinite(location.accuracy) || location.accuracy < 0
      || !Number.isFinite(Date.parse(location.capturedAt)) || location.mocked !== false) {
    throw new Error('A valid, non-mock GPS reading is required at this building.');
  }
  if (location.accuracy > Math.min(50, pin.radius / 2)) throw new Error('GPS accuracy is too poor. Move outside or near a window and retry.');
  const rad = (degrees) => degrees * Math.PI / 180;
  const a = Math.sin(rad(location.latitude - pin.latitude) / 2) ** 2
    + Math.cos(rad(pin.latitude)) * Math.cos(rad(location.latitude)) * Math.sin(rad(location.longitude - pin.longitude) / 2) ** 2;
  const distance = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  if (distance + location.accuracy > pin.radius) {
    throw new Error(`You are outside this building's ${pin.radius} m boundary (${Math.round(distance)} m from its pin).`);
  }
  return distance;
}

export function assertVisitPoint(visit, point, boundary) {
  if (!visit || visit.cancelled_at) throw new Error('This visit is unavailable or cancelled. Refresh your schedule.');
  assertAtBuilding(point, boundary);
  const time = Date.parse(point.capturedAt);
  if (time < Date.parse(visit.starts_at) || time >= Date.parse(visit.ends_at)) {
    throw new Error('Checks must take place during the booked day and time.');
  }
}

export function visitProgress(visit, reports, now = new Date()) {
  const matching = reports.filter((report) => report.visit_id === visit.id);
  const done = requiredChecks.filter((type) => matching.some((report) => report.appliance_type === type && !report.pending_sync));
  const pending = requiredChecks.filter((type) => !done.includes(type)
    && matching.some((report) => report.appliance_type === type && report.pending_sync));
  const missing = requiredChecks.filter((type) => !done.includes(type));
  const overdue = Date.parse(visit.ends_at) <= new Date(now).getTime();
  const status = visit.booking_status === 'postponed' ? 'postponed' : visit.cancelled_at ? 'cancelled' : !missing.length ? 'complete'
    : overdue ? (done.length ? 'incomplete' : 'missed') : (visit.started_at ? 'in_progress' : 'scheduled');
  return { done, pending, missing, status };
}

export function assertCanMove(visits, reports, visitId) {
  const unfinished = visits.find((visit) => visit.id !== visitId && visit.started_at && !visit.cancelled_at && !visit.rebooked_as
    && visitProgress(visit, reports).missing.length);
  if (unfinished) throw new Error('Complete and submit both Washer and Dryer checks for your current visit before moving to another building. Pending offline uploads must sync first, or MM must cancel the visit.');
}

export function attendance(visits, reports, now = new Date()) {
  const rows = visits.map((visit) => ({ ...visit, ...visitProgress(visit, reports, now) }));
  const overdue = rows.filter((row) => row.kind === 'booking' && ['missed', 'incomplete'].includes(row.status));
  return {
    rows,
    totals: {
      appointments: rows.filter((row) => row.kind === 'booking' && !['cancelled', 'postponed'].includes(row.status)).length,
      missedAppointments: overdue.filter((row) => row.status === 'missed').length,
      missedDays: new Set(overdue.filter((row) => row.status === 'missed').map((row) => `${row.technician_id}:${localDay(row.starts_at)}`)).size,
      incompleteAppointments: overdue.filter((row) => row.status === 'incomplete').length,
      incompleteChecks: overdue.reduce((total, row) => total + row.missing.length, 0)
    }
  };
}

export function attendanceHtml(data, from, to) {
  const displayTime = (time) => new Date(time).toLocaleString('en-ZA', { timeZone: visitTimezone, dateStyle: 'medium', timeStyle: 'short' });
  return reportDocument({
    title: 'Technician attendance', subtitle: `${from} to ${to} (${visitTimezone})`,
    metadata: [['Generated', new Date().toISOString()], ['Visibility', 'Maintenance managers only']],
    summary: Object.entries(data.totals).map(([label, value]) => [label.replace(/([A-Z])/g, ' $1'), String(value)]),
    body: `<p>Both Washer and Dryer reports are required. Misses remain in history after rebooking. Offline work is provisional until received and validated by the server; late uploads may update these totals.</p>
      <table><thead><tr><th>Technician / building</th><th>Booking</th><th>Status</th><th>Checks not completed</th><th>History</th></tr></thead><tbody>${data.rows.map((row) =>
        `<tr><td>${escape(row.technician_name)}<br>${escape(row.building_name)}</td><td>${escape(displayTime(row.starts_at))}<br>${escape(displayTime(row.ends_at))}</td><td>${escape(row.status)}</td><td>${escape(row.missing.join(', ') || 'None')}</td><td>${escape(row.kind)}${row.replaces_id ? `<br>Rebooks ${escape(row.replaces_id)}` : ''}${row.rebooked_as ? `<br>Rebooked as ${escape(row.rebooked_as)}` : ''}</td></tr>`
      ).join('')}</tbody></table>
      <h2>Manually recorded: did not report to work</h2>
      <p>These are manager-entered records, separate from automatic missed/incomplete totals. They do not cancel bookings. A later offline upload can supply evidence without deleting the original record.</p>
      <table><thead><tr><th>Technician / building</th><th>Day / scope</th><th>Required note</th><th>Recorded by / when</th></tr></thead><tbody>
      ${(data.absences || []).map((item) => `<tr><td>${escape(item.technician_name)}<br>${escape(item.building_name)}</td>
        <td>${escape(item.absence_date)}<br>${item.scope === 'day' ? 'Whole workday' : `Booked visit ${escape(item.visit_id)}`}</td>
        <td>${escape(item.note)}</td><td>${escape(item.recorded_by_name)}<br>${escape(displayTime(item.recorded_at))}</td></tr>`).join('')}
      </tbody></table>`
  });
}
