import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarState, changeCalendarMonth, monthDays, visitsOnDay, calendarHtml, bookingDetailsHtml } from './technician-calendar.mjs';
import { applianceTabs } from './appliances.js';
import { reportEscape } from './report-layout.mjs';
import { scheduleHtml } from './technician-schedule.js';

const state = { month: '2026-10', selectedDay: '2026-10-30', propertyId: '', technicianId: '' };
const visit = { id: 'one', property_id: 'p', technician_id: 'tech', building_name: 'North laundry',
  technician_name: 'Technician One', kind: 'booking', starts_at: '2026-10-30T06:00:00Z', ends_at: '2026-10-30T10:00:00Z' };
const schedule = { visits: [visit], locations: [], technicians: [{ id: 'tech', name: 'Technician One' }] };
const properties = [{ id: 'p', name: 'North laundry' }];
const render = (role, data = schedule, calendar = state) => calendarHtml(data, [], properties, { role }, calendar, reportEscape);
const details = (role, data = schedule) => bookingDetailsHtml(data, [], properties, { role }, data.visits[0], reportEscape);

test('calendar covers full Monday-to-Sunday weeks including month boundaries and leap years', () => {
  for (const month of ['2026-10', '2026-03', '2028-02', '2021-02']) {
    const days = monthDays(month);
    assert.equal(days.length % 7, 0);
    assert.equal(new Date(`${days[0]}T12:00Z`).getUTCDay(), 1);
    assert.equal(new Date(`${days.at(-1)}T12:00Z`).getUTCDay(), 0);
    assert(days.includes(`${month}-01`));
  }
  assert(monthDays('2028-02').includes('2028-02-29'));
  assert.equal(monthDays('2026-03').length, 42);
  assert.equal(monthDays('2021-02').length, 28);
  assert.throws(() => monthDays('2026-13'), /valid calendar month/);
});

test('calendar uses SAST today and navigates over December and January without skipping months', () => {
  assert.deepEqual(createCalendarState('2026-10-29T22:30:00Z'), state);
  const calendar = { ...state, month: '2026-12' };
  changeCalendarMonth(calendar, 1);
  assert.equal(calendar.month, '2027-01');
  assert.equal(calendar.selectedDay, '2027-01-01');
  changeCalendarMonth(calendar, -1);
  assert.equal(calendar.month, '2026-12');
});

test('whole-day and multi-day events use exclusive end dates and correct South African midnight', () => {
  const wholeDay = { ...visit, starts_at: '2026-10-29T22:00:00Z', ends_at: '2026-10-30T22:00:00Z' };
  assert.equal(visitsOnDay([wholeDay], '2026-10-29').length, 0);
  assert.equal(visitsOnDay([wholeDay], '2026-10-30').length, 1);
  assert.equal(visitsOnDay([wholeDay], '2026-10-31').length, 0);
  const multiDay = { ...visit, ends_at: '2026-11-02T10:00:00Z' };
  assert.equal(visitsOnDay([multiDay], '2026-11-01').length, 1);
});

test('calendar contains all days, time/building labels, selected-day agenda and navigation', () => {
  const html = render('technician');
  assert.equal([...html.matchAll(/data-calendar-day="/g)].length, monthDays(state.month).length);
  assert(html.includes('October 2026'));
  assert(html.includes('North laundry'));
  assert(html.includes('08:00'));
  assert(html.includes('Selected day visits'));
  assert(html.includes('aria-pressed="true"'));
  assert(html.includes('data-calendar-move="-1"'));
  assert(html.includes('data-calendar-move="1"'));
  assert(html.includes('data-calendar-today'));
  assert(html.includes('data-open-booking="one"'));
  assert(!html.includes('data-check-visit='));
  assert(details('technician').includes('data-check-visit="one"'));
});

test('MM calendar filters by building and technician and shows all selected-day visits beyond preview limit', () => {
  const data = { ...schedule, visits: [visit, { ...visit, id: 'two' }, { ...visit, id: 'three' }] };
  const html = render('maintenance_manager', data);
  assert(html.includes('+1 more'));
  assert.equal([...html.matchAll(/class="calendar-visit /g)].length, 3);
  assert(html.includes('data-calendar-technician'));
  assert(html.includes('data-book-calendar-day="2026-10-30"'));
  assert(render('maintenance_manager', data, { ...state, technicianId: 'other' }).includes('No visits on this day.'));
  assert(render('maintenance_manager', data, { ...state, propertyId: 'other' }).includes('No visits on this day.'));
});

test('technicians cannot see booking controls, technician filters or MM attendance legend', () => {
  const html = render('technician');
  assert(!html.includes('data-book-calendar-day'));
  assert(!html.includes('data-calendar-technician'));
  assert(!html.includes('Missed / incomplete'));
  assert(!render('admin').includes('Missed / incomplete'));
  assert(render('maintenance_manager').includes('Missed / incomplete'));
});

test('upcoming unstarted bookings offer manager moves and technician approval requests only', () => {
  const future = { ...visit, starts_at: '2099-10-30T06:00:00Z', ends_at: '2099-10-30T10:00:00Z' };
  const calendar = { ...state, month: '2099-10', selectedDay: '2099-10-30' };
  const data = { ...schedule, visits: [future] };
  assert(details('maintenance_manager', data).includes('data-reschedule-visit="one"'));
  assert(details('maintenance_manager', data).includes('data-postpone-visit="one"'));
  const own = details('technician', data);
  assert(own.includes('data-request-action="cancel"'));
  assert(own.includes('data-request-action="reschedule"'));
  assert(!own.includes('data-reschedule-visit='));
  for (const change of [{ started_at: future.starts_at }, { cancelled_at: future.starts_at }]) {
    const updated = { ...data, visits: [{ ...future, ...change }] };
    assert(!details('maintenance_manager', updated).includes('data-reschedule-visit='));
    assert(!details('technician', updated).includes('data-request-action='));
  }
  assert(!details('technician', { ...data, requests: [{ visit_id: 'one', status: 'pending' }] }).includes('data-request-action='));
});

test('calendar escapes property, technician and note text in both labels and agenda', () => {
  const html = render('maintenance_manager', { ...schedule, visits: [{ ...visit, building_name: '<img src=x>', technician_name: '<script>bad</script>', note: '<script>note</script>' }] });
  assert(!html.includes('<script>'));
  assert(!html.includes('<img src=x>'));
  assert(html.includes('&lt;img src=x&gt;'));
});

test('sub-tabs keep manager configuration and MM-only attendance out of technician navigation', () => {
  assert.deepEqual(applianceTabs('technician').map(([id]) => id), ['schedule', 'checks', 'reports', 'assets']);
  assert.deepEqual(applianceTabs('admin').map(([id]) => id), ['schedule', 'checks', 'reports', 'assets', 'quotes', 'parts', 'locations']);
  assert.deepEqual(applianceTabs('maintenance_manager').map(([id]) => id), ['schedule', 'checks', 'reports', 'assets', 'quotes', 'parts', 'locations', 'attendance']);
  for (const role of ['portfolio_manager', 'building_manager', 'operations_manager']) {
    assert.deepEqual(applianceTabs(role), applianceTabs('maintenance_manager'));
    const future = { ...schedule, visits: [{ ...visit, starts_at: '2099-10-30T06:00:00Z', ends_at: '2099-10-30T10:00:00Z' }] };
    assert(details(role, future).includes('data-reschedule-visit="one"'));
  }
});

test('only MM/admin see no-show buttons, required-note form and escaped manual absence history', () => {
  const absence = { id: 'absence', group_id: 'group', technician_id: 'tech', property_id: 'p', scope: 'day',
    absence_date: state.selectedDay, technician_name: '<Tech>', building_name: '<North>',
    note: '<script>private note</script>', recorded_by_name: '<Manager>', recorded_at: '2026-10-30T10:00:00Z' };
  for (const role of ['admin', 'maintenance_manager']) {
    const form = scheduleHtml(schedule, [], properties, { role }, reportEscape);
    assert(form.includes('data-open-absence'));
    assert(form.includes('name="note" maxlength="2000" required'));
    assert(form.includes('Whole workday - all buildings'));
    const html = render(role, { ...schedule, absences: [absence] });
    assert(html.includes('Did not report to work'));
    assert(html.includes('&lt;script&gt;private note&lt;/script&gt;'));
    assert(!html.includes('<script>'));
    assert(!details(role, { ...schedule, absences: [absence] }).includes('data-record-visit-absence="one"'));
    assert(details(role).includes('data-record-visit-absence="one"'));
    assert(!render(role, schedule, { ...state, propertyId: 'other' }).includes('data-record-visit-absence'));
    assert(!render(role, { ...schedule, absences: [absence] }, { ...state, technicianId: 'other' }).includes('private note'));
    assert(!details(role, { ...schedule, visits: [{ ...visit, cancelled_at: '2026-10-30' }] }).includes('data-record-visit-absence'));
    assert(!details(role, { ...schedule, visits: [{ ...visit, started_at: visit.starts_at }] }).includes('data-record-visit-absence'));
  }
  for (const role of ['technician', 'user', 'maintenance_assistant']) {
    const form = scheduleHtml(schedule, [], properties, { role }, reportEscape);
    assert(!form.includes('data-open-absence'));
    assert(!form.includes('technician-absence-form'));
    const html = render(role, { ...schedule, absences: [absence] });
    assert(!html.includes('data-record-visit-absence'));
    assert(!html.includes('private note'));
  }
});

test('undated postponements stay out of dated slots and remain available for rescheduling or cancellation', () => {
  const data = { ...schedule, visits: [{ ...visit, booking_status: 'postponed', cancelled_at: visit.starts_at,
    postpone_reason: '<private reason>' }] };
  const html = render('maintenance_manager', data);
  assert(html.includes('Awaiting reschedule (1)'));
  assert(!html.includes('class="calendar-event booked"'));
  const booking = details('maintenance_manager', data);
  assert(booking.includes('data-reschedule-visit="one"'));
  assert(booking.includes('data-cancel-visit="one"'));
  assert(!booking.includes('data-postpone-visit='));
  assert(!booking.includes('data-record-visit-absence='));
  assert(booking.includes('&lt;private reason&gt;'));
  assert(!render('maintenance_manager', { ...data, visits: [{ ...data.visits[0], rebooked_as: 'new' }] }).includes('Awaiting reschedule (1)'));
  const shell = scheduleHtml(schedule, [], properties, { role: 'maintenance_manager' }, reportEscape);
  assert(shell.includes('data-booking-dialog'));
  assert(shell.includes('Choose a later date now'));
  assert(shell.includes('Leave until rescheduled'));
});
