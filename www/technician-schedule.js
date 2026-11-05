import { localDay, visitTimezone, attendanceHtml } from './technician-visits.mjs';
import { isManagerRole, isManagementRole } from './account-access.mjs';
import { calendarHtml, createCalendarState, changeCalendarMonth, visitsOnDay, bookingDetailsHtml } from './technician-calendar.mjs';

export function scheduleHtml(schedule, reports, properties, user, escape, calendar = createCalendarState()) {
  const manager = isManagementRole(user.role);
  const mm = isManagerRole(user.role);
  const options = properties.map((property) => `<option value="${escape(property.id)}">${escape(property.name)}</option>`).join('');
  return `<section class="storage-panel" id="appliance-panel-schedule" role="tabpanel" aria-labelledby="appliance-tab-schedule" data-appliance-panel="schedule" aria-label="Technician schedule">
    <h2>${manager ? 'Schedules / Bookings' : 'My building visits'}</h2>
    ${schedule.offline_copy ? '<p role="status">Offline copy - changes may be missing.</p>' : ''}
    <div data-technician-calendar>${calendarHtml(schedule, reports, properties, user, calendar, escape)}</div>
    <p class="schedule-notice" role="status">${escape(calendar.notice || '')}</p>
    <div class="top-actions">
      ${(schedule.requests || []).some((request) => request.status === 'pending') ? `<button type="button" class="button secondary" data-open-booking-requests>Pending change requests (${schedule.requests.filter((request) => request.status === 'pending').length})</button>` : ''}
      ${manager ? '<button type="button" class="button secondary" data-open-absence>Did not report to work</button>' : ''}
    </div>
    <dialog class="survey-dialog booking-dialog" data-booking-dialog aria-labelledby="booking-dialog-title">
      <div class="dialog-heading"><button type="button" class="button secondary" data-booking-back hidden>Back to booking</button><h2 id="booking-dialog-title">Booking</h2><button type="button" class="icon-button quiet" data-booking-close aria-label="Close booking">×</button></div>
      <div data-booking-overview data-booking-pane></div>
      <div data-booking-days data-booking-pane hidden></div>
      ${user.role === 'technician' ? `<details data-change-request-editor data-booking-pane hidden><summary>Request a booking change</summary>
      <form id="technician-change-request-form" class="storage-form">
        <input type="hidden" name="visitId" /><input type="hidden" name="action" />
        <p data-change-request-summary></p>
        <label>Reason<textarea name="reason" maxlength="2000" required></textarea></label>
        <p>Booking stays active until MM approves.</p>
        <button type="submit" class="button primary">Send for MM approval</button>
      </form></details>` : ''}
    ${(schedule.requests || []).length ? `<details class="visit-change-requests" data-booking-pane hidden>
      <summary>Booking change requests (${(schedule.requests || []).filter((request) => request.status === 'pending').length} pending)</summary>
      <ul>${(schedule.requests || []).map((request) => `<li>
        <strong>${escape(request.technician_name)} - ${escape(request.building_name)}</strong>
        <p>${request.action === 'cancel' ? 'Cancellation' : 'Reschedule'} - ${escape(request.status === 'pending' ? 'Pending MM approval' : request.status)}</p>
        <p>${escape(request.reason)}</p>
        ${request.reviewed_by_name ? `<p>Reviewed by ${escape(request.reviewed_by_name)}</p>` : ''}
        ${manager && request.status === 'pending' ? `<div class="top-actions">
          ${request.action === 'cancel' ? `<button type="button" class="button secondary" data-decide-request="${escape(request.id)}" data-approve="true">Approve cancellation</button>`
            : `<button type="button" class="button secondary" data-reschedule-visit="${escape(request.visit_id)}" data-change-request="${escape(request.id)}">Choose new time & approve</button>`}
          <button type="button" class="button secondary" data-decide-request="${escape(request.id)}" data-approve="false">Decline</button>
        </div>` : ''}
      </li>`).join('')}</ul></details>` : ''}
    ${manager ? `<details data-booking-editor data-booking-pane hidden><summary>New booking</summary><form id="technician-booking-form" class="storage-form">
      <label>Building<select name="propertyId" required>${options}</select></label>
      <label>Technician<select name="technicianId" required>${schedule.technicians.map((tech) => `<option value="${escape(tech.id)}" data-properties="${escape(JSON.stringify(tech.property_ids))}">${escape(tech.name)}</option>`).join('')}</select></label>
      <label>Day<input type="date" name="date" value="${localDay()}" required /></label>
      <label class="inline-choice"><input type="checkbox" name="allDay" /> Whole day</label>
      <label>Start<input type="time" name="startTime" value="08:00" required /></label>
      <label>End<input type="time" name="endTime" value="16:00" required /></label>
      <label>Notes<textarea name="note" maxlength="2000"></textarea></label>
      <input type="hidden" name="replacesId" />
      <input type="hidden" name="reschedulesId" />
      <input type="hidden" name="changeRequestId" />
      <input type="hidden" name="postpone" />
      <p data-rebooking-note role="status"></p><button class="button primary" type="submit">Save booking</button>
    </form></details>` : ''}
    ${manager ? `<details data-absence-editor data-booking-pane hidden><summary>Mark as missed / did not report to work</summary>
      <form id="technician-absence-form" class="storage-form">
        <label>Technician<select name="technicianId" required>${schedule.technicians.map((tech) => `<option value="${escape(tech.id)}">${escape(tech.name)}</option>`).join('')}</select></label>
        <label>Record for<select name="scope"><option value="day">Whole workday - all buildings</option><option value="visit">A specific booked visit</option></select></label>
        <label>Day<input type="date" name="date" max="${localDay()}" value="${localDay()}" required /></label>
        <label data-absence-visit-field hidden>Booked visit<select name="visitId"></select></label>
        <label>Required note<textarea name="note" maxlength="2000" required></textarea></label>
        <button type="submit" class="button primary">Save missed attendance</button>
      </form></details>` : ''}
    ${manager ? `<form id="technician-booking-action-form" class="storage-form" data-booking-pane hidden>
      <input type="hidden" name="visitId" /><input type="hidden" name="action" />
      <h3 data-booking-action-title></h3><p data-booking-action-summary></p>
      <div data-postpone-choices class="booking-action-grid" hidden>
        <button type="button" class="button secondary" data-postpone-date>Choose a later date now</button>
        <button type="button" class="button secondary" data-postpone-undated>Leave until rescheduled</button>
      </div>
      <label data-postpone-reason hidden>Reason<textarea name="reason" maxlength="2000"></textarea></label>
      <p data-booking-action-note></p>
      <button type="submit" class="button primary">Confirm</button>
    </form>` : ''}
    <p class="form-error" data-booking-error role="alert" hidden></p>
    </dialog>
    ${user.role === 'technician' ? '<details><summary>Check requirements</summary><p>Submit and sync both Washer and Dryer checks before changing visits.</p></details>' : ''}
  </section>
    ${manager ? `<section class="storage-panel" id="appliance-panel-locations" role="tabpanel" aria-labelledby="appliance-tab-locations" data-appliance-panel="locations" hidden><h2>Building GPS boundaries</h2>
      <p>Place the pin at the laundry.</p>
      <form id="technician-location-form" class="storage-form">
        <label>Building<select name="propertyId" required>${options}</select></label>
        <label>Latitude<input name="latitude" type="number" step="any" min="-90" max="90" required /></label>
        <label>Longitude<input name="longitude" type="number" step="any" min="-180" max="180" required /></label>
        <label>Allowed radius (metres)<input name="radius" type="number" min="20" max="500" value="100" required /></label>
        <button type="button" class="button secondary" data-use-building-gps>Use my current location</button>
        <button class="button primary" type="submit">Save GPS boundary</button>
      </form>
    </section>` : ''}
    ${mm ? `<section class="storage-panel" id="appliance-panel-attendance" role="tabpanel" aria-labelledby="appliance-tab-attendance" data-appliance-panel="attendance" hidden><h2>Missed visits and attendance report (MM only)</h2>
      <form id="technician-attendance-form" class="storage-form">
        <label>From<input type="date" name="from" value="${localDay(new Date(Date.now() - 30 * 86400000))}" required /></label>
        <label>To<input type="date" name="to" value="${localDay()}" required /></label>
        <label>Technician<select name="technicianId"><option value="">All technicians</option>${schedule.technicians.map((tech) => `<option value="${escape(tech.id)}">${escape(tech.name)}</option>`).join('')}</select></label>
        <button class="button secondary" type="submit">Download attendance report</button>
      </form><p data-attendance-summary role="status"></p></section>` : ''}`;
}

export function wireSchedule({ workspace, apiRequest, getUser, isCurrent, getOwner, getSchedule, getReports, getProperties, escape, getCalendar, refreshCalendar, render, captureLocation, printDocument, alertError }) {
  let selectedVisitId = null;
  const dialog = () => workspace.querySelector('[data-booking-dialog]');
  function showPane(selector, title, back = true) {
    const modal = dialog();
    for (const pane of modal.querySelectorAll('[data-booking-pane]')) pane.hidden = !pane.matches(selector);
    const pane = modal.querySelector(selector);
    if (pane.tagName === 'DETAILS') pane.open = true;
    modal.querySelector('#booking-dialog-title').textContent = title;
    modal.querySelector('[data-booking-back]').hidden = !back;
    modal.querySelector('[data-booking-error]').hidden = true;
    if (!modal.open) modal.showModal();
    pane.querySelector('input:not([type=hidden]):not([disabled]), textarea, button, select')?.focus({ preventScroll: true });
    modal.scrollTop = 0;
  }
  function openBooking(id) {
    const visit = getSchedule().visits.find((item) => item.id === id);
    if (!visit) throw new Error('This booking is no longer available. Refresh the schedule.');
    selectedVisitId = visit.id;
    dialog().querySelector('[data-booking-overview]').innerHTML = bookingDetailsHtml(getSchedule(), getReports(), getProperties(), getUser(), visit, escape);
    showPane('[data-booking-overview]', 'Booking', false);
  }
  function openDay(day) {
    const calendar = getCalendar();
    const visits = visitsOnDay(getSchedule().visits.filter((visit) => visit.booking_status !== 'postponed'
      && (calendar.showHistory || !visit.cancelled_at)
      && (!calendar.propertyId || visit.property_id === calendar.propertyId)
      && (!calendar.technicianId || visit.technician_id === calendar.technicianId)), day);
    if (visits.length === 1) { openBooking(visits[0].id); return; }
    selectedVisitId = null;
    dialog().querySelector('[data-booking-days]').innerHTML = `${visits.map((visit) => `<button type="button" class="booking-list-button" data-open-booking="${escape(visit.id)}"><strong>${escape(visit.building_name)}</strong><span>${escape(visit.technician_name || '')} / ${escape(new Date(visit.starts_at).toLocaleTimeString('en-ZA', { timeZone: visitTimezone, hour: '2-digit', minute: '2-digit' }))}</span></button>`).join('') || '<p>No bookings for this day.</p>'}
      ${isManagementRole(getUser().role) ? `<button type="button" class="button primary" data-book-calendar-day="${day}">+ Book this day</button>` : ''}`;
    showPane('[data-booking-days]', new Date(`${day}T12:00:00+02:00`).toLocaleDateString('en-ZA', { timeZone: visitTimezone, dateStyle: 'medium' }), false);
  }
  function showBookingError(error) {
    if (!dialog()?.open) { alertError(error, 'Could not update this booking.'); return; }
    const message = dialog().querySelector('[data-booking-error]');
    message.textContent = error.message || 'Could not update this booking. Reconnect and retry.';
    message.hidden = false;
    message.scrollIntoView({ block: 'nearest' });
  }
  function editBooking(id, moving, changeRequestId = '', postponing = false) {
    const visit = getSchedule().visits.find((item) => item.id === id);
    if (!visit) throw new Error('Booking not found. Refresh the schedule.');
    const form = workspace.querySelector('#technician-booking-form');
    form.reset();
    selectedVisitId = visit.id;
    form.elements.propertyId.value = visit.property_id;
    form.elements.propertyId.dispatchEvent(new Event('change', { bubbles: true }));
    form.elements.technicianId.value = visit.technician_id;
    form.elements.replacesId.value = moving ? '' : visit.id;
    form.elements.reschedulesId.value = moving ? visit.id : '';
    form.elements.changeRequestId.value = changeRequestId;
    form.elements.postpone.value = postponing ? 'true' : '';
    form.elements.date.min = localDay();
    form.elements.propertyId.disabled = moving;
    form.elements.technicianId.disabled = moving;
    if (moving) {
      form.elements.date.value = localDay(visit.starts_at) < localDay() ? localDay() : localDay(visit.starts_at);
      const time = (value) => new Date(value).toLocaleTimeString('en-GB', { timeZone: visitTimezone, hour: '2-digit', minute: '2-digit' });
      form.elements.startTime.value = time(visit.starts_at);
      form.elements.endTime.value = time(visit.ends_at);
      form.elements.allDay.checked = visit.all_day;
      form.elements.note.value = visit.note || '';
    }
    form.elements.allDay.dispatchEvent(new Event('change', { bubbles: true }));
    form.querySelector('[data-rebooking-note]').textContent = postponing
      ? 'Choose a later date/time.'
      : '';
    showPane('[data-booking-editor]', postponing ? 'Postpone to a later date' : moving ? 'Change booking' : 'Rebook visit');
  }
  workspace.addEventListener('change', (event) => {
    if (!isCurrent()) return;
    const calendar = getCalendar();
    if (event.target.matches('[data-calendar-month], [data-calendar-property], [data-calendar-technician], [data-calendar-history]')) {
      if (event.target.matches('[data-calendar-month]')) {
        if (!event.target.value || !event.target.checkValidity()) return;
        calendar.month = event.target.value;
        calendar.selectedDay = `${calendar.month}-01`;
      } else if (event.target.matches('[data-calendar-property]')) calendar.propertyId = event.target.value;
      else if (event.target.matches('[data-calendar-technician]')) calendar.technicianId = event.target.value;
      else calendar.showHistory = event.target.checked;
      refreshCalendar();
      return;
    }
    const form = event.target.form;
    if (form?.id === 'technician-absence-form' && ['technicianId', 'scope', 'date'].includes(event.target.name)) fillAbsenceVisits(form);
    if (form?.id === 'technician-booking-form' && event.target.name === 'propertyId') {
      for (const option of form.elements.technicianId.options) {
        option.disabled = !JSON.parse(option.dataset.properties).includes(form.elements.propertyId.value);
        option.hidden = option.disabled;
      }
      if (form.elements.technicianId.selectedOptions[0]?.disabled) {
        form.elements.technicianId.value = [...form.elements.technicianId.options].find((option) => !option.disabled)?.value || '';
      }
    }
    if (form?.id === 'technician-booking-form' && event.target.name === 'allDay') {
      for (const key of ['startTime', 'endTime']) {
        form.elements[key].disabled = form.elements.allDay.checked;
        form.elements[key].required = !form.elements.allDay.checked;
      }
    }
    if (form?.id === 'technician-location-form' && event.target.name === 'propertyId') fillBoundary(form);
  });
  function fillBoundary(form) {
    const pin = getSchedule()?.locations.find((item) => item.property_id === form.elements.propertyId.value);
    for (const key of ['latitude', 'longitude', 'radius']) form.elements[key].value = pin?.[key] ?? (key === 'radius' ? 100 : '');
  }
  function fillAbsenceVisits(form) {
    const visitField = form.querySelector('[data-absence-visit-field]');
    const visit = form.elements.visitId;
    const previous = visit.value;
    const specific = form.elements.scope.value === 'visit';
    visitField.hidden = !specific;
    visit.disabled = !specific;
    visit.required = specific;
    visit.replaceChildren(new Option('Choose a booked visit', ''));
    for (const item of getSchedule().visits.filter((item) => item.technician_id === form.elements.technicianId.value
      && item.kind === 'booking' && !item.cancelled_at && !item.started_at
      && new Date(item.starts_at).getTime() <= Date.now() && localDay(item.starts_at) === form.elements.date.value)) {
      visit.add(new Option(`${item.building_name} - ${new Date(item.starts_at).toLocaleTimeString('en-ZA', { timeZone: visitTimezone, hour: '2-digit', minute: '2-digit' })}`, item.id));
    }
    if ([...visit.options].some((option) => option.value === previous)) visit.value = previous;
  }
  workspace.addEventListener('click', async (event) => {
    if (!isCurrent()) return;
    const calendar = getCalendar();
    if (event.target.closest('[data-booking-close]')) { dialog().close(); return; }
    if (event.target.closest('[data-booking-back]')) {
      if (selectedVisitId) openBooking(selectedVisitId);
      else openDay(calendar.selectedDay);
      return;
    }
    const open = event.target.closest('[data-open-booking]');
    if (open) { openBooking(open.dataset.openBooking); return; }
    if (event.target.closest('[data-open-booking-requests]')) {
      selectedVisitId = null;
      showPane('.visit-change-requests', 'Booking change requests', false);
      return;
    }
    if (event.target.closest('[data-check-visit]')) dialog()?.close();
    const day = event.target.closest('[data-calendar-day], [data-calendar-more]');
    const move = event.target.closest('[data-calendar-move]');
    const today = event.target.closest('[data-calendar-today]');
    if (day || move || today) {
      if (day) { calendar.selectedDay = day.dataset.calendarDay || day.dataset.calendarMore; calendar.month = calendar.selectedDay.slice(0, 7); }
      if (move) changeCalendarMonth(calendar, Number(move.dataset.calendarMove));
      if (today) Object.assign(calendar, { month: localDay().slice(0, 7), selectedDay: localDay() });
      refreshCalendar();
      workspace.querySelector(day ? `[data-calendar-day="${calendar.selectedDay}"]` : move ? `[data-calendar-move="${move.dataset.calendarMove}"]` : '[data-calendar-today]')?.focus({ preventScroll: true });
      if (day) openDay(calendar.selectedDay);
      return;
    }
    const absence = event.target.closest('[data-open-absence], [data-record-visit-absence]');
    if (absence) {
      if (!isManagementRole(getUser().role)) return;
      const editor = workspace.querySelector('[data-absence-editor]');
      const form = editor.querySelector('form');
      editor.hidden = false;
      editor.open = true;
      const visit = getSchedule().visits.find((item) => item.id === absence.dataset.recordVisitAbsence);
      form.elements.scope.value = visit ? 'visit' : 'day';
      form.elements.date.value = visit ? localDay(visit.starts_at) : calendar.selectedDay > localDay() ? localDay() : calendar.selectedDay;
      if (visit) form.elements.technicianId.value = visit.technician_id;
      else if (calendar.technicianId) form.elements.technicianId.value = calendar.technicianId;
      fillAbsenceVisits(form);
      if (visit) form.elements.visitId.value = visit.id;
      for (const name of ['technicianId', 'scope', 'date']) form.elements[name].closest('label').hidden = !!visit;
      if (visit) form.querySelector('[data-absence-visit-field]').hidden = true;
      if (visit) selectedVisitId = visit.id;
      else selectedVisitId = null;
      form.elements.note.value = '';
      showPane('[data-absence-editor]', visit ? 'Mark this booking as missed' : 'Did not report to work', !!visit);
      form.elements.note.focus();
      return;
    }
    const bookDay = event.target.closest('[data-book-calendar-day]');
    if (bookDay) {
      const form = workspace.querySelector('#technician-booking-form');
      form.reset();
      selectedVisitId = null;
      workspace.querySelector('[data-booking-editor]').open = true;
      form.elements.date.value = bookDay.dataset.bookCalendarDay;
      form.elements.replacesId.value = '';
      form.elements.reschedulesId.value = '';
      form.elements.changeRequestId.value = '';
      form.elements.propertyId.disabled = false;
      form.elements.technicianId.disabled = false;
      form.elements.date.min = localDay();
      form.elements.postpone.value = '';
      if (calendar.propertyId) form.elements.propertyId.value = calendar.propertyId;
      form.elements.propertyId.dispatchEvent(new Event('change', { bubbles: true }));
      if (calendar.technicianId && !form.elements.technicianId.querySelector(`option[value="${CSS.escape(calendar.technicianId)}"]`)?.disabled) form.elements.technicianId.value = calendar.technicianId;
      form.elements.allDay.dispatchEvent(new Event('change', { bubbles: true }));
      form.querySelector('[data-rebooking-note]').textContent = '';
      showPane('[data-booking-editor]', 'New booking', false);
      form.elements.date.focus();
      return;
    }
    const requestVisit = event.target.closest('[data-request-visit]');
    if (requestVisit) {
      const form = workspace.querySelector('#technician-change-request-form');
      const visit = getSchedule().visits.find((item) => item.id === requestVisit.dataset.requestVisit);
      form.reset();
      form.elements.visitId.value = visit.id;
      form.elements.action.value = requestVisit.dataset.requestAction;
      form.querySelector('[data-change-request-summary]').textContent = `${requestVisit.dataset.requestAction === 'cancel' ? 'Request cancellation' : 'Request reschedule'} - ${visit.building_name} - ${localDay(visit.starts_at)}`;
      if (requestVisit.hasAttribute('data-request-postpone')) form.querySelector('[data-change-request-summary]').textContent = `Request postponement - ${visit.building_name} - ${localDay(visit.starts_at)}`;
      const editor = form.closest('details');
      editor.hidden = false;
      editor.open = true;
      selectedVisitId = visit.id;
      showPane('[data-change-request-editor]', 'Send request to MM');
      form.elements.reason.focus();
      return;
    }
    const decision = event.target.closest('[data-decide-request]');
    if (decision) {
      const owner = getOwner();
      decision.disabled = true;
      try {
        await apiRequest(`/api/technician-requests/${encodeURIComponent(decision.dataset.decideRequest)}/decision`,
          { method: 'POST', body: { approve: decision.dataset.approve === 'true' } });
        if (owner === getOwner()) await render();
      } catch (error) { showBookingError(error); }
      finally { decision.disabled = false; }
      return;
    }
    const rebook = event.target.closest('[data-rebook-visit], [data-reschedule-visit]');
    if (rebook) {
      const moving = !!rebook.dataset.rescheduleVisit;
      editBooking(rebook.dataset.rebookVisit || rebook.dataset.rescheduleVisit, moving, rebook.dataset.changeRequest || '');
      return;
    }
    const postpone = event.target.closest('[data-postpone-visit]');
    const cancel = event.target.closest('[data-cancel-visit]');
    if (postpone || cancel) {
      const visit = getSchedule().visits.find((item) => item.id === (postpone?.dataset.postponeVisit || cancel.dataset.cancelVisit));
      selectedVisitId = visit.id;
      const form = workspace.querySelector('#technician-booking-action-form');
      form.reset();
      form.elements.visitId.value = visit.id;
      form.elements.action.value = postpone ? 'postpone' : 'cancel';
      form.querySelector('[data-booking-action-title]').textContent = postpone ? 'When should this booking move?' : 'Cancel this booking?';
      form.querySelector('[data-booking-action-summary]').textContent = `${visit.building_name} / ${visit.technician_name} / ${localDay(visit.starts_at)}`;
      form.querySelector('[data-postpone-choices]').hidden = !postpone;
      form.querySelector('[data-postpone-reason]').hidden = true;
      form.elements.reason.required = false;
      form.querySelector('[type=submit]').hidden = !!postpone;
      form.querySelector('[type=submit]').textContent = 'Confirm cancellation';
      form.querySelector('[data-booking-action-note]').textContent = postpone ? '' : 'Release this slot? History is kept.';
      showPane('#technician-booking-action-form', postpone ? 'Postpone booking' : 'Cancel booking');
      return;
    }
    if (event.target.closest('[data-postpone-date]')) {
      editBooking(selectedVisitId, true, '', true);
      return;
    }
    if (event.target.closest('[data-postpone-undated]')) {
      const form = workspace.querySelector('#technician-booking-action-form');
      form.querySelector('[data-postpone-choices]').hidden = true;
      form.querySelector('[data-postpone-reason]').hidden = false;
      form.elements.reason.required = true;
      form.querySelector('[type=submit]').hidden = false;
      form.querySelector('[type=submit]').textContent = 'Confirm postponement';
      form.querySelector('[data-booking-action-note]').textContent = 'Slot released. Booking kept under Awaiting reschedule.';
      form.elements.reason.focus();
      return;
    }
    const gps = event.target.closest('[data-use-building-gps]');
    if (!gps) return;
    const owner = getOwner();
    try {
        const location = await captureLocation();
        if (owner !== getOwner() || !gps.isConnected) return;
        const form = gps.form;
        form.elements.latitude.value = location.latitude;
        form.elements.longitude.value = location.longitude;
    } catch (error) { alertError(error, 'Could not update technician visit.'); }
  });
  workspace.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!isCurrent() || !['technician-booking-form', 'technician-booking-action-form', 'technician-location-form', 'technician-attendance-form', 'technician-absence-form', 'technician-change-request-form'].includes(form.id)) return;
    event.preventDefault();
    const owner = getOwner(), button = form.querySelector('[type=submit]');
    button.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(form));
      if (form.id === 'technician-booking-action-form') {
        if (!['cancel', 'postpone'].includes(body.action)) throw new Error('Choose a booking action.');
        await apiRequest(`/api/technician-bookings/${encodeURIComponent(body.visitId)}/${body.action}`,
          { method: 'POST', body: { reason: body.reason } });
        getCalendar().notice = body.action === 'postpone' ? 'Booking postponed.' : 'Booking cancelled.';
      } else if (form.id === 'technician-change-request-form') {
        await apiRequest(`/api/technician-bookings/${encodeURIComponent(body.visitId)}/requests`,
          { method: 'POST', body: { action: body.action, reason: body.reason } });
        getCalendar().notice = 'Sent for MM approval.';
      } else if (form.id === 'technician-absence-form') {
        if (!isManagementRole(getUser().role)) throw new Error('Only managers and administrators can record a no-show.');
        if (!body.note.trim()) throw new Error('Enter a required note before recording a no-show.');
        await apiRequest('/api/technician-absences', { method: 'POST', body });
        getCalendar().notice = 'Missed attendance recorded.';
        calendarToDay(body.date);
      } else if (form.id === 'technician-booking-form') {
        await apiRequest('/api/technician-bookings', { method: 'POST', body: { ...body,
          propertyId: form.elements.propertyId.value, technicianId: form.elements.technicianId.value,
          allDay: form.elements.allDay.checked, postpone: body.postpone === 'true' } });
        getCalendar().notice = body.reschedulesId || body.replacesId ? 'Booking moved.' : 'Booking saved.';
        calendarToDay(body.date);
      } else if (form.id === 'technician-location-form') {
        await apiRequest(`/api/technician-locations/${encodeURIComponent(body.propertyId)}`, {
          method: 'PUT', body: { latitude: Number(body.latitude), longitude: Number(body.longitude), radius: Number(body.radius) }
        });
      } else {
        if (!isManagerRole(getUser().role)) throw new Error('Only managers can export attendance reports.');
        const data = await apiRequest(`/api/technician-attendance?${new URLSearchParams(body)}`);
        if (owner !== getOwner()) return;
        form.parentElement.querySelector('[data-attendance-summary]').textContent =
          `${data.totals.missedDays} missed days; ${data.totals.missedAppointments} missed appointments; ${data.totals.incompleteAppointments} incomplete appointments; ${data.totals.incompleteChecks} checks not completed.`;
        await printDocument(attendanceHtml(data, body.from, body.to), `Technician-attendance-${body.from}-${body.to}`);
        return;
      }
      if (owner === getOwner()) {
        dialog()?.close();
        await render();
      }
    } catch (error) { showBookingError(error); }
    finally { button.disabled = false; }
  });
  function calendarToDay(day) {
    Object.assign(getCalendar(), { month: day.slice(0, 7), selectedDay: day });
  }
}
