const crypto = require('node:crypto');

const schema = `
CREATE TABLE IF NOT EXISTS technician_locations (
  property_id TEXT PRIMARY KEY REFERENCES app_properties(id),
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  radius DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS technician_visits (
  id TEXT PRIMARY KEY,
  technician_id TEXT NOT NULL REFERENCES app_users(id),
  property_id TEXT NOT NULL REFERENCES app_properties(id),
  kind TEXT NOT NULL CHECK (kind IN ('booking', 'extra')),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL CHECK (ends_at > starts_at),
  all_day BOOLEAN NOT NULL DEFAULT FALSE,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  checkin JSONB,
  cancelled_at TIMESTAMPTZ,
  replaces_id TEXT REFERENCES technician_visits(id)
);
ALTER TABLE technician_visits DROP CONSTRAINT IF EXISTS technician_visits_replaces_id_key;
ALTER TABLE technician_visits ADD COLUMN IF NOT EXISTS booking_status TEXT NOT NULL DEFAULT 'scheduled'
  CHECK(booking_status IN ('scheduled','postponed','cancelled'));
ALTER TABLE technician_visits ADD COLUMN IF NOT EXISTS postponed_at TIMESTAMPTZ;
ALTER TABLE technician_visits ADD COLUMN IF NOT EXISTS postponed_by TEXT REFERENCES app_users(id);
ALTER TABLE technician_visits ADD COLUMN IF NOT EXISTS postpone_reason TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS technician_visits_active_replacement ON technician_visits(replaces_id) WHERE cancelled_at IS NULL;
ALTER TABLE appliance_reports ADD COLUMN IF NOT EXISTS visit_id TEXT REFERENCES technician_visits(id);
CREATE INDEX IF NOT EXISTS technician_visits_owner_time ON technician_visits(technician_id, starts_at);
CREATE INDEX IF NOT EXISTS appliance_reports_visit ON appliance_reports(visit_id);
CREATE TABLE IF NOT EXISTS technician_absences (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  technician_id TEXT NOT NULL REFERENCES app_users(id),
  property_id TEXT NOT NULL REFERENCES app_properties(id),
  visit_id TEXT REFERENCES technician_visits(id),
  absence_date DATE NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('visit','day')),
  note TEXT NOT NULL CHECK(length(trim(note)) BETWEEN 1 AND 2000),
  recorded_by TEXT NOT NULL REFERENCES app_users(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK((scope='visit' AND visit_id IS NOT NULL) OR (scope='day' AND visit_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS technician_absences_visit ON technician_absences(visit_id) WHERE scope='visit';
CREATE UNIQUE INDEX IF NOT EXISTS technician_absences_day ON technician_absences(technician_id,property_id,absence_date) WHERE scope='day';
CREATE TABLE IF NOT EXISTS technician_visit_requests (
  id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL REFERENCES technician_visits(id),
  requested_by TEXT NOT NULL REFERENCES app_users(id),
  action TEXT NOT NULL CHECK(action IN ('cancel','reschedule')),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by TEXT REFERENCES app_users(id),
  reviewed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS technician_visit_requests_pending ON technician_visit_requests(visit_id) WHERE status='pending';
`;

function service({ pool, accessibleProperties }) {
  const rules = () => import('../www/technician-visits.mjs');
  async function allowedProperty(user, propertyId, client = pool) {
    if (!(await accessibleProperties(user, client)).some((property) => property.id === propertyId)) {
      throw Object.assign(new Error('This building is outside your assigned buildings.'), { status: 403 });
    }
  }
  async function lockTechnician(client, id, propertyId) {
    const { rows } = await client.query(`SELECT u.id FROM app_users u JOIN user_properties up ON up.user_id = u.id
      JOIN app_properties p ON p.id = up.property_id
      WHERE u.id = $1 AND u.active = TRUE AND u.role = 'technician' AND up.property_id = $2 AND p.active = TRUE FOR UPDATE OF u`, [id, propertyId]);
    if (!rows[0]) throw Object.assign(new Error('Choose an active technician assigned to this building.'), { status: 403 });
  }
  async function visitsAndReports(technicianId, client = pool) {
    const { rows: visits } = await client.query(`SELECT v.*,
      (SELECT id FROM technician_visits replacement WHERE replacement.replaces_id=v.id AND replacement.cancelled_at IS NULL) AS rebooked_as
      FROM technician_visits v WHERE technician_id = $1`, [technicianId]);
    const { rows: reports } = await client.query('SELECT visit_id, appliance_type FROM appliance_reports WHERE created_by = $1 AND visit_id IS NOT NULL', [technicianId]);
    return { visits, reports };
  }
  async function boundary(propertyId, client = pool) {
    const { rows } = await client.query('SELECT latitude, longitude, radius FROM technician_locations WHERE property_id = $1', [propertyId]);
    return (await rules()).validateBoundary(rows[0]);
  }
  async function validateReport(user, body, client) {
    if (user.role !== 'technician') return null;
    await lockTechnician(client, user.id, body.propertyId);
    const { rows } = await client.query('SELECT * FROM technician_visits WHERE id = $1 AND technician_id = $2 AND property_id = $3', [body.visitId || '', user.id, body.propertyId]);
    const visit = rows[0];
    if (!visit?.started_at) throw Object.assign(new Error('Start a booked or extra visit before submitting appliance checks.'), { status: 409 });
    const { assertVisitPoint, assertCanMove } = await rules();
    const pin = await boundary(body.propertyId, client);
    const history = await visitsAndReports(user.id, client);
    assertCanMove(history.visits, history.reports, visit.id);
    for (const audit of [body.checkAudit, ...body.entries.map((entry) => entry.checkAudit)]) {
      if (Date.parse(audit.completed.capturedAt) > Date.now() + 15000) throw new Error('The evidence time is in the future. Correct the device clock.');
      assertVisitPoint(visit, audit.started, pin);
      assertVisitPoint(visit, audit.completed, pin);
      if (Date.parse(audit.started.capturedAt) < new Date(visit.started_at).getTime()) throw new Error('Checks must start after checking in to this visit.');
    }
    return visit.id;
  }
  return { rules, allowedProperty, lockTechnician, visitsAndReports, boundary, validateReport };
}

function mount(app, dependencies) {
  const { pool, authenticate, requireAdmin, accessibleProperties, withTransaction, apiError } = dependencies;
  const visits = service(dependencies);
  const fail = (res, error, action) => {
    console.error(`Technician ${action} failed:`, error.message);
    if (error.constraint === 'technician_visit_requests_pending') return apiError(res, 409, 'A request for this booking is already pending MM approval. Refresh the schedule.');
    if (error.code === '23505') return apiError(res, 409, 'This visit has already been booked or rebooked. Refresh the schedule.');
    if (error.code) return apiError(res, 503, 'The technician schedule could not be saved or loaded. Reconnect and retry.');
    return apiError(res, error.status || 400, error.status ? error.message : `Could not ${action}: ${error.message}`);
  };
  const scope = (user, alias = 'v') => user.role === 'admin' ? 'TRUE'
    : `${alias}.property_id IN (SELECT up.property_id FROM user_properties up JOIN app_properties p ON p.id = up.property_id WHERE up.user_id = $1 AND p.active = TRUE)`;
  const scopedValues = (user) => user.role === 'admin' ? [] : [user.id];
  const requireReports = (req, res, next) => ['admin', ...require('../www/manager-roles.json'), 'technician'].includes(req.user.role)
    ? next() : apiError(res, 403, 'Technician or manager access is required.');
  async function changeableBooking(client, user, id, allowPostponed = false) {
    const { rows } = await client.query('SELECT * FROM technician_visits WHERE id=$1', [id]);
    const visit = rows[0];
    if (!visit) throw Object.assign(new Error('Booking not found.'), { status: 404 });
    await visits.allowedProperty(user, visit.property_id, client);
    if (user.role === 'technician' && visit.technician_id !== user.id) throw Object.assign(new Error('This is not your booking.'), { status: 403 });
    await client.query('SELECT id FROM app_users WHERE id=$1 FOR UPDATE', [visit.technician_id]);
    const { rows: current } = await client.query('SELECT * FROM technician_visits WHERE id=$1 FOR UPDATE', [id]);
    const original = current[0];
    const { rows: evidence } = await client.query('SELECT id FROM appliance_reports WHERE visit_id=$1 LIMIT 1', [id]);
    const postponed = allowPostponed && original.booking_status === 'postponed';
    if (original.kind !== 'booking' || (original.cancelled_at && !postponed) || original.started_at || evidence.length
        || (!postponed && new Date(original.ends_at).getTime() <= Date.now())) {
      throw Object.assign(new Error('Only upcoming, unstarted bookings can be changed. Use Rebook for overdue visits; keep started check evidence intact.'), { status: 409 });
    }
    return original;
  }
  async function closePending(client, visitId, userId, approvedId = null) {
    await client.query(`UPDATE technician_visit_requests SET status=CASE WHEN id=$3 THEN 'approved' ELSE 'declined' END,
      reviewed_by=$2,reviewed_at=NOW() WHERE visit_id=$1 AND status='pending'`, [visitId, userId, approvedId]);
  }
  async function absenceRows(user, from = '0001-01-01', to = '9999-12-31', technicianId = '') {
    const properties = await accessibleProperties(user);
    const { rows } = await pool.query(`SELECT a.id,a.group_id,a.technician_id,a.property_id,a.visit_id,
      to_char(a.absence_date,'YYYY-MM-DD') AS absence_date,a.scope,a.note,a.recorded_at,
      recorder.display_name AS recorded_by_name,p.name AS building_name,u.display_name AS technician_name
      FROM technician_absences a JOIN app_properties p ON p.id=a.property_id
      JOIN app_users u ON u.id=a.technician_id JOIN app_users recorder ON recorder.id=a.recorded_by
      WHERE a.property_id=ANY($1::TEXT[]) AND a.absence_date BETWEEN $2::date AND $3::date
      AND ($4='' OR a.technician_id=$4) ORDER BY a.absence_date,a.recorded_at,a.id`,
    [properties.map((property) => property.id), from, to, technicianId]);
    return rows;
  }

  app.get('/api/technician-schedule', authenticate, requireReports, async (req, res) => {
    try {
      const technician = req.user.role === 'technician';
      const condition = technician ? `v.technician_id = $1 AND ${scope(req.user)}` : scope(req.user);
      const { rows } = await pool.query(`SELECT v.id, v.technician_id, v.property_id, v.kind, v.starts_at, v.ends_at,
        v.all_day, v.note, v.started_at, v.cancelled_at, v.replaces_id,
        v.booking_status,v.postponed_at,v.postponed_by,v.postpone_reason,
        (SELECT id FROM technician_visits replacement WHERE replacement.replaces_id = v.id AND replacement.cancelled_at IS NULL) AS rebooked_as,
        p.name AS building_name, u.display_name AS technician_name
        FROM technician_visits v JOIN app_properties p ON p.id = v.property_id JOIN app_users u ON u.id = v.technician_id
        WHERE ${condition} ORDER BY v.starts_at, v.id`, scopedValues(req.user));
      const properties = await accessibleProperties(req.user);
      const ids = properties.map((property) => property.id);
      const { rows: locations } = await pool.query('SELECT property_id, latitude, longitude, radius FROM technician_locations WHERE property_id = ANY($1::TEXT[])', [ids]);
      const { rows: technicians } = technician ? { rows: [] } : await pool.query(`SELECT u.id, u.display_name AS name,
        ARRAY_AGG(up.property_id ORDER BY up.property_id) AS property_ids
        FROM app_users u JOIN user_properties up ON up.user_id = u.id
        WHERE u.role = 'technician' AND u.active = TRUE AND up.property_id = ANY($1::TEXT[])
        GROUP BY u.id ORDER BY u.display_name`, [ids]);
      const absences = technician ? [] : await absenceRows(req.user);
      const { rows: requests } = await pool.query(`SELECT r.*,v.property_id,v.technician_id,p.name AS building_name,
        u.display_name AS technician_name,reviewer.display_name AS reviewed_by_name
        FROM technician_visit_requests r JOIN technician_visits v ON v.id=r.visit_id
        JOIN app_properties p ON p.id=v.property_id JOIN app_users u ON u.id=v.technician_id
        LEFT JOIN app_users reviewer ON reviewer.id=r.reviewed_by
        WHERE ${condition} ORDER BY r.created_at DESC`, scopedValues(req.user));
      return res.json({ visits: rows, locations, technicians, absences, requests, timezone: 'Africa/Johannesburg' });
    } catch (error) { return fail(res, error, 'load schedule'); }
  });

  app.put('/api/technician-locations/:propertyId', authenticate, requireAdmin, async (req, res) => {
    try {
      await visits.allowedProperty(req.user, req.params.propertyId);
      const pin = (await visits.rules()).validateBoundary(req.body);
      await pool.query(`INSERT INTO technician_locations(property_id, latitude, longitude, radius) VALUES($1,$2,$3,$4)
        ON CONFLICT(property_id) DO UPDATE SET latitude=$2,longitude=$3,radius=$4,updated_at=NOW()`,
      [req.params.propertyId, pin.latitude, pin.longitude, pin.radius]);
      return res.json({ location: { property_id: req.params.propertyId, ...pin } });
    } catch (error) { return fail(res, error, 'save building location'); }
  });

  app.post('/api/technician-bookings', authenticate, requireAdmin, async (req, res) => {
    try {
      const { propertyId, technicianId, replacesId, reschedulesId, changeRequestId, note = '', allDay = false } = req.body || {};
      if (replacesId && reschedulesId) throw new Error('Choose either a rebooking or a reschedule.');
      if (changeRequestId && !reschedulesId) throw new Error('Choose the booking to reschedule for this request.');
      if (typeof note !== 'string' || note.length > 2000 || typeof allDay !== 'boolean') throw new Error('Enter valid booking notes and time settings.');
      const { bookingWindow, visitProgress } = await visits.rules();
      const window = bookingWindow(req.body || {});
      if (Date.parse(window.ends_at) <= Date.now()) throw new Error('Book a current or future visit.');
      const visit = await withTransaction(async (client) => {
        await visits.allowedProperty(req.user, propertyId, client);
        await visits.lockTechnician(client, technicianId, propertyId);
        await visits.boundary(propertyId, client);
        if (reschedulesId) {
          const original = await changeableBooking(client, req.user, reschedulesId, true);
          if (original.technician_id !== technicianId || original.property_id !== propertyId) throw new Error('Reschedule the same technician and building.');
          if (changeRequestId) {
            const { rows: requests } = await client.query(`SELECT id FROM technician_visit_requests
              WHERE id=$1 AND visit_id=$2 AND action='reschedule' AND status='pending' FOR UPDATE`, [changeRequestId, original.id]);
            if (!requests[0]) throw Object.assign(new Error('This reschedule request is no longer pending. Refresh the schedule.'), { status: 409 });
          }
          if (original.booking_status !== 'postponed' && new Date(original.starts_at).getTime() === Date.parse(window.starts_at)
              && new Date(original.ends_at).getTime() === Date.parse(window.ends_at)) throw new Error('Choose a different day or time.');
          if (req.body.postpone === true && Date.parse(window.starts_at) <= new Date(original.starts_at).getTime()) {
            throw new Error('Choose a later date/time to postpone this booking, or use Change to move it earlier.');
          }
          await client.query("UPDATE technician_visits SET cancelled_at=NOW(),booking_status='cancelled' WHERE id=$1", [original.id]);
          await closePending(client, original.id, req.user.id, changeRequestId || null);
        }
        if (replacesId) {
          const history = await visits.visitsAndReports(technicianId, client);
          const original = history.visits.find((item) => item.id === replacesId && item.property_id === propertyId && item.kind === 'booking');
          if (!original || !['missed', 'incomplete'].includes(visitProgress(original, history.reports).status)) throw new Error('Only overdue missed or incomplete bookings can be rebooked.');
        }
        const { rows: overlaps } = await client.query(`SELECT id FROM technician_visits
          WHERE technician_id=$1 AND kind='booking' AND cancelled_at IS NULL
          AND starts_at < $3 AND ends_at > $2`, [technicianId, window.starts_at, window.ends_at]);
        if (overlaps.length) throw Object.assign(new Error('This technician already has a booking during that time. Choose another slot.'), { status: 409 });
        const { rows } = await client.query(`INSERT INTO technician_visits(id,technician_id,property_id,kind,starts_at,ends_at,all_day,note,created_by,replaces_id)
          VALUES($1,$2,$3,'booking',$4,$5,$6,$7,$8,$9) RETURNING *`,
        [crypto.randomUUID(), technicianId, propertyId, window.starts_at, window.ends_at, allDay, note.trim(), req.user.id, replacesId || reschedulesId || null]);
        return rows[0];
      });
      return res.status(201).json({ visit });
    } catch (error) { return fail(res, error, 'book visit'); }
  });

  app.post('/api/technician-bookings/:id/requests', authenticate, async (req, res) => {
    if (req.user.role !== 'technician') return apiError(res, 403, 'Only technicians request booking changes.');
    try {
      const { action, reason } = req.body || {};
      if (!['cancel', 'reschedule'].includes(action) || typeof reason !== 'string' || !reason.trim() || reason.length > 2000) {
        throw new Error('Choose cancellation or rescheduling and enter a reason (up to 2,000 characters).');
      }
      const request = await withTransaction(async (client) => {
        await changeableBooking(client, req.user, req.params.id);
        const { rows } = await client.query(`INSERT INTO technician_visit_requests(id,visit_id,requested_by,action,reason)
          VALUES($1,$2,$3,$4,$5) RETURNING *`, [crypto.randomUUID(), req.params.id, req.user.id, action, reason.trim()]);
        return rows[0];
      });
      return res.status(201).json({ request });
    } catch (error) { return fail(res, error, 'request booking change'); }
  });

  app.post('/api/technician-requests/:id/decision', authenticate, requireAdmin, async (req, res) => {
    try {
      if (typeof req.body?.approve !== 'boolean') throw new Error('Choose approve or decline.');
      await withTransaction(async (client) => {
        const { rows } = await client.query('SELECT * FROM technician_visit_requests WHERE id=$1', [req.params.id]);
        const request = rows[0];
        if (!request) throw Object.assign(new Error('Request not found.'), { status: 404 });
        const { rows: bookings } = await client.query('SELECT * FROM technician_visits WHERE id=$1', [request.visit_id]);
        await visits.allowedProperty(req.user, bookings[0].property_id, client);
        await client.query('SELECT id FROM app_users WHERE id=$1 FOR UPDATE', [bookings[0].technician_id]);
        const { rows: pending } = await client.query(`SELECT * FROM technician_visit_requests WHERE id=$1 AND status='pending' FOR UPDATE`, [request.id]);
        if (!pending[0]) throw Object.assign(new Error('This request has already been reviewed.'), { status: 409 });
        if (req.body.approve) {
          if (request.action !== 'cancel') throw new Error('Choose the new date/time using Reschedule, then Save booking to approve.');
          await changeableBooking(client, req.user, request.visit_id);
          await client.query("UPDATE technician_visits SET cancelled_at=NOW(),booking_status='cancelled' WHERE id=$1", [request.visit_id]);
        }
        await client.query(`UPDATE technician_visit_requests SET status=$2,reviewed_by=$3,reviewed_at=NOW() WHERE id=$1`,
          [request.id, req.body.approve ? 'approved' : 'declined', req.user.id]);
      });
      return res.json({ success: true });
    } catch (error) { return fail(res, error, 'review booking request'); }
  });

  app.post('/api/technician-bookings/:id/postpone', authenticate, requireAdmin, async (req, res) => {
    try {
      const reason = req.body?.reason;
      if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) throw new Error('Enter a reason for postponing this booking (up to 2,000 characters).');
      await withTransaction(async (client) => {
        const original = await changeableBooking(client, req.user, req.params.id);
        await client.query(`UPDATE technician_visits SET cancelled_at=NOW(),booking_status='postponed',
          postponed_at=NOW(),postponed_by=$2,postpone_reason=$3 WHERE id=$1`, [original.id, req.user.id, reason.trim()]);
        await closePending(client, original.id, req.user.id);
      });
      return res.json({ success: true });
    } catch (error) { return fail(res, error, 'postpone booking'); }
  });

  app.post('/api/technician-bookings/:id/cancel', authenticate, requireAdmin, async (req, res) => {
    try {
      await withTransaction(async (client) => {
        const { rows } = await client.query('SELECT * FROM technician_visits WHERE id=$1', [req.params.id]);
        if (!rows[0]) throw Object.assign(new Error('Visit not found.'), { status: 404 });
        await visits.allowedProperty(req.user, rows[0].property_id, client);
        await client.query('SELECT id FROM app_users WHERE id=$1 FOR UPDATE', [rows[0].technician_id]);
        const { rows: current } = await client.query('SELECT * FROM technician_visits WHERE id=$1 FOR UPDATE', [req.params.id]);
        if (current[0].booking_status !== 'postponed' && current[0].kind === 'booking' && new Date(current[0].ends_at).getTime() <= Date.now()) throw new Error('Overdue bookings stay in history. Rebook rather than cancel them.');
        await client.query("UPDATE technician_visits SET cancelled_at=COALESCE(cancelled_at,NOW()),booking_status='cancelled' WHERE id=$1", [req.params.id]);
        await closePending(client, req.params.id, req.user.id);
      });
      return res.json({ success: true });
    } catch (error) { return fail(res, error, 'cancel visit'); }
  });

  app.post('/api/technician-absences', authenticate, requireAdmin, async (req, res) => {
    try {
      const { scope: absenceScope, technicianId, visitId, date, note } = req.body || {};
      if (!['visit', 'day'].includes(absenceScope) || typeof technicianId !== 'string'
          || typeof note !== 'string' || !note.trim() || note.length > 2000) {
        throw new Error('Choose a technician and absence type, and enter a required note (up to 2000 characters).');
      }
      const { localDay, bookingWindow } = await visits.rules();
      const result = await withTransaction(async (client) => {
        const { rows: technicians } = await client.query(
          "SELECT id FROM app_users WHERE id=$1 AND role='technician' AND active=TRUE FOR UPDATE", [technicianId]);
        if (!technicians.length) throw Object.assign(new Error('Choose an active appliance technician.'), { status: 403 });
        let day, propertyIds, selectedVisit = null;
        if (absenceScope === 'visit') {
          if (typeof visitId !== 'string') throw new Error('Choose a booked visit.');
          const { rows } = await client.query("SELECT * FROM technician_visits WHERE id=$1 AND technician_id=$2 AND kind='booking'", [visitId, technicianId]);
          selectedVisit = rows[0];
          if (!selectedVisit) throw Object.assign(new Error('Booked visit not found.'), { status: 404 });
          await visits.allowedProperty(req.user, selectedVisit.property_id, client);
          if (selectedVisit.cancelled_at || Date.parse(selectedVisit.starts_at) > Date.now()) {
            throw new Error('Only a non-cancelled booking that has already started can be marked as not reported.');
          }
          day = localDay(selectedVisit.starts_at);
          propertyIds = [selectedVisit.property_id];
        } else {
          const window = bookingWindow({ date, allDay: true });
          day = date;
          if (day > localDay()) throw new Error('A future workday cannot be marked absent.');
          const { rows } = await client.query(`SELECT up.property_id FROM user_properties up
            JOIN app_properties p ON p.id=up.property_id WHERE up.user_id=$1 AND p.active=TRUE
            UNION SELECT property_id FROM technician_visits WHERE technician_id=$1 AND cancelled_at IS NULL
            AND starts_at < $3 AND ends_at > $2`, [technicianId, window.starts_at, window.ends_at]);
          propertyIds = rows.map((row) => row.property_id);
          if (!propertyIds.length) throw new Error('This technician has no assigned buildings or visits for this workday.');
          const allowed = await accessibleProperties(req.user, client);
          if (propertyIds.some((id) => !allowed.some((property) => property.id === id))) {
            throw Object.assign(new Error('A whole-day absence affects buildings outside your access. Ask an administrator to record it, or mark an individual permitted visit.'), { status: 403 });
          }
        }
        const window = bookingWindow({ date: day, allDay: true });
        const { rows: evidence } = await client.query(`SELECT v.id FROM technician_visits v
          WHERE v.technician_id=$1 AND ($4::TEXT IS NULL OR v.id=$4)
          AND v.starts_at < $3 AND v.ends_at > $2
          AND (v.started_at IS NOT NULL OR EXISTS(SELECT 1 FROM appliance_reports r WHERE r.visit_id=v.id))`,
        [technicianId, window.starts_at, window.ends_at, selectedVisit?.id || null]);
        if (evidence.length) throw Object.assign(new Error('This technician already has a check-in or submitted check for the selected visit/workday. Review attendance before recording a no-show.'), { status: 409 });
        const { rows: existing } = await client.query(`SELECT id FROM technician_absences
          WHERE technician_id=$1 AND absence_date=$2 AND
          (($3='day' AND scope='day') OR ($3='visit' AND (visit_id=$4 OR (scope='day' AND property_id=$5))))`,
        [technicianId, day, absenceScope, selectedVisit?.id || null, selectedVisit?.property_id || null]);
        if (existing.length) throw Object.assign(new Error('A no-show has already been recorded for this visit or workday.'), { status: 409 });
        const groupId = crypto.randomUUID();
        for (const propertyId of propertyIds) {
          await client.query(`INSERT INTO technician_absences(id,group_id,technician_id,property_id,visit_id,absence_date,scope,note,recorded_by)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [crypto.randomUUID(), groupId, technicianId, propertyId, selectedVisit?.id || null, day, absenceScope, note.trim(), req.user.id]);
        }
        return { groupId, buildings: propertyIds.length, date: day };
      });
      return res.status(201).json({ absence: result });
    } catch (error) { return fail(res, error, 'record did not report to work'); }
  });

  app.post('/api/technician-checkins', authenticate, async (req, res) => {
    if (req.user.role !== 'technician') return apiError(res, 403, 'Only technicians check in to visits.');
    try {
      const { id, propertyId, extra, location } = req.body || {};
      if (!/^[a-f0-9-]{36}$/i.test(id || '') || typeof extra !== 'boolean') throw new Error('Choose a booked or extra visit.');
      if (Date.parse(location?.capturedAt) > Date.now() + 15000) throw new Error('The check-in time is in the future.');
      const visit = await withTransaction(async (client) => {
        await visits.allowedProperty(req.user, propertyId, client);
        await visits.lockTechnician(client, req.user.id, propertyId);
        const { localDay, bookingWindow, assertVisitPoint, assertCanMove } = await visits.rules();
        const history = await visits.visitsAndReports(req.user.id, client);
        assertCanMove(history.visits, history.reports, id);
        const { rows } = await client.query('SELECT * FROM technician_visits WHERE id=$1', [id]);
        let current = rows[0];
        if (!current && extra) {
          current = { id, technician_id: req.user.id, property_id: propertyId, kind: 'extra', ...bookingWindow({ date: localDay(location?.capturedAt), allDay: true }) };
        }
        if (!current || current.technician_id !== req.user.id || current.property_id !== propertyId || (current.kind === 'extra') !== extra) {
          throw Object.assign(new Error('This visit is not available to your account.'), { status: 403 });
        }
        assertVisitPoint(current, location, await visits.boundary(propertyId, client));
        if (current.started_at) return current;
        if (!rows[0]) {
          await client.query(`INSERT INTO technician_visits(id,technician_id,property_id,kind,starts_at,ends_at,created_by)
            VALUES($1,$2,$3,'extra',$4,$5,$2)`, [id, req.user.id, propertyId, current.starts_at, current.ends_at]);
        }
        const { rows: saved } = await client.query('UPDATE technician_visits SET started_at=$2,checkin=$3::jsonb WHERE id=$1 RETURNING *', [id, location.capturedAt, JSON.stringify(location)]);
        return saved[0];
      });
      const { checkin, ...safe } = visit;
      return res.json({ visit: safe });
    } catch (error) { return fail(res, error, 'start visit'); }
  });

  app.get('/api/technician-attendance', authenticate, async (req, res) => {
    if (!require('../www/manager-roles.json').includes(req.user.role)) return apiError(res, 403, 'Attendance alerts and reports are limited to managers.');
    try {
      const { localDay, attendance } = await visits.rules();
      const from = String(req.query.from || localDay(new Date(Date.now() - 30 * 86400000)));
      const to = String(req.query.to || localDay());
      const dates = [from, to].map((date) => `${date}T00:00:00+02:00`);
      if (![from, to].every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)) || dates.some((date) => !Number.isFinite(Date.parse(date)))
          || localDay(dates[0]) !== from || localDay(dates[1]) !== to || from > to) throw new Error('Choose a valid attendance date range.');
      const { rows } = await pool.query(`SELECT v.*,p.name AS building_name,u.display_name AS technician_name,
        (SELECT id FROM technician_visits replacement WHERE replacement.replaces_id=v.id AND replacement.cancelled_at IS NULL) AS rebooked_as
        FROM technician_visits v JOIN app_properties p ON p.id=v.property_id JOIN app_users u ON u.id=v.technician_id
        WHERE ${scope(req.user)} AND ($4 OR (v.starts_at >= $2::timestamptz AND v.starts_at < $3::timestamptz + interval '1 day'))
        AND ($5='' OR v.technician_id=$5) ORDER BY v.starts_at`, [req.user.id, ...dates, req.query.alerts === 'true', String(req.query.technicianId || '')]);
      const { rows: reports } = await pool.query('SELECT visit_id,appliance_type FROM appliance_reports WHERE visit_id=ANY($1::TEXT[])', [rows.map((row) => row.id)]);
      const result = attendance(rows, reports);
      const absences = await absenceRows(req.user, req.query.alerts === 'true' ? undefined : from,
        req.query.alerts === 'true' ? undefined : to, String(req.query.technicianId || ''));
      return res.json({ ...result, absences, from, to });
    } catch (error) { return fail(res, error, 'load attendance'); }
  });
  return visits;
}

module.exports = { schema, service, mount };
