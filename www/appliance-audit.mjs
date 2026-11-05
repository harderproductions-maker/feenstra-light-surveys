export function validateAudit(input) {
  if (!input || typeof input.offlineCompleted !== 'boolean'
      || !Number.isFinite(input.durationMs) || input.durationMs < 0) {
    throw new Error('Start the check and capture its completion location before saving.');
  }
  const point = (value) => {
    if (!value || !Number.isFinite(value.latitude) || Math.abs(value.latitude) > 90
        || !Number.isFinite(value.longitude) || Math.abs(value.longitude) > 180
        || !Number.isFinite(value.accuracy) || value.accuracy < 0
        || typeof value.capturedAt !== 'string' || !Number.isFinite(Date.parse(value.capturedAt))
        || typeof value.mocked !== 'boolean') {
      throw new Error('A valid GPS location, accuracy and capture time are required at start and completion.');
    }
    if (value.mocked) throw new Error('Mock location detected. Turn off mock locations and capture your real location.');
    return {
      latitude: value.latitude, longitude: value.longitude, accuracy: value.accuracy,
      capturedAt: new Date(value.capturedAt).toISOString(), mocked: value.mocked
    };
  };
  const started = point(input.started);
  const completed = point(input.completed);
  if (Date.parse(completed.capturedAt) < Date.parse(started.capturedAt)) {
    throw new Error('The device clock moved backwards. Correct the clock and start a new check.');
  }
  return { started, completed, durationMs: input.durationMs, offlineCompleted: input.offlineCompleted };
}

export function auditReview(audit, receivedAt) {
  if (!audit) return 'Legacy report - no location audit captured.';
  const flags = [];
  if (audit.offlineCompleted) flags.push('Completed offline - review device evidence.');
  if (!receivedAt) flags.push('Pending server receipt.');
  else {
    const delay = Date.parse(receivedAt) - Date.parse(audit.completed.capturedAt);
    if (delay < -120000) flags.push('Device completion time is ahead of the server.');
    if (delay > 300000) flags.push('Delayed upload (over 5 minutes) - review timing.');
  }
  if (Math.max(audit.started.accuracy, audit.completed.accuracy) > 100) flags.push('Low location accuracy (over 100 m).');
  if (Math.abs(Date.parse(audit.completed.capturedAt) - Date.parse(audit.started.capturedAt) - audit.durationMs) > 120000) {
    flags.push('Device clock and elapsed time disagree.');
  }
  return [...flags, 'Device-reported evidence only; server receipt does not verify physical presence or work performed.'].join(' ');
}

export function auditHtml(audit, receivedAt, escapeHtml) {
  if (!audit) return `<p>${auditReview(null)}</p>`;
  const point = (label, value) => `<p>${label}: ${escapeHtml(value.capturedAt)} (UTC)<br>GPS: ${escapeHtml(value.latitude)}, ${escapeHtml(value.longitude)} (accuracy +/- ${escapeHtml(value.accuracy)} m)</p>`;
  return `<h2>Check audit - admin / maintenance manager only</h2>
    ${point('Started', audit.started)}${point('Completed', audit.completed)}
    <p>Elapsed: ${escapeHtml(Math.round(audit.durationMs / 1000))} seconds<br>Server received: ${escapeHtml(receivedAt || 'Pending upload')}</p>
    <p>${escapeHtml(auditReview(audit, receivedAt))}</p>`;
}
