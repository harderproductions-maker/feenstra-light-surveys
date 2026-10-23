import { Capacitor, registerPlugin } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import readXlsxFile from 'read-excel-file/browser';
import checkCatalog from './building-check-templates.json';

const LightSensor = registerPlugin('LightSensor');
const CameraCapture = registerPlugin('CameraCapture');
const PdfReport = registerPlugin('PdfReport');
const storageKey = 'feenstra-light-surveys-v1';
const databaseName = 'feenstra-light-surveys';
const ocrAssetPath = new URL('assets/tesseract/', document.baseURI).href;
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
const themeStorageKey = 'feenstra-light-surveys-theme';
const authTokenKey = 'feenstra-light-surveys-token';
const cachedUserKey = 'feenstra-light-surveys-user';

let database;
let stateReady;
let stateLoadError = null;
let state = {
  surveys: [],
  buildingChecks: [],
  properties: checkCatalog.properties,
  activeId: null,
  activeEntryId: null,
  sensorCalibration: initialCalibration
};
let currentView = 'home';
const userManagementSection = document.querySelector('#user-management');
let activeCheckProjectId = null;
let activeCheckId = null;
let activeCheckFilter = null;
let activePropertyId = null;
let activeTemplateId = null;
let liveLux = null;
let liveCalibratedLux = null;
let liveLuxAt = null;
let sensorListener = null;
let sensorRunning = false;
let editingSurveyId = null;
let pendingPhoto = null;
let previewPhoto = null;
let reportPhotoSources = [];
let authToken = '';
let currentUser = null;
let workspaceRevision = null;
let offlineMode = false;
let syncInProgress = false;
let stateVersion = 0;

function preferredTheme() {
  try {
    const saved = localStorage.getItem(themeStorageKey);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Continue with the browser preference when local storage is unavailable.
  }
  return 'dark';
}

function applyTheme(theme, persist = true) {
  const selected = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = selected;
  document.querySelector('meta[name="theme-color"]').content = selected === 'dark' ? '#070618' : '#f1f3ec';
  const button = document.querySelector('#theme-toggle');
  if (button) {
    const next = selected === 'dark' ? 'light' : 'dark';
    button.setAttribute('aria-label', `Switch to ${next} mode`);
    button.title = `Switch to ${next} mode`;
    button.setAttribute('aria-pressed', String(selected === 'dark'));
    button.querySelector('[data-theme-icon]').textContent = selected === 'dark' ? '☀' : '☾';
    button.querySelector('[data-theme-label]').textContent = `${next === 'dark' ? 'Dark' : 'Light'} mode`;
  }
  if (persist) {
    try {
      localStorage.setItem(themeStorageKey, selected);
    } catch {
      // The selected theme remains active for this page session.
    }
  }
}

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

function apiUrl(path) {
  const base = String(window.APP_CONFIG?.apiBaseUrl || import.meta.env.VITE_API_BASE_URL || window.location.origin).replace(/\/+$/, '');
  return `${base}${path}`;
}

async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (authToken && options.auth !== false) headers.set('Authorization', `Bearer ${authToken}`);
  const response = await fetch(apiUrl(path), {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal || AbortSignal.timeout(12000)
  });
  let result = {};
  try { result = await response.json(); } catch { /* Keep a generic API error for non-JSON responses. */ }
  if (!response.ok) {
    const error = new Error(result.error || `The backend returned ${response.status}.`);
    error.status = response.status;
    error.payload = result;
    throw error;
  }
  return result;
}

function setSyncStatus(label, message, stateName = '') {
  const indicator = document.querySelector('#sync-status');
  if (!indicator) return;
  indicator.innerHTML = `<span></span> ${escapeHtml(label)}`;
  indicator.title = message;
  indicator.dataset.syncState = stateName;
  indicator.setAttribute('aria-label', message);
}

async function readSyncMetadata() {
  return databaseRequest('readonly', (store) => store.get('sync-meta'));
}

async function writeSyncMetadata(metadata) {
  return databaseRequest('readwrite', (store) => store.put(metadata, 'sync-meta'));
}

function scopeStateToUser(source, user) {
  const allowed = new Set(user.role === 'admin' ? source.properties.map((property) => property.id) : user.propertyIds || []);
  const propertyByName = new Map(source.properties.map((property) => [property.name.trim().toLocaleLowerCase(), property.id]));
  const scopedPropertyId = (record) => record.propertyId || propertyByName.get(String(record.buildingName || '').trim().toLocaleLowerCase());
  return {
    ...source,
    properties: source.properties.filter((property) => allowed.has(property.id)),
    surveys: source.surveys.filter((survey) => allowed.has(scopedPropertyId(survey)))
      .map((survey) => ({ ...survey, propertyId: scopedPropertyId(survey) })),
    buildingChecks: source.buildingChecks.filter((project) => allowed.has(scopedPropertyId(project)))
      .map((project) => ({ ...project, propertyId: scopedPropertyId(project) }))
  };
}

function showSignedIn(user) {
  currentUser = user;
  document.querySelector('#auth-screen').hidden = true;
  document.querySelector('#app-shell').hidden = false;
  document.querySelector('#account-summary').textContent = `${user.name} · ${user.email} · ${user.role === 'admin' ? 'Administrator' : 'Building access'}`;
  document.querySelector('#users-nav').hidden = user.role !== 'admin';
  render();
}

function showSignIn(message = '') {
  document.querySelector('#app-shell').hidden = true;
  document.querySelector('#auth-screen').hidden = false;
  const error = document.querySelector('#login-error');
  error.textContent = message;
  error.hidden = !message;
}

document.addEventListener('click', (event) => {
  const toggle = event.target.closest('[data-toggle-buildings]');
  if (!toggle) return;
  const boxes = [...toggle.closest('.building-picker').querySelectorAll('input[type="checkbox"]')];
  const selectAll = boxes.some((box) => !box.checked);
  for (const box of boxes) box.checked = selectAll;
  toggle.textContent = selectAll ? 'Clear all' : 'Select all';
});

function applyUserFilter() {
  const query = String(document.querySelector('#user-search')?.value || '').trim().toLowerCase();
  const filter = document.querySelector('#user-filter')?.value || 'active';
  let shown = 0;
  const items = [...document.querySelectorAll('#user-list > li')];
  for (const item of items) {
    const matches = (!query || item.dataset.search.includes(query))
      && (filter === 'all' || (filter === 'active') === (item.dataset.active === 'true'));
    item.hidden = !matches;
    if (matches) shown += 1;
  }
  const count = document.querySelector('#user-count');
  if (count) count.textContent = `Showing ${shown} of ${items.length} users`;
}

async function loadUserManagement() {
  const status = document.querySelector('#user-management-status');
  const userList = document.querySelector('#user-list');
  try {
    const [{ users }, { properties }] = await Promise.all([
      apiRequest('/api/users'),
      apiRequest('/api/properties')
    ]);
    const buildingPicker = (selectedIds, disabled) => `<fieldset class="building-picker" ${disabled ? 'disabled' : ''}>
      <legend>Allowed buildings</legend>
      <button class="button secondary building-picker-toggle" type="button" data-toggle-buildings>Select all</button>
      <div class="building-picker-list">${properties.map((property) => `<label class="check-label"><input type="checkbox" name="propertyIds" value="${escapeHtml(property.id)}" ${selectedIds.includes(property.id) ? 'checked' : ''} /> ${escapeHtml(property.name)}</label>`).join('')}</div>
    </fieldset>`;
    document.querySelector('#create-user-picker').innerHTML = buildingPicker([], false);
    const propertyNames = new Map(properties.map((property) => [property.id, property.name]));
    userList.innerHTML = users.map((user) => {
      const buildingNames = user.role === 'admin' ? ['All buildings'] : (user.property_ids || []).map((id) => propertyNames.get(id) || id);
      const searchText = [user.name, user.email, ...buildingNames].join(' ').toLowerCase();
      return `
      <li data-search="${escapeHtml(searchText)}" data-active="${user.active ? 'true' : 'false'}">
        <details class="managed-user">
          <summary>
            <span class="managed-user-name"><strong>${escapeHtml(user.name)}</strong> <span>${escapeHtml(user.email)}</span></span>
            <span class="managed-user-meta">${user.role === 'admin' ? 'Administrator' : `${buildingNames.length} building${buildingNames.length === 1 ? '' : 's'}`} · ${user.active ? 'Active' : 'Inactive'}</span>
          </summary>
          <form class="managed-user-form" data-user-id="${escapeHtml(user.id)}">
            <div class="managed-user-heading"><span>${escapeHtml(buildingNames.join(', ') || 'No buildings assigned')}</span></div>
            <label>Name<input name="name" maxlength="100" value="${escapeHtml(user.name)}" required ${user.role === 'admin' ? 'disabled' : ''} /></label>
            <label>Username<input name="email" type="text" value="${escapeHtml(user.email)}" required ${user.role === 'admin' ? 'disabled' : ''} /></label>
            ${buildingPicker(user.property_ids || [], user.role === 'admin')}
            <label>Set new password<input name="password" type="password" minlength="4" autocomplete="new-password" ${user.role === 'admin' ? 'disabled' : ''} /></label>
            <label class="check-label"><input type="checkbox" name="active" ${user.active ? 'checked' : ''} ${user.role === 'admin' ? 'disabled' : ''} /> Account active</label>
            ${user.role === 'admin' ? '' : '<button class="button secondary" type="submit">Save account</button>'}
          </form>
        </details>
      </li>`;
    }).join('');
    applyUserFilter();
    status.textContent = '';
  } catch (error) {
    status.textContent = error.message || 'Could not load user accounts.';
  }
}

async function syncWorkspace(force = false) {
  if (!authToken || !currentUser || offlineMode || syncInProgress) return false;
  const metadata = await readSyncMetadata();
  if (!metadata?.dirty && !force) {
    setSyncStatus('SYNCED', 'All changes are saved to the shared workspace.', 'synced');
    return true;
  }
  syncInProgress = true;
  const submittedVersion = stateVersion;
  const snapshot = JSON.parse(JSON.stringify(state));
  let syncAgain = false;
  setSyncStatus('SYNCING', 'Saving changes to the shared workspace.', 'syncing');
  try {
    const result = await apiRequest('/api/workspace', {
      method: 'PUT',
      headers: { 'If-Match': String(workspaceRevision ?? metadata?.revision ?? 0) },
      body: { data: snapshot }
    });
    workspaceRevision = result.revision;
    syncAgain = stateVersion !== submittedVersion;
    await writeSyncMetadata({ userId: currentUser.id, revision: workspaceRevision, dirty: syncAgain });
    setSyncStatus(syncAgain ? 'SYNCING' : 'SYNCED', syncAgain ? 'Saving newer local changes.' : 'All changes are saved to the shared workspace.', syncAgain ? 'syncing' : 'synced');
  } catch (error) {
    if (error.status === 409) {
      workspaceRevision = error.payload.revision;
      await writeSyncMetadata({ userId: currentUser.id, revision: metadata?.revision ?? null, dirty: true });
      setSyncStatus('CONFLICT', 'The shared workspace changed elsewhere. Select to review before replacing its version.', 'conflict');
    } else {
      await writeSyncMetadata({ userId: currentUser.id, revision: workspaceRevision ?? metadata?.revision ?? null, dirty: true });
      setSyncStatus('OFFLINE', 'Your changes are saved on this device and will sync when the backend is reachable.', 'offline');
    }
    return false;
  } finally {
    syncInProgress = false;
  }
  if (syncAgain) return syncWorkspace();
  return true;
}

async function resolveSyncConflict() {
  if (document.querySelector('#sync-status').dataset.syncState !== 'conflict') return;
  if (!window.confirm('The server has newer changes for one or more of your buildings. Replace those buildings with this device’s saved copy? Other buildings will remain unchanged.')) return;
  try {
    const remote = await apiRequest('/api/workspace');
    workspaceRevision = remote.revision;
    await syncWorkspace(true);
  } catch (error) {
    setSyncStatus('OFFLINE', 'Could not reach the backend. Your local changes remain saved.', 'offline');
  }
}

function normalizedWorkspace(data) {
  const properties = normalizeProperties(data.properties);
  return {
    surveys: (data.surveys || []).map(normalizeSurvey),
    buildingChecks: attachProjectsToProperties(
      (data.buildingChecks || []).map(normalizeCheckProject),
      properties
    ),
    properties,
    activeId: data.activeId || null,
    activeEntryId: data.activeEntryId || null,
    sensorCalibration: normalizeCalibration(data.sensorCalibration)
  };
}

function prepareLegacyMigration(source) {
  const byName = new Map(checkCatalog.properties.map((property) => [property.name.trim().toLocaleLowerCase(), property.id]));
  const surveys = source.surveys.map((survey) => {
    const propertyId = survey.propertyId || byName.get(String(survey.buildingName || '').trim().toLocaleLowerCase());
    return propertyId ? { ...survey, propertyId } : null;
  });
  const buildingChecks = source.buildingChecks.map((project) => {
    const propertyId = byName.has(String(project.propertyId || '').toLocaleLowerCase())
      ? project.propertyId
      : byName.get(String(project.buildingName || '').trim().toLocaleLowerCase());
    return propertyId ? { ...project, propertyId } : null;
  });
  if (surveys.includes(null) || buildingChecks.includes(null)) return null;
  return { ...source, surveys, buildingChecks, properties: checkCatalog.properties };
}

async function persistHydratedWorkspace(data, metadata) {
  await databaseRequest('readwrite', (store) => {
    store.put(data, 'state');
    return store.put(metadata, 'sync-meta');
  });
  state = data;
  stateLoadError = null;
}

async function connectUser(user) {
  currentUser = user;
  const remote = await apiRequest('/api/workspace');
  const metadata = await readSyncMetadata();
  const localHasRecords = state.surveys.length > 0 || state.buildingChecks.length > 0;
  const remoteData = normalizedWorkspace(remote.data);
  const remoteHasRecords = remoteData.surveys.length > 0 || remoteData.buildingChecks.length > 0;
  const sameAccount = metadata?.userId === user.id;

  if (sameAccount && metadata.dirty) {
    state = scopeStateToUser(state, user);
    workspaceRevision = metadata.revision;
    if (metadata.revision === remote.revision) {
      await syncWorkspace();
    } else {
      setSyncStatus('CONFLICT', 'This device has unsynced changes and the server has newer data. Select to review before replacing its version.', 'conflict');
    }
    return;
  }

  if (!sameAccount && !remoteHasRecords && localHasRecords && user.role === 'admin') {
    await databaseRequest('readwrite', (store) => store.put(state, 'pre-backend-state'));
    const migration = prepareLegacyMigration(state);
    if (migration && window.confirm(`Import ${migration.surveys.length} lighting project(s) and ${migration.buildingChecks.length} building check(s) from this device into the shared workspace?`)) {
      state = migration;
      workspaceRevision = remote.revision;
      await writeSyncMetadata({ userId: user.id, revision: workspaceRevision, dirty: true });
      await syncWorkspace();
      return;
    }
    if (!migration) {
      state = scopeStateToUser(state, user);
      setSyncStatus('LOCAL ONLY', 'Some saved records do not match a configured building. The original local copy is preserved and was not uploaded.', 'offline');
      return;
    }
  }

  state = scopeStateToUser(remoteData, user);
  workspaceRevision = remote.revision;
  await persistHydratedWorkspace(state, { userId: user.id, revision: remote.revision, dirty: false });
  setSyncStatus('SYNCED', 'All changes are saved to the shared workspace.', 'synced');
}

async function initializeAuthentication() {
  await stateReady;
  authToken = localStorage.getItem(authTokenKey) || '';
  if (!authToken) {
    showSignIn();
    return;
  }
  try {
    const result = await apiRequest('/api/auth/me');
    const user = result.user;
    localStorage.setItem(cachedUserKey, JSON.stringify(user));
    await connectUser(user);
    offlineMode = false;
    showSignedIn(user);
  } catch (error) {
    let cachedUser = null;
    try { cachedUser = JSON.parse(localStorage.getItem(cachedUserKey) || 'null'); } catch { /* Ignore an invalid cached profile. */ }
    if (!error.status && cachedUser?.id) {
      const metadata = await readSyncMetadata();
      if (metadata?.userId === cachedUser.id) {
        currentUser = cachedUser;
        state = scopeStateToUser(state, cachedUser);
        workspaceRevision = metadata.revision;
        offlineMode = true;
        setSyncStatus('OFFLINE', 'The backend is unavailable. This account’s cached buildings remain available on this device.', 'offline');
        showSignedIn(cachedUser);
        return;
      }
    }
    if (error.status === 401) {
      authToken = '';
      localStorage.removeItem(authTokenKey);
      localStorage.removeItem(cachedUserKey);
    }
    showSignIn(error.status === 401 ? 'Your sign-in has expired. Sign in again.' : 'Could not reach the backend. Check the server connection and try again.');
  }
}

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const values = new FormData(form);
  button.disabled = true;
  document.querySelector('#login-error').hidden = true;
  try {
    const result = await apiRequest('/api/auth/login', {
      method: 'POST',
      auth: false,
      body: { email: values.get('email'), password: values.get('password') }
    });
    authToken = result.token;
    localStorage.setItem(authTokenKey, authToken);
    const account = await apiRequest('/api/auth/me');
    localStorage.setItem(cachedUserKey, JSON.stringify(account.user));
    await connectUser(account.user);
    offlineMode = false;
    form.reset();
    showSignedIn(account.user);
  } catch (error) {
    showSignIn(error.message || 'Could not sign in.');
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#account-button').addEventListener('click', async () => {
  document.querySelector('#account-dialog').showModal();
});

document.querySelector('#create-user-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const status = document.querySelector('#user-management-status');
  try {
    await apiRequest('/api/users', {
      method: 'POST',
      body: {
        name: values.get('name'),
        email: values.get('email'),
        password: values.get('password'),
        propertyIds: values.getAll('propertyIds')
      }
    });
    form.reset();
    status.textContent = 'Account created.';
    await loadUserManagement();
  } catch (error) {
    status.textContent = error.message || 'Could not create the account.';
  }
});

document.querySelector('#create-property-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const status = document.querySelector('#property-management-status');
  try {
    const { property } = await apiRequest('/api/properties', {
      method: 'POST',
      body: { name: values.get('name'), city: values.get('city') }
    });
    form.reset();
    const properties = normalizeProperties([...state.properties, property]);
    if (!await commit({ ...state, properties })) return;
    status.textContent = 'Building added.';
    await loadUserManagement();
  } catch (error) {
    status.textContent = error.message || 'Could not add the building.';
  }
});

document.querySelector('#user-search').addEventListener('input', applyUserFilter);
document.querySelector('#user-filter').addEventListener('change', applyUserFilter);

document.querySelector('#user-list').addEventListener('submit', async (event) => {
  if (!event.target.matches('.managed-user-form')) return;
  event.preventDefault();
  const form = event.target;
  const values = new FormData(form);
  const status = document.querySelector('#user-management-status');
  try {
    await apiRequest(`/api/users/${encodeURIComponent(form.dataset.userId)}`, {
      method: 'PUT',
      body: {
        name: values.get('name'),
        email: values.get('email'),
        password: values.get('password'),
        active: values.get('active') === 'on',
        propertyIds: values.getAll('propertyIds')
      }
    });
    status.textContent = 'Account updated.';
    await loadUserManagement();
  } catch (error) {
    status.textContent = error.message || 'Could not update the account.';
  }
});

document.querySelector('#close-account-dialog').addEventListener('click', () => document.querySelector('#account-dialog').close());
document.querySelector('#close-account-dialog-footer').addEventListener('click', () => document.querySelector('#account-dialog').close());

document.querySelector('#signout-button').addEventListener('click', () => {
  authToken = '';
  currentUser = null;
  offlineMode = false;
  localStorage.removeItem(authTokenKey);
  localStorage.removeItem(cachedUserKey);
  showSignIn();
});

document.querySelector('#sync-status').addEventListener('click', resolveSyncConflict);
window.addEventListener('online', () => {
  if (currentUser && authToken) {
    offlineMode = false;
    void syncWorkspace();
  }
});

function normalizeSurvey(survey) {
  if (!survey || typeof survey !== 'object') {
    throw new Error('A saved project record is invalid. Existing local data has been left untouched.');
  }
  const normalized = {
    ...survey,
    id: survey.id || crypto.randomUUID(),
    propertyId: String(survey.propertyId || ''),
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
  const id = project.id || crypto.randomUUID();
  const inspectionDate = String(project.inspectionDate || new Date().toISOString().slice(0, 10));
  return {
    ...project,
    id,
    buildingName: String(project.buildingName || ''),
    inspectorName: String(project.inspectorName || ''),
    inspectionDate,
    monthKey: String(project.monthKey || inspectionDate.slice(0, 7)),
    monthlyTemplateId: String(project.monthlyTemplateId || id),
    lastChangedBy: String(project.lastChangedBy || ''),
    reports: Array.isArray(project.reports) ? project.reports : [],
    checks: (Array.isArray(project.checks) ? project.checks : []).map((check) => ({
      ...check,
      id: check.id || crypto.randomUUID(),
      title: String(check.title || ''),
      location: String(check.location || ''),
      description: String(check.description || ''),
      category: String(check.category || ''),
      reference: String(check.reference || ''),
      status: ['open', 'in-progress', 'repaired', 'verified'].includes(check.status) ? check.status : 'open',
      condition: normalizeCheckCondition(check.condition),
      severity: ['not-assessed', 'low', 'moderate', 'high', 'critical'].includes(check.severity) ? check.severity : 'not-assessed',
      notes: String(check.notes || ''),
      photos: Array.isArray(check.photos) ? check.photos : [],
      history: Array.isArray(check.history) ? check.history : [],
      reports: Array.isArray(check.reports) ? check.reports : []
    }))
  };
}

function normalizeProperties(savedProperties = []) {
  const properties = new Map(checkCatalog.properties.map((property) => [property.id, { ...property }]));
  for (const property of Array.isArray(savedProperties) ? savedProperties : []) {
    if (!property || typeof property !== 'object' || !property.id || !property.name) continue;
    properties.set(property.id, {
      id: String(property.id),
      name: String(property.name),
      city: String(property.city || '')
    });
  }
  return [...properties.values()];
}

function attachProjectsToProperties(projects, properties) {
  const propertyIds = new Set(properties.map((property) => property.id));
  const byName = new Map(properties.map((property) => [property.name.trim().toLocaleLowerCase(), property.id]));
  return projects.map((project) => {
    if (propertyIds.has(project.propertyId)) return project;
    const match = byName.get(project.buildingName.trim().toLocaleLowerCase());
    if (match) return { ...project, propertyId: match };
    const id = `legacy-${project.id}`;
    const property = { id, name: project.buildingName || 'Unassigned property', city: '' };
    properties.push(property);
    propertyIds.add(id);
    byName.set(property.name.trim().toLocaleLowerCase(), id);
    return { ...project, propertyId: id };
  });
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
    const properties = normalizeProperties(saved.properties);
    const projects = attachProjectsToProperties(
      (Array.isArray(saved.buildingChecks) ? saved.buildingChecks : []).map(normalizeCheckProject),
      properties
    );
    state = {
      surveys: saved.surveys.map(normalizeSurvey),
      buildingChecks: projects,
      properties,
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
      properties: normalizeProperties(),
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
    const metadata = await readSyncMetadata();
    await databaseRequest('readwrite', (store) => {
      store.put(nextState, 'state');
      return store.put({
        userId: currentUser?.id || metadata?.userId || null,
        revision: workspaceRevision ?? metadata?.revision ?? null,
        dirty: Boolean(currentUser)
      }, 'sync-meta');
    });
  } catch (error) {
    state = previous;
    alertError(error, 'Could not save the change. Your existing survey data has not been replaced.');
    render();
    return false;
  }
  state = nextState;
  stateVersion += 1;
  try {
    render();
  } catch (error) {
    alertError(error, 'Changes were saved, but the screen could not refresh. Reopen the app to view them.');
  }
  if (currentUser) {
    if (offlineMode) setSyncStatus('OFFLINE', 'Your changes are saved on this device and will sync when the backend is reachable.', 'offline');
    else await syncWorkspace();
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

function formatMonth(value) {
  const dateValue = /^\d{4}-\d{2}$/.test(String(value)) ? `${value}-01` : value;
  const date = new Date(`${dateValue}T12:00:00`);
  return Number.isNaN(date.getTime()) ? 'Month not set' : new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date);
}

function nextMonthDate(value) {
  const [year, month, day] = String(value).split('-').map(Number);
  if (!year || !month || !day) throw new Error('Set a valid inspection date before creating the next monthly checklist.');
  const nextMonth = month;
  const lastDay = new Date(Date.UTC(year, nextMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, nextMonth, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
  if (options.filter !== undefined) activeCheckFilter = options.filter;
  if (options.propertyId !== undefined) activePropertyId = options.propertyId;
  if (options.templateId !== undefined) activeTemplateId = options.templateId;
  if (options.push !== false) history.pushState({
    view,
    projectId: activeCheckProjectId,
    checkId: activeCheckId,
    filter: activeCheckFilter,
    propertyId: activePropertyId,
    templateId: activeTemplateId
  }, '');
  render();
}

function renderHome() {
  const checkCount = state.buildingChecks.reduce((total, project) => total + project.checks.length, 0);
  const openCount = state.buildingChecks.reduce((total, project) =>
    total + project.checks.filter((check) => check.status !== 'verified').length, 0);
  const allChecks = state.buildingChecks.flatMap((project) => project.checks);
  const goodCount = allChecks.filter((check) => check.condition === 'good').length;
  const attentionCount = allChecks.filter((check) => check.condition === 'needs-attention').length;
  const badCount = allChecks.filter((check) => check.condition === 'bad').length;
  workspace.innerHTML = `
    <div class="home-view">
      ${stateLoadError ? '<p class="storage-warning" role="alert">Saved records could not be loaded in this browser. The dashboard is available, but changes will not save until browser storage is enabled.</p>' : ''}
      <p class="eyebrow">FIELDWORK DASHBOARD · FG OPS</p>
      <div class="home-heading">
        <div><h1>Fieldwork, in focus.</h1><p class="home-intro">Choose a workspace and pick up where your site work left off.</p></div>
        <div class="home-total"><span>PROJECTS ON THIS DEVICE</span><strong>${state.surveys.length + state.buildingChecks.length}</strong><small>Lighting and building checks</small></div>
      </div>
      <section class="home-condition-summary" aria-label="Building check conditions">
        <span class="home-summary-label">BUILDING CHECKS</span>
        <button class="condition-count good" type="button" data-check-filter="good" aria-label="Show ${goodCount} good checks"><strong>${goodCount}</strong><span>Good</span></button>
        <button class="condition-count needs-attention" type="button" data-check-filter="needs-attention" aria-label="Show ${attentionCount} checks needing attention"><strong>${attentionCount}</strong><span>Needs attention</span></button>
        <button class="condition-count bad" type="button" data-check-filter="bad" aria-label="Show ${badCount} bad checks"><strong>${badCount}</strong><span>Bad</span></button>
        <button class="condition-count open" type="button" data-check-filter="open" aria-label="Show ${openCount} open checks"><strong>${openCount}</strong><span>Open</span></button>
      </section>
      <div class="home-cards" aria-label="Choose a workspace">
        <article class="home-card lighting-card">
          <div class="home-card-top"><span>01 / LIGHT LEVELS</span><span class="home-card-icon" aria-hidden="true">lx</span></div>
          <div><p class="eyebrow">LIGHTING SURVEYS</p><h2>Measure the spaces people work in.</h2>
            <p class="home-card-description">Record lux readings, inspection notes, and evidence photos.</p></div>
          <div class="home-card-footer"><span>${state.surveys.length} ${state.surveys.length === 1 ? 'project' : 'projects'}</span>
            <button type="button" class="button primary" data-action="lighting">Open light surveys <span aria-hidden="true">→</span></button></div>
        </article>
        <article class="home-card checks-card">
          <div class="home-card-top"><span>02 / CONDITION & REPAIRS</span><span class="home-card-icon" aria-hidden="true">✓</span></div>
          <div><p class="eyebrow">BUILDING CHECKS</p><h2>Inspect conditions and track repairs.</h2>
            <p class="home-card-description">Work through checklists, record evidence, and verify completed repairs.</p></div>
          <div class="home-card-footer"><span>${state.buildingChecks.length} ${state.buildingChecks.length === 1 ? 'building' : 'buildings'} · ${checkCount} checks · ${openCount} open</span>
            <button type="button" class="button dark" data-action="checks">Open building checks <span aria-hidden="true">→</span></button></div>
        </article>
      </div>
      <section class="home-quick-actions">
        <div><p class="eyebrow">GET STARTED</p><h2>Start a new record</h2></div>
        <button class="button secondary" type="button" data-action="new">Start a light survey <span aria-hidden="true">＋</span></button>
        <button class="button secondary" type="button" data-action="checks">Choose property & checklist <span aria-hidden="true">→</span></button>
      </section>
      <p class="workspace-footer">Records stay on this device. Keep exported reports and project files private.</p>
    </div>`;
}

function renderCheckProjects() {
  const properties = state.properties;
  workspace.innerHTML = `
    <div class="checks-view">
      <div class="page-heading">
        <div><p class="eyebrow">OPERATIONS & OHS</p><h1>Select a property</h1>
        <p>Choose the property first. Its standard monthly forms and saved runs will be shown next.</p></div>
      </div>
      <div class="property-grid">${properties.map((property) => {
        const projects = state.buildingChecks.filter((project) => project.propertyId === property.id);
        const open = projects.reduce((count, project) => count + (project.runStatus === 'submitted' ? 0 : 1), 0);
        return `<article class="building-card">
          <div class="building-card-top"><span class="eyebrow">${escapeHtml(property.city || 'PROPERTY')}</span><span class="status-chip">${checkCatalog.templates.length} forms</span></div>
          <h2>${escapeHtml(property.name)}</h2><p>${escapeHtml(property.city || 'Location not set')}</p>
          <div class="building-stats"><span><strong>${projects.length}</strong> saved runs</span><span><strong>${open}</strong> drafts</span></div>
          <button class="button dark" type="button" data-action="select-property" data-property-id="${escapeHtml(property.id)}">Open property →</button>
        </article>`;
      }).join('')}</div>
    </div>`;
}

function renderPropertyChecklists() {
  const property = state.properties.find((item) => item.id === activePropertyId);
  if (!property) {
    navigateView('checks', { push: false });
    return;
  }
  const projects = state.buildingChecks
    .filter((project) => project.propertyId === property.id)
    .sort((left, right) => String(right.monthKey || '').localeCompare(String(left.monthKey || '')));
  const templates = checkCatalog.templates.map((template) => {
    const runs = projects.filter((project) => project.templateId === template.id);
    const currentRun = runs[0];
    return `<article class="form-template-card">
      <div><p class="eyebrow">MONTHLY PROPERTY FORM</p><h2>${escapeHtml(template.title)}</h2>
        <p>${template.questions.length} questions${currentRun ? ` · Latest ${escapeHtml(formatMonth(currentRun.monthKey))}` : ''}</p></div>
      <button class="button primary" type="button" data-action="start-property-template" data-template-id="${escapeHtml(template.id)}">${currentRun?.runStatus !== 'submitted' && currentRun ? 'Continue current run' : 'Start monthly check'} <span aria-hidden="true">→</span></button>
    </article>`;
  }).join('');
  const savedRuns = projects.filter((project) => project.templateId).map((project) => `
    <article class="saved-month-run"><div><strong>${escapeHtml(project.templateTitle || project.buildingName)}</strong>
      <span>${escapeHtml(formatMonth(project.monthKey || project.inspectionDate))} · ${project.runStatus === 'submitted' ? `Submitted by ${escapeHtml(project.submittedBy || 'Not recorded')}` : 'Draft'}</span></div>
      <button class="button secondary" type="button" data-action="open-check-project" data-project-id="${escapeHtml(project.id)}">Open run</button></article>`).join('');
  const legacyRuns = projects.filter((project) => !project.templateId).map((project) => `
    <article class="saved-month-run"><div><strong>${escapeHtml(project.sourceFileName || project.buildingName)}</strong>
      <span>${escapeHtml(formatMonth(project.monthKey || project.inspectionDate))} · ${project.checks.length} checks · ${escapeHtml(project.lastChangedBy || 'Editor not recorded')}</span></div>
      <button class="button secondary" type="button" data-action="open-check-project" data-project-id="${escapeHtml(project.id)}">Open legacy checklist</button></article>`).join('');
  workspace.innerHTML = `
    <div class="checks-view property-checklists-view">
      <div class="page-heading"><div><p class="eyebrow">${escapeHtml(property.city || 'PROPERTY')} · MONTHLY CHECKS</p>
        <h1>${escapeHtml(property.name)}</h1><p>Choose a standard form to answer and submit this month’s inspection.</p></div>
        <div class="page-heading-actions"><button class="button secondary" type="button" data-action="checks">All properties</button>
          <button class="button secondary" type="button" data-action="import-checks">Import completed checklist</button></div>
      </div>
      <div class="form-template-grid">${templates}</div>
      <section class="detail-panel"><div class="history-heading"><h2>Saved monthly runs</h2><span class="count">${projects.length}</span></div>
        <div class="saved-month-run-list">${savedRuns || '<p class="empty-list">No monthly runs saved for this property yet.</p>'}</div></section>
      ${legacyRuns ? `<section class="detail-panel"><div class="history-heading"><h2>Existing checklists</h2><span class="count">${projects.filter((project) => !project.templateId).length}</span></div>
        <div class="saved-month-run-list">${legacyRuns}</div></section>` : ''}
    </div>`;
}

async function startPropertyTemplate(propertyId, templateId) {
  await stateReady;
  if (stateLoadError) throw stateLoadError;
  const property = state.properties.find((item) => item.id === propertyId);
  const template = checkCatalog.templates.find((item) => item.id === templateId);
  if (!property || !template) throw new Error('Select a property and an available checklist form.');
  const monthKey = localDateString().slice(0, 7);
  const monthlyTemplateId = `${property.id}:${template.id}`;
  const existing = state.buildingChecks.find((project) =>
    project.monthlyTemplateId === monthlyTemplateId && project.monthKey === monthKey);
  if (existing) {
    navigateView('check-project', { projectId: existing.id, propertyId: property.id, templateId: template.id });
    return;
  }
  const createdAt = new Date().toISOString();
  const project = normalizeCheckProject({
    id: crypto.randomUUID(),
    propertyId: property.id,
    buildingName: property.name,
    inspectorName: '',
    inspectionDate: `${monthKey}-01`,
    monthKey,
    templateId: template.id,
    templateTitle: template.title,
    monthlyTemplateId,
    runStatus: 'draft',
    lastChangedBy: '',
    createdAt,
    updatedAt: createdAt,
    auditHistory: [],
    reports: [],
    checks: template.questions.map((question) => ({
      id: crypto.randomUUID(),
      templateQuestionId: question.id,
      title: question.label,
      responseType: question.type,
      photo: question.photo,
      attachmentLabel: question.attachmentLabel || '',
      answer: '',
      location: '',
      description: '',
      reference: '',
      status: 'open',
      condition: 'not-assessed',
      severity: 'not-assessed',
      notes: '',
      photos: [],
      history: [],
      reports: [],
      createdAt,
      updatedAt: createdAt
    }))
  });
  if (await commit({ ...state, buildingChecks: [project, ...state.buildingChecks] })) {
    navigateView('check-project', { projectId: project.id, propertyId: property.id, templateId: template.id });
  }
}

function statusLabel(status) {
  return ({ open: 'Open', 'in-progress': 'In progress', repaired: 'Repaired', verified: 'Verified' })[status] || 'Open';
}

function renderChecklistEditorRow(check, index, open = false) {
  const conditionOptions = ['not-assessed', 'good', 'needs-attention', 'bad']
    .map((value) => `<option value="${value}" ${check.condition === value ? 'selected' : ''}>${escapeHtml(conditionLabel(value))}</option>`)
    .join('');
  const severityOptions = ['not-assessed', 'low', 'moderate', 'high', 'critical']
    .map((value) => `<option value="${value}" ${check.severity === value ? 'selected' : ''}>${escapeHtml(value === 'not-assessed' ? 'Not assessed' : value[0].toUpperCase() + value.slice(1))}</option>`)
    .join('');
  const statusOptions = ['open', 'in-progress', 'repaired', 'verified']
    .map((value) => `<option value="${value}" ${check.status === value ? 'selected' : ''}>${escapeHtml(statusLabel(value))}</option>`)
    .join('');
  const photos = check.photos.slice(0, 4).map((photo) => `
    <img src="${escapeHtml(photo.data)}" alt="Condition photo for ${escapeHtml(check.title || `Check ${index + 1}`)}">`).join('');
  const lastUpdate = check.history[check.history.length - 1];
  return `<details class="check-edit-row" data-check-id="${escapeHtml(check.id)}" ${open ? 'open' : ''}>
    <summary><span class="check-edit-summary-title" data-check-label>${escapeHtml(check.title || `New check ${index + 1}`)}</span>
      <span class="condition-chip ${escapeHtml(check.condition)}" data-condition-label>${escapeHtml(conditionLabel(check.condition))}</span>
      <span class="status-chip">${escapeHtml(statusLabel(check.status))}</span></summary>
    <div class="check-edit-fields">
      <label>Check name<input data-field="title" maxlength="120" value="${escapeHtml(check.title)}" required /></label>
      <label>Location / area<input data-field="location" maxlength="120" value="${escapeHtml(check.location)}" /></label>
      <label>Description<textarea data-field="description" maxlength="1000" rows="2">${escapeHtml(check.description)}</textarea></label>
      <label>Reference / standard<input data-field="reference" maxlength="200" value="${escapeHtml(check.reference)}" /></label>
      <label>Condition<select data-field="condition" required>${conditionOptions}</select></label>
      <label>Severity<select data-field="severity" required>${severityOptions}</select></label>
      <label>Status<select data-field="status" required>${statusOptions}</select></label>
      <label>Inspector notes<textarea data-field="notes" maxlength="2000" rows="3">${escapeHtml(check.notes)}</textarea></label>
      <label class="check-photo-input">Add photos<input data-field="photos" type="file" accept="image/*" capture="environment" multiple /></label>
      ${photos ? `<div class="check-photo-strip">${photos}</div>` : '<p class="muted">No photos attached yet.</p>'}
      ${lastUpdate ? `<p class="check-last-update"><strong>Last update:</strong> ${escapeHtml(formatDateTime(lastUpdate.createdAt))} · Changed by ${escapeHtml(lastUpdate.changedBy || 'Not recorded')}${lastUpdate.notes ? ` · ${escapeHtml(lastUpdate.notes)}` : ''}</p>` : ''}
    </div>
  </details>`;
}

function buildBuildingChecklistReport(project) {
  if (project.templateId) {
    const template = checkCatalog.templates.find((item) => item.id === project.templateId);
    const questions = project.checks.map((check, index) => {
      const photos = (check.photos || []).map((photo) => `<figure><img src="${escapeHtml(photo.data)}" alt="Evidence for ${escapeHtml(check.title)}"><figcaption>${escapeHtml(formatDateTime(photo.createdAt))}</figcaption></figure>`).join('');
      const edits = project.firstSubmittedAt
        ? (check.history || []).filter((entry) => entry.createdAt > project.firstSubmittedAt)
        : [];
      const history = edits.map((entry) => `<li>${escapeHtml(formatDateTime(entry.createdAt))} · ${escapeHtml(entry.changedBy || 'Not recorded')} · ${entry.previousAnswer ? `${escapeHtml(entry.previousAnswer)} → ` : ''}${escapeHtml(entry.answer || 'No answer recorded')}</li>`).join('');
      return `<article class="report-check"><h2>${index + 1}. ${escapeHtml(check.title)}${edits.length ? ' <small>(Edited)</small>' : ''}</h2>
        <p><strong>Answer:</strong> ${escapeHtml(check.answer || 'Not answered')}</p>${photos ? `<h3>Photos</h3>${photos}` : ''}
        ${history ? `<h3>Edited after submission</h3><ul>${history}</ul>` : ''}</article>`;
    }).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(template?.title || project.templateTitle)} - ${escapeHtml(project.buildingName)} - ${escapeHtml(localDateString(new Date(project.submittedAt || project.updatedAt)))}</title><style>
      *{box-sizing:border-box}body{max-width:900px;margin:30px auto;padding:0 24px;color:#192c28;font:14px/1.5 Arial,sans-serif}header{border-bottom:3px solid #355449;padding-bottom:16px}h1{font-size:27px}h2{margin:18px 0 6px}h3{font-size:12px}.meta{color:#53645b}.report-check{padding:8px 0 18px;border-bottom:1px solid #dce2d8;break-inside:avoid}figure{display:inline-block;width:30%;margin:8px 2% 12px 0;vertical-align:top}figure img{width:100%;max-height:280px;object-fit:contain}figcaption{color:#53645b}@media print{body{margin:12mm auto}}
      </style></head><body><header><p>FG OPS · MONTHLY PROPERTY CHECK</p><h1>${escapeHtml(template?.title || project.templateTitle)}</h1><p class="meta"><strong>Property:</strong> ${escapeHtml(project.buildingName)} · <strong>City:</strong> ${escapeHtml(state.properties.find((item) => item.id === project.propertyId)?.city || '')}</p><p class="meta"><strong>Inspection date:</strong> ${escapeHtml(formatDate(project.inspectionDate))} · <strong>Inspector:</strong> ${escapeHtml(project.inspectorName)} · <strong>Submitted by:</strong> ${escapeHtml(project.submittedBy || project.lastChangedBy || 'Not recorded')}</p><p class="meta">Submitted ${escapeHtml(formatDateTime(project.submittedAt || project.updatedAt))}</p></header>${questions}</body></html>`;
  }
  const checks = project.checks.map((check, index) => {
    const photos = check.photos.map((photo) => `
      <figure><img src="${escapeHtml(photo.data)}" alt="Condition evidence for ${escapeHtml(check.title)}">
        <figcaption>${escapeHtml(formatDateTime(photo.createdAt))}${photo.caption ? ` · ${escapeHtml(photo.caption)}` : ''}</figcaption></figure>`).join('');
    const history = [...check.history].reverse().map((item) => `
      <li><strong>${escapeHtml(formatDateTime(item.createdAt))}</strong> · ${escapeHtml(statusLabel(item.status))}
        · Changed by ${escapeHtml(item.changedBy || 'Not recorded')}
        · ${escapeHtml(conditionLabel(item.condition))} · ${escapeHtml(item.severity.replaceAll('-', ' '))}
        ${item.notes ? `<br>${escapeHtml(item.notes)}` : ''}</li>`).join('');
    return `<article class="report-check"><h2>${index + 1}. ${escapeHtml(check.title)}</h2>
      <p><strong>Location:</strong> ${escapeHtml(check.location || 'Not specified')} ·
        <strong>Status:</strong> ${escapeHtml(statusLabel(check.status))} ·
        <strong>Condition:</strong> ${escapeHtml(conditionLabel(check.condition))} ·
        <strong>Severity:</strong> ${escapeHtml(check.severity.replaceAll('-', ' '))}</p>
      ${check.description ? `<p><strong>Description:</strong> ${escapeHtml(check.description)}</p>` : ''}
      ${check.notes ? `<p class="notes"><strong>Inspector notes:</strong> ${escapeHtml(check.notes)}</p>` : ''}
      ${photos ? `<h3>Photos</h3>${photos}` : '<p>No photos attached.</p>'}
      ${history ? `<h3>History</h3><ul>${history}</ul>` : ''}</article>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Building checklist - ${escapeHtml(project.buildingName)}</title><style>
    *{box-sizing:border-box}body{max-width:900px;margin:30px auto;padding:0 24px;color:#192c28;font:14px/1.5 Arial,sans-serif}
    header{border-bottom:3px solid #355449;padding-bottom:16px}h1{font-size:27px}h2{margin:20px 0 8px}h3{font-size:14px}
    .meta{color:#53645b}.report-check{padding:8px 0 18px;border-bottom:1px solid #dce2d8;break-inside:avoid}
    figure{display:inline-block;width:30%;margin:8px 2% 12px 0;vertical-align:top}figure img{width:100%;max-height:280px;object-fit:contain}
    figcaption,.notes{color:#53645b;white-space:pre-wrap}ul{padding-left:20px}@media print{body{margin:12mm auto}}
    </style></head><body><header><p>FG OPS · CHECKLIST REPORT</p>
    <h1>${escapeHtml(project.buildingName)}</h1><p class="meta"><strong>Inspector:</strong> ${escapeHtml(project.inspectorName)} ·
    <strong>Inspection date:</strong> ${escapeHtml(formatDate(project.inspectionDate))} ·
    <strong>Checks:</strong> ${project.checks.length}</p><p class="meta">Report generated ${escapeHtml(formatDateTime(new Date().toISOString()))}</p></header>
    ${checks || '<p>No checklist items recorded.</p>'}</body></html>`;
}

function renderTemplateQuestion(check, index) {
  const inputId = `template-answer-${index}`;
  let control;
  if (check.responseType === 'yes-no') {
    control = `<select data-template-answer id="${inputId}"><option value="">Choose an answer</option><option value="Yes" ${check.answer === 'Yes' ? 'selected' : ''}>Yes</option><option value="No" ${check.answer === 'No' ? 'selected' : ''}>No</option></select>`;
  } else if (check.responseType === 'yes-no-na') {
    control = `<select data-template-answer id="${inputId}"><option value="">Choose an answer</option><option value="Yes" ${check.answer === 'Yes' ? 'selected' : ''}>Yes</option><option value="No" ${check.answer === 'No' ? 'selected' : ''}>No</option><option value="N/A" ${check.answer === 'N/A' ? 'selected' : ''}>N/A</option></select>`;
  } else if (check.responseType === 'pass-fail-na') {
    control = `<select data-template-answer id="${inputId}"><option value="">Choose an answer</option><option value="Pass" ${check.answer === 'Pass' ? 'selected' : ''}>Pass</option><option value="Fail" ${check.answer === 'Fail' ? 'selected' : ''}>Fail</option><option value="N/A" ${check.answer === 'N/A' ? 'selected' : ''}>N/A</option></select>`;
  } else if (check.responseType === 'date') {
    control = `<input data-template-answer id="${inputId}" type="date" value="${escapeHtml(check.answer || '')}" />`;
  } else if (check.responseType === 'number' || check.responseType === 'rating') {
    control = `<input data-template-answer id="${inputId}" type="number" ${check.responseType === 'rating' ? 'min="0" max="10" step="0.1"' : 'step="any"'} value="${escapeHtml(check.answer || '')}" />`;
  } else if (check.responseType === 'textarea') {
    control = `<textarea data-template-answer id="${inputId}" rows="3">${escapeHtml(check.answer || '')}</textarea>`;
  } else {
    control = `<input data-template-answer id="${inputId}" type="text" value="${escapeHtml(check.answer || '')}" />`;
  }
  const photos = (check.photos || []).map((photo) => `<img src="${escapeHtml(photo.data)}" alt="Attached evidence for ${escapeHtml(check.title)}">`).join('');
  return `<article class="template-question" data-check-id="${escapeHtml(check.id)}">
    <label for="${inputId}"><span class="template-question-number">${index + 1}</span><span class="template-question-title">${escapeHtml(check.title)}</span></label>
    <div class="template-answer-control">${control}</div>
    ${check.photo || check.attachmentLabel ? `<label class="template-photo-field">${escapeHtml(check.attachmentLabel || 'Upload photo')}<input data-template-photos type="file" accept="image/*" capture="environment" multiple /></label>` : ''}
    ${photos ? `<div class="check-photo-strip">${photos}</div>` : ''}
    ${check.history?.length ? `<p class="check-last-update">Last changed ${escapeHtml(formatDateTime(check.history.at(-1).createdAt))} · ${escapeHtml(check.history.at(-1).changedBy || 'Not recorded')}</p>` : ''}
  </article>`;
}

function renderTemplateCheckProject(project) {
  const property = state.properties.find((item) => item.id === project.propertyId);
  const template = checkCatalog.templates.find((item) => item.id === project.templateId);
  if (!property || !template) {
    workspace.innerHTML = '<div class="empty-state"><h2>Checklist form unavailable</h2><p>This saved monthly run refers to a form template that is not available in this app build.</p></div>';
    return;
  }
  const answeredCount = project.checks.filter((check) => String(check.answer || '').trim()).length;
  const reports = [...(project.reports || [])].reverse().map((report, index) => `
    <article class="report-revision"><div><strong>${escapeHtml(report.title || `Submitted report ${project.reports.length - index}`)}</strong><span>${escapeHtml(formatDateTime(report.createdAt))} · ${escapeHtml(report.createdBy || 'Not recorded')}</span></div>
      <div class="report-revision-actions"><button class="button secondary" type="button" data-action="view-building-report" data-report-id="${escapeHtml(report.id)}">View</button>
        <button class="button secondary" type="button" data-action="download-building-report" data-report-id="${escapeHtml(report.id)}">Export PDF</button></div>
    </article>`).join('');
  workspace.innerHTML = `
    <div class="checks-view monthly-form-view">
      <div class="page-heading"><div><p class="eyebrow">${escapeHtml(property.city)} · ${escapeHtml(formatMonth(project.monthKey))}</p>
        <h1>${escapeHtml(property.name)}</h1><p>${escapeHtml(template.title)} · ${answeredCount} of ${project.checks.length} answered</p>
        <p class="checklist-guidance">${project.firstSubmittedAt ? `Submitted ${escapeHtml(formatDateTime(project.submittedAt))} by ${escapeHtml(project.submittedBy || 'Not recorded')}. Edit time-sensitive items below, then resubmit to save an updated report; earlier reports are kept.` : 'Answer the form questions below. Attach photos where prompted. This monthly run is saved separately from previous months.'}</p></div>
        <div class="page-heading-actions"><button class="button secondary" type="button" data-action="property-checklists">All ${escapeHtml(property.name)} forms</button>
          <button class="button secondary" type="button" data-action="start-next-month" data-project-id="${escapeHtml(project.id)}">Next month <span aria-hidden="true">＋</span></button></div>
      </div>
      <form id="monthly-template-form" data-project-id="${escapeHtml(project.id)}">
        <div class="check-project-fields monthly-run-fields">
          <label>Inspector<input name="inspectorName" maxlength="100" value="${escapeHtml(project.inspectorName || '')}" required /></label>
          <label>Inspection date<input name="inspectionDate" type="date" value="${escapeHtml(project.inspectionDate)}" required /></label>
          <label>Changed by<input name="changedBy" maxlength="100" value="${escapeHtml(project.lastChangedBy || '')}" required /></label>
        </div>
        <div class="template-question-list">${project.checks.map((check, index) => renderTemplateQuestion(check, index)).join('')}</div>
        <div class="checklist-submit-bar"><button class="button secondary" type="submit">${project.firstSubmittedAt ? 'Save changes' : 'Save progress'}</button>
          <button class="button primary" type="submit" data-submit-monthly="true">${project.firstSubmittedAt ? 'Save & resubmit edited report' : 'Submit monthly check'}</button></div>
      </form>
      <section class="detail-panel"><div class="history-heading"><h2>Previous submissions</h2><span class="count">${project.reports?.length || 0}</span></div>
        <div class="report-revision-list">${reports || '<p class="empty-list">No report submitted for this month yet.</p>'}</div></section>
    </div>`;
}

async function saveMonthlyTemplate(form, submitRun) {
  await stateReady;
  if (stateLoadError) throw stateLoadError;
  const project = state.buildingChecks.find((item) => item.id === form.dataset.projectId);
  if (!project?.templateId) throw new Error('The monthly checklist is no longer available.');
  const template = checkCatalog.templates.find((item) => item.id === project.templateId);
  const values = new FormData(form);
  const inspectorName = String(values.get('inspectorName') || '').trim();
  const inspectionDate = String(values.get('inspectionDate') || '').trim();
  const changedBy = String(values.get('changedBy') || '').trim();
  if (!inspectorName || !inspectionDate || !changedBy) {
    throw new Error('Inspector, inspection date, and the person completing the form are required.');
  }
  const questionRows = [...form.querySelectorAll('.template-question')];
  const nextChecks = [];
  const missing = [];
  for (const row of questionRows) {
    const previous = project.checks.find((check) => check.id === row.dataset.checkId);
    if (!previous) throw new Error('A checklist question could not be matched to its saved record.');
    const answer = String(row.querySelector('[data-template-answer]')?.value || '').trim();
    if (submitRun && !answer) missing.push(previous.title);
    const files = [...(row.querySelector('[data-template-photos]')?.files || [])];
    if (files.length > 10) throw new Error(`Attach no more than 10 photos to “${previous.title}” at once.`);
    const createdAt = new Date().toISOString();
    const photos = await Promise.all(files.map(async (file) => {
      if (!file.type.startsWith('image/')) throw new Error(`${file.name} is not an image file.`);
      if (file.size > 12 * 1024 * 1024) throw new Error(`${file.name} is larger than 12 MB.`);
      return { id: crypto.randomUUID(), data: await fileToDataUrl(file), caption: previous.title, createdAt };
    }));
    const changed = answer !== String(previous.answer || '') || photos.length > 0;
    nextChecks.push(changed ? {
      ...previous,
      answer,
      photos: [...(previous.photos || []), ...photos],
      updatedAt: createdAt,
      history: [...(previous.history || []), {
        id: crypto.randomUUID(),
        createdAt,
        changedBy,
        answer,
        previousAnswer: String(previous.answer || ''),
        notes: photos.length ? `Answer updated with ${photos.length} photo(s).` : 'Answer updated.',
        photoIds: photos.map((photo) => photo.id)
      }]
    } : previous);
  }
  if (missing.length) {
    throw new Error(`Answer every question before submitting. First unanswered question: ${missing[0]}`);
  }
  const monthKey = inspectionDate.slice(0, 7);
  const duplicate = state.buildingChecks.find((item) => item.id !== project.id
    && item.monthlyTemplateId === project.monthlyTemplateId && item.monthKey === monthKey);
  if (duplicate) throw new Error(`A ${formatMonth(monthKey)} run for this form already exists for ${project.buildingName}.`);
  const createdAt = new Date().toISOString();
  let updatedProject = {
    ...project,
    inspectorName,
    inspectionDate,
    monthKey,
    lastChangedBy: changedBy,
    updatedAt: createdAt,
    runStatus: submitRun || project.firstSubmittedAt ? 'submitted' : 'draft',
    submittedBy: submitRun ? changedBy : project.submittedBy || '',
    submittedAt: submitRun ? createdAt : project.submittedAt || null,
    firstSubmittedAt: project.firstSubmittedAt || (submitRun ? createdAt : null),
    checks: nextChecks,
    auditHistory: [...(project.auditHistory || []), {
      id: crypto.randomUUID(),
      createdAt,
      changedBy,
      action: submitRun ? 'Submitted monthly form' : 'Saved draft'
    }]
  };
  let report;
  if (submitRun) {
    const revision = (project.reports || []).length + 1;
    report = {
      id: crypto.randomUUID(),
      createdAt,
      createdBy: changedBy,
      revision,
      title: `${template?.title || project.templateTitle} - ${project.buildingName} - ${localDateString(new Date(createdAt))}${revision > 1 ? ` (Edited, revision ${revision})` : ''}`,
      html: buildBuildingChecklistReport(updatedProject)
    };
    updatedProject.reports = [...(project.reports || []), report];
  }
  const buildingChecks = state.buildingChecks.map((item) => item.id === project.id ? updatedProject : item);
  if (!await commit({ ...state, buildingChecks })) return;
  if (report) {
    try {
      await downloadReport(report.html, { buildingName: report.title }, report.id, reportMeta(project.buildingName, template?.title || project.templateTitle || 'Monthly form', report.createdAt, report.revision));
    } catch (error) {
      alertError(error, 'The monthly form was submitted and saved, but the PDF could not be exported.');
    }
  } else {
    window.alert(`Draft saved for ${formatMonth(monthKey)}.`);
  }
}

function renderCheckProject() {
  const project = state.buildingChecks.find((item) => item.id === activeCheckProjectId);
  if (!project) {
    navigateView('checks', { push: false });
    return;
  }
  if (project.templateId) {
    renderTemplateCheckProject(project);
    return;
  }
  const savedReports = [...(project.reports || [])].reverse().map((report, index) => `
    <article class="report-revision"><div><strong>Building report ${project.reports.length - index}</strong><span>${escapeHtml(formatDateTime(report.createdAt))}</span></div>
      <div class="report-revision-actions"><button class="button secondary" type="button" data-action="view-building-report" data-report-id="${escapeHtml(report.id)}">View</button>
        <button class="button secondary" type="button" data-action="download-building-report" data-report-id="${escapeHtml(report.id)}">Export PDF</button></div>
    </article>`).join('');
  workspace.innerHTML = `
    <div class="checks-view">
      <div class="page-heading"><div><p class="eyebrow">BUILDING CHECKS · ${escapeHtml(formatMonth(project.monthKey || project.inspectionDate))}</p>
        <h1>Edit building checklist</h1><p>${project.checks.length} checks · expand items to update them without leaving this list</p>
        <p class="checklist-guidance">Last saved by ${escapeHtml(project.lastChangedBy || 'Not recorded')} · ${escapeHtml(formatDateTime(project.updatedAt || project.createdAt))}</p>
        <p class="checklist-guidance">Set condition, severity, status, notes, and photos; save once for the entire building. Repaired checks need a new repair note, and verification is available only after repair.</p></div>
        <div class="page-heading-actions"><button class="button secondary" type="button" data-action="checks">All buildings</button>
          <button class="button primary" type="button" data-action="start-next-month" data-project-id="${escapeHtml(project.id)}">Create next month <span aria-hidden="true">＋</span></button></div>
      </div>
      <form id="checklist-edit-form" data-project-id="${escapeHtml(project.id)}">
        <div class="check-project-fields">
          <label>Building name<input name="buildingName" maxlength="100" value="${escapeHtml(project.buildingName)}" required /></label>
          <label>Inspector name<input name="inspectorName" maxlength="100" value="${escapeHtml(project.inspectorName)}" required /></label>
          <label>Inspection date<input name="inspectionDate" type="date" value="${escapeHtml(project.inspectionDate)}" required /></label>
          <label>Changed by<input name="changedBy" maxlength="100" value="${escapeHtml(project.lastChangedBy)}" required /></label>
        </div>
        <div class="checklist-edit-heading"><h2>Checklist items</h2><button class="button secondary" type="button" data-action="add-check-to-list">＋ Add check</button></div>
        <div class="check-list" id="checklist-edit-list">${project.checks.map((check, index) => renderChecklistEditorRow(check, index, index === 0)).join('')}</div>
        <div class="checklist-submit-bar">
          <button class="button secondary" type="submit">Save checklist</button>
          <button class="button primary" type="submit" data-export-report="true">Save checklist & export building report</button>
        </div>
      </form>
      <section class="detail-panel"><div class="history-heading"><h2>Saved building reports</h2><span class="count">${project.reports?.length || 0}</span></div>
        <div class="report-revision-list">${savedReports || '<p class="empty-list">Save and export the checklist to create the first building report.</p>'}</div></section>
    </div>`;
}

function renderCheckFilter() {
  const labels = { good: 'Good', 'needs-attention': 'Needs attention', bad: 'Bad', open: 'Open' };
  if (!labels[activeCheckFilter]) {
    navigateView('home', { push: false });
    return;
  }
  const projects = state.buildingChecks.map((project) => ({
    ...project,
    checks: project.checks.filter((check) => activeCheckFilter === 'open'
      ? check.status !== 'verified'
      : check.condition === activeCheckFilter)
  })).filter((project) => project.checks.length);
  const checkCount = projects.reduce((total, project) => total + project.checks.length, 0);
  workspace.innerHTML = `
    <div class="checks-view check-filter-view">
      <div class="page-heading"><div><p class="eyebrow">BUILDING CHECKS · QUICK FILTER</p><h1>${labels[activeCheckFilter]}</h1>
        <p>${checkCount} matching ${checkCount === 1 ? 'check' : 'checks'} · expand an item to update it.</p></div>
        <button class="button secondary" type="button" data-action="checks">All checklists</button>
      </div>
      ${projects.length ? projects.map((project) => `
        <form class="filtered-project" data-filtered-project-form data-project-id="${escapeHtml(project.id)}" data-check-filter="${escapeHtml(activeCheckFilter)}">
          <input type="hidden" name="buildingName" value="${escapeHtml(project.buildingName)}" />
          <input type="hidden" name="inspectorName" value="${escapeHtml(project.inspectorName)}" />
          <input type="hidden" name="inspectionDate" value="${escapeHtml(project.inspectionDate)}" />
          <label class="filtered-changed-by">Changed by<input name="changedBy" maxlength="100" value="${escapeHtml(project.lastChangedBy)}" required /></label>
          <div class="checklist-edit-heading"><h2>${escapeHtml(project.buildingName)}</h2><span>${project.checks.length} ${project.checks.length === 1 ? 'check' : 'checks'}</span></div>
          <div class="check-list">${project.checks.map((check, index) => renderChecklistEditorRow(check, index)).join('')}</div>
          <div class="checklist-submit-bar"><button class="button primary" type="submit">Save matching checks</button></div>
        </form>`).join('') : '<p class="empty-list filtered-empty">No checks match this category yet.</p>'}
    </div>`;
}

function buildCheckReport(project, check) {
  const photos = (check.photos || []).map((photo) => `<figure><img src="${escapeHtml(photo.data)}" alt="Condition evidence for ${escapeHtml(check.title)}"><figcaption>${escapeHtml(formatDateTime(photo.createdAt))} · ${escapeHtml(photo.caption || 'Inspection photo')}</figcaption></figure>`).join('');
  const history = (check.history || []).map((item) => `
    <article class="history-item"><h3>${escapeHtml(formatDateTime(item.createdAt))} · ${escapeHtml(statusLabel(item.status))}</h3>
      ${item.title ? `<p><strong>Check:</strong> ${escapeHtml(item.title)}${item.location ? ` · ${escapeHtml(item.location)}` : ''}</p>` : ''}
      <p>Condition: ${escapeHtml(conditionLabel(item.condition))} · Severity: ${escapeHtml(item.severity.replaceAll('-', ' '))}</p>
      ${item.notes ? `<p>${escapeHtml(item.notes)}</p>` : ''}
      ${(item.photoIds || []).length ? `<p>${item.photoIds.length} photo(s) attached to this update. See the condition photos above.</p>` : ''}
    </article>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Building check - ${escapeHtml(check.title)}</title><style>
    *{box-sizing:border-box}body{max-width:900px;margin:30px auto;padding:0 24px;color:#192c28;font:14px/1.5 Arial,sans-serif}header{border-bottom:3px solid #355449;padding-bottom:16px}h1{font-size:27px}h2{margin-top:25px}h3{margin-bottom:5px}.meta{color:#53645b}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:20px 0}.summary div{padding:12px;background:#f1f4ec;border:1px solid #dce2d8}figure{display:inline-block;width:30%;margin:8px 2% 12px 0;vertical-align:top}figure img{width:100%;max-height:280px;object-fit:contain}.history-item{border-top:1px solid #dce2d8;padding:8px 0}.notes{white-space:pre-wrap}@media print{body{margin:12mm auto}}
    </style></head><body><header><p>FG OPS · BUILDING CONDITION RECORD</p><h1>${escapeHtml(check.title)}</h1>
    <p class="meta"><strong>Building:</strong> ${escapeHtml(project.buildingName)} · <strong>Inspector:</strong> ${escapeHtml(project.inspectorName)}</p>
    <p class="meta"><strong>Location:</strong> ${escapeHtml(check.location || 'Not specified')} · <strong>Inspection date:</strong> ${escapeHtml(formatDate(project.inspectionDate))}</p></header>
    <section class="summary"><div><strong>Status:</strong> ${escapeHtml(statusLabel(check.status))}</div><div><strong>Condition:</strong> ${escapeHtml(conditionLabel(check.condition))}</div><div><strong>Severity:</strong> ${escapeHtml(check.severity.replaceAll('-', ' '))}</div></section>
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
    <article class="history-item"><div class="history-heading"><strong>${escapeHtml(formatDateTime(item.createdAt))} · ${escapeHtml(item.changedBy || 'Not recorded')}</strong><span class="status-chip">${escapeHtml(statusLabel(item.status))}</span></div>
      ${item.title ? `<p><strong>Check:</strong> ${escapeHtml(item.title)}${item.location ? ` · ${escapeHtml(item.location)}` : ''}</p>` : ''}
      <p>Condition: ${escapeHtml(conditionLabel(item.condition))} · Severity: ${escapeHtml(item.severity.replaceAll('-', ' '))}</p>
      ${item.notes ? `<p class="notes">${escapeHtml(item.notes)}</p>` : ''}
      <div class="history-photos">${(item.photoIds || []).map((id) => {
        const photo = check.photos.find((itemPhoto) => itemPhoto.id === id);
        return photo ? `<img src="${escapeHtml(photo.data)}" alt="Repair history photo">` : '';
      }).join('')}</div>
    </article>`).join('');
  const reports = [...(check.reports || [])].reverse().map((report, index) => `
    <article class="report-revision"><div><strong>Revision ${check.reports.length - index}</strong><span>${escapeHtml(formatDateTime(report.createdAt))}</span></div>
      <div class="report-revision-actions"><button class="button secondary" type="button" data-action="view-check-report" data-report-id="${escapeHtml(report.id)}">View</button>
        <button class="button secondary" type="button" data-action="download-check-report" data-report-id="${escapeHtml(report.id)}">Export PDF</button></div>
    </article>`).join('');
  workspace.innerHTML = `
    <div class="check-detail">
      <div class="breadcrumbs"><button class="text-button" type="button" data-action="checks">Building checks</button><span>›</span><span>${escapeHtml(project.buildingName)}</span></div>
      <div class="page-heading"><div><p class="eyebrow">${escapeHtml(check.category || 'BUILDING CHECK')}</p><h1>${escapeHtml(check.title)}</h1>
        <p>${escapeHtml(check.location || 'Location not specified')} · ${escapeHtml(project.buildingName)}</p></div>
        <div class="detail-actions"><button class="button secondary" type="button" data-action="update-check">Edit check</button>
        <button class="button primary" type="button" data-action="export-check">Save & export report</button></div>
      </div>
      <div class="condition-overview"><span class="status-chip ${check.status === 'verified' ? 'complete' : 'attention'}">${escapeHtml(statusLabel(check.status))}</span>
        <div><span>Condition</span><strong class="condition-value ${escapeHtml(check.condition)}">${escapeHtml(conditionLabel(check.condition))}</strong></div>
        <div><span>Severity</span><strong>${escapeHtml(check.severity.replaceAll('-', ' '))}</strong></div>
        <div><span>Last updated</span><strong>${escapeHtml(formatDateTime(check.updatedAt || check.createdAt))}</strong></div>
      </div>
      ${check.description ? `<section class="detail-panel"><h2>Check description</h2><p>${escapeHtml(check.description)}</p>${check.reference ? `<p class="muted">Reference: ${escapeHtml(check.reference)}</p>` : ''}</section>` : ''}
      <section class="detail-panel"><h2>Inspector notes</h2><p class="notes">${escapeHtml(check.notes || 'No notes recorded.')}</p></section>
      <section class="detail-panel"><h2>Condition photos <span class="count">${check.photos.length}</span></h2><div class="check-photo-grid">${photos || '<p class="empty-list">No condition photos attached yet.</p>'}</div></section>
      <section class="detail-panel"><div class="history-heading"><h2>Saved report revisions</h2><span class="count">${check.reports?.length || 0}</span></div>
        <p class="muted">Each saved version is a snapshot. Edit the check and save a new report to keep the earlier version.</p>
        <div class="report-revision-list">${reports || '<p class="empty-list">No reports saved yet. Save and export a report to create the first version.</p>'}</div></section>
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

function pdfPageLines(items) {
  const lines = [];
  let line = '';
  let previousY = null;
  for (const item of items) {
    if (typeof item.str !== 'string' || !item.str.trim()) continue;
    const y = item.transform?.[5];
    if (line && Number.isFinite(y) && Number.isFinite(previousY) && Math.abs(y - previousY) > 3) {
      lines.push(line.trim());
      line = '';
    }
    line += `${line ? ' ' : ''}${item.str.trim()}`;
    previousY = y;
    if (item.hasEOL) {
      lines.push(line.trim());
      line = '';
      previousY = null;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

function checklistRowsFromPdfText(text) {
  const lines = text.split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 8 && !/^(?:page\s+)?\d+(?:\s+of\s+\d+)?$/i.test(line)
      && !/^(?:contents|table of contents|checklist|inspection checklist)$/i.test(line));
  const isListItem = (line) => /^(?:[☐☑□■▪●•*-]|\d{1,3}[.)])\s*/.test(line);
  const listLines = lines.filter(isListItem);
  const actionLines = lines.filter((line) => /\b(check|inspect|verify|ensure|confirm|test|assess|maintain|provide|identify|review|record|clean|repair|secure|replace|install|operate)\b/i.test(line));
  const candidates = listLines.length >= 2 ? listLines : actionLines.length >= 2 ? actionLines : lines;
  const seen = new Set();
  return candidates.flatMap((line) => {
    const title = line.replace(/^(?:[☐☑□■▪●•*-]|\d{1,3}[.)])\s*/, '').trim();
    const key = title.toLocaleLowerCase();
    if (title.length < 8 || seen.has(key)) return [];
    seen.add(key);
    return [{ Check: title.slice(0, 120), Description: title.length > 120 ? title.slice(120) : '' }];
  }).slice(0, 1000);
}

async function readPdfChecklistRows(file, status) {
  if (file.size > 25 * 1024 * 1024) throw new Error('PDF checklists must be smaller than 25 MB.');
  const [{ getDocument, GlobalWorkerOptions }, { default: pdfWorkerUrl }] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  ]);
  GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const loadingTask = getDocument({ data: await file.arrayBuffer() });
  let pdf;
  let ocrWorker;
  try {
    pdf = await loadingTask.promise;
    if (!pdf.numPages || pdf.numPages > 100) {
      throw new Error('PDF checklists must contain between 1 and 100 pages.');
    }
    const lines = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      status.textContent = `Reading PDF text · page ${pageNumber} of ${pdf.numPages}`;
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      let pageLines = pdfPageLines(textContent.items);
      if (pageLines.join(' ').length < 40) {
        if (!ocrWorker) {
          status.textContent = 'Preparing offline English OCR…';
          const { createWorker } = await import('tesseract.js');
          ocrWorker = await createWorker('eng', undefined, {
            workerPath: `${ocrAssetPath}worker.min.js`,
            corePath: `${ocrAssetPath}core`,
            langPath: `${ocrAssetPath}lang`,
            workerBlobURL: false,
            logger: (message) => {
              if (message.status === 'recognizing text') {
                status.textContent = `Reading scanned PDF · page ${pageNumber} of ${pdf.numPages} · ${Math.round(message.progress * 100)}%`;
              } else if (message.status === 'loading language traineddata') {
                status.textContent = 'Loading offline English OCR data…';
              }
            }
          });
        }
        const viewport = page.getViewport({ scale: Math.min(1.5, 1800 / Math.max(page.view[2], page.view[3])) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not prepare a PDF page for OCR.');
        await page.render({ canvasContext: context, viewport }).promise;
        const result = await ocrWorker.recognize(canvas);
        pageLines = result.data.text.split(/\r?\n/);
        canvas.width = 0;
        canvas.height = 0;
      }
      lines.push(...pageLines);
      page.cleanup();
    }
    const rows = checklistRowsFromPdfText(lines.join('\n'));
    if (!rows.length) {
      throw new Error('No checklist items could be identified in the PDF. Try a clearer PDF or import a CSV/Excel checklist.');
    }
    return rows;
  } finally {
    if (ocrWorker) await ocrWorker.terminate();
    if (pdf) await pdf.destroy();
    else await loadingTask.destroy();
    status.textContent = '';
  }
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
  const propertyId = String(values.get('propertyId') || '').trim();
  const property = state.properties.find((item) => item.id === propertyId);
  const buildingName = property?.name || '';
  const inspectorName = String(values.get('inspectorName') || '').trim();
  const changedBy = String(values.get('changedBy') || '').trim();
  const inspectionDate = String(values.get('inspectionDate') || '').trim();
  const file = form.elements.checksFile.files?.[0];
  if (!property || !inspectorName || !changedBy || !inspectionDate || !file) throw new Error('Select a property and provide the inspector, importing person, inspection date, and checklist file.');
  const status = document.querySelector('#check-import-status');
  const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  const rows = isPdf ? await readPdfChecklistRows(file, status) : await readBuildingCheckRows(file);
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
      history: [{ id: crypto.randomUUID(), createdAt, status, condition, severity, notes: 'Checklist item imported; condition and severity remain unassessed unless provided in the checklist.', changedBy, photoIds: [] }],
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
    inspectionDate,
    propertyId,
    createdAt: new Date().toISOString(),
    lastChangedBy: changedBy,
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
    window.alert(`Created a ${checks.length}-item checklist for ${buildingName}. Review it, add photos, and save or export its building report.`);
  }
}

function resetManualCheckRows() {
  const list = document.querySelector('#manual-check-list');
  const template = document.querySelector('#manual-check-row-template');
  list.replaceChildren(template.content.cloneNode(true));
}

function addManualCheckRow() {
  const list = document.querySelector('#manual-check-list');
  if (list.children.length >= 100) {
    window.alert('A building project can contain at most 100 checklist items.');
    return;
  }
  const template = document.querySelector('#manual-check-row-template');
  list.append(template.content.cloneNode(true));
}

function openCheckProjectDialog() {
  const form = document.querySelector('#check-project-form');
  form.reset();
  form.elements.inspectionDate.value = new Date().toISOString().slice(0, 10);
  resetManualCheckRows();
  document.querySelector('#check-project-dialog').showModal();
}

async function createCheckProject(form) {
  await stateReady;
  if (stateLoadError) throw stateLoadError;
  const values = new FormData(form);
  const buildingName = String(values.get('buildingName') || '').trim();
  const inspectorName = String(values.get('inspectorName') || '').trim();
  const inspectionDate = String(values.get('inspectionDate') || '');
  const createdBy = String(values.get('createdBy') || '').trim();
  const rows = [...form.querySelectorAll('.manual-check-row')];
  if (!buildingName || !inspectorName || !inspectionDate || !createdBy) {
    throw new Error('Building name, inspector name, inspection date, and creator name are required.');
  }
  if (!rows.length || rows.length > 100) throw new Error('Add between 1 and 100 checklist items.');
  const createdAt = new Date().toISOString();
  const checks = rows.map((row) => {
    const title = String(row.querySelector('[name="title"]').value || '').trim();
    if (!title) throw new Error('Every checklist item needs a name.');
    return {
      id: crypto.randomUUID(),
      title,
      location: String(row.querySelector('[name="location"]').value || '').trim(),
      description: String(row.querySelector('[name="description"]').value || '').trim(),
      category: '',
      reference: '',
      status: values.status,
      condition: 'not-assessed',
      severity: 'not-assessed',
      notes: '',
      photos: [],
      history: [{
        id: crypto.randomUUID(),
        createdAt,
        status: 'open',
        condition: 'not-assessed',
        severity: 'not-assessed',
        notes: 'Checklist item created; condition has not yet been assessed.',
        changedBy: createdBy,
        photoIds: []
      }],
      createdAt,
      updatedAt: createdAt
    };
  });
  const project = normalizeCheckProject({ id: crypto.randomUUID(), buildingName, inspectorName, inspectionDate, createdAt, updatedAt: createdAt, lastChangedBy: createdBy, checks });
  const saved = await commit({ ...state, buildingChecks: [project, ...state.buildingChecks] });
  if (saved) {
    form.reset();
    resetManualCheckRows();
    document.querySelector('#check-project-dialog').close();
    navigateView('check-project', { projectId: project.id });
  }
}

function createChecklistCheck(values, createdAt) {
  const check = {
    id: crypto.randomUUID(),
    title: values.title,
    location: values.location,
    description: values.description,
    reference: values.reference,
    category: '',
    status: 'open',
    condition: values.condition,
    severity: values.severity,
    notes: values.notes,
    photos: values.photos,
    history: [],
    reports: [],
    createdAt,
    updatedAt: createdAt
  };
  check.history.push({
    id: crypto.randomUUID(),
    createdAt,
    status: check.status,
    condition: check.condition,
    severity: check.severity,
    notes: check.notes || 'Checklist item created.',
    changedBy: values.changedBy,
    title: check.title,
    location: check.location,
    description: check.description,
    photoIds: check.photos.map((photo) => photo.id)
  });
  return check;
}

async function saveBuildingChecklist(form, exportReport) {
  await stateReady;
  if (stateLoadError) throw stateLoadError;
  const project = state.buildingChecks.find((item) => item.id === form.dataset.projectId);
  if (!project) throw new Error('The selected building checklist is no longer available.');
  const values = new FormData(form);
  const buildingName = String(values.get('buildingName') || '').trim();
  const inspectorName = String(values.get('inspectorName') || '').trim();
  const inspectionDate = String(values.get('inspectionDate') || '');
  const changedBy = String(values.get('changedBy') || '').trim();
  const rows = [...form.querySelectorAll('.check-edit-row')];
  if (!buildingName || !inspectorName || !inspectionDate || !changedBy) {
    throw new Error('Building name, inspector name, inspection date, and the editor name are required.');
  }
  if (!rows.length || rows.length > 1000) throw new Error('A checklist must contain between 1 and 1,000 items.');

  const checks = [];
  for (const row of rows) {
    const previous = project.checks.find((item) => item.id === row.dataset.checkId);
    const field = (name) => row.querySelector(`[data-field="${name}"]`);
    const title = field('title').value.trim();
    const checkValues = {
      title,
      location: field('location').value.trim(),
      description: field('description').value.trim(),
      reference: field('reference').value.trim(),
      condition: field('condition').value,
      severity: field('severity').value,
      status: field('status').value,
      notes: field('notes').value.trim()
    };
    if (!title) throw new Error('Every checklist item needs a name.');
    if (!previous && ['repaired', 'verified'].includes(checkValues.status)) {
      throw new Error(`"${title}" must be inspected and repaired before it can be marked ${statusLabel(checkValues.status).toLowerCase()}.`);
    }
    if (previous && checkValues.status === 'verified' && !['repaired', 'verified'].includes(previous.status)) {
      throw new Error(`Mark "${title}" as repaired and add a repair note before recording verification.`);
    }
    if (previous && checkValues.status === 'repaired' && previous.status !== 'repaired'
      && (!checkValues.notes || checkValues.notes === previous.notes)) {
      throw new Error(`Add a new repair note for "${title}" before marking it repaired.`);
    }
    const files = [...field('photos').files];
    if (files.length > 10) throw new Error(`Attach no more than 10 photos to "${title}" at once.`);
    const createdAt = new Date().toISOString();
    const photos = await Promise.all(files.map(async (file) => {
      if (!file.type.startsWith('image/')) throw new Error(`${file.name} is not an image file.`);
      if (file.size > 12 * 1024 * 1024) throw new Error(`${file.name} is larger than 12 MB.`);
      return {
        id: crypto.randomUUID(),
        data: await fileToDataUrl(file),
        caption: `${conditionLabel(checkValues.condition)} condition`,
        createdAt
      };
    }));

    if (!previous) {
      checks.push(createChecklistCheck({ ...checkValues, photos, changedBy }, createdAt));
      continue;
    }
    const changed = photos.length > 0 || Object.entries(checkValues).some(([key, value]) => previous[key] !== value);
    if (!changed) {
      checks.push(previous);
      continue;
    }
    const updated = {
      ...previous,
      ...checkValues,
      photos: [...previous.photos, ...photos],
      updatedAt: createdAt,
      history: [...previous.history, {
        id: crypto.randomUUID(),
        createdAt,
        status: checkValues.status,
        condition: checkValues.condition,
        severity: checkValues.severity,
        notes: checkValues.notes || 'Checklist details updated.',
        changedBy,
        title,
        location: checkValues.location,
        description: checkValues.description,
        reference: checkValues.reference,
        photoIds: photos.map((photo) => photo.id)
      }]
    };
    checks.push(updated);
  }

  const updatedChecks = form.dataset.checkFilter
    ? project.checks.map((check) => checks.find((updated) => updated.id === check.id) || check)
    : checks;
  const savedAt = new Date().toISOString();
  const updatedProject = {
    ...project,
    buildingName,
    inspectorName,
    inspectionDate,
    monthKey: inspectionDate.slice(0, 7),
    lastChangedBy: changedBy,
    updatedAt: savedAt,
    checks: updatedChecks
  };
  let report;
  if (exportReport) {
    report = {
      id: crypto.randomUUID(),
      createdAt: savedAt,
      createdBy: changedBy,
      html: buildBuildingChecklistReport(updatedProject)
    };
    updatedProject.reports = [...(project.reports || []), report];
  }
  const buildingChecks = state.buildingChecks.map((item) => item.id === project.id ? updatedProject : item);
  if (!await commit({ ...state, buildingChecks })) return;
  if (!form.dataset.checkFilter) navigateView('check-project', { projectId: project.id });
  if (report) {
    try {
      await downloadReport(report.html, { buildingName: `${buildingName}-Building-Checklist` }, report.id, reportMeta(buildingName, 'Building checklist', report.createdAt));
    } catch (error) {
      alertError(error, 'The checklist and report revision were saved, but the report could not be exported.');
    }
  } else {
    window.alert(form.dataset.checkFilter
      ? `${rows.length} matching checks saved for ${buildingName}.`
      : `Checklist saved for ${buildingName}.`);
  }
}

async function createNextMonthlyChecklist(projectId) {
  await stateReady;
  if (stateLoadError) throw stateLoadError;
  const project = state.buildingChecks.find((item) => item.id === projectId);
  if (!project) throw new Error('The source checklist is no longer available.');
  const inspectionDate = nextMonthDate(project.inspectionDate);
  const monthKey = inspectionDate.slice(0, 7);
  const monthlyTemplateId = project.monthlyTemplateId || project.id;
  const existing = state.buildingChecks.find((item) =>
    (item.monthlyTemplateId || item.id) === monthlyTemplateId
      && (item.monthKey || item.inspectionDate.slice(0, 7)) === monthKey);
  if (existing) {
    navigateView('check-project', { projectId: existing.id });
    window.alert(`A checklist for ${formatMonth(monthKey)} already exists. It has been opened; no records were replaced.`);
    return;
  }
  const changedBy = String(window.prompt(`Who is starting the ${formatMonth(monthKey)} checklist?`, project.lastChangedBy || '') || '').trim();
  if (!changedBy) return;
  const createdAt = new Date().toISOString();
  const checks = project.checks.map((check) => ({
    ...check,
    id: crypto.randomUUID(),
    answer: '',
    status: 'open',
    condition: 'not-assessed',
    severity: 'not-assessed',
    notes: '',
    photos: [],
    reports: [],
    createdAt,
    updatedAt: createdAt,
    history: [{
      id: crypto.randomUUID(),
      createdAt,
      status: 'open',
      condition: 'not-assessed',
      severity: 'not-assessed',
      notes: `Monthly checklist started from ${formatMonth(project.monthKey || project.inspectionDate)}.`,
      changedBy,
      title: check.title,
      location: check.location,
      description: check.description,
      reference: check.reference,
      photoIds: []
    }]
  }));
  const nextProject = normalizeCheckProject({
    ...project,
    id: crypto.randomUUID(),
    inspectionDate,
    monthKey,
    monthlyTemplateId,
    sourceProjectId: project.id,
    lastChangedBy: changedBy,
    createdAt,
    updatedAt: createdAt,
    runStatus: 'draft',
    submittedBy: '',
    submittedAt: null,
    auditHistory: [{ id: crypto.randomUUID(), createdAt, changedBy, action: 'Started monthly form' }],
    reports: [],
    checks
  });
  if (await commit({ ...state, buildingChecks: [nextProject, ...state.buildingChecks] })) {
    navigateView('check-project', { projectId: nextProject.id });
  }
}

function openCreateCheckDialog() {
  const form = document.querySelector('#create-check-form');
  form.reset();
  document.querySelector('#create-check-dialog').showModal();
}

async function createCheck(form) {
  const project = state.buildingChecks.find((item) => item.id === activeCheckProjectId);
  if (!project) throw new Error('Open a building project before adding a check.');
  const values = new FormData(form);
  const title = String(values.get('title') || '').trim();
  const location = String(values.get('location') || '').trim();
  const description = String(values.get('description') || '').trim();
  const condition = String(values.get('condition') || 'not-assessed');
  if (!title) throw new Error('A check name is required.');
  const files = [...(form.elements.photos.files || [])];
  if (files.length > 10) throw new Error('Attach no more than 10 photos to one check.');
  const createdAt = new Date().toISOString();
  const photos = await Promise.all(files.map(async (file) => {
    if (!file.type.startsWith('image/')) throw new Error(`${file.name} is not an image file.`);
    if (file.size > 12 * 1024 * 1024) throw new Error(`${file.name} is larger than 12 MB.`);
    return {
      id: crypto.randomUUID(),
      data: await fileToDataUrl(file),
      caption: `${conditionLabel(condition)} condition`,
      createdAt
    };
  }));
  const check = {
    id: crypto.randomUUID(),
    title,
    location,
    description,
    category: '',
    reference: '',
    status: 'open',
    condition,
    severity: 'not-assessed',
    notes: '',
    photos,
    history: [{
      id: crypto.randomUUID(),
      createdAt,
      status: 'open',
      condition,
      severity: 'not-assessed',
      notes: 'Check item created.',
      title,
      location,
      description,
      photoIds: photos.map((photo) => photo.id)
    }],
    reports: [],
    createdAt,
    updatedAt: createdAt
  };
  const updatedProject = { ...project, checks: [...project.checks, check] };
  const buildingChecks = state.buildingChecks.map((item) => item.id === project.id ? updatedProject : item);
  if (await commit({ ...state, buildingChecks })) {
    form.reset();
    document.querySelector('#create-check-dialog').close();
    navigateView('check-project', { projectId: project.id });
  }
}

function openCheckUpdateDialog() {
  const project = state.buildingChecks.find((item) => item.id === activeCheckProjectId);
  const check = project?.checks.find((item) => item.id === activeCheckId);
  if (!check) return;
  const form = document.querySelector('#check-update-form');
  form.reset();
  form.elements.title.value = check.title;
  form.elements.location.value = check.location;
  form.elements.description.value = check.description;
  form.elements.reference.value = check.reference;
  form.elements.changedBy.value = project.lastChangedBy || '';
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
  const title = String(values.get('title') || '').trim();
  const location = String(values.get('location') || '').trim();
  const description = String(values.get('description') || '').trim();
  const reference = String(values.get('reference') || '').trim();
  const changedBy = String(values.get('changedBy') || '').trim();
  const status = String(values.get('status'));
  const condition = String(values.get('condition'));
  const severity = String(values.get('severity'));
  const notes = String(values.get('notes') || '').trim();
  if (!title || !changedBy) throw new Error('A check name and the editor name are required.');
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
      caption: notes || `${conditionLabel(condition)} · ${severity} severity`,
      createdAt: new Date().toISOString()
    };
  }));
  const createdAt = new Date().toISOString();
  const updated = {
    ...check,
    title,
    location,
    description,
    reference,
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
      notes: notes || 'Check details and condition updated.',
      changedBy,
      title,
      location,
      description,
      reference,
      photoIds: photos.map((photo) => photo.id)
    }]
  };
  const buildingChecks = state.buildingChecks.map((item) => item.id === project.id
    ? { ...item, lastChangedBy: changedBy, updatedAt: createdAt, checks: item.checks.map((child) => child.id === check.id ? updated : child) }
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
  const report = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    html: buildCheckReport(project, check),
    buildingName: project.buildingName,
    checkTitle: check.title
  };
  const updated = { ...check, reports: [...(check.reports || []), report] };
  const buildingChecks = state.buildingChecks.map((item) => item.id === project.id
    ? { ...item, checks: item.checks.map((child) => child.id === check.id ? updated : child) }
    : item);
  if (await commit({ ...state, buildingChecks })) {
    await downloadReport(report.html, { buildingName: `${project.buildingName}-${check.title}` }, report.id, reportMeta(project.buildingName, check.title, report.createdAt));
  }
}

async function downloadCheckTemplate() {
  const sample = [
    ['Check', 'Location', 'Description', 'Category', 'Reference', 'Condition', 'Severity'],
    ['Emergency lighting', 'North stairwell', 'Confirm emergency lighting test operation', 'Electrical', 'Site inspection schedule', 'Not assessed', 'Medium'],
    ['Handrail condition', 'Level 1 landing', 'Check fixings and surface condition', 'Access and egress', '', 'Bad', 'High']
  ].map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n');
  const filename = 'FG-Ops-Building-Checks-Template.csv';
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
  if (['good', 'fair', 'needs attention', 'poor', 'critical', 'bad'].includes(normalized)) return normalizeCheckCondition(normalized);
  throw new Error(`Unrecognized condition “${value}”${rowNumber ? ` in checklist row ${rowNumber}` : ''}. Use not assessed, good, needs attention, or bad.`);
}

function normalizeCheckCondition(value) {
  const normalized = normalizeImportHeader(value);
  if (normalized === 'good') return 'good';
  if (normalized === 'fair' || normalized === 'needs attention') return 'needs-attention';
  if (normalized === 'poor' || normalized === 'critical' || normalized === 'bad') return 'bad';
  return 'not-assessed';
}

function conditionLabel(condition) {
  return ({
    'not-assessed': 'Not assessed',
    good: 'Good',
    'needs-attention': 'Needs attention',
    bad: 'Bad'
  })[normalizeCheckCondition(condition)];
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
  document.querySelector('[data-view="users"]').classList.toggle('active', currentView === 'users');
  checksNav.classList.toggle('active', ['checks', 'property-checks', 'check-project', 'check-filter'].includes(currentView));
  surveyList.hidden = currentView !== 'lighting';
  document.querySelector('.rail-heading').hidden = currentView !== 'lighting';
  document.querySelector('#new-survey').hidden = currentView !== 'lighting';
  document.querySelector('#import-project').hidden = currentView !== 'lighting';
  if (currentView === 'home') {
    renderHome();
    return;
  }
  if (currentView === 'users') {
    if (currentUser?.role !== 'admin') {
      currentView = 'home';
      renderHome();
      return;
    }
    workspace.replaceChildren(userManagementSection);
    void loadUserManagement();
    return;
  }
  if (currentView === 'checks') {
    renderCheckProjects();
    return;
  }
  if (currentView === 'property-checks') {
    renderPropertyChecklists();
    return;
  }
  if (currentView === 'check-project') {
    renderCheckProject();
    return;
  }
  if (currentView === 'check-filter') {
    renderCheckFilter();
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
  surveyForm.elements.propertyId.innerHTML = currentUser?.role === 'admin'
    ? `<option value="">Select a building</option>${state.properties.map((property) => `<option value="${escapeHtml(property.id)}">${escapeHtml(property.name)}</option>`).join('')}`
    : state.properties.map((property) => `<option value="${escapeHtml(property.id)}">${escapeHtml(property.name)}</option>`).join('');
  surveyForm.elements.propertyId.value = survey?.propertyId || state.properties[0]?.id || '';
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
      `FG OPS  |  ${survey.buildingName}`,
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
    </style></head><body><header><div><p class="kicker">FG OPS / OHS RECORD</p><h1>Lighting Survey Report</h1>
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

function reportMeta(building, kind, createdAt, revision) {
  return { building, kind, date: localDateString(new Date(createdAt)), revision: revision || 1 };
}

async function downloadReport(report, survey, reportId, meta) {
  if (window.desktopApp?.saveReportPdf && meta) {
    const result = await window.desktopApp.saveReportPdf({ html: report, ...meta });
    if (result?.error) throw new Error(result.error);
    window.alert(`Report saved to:\n${result.path}`);
    return;
  }
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
  const filename = `FG-Ops-Project-${safeFileName(survey.buildingName)}.json`;
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
      text: `Editable FG Ops project: ${survey.buildingName}`,
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
    throw new Error('This file is not a supported FG Ops project package.');
  }
  const project = normalizeSurvey(bundle.project);
  const property = state.properties.find((item) => item.id === project.propertyId)
    || state.properties.find((item) => item.name.trim().toLocaleLowerCase() === project.buildingName.trim().toLocaleLowerCase());
  if (!property) throw new Error('This project does not match a building assigned to your account. Ask an administrator to assign that building first.');
  project.propertyId = property.id;
  project.buildingName = property.name;
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
    const reportCreatedAt = new Date().toISOString();
    const snapshot = JSON.parse(JSON.stringify({ ...survey, reports: [] }));
    const savedSurvey = {
      ...survey,
      reports: [...survey.reports, { id: reportId, createdAt: reportCreatedAt, html: report, projectSnapshot: snapshot }]
    };
    const surveys = state.surveys.map((item) => item.id === survey.id ? savedSurvey : item);
    if (!await commit({ ...state, surveys })) return;
    await downloadReport(report, survey, reportId, reportMeta(survey.buildingName, 'Lighting survey', reportCreatedAt));
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

function openSavedReportPreview(html, title) {
  const reportDocument = new DOMParser().parseFromString(html, 'text/html');
  reportPhotoSources = [...reportDocument.querySelectorAll('img[src^="data:image/"]')]
    .map((image) => ({
      source: image.getAttribute('src'),
      label: image.closest('figure')?.querySelector('figcaption')?.textContent.trim() || image.alt || ''
    }));
  const photoTools = document.querySelector('#report-photo-tools');
  const photoList = document.querySelector('#report-photo-list');
  const photoStatus = document.querySelector('#report-photo-status');
  photoList.replaceChildren();
  photoStatus.textContent = '';
  photoTools.hidden = reportPhotoSources.length === 0;
  reportPreviewDialog.classList.toggle('has-report-photos', reportPhotoSources.length > 0);
  reportPhotoSources.forEach((photo, index) => {
    const item = document.createElement('div');
    item.className = 'report-photo-copy-item';
    const thumbnail = document.createElement('img');
    thumbnail.src = photo.source;
    thumbnail.alt = photo.label || `Report photo ${index + 1}`;
    const label = document.createElement('span');
    label.textContent = photo.label || `Photo ${index + 1}`;
    const button = document.createElement('button');
    button.className = 'button secondary';
    button.type = 'button';
    button.dataset.copyReportPhoto = String(index);
    button.textContent = 'Copy photo';
    item.append(thumbnail, label, button);
    photoList.append(item);
  });
  document.querySelector('#saved-report-frame').srcdoc = restrictReportPreview(html);
  document.querySelector('#saved-report-title').textContent = title;
  reportPreviewDialog.showModal();
}

async function copyReportPhoto(index) {
  const photo = reportPhotoSources[index];
  if (!photo) return;
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('This browser cannot copy images to the clipboard. Open the report in a browser that supports image clipboard access.');
  }
  const imageBlob = await (await fetch(photo.source)).blob();
  const image = await createImageBitmap(imageBlob);
  const scale = Math.min(1, 4096 / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not prepare this report photo for copying.');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();
  const png = await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not encode this report photo.')), 'image/png');
  });
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  document.querySelector('#report-photo-status').textContent = 'Photo copied. Paste it into your document.';
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
  const button = event.target.closest('[data-action], [data-photo], [data-entry], [data-check-filter]');
  if (!button) return;
  if (button.dataset.checkFilter) {
    navigateView('check-filter', { filter: button.dataset.checkFilter });
    return;
  }
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
  if (button.dataset.action === 'select-property') {
    navigateView('property-checks', { propertyId: button.dataset.propertyId });
    return;
  }
  if (button.dataset.action === 'property-checklists') {
    navigateView('property-checks', { propertyId: activePropertyId });
    return;
  }
  if (button.dataset.action === 'start-property-template') {
    try {
      await startPropertyTemplate(activePropertyId, button.dataset.templateId);
    } catch (error) {
      alertError(error, 'Could not start this property checklist.');
    }
    return;
  }
  if (button.dataset.action === 'create-check-project') {
    openCheckProjectDialog();
    return;
  }
  if (button.dataset.action === 'import-checks') {
    const form = document.querySelector('#check-import-form');
    form.reset();
    form.elements.inspectionDate.value = new Date().toISOString().slice(0, 10);
    const property = state.properties.find((item) => item.id === activePropertyId);
    form.elements.propertyId.value = property?.id || '';
    form.elements.buildingName.value = property?.name || '';
    document.querySelector('#check-import-dialog').showModal();
    return;
  }
  if (button.dataset.action === 'open-check-project') {
    navigateView('check-project', { projectId: button.dataset.projectId });
    return;
  }
  if (button.dataset.action === 'start-next-month') {
    try {
      await createNextMonthlyChecklist(button.dataset.projectId);
    } catch (error) {
      alertError(error, 'Could not start the next monthly checklist.');
    }
    return;
  }
  if (button.dataset.action === 'add-check-to-list') {
    const list = document.querySelector('#checklist-edit-list');
    if (list.children.length >= 1000) {
      window.alert('A checklist can contain at most 1,000 items.');
      return;
    }
    const newCheck = {
      id: crypto.randomUUID(),
      title: '',
      location: '',
      description: '',
      reference: '',
      condition: 'not-assessed',
      severity: 'not-assessed',
      status: 'open',
      notes: '',
      photos: [],
      history: []
    };
    list.insertAdjacentHTML('beforeend', renderChecklistEditorRow(newCheck, list.children.length, true));
    list.lastElementChild.querySelector('[data-field="title"]').focus();
    return;
  }
  if (button.dataset.action === 'view-building-report' || button.dataset.action === 'download-building-report') {
    const project = state.buildingChecks.find((item) => item.id === activeCheckProjectId);
    const report = project?.reports?.find((item) => item.id === button.dataset.reportId);
    if (!project || !report) return;
    if (button.dataset.action === 'view-building-report') {
      openSavedReportPreview(report.html, report.title || `Building checklist report · ${formatDateTime(report.createdAt)}`);
    } else {
      try {
        await downloadReport(report.html, { buildingName: report.title || `${project.buildingName}-Building-Checklist` }, report.id, reportMeta(project.buildingName, project.templateTitle || 'Building checklist', report.createdAt, report.revision));
      } catch (error) {
        alertError(error, 'Could not export the saved building checklist report.');
      }
    }
    return;
  }
  if (button.dataset.action === 'update-check') {
    openCheckUpdateDialog();
    return;
  }
  if (button.dataset.action === 'view-check-report' || button.dataset.action === 'download-check-report') {
    const project = state.buildingChecks.find((item) => item.id === activeCheckProjectId);
    const check = project?.checks.find((item) => item.id === activeCheckId);
    const report = check?.reports?.find((item) => item.id === button.dataset.reportId);
    if (!project || !check || !report) return;
    if (button.dataset.action === 'view-check-report') {
      openSavedReportPreview(report.html, `Building check report · ${formatDateTime(report.createdAt)}`);
    } else {
      try {
        await downloadReport(report.html, { buildingName: `${project.buildingName}-${report.checkTitle || check.title}` }, report.id, reportMeta(project.buildingName, report.checkTitle || check.title, report.createdAt));
      } catch (error) {
        alertError(error, 'Could not export the saved building-check report.');
      }
    }
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

workspace.addEventListener('input', (event) => {
  const row = event.target.closest('.check-edit-row');
  if (!row) return;
  if (event.target.matches('[data-field="title"]')) {
    row.querySelector('[data-check-label]').textContent = event.target.value.trim() || 'New checklist item';
  }
});

workspace.addEventListener('change', (event) => {
  const row = event.target.closest('.check-edit-row');
  if (!row) return;
  if (event.target.matches('[data-field="condition"]')) {
    const label = row.querySelector('[data-condition-label]');
    label.textContent = conditionLabel(event.target.value);
    label.className = `condition-chip ${event.target.value}`;
  }
  if (event.target.matches('[data-field="status"]')) {
    row.querySelector('.status-chip').textContent = statusLabel(event.target.value);
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
document.querySelector('#theme-toggle').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});
document.querySelector('#home-button').addEventListener('click', () => navigateView('home'));
document.querySelector('#back-button').addEventListener('click', () => history.back());
window.addEventListener('popstate', (event) => {
  currentView = ['home', 'lighting', 'checks', 'users', 'property-checks', 'check-project', 'check-filter'].includes(event.state?.view)
    ? event.state.view
    : 'home';
  activeCheckProjectId = event.state?.projectId || null;
  activeCheckId = event.state?.checkId || null;
  activeCheckFilter = event.state?.filter || null;
  activePropertyId = event.state?.propertyId || null;
  activeTemplateId = event.state?.templateId || null;
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
document.querySelector('#check-project-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await createCheckProject(event.currentTarget);
  } catch (error) {
    alertError(error, 'Could not create the building-check project.');
  }
});
document.querySelector('#manual-check-list').addEventListener('click', (event) => {
  if (event.target.closest('[data-remove-manual-check]')) {
    const list = document.querySelector('#manual-check-list');
    if (list.children.length > 1) event.target.closest('.manual-check-row').remove();
    return;
  }
});
document.querySelector('#add-manual-check').addEventListener('click', addManualCheckRow);
document.querySelector('#close-check-project').addEventListener('click', () => document.querySelector('#check-project-dialog').close());
document.querySelector('#cancel-check-project').addEventListener('click', () => document.querySelector('#check-project-dialog').close());
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
    openSavedReportPreview(report.html, `Saved report · ${formatDateTime(report.createdAt)}`);
  } else if (button.dataset.reportAction === 'download') {
    try {
      await downloadReport(report.html, survey, report.id, reportMeta(survey.buildingName, 'Lighting survey', report.createdAt));
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
reportPreviewDialog.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy-report-photo]');
  if (!button) return;
  const status = document.querySelector('#report-photo-status');
  button.disabled = true;
  status.textContent = 'Copying photo…';
  try {
    await copyReportPhoto(Number(button.dataset.copyReportPhoto));
  } catch (error) {
    status.textContent = error.message || 'Could not copy this photo.';
  } finally {
    button.disabled = false;
  }
});

surveyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await stateReady;
  if (stateLoadError) {
    alertError(stateLoadError, 'Project storage is unavailable. No changes were saved.');
    return;
  }
  const form = new FormData(surveyForm);
  const propertyId = String(form.get('propertyId') || '').trim();
  const property = state.properties.find((item) => item.id === propertyId);
  const buildingName = property?.name || '';
  const inspectorName = String(form.get('inspectorName') || '').trim();
  const inspectionDate = String(form.get('inspectionDate') || '').trim();
  if (!property || !inspectorName || !inspectionDate) {
    window.alert('Building, Inspector Name, and inspection date are required.');
    return;
  }
  const previous = state.surveys.find((survey) => survey.id === editingSurveyId);
  const project = previous
    ? { ...previous, propertyId, buildingName, inspectorName, inspectionDate }
    : {
      id: crypto.randomUUID(),
      propertyId,
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
  if (event.target.id === 'monthly-template-form') {
    event.preventDefault();
    try {
      await saveMonthlyTemplate(event.target, event.submitter?.dataset.submitMonthly === 'true');
    } catch (error) {
      alertError(error, 'Could not save the monthly property checklist.');
    }
    return;
  }
  if (event.target.id === 'checklist-edit-form' || event.target.matches('[data-filtered-project-form]')) {
    event.preventDefault();
    try {
      await saveBuildingChecklist(event.target, event.submitter?.dataset.exportReport === 'true');
    } catch (error) {
      alertError(error, 'Could not save the building checklist.');
    }
    return;
  }
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

document.addEventListener('input', (event) => {
  if (event.target.id !== 'manual-lux') return;
  event.target.dataset.source = 'manual';
  event.target.dataset.sensorLux = '';
  event.target.dataset.sensorTime = '';
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
    if (file.size > 12 * 1024 * 1024) throw new Error('Photos must be smaller than 12 MB.');
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
applyTheme(preferredTheme(), false);
render();
stateReady = loadState().catch((error) => {
  stateLoadError = error;
  render();
});
void initializeAuthentication().catch((error) => {
  console.error('Authentication initialization failed:', error);
  showSignIn('Could not initialize the app. Check the backend connection and try again.');
});
