import { localDay, visitProgress, visitTimezone } from './technician-visits.mjs';
import { isManagerRole, isManagementRole } from './account-access.mjs';

const when = (value) => new Date(value).toLocaleString('en-ZA', { timeZone: visitTimezone, dateStyle: 'medium', timeStyle: 'short' });
const time = (value) => new Date(value).toLocaleTimeString('en-ZA', { timeZone: visitTimezone, hour: '2-digit', minute: '2-digit' });

export function createCalendarState(now = new Date()) {
  const selectedDay = localDay(now);
  return { month: selectedDay.slice(0, 7), selectedDay, propertyId: '', technicianId: '' };
}

export function monthDays(month) {
  const first = new Date(`${month}-01T00:00:00Z`);
  if (!/^\d{4}-\d{2}$/.test(month) || !Number.isFinite(first.getTime())) throw new Error('Choose a valid calendar month.');
  const start = new Date(first);
  start.setUTCDate(1 - (first.getUTCDay() + 6) % 7);
  const last = new Date(first);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  const count = Math.ceil(((last - start) / 86400000 + 1) / 7) * 7;
  return Array.from({ length: count }, (_, index) => new Date(start.getTime() + index * 86400000).toISOString().slice(0, 10));
}

export function visitsOnDay(visits, day) {
  return visits.filter((visit) => localDay(visit.starts_at) <= day && localDay(new Date(new Date(visit.ends_at).getTime() - 1)) >= day)
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at) || a.id.localeCompare(b.id));
}

export function changeCalendarMonth(state, offset) {
  const date = new Date(`${state.month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  state.month = date.toISOString().slice(0, 7);
  state.selectedDay = `${state.month}-01`;
}

export function calendarHtml(schedule, reports, properties, user, state, escape) {
  const manager = isManagementRole(user.role);
  const mm = isManagerRole(user.role);
  const filtered = schedule.visits.filter((visit) => (!state.propertyId || visit.property_id === state.propertyId)
    && (!state.technicianId || visit.technician_id === state.technicianId));
  const waiting = filtered.filter((visit) => visit.booking_status === 'postponed' && !visit.rebooked_as);
  const visits = filtered.filter((visit) => visit.booking_status !== 'postponed' && (state.showHistory || !visit.cancelled_at));
  const absences = manager ? (schedule.absences || []).filter((item) => (!state.propertyId || item.property_id === state.propertyId)
    && (!state.technicianId || item.technician_id === state.technicianId)) : [];
  const building = (visit) => visit.building_name || properties.find((property) => property.id === visit.property_id)?.name || 'Building';
  const today = localDay();
  const title = new Date(`${state.month}-01T12:00:00Z`).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric', timeZone: visitTimezone });
  const status = (visit) => visitProgress(visit, reports).status;
  const recordedMiss = (visit) => absences.some((item) => item.technician_id === visit.technician_id
    && (item.visit_id === visit.id || (item.scope === 'day' && item.absence_date === localDay(visit.starts_at))));
  const tone = (visit) => visit.cancelled_at ? 'cancelled' : status(visit) === 'complete' ? 'complete'
    : recordedMiss(visit) || (mm && ['missed', 'incomplete'].includes(status(visit))) ? 'attention' : visit.kind === 'extra' ? 'extra' : 'booked';
  const label = (visit) => visit.cancelled_at ? (visit.rebooked_as ? 'Rescheduled' : 'Cancelled') : status(visit) === 'complete' ? 'Complete'
    : recordedMiss(visit) ? 'Missed / recorded' : mm ? status(visit).replaceAll('_', ' ') : visit.kind === 'extra' ? 'Extra visit' : 'Booked';
  const selected = visitsOnDay(visits, state.selectedDay);
  return `<div class="technician-calendar">
    <div class="calendar-toolbar">
      <h3 id="technician-calendar-title" aria-live="polite">${escape(title)}</h3>
      <div class="calendar-controls">
        <button type="button" class="button secondary" data-calendar-move="-1" aria-label="Previous month">Previous</button>
        <button type="button" class="button secondary" data-calendar-today>Today</button>
        <button type="button" class="button secondary" data-calendar-move="1" aria-label="Next month">Next</button>
      </div>
    </div>
    ${manager ? `<button type="button" class="button primary" data-book-calendar-day="${state.selectedDay}">+ New booking</button>` : ''}
    <details class="calendar-filter-panel"><summary>Filter calendar / show history</summary><div class="calendar-filters">
      <label>Month<input type="month" data-calendar-month value="${state.month}" /></label>
      <label>Building<select data-calendar-property><option value="">All buildings</option>${properties.map((property) => `<option value="${escape(property.id)}" ${state.propertyId === property.id ? 'selected' : ''}>${escape(property.name)}</option>`).join('')}</select></label>
      ${manager ? `<label>Technician<select data-calendar-technician><option value="">All technicians</option>${schedule.technicians.map((tech) => `<option value="${escape(tech.id)}" ${state.technicianId === tech.id ? 'selected' : ''}>${escape(tech.name)}</option>`).join('')}</select></label>` : ''}
      <label class="inline-choice"><input type="checkbox" data-calendar-history ${state.showHistory ? 'checked' : ''} /> Show cancelled / rescheduled history</label>
    </div></details>
    <p class="calendar-help">Tap a booking. Times: SAST.</p>
    <div class="calendar-weekdays" aria-hidden="true">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => `<span>${day}</span>`).join('')}</div>
    <div class="calendar-days" role="group" aria-labelledby="technician-calendar-title">
      ${monthDays(state.month).map((day) => {
        const events = visitsOnDay(visits, day);
        const noShows = absences.filter((item) => item.absence_date === day);
        const fullDate = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-ZA', { dateStyle: 'full', timeZone: visitTimezone });
        return `<div class="calendar-day${day.slice(0, 7) !== state.month ? ' outside-month' : ''}${day === today ? ' is-today' : ''}${day === state.selectedDay ? ' is-selected' : ''}">
          <button type="button" class="calendar-day-select" data-calendar-day="${day}" aria-pressed="${day === state.selectedDay}" ${day === today ? 'aria-current="date"' : ''}
            aria-label="${escape(`${fullDate}: ${events.length} visit(s)${noShows.length ? '. Did not report to work recorded' : ''}`)}"><span class="calendar-day-number">${Number(day.slice(-2))}</span></button>
          ${events.slice(0, 2).map((visit) => `<button type="button" class="calendar-event ${tone(visit)}" data-open-booking="${escape(visit.id)}" aria-label="${escape(`Open booking: ${building(visit)}, ${visit.all_day ? 'whole day' : time(visit.starts_at)}, ${visit.technician_name || ''}, ${label(visit)}`)}"><span>${visit.all_day ? 'All day' : escape(time(visit.starts_at))}</span><strong>${escape(building(visit))}</strong>${manager ? `<span class="calendar-technician">${escape(visit.technician_name || '')}</span>` : ''}</button>`).join('')}
          ${events.length > 2 ? `<button type="button" class="calendar-more" data-calendar-more="${day}">+${events.length - 2} more</button>` : ''}
          ${noShows.length ? `<span class="calendar-event attention">Did not report to work</span>` : ''}
        </div>`;
      }).join('')}
    </div>
    <div class="calendar-legend"><span class="booked">Booked</span><span class="extra">Extra visit</span><span class="complete">Complete</span><span class="cancelled">Cancelled</span>${mm ? '<span class="attention">Missed / incomplete</span>' : ''}</div>
    <section class="calendar-agenda" aria-label="Selected day visits">
      <div class="calendar-toolbar"><h3>${escape(new Date(`${state.selectedDay}T12:00:00Z`).toLocaleDateString('en-ZA', { dateStyle: 'full', timeZone: visitTimezone }))}</h3>
      </div>
      ${absences.filter((item) => item.absence_date === state.selectedDay).map((item) =>
        `<article class="calendar-visit attention" data-recorded-absence="${escape(item.id)}"><h4>Did not report to work: ${escape(item.technician_name)}</h4>
          <p>${escape(item.building_name)} - ${item.scope === 'day' ? 'Whole workday' : 'Booked visit'}</p><p>${escape(item.note)}</p>
          <p>Recorded by ${escape(item.recorded_by_name)} on ${escape(when(item.recorded_at))}.</p></article>`).join('')}
      <ul class="ticket-list">${selected.map((visit) => `<li class="calendar-visit ${tone(visit)}"><button type="button" class="booking-list-button" data-open-booking="${escape(visit.id)}">
        <strong>${escape(building(visit))}</strong><span>${visit.all_day ? 'All day' : escape(`${time(visit.starts_at)} - ${time(visit.ends_at)}`)}${manager ? ` / ${escape(visit.technician_name || '')}` : ''}</span>
        <span>${escape(label(visit))} / Open booking</span></button></li>`).join('') || '<li class="calendar-empty">No visits on this day.</li>'}</ul>
    </section>
    ${waiting.length ? `<section class="calendar-waiting"><h3>Awaiting reschedule (${waiting.length})</h3><ul class="ticket-list">${waiting.map((visit) => `<li class="calendar-visit postponed"><button type="button" class="booking-list-button" data-open-booking="${escape(visit.id)}"><strong>${escape(building(visit))}</strong><span>${escape(visit.technician_name || '')}</span><span>Choose a date</span></button></li>`).join('')}</ul></section>` : ''}
  </div>`;
}

export function bookingDetailsHtml(schedule, reports, properties, user, visit, escape) {
  const manager = isManagementRole(user.role);
  const progress = visitProgress(visit, reports);
  const postponed = visit.booking_status === 'postponed';
  const overdue = ['missed', 'incomplete'].includes(progress.status);
  const changeable = visit.kind === 'booking' && !visit.started_at && !visit.rebooked_as
    && ((!visit.cancelled_at && new Date(visit.ends_at).getTime() > Date.now()) || postponed);
  const pending = (schedule.requests || []).find((request) => request.visit_id === visit.id && request.status === 'pending');
  const absence = manager && (schedule.absences || []).find((item) => item.technician_id === visit.technician_id
    && (item.visit_id === visit.id || (item.scope === 'day' && item.absence_date === localDay(visit.starts_at))));
  const pin = schedule.locations.find((item) => item.property_id === visit.property_id);
  const id = escape(visit.id);
  const icons = {
    change: '<path d="M4 20h4L20 8l-4-4L4 16v4Zm10-14 4 4"/>',
    cancel: '<path d="m6 6 12 12M6 18 18 6"/>',
    postpone: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
    missed: '<path d="M12 3 2 21h20L12 3Zm0 6v5m0 3v1"/>'
  };
  const action = (label, attribute, icon) => `<button type="button" class="button secondary booking-action" ${attribute}><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${icons[icon]}</svg><span>${label}</span></button>`;
  return `<h3>${escape(visit.building_name || properties.find((item) => item.id === visit.property_id)?.name || 'Building')}</h3>
    ${manager ? `<p>${escape(visit.technician_name || '')}</p>` : ''}
    <p>${postponed ? 'Previous time: ' : ''}${escape(when(visit.starts_at))} to ${escape(when(visit.ends_at))}${visit.all_day ? ' / whole day' : ''}</p>
    <p class="booking-status">${postponed ? 'Awaiting reschedule' : visit.rebooked_as ? 'Rescheduled' : absence ? 'Marked as missed' : escape(progress.status.replaceAll('_', ' '))}</p>
    ${visit.note ? `<p>${escape(visit.note)}</p>` : ''}${postponed ? `<p>${escape(visit.postpone_reason || '')}</p>` : ''}
    ${absence ? `<p>${escape(absence.note)}</p>` : ''}
    <div class="booking-action-grid">
      ${manager && changeable ? action(postponed ? 'Choose new date' : 'Change', `data-reschedule-visit="${id}"`, 'change') : ''}
      ${manager && changeable && !postponed ? action('Postpone', `data-postpone-visit="${id}"`, 'postpone') : ''}
      ${manager && !visit.rebooked_as && (postponed || (!visit.cancelled_at && (new Date(visit.ends_at).getTime() > Date.now() || visit.kind === 'extra'))) ? action('Cancel booking', `data-cancel-visit="${id}"`, 'cancel') : ''}
      ${manager && overdue && !visit.rebooked_as && visit.kind === 'booking' ? action('Rebook visit', `data-rebook-visit="${id}"`, 'change') : ''}
      ${manager && visit.kind === 'booking' && !visit.cancelled_at && !visit.started_at && new Date(visit.starts_at).getTime() <= Date.now() && !absence ? action('Mark as missed', `data-record-visit-absence="${id}"`, 'missed') : ''}
      ${user.role === 'technician' && !visit.cancelled_at && !visit.rebooked_as && progress.status !== 'complete' ? `<button type="button" class="button primary" data-check-visit="${id}">Open checks</button>` : ''}
      ${user.role === 'technician' && changeable && !postponed && !pending ? `${action('Request change', `data-request-visit="${id}" data-request-action="reschedule"`, 'change')}${action('Request cancellation', `data-request-visit="${id}" data-request-action="cancel"`, 'cancel')}${action('Request postponement', `data-request-visit="${id}" data-request-action="reschedule" data-request-postpone`, 'postpone')}` : ''}
    </div>
    ${pending ? `<section class="booking-pending"><h4>Pending MM approval</h4><p>${escape(pending.reason)}</p>${manager ? `<div class="top-actions">${pending.action === 'cancel' ? `<button type="button" class="button primary" data-decide-request="${escape(pending.id)}" data-approve="true">Approve cancellation</button>` : `<button type="button" class="button primary" data-reschedule-visit="${id}" data-change-request="${escape(pending.id)}">Choose new time & approve</button>`}<button type="button" class="button secondary" data-decide-request="${escape(pending.id)}" data-approve="false">Decline request</button></div>` : ''}</section>` : ''}
    <details><summary>Checks and building location</summary><p>Washer: ${progress.done.includes('Washer') ? 'received' : progress.pending.includes('Washer') ? 'pending sync' : 'not submitted'}.
      Dryer: ${progress.done.includes('Dryer') ? 'received' : progress.pending.includes('Dryer') ? 'pending sync' : 'not submitted'}.</p>
      ${pin ? `<a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=${pin.latitude},${pin.longitude}">Open building pin</a>` : '<p>MM must set this building GPS pin before checks can start.</p>'}</details>`;
}
