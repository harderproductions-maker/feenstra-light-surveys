import { Capacitor, registerPlugin } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import readXlsxFile from 'read-excel-file/browser';

const LightSensor = registerPlugin('LightSensor');
const CameraCapture = registerPlugin('CameraCapture');
const PdfReport = registerPlugin('PdfReport');
const storageKey = 'feenstra-light-surveys-v1';
const databaseName = 'feenstra-light-surveys';
const recommendedLux = 300;
const initialCalibration = {
  factor: 1200 / 82.01,
  rawReference: 82.01,
  luxReference: 1200,
  note: 'Unverified comparison supplied by the inspector'
};
const workspace = document.querySelector('#workspace');
const surveyList = document.querySelector('#survey-list');
const surveyDialog = document.querySelector('#survey-dialog');
const surveyForm = document.querySelector('#survey-form');
const photoDialog = document.querySelector('#photo-dialog');
const photoForm = document.querySelector('#photo-form');
const photoInput = document.querySelector('#photo-input');
const previewDialog = document.querySelector('#photo-preview');
const reportsDialog = document.querySelector('#reports-dialog');
const reportPreviewDialog = document.querySelector('#report-preview-dialog');
const projectImportInput = document.querySelector('#project-import-input');

let database;
let stateReady;
let stateLoadError = null;
let state = {
  surveys: [],
  buildingChecks: [],
  activeId: null,
  activeEntryId: null,
  sensorCalibration: initialCalibration
};
let currentView = 'home';
let activeCheckProjectId = null;
let activeCheckId = null;
let liveLux = null;
let liveCalibratedLux = null;
let liveLuxAt = null;
let sensorListener = null;
let sensorRunning = false;
let editingSurveyId = null;
let pendingPhoto = null;
let previewPhoto = null;

function alertError(error, fallback) {
  window.alert(error?.message || fallback);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('workspace');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local survey storage.'));
  });
}

const databaseReady = openDatabase().then((connection) => {
  database = connection;
  return connection;
});

async function databaseRequest(mode, action) {
  await databaseReady;
  return new Promise((resolve, reject) => {
    if (!database) {
      reject(new Error('The local survey database connection is unavailable.'));
      return;
    }
    const transaction = database.transaction('workspace', mode);
    const request = action(transaction.objectStore('workspace'));
    let result;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error || new Error('Could not access local survey storage.'));
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error || new Error('Saving survey data was aborted.'));
    transaction.onerror = () => reject(transaction.error || new Error('Could not access local survey storage.'));
  });
}

function normalizeSurvey(survey) {
  if (!survey || typeof survey !== 'object') {
    throw new Error('A saved project record is invalid. Existing local data has been left untouched.');
  }
  const normalized = {
    ...survey,
    id: survey.id || crypto.randomUUID(),
    buildingName: String(survey.buildingName ?? survey.site ?? ''),
    inspectorName: String(survey.inspectorName ?? ''),
    inspectionDate: String(survey.inspectionDate ?? survey.date ?? ''),
    createdAt: survey.createdAt || new Date().toISOString(),
    reports: Array.isArray(survey.reports) ? survey.reports : [],
    entries: []
  };

  if (Array.isArray(survey.entries)) {
    normalized.entries = survey.entries.map((entry) => ({
      ...entry,
      id: entry.id || crypto.randomUUID(),
      name: String(entry.name || ''),
      notes: String(entry.notes || ''),
      readings: Array.isArray(entry.readings) ? entry.readings.map(normalizeReading) : [],
      photos: Array.isArray(entry.photos) ? entry.photos.map(normalizePhoto) : []
    }));
  } else {
    const entries = new Map();
    for (const reading of Array.isArray(survey.readings) ? survey.readings : []) {
      const name = String(reading.area || 'Inspection point');
      if (!entries.has(name)) {
        entries.set(name, { id: crypto.randomUUID(), name, notes: '', readings: [], photos: [] });
      }
      entries.get(name).readings.push(normalizeReading(reading));
    }
    normalized.entries = [...entries.values()];

    for (const photo of Array.isArray(survey.photos) ? survey.photos : []) {
      if (!normalized.entries.length) {
        normalized.entries.push({
          id: crypto.randomUUID(),
          name: 'General inspection',
          notes: '',
          readings: [],
          photos: []
        });
      }
      normalized.entries[0].photos.push(normalizePhoto(photo));
    }
  }
  return normalized;
}

function normalizeCheckProject(project) {
  if (!project || typeof project !== 'object') {
    throw new Error('An imported building-check project is invalid.');
  }
  return {
    ...project,
    id: project.id || crypto.randomUUID(),
    buildingName: String(project.buildingName || ''),
    inspectorName: String(project.inspectorName || ''),
    inspectionDate: String(project.inspectionDate || new Date().toISOString().slice(0, 10)),
    checks: (Array.isArray(project.checks) ? project.checks : []).map((check) => ({
      ...check,
      id: check.id || crypto.randomUUID(),
      title: String(check.title || ''),
      location: String(check.location || ''),
      description: String(check.description || ''),
      category: String(check.category || ''),
      reference: String(check.reference || ''),
      status: ['open', 'in-progress', 'repaired', 'verified'].includes(check.status) ? check.status : 'open',
      condition: ['not-assessed', 'good', 'fair', 'poor', 'critical'].includes(check.condition) ? check.condition : 'not-assessed',
      severity: ['not-assessed', 'low', 'moderate', 'high', 'critical'].includes(check.severity) ? check.severity : 'not-assessed',
      notes: String(check.notes || ''),
      photos: Array.isArray(check.photos) ? check.photos : [],
      history: Array.isArray(check.history) ? check.history : []
    }))
  };
}

function normalizeCalibration(calibration) {
  if (!calibration || !Number.isFinite(Number(calibration.factor)) || Number(calibration.factor) <= 0) {
    return initialCalibration;
  }
  return {
    factor: Number(calibration.factor),
    rawReference: Number(calibration.rawReference) || initialCalibration.rawReference,
    luxReference: Number(calibration.luxReference) || initialCalibration.luxReference,
    note: String(calibration.note || initialCalibration.note)
  };
}

function normalizeReading(reading) {
  return {
    ...reading,
    id: reading.id || crypto.randomUUID(),
    lux: Number(reading.lux),
    rawLux: reading.rawLux === null || reading.rawLux === undefined ? null : Number(reading.rawLux),
    calibrationFactor: reading.calibrationFactor === null || reading.calibrationFactor === undefined
      ? null
      : Number(reading.calibrationFactor),
    target: reading.target === null || reading.target === undefined || reading.target === ''
      ? null
      : Number(reading.target),
    source: reading.source === 'sensor' ? 'sensor' : 'manual',
    createdAt: reading.createdAt || new Date().toISOString()
  };
}

function normalizePhoto(photo) {
  return {
    ...photo,
    id: photo.id || crypto.randomUUID(),
    originalData: photo.originalData || photo.data || '',
    annotatedData: photo.annotatedData || null,
    readingId: photo.readingId || null,
    readingLux: photo.readingLux === null || photo.readingLux === undefined ? null : Number(photo.readingLux),
    readingSource: photo.readingSource || null,
    readingRawLux: photo.readingRawLux === null || photo.readingRawLux === undefined ? null : Number(photo.readingRawLux),
    calibrationFactor: photo.calibrationFactor === null || photo.calibrationFactor === undefined ? null : Number(photo.calibrationFactor),
    createdAt: photo.createdAt || new Date().toISOString()
  };
}

async function loadState() {
  await databaseReady;
  const saved = await databaseRequest('readonly', (store) => store.get('state'));
  if (saved) {
    if (!Array.isArray(saved.surveys)) {
      throw new Error('Saved project data is invalid. Existing local data has been left untouched.');
    }
    if (saved.buildingChecks !== undefined && !Array.isArray(saved.buildingChecks)) {
      throw new Error('Saved building check data is invalid. Existing local data has been left untouched.');
    }
    state = {
      surveys: saved.surveys.map(normalizeSurvey),
      buildingChecks: (Array.isArray(saved.buildingChecks) ? saved.buildingChecks : []).map(normalizeCheckProject),
      activeId: saved.activeId || null,
      activeEntryId: saved.activeEntryId || null,
      sensorCalibration: normalizeCalibration(saved.sensorCalibration)
    };
    render();
    return;
  }

  const legacyValue = localStorage.getItem(storageKey);
  if (legacyValue) {
    const legacy = JSON.parse(legacyValue);
    if (!legacy || !Array.isArray(legacy.surveys)) {
      throw new Error('Legacy project data is invalid. It has been preserved without changes.');
    }
    state = {
      surveys: legacy.surveys.map(normalizeSurvey),
      buildingChecks: [],
      activeId: legacy.activeId || null,
      activeEntryId: null,
      sensorCalibration: initialCalibration
    };
    await databaseRequest('readwrite', (store) => store.put(state, 'state'));
    localStorage.removeItem(storageKey);
  }

  render();
}

async function commit(nextState) {
  const previous = state;
  try {
    await stateReady;
    if (stateLoadError) throw stateLoadError;
    await databaseRequest('readwrite', (store) => store.put(nextState, 'state'));
  } catch (error) {
    state = previous;
    alertError(error, 'Could not save the change. Your existing survey data has not been replaced.');
    render();
    return false;
  }
  state = nextState;
  try {
    render();
  } catch (error) {
    alertError(error, 'Changes were saved, but the screen could not refresh. Reopen the app to view them.');
  }
  return true;
}

function activeSurvey() {
  return state.surveys.find((survey) => survey.id === state.activeId) || null;
}

function activeEntry() {
  const survey = activeSurvey();
  return survey?.entries.find((entry) => entry.id === state.activeEntryId) || survey?.entries[0] || null;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function formatDate(value) {
  if (!value) return 'Date not set';
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? 'Date not set'
    : new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Time not recorded' : new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date);
}

function formatLux(value) {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function navigateView(view, options = {}) {
  if (sensorRunning && view !== 'lighting') void stopSensor();
  currentView = view;
  if (options.projectId !== undefined) activeCheckProjectId = options.projectId;
  if (options.checkId !== undefined) activeCheckId = options.checkId;
  if (options.push !== false) history.pushState({ view, projectId: activeCheckProjectId, checkId: activeCheckId }, '');
  render();
}

function renderHome() {
  const checkCount = state.buildingChecks.reduce((total, project) => total + project.checks.length, 0);
  const openCount = state.buildingChecks.reduce((total, project) =>
    total + project.checks.filter((check) => check.status !== 'verified').length, 0);
  workspace.innerHTML = `
    <div class="home-view">
      <p class="eyebrow">OPERATIONS & OHS WORKSPACE</p>
      <h1>Good ${new Date().getHours() < 12 ? 'morning' : 'day'}.</h1>
      <p class="home-intro">Your fieldwork, inspections, and repair follow-ups in one place.</p>
      <div class="home-cards">
        <article class="home-card lighting-card">
          <div class="home-card-icon">lx</div><p class="eyebrow">LIGHTING SURVEYS</p>
          <h2>Measure and record lighting conditions</h2>
          <p>${state.surveys.length} ${state.surveys.length === 1 ? 'project' : 'projects'} saved on this device</p>
          <button type="button" class="button primary" data-action="lighting">Open lighting surveys →</button>
        </article>
        <article class="home-card checks-card">
          <div class="home-card-icon">✓</div><p class="eyebrow">BUILDING CHECKS</p>
          <h2>Inspect conditions and follow repairs</h2>
          <p>${state.buildingChecks.length} ${state.buildingChecks.length === 1 ? 'building' : 'buildings'} · ${checkCount} checks · ${openCount} need attention</p>
          <button type="button" class="button primary" data-action="checks">Open building checks →</button>
        </article>
      </div>
      <section class="home-quick-actions">
        <h2>Quick actions</h2>
        <button class="button secondary" type="button" data-action="new">＋ Start a lighting project</button>
        <button class="button secondary" type="button" data-action="import-checks">⇧ Import building checks</button>
      </section>
      <p class="workspace-footer">Your records are stored on this device. Export reports or share project data to keep a copy.</p>
    </div>`;
}

function renderCheckProjects() {
  const projects = state.buildingChecks;
  workspace.innerHTML = `
    <div class="checks-view">
      <div class="page-heading">
        <div><p class="eyebrow">OPERATIONS & OHS</p><h1>Building checks</h1>
        <p>Import your building checklist, record condition and severity, and track repairs through verification.</p></div>
        <button class="button primary" type="button" data-action="import-checks">Import checks</button>
      </div>
      ${projects.length ? `<div class="building-grid">${projects.map((project) => {
        const open = project.checks.filter((check) => check.status !== 'verified').length;
        const critical = project.checks.filter((check) => check.severity === 'critical' && check.status !== 'verified').length;
        return `<article class="building-card">
          <div class="building-card-top"><span class="eyebrow">BUILDING CHECKLIST</span><span class="status-chip ${open ? 'attention' : 'complete'}">${open ? `${open} open` : 'Up to date'}</span></div>
          <h2>${escapeHtml(project.buildingName)}</h2><p>${escapeHtml(project.inspectorName)} · Imported ${escapeHtml(formatDateTime(project.createdAt))}</p>
          <div class="building-stats"><span><strong>${project.checks.length}</strong> checks</span><span><strong>${critical}</strong> critical</span></div>
          <button class="button dark" type="button" data-action="open-check-project" data-project-id="${escapeHtml(project.id)}">View checks →</button>
        </article>`;
      }).join('')}</div>` : `
        <div class="empty-state compact-empty"><div class="empty-stamp">✓</div><h2>Start with your building checklist</h2>
          <p>Import your CSV or Excel list. Each item becomes its own check record and individual report, with condition, severity, photos, and repair history.</p>
          <button class="button primary" type="button" data-action="import-checks">Import check list →</button>
        </div>`}
      <div class="import-help"><strong>Supported spreadsheet columns:</strong> Check / Item / Name (required), plus optional Location / Area, Description, Category, Reference / Standard, Condition, and Severity. <button class="text-button" type="button" data-action="download-check-template">Download CSV template</button></div>
    </div>`;
}

function statusLabel(status) {
  return ({ open: 'Open', 'in-progress': 'In progress', repaired: 'Repaired', verified: 'Verified' })[status] || 'Open';
}

function renderCheckProject() {
  const project = state.buildingChecks.find((item) => item.id === activeCheckProjectId);
  if (!project) {
    navigateView('checks', { push: false });
    return;
  }
  const checks = project.checks.map((check) => `
    <article class="check-card">
      <div class="check-card-main">
        <span class="status-chip ${check.status === 'verified' ? 'complete' : check.severity === 'critical' || check.severity === 'high' ? 'attention' : ''}">${escapeHtml(statusLabel(check.status))}</span>
        <h2>${escapeHtml(check.title)}</h2>
        <p>${escapeHtml([check.location, check.category].filter(Boolean).join(' · ') || 'Location not specified')}</p>
        <div class="check-tags"><span>Condition: ${escapeHtml(check.condition.replaceAll('-', ' '))}</span><span>Severity: ${escapeHtml(check.severity.replaceAll('-', ' '))}</span></div>
      </div>
      <div class="check-card-actions">
        <button class="button secondary" type="button" data-action="open-check" data-check-id="${escapeHtml(check.id)}">Open check</button>
        <button class="button secondary" type="button" data-action="export-check" data-check-id="${escapeHtml(check.id)}">Individual report PDF</button>
      </div>
    </article>`).join('');
  workspace.innerHTML = `
    <div class="checks-view">
      <div class="page-heading"><div><p class="eyebrow">BUILDING CHECKS · ${escapeHtml(formatDate(project.inspectionDate))}</p>
        <h1>${escapeHtml(project.buildingName)}</h1><p>Inspector: ${escapeHtml(project.inspectorName)} · ${project.checks.length} individual checks / reports</p></div>
        <button class="button secondary" type="button" data-action="checks">All buildings</button>
      </div>
      <div class="check-list">${checks}</div>
    </div>`;
}

function buildCheckReport(project, check) {
  const photos = (check.photos || []).map((photo) => `<figure><img src="${escapeHtml(photo.data)}" alt="Condition evidence for ${escapeHtml(check.title)}"><figcaption>${escapeHtml(formatDateTime(photo.createdAt))} · ${escapeHtml(photo.caption || 'Inspection photo')}</figcaption></figure>`).join('');
  const history = (check.history || []).map((item) => `
    <article class="history-item"><h3>${escapeHtml(formatDateTime(item.createdAt))} · ${escapeHtml(statusLabel(item.status))}</h3>
      <p>Condition: ${escapeHtml(item.condition.replaceAll('-', ' '))} · Severity: ${escapeHtml(item.severity.replaceAll('-', ' '))}</p>
      ${item.notes ? `<p>${escapeHtml(item.notes)}</p>` : ''}
      ${(item.photoIds || []).length ? `<p>${item.photoIds.length} photo(s) attached to this update. See the condition photos above.</p>` : ''}
    </article>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Building check - ${escapeHtml(check.title)}</title><style>
    *{box-sizing:border-box}body{max-width:900px;margin:30px auto;padding:0 24px;color:#192c28;font:14px/1.5 Arial,sans-serif}header{border-bottom:3px solid #355449;padding-bottom:16px}h1{font-size:27px}h2{margin-top:25px}h3{margin-bottom:5px}.meta{color:#53645b}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:20px 0}.summary div{padding:12px;background:#f1f4ec;border:1px solid #dce2d8}figure{display:inline-block;width:30%;margin:8px 2% 12px 0;vertical-align:top}figure img{width:100%;max-height:280px;object-fit:contain}.history-item{border-top:1px solid #dce2d8;padding:8px 0}.notes{white-space:pre-wrap}@media print{body{margin:12mm auto}}
    </style></head><body><header><p>FEENSTRA LIGHT SURVEYS · BUILDING CONDITION RECORD</p><h1>${escapeHtml(check.title)}</h1>
    <p class="meta"><strong>Building:</strong> ${escapeHtml(project.buildingName)} · <strong>Inspector:</strong> ${escapeHtml(project.inspectorName)}</p>
    <p class="meta"><strong>Location:</strong> ${escapeHtml(check.location || 'Not specified')} · <strong>Inspection date:</strong> ${escapeHtml(formatDate(project.inspectionDate))}</p></header>
    <section class="summary"><div><strong>Status:</strong> ${escapeHtml(statusLabel(check.status))}</div><div><strong>Condition:</strong> ${escapeHtml(check.condition.replaceAll('-', ' '))}</div><div><strong>Severity:</strong> ${escapeHtml(check.severity.replaceAll('-', ' '))}</div></section>
    ${check.description ? `<p><strong>Check description:</strong> ${escapeHtml(check.description)}</p>` : ''}${check.reference ? `<p><strong>Reference:</strong> ${escapeHtml(check.reference)}</p>` : ''}
    <h2>Current inspector notes</h2><p class="notes">${escapeHtml(check.notes || 'No notes recorded.')}</p><h2>Condition photos</h2>${photos || '<p>No photos attached.</p>'}
    <h2>Repair and inspection history</h2>${history || '<p>No updates recorded.</p>'}</body></html>`;
}

function renderCheckDetail() {
  const project = state.buildingChecks.find((item) => item.id === activeCheckProjectId);
  const check = project?.checks.find((item) => item.id === activeCheckId);
  if (!project || !check) {
    navigateView('checks', { push: false });
    return;
  }
  const photos = check.photos.map((photo) => `<figure class="check-photo"><img src="${escapeHtml(photo.data)}" alt="Condition photo for ${escapeHtml(check.title)}"><figcaption>${escapeHtml(formatDateTime(photo.createdAt))}${photo.caption ? ` · ${escapeHtml(photo.caption)}` : ''}</figcaption></figure>`).join('');
  const history = [...check.history].reverse().map((item) => `
    <article class="history-item"><div class="history-heading"><strong>${escapeHtml(formatDateTime(item.createdAt))}</strong><span class="status-chip">${escapeHtml(statusLabel(item.status))}</span></div>
      <p>Condition: ${escapeHtml(item.condition.replaceAll('-', ' '))} · Severity: ${escapeHtml(item.severity.replaceAll('-', ' '))}</p>
      ${item.notes ? `<p class="notes">${escapeHtml(item.notes)}</p>` : ''}
      <div class="history-photos">${(item.photoIds || []).map((id) => {
        const photo = check.photos.find((itemPhoto) => itemPhoto.id === id);
        return photo ? `<img src="${escapeHtml(photo.data)}" alt="Repair history photo">` : '';
      }).join('')}</div>
    </article>`).join('');
  workspace.innerHTML = `
    <div class="check-detail">
      <div class="breadcrumbs"><button class="text-button" type="button" data-action="checks">Building checks</button><span>›</span><span>${escapeHtml(project.buildingName)}</span></div>
      <div class="page-heading"><div><p class="eyebrow">${escapeHtml(check.category || 'BUILDING CHECK')}</p><h1>${escapeHtml(check.title)}</h1>
        <p>${escapeHtml(check.location || 'Location not specified')} · ${escapeHtml(project.buildingName)}</p></div>
        <div class="detail-actions"><button class="button primary" type="button" data-action="update-check">Update check</button>
        <button class="button secondary" type="button" data-action="export-check">Export individual PDF</button></div>
      </div>
      <div class="condition-overview"><span class="status-chip ${check.status === 'verified' ? 'complete' : 'attention'}">${escapeHtml(statusLabel(check.status))}</span>
        <div><span>Condition</span><strong>${escapeHtml(check.condition.replace('-', ' '))}</strong></div>
        <div><span>Severity</span><strong>${escapeHtml(check.severity.replaceAll('-', ' '))}</strong></div>
        <div><span>Last updated</span><strong>${escapeHtml(formatDateTime(check.updatedAt || check.createdAt))}</strong></div>
      </div>
      ${check.description ? `<section class="detail-panel"><h2>Check description</h2><p>${escapeHtml(check.description)}</p>${check.reference ? `<p class="muted">Reference: ${escapeHtml(check.reference)}</p>` : ''}</section>` : ''}
      <section class="detail-panel"><h2>Inspector notes</h2><p class="notes">${escapeHtml(check.notes || 'No notes recorded.')}</p></section>
      <section class="detail-panel"><h2>Condition photos <span class="count">${check.photos.length}</span></h2><div class="check-photo-grid">${photos || '<p class="empty-list">No condition photos attached yet.</p>'}</div></section>
      <section class="detail-panel"><h2>Repair and inspection history</h2><div class="history-list">${history || '<p class="empty-list">Updates and repair evidence will appear here.</p>'}</div></section>
    </div>`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted && character === '"' && text[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === ',') {
      row.push(cell);
      cell = '';
    } else if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  if (quoted) throw new Error('CSV file has an unclosed quoted field.');
  if (rows.length < 2) throw new Error('The checklist file needs a header row and at least one check.');
  const headers = rows[0].map((header) => String(header).trim().replace(/^\uFEFF/, ''));
  return rows.slice(1).map((values) => Object.fromEntries(
    headers.map((header, index) => [header, values[index] || ''])
  ));
}

function normalizeImportHeader(value) {
  return String(value).trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function getImportValue(row, aliases) {
  const entries = Object.entries(row);
  const match = entries.find(([header]) => aliases.includes(normalizeImportHeader(header)));
  return match ? String(match[1] ?? '').trim() : '';
}

async function readBuildingCheckRows(file) {
  if (file.size > 25 * 1024 * 1024) throw new Error('Checklist files must be smaller than 25 MB.');
  if (/\.csv$/i.test(file.name) || file.type === 'text/csv') return parseCsv(await file.text());
  if (!/\.xlsx$/i.test(file.name)) throw new Error('Choose a CSV or Excel (.xlsx) checklist.');
  const rows = (await readXlsxFile(file)).map((row) => row.map((value) =>
    value instanceof Date ? value.toISOString().slice(0, 10) : value === null || value === undefined ? '' : String(value)
  ));
  if (rows.length < 2) throw new Error('The checklist worksheet needs a header row and at least one check.');
  const headers = rows[0].map((header) => String(header).trim());
  return rows.slice(1).map((values) => Object.fromEntries(
    headers.map((header, index) => [header, values[index] || ''])
  ));
}

async function importBuildingChecks(form) {
  await stateReady;
  if (stateLoadError) throw stateLoadError;
  const values = new FormData(form);
  const buildingName = String(values.get('buildingName') || '').trim();
  const inspectorName = String(values.get('inspectorName') || '').trim();
  const file = form.elements.checksFile.files?.[0];
  if (!buildingName || !inspectorName || !file) throw new Error('Building name, inspector name, and a checklist file are required.');
  const rows = await readBuildingCheckRows(file);
  if (rows.length > 1000) throw new Error('A checklist can contain at most 1,000 rows.');
  const checkNameAliases = ['check', 'check name', 'check item', 'checklist item', 'item', 'name', 'inspection item', 'inspection point', 'check point', 'requirement'];
  const checks = rows.map((row, index) => {
    const title = getImportValue(row, checkNameAliases);
    if (!title) {
      if (Object.values(row).some((value) => String(value).trim())) {
        throw new Error(`Checklist row ${index + 2} contains data but has no check name.`);
      }
      return null;
    }
    const createdAt = new Date().toISOString();
    const severity = normalizeSeverity(getImportValue(row, ['severity', 'priority', 'risk level']), index + 2);
    const condition = normalizeCondition(getImportValue(row, ['condition', 'current condition']), index + 2);
    const status = normalizeCheckStatus(getImportValue(row, ['status', 'repair status']), index + 2);
    const check = {
      id: crypto.randomUUID(),
      title,
      location: getImportValue(row, ['location', 'area', 'room', 'building area', 'zone']),
      description: getImportValue(row, ['description', 'details', 'check description', 'observation']),
      category: getImportValue(row, ['category', 'system', 'trade', 'section']),
      reference: getImportValue(row, ['reference', 'standard', 'regulation', 'clause', 'reference standard']),
      status,
      condition,
      severity,
      notes: '',
      photos: [],
      history: [{ id: crypto.randomUUID(), createdAt, status, condition, severity, notes: 'Checklist item imported; condition and severity remain unassessed unless provided in the checklist.', photoIds: [] }],
      createdAt,
      updatedAt: createdAt
    };
    return check;
  }).filter(Boolean);
  if (!checks.length) throw new Error('No check names found. Include a column named Check, Item, Name, or Inspection Item.');
  const project = normalizeCheckProject({
    id: crypto.randomUUID(),
    buildingName,
    inspectorName,
    inspectionDate: new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString(),
    sourceFileName: file.name,
    checks
  });
  const saved = await commit({
    ...state,
    buildingChecks: [project, ...state.buildingChecks]
  });
  if (saved) {
    form.reset();
    document.querySelector('#check-import-dialog').close();
    navigateView('check-project', { projectId: project.id });
    window.alert(`Imported ${checks.length} checks for ${buildingName}. Each check can be inspected and reported separately.`);
  }
}

function openCheckUpdateDialog() {
  const project = state.buildingChecks.find((item) => item.id === activeCheckProjectId);
  const check = project?.checks.find((item) => item.id === activeCheckId);
  if (!check) return;
  const form = document.querySelector('#check-update-form');
  form.reset();
  form.elements.status.value = check.status;
  form.elements.condition.value = check.condition;
  form.elements.severity.value = check.severity;
  form.elements.notes.value = check.notes;
  document.querySelector('#check-update-title').textContent = `Update: ${check.title}`;
  document.querySelector('#check-update-dialog').showModal();
}

async function saveCheckUpdate(form) {
  const project = state.buildingChecks.find((item) => item.id === activeCheckProjectId);
  const check = project?.checks.find((item) => item.id === activeCheckId);
  if (!project || !check) throw new Error('The selected building check is no longer available.');
  const values = new FormData(form);
  const status = String(values.get('status'));
  const condition = String(values.get('condition'));
  const severity = String(values.get('severity'));
  const notes = String(values.get('notes') || '').trim();
  if (status === 'verified' && check.status !== 'repaired' && check.status !== 'verified') {
    throw new Error('Mark the check as repaired before recording verification.');
  }
  if (status === 'repaired' && (!notes || notes === check.notes)) {
    throw new Error('Add a new update note describing the repair before marking this check repaired.');
  }
  const files = [...(form.elements.photos.files || [])];
  if (files.length > 10) throw new Error('Attach no more than 10 photos in one check update.');
  const photos = await Promise.all(files.map(async (file) => {
    if (!file.type.startsWith('image/')) throw new Error(`${file.name} is not an image file.`);
    if (file.size > 12 * 1024 * 1024) throw new Error(`${file.name} is larger than 12 MB.`);
    return {
      id: crypto.randomUUID(),
      data: await fileToDataUrl(file),
      caption: notes || `${condition.replace('-', ' ')} · ${severity} severity`,
      createdAt: new Date().toISOString()
    };
  }));
  const createdAt = new Date().toISOString();
  const updated = {
    ...check,
    status,
    condition,
    severity,
    notes,
    updatedAt: createdAt,
    photos: [...check.photos, ...photos],
    history: [...check.history, {
      id: crypto.randomUUID(),
      createdAt,
      status,
      condition,
      severity,
      notes,
      photoIds: photos.map((photo) => photo.id)
    }]
  };
  const buildingChecks = state.buildingChecks.map((item) => item.id === project.id
    ? { ...item, checks: item.checks.map((child) => child.id === check.id ? updated : child) }
    : item);
  if (await commit({ ...state, buildingChecks })) {
    form.reset();
    document.querySelector('#check-update-dialog').close();
  }
}

async function exportBuildingCheckReport() {
  const project = state.buildingChecks.find((item) => item.id === activeCheckProjectId);
  const check = project?.checks.find((item) => item.id === activeCheckId);
  if (!project || !check) throw new Error('Select a building check before exporting its report.');
  await downloadReport(buildCheckReport(project, check), { buildingName: `${project.buildingName}-${check.title}` }, check.id);
}

async function downloadCheckTemplate() {
  const sample = [
    ['Check', 'Location', 'Description', 'Category', 'Reference', 'Condition', 'Severity'],
    ['Emergency lighting', 'North stairwell', 'Confirm emergency lighting test operation', 'Electrical', 'Site inspection schedule', 'Not assessed', 'Medium'],
    ['Handrail condition', 'Level 1 landing', 'Check fixings and surface condition', 'Access and egress', '', 'Poor', 'High']
  ].map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n');
  const filename = 'Feenstra-Building-Checks-Template.csv';
  if (Capacitor.isNativePlatform()) {
    const saved = await Filesystem.writeFile({ path: filename, data: sample, directory: Directory.Cache });
    await Share.share({ title: 'Building checks import template', url: saved.uri, dialogTitle: 'Save or share CSV template' });
  } else {
    const url = URL.createObjectURL(new Blob([sample], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

function normalizeCondition(value, rowNumber) {
  const normalized = normalizeImportHeader(value);
  if (normalized === 'not assessed' || normalized === 'unknown' || normalized === 'n a' || !normalized) return 'not-assessed';
  if (['good', 'fair', 'poor', 'critical'].includes(normalized)) return normalized;
  throw new Error(`Unrecognized condition “${value}”${rowNumber ? ` in checklist row ${rowNumber}` : ''}. Use not assessed, good, fair, poor, or critical.`);
}

function normalizeSeverity(value, rowNumber) {
  const normalized = normalizeImportHeader(value);
  if (normalized === 'medium') return 'moderate';
  if (['low', 'moderate', 'high', 'critical'].includes(normalized)) return normalized;
  if (!normalized || normalized === 'not assessed' || normalized === 'unknown') return 'not-assessed';
  throw new Error(`Unrecognized severity “${value}”${rowNumber ? ` in checklist row ${rowNumber}` : ''}. Use not assessed, low, medium, moderate, high, or critical.`);
}

function normalizeCheckStatus(value, rowNumber) {
  const normalized = normalizeImportHeader(value);
  if (normalized === 'in progress' || normalized === 'under repair' || normalized === 'underway' || normalized === 'repairing') return 'in-progress';
  if (normalized === 'fixed' || normalized === 'complete' || normalized === 'completed') return 'repaired';
  if (normalized === 'outstanding' || normalized === 'not started') return 'open';
  if (['open', 'repaired', 'verified'].includes(normalized)) return normalized;
  if (!normalized) return 'open';
  throw new Error(`Unrecognized status “${value}”${rowNumber ? ` in checklist row ${rowNumber}` : ''}. Use open, in progress, repaired, or verified.`);
}

function render() {
  renderSurveyList();
  const homeButton = document.querySelector('#home-button');
  const backButton = document.querySelector('#back-button');
  const lightingNav = document.querySelector('[data-view="lighting"]');
  const checksNav = document.querySelector('[data-view="checks"]');
  const homeNav = document.querySelector('[data-view="home"]');
  homeButton.hidden = currentView === 'home';
  backButton.hidden = currentView === 'home';
  homeNav.classList.toggle('active', currentView === 'home');
  lightingNav.classList.toggle('active', currentView === 'lighting');
  checksNav.classList.toggle('active', ['checks', 'check-project', 'check-detail'].includes(currentView));
  surveyList.hidden = currentView !== 'lighting';
  document.querySelector('.rail-heading').hidden = currentView !== 'lighting';
  document.querySelector('#new-survey').hidden = currentView !== 'lighting';
  document.querySelector('#import-project').hidden = currentView !== 'lighting';
  if (currentView === 'home') {
    renderHome();
    return;
  }
  if (currentView === 'checks') {
    renderCheckProjects();
    return;
  }
  if (currentView === 'check-project') {
    renderCheckProject();
    return;
  }
  if (currentView === 'check-detail') {
    renderCheckDetail();
    return;
  }
  const survey = activeSurvey();
  if (!survey) {
    workspace.innerHTML = `
      <div class="empty-state">
        <div class="empty-stamp" aria-hidden="true">lx</div>
        <p class="eyebrow">OHS LIGHTING RECORDS</p>
        <h2>Measure the light where work happens.</h2>
        <p>Create a project with a building and inspector, add named inspection entries, and export a report of its saved measurements and photos.</p>
        <button class="button primary" type="button" data-action="new">Start a project <span aria-hidden="true">→</span></button>
      </div>`;
    return;
  }

  const entry = activeEntry();
  const totalReadings = survey.entries.reduce((count, item) => count + item.readings.length, 0);
  const readings = entry ? [...entry.readings].reverse() : [];
  const photos = entry ? [...entry.photos].reverse() : [];
  const calibration = normalizeCalibration(state.sensorCalibration);

  workspace.innerHTML = `
    <div class="survey-view">
      <div class="survey-topline">
        <div class="survey-title">
          <p class="eyebrow">OHS LIGHTING PROJECT / ${escapeHtml(formatDate(survey.inspectionDate).toUpperCase())}</p>
          <h2>${escapeHtml(survey.buildingName || 'Building name required')}</h2>
          <p class="survey-meta">Inspector: ${escapeHtml(survey.inspectorName || 'Required')} · Inspection date: ${escapeHtml(formatDate(survey.inspectionDate))} · ${totalReadings} readings</p>
          ${survey.restoredFromReportId ? '<p class="survey-meta restored-note">Editable copy restored from a saved report; original project and report are preserved.</p>' : ''}
        </div>
        <div class="top-actions">
          <button class="button secondary" type="button" data-action="project-details">Project details</button>
          <button class="button secondary" type="button" data-action="reports">Saved reports (${survey.reports?.length || 0})</button>
          <button class="button secondary" type="button" data-action="photo" ${entry ? '' : 'disabled'}>Add photo</button>
          <button class="button secondary" type="button" data-action="share-project">Share project</button>
          <button class="button dark" type="button" data-action="export">Export PDF report <span aria-hidden="true">↗</span></button>
        </div>
      </div>

      <div class="entry-toolbar">
        <label for="entry-select">INSPECTION ENTRY</label>
        <select id="entry-select" ${survey.entries.length ? '' : 'disabled'}>
          ${survey.entries.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === entry?.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}
        </select>
      </div>
      <form class="new-entry-form" id="new-entry-form">
        <label for="new-entry-name">Add named inspection entry</label>
        <input id="new-entry-name" name="name" maxlength="100" placeholder="e.g. Ground Floor Reception" required />
        <button class="button secondary" type="submit">Add entry</button>
      </form>

      ${entry ? `
      <form class="entry-details-form" id="entry-details-form">
        <div class="field"><label for="entry-name">Entry name</label><input id="entry-name" name="name" maxlength="100" value="${escapeHtml(entry.name)}" required /></div>
        <div class="field"><label for="entry-notes">Inspector notes / observations</label><input id="entry-notes" name="notes" maxlength="1000" value="${escapeHtml(entry.notes)}" placeholder="Task, conditions, observations" /></div>
        <button class="button subtle" type="submit">Save entry details</button>
      </form>
      ` : '<p class="empty-list">Add a named entry to record measurements and photos for this project.</p>'}

      <p class="section-label">MEASUREMENT</p>
      <div class="capture-grid">
        <section class="meter-panel" aria-label="Live light sensor">
          <div class="meter-kicker"><span>AMBIENT ILLUMINANCE</span><span class="sensor-state ${sensorRunning ? 'live' : ''}" id="sensor-state">${sensorRunning ? 'Live sensor' : 'Sensor off'}</span></div>
          <div class="lux-display"><strong id="lux-value">${liveLux === null ? '--' : escapeHtml(formatLux(liveCalibratedLux))}</strong><span>lx</span></div>
          <p class="sensor-caption" id="sensor-caption">${liveLux === null ? 'No live reading. Start the phone sensor to measure illuminance.' : `Raw ${escapeHtml(formatLux(liveLux))} lx · adjusted ×${escapeHtml(calibration.factor.toFixed(2))} · ${escapeHtml(formatDateTime(liveLuxAt))}`}</p>
          <div class="meter-actions">
            <button class="button primary" type="button" data-action="sensor">${sensorRunning ? 'Stop sensor' : 'Start sensor'}</button>
            <button class="button secondary" type="button" data-action="use-live" ${liveLux === null || !entry ? 'disabled' : ''}>Use live reading</button>
            <button class="button secondary" type="button" data-action="calibration">Calibrate ×${escapeHtml(calibration.factor.toFixed(2))}</button>
          </div>
          <p class="calibration-note">Adjusted using your 82.01 → 1200 lx app comparison. This is unverified, not certified instrument calibration.</p>
        </section>
        <section class="entry-panel">
          <h3>Record a measurement</h3>
          <p>${entry ? `Reading will be saved to ${escapeHtml(entry.name)}.` : 'Add an inspection entry before recording a measurement.'}</p>
          <form class="measurement-form" id="measurement-form">
            <div class="field"><label for="target">Recommended target lux</label><input id="target" name="target" type="number" min="0" step="any" inputmode="decimal" value="${recommendedLux}" required /></div>
            <div class="field"><label for="manual-lux">Measured lux</label><input id="manual-lux" name="lux" type="number" min="0" step="any" inputmode="decimal" placeholder="Enter measured value" required /></div>
            <p class="reading-source" id="reading-source">Manual entry (not a phone sensor reading)</p>
            <div class="field full-width"><label for="reading-note">Measurement note <span>(optional)</span></label><input id="reading-note" name="note" maxlength="500" placeholder="Conditions or task" /></div>
            <button class="button primary record-button" type="submit" ${entry ? '' : 'disabled'}>Save measurement <span aria-hidden="true">→</span></button>
          </form>
        </section>
      </div>

      <div class="list-heading section-label"><h3>READINGS · ${escapeHtml(entry?.name || 'NO ENTRY')}</h3><span class="count">${readings.length} ${readings.length === 1 ? 'reading' : 'readings'}</span></div>
      <div class="reading-list">
        <div class="reading-row header"><span>MEASURED</span><span>TARGET</span><span>ASSESSMENT</span><span>RECORDED</span></div>
        ${readings.length ? readings.map(readingRow).join('') : '<p class="empty-list">No readings in this entry yet.</p>'}
      </div>

      <div class="photo-heading section-label"><h3>PHOTOS · ${escapeHtml(entry?.name || 'NO ENTRY')}</h3><button class="button subtle" type="button" data-action="photo" ${entry ? '' : 'disabled'}>Add photo</button></div>
      ${photos.length ? `<div class="photo-strip">${photos.map(photoTile).join('')}</div>` : '<p class="photo-empty">No photos attached to this entry.</p>'}

      <div class="project-entries section-label"><h3>ALL PROJECT ENTRIES</h3></div>
      <div class="entry-list">${survey.entries.length ? survey.entries.map((item) => `
        <button type="button" class="entry-card ${item.id === entry?.id ? 'active' : ''}" data-entry="${escapeHtml(item.id)}">
          <strong>${escapeHtml(item.name || 'Unnamed entry')}</strong>
          <span>${item.readings.length} readings · ${item.photos.length} photos</span>
        </button>`).join('') : '<p class="empty-list">No inspection entries yet.</p>'}</div>
      <p class="workspace-footer">Project data and original photos are stored locally on this device. Reports include all saved entries, measurements, notes, and photos in this project.</p>
    </div>`;

  document.querySelector('#entry-select')?.addEventListener('change', selectEntry);
}

function readingRow(reading) {
  const target = reading.target === null || reading.target === undefined || reading.target === ''
    ? null
    : Number.isFinite(Number(reading.target)) ? Number(reading.target) : null;
  const status = target === null ? 'No target' : reading.lux >= target ? 'Meets target' : 'Below target';
  const statusClass = target === null ? 'unset' : reading.lux >= target ? '' : 'below';
  return `<div class="reading-row">
    <span><strong class="reading-lux">${escapeHtml(formatLux(reading.lux))} lx</strong><small>${reading.source === 'sensor' ? `Phone sensor · raw ${reading.rawLux === null ? 'not recorded' : `${escapeHtml(formatLux(reading.rawLux))} lx · ×${escapeHtml(Number(reading.calibrationFactor || 1).toFixed(2))}`}` : 'Manual entry'}</small></span>
    <span class="reading-target">${target === null ? '—' : `${escapeHtml(formatLux(target))} lx`}</span>
    <span class="reading-status ${statusClass}">${status}</span>
    <span class="reading-time">${escapeHtml(formatDateTime(reading.createdAt))}</span>
  </div>`;
}

function photoTile(photo) {
  return `<button type="button" class="photo-tile" data-photo="${escapeHtml(photo.id)}" aria-label="View ${photo.annotatedData ? 'annotated' : 'original'} inspection photo">
    <img src="${escapeHtml(photo.annotatedData || photo.originalData)}" alt="Inspection photo for ${escapeHtml(photo.entryName || '')}" />
    <span>${escapeHtml(formatDateTime(photo.createdAt))}${photo.readingLux === null ? '' : ` · ${escapeHtml(formatLux(photo.readingLux))} lx`}</span>
  </button>`;
}

function renderSurveyList() {
  surveyList.innerHTML = state.surveys.map((survey) => `
    <button type="button" class="survey-item ${survey.id === state.activeId ? 'active' : ''}" data-survey="${escapeHtml(survey.id)}">
      <strong>${escapeHtml(survey.buildingName || 'Building name required')}</strong>
      <span>${escapeHtml(survey.inspectorName || 'Inspector required')} · ${survey.entries.length} entries</span>
    </button>`).join('');
}

function openSurveyDialog(survey = null) {
  editingSurveyId = survey?.id || null;
  surveyForm.reset();
  surveyForm.elements.buildingName.value = survey?.buildingName || '';
  surveyForm.elements.inspectorName.value = survey?.inspectorName || '';
  surveyForm.elements.inspectionDate.value = survey?.inspectionDate || new Date().toISOString().slice(0, 10);
  document.querySelector('#survey-dialog-title').textContent = survey ? 'Project details' : 'Start a project';
  document.querySelector('#survey-dialog-submit').textContent = survey ? 'Save project' : 'Create project →';
  surveyDialog.showModal();
}

function selectEntry(event) {
  void commit({ ...state, activeEntryId: event.currentTarget.value });
}

async function startSensor() {
  liveLux = null;
  liveCalibratedLux = null;
  liveLuxAt = null;
  try {
    sensorListener = await LightSensor.addListener('reading', ({ lux }) => {
      const value = Number(lux);
      if (!Number.isFinite(value) || value < 0) return;
      liveLux = value;
      liveCalibratedLux = value * normalizeCalibration(state.sensorCalibration).factor;
      liveLuxAt = new Date().toISOString();
      const display = document.querySelector('#lux-value');
      const caption = document.querySelector('#sensor-caption');
      const useButton = document.querySelector('[data-action="use-live"]');
      if (display) display.textContent = formatLux(liveCalibratedLux);
      if (caption) caption.textContent = `Raw ${formatLux(liveLux)} lx · adjusted ×${normalizeCalibration(state.sensorCalibration).factor.toFixed(2)} · ${formatDateTime(liveLuxAt)}`;
      if (useButton) useButton.disabled = !activeEntry();
    });
    await LightSensor.start();
    sensorRunning = true;
    render();
  } catch (error) {
    await sensorListener?.remove();
    sensorListener = null;
    sensorRunning = false;
    liveLux = null;
    liveCalibratedLux = null;
    liveLuxAt = null;
    render();
    alertError(error, 'The ambient light sensor is unavailable. No sensor reading was recorded.');
  }
}

async function stopSensor() {
  try {
    await LightSensor.stop();
    await sensorListener?.remove();
    sensorListener = null;
    sensorRunning = false;
    liveLux = null;
    liveCalibratedLux = null;
    liveLuxAt = null;
    render();
  } catch (error) {
    alertError(error, 'Could not stop the ambient light sensor.');
  }
}

function openPhotoDialog() {
  const entry = activeEntry();
  if (!entry) {
    window.alert('Add or select a named inspection entry before taking a photo.');
    return;
  }
  photoForm.reset();
  const select = photoForm.elements.readingId;
  const sensorReadings = entry.readings.filter((reading) => reading.source === 'sensor');
  select.innerHTML = `<option value="">No saved phone sensor reading</option>${[...sensorReadings].reverse().map((reading) => `
    <option value="${escapeHtml(reading.id)}">${escapeHtml(formatLux(reading.lux))} lx · ${escapeHtml(formatDateTime(reading.createdAt))} · ${reading.source === 'sensor' ? 'Phone sensor' : 'manual'}</option>`).join('')}`;
  photoForm.elements.annotate.checked = sensorReadings.length > 0;
  photoDialog.showModal();
}

async function savePhotoForEntry(surveyId, entryId, originalData, capture) {
  const survey = state.surveys.find((item) => item.id === surveyId);
  const entry = survey?.entries.find((item) => item.id === entryId);
  if (!survey || !entry) throw new Error('The selected project entry is no longer available.');

  const createdAt = capture.createdAt || new Date().toISOString();
  let reading = capture.reading || null;
  if (!reading && Number.isFinite(capture.rawLux) && capture.rawLux >= 0
    && Number.isFinite(capture.calibratedLux) && capture.calibratedLux >= 0) {
    reading = {
      id: crypto.randomUUID(),
      lux: capture.calibratedLux,
      rawLux: capture.rawLux,
      calibrationFactor: capture.calibrationFactor,
      target: recommendedLux,
      note: 'Captured with inspection photo',
      source: 'sensor',
      createdAt
    };
  }

  const photo = {
    id: crypto.randomUUID(),
    entryName: entry.name,
    originalData,
    annotatedData: capture.annotate === false
      ? null
      : await createAnnotatedPhoto(originalData, survey, entry, reading, createdAt),
    readingId: reading?.id || null,
    readingLux: reading ? Number(reading.lux) : null,
    readingRawLux: reading?.rawLux ?? null,
    calibrationFactor: reading?.calibrationFactor ?? null,
    readingSource: reading?.source || null,
    createdAt
  };
  const surveys = state.surveys.map((item) => item.id === survey.id
    ? { ...item, entries: item.entries.map((child) => child.id === entry.id
      ? {
        ...child,
        readings: reading ? [...child.readings, reading] : child.readings,
        photos: [...child.photos, photo]
      }
      : child) }
    : item);
  return commit({ ...state, surveys });
}

async function captureNativePhoto() {
  const survey = activeSurvey();
  const entry = activeEntry();
  if (!survey || !entry) {
    window.alert('Add or select a named inspection entry before taking a photo.');
    return;
  }
  try {
    if (sensorRunning) await stopSensor();
    const result = await CameraCapture.capture({
      buildingName: survey.buildingName,
      entryName: entry.name,
      recommendedLux,
      calibrationFactor: normalizeCalibration(state.sensorCalibration).factor
    });
    if (result.cancelled) return;
    if (!result.base64) throw new Error('The camera did not return an image.');
    const createdAt = new Date(Number(result.capturedAt) || Date.now()).toISOString();
    const saved = await savePhotoForEntry(survey.id, entry.id, `data:image/jpeg;base64,${result.base64}`, {
      rawLux: Number.isFinite(result.rawLux) ? result.rawLux : null,
      calibratedLux: Number.isFinite(result.calibratedLux) ? result.calibratedLux : null,
      calibrationFactor: normalizeCalibration(state.sensorCalibration).factor,
      createdAt
    });
    if (saved) window.alert('Photo saved with this inspection entry and its captured sensor reading.');
  } catch (error) {
    alertError(error, 'Could not open the camera or save the captured photo.');
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('Could not read the captured photo.'));
    reader.readAsDataURL(file);
  });
}

async function createAnnotatedPhoto(originalData, survey, entry, reading, createdAt) {
  const response = await fetch(originalData);
  const image = await createImageBitmap(await response.blob());
  try {
    const scale = Math.min(1, 2000 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not prepare the photo annotation.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const unit = Math.max(1, canvas.width / 1000);
    const padding = 14 * unit;
    const fontSize = Math.max(14, 20 * unit);
    const lineHeight = fontSize * 1.35;
    const lines = [
      `FEENSTRA LIGHT SURVEYS  |  ${survey.buildingName}`,
      `Entry: ${entry.name}`,
      `Captured: ${formatDateTime(createdAt)}`,
      `Recommended target: ${recommendedLux} lx`,
      reading
        ? `Lux: ${formatLux(reading.lux)} lx  (${reading.source === 'sensor' ? 'phone light sensor' : 'manual entry'}) · Measured ${formatDateTime(reading.createdAt)}`
        : 'Lux: not recorded for this photo'
    ];
    if (reading?.source === 'sensor' && Number.isFinite(reading.rawLux)) {
      lines.push(`Raw sensor: ${formatLux(reading.rawLux)} lx · adjustment ×${Number(reading.calibrationFactor).toFixed(2)} (unverified)`);
    }
    const panelHeight = padding * 2 + lines.length * lineHeight;
    const panelTop = canvas.height - panelHeight;
    context.fillStyle = 'rgba(13, 26, 23, 0.86)';
    context.fillRect(0, panelTop, canvas.width, panelHeight);
    context.fillStyle = '#ffffff';
    context.font = `600 ${fontSize}px Arial, sans-serif`;
    context.textBaseline = 'top';
    lines.forEach((line, index) => {
      let visible = line;
      const maxWidth = canvas.width - padding * 2;
      while (context.measureText(visible).width > maxWidth && visible.length > 4) {
        visible = `${visible.slice(0, -5)}…`;
      }
      context.fillText(visible, padding, panelTop + padding + index * lineHeight);
    });
    return canvas.toDataURL('image/jpeg', 0.9);
  } finally {
    image.close();
  }
}

function buildReport(survey) {
  const allReadings = survey.entries.flatMap((entry) => entry.readings);
  const allPhotos = survey.entries.flatMap((entry) => entry.photos);
  const average = allReadings.length
    ? formatLux(allReadings.reduce((sum, reading) => sum + Number(reading.lux), 0) / allReadings.length)
    : '—';
  const entries = survey.entries.map((entry) => {
    const rows = entry.readings.map((reading) => {
      const target = reading.target === null || reading.target === undefined || reading.target === ''
        ? null
        : Number.isFinite(Number(reading.target)) ? Number(reading.target) : null;
      const assessment = target === null ? 'No target specified' : reading.lux >= target ? 'Meets target' : 'Below target';
      return `<tr>
        <td>${escapeHtml(formatLux(reading.lux))} lx<br><small>${reading.source === 'sensor' ? `Phone sensor · raw ${reading.rawLux === null ? 'not recorded' : `${escapeHtml(formatLux(reading.rawLux))} lx · calibration ×${escapeHtml(Number(reading.calibrationFactor || 1).toFixed(2))}`}` : 'Manual entry'}</small></td>
        <td>${target === null ? '—' : `${escapeHtml(formatLux(target))} lx`}</td>
        <td>${assessment}</td>
        <td>${escapeHtml(formatDateTime(reading.createdAt))}</td>
        <td>${escapeHtml(reading.note || '')}</td>
      </tr>`;
    }).join('');
    const photos = entry.photos.map((photo) => `
      <figure>
        <img src="${escapeHtml(photo.annotatedData || photo.originalData)}" alt="Inspection photo for ${escapeHtml(entry.name)}">
        <figcaption>${photo.annotatedData ? 'Annotated inspection photo' : 'Original inspection photo'} · Captured ${escapeHtml(formatDateTime(photo.createdAt))}${photo.readingLux === null ? '' : ` · ${escapeHtml(formatLux(photo.readingLux))} lx recorded`}</figcaption>
        ${photo.annotatedData ? `<details><summary>View original photograph</summary><img src="${escapeHtml(photo.originalData)}" alt="Original, unannotated photograph"></details>` : ''}
      </figure>`).join('');
    return `<section class="entry">
      <h2>${escapeHtml(entry.name || 'Unnamed inspection entry')}</h2>
      ${entry.notes ? `<p class="notes"><strong>Inspector notes / observations:</strong> ${escapeHtml(entry.notes)}</p>` : '<p class="notes">No inspector notes recorded.</p>'}
      <table><thead><tr><th>Measured</th><th>Target</th><th>Assessment</th><th>Inspection date / time</th><th>Measurement notes</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">No measurements recorded for this entry.</td></tr>'}</tbody></table>
      <h3>Inspection photos</h3>${photos || '<p>No photos attached to this entry.</p>'}
    </section>`;
  }).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OHS Lighting Report - ${escapeHtml(survey.buildingName)}</title><style>
    *{box-sizing:border-box}body{max-width:1000px;margin:36px auto;padding:0 24px;color:#192c28;font:14px/1.5 Arial,sans-serif}header{display:flex;justify-content:space-between;align-items:start;border-bottom:3px solid #355449;padding-bottom:20px}h1{font-size:27px;margin:0 0 6px}h2{font-size:19px;margin:28px 0 10px}h3{font-size:14px;margin:18px 0 8px}.kicker{font-size:10px;letter-spacing:1.4px;font-weight:bold;color:#5e6e64}.meta{color:#53645b;margin:4px 0}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:20px 0}.summary div{padding:13px;border:1px solid #dce2d8;background:#f7f9f4}.summary strong{display:block;font-size:20px}.summary span{font-size:11px;color:#53645b}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:9px;border-bottom:1px solid #dce2d8;vertical-align:top}th{background:#edf1e8;font-size:10px;text-transform:uppercase}.entry{margin-top:26px;break-inside:avoid}.entry>h2{border-bottom:1px solid #dce2d8;padding-bottom:8px}.notes{color:#53645b}figure{display:inline-block;width:30%;margin:0 2% 16px 0;vertical-align:top}figure img{width:100%;max-height:280px;object-fit:contain;background:#f2f4ef}figcaption,.disclaimer{color:#53645b;font-size:11px}details img{margin-top:8px}.disclaimer{margin-top:30px;padding-top:12px;border-top:1px solid #dce2d8}@media print{body{margin:12mm auto;padding:0}.no-print{display:none}tr,figure{break-inside:avoid}}@media(max-width:600px){.summary{grid-template-columns:1fr 1fr}table{font-size:10px}th,td{padding:6px}figure{width:47%}}
    </style></head><body><header><div><p class="kicker">FEENSTRA LIGHT SURVEYS / OHS RECORD</p><h1>Lighting Survey Report</h1>
    <p class="meta"><strong>Building:</strong> ${escapeHtml(survey.buildingName)}</p><p class="meta"><strong>Inspector:</strong> ${escapeHtml(survey.inspectorName)}</p>
    <p class="meta"><strong>Project ID:</strong> ${escapeHtml(survey.id)}</p><p class="meta"><strong>Inspection date:</strong> ${escapeHtml(formatDate(survey.inspectionDate))}</p>
    <p class="meta"><strong>Report generated:</strong> ${escapeHtml(formatDateTime(new Date().toISOString()))}</p></div><button class="no-print" onclick="window.print()">Print / Save as PDF</button></header>
    <section class="summary"><div><strong>${survey.entries.length}</strong><span>Named inspection entries</span></div>
    <div><strong>${allReadings.length}</strong><span>Recorded measurements</span></div><div><strong>${allPhotos.length}</strong><span>Inspection photos</span></div>
    <div><strong>${average}</strong><span>Average measured lux</span></div></section>
    <h2>Inspection entries and measurements</h2>${entries || '<p>No inspection entries recorded.</p>'}
    <p class="disclaimer">Recommended target: ${recommendedLux} lx; confirm the applicable standard for the task and jurisdiction. Sensor readings retain the raw phone value and the adjusted value. The current adjustment factor (${escapeHtml(normalizeCalibration(state.sensorCalibration).factor.toFixed(4))}) is based on an unverified comparison supplied in the app and is not certified calibration. Manual values are identified separately. Confirm workplace lighting requirements for the relevant jurisdiction and task.</p></body></html>`;
}

function safeFileName(value) {
  return value.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'survey';
}

async function downloadReport(report, survey, reportId) {
  if (Capacitor.isNativePlatform()) {
    await PdfReport.create({
      html: report,
      title: `OHS-Lighting-Report-${safeFileName(survey.buildingName)}-${reportId.slice(0, 8)}`
    });
    return;
  }
  const frame = document.createElement('iframe');
  frame.title = 'PDF report print preview';
  frame.style.position = 'fixed';
  frame.style.width = '1px';
  frame.style.height = '1px';
  frame.style.opacity = '0';
  frame.style.pointerEvents = 'none';
  frame.srcdoc = report;
  frame.onload = () => {
    const printWindow = frame.contentWindow;
    if (!printWindow) {
      frame.remove();
      window.alert('Could not open the PDF print dialog.');
      return;
    }
    printWindow.addEventListener('afterprint', () => frame.remove(), { once: true });
    printWindow.focus();
    printWindow.print();
    window.setTimeout(() => frame.remove(), 60_000);
  };
  document.body.append(frame);
}

function projectPackage(survey) {
  return {
    format: 'feenstra-light-surveys-project',
    version: 1,
    exportedAt: new Date().toISOString(),
    project: survey
  };
}

async function shareProject(survey) {
  if (!survey.buildingName.trim() || !survey.inspectorName.trim()) {
    window.alert('Building Name and Inspector Name are required before sharing a project.');
    return;
  }
  const filename = `Feenstra-Project-${safeFileName(survey.buildingName)}.json`;
  const contents = JSON.stringify(projectPackage(survey));
  if (Capacitor.isNativePlatform()) {
    const saved = await Filesystem.writeFile({
      path: filename,
      data: contents,
      directory: Directory.Cache,
      recursive: true
    });
    await Share.share({
      title: `Share ${survey.buildingName} project`,
      text: `Editable Feenstra Light Surveys project: ${survey.buildingName}`,
      url: saved.uri,
      dialogTitle: 'Share project package'
    });
    return;
  }
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function importProject(file) {
  if (!file) return;
  await stateReady;
  if (stateLoadError) throw stateLoadError;
  if (file.size > 100 * 1024 * 1024) {
    throw new Error('Project package is larger than 100 MB. Share a smaller project package.');
  }
  let bundle;
  try {
    bundle = JSON.parse(await file.text());
  } catch (error) {
    throw new Error(`Could not read the project package as JSON: ${error.message}`);
  }
  if (bundle?.format !== 'feenstra-light-surveys-project' || bundle.version !== 1 || !bundle.project) {
    throw new Error('This file is not a supported Feenstra Light Surveys project package.');
  }
  const project = normalizeSurvey(bundle.project);
  if (!project.buildingName.trim() || !project.inspectorName.trim()) {
    throw new Error('The shared project is missing its required building or inspector name.');
  }
  const names = project.entries.map((entry) => entry.name.trim().toLocaleLowerCase());
  if (names.some((name) => !name) || new Set(names).size !== names.length) {
    throw new Error('The shared project has an empty or repeated inspection entry name.');
  }
  project.id = crypto.randomUUID();
  project.importedAt = new Date().toISOString();
  const saved = await commit({
    ...state,
    surveys: [project, ...state.surveys],
    activeId: project.id,
    activeEntryId: project.entries[0]?.id || null
  });
  if (saved) {
    window.alert(`Imported “${project.buildingName}” as a separate editable project. Existing projects were not changed.`);
  }
}

async function exportReport(survey) {
  if (!survey.buildingName.trim() || !survey.inspectorName.trim() || !survey.inspectionDate) {
    window.alert('Building Name, Inspector Name, and inspection date are required before exporting this report.');
    openSurveyDialog(survey);
    return;
  }
  try {
    const report = buildReport(survey);
    const reportId = crypto.randomUUID();
    const snapshot = JSON.parse(JSON.stringify({ ...survey, reports: [] }));
    const savedSurvey = {
      ...survey,
      reports: [...survey.reports, { id: reportId, createdAt: new Date().toISOString(), html: report, projectSnapshot: snapshot }]
    };
    const surveys = state.surveys.map((item) => item.id === survey.id ? savedSurvey : item);
    if (!await commit({ ...state, surveys })) return;
    await downloadReport(report, survey, reportId);
  } catch (error) {
    alertError(error, 'Could not export the OHS report.');
  }
}

function openReportHistory(survey) {
  const list = document.querySelector('#report-history-list');
  list.innerHTML = survey.reports.length
    ? [...survey.reports].reverse().map((report) => `
      <article class="saved-report">
        <div><strong>Report · ${escapeHtml(formatDateTime(report.createdAt))}</strong><span>${escapeHtml(report.id.slice(0, 8))}</span></div>
        <button class="button secondary" type="button" data-report-action="view" data-report-id="${escapeHtml(report.id)}">View</button>
        <button class="button secondary" type="button" data-report-action="download" data-report-id="${escapeHtml(report.id)}">Export PDF</button>
        <button class="button primary" type="button" data-report-action="restore" data-report-id="${escapeHtml(report.id)}">Restore as editable copy</button>
      </article>`).join('')
    : '<p class="empty-list">No saved reports yet. Export a PDF report to preserve a report revision in this project.</p>';
  reportsDialog.showModal();
}

function restrictReportPreview(html) {
  const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:">';
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (head) => `${head}${policy}`);
  return `<!doctype html><html><head>${policy}</head><body>${html}</body></html>`;
}

async function restoreReportAsProject(survey, report) {
  if (!report.projectSnapshot || !Array.isArray(report.projectSnapshot.entries)) {
    window.alert('This saved report has no editable project snapshot.');
    return;
  }
  const restored = {
    ...JSON.parse(JSON.stringify(report.projectSnapshot)),
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    reports: [],
    restoredFromReportId: report.id
  };
  const surveys = [restored, ...state.surveys];
  const saved = await commit({ ...state, surveys, activeId: restored.id, activeEntryId: restored.entries[0]?.id || null });
  if (saved) {
    reportsDialog.close();
    window.alert(`An editable copy of the ${survey.buildingName} report was restored. The saved report and original project were not changed.`);
  }
}

workspace.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action], [data-photo], [data-entry]');
  if (!button) return;
  if (button.dataset.photo) {
    const photo = activeEntry()?.photos.find((item) => item.id === button.dataset.photo);
    if (!photo) return;
    previewPhoto = photo;
    document.querySelector('#photo-preview-image').src = photo.annotatedData || photo.originalData;
    document.querySelector('#photo-preview-caption').textContent = `${photo.annotatedData ? 'Annotated' : 'Original'} photo · ${formatDateTime(photo.createdAt)}${photo.readingLux === null ? '' : ` · ${formatLux(photo.readingLux)} lx recorded`}`;
    document.querySelector('[data-preview-mode="original"]').disabled = !photo.annotatedData;
    previewDialog.showModal();
    return;
  }
  if (button.dataset.entry) {
    await commit({ ...state, activeEntryId: button.dataset.entry });
    return;
  }
  const survey = activeSurvey();
  if (button.dataset.action === 'lighting') {
    navigateView('lighting');
    return;
  }
  if (button.dataset.action === 'checks') {
    navigateView('checks');
    return;
  }
  if (button.dataset.action === 'import-checks') {
    document.querySelector('#check-import-dialog').showModal();
    return;
  }
  if (button.dataset.action === 'open-check-project') {
    navigateView('check-project', { projectId: button.dataset.projectId });
    return;
  }
  if (button.dataset.action === 'open-check') {
    navigateView('check-detail', { checkId: button.dataset.checkId });
    return;
  }
  if (button.dataset.action === 'update-check') {
    openCheckUpdateDialog();
    return;
  }
  if (button.dataset.action === 'export-check') {
    try {
      await exportBuildingCheckReport();
    } catch (error) {
      alertError(error, 'Could not export the building check report.');
    }
    return;
  }
  if (button.dataset.action === 'download-check-template') {
    try {
      await downloadCheckTemplate();
    } catch (error) {
      alertError(error, 'Could not share the building checks template.');
    }
    return;
  }
  switch (button.dataset.action) {
    case 'new':
      if (currentView !== 'lighting') navigateView('lighting');
      openSurveyDialog();
      break;
    case 'project-details':
      if (survey) openSurveyDialog(survey);
      break;
    case 'photo':
      if (Capacitor.isNativePlatform()) await captureNativePhoto();
      else openPhotoDialog();
      break;
    case 'export':
      if (survey) await exportReport(survey);
      break;
    case 'share-project':
      if (survey) {
        try {
          await shareProject(survey);
        } catch (error) {
          alertError(error, 'Could not share the project package.');
        }
      }
      break;
    case 'reports':
      if (survey) openReportHistory(survey);
      break;
    case 'sensor':
      if (sensorRunning) await stopSensor();
      else await startSensor();
      break;
    case 'use-live': {
      const input = document.querySelector('#manual-lux');
      if (input && liveLux !== null && liveCalibratedLux !== null && liveLuxAt) {
        input.value = String(liveCalibratedLux);
        input.dataset.source = 'sensor';
        input.dataset.sensorLux = String(liveCalibratedLux);
        input.dataset.rawLux = String(liveLux);
        input.dataset.calibrationFactor = String(normalizeCalibration(state.sensorCalibration).factor);
        input.dataset.sensorTime = liveLuxAt;
        document.querySelector('#reading-source').textContent = `Adjusted phone sensor ×${normalizeCalibration(state.sensorCalibration).factor.toFixed(2)} · raw ${formatLux(liveLux)} lx`;
      }
      break;
    }
    case 'calibration': {
      if (liveLux === null || liveLux <= 0) {
        window.alert('Start the sensor and wait for a non-zero live reading before calibrating.');
        break;
      }
      const reference = Number(window.prompt('Enter a trusted reference meter reading in lux for the same light and position. This adjustment is unverified and not certified calibration.', String(initialCalibration.luxReference)));
      if (!Number.isFinite(reference) || reference <= 0) break;
      const calibration = {
        factor: reference / liveLux,
        rawReference: liveLux,
        luxReference: reference,
        note: 'Inspector-calibrated from a reference meter; not independently certified'
      };
      if (await commit({ ...state, sensorCalibration: calibration })) {
        liveCalibratedLux = liveLux * calibration.factor;
        const input = document.querySelector('#manual-lux');
        if (input?.dataset.source === 'sensor') {
          input.value = String(liveCalibratedLux);
          input.dataset.sensorLux = String(liveCalibratedLux);
          input.dataset.calibrationFactor = String(calibration.factor);
        }
      }
      break;
    }
  }
});

surveyList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-survey]');
  if (!button) return;
  if (sensorRunning) await stopSensor();
  const survey = state.surveys.find((item) => item.id === button.dataset.survey);
  currentView = 'lighting';
  history.pushState({ view: 'lighting' }, '');
  await commit({ ...state, activeId: button.dataset.survey, activeEntryId: survey?.entries[0]?.id || null });
});

document.querySelectorAll('.module-link').forEach((button) => {
  button.addEventListener('click', () => navigateView(button.dataset.view));
});
document.querySelector('#home-button').addEventListener('click', () => navigateView('home'));
document.querySelector('#back-button').addEventListener('click', () => {
  if (currentView === 'check-detail') navigateView('check-project', { projectId: activeCheckProjectId });
  else if (currentView === 'check-project') navigateView('checks');
  else navigateView('home');
});
window.addEventListener('popstate', (event) => {
  currentView = ['home', 'lighting', 'checks', 'check-project', 'check-detail'].includes(event.state?.view)
    ? event.state.view
    : 'home';
  activeCheckProjectId = event.state?.projectId || activeCheckProjectId;
  activeCheckId = event.state?.checkId || activeCheckId;
  render();
});

document.querySelector('#check-import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await importBuildingChecks(event.currentTarget);
  } catch (error) {
    alertError(error, 'Could not import the building check list.');
  }
});
document.querySelector('#close-check-import').addEventListener('click', () => document.querySelector('#check-import-dialog').close());
document.querySelector('#cancel-check-import').addEventListener('click', () => document.querySelector('#check-import-dialog').close());
document.querySelector('#check-update-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await saveCheckUpdate(event.currentTarget);
  } catch (error) {
    alertError(error, 'Could not save the building check update.');
  }
});
document.querySelector('#close-check-update').addEventListener('click', () => document.querySelector('#check-update-dialog').close());
document.querySelector('#cancel-check-update').addEventListener('click', () => document.querySelector('#check-update-dialog').close());

reportsDialog.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-report-action]');
  if (!button) return;
  const survey = activeSurvey();
  const report = survey?.reports.find((item) => item.id === button.dataset.reportId);
  if (!survey || !report) return;

  if (button.dataset.reportAction === 'view') {
    document.querySelector('#saved-report-frame').srcdoc = restrictReportPreview(report.html);
    document.querySelector('#saved-report-title').textContent = `Saved report · ${formatDateTime(report.createdAt)}`;
    reportPreviewDialog.showModal();
  } else if (button.dataset.reportAction === 'download') {
    try {
      await downloadReport(report.html, survey, report.id);
    } catch (error) {
      alertError(error, 'Could not export the saved report.');
    }
  } else if (button.dataset.reportAction === 'restore') {
    await restoreReportAsProject(survey, report);
  }
});

document.querySelector('#new-survey').addEventListener('click', () => openSurveyDialog());
document.querySelector('#import-project').addEventListener('click', () => projectImportInput.click());
projectImportInput.addEventListener('change', async () => {
  const file = projectImportInput.files?.[0];
  try {
    await importProject(file);
  } catch (error) {
    alertError(error, 'Could not import the project package.');
  } finally {
    projectImportInput.value = '';
  }
});
document.querySelector('#close-dialog').addEventListener('click', () => surveyDialog.close());
document.querySelector('#cancel-survey').addEventListener('click', () => surveyDialog.close());
document.querySelector('#close-photo-dialog').addEventListener('click', () => photoDialog.close());
document.querySelector('#cancel-photo').addEventListener('click', () => photoDialog.close());
document.querySelector('#close-photo-preview').addEventListener('click', () => previewDialog.close());
document.querySelector('#close-reports-dialog').addEventListener('click', () => reportsDialog.close());
document.querySelector('#close-report-preview').addEventListener('click', () => reportPreviewDialog.close());
document.querySelector('#close-report-preview-footer').addEventListener('click', () => reportPreviewDialog.close());

surveyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await stateReady;
  if (stateLoadError) {
    alertError(stateLoadError, 'Project storage is unavailable. No changes were saved.');
    return;
  }
  const form = new FormData(surveyForm);
  const buildingName = String(form.get('buildingName') || '').trim();
  const inspectorName = String(form.get('inspectorName') || '').trim();
  const inspectionDate = String(form.get('inspectionDate') || '').trim();
  if (!buildingName || !inspectorName || !inspectionDate) {
    window.alert('Building Name, Inspector Name, and inspection date are required.');
    return;
  }
  const previous = state.surveys.find((survey) => survey.id === editingSurveyId);
  const project = previous
    ? { ...previous, buildingName, inspectorName, inspectionDate }
    : {
      id: crypto.randomUUID(),
      buildingName,
      inspectorName,
      inspectionDate,
      createdAt: new Date().toISOString(),
      entries: [],
      reports: []
    };
  const surveys = previous
    ? state.surveys.map((survey) => survey.id === previous.id ? project : survey)
    : [project, ...state.surveys];
  const saved = await commit({
    ...state,
    surveys,
    activeId: project.id,
    activeEntryId: previous ? state.activeEntryId : null
  });
  if (saved) surveyDialog.close();
});

workspace.addEventListener('submit', async (event) => {
  if (!['new-entry-form', 'entry-details-form', 'measurement-form'].includes(event.target.id)) return;
  event.preventDefault();
  await stateReady;
  if (stateLoadError) {
    alertError(stateLoadError, 'Project storage is unavailable. No changes were saved.');
    return;
  }

  if (event.target.id === 'new-entry-form') {
    const survey = activeSurvey();
    const form = new FormData(event.target);
    const name = String(form.get('name') || '').trim();
    if (!survey || !name) {
      window.alert('Enter a name for this inspection entry.');
      return;
    }
    if (survey.entries.some((entry) => entry.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      window.alert('This project already has an entry with that name.');
      return;
    }
    const entry = { id: crypto.randomUUID(), name, notes: '', readings: [], photos: [] };
    const surveys = state.surveys.map((item) => item.id === survey.id
      ? { ...item, entries: [...item.entries, entry] }
      : item);
    if (await commit({ ...state, surveys, activeEntryId: entry.id })) event.target.reset();
    return;
  }

  if (event.target.id === 'entry-details-form') {
    const survey = activeSurvey();
    const entry = activeEntry();
    const form = new FormData(event.target);
    const name = String(form.get('name') || '').trim();
    if (!survey || !entry || !name) {
      window.alert('An inspection entry name is required.');
      return;
    }
    if (survey.entries.some((item) => item.id !== entry.id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      window.alert('This project already has an entry with that name.');
      return;
    }
    const updatedEntry = { ...entry, name, notes: String(form.get('notes') || '').trim() };
    const surveys = state.surveys.map((item) => item.id === survey.id
      ? { ...item, entries: item.entries.map((child) => child.id === entry.id ? updatedEntry : child) }
      : item);
    await commit({ ...state, surveys });
    return;
  }

  const survey = activeSurvey();
  const entry = activeEntry();
  const form = new FormData(event.target);
  const lux = Number(form.get('lux'));
  const targetRaw = String(form.get('target') || '').trim();
  const target = targetRaw === '' ? null : Number(targetRaw);
  if (!survey || !entry || !Number.isFinite(lux) || lux < 0 || (target !== null && (!Number.isFinite(target) || target < 0))) {
    window.alert('Choose an entry and enter valid non-negative lux values.');
    return;
  }
  const luxInput = event.target.elements.lux;
  const fromSensor = luxInput.dataset.source === 'sensor'
    && Number(luxInput.dataset.sensorLux) === lux
    && Number.isFinite(Number(luxInput.dataset.sensorLux));
  const reading = {
    id: crypto.randomUUID(),
    lux,
    target,
    note: String(form.get('note') || '').trim(),
    source: fromSensor ? 'sensor' : 'manual',
    rawLux: fromSensor ? Number(luxInput.dataset.rawLux) : null,
    calibrationFactor: fromSensor ? Number(luxInput.dataset.calibrationFactor) : null,
    createdAt: fromSensor ? luxInput.dataset.sensorTime : new Date().toISOString()
  };
  const surveys = state.surveys.map((item) => item.id === survey.id
    ? { ...item, entries: item.entries.map((child) => child.id === entry.id
      ? { ...child, readings: [...child.readings, reading] }
      : child) }
    : item);
  if (await commit({ ...state, surveys })) event.target.reset();
});

document.querySelector('#manual-lux').addEventListener('input', (event) => {
  event.currentTarget.dataset.source = 'manual';
  event.currentTarget.dataset.sensorLux = '';
  event.currentTarget.dataset.sensorTime = '';
  document.querySelector('#reading-source').textContent = 'Manual entry (not a phone sensor reading)';
});

photoForm.addEventListener('change', (event) => {
  if (event.target.name === 'readingId') {
    photoForm.elements.annotate.checked = Boolean(event.target.value);
  }
});

photoForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const entry = activeEntry();
  if (!entry) {
    window.alert('Select an inspection entry before taking a photo.');
    return;
  }
  pendingPhoto = {
    surveyId: activeSurvey().id,
    entryId: entry.id,
    readingId: String(photoForm.elements.readingId.value || ''),
    annotate: photoForm.elements.annotate.checked
  };
  photoDialog.close();
  photoInput.click();
});

photoInput.addEventListener('change', async () => {
  const selection = pendingPhoto;
  const file = photoInput.files?.[0];
  if (!selection || !file) {
    photoInput.value = '';
    pendingPhoto = null;
    return;
  }
  try {
    if (!file.type.startsWith('image/')) throw new Error('The selected file is not an image.');
    const originalData = await fileToDataUrl(file);
    const survey = state.surveys.find((item) => item.id === selection.surveyId);
    const entry = survey?.entries.find((item) => item.id === selection.entryId);
    const reading = entry?.readings.find((item) => item.id === selection.readingId && item.source === 'sensor') || null;
    if (!survey || !entry) throw new Error('The selected project entry is no longer available.');
    const createdAt = new Date().toISOString();
    const saved = await savePhotoForEntry(survey.id, entry.id, originalData, {
      reading,
      createdAt,
      annotate: selection.annotate
    });
    if (saved) window.alert('Photo saved to the selected inspection entry.');
  } catch (error) {
    alertError(error, 'Could not save the photo. The original photograph was not changed.');
  } finally {
    pendingPhoto = null;
    photoInput.value = '';
  }
});

previewDialog.addEventListener('click', (event) => {
  const button = event.target.closest('[data-preview-mode]');
  if (!button || !previewPhoto) return;
  const original = button.dataset.previewMode === 'original';
  document.querySelector('#photo-preview-image').src = original
    ? previewPhoto.originalData
    : previewPhoto.annotatedData || previewPhoto.originalData;
  document.querySelector('#photo-preview-caption').textContent = original
    ? `Original photograph · ${formatDateTime(previewPhoto.createdAt)}`
    : `Annotated photograph · ${formatDateTime(previewPhoto.createdAt)}${previewPhoto.readingLux === null ? '' : ` · ${formatLux(previewPhoto.readingLux)} lx recorded`}`;
});

history.replaceState({ view: 'home' }, '');
stateReady = loadState().catch((error) => {
  stateLoadError = error;
  workspace.innerHTML = '<div class="empty-state"><h2>Survey storage is unavailable.</h2><p>Your stored project data was not changed. Check device storage permissions and reopen the app.</p></div>';
  alertError(error, 'Could not load saved survey data.');
});
