import { Capacitor, registerPlugin } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

const LightSensor = registerPlugin('LightSensor');
const storageKey = 'feenstra-light-surveys-v1';
const databaseName = 'feenstra-light-surveys';
const workspace = document.querySelector('#workspace');
const surveyList = document.querySelector('#survey-list');
const surveyDialog = document.querySelector('#survey-dialog');
const surveyForm = document.querySelector('#survey-form');
const photoDialog = document.querySelector('#photo-dialog');
const photoForm = document.querySelector('#photo-form');
const photoInput = document.querySelector('#photo-input');
const previewDialog = document.querySelector('#photo-preview');

let database;
let stateReady;
let stateLoadError = null;
let state = { surveys: [], activeId: null, activeEntryId: null };
let liveLux = null;
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

function databaseRequest(mode, action) {
  return new Promise((resolve, reject) => {
    if (!database) {
      reject(new Error('Local survey storage has not finished initializing.'));
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

function normalizeReading(reading) {
  return {
    ...reading,
    id: reading.id || crypto.randomUUID(),
    lux: Number(reading.lux),
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
    createdAt: photo.createdAt || new Date().toISOString()
  };
}

async function loadState() {
  database = await openDatabase();
  const saved = await databaseRequest('readonly', (store) => store.get('state'));
  if (saved) {
    if (!Array.isArray(saved.surveys)) {
      throw new Error('Saved project data is invalid. Existing local data has been left untouched.');
    }
    state = {
      surveys: saved.surveys.map(normalizeSurvey),
      activeId: saved.activeId || null,
      activeEntryId: saved.activeEntryId || null
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
      activeId: legacy.activeId || null,
      activeEntryId: null
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
    state = nextState;
    render();
    return true;
  } catch (error) {
    state = previous;
    alertError(error, 'Could not save the change. Your existing survey data has not been replaced.');
    render();
    return false;
  }
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

function render() {
  renderSurveyList();
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
  const readingOptions = entry?.readings.map((reading) => `
    <option value="${escapeHtml(reading.id)}">${escapeHtml(formatLux(reading.lux))} lx · ${escapeHtml(formatDateTime(reading.createdAt))}</option>`).join('') || '';
  const readings = entry ? [...entry.readings].reverse() : [];
  const photos = entry ? [...entry.photos].reverse() : [];

  workspace.innerHTML = `
    <div class="survey-view">
      <div class="survey-topline">
        <div class="survey-title">
          <p class="eyebrow">OHS LIGHTING PROJECT / ${escapeHtml(formatDate(survey.inspectionDate).toUpperCase())}</p>
          <h2>${escapeHtml(survey.buildingName || 'Building name required')}</h2>
          <p class="survey-meta">Inspector: ${escapeHtml(survey.inspectorName || 'Required')} · Inspection date: ${escapeHtml(formatDate(survey.inspectionDate))} · ${totalReadings} readings</p>
        </div>
        <div class="top-actions">
          <button class="button secondary" type="button" data-action="project-details">Project details</button>
          <button class="button secondary" type="button" data-action="photo" ${entry ? '' : 'disabled'}>Add photo</button>
          <button class="button dark" type="button" data-action="export">Export OHS report <span aria-hidden="true">↗</span></button>
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
          <div class="lux-display"><strong id="lux-value">${liveLux === null ? '--' : escapeHtml(formatLux(liveLux))}</strong><span>lx</span></div>
          <p class="sensor-caption" id="sensor-caption">${liveLux === null ? 'No live reading. Start the phone sensor to measure illuminance.' : `Actual phone sensor reading · ${escapeHtml(formatDateTime(liveLuxAt))}`}</p>
          <div class="meter-actions">
            <button class="button primary" type="button" data-action="sensor">${sensorRunning ? 'Stop sensor' : 'Start sensor'}</button>
            <button class="button secondary" type="button" data-action="use-live" ${liveLux === null || !entry ? 'disabled' : ''}>Use live reading</button>
          </div>
        </section>
        <section class="entry-panel">
          <h3>Record a measurement</h3>
          <p>${entry ? `Reading will be saved to ${escapeHtml(entry.name)}.` : 'Add an inspection entry before recording a measurement.'}</p>
          <form class="measurement-form" id="measurement-form">
            <div class="field"><label for="target">Target lux <span>(optional)</span></label><input id="target" name="target" type="number" min="0" step="any" inputmode="decimal" placeholder="Set by assessor" /></div>
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
    <span><strong class="reading-lux">${escapeHtml(formatLux(reading.lux))} lx</strong><small>${reading.source === 'sensor' ? 'Phone light sensor' : 'Manual entry'}</small></span>
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
  liveLuxAt = null;
  try {
    sensorListener = await LightSensor.addListener('reading', ({ lux }) => {
      const value = Number(lux);
      if (!Number.isFinite(value) || value < 0) return;
      liveLux = value;
      liveLuxAt = new Date().toISOString();
      const display = document.querySelector('#lux-value');
      const caption = document.querySelector('#sensor-caption');
      const useButton = document.querySelector('[data-action="use-live"]');
      if (display) display.textContent = formatLux(liveLux);
      if (caption) caption.textContent = `Actual phone sensor reading · ${formatDateTime(liveLuxAt)}`;
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
      reading
        ? `Lux: ${formatLux(reading.lux)} lx  (${reading.source === 'sensor' ? 'phone light sensor' : 'manual entry'}) · Measured ${formatDateTime(reading.createdAt)}`
        : 'Lux: not recorded for this photo'
    ];
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
        <td>${escapeHtml(formatLux(reading.lux))} lx<br><small>${reading.source === 'sensor' ? 'Phone light sensor' : 'Manual entry'}</small></td>
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
    <p class="disclaimer">Targets are entered by the assessor and are not pre-populated. Sensor readings are captured from the device ambient light sensor; manual values are identified separately. This record reports observed readings and user-entered targets; confirm applicable workplace lighting requirements for the relevant jurisdiction and task.</p></body></html>`;
}

function safeFileName(value) {
  return value.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'survey';
}

function encodeBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

async function exportReport(survey) {
  if (!survey.buildingName.trim() || !survey.inspectorName.trim() || !survey.inspectionDate) {
    window.alert('Building Name, Inspector Name, and inspection date are required before exporting this report.');
    openSurveyDialog(survey);
    return;
  }
  const report = buildReport(survey);
  const filename = `OHS-Lighting-Report-${safeFileName(survey.buildingName)}.html`;
  try {
    if (Capacitor.isNativePlatform()) {
      const saved = await Filesystem.writeFile({
        path: filename,
        data: encodeBase64(report),
        directory: Directory.Documents,
        recursive: true
      });
      await Share.share({
        title: 'OHS Lighting Survey Report',
        text: `Lighting survey report for ${survey.buildingName}`,
        url: saved.uri,
        dialogTitle: 'Export OHS lighting report'
      });
      return;
    }
    const url = URL.createObjectURL(new Blob([report], { type: 'text/html;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    alertError(error, 'Could not export the OHS report.');
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
  switch (button.dataset.action) {
    case 'new':
      openSurveyDialog();
      break;
    case 'project-details':
      if (survey) openSurveyDialog(survey);
      break;
    case 'photo':
      openPhotoDialog();
      break;
    case 'export':
      if (survey) await exportReport(survey);
      break;
    case 'sensor':
      if (sensorRunning) await stopSensor();
      else await startSensor();
      break;
    case 'use-live': {
      const input = document.querySelector('#manual-lux');
      if (input && liveLux !== null && liveLuxAt) {
        input.value = String(liveLux);
        input.dataset.source = 'sensor';
        input.dataset.sensorLux = String(liveLux);
        input.dataset.sensorTime = liveLuxAt;
        document.querySelector('#reading-source').textContent = `Phone light sensor · ${formatDateTime(liveLuxAt)}`;
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
  await commit({ ...state, activeId: button.dataset.survey, activeEntryId: survey?.entries[0]?.id || null });
});

document.querySelector('#new-survey').addEventListener('click', () => openSurveyDialog());
document.querySelector('#close-dialog').addEventListener('click', () => surveyDialog.close());
document.querySelector('#cancel-survey').addEventListener('click', () => surveyDialog.close());
document.querySelector('#close-photo-dialog').addEventListener('click', () => photoDialog.close());
document.querySelector('#cancel-photo').addEventListener('click', () => photoDialog.close());
document.querySelector('#close-photo-preview').addEventListener('click', () => previewDialog.close());

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
      entries: []
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
  const survey = state.surveys.find((item) => item.id === pendingPhoto?.surveyId);
  const entry = survey?.entries.find((item) => item.id === pendingPhoto?.entryId);
  const file = photoInput.files?.[0];
  if (!survey || !entry || !file) {
    photoInput.value = '';
    pendingPhoto = null;
    return;
  }
  try {
    if (!file.type.startsWith('image/')) throw new Error('The selected file is not an image.');
    const originalData = await fileToDataUrl(file);
    const reading = entry.readings.find((item) => item.id === pendingPhoto?.readingId && item.source === 'sensor') || null;
    const createdAt = new Date().toISOString();
    const photo = {
      id: crypto.randomUUID(),
      entryName: entry.name,
      originalData,
      annotatedData: pendingPhoto?.annotate
        ? await createAnnotatedPhoto(originalData, survey, entry, reading, createdAt)
        : null,
      readingId: reading?.id || null,
      readingLux: reading ? Number(reading.lux) : null,
      readingSource: reading?.source || null,
      createdAt
    };
    const surveys = state.surveys.map((item) => item.id === survey.id
      ? { ...item, entries: item.entries.map((child) => child.id === entry.id
        ? { ...child, photos: [...child.photos, photo] }
        : child) }
      : item);
    await commit({ ...state, surveys });
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

stateReady = loadState().catch((error) => {
  stateLoadError = error;
  workspace.innerHTML = '<div class="empty-state"><h2>Survey storage is unavailable.</h2><p>Your stored project data was not changed. Check device storage permissions and reopen the app.</p></div>';
  alertError(error, 'Could not load saved survey data.');
});
