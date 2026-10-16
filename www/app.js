import { registerPlugin } from '@capacitor/core';

const LightSensor = registerPlugin('LightSensor');
const storageKey = 'feenstra-light-surveys-v1';
const workspace = document.querySelector('#workspace');
const surveyList = document.querySelector('#survey-list');
const surveyDialog = document.querySelector('#survey-dialog');
const surveyForm = document.querySelector('#survey-form');
const photoInput = document.querySelector('#photo-input');

let state = readState();
let liveLux = null;
let sensorListener = null;
let sensorRunning = false;

function readState() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    return { surveys: Array.isArray(saved.surveys) ? saved.surveys : [], activeId: saved.activeId || null };
  } catch {
    return { surveys: [], activeId: null };
  }
}

function persist() {
  localStorage.setItem(storageKey, JSON.stringify(state));
  render();
}

function activeSurvey() {
  return state.surveys.find((survey) => survey.id === state.activeId) || null;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function formatDate(value) {
  if (!value) return 'Date not set';
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(`${value}T12:00:00`));
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
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
        <p>Create a survey, capture illuminance readings and site photos, then export a shareable report from the field.</p>
        <button class="button primary" type="button" data-action="new">Start a survey <span aria-hidden="true">→</span></button>
      </div>`;
    return;
  }

  const readings = [...survey.readings].reverse();
  const photos = [...survey.photos].reverse();
  workspace.innerHTML = `
    <div class="survey-view">
      <div class="survey-topline">
        <div class="survey-title">
          <p class="eyebrow">LIGHTING SURVEY / ${escapeHtml(formatDate(survey.date).toUpperCase())}</p>
          <h2>${escapeHtml(survey.site)}</h2>
          <p class="survey-meta">${survey.client ? `${escapeHtml(survey.client)} · ` : ''}Created ${escapeHtml(formatDate(survey.date))}</p>
        </div>
        <div class="top-actions">
          <button class="button secondary" type="button" data-action="photo">Add photos</button>
          <button class="button dark" type="button" data-action="export">Export OHS report <span aria-hidden="true">↗</span></button>
        </div>
      </div>

      <p class="section-label">MEASUREMENT</p>
      <div class="capture-grid">
        <section class="meter-panel" aria-label="Live light sensor">
          <div class="meter-kicker"><span>ILLUMINANCE</span><span class="sensor-state ${sensorRunning ? 'live' : ''}" id="sensor-state">${sensorRunning ? 'Live sensor' : 'Sensor off'}</span></div>
          <div class="lux-display"><strong id="lux-value">${liveLux === null ? '--' : escapeHtml(Math.round(liveLux))}</strong><span>lux</span></div>
          <p class="sensor-caption" id="sensor-caption">${liveLux === null ? 'Start the phone sensor or enter a reading manually.' : 'Current ambient light level'}</p>
          <div class="meter-actions">
            <button class="button primary" type="button" data-action="sensor">${sensorRunning ? 'Stop sensor' : 'Start sensor'}</button>
            <button class="button secondary" type="button" data-action="use-live" ${liveLux === null ? 'disabled' : ''}>Use live reading</button>
          </div>
        </section>
        <section class="entry-panel">
          <h3>Record a point</h3>
          <p>Set the work area and optional reference illuminance.</p>
          <form class="measurement-form" id="measurement-form">
            <div class="field"><label for="area">Work area</label><input id="area" name="area" maxlength="80" placeholder="e.g. Assembly bench" required /></div>
            <div class="field"><label for="target">Target lux <span>(optional)</span></label><input id="target" name="target" type="number" min="0" step="1" inputmode="numeric" placeholder="Set by assessor" /></div>
            <div class="field"><label for="manual-lux">Measured lux</label><input id="manual-lux" name="lux" type="number" min="0" step="1" inputmode="decimal" placeholder="${liveLux === null ? 'Enter value' : Math.round(liveLux)}" required /></div>
            <div class="field"><label for="reading-note">Note <span>(optional)</span></label><input id="reading-note" name="note" maxlength="120" placeholder="Conditions or task" /></div>
            <button class="button primary record-button" type="submit">Save measurement <span aria-hidden="true">→</span></button>
          </form>
        </section>
      </div>

      <div class="list-heading section-label"><h3>READINGS</h3><span class="count">${readings.length} ${readings.length === 1 ? 'point' : 'points'}</span></div>
      <div class="reading-list">
        <div class="reading-row header"><span>WORK AREA</span><span>MEASURED</span><span>TARGET</span><span>ASSESSMENT</span></div>
        ${readings.length ? readings.map(readingRow).join('') : '<p class="empty-list">No readings yet. Capture a point to start the record.</p>'}
      </div>

      <div class="photo-heading section-label"><h3>SITE PHOTOS</h3><button class="button subtle" type="button" data-action="photo">Add photos</button></div>
      ${photos.length ? `<div class="photo-strip">${photos.map((photo) => `<div class="photo-tile"><img src="${photo.data}" alt="Site photo" /><span>${escapeHtml(formatTime(photo.createdAt))}</span></div>`).join('')}</div>` : '<p class="photo-empty">No photos attached to this survey.</p>'}
      <p class="workspace-footer">Stored locally on this device. Exported reports include only the information recorded here.</p>
    </div>`;
}

function readingRow(reading) {
  const target = Number.isFinite(reading.target) ? reading.target : null;
  const status = target === null ? 'No target' : reading.lux >= target ? 'Meets target' : 'Below target';
  const statusClass = target === null ? 'unset' : reading.lux >= target ? '' : 'below';
  return `<div class="reading-row"><span class="reading-area" title="${escapeHtml(reading.area)}">${escapeHtml(reading.area)}</span><span class="reading-lux">${escapeHtml(reading.lux)} lx</span><span class="reading-target">${target === null ? '—' : `${escapeHtml(target)} lx`}</span><span class="reading-status ${statusClass}">${status}</span></div>`;
}

function renderSurveyList() {
  surveyList.innerHTML = state.surveys.map((survey) => `
    <button type="button" class="survey-item ${survey.id === state.activeId ? 'active' : ''}" data-survey="${escapeHtml(survey.id)}">
      <strong>${escapeHtml(survey.site)}</strong><span>${escapeHtml(formatDate(survey.date))} · ${survey.readings.length} readings</span>
    </button>`).join('');
}

function openSurveyDialog() {
  surveyForm.reset();
  surveyForm.elements.date.value = new Date().toISOString().slice(0, 10);
  surveyDialog.showModal();
}

async function startSensor() {
  try {
    await LightSensor.start();
    sensorListener = await LightSensor.addListener('reading', ({ lux }) => {
      if (Number.isFinite(Number(lux))) {
        liveLux = Number(lux);
        const value = document.querySelector('#lux-value');
        const caption = document.querySelector('#sensor-caption');
        const useButton = document.querySelector('[data-action="use-live"]');
        if (value) value.textContent = String(Math.round(liveLux));
        if (caption) caption.textContent = 'Current ambient light level';
        if (useButton) useButton.disabled = false;
      }
    });
    sensorRunning = true;
    render();
  } catch (error) {
    sensorRunning = false;
    render();
    alert(error?.message || 'The light sensor is unavailable on this device. Enter a measured value manually.');
  }
}

async function stopSensor() {
  try {
    await LightSensor.stop();
    await sensorListener?.remove();
  } catch { /* Sensor may already have stopped with the activity. */ }
  sensorListener = null;
  sensorRunning = false;
  render();
}

function exportReport(survey) {
  const rows = survey.readings.map((reading) => {
    const target = Number.isFinite(reading.target) ? reading.target : null;
    const assessment = target === null ? 'No target specified' : reading.lux >= target ? 'Meets target' : 'Below target';
    return `<tr><td>${escapeHtml(reading.area)}</td><td>${escapeHtml(reading.lux)} lux</td><td>${target === null ? '—' : `${escapeHtml(target)} lux`}</td><td>${assessment}</td><td>${escapeHtml(new Date(reading.createdAt).toLocaleString())}</td><td>${escapeHtml(reading.note || '')}</td></tr>`;
  }).join('');
  const photos = survey.photos.map((photo) => `<figure><img src="${photo.data}" alt="Lighting survey site photo"><figcaption>Captured ${escapeHtml(new Date(photo.createdAt).toLocaleString())}</figcaption></figure>`).join('');
  const report = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OHS Lighting Report - ${escapeHtml(survey.site)}</title><style>
    *{box-sizing:border-box}body{max-width:1000px;margin:36px auto;padding:0 24px;color:#192c28;font:14px/1.5 Arial,sans-serif}header{display:flex;justify-content:space-between;align-items:start;border-bottom:3px solid #355449;padding-bottom:20px}h1{font-size:27px;margin:0 0 6px}h2{font-size:16px;margin:28px 0 10px}.kicker{font-size:10px;letter-spacing:1.4px;font-weight:bold;color:#5e6e64}.meta{color:#53645b;margin:4px 0}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:20px 0}.summary div{padding:13px;border:1px solid #dce2d8;background:#f7f9f4}.summary strong{display:block;font-size:20px}.summary span{font-size:11px;color:#53645b}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:9px;border-bottom:1px solid #dce2d8;vertical-align:top}th{background:#edf1e8;font-size:10px;text-transform:uppercase}figure{display:inline-block;width:30%;margin:0 2% 16px 0;vertical-align:top}figure img{width:100%;max-height:230px;object-fit:cover}figcaption,.disclaimer{color:#53645b;font-size:11px}.disclaimer{margin-top:30px;padding-top:12px;border-top:1px solid #dce2d8}@media print{body{margin:12mm auto;padding:0}.no-print{display:none}tr{break-inside:avoid}figure{break-inside:avoid}}@media(max-width:600px){.summary{grid-template-columns:1fr 1fr}table{font-size:10px}th,td{padding:6px}figure{width:47%}}
    </style></head><body><header><div><p class="kicker">FEENSTRA LIGHT SURVEYS / OHS RECORD</p><h1>Lighting Survey Report</h1><p class="meta"><strong>Site:</strong> ${escapeHtml(survey.site)}</p><p class="meta"><strong>Client:</strong> ${escapeHtml(survey.client || 'Not specified')}</p><p class="meta"><strong>Survey date:</strong> ${escapeHtml(formatDate(survey.date))}</p></div><button class="no-print" onclick="window.print()">Print / Save as PDF</button></header><section class="summary"><div><strong>${survey.readings.length}</strong><span>Measurement points</span></div><div><strong>${survey.photos.length}</strong><span>Site photos</span></div><div><strong>${survey.readings.length ? Math.round(survey.readings.reduce((sum, reading) => sum + reading.lux, 0) / survey.readings.length) : '—'}</strong><span>Average measured lux</span></div></section><h2>Illuminance measurements</h2><table><thead><tr><th>Work area</th><th>Measured</th><th>Target</th><th>Assessment</th><th>Recorded</th><th>Notes</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No measurements recorded.</td></tr>'}</tbody></table><h2>Site photos</h2>${photos || '<p>No site photos attached.</p>'}<p class="disclaimer">Targets are entered by the assessor and are not pre-populated. This record reports observed readings and user-entered targets; confirm applicable workplace lighting requirements for the relevant jurisdiction and task.</p></body></html>`;
  const blob = new Blob([report], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `OHS-Lighting-Report-${survey.site.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'survey'}.html`;
  link.click();
  URL.revokeObjectURL(url);
}

async function readPhoto(file) {
  const image = await createImageBitmap(file);
  const scale = Math.min(1, 1400 / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();
  return canvas.toDataURL('image/jpeg', 0.78);
}

workspace.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const survey = activeSurvey();
  switch (button.dataset.action) {
    case 'new': openSurveyDialog(); break;
    case 'photo': photoInput.click(); break;
    case 'export': if (survey) exportReport(survey); break;
    case 'sensor': sensorRunning ? await stopSensor() : await startSensor(); break;
    case 'use-live': {
      const input = document.querySelector('#manual-lux');
      if (input && liveLux !== null) input.value = Math.round(liveLux);
      break;
    }
  }
});

surveyList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-survey]');
  if (!button) return;
  if (sensorRunning) stopSensor();
  state.activeId = button.dataset.survey;
  persist();
});

document.querySelector('#new-survey').addEventListener('click', openSurveyDialog);
document.querySelector('#close-dialog').addEventListener('click', () => surveyDialog.close());
document.querySelector('#cancel-survey').addEventListener('click', () => surveyDialog.close());

surveyForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = new FormData(surveyForm);
  const survey = {
    id: crypto.randomUUID(),
    site: String(form.get('site')).trim(),
    client: String(form.get('client') || '').trim(),
    date: String(form.get('date')),
    readings: [],
    photos: []
  };
  state.surveys.unshift(survey);
  state.activeId = survey.id;
  surveyDialog.close();
  persist();
});

workspace.addEventListener('submit', (event) => {
  if (event.target.id !== 'measurement-form') return;
  event.preventDefault();
  const survey = activeSurvey();
  const form = new FormData(event.target);
  const lux = Number(form.get('lux'));
  const targetRaw = String(form.get('target') || '').trim();
  if (!survey || !Number.isFinite(lux) || lux < 0) return;
  survey.readings.push({
    area: String(form.get('area')).trim(),
    lux: Math.round(lux * 10) / 10,
    target: targetRaw === '' ? null : Number(targetRaw),
    note: String(form.get('note') || '').trim(),
    createdAt: new Date().toISOString()
  });
  persist();
});

photoInput.addEventListener('change', async () => {
  const survey = activeSurvey();
  if (!survey || !photoInput.files?.length) return;
  const files = [...photoInput.files].filter((file) => file.type.startsWith('image/'));
  try {
    for (const file of files) {
      survey.photos.push({ data: await readPhoto(file), createdAt: new Date().toISOString() });
    }
    persist();
  } catch {
    alert('Could not read one of the selected photos. Try a smaller image.');
  } finally {
    photoInput.value = '';
  }
});

render();