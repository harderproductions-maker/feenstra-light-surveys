import { Capacitor, registerPlugin } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { readSheet as readXlsxFile } from 'read-excel-file/browser';
import { wireChecklistTemplates } from './checklist-templates.mjs';
import { wireSubscriptions } from './subscriptions.mjs';
import { wireCompanyFeatures } from './company-features.mjs';
import legacy from './legacy-identifiers.json' with { type: 'json' };
import { migrateLocalSettings, migrateLegacyDatabase, isPrimaryCompany } from './product-migration.mjs';
import { wireDeviceTransfer } from './device-transfer.mjs';
import { createApplianceView } from './appliances.js';
import { createOfflineStore } from './offline.mjs';
import { permissionKey } from './building-access.mjs';
import { remap } from './offline-views.mjs';
import { createOfflineAuth, isServerUnavailable } from './offline-auth.mjs';
import { createAndroidUpdater } from './app-updates.mjs';
import { reportDocument, reportBadge } from './report-layout.mjs';
import { wireProfilePhoto } from './profile-photo.mjs';
import { accountSections, canUseSection, sectionsFor, canDelegateAccounts, accountBuildingIds, isManagerRole, isManagementRole, managerProfiles } from './account-access.mjs';
import { navigationPicture, sectionTabs, sectionPanel, wireSectionTabs, resetSectionTabs } from './section-navigation.mjs';
import { createLicenceClient } from './licence.mjs';
import { createOperationsView, operationIds, residentLabel, residentTypeField } from './operations.mjs';
import { pdfTableRows } from './checklist-import.mjs';
import { statementHtml as platformStatementHtml, statementLedgerHtml } from './platform-account.mjs';
import { importBillingFile } from './billing-import.mjs';
import { resolveClient, signInClient } from './client-sign-in.mjs';
import { createLeasingView } from './leasing.mjs';

const LightSensor = registerPlugin('LightSensor');
const CameraCapture = registerPlugin('CameraCapture');
const PdfReport = registerPlugin('PdfReport');
const SupplierEmail = registerPlugin('SupplierEmail');
const AppUpdates = registerPlugin('AppUpdates');
const companyCodeKey = 'primeops-company-code';
migrateLocalSettings(localStorage);
const checkCatalog = { properties: [], templates: [] };
function selectedCompany() { return (localStorage.getItem(companyCodeKey) || '').trim().toUpperCase(); }
const companySuffix = isPrimaryCompany(selectedCompany()) ? '' : `-${selectedCompany()}`;
const storageKey = `primeops-v1${companySuffix}`;
const databaseName = `primeops${companySuffix}`;
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
const themeStorageKey = 'primeops-theme';
const authTokenKey = `primeops-token${companySuffix}`;
const cachedUserKey = `primeops-user${companySuffix}`;
const cachedServerKey = `primeops-server${companySuffix}`;

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
wireSectionTabs(document);
for (const button of document.querySelectorAll('.module-nav [data-view]')) {
  button.insertAdjacentHTML('afterbegin', navigationPicture(button.dataset.view));
}
document.querySelector('#section-menu-toggle').insertAdjacentHTML('afterbegin', navigationPicture('home'));
document.querySelector('#section-menu-toggle').addEventListener('click', (event) => {
  const button = event.currentTarget;
  const open = button.getAttribute('aria-expanded') !== 'true';
  button.setAttribute('aria-expanded', String(open));
  document.querySelector('.module-nav').classList.toggle('is-open', open);
});
document.querySelector('.module-nav').addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  document.querySelector('.module-nav').classList.remove('is-open');
  document.querySelector('#section-menu-toggle').setAttribute('aria-expanded', 'false');
  document.querySelector('#section-menu-toggle').focus();
});
document.querySelector('#user-section-tabs').innerHTML = sectionTabs('users', 'User management sections',
  [['accounts', 'Find users'], ['create', 'Add a user'], ['buildings', 'Add a building']]);
document.querySelector('#create-user-tabs').innerHTML = sectionTabs('create-user', 'New account sections',
  [['details', 'Account details'], ['access', 'Buildings & access']]);
let activeCheckProjectId = null;
let activeCheckId = null;
let activeCheckFilter = null;
let activePropertyId = null;
let activeTemplateId = null;
let ticketCameraStream = null;
let ticketCameraId = null;
let ticketCapturedPhoto = '';
let ticketPhotoObjectUrl = '';
let ticketRecords = [];
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
let authGeneration = 0;
let workspaceRevision = null;
let offlineMode = false;
let reconnectPromise = null;
let offlineMappingVersion = '';
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

function openDatabase(name = databaseName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('workspace');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local survey storage.'));
  });
}

const databaseReady = openDatabase().then(async (connection) => {
  await migrateLegacyDatabase(connection, companySuffix);
  database = connection;
  return connection;
});
wireDeviceTransfer({
  getDatabase: () => database, getCompany: () => isPrimaryCompany(selectedCompany()) ? '' : selectedCompany(),
  getUser: () => currentUser, ready: () => Promise.all([databaseReady, stateReady]),
  saveNativeBackup: Capacitor.isNativePlatform() ? async (contents, filename) => {
    const saved = await Filesystem.writeFile({ path: filename, data: contents, directory: Directory.Cache, encoding: Encoding.UTF8 });
    await Share.share({ title: 'PrimeOps device backup', url: saved.uri, dialogTitle: 'Save encrypted device backup' });
  } : null
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

const serverUrlKey = 'primeops-server-url';

function savedServerUrl() {
  try { return localStorage.getItem(serverUrlKey) || ''; } catch { return ''; }
}

function apiUrl(path) {
  const base = String(savedServerUrl() || window.APP_CONFIG?.apiBaseUrl || import.meta.env.VITE_API_BASE_URL || window.location.origin).replace(/\/+$/, '');
  const company = selectedCompany();
  return `${base}${isPrimaryCompany(company) ? '' : `/c/${encodeURIComponent(company)}`}${path}`;
}

async function sendApiRequest(path, options = {}) {
  if (!path.startsWith('/api/license') && !path.startsWith('/api/app-updates/')) licenceClient.assertActive();
  const requestSession = `${authGeneration}:${authToken}:${apiUrl('')}`;
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
  if (options.auth !== false && requestSession !== `${authGeneration}:${authToken}:${apiUrl('')}`) {
    throw new Error('The signed-in account changed. Reopen this screen.');
  }
  if (!response.ok) {
    if (response.status === 423 && result.code === 'LICENSE_REQUIRED') licenceClient.block(result.error);
    if (response.status === 423 && result.code === 'ACCOUNT_ARREARS' && currentUser) {
      currentUser = { ...currentUser, billingBlocked: true };
      localStorage.setItem(cachedUserKey, JSON.stringify(currentUser));
      await offlineAuth.refresh({ token: authToken, user: currentUser });
      showBillingBlocked(currentUser);
    }
    const error = new Error(result.error || `The backend returned ${response.status}.`);
    error.status = response.status;
    error.payload = result;
    throw error;
  }
  return result;
}

let licenceExpiryTimer;
const licenceClient = createLicenceClient({
  storage: {
    get: (key) => databaseRequest('readonly', (store) => store.get(key)),
    set: (key, value) => databaseRequest('readwrite', (store) => store.put(value, key))
  },
  getServer: () => apiUrl(''), request: sendApiRequest,
  onChange: updateLicenceScreen
});

function updateLicenceScreen(licence) {
  clearTimeout(licenceExpiryTimer);
  if (licence.active && licence.expiresAt) {
    licenceExpiryTimer = setTimeout(() => licenceClient.check(), Math.max(1, Math.min(2147483647, Date.parse(licence.expiresAt) - Date.now())));
  }
  document.querySelectorAll('[data-licence-system]').forEach((element) => { element.textContent = licence.systemId || 'Connect to the server to obtain its ID'; });
  document.querySelectorAll('[data-licence-message]').forEach((element) => { element.textContent = licence.message; });
  document.querySelector('#licence-expiry').textContent = licence.expiresAt ? new Date(licence.expiresAt).toLocaleString() : 'Not activated';
  document.querySelector('#licence-download').disabled = !licence.token;
  document.querySelector('#licence-renewal-options').hidden = !licence.ownerRegistered;
  document.querySelector('#licence-test-renew').hidden = !licence.testRenewalEnabled;
  document.querySelectorAll('[data-company-name]').forEach((element) => { element.textContent = licence.companyName || selectedCompany(); });
  document.querySelector('#licence-screen').hidden = licence.active || !currentUser;
  const warning = document.querySelector('#licence-warning');
  warning.hidden = !licence.active || !licence.warning || !isManagementRole(currentUser?.role)
    || document.querySelector('#app-shell').hidden;
  warning.querySelector('[data-licence-warning]').textContent = licence.warning
    ? `System licence expires within ${licence.warning} (${new Date(licence.expiresAt).toLocaleString()}). Ask the owner to generate a renewal token.` : '';
  if (!licence.active) {
    document.querySelector('#platform-account-screen').hidden = true;
    document.querySelector('#auth-screen').hidden = !!currentUser;
    document.querySelector('#app-shell').hidden = true;
    for (const dialog of document.querySelectorAll('dialog[open]:not(#licence-dialog)')) dialog.close();
    document.querySelector('#licence-server').value = savedServerUrl();
  }
}

async function checkSystemLicence() {
  const wasActive = licenceClient.state().active;
  try {
    if (await licenceClient.refresh()) {
      if (!wasActive) await initializeAuthentication();
    }
  } catch (error) {
    console.error('System licence check failed:', error);
    licenceClient.block(`Could not verify the licence: ${error.message}`);
    return;
  }
  if (licenceClient.state().active && currentUser && authToken && navigator.onLine !== false) {
    try {
      const { user } = await sendApiRequest('/api/auth/me');
      if (user.billingBlocked) {
        currentUser = user;
        localStorage.setItem(cachedUserKey, JSON.stringify(user));
        await offlineAuth.refresh({ token: authToken, user });
        showBillingBlocked(user);
      } else if (currentUser.billingBlocked) await initializeAuthentication();
    } catch (error) {
      console.error('Client account access check failed:', error);
      if (error.status === 401) showSignIn(error.message);
    }
  }
}

document.querySelectorAll('[data-open-licence]').forEach((button) => button.addEventListener('click', () => {
  licenceClient.check();
  document.querySelector('#licence-status').textContent = '';
  document.querySelector('#licence-dialog').showModal();
}));
document.querySelectorAll('[data-company-code]').forEach((input) => { input.value = selectedCompany() || legacy.defaultClientCode; });
document.querySelectorAll('[data-change-company]').forEach((button) => button.addEventListener('click', () => {
  const code = button.closest('[data-company-selector]').querySelector('[data-company-code]').value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,39}$/.test(code)) { window.alert('Enter a valid company code.'); return; }
  localStorage.setItem(companyCodeKey, code);
  window.location.reload();
}));
document.querySelector('#licence-renewal-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = event.submitter;
  if (!button) return;
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach((element) => { element.disabled = true; });
  try {
    const active = await licenceClient.renew({ mode: button.value, username: form.elements.username.value, password: form.elements.password.value });
    form.elements.password.value = '';
    document.querySelector('#licence-status').textContent = button.value === 'test' ? 'Test renewal activated.' : 'Renewal requested.';
    if (active && button.value === 'test') {
      document.querySelector('#licence-dialog').close();
      await initializeAuthentication();
    }
  } catch (error) {
    document.querySelector('#licence-status').textContent = error.message || 'Renewal failed.';
  } finally { buttons.forEach((element) => { element.disabled = false; }); }
});
document.querySelector('#licence-close').addEventListener('click', () => document.querySelector('#licence-dialog').close());
document.querySelector('#licence-recheck').addEventListener('click', () => { void checkSystemLicence(); });
document.querySelector('#licence-change-server').addEventListener('click', () => {
  try {
    const entered = document.querySelector('#licence-server').value.trim();
    if (entered) {
      const url = new URL(entered);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS server address.');
      localStorage.setItem(serverUrlKey, url.origin);
    } else localStorage.removeItem(serverUrlKey);
    serverUrlInput.value = savedServerUrl();
    licenceClient.block('Checking the selected server licence.');
    void checkSystemLicence();
  } catch (error) { window.alert(error.message || 'Enter a valid server address.'); }
});
document.querySelector('#licence-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type=submit]');
  button.disabled = true;
  try {
    if (await licenceClient.activate(form.elements.token.value.trim())) {
      form.reset();
      document.querySelector('#licence-dialog').close();
      await initializeAuthentication();
    }
  } catch (error) {
    document.querySelector('#licence-status').textContent = error.message || 'Could not activate the licence.';
  } finally { button.disabled = false; }
});
document.querySelector('#licence-download').addEventListener('click', () => {
  const licence = licenceClient.state();
  if (!licence.token) return;
  const url = URL.createObjectURL(new Blob([`${licence.token}\n`], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `PrimeOps-current-licence-${licence.systemId}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
for (const name of ['click', 'submit', 'change', 'keydown']) {
  document.addEventListener(name, (event) => {
    if (event.target.closest('#auth-screen, #licence-screen, #licence-dialog, #android-update-banner, [data-company-selector]')) return;
    if (!licenceClient.check()) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
}
window.setInterval(() => { void licenceClient.checkpoint().catch((error) => licenceClient.block(`Could not retain licence verification: ${error.message}`)); }, 30000);
window.setInterval(() => { void checkSystemLicence(); }, 60000);
window.addEventListener('online', () => { void checkSystemLicence(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    licenceClient.check();
    void checkSystemLicence();
  } else void licenceClient.checkpoint().catch((error) => console.error('Licence checkpoint failed:', error));
});

const offlineStore = createOfflineStore({
  storage: {
    get: (key) => databaseRequest('readonly', (store) => store.get(key)),
    set: (key, value) => databaseRequest('readwrite', (store) => store.put(value, key))
  },
  send: sendApiRequest,
  getUser: () => currentUser,
  getSession: () => `${authGeneration}:${authToken}`,
  getServer: () => apiUrl(''),
  notify: updateOfflineStatus
});

const offlineAuth = createOfflineAuth({
  storage: {
    get: (key) => databaseRequest('readonly', (store) => store.get(key)),
    set: (key, value) => databaseRequest('readwrite', (store) => store.put(value, key))
  },
  getServer: () => apiUrl(''),
  authenticate: async (email, password) => {
    if (navigator.onLine === false) throw new TypeError('The device is offline.');
    const result = await sendApiRequest('/api/auth/login', {
      method: 'POST', auth: false, body: { email, password }
    });
    authToken = result.token;
    const { user } = await sendApiRequest('/api/auth/me');
    return { token: result.token, user };
  }
});

const androidUpdater = Capacitor.getPlatform() === 'android' ? createAndroidUpdater({
  native: AppUpdates,
  request: sendApiRequest,
  getServer: () => apiUrl(''),
  notify: ({ message, visible, canInstall = false }) => {
    const banner = document.querySelector('#android-update-banner');
    banner.hidden = !visible;
    banner.querySelector('[data-update-message]').textContent = message;
    banner.querySelector('[data-install-update]').hidden = !canInstall;
  }
}) : null;

document.querySelectorAll('[data-check-app-updates]').forEach((button) => {
  button.hidden = !androidUpdater;
  button.addEventListener('click', () => { void androidUpdater.check(true); });
});
const androidDownload = document.querySelector('#download-android-app');
const androidDownloadNote = document.querySelector('#download-android-app-note');
androidDownload.hidden = Capacitor.isNativePlatform();
androidDownloadNote.hidden = Capacitor.isNativePlatform();
document.querySelector('[data-install-update]').addEventListener('click', async () => {
  if (!androidUpdater || !window.confirm('Save any open form before continuing. Android will ask you to confirm Update and may close the app. Saved projects and pending uploads will be kept. Continue?')) return;
  try {
    await androidUpdater.install();
  } catch (error) {
    alertError(error, 'Could not install the Android update.');
  }
});
if (androidUpdater) {
  void androidUpdater.check();
  window.addEventListener('online', () => { void androidUpdater.check(true); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void androidUpdater.check();
  });
  window.setInterval(() => { void androidUpdater.check(); }, 300000);
}

async function apiRequest(path, options = {}) {
  licenceClient.assertActive();
  if (/\/api\/tickets\/[^/]+\/access$/.test(path)) {
    if (!navigator.onLine || offlineMode || path.includes('local-')) throw new Error('Connect to the server before changing apartment access permission.');
  }
  return offlineStore.request(path, options);
}

function checklistCacheKey(user) { return `check-templates:${apiUrl('')}:${user.id}:${permissionKey(user)}`; }
async function loadCheckTemplates(user, offline = false) {
  const server = apiUrl('');
  const generation = authGeneration;
  const key = checklistCacheKey(user);
  if (!canUseSection(user, 'checks')) { checkCatalog.templates = []; return; }
  const templates = offline
    ? await databaseRequest('readonly', (store) => store.get(key)) || []
    : (await apiRequest('/api/check-templates')).templates;
  if (currentUser?.id !== user.id || apiUrl('') !== server || authGeneration !== generation) throw new Error('The account changed. Reopen checklists.');
  checkCatalog.templates = templates;
  if (!offline) await databaseRequest('readwrite', (store) => store.put(templates, key));
}
wireChecklistTemplates({
  getUser: () => currentUser, getProperties: () => state.properties, getTemplates: () => checkCatalog.templates,
  getPropertyId: () => activePropertyId, apiRequest, escape: escapeHtml, readSpreadsheet: readXlsxFile,
  readPdf: (file, status) => readPdfChecklistRows(file, status, true),
  readImage: readChecklistImage,
  reload: async () => { await loadCheckTemplates(currentUser); render(); }
});
wireSubscriptions({
  apiRequest, getUser: () => currentUser,
  getContext: () => `${apiUrl('')}:${currentUser?.id}:${authGeneration}`, escape: escapeHtml
});
wireCompanyFeatures({
  apiRequest, getUser: () => currentUser,
  getContext: () => `${apiUrl('')}:${currentUser?.id}:${authGeneration}`, escape: escapeHtml,
  refreshUser: () => reconnectOffline({ fresh: true })
});
const operationsView = createOperationsView({
  workspace, apiRequest: sendApiRequest, getUser: () => currentUser, escape: escapeHtml,
  readers: (status, sheet = 1) => ({ readSpreadsheet: (file) => readXlsxFile(file, sheet),
    readPdf: (file) => readPdfChecklistRows(file, status, true), readImage: (file) => readChecklistImage(file, status) }),
  printDocument,
  canCreateAssetTickets: () => isManagementRole(currentUser?.role) && canUseSection(currentUser, 'tickets'),
  getContext: () => `${apiUrl('')}:${currentUser?.id}:${authGeneration}:${currentView}`
});
const leasingView = createLeasingView({
  workspace, apiRequest: sendApiRequest, escape: escapeHtml,
  readers: (status, sheet = 1) => ({ readSpreadsheet: (file) => readXlsxFile(file, sheet),
    readPdf: (file) => readPdfChecklistRows(file, status, true), readImage: (file) => readChecklistImage(file, status) }),
  getUser: () => currentUser,
  getContext: () => `${apiUrl('')}:${currentUser?.id}:${authGeneration}:${currentView}`,
  download: async (path, filename) => {
    const expected = `${apiUrl('')}:${currentUser?.id}:${authGeneration}:${currentView}`;
    const response = await fetch(apiUrl(path), { headers: { Authorization: `Bearer ${authToken}` }, signal: AbortSignal.timeout(60000) });
    if (!response.ok) {
      const body = await response.json();
      throw new Error(body.error || 'Could not download the leasing export.');
    }
    const blob = await response.blob();
    if (expected !== `${apiUrl('')}:${currentUser?.id}:${authGeneration}:${currentView}`) throw new Error('Account or section changed. Open the export again from the intended account.');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
});
function templatesForBuilding(id) { return checkCatalog.templates.filter((template) => !template.propertyIds?.length || template.propertyIds.includes(id)); }
function projectTemplate(project) {
  return checkCatalog.templates.find((template) => template.id === project.templateId)
    || { id: project.templateId, title: project.templateTitle || 'Checklist', sourceColumns: project.sourceColumns, questions: project.checks.map((check) => ({
      id: check.templateQuestionId, label: check.title, type: check.responseType, photo: check.photo
    })) };
}

function updateOfflineStatus(saved, message = '') {
  const banner = document.querySelector('#offline-banner');
  if (!banner || !currentUser || currentUser.billingBlocked) return;
  const pending = saved.jobs.filter((job) => job.state !== 'confirmed');
  const rejected = pending.find((job) => job.state === 'blocked');
  banner.hidden = false;
  banner.querySelector('[data-offline-summary]').textContent = pending.length
    ? `${pending.length} change(s) saved on this device - awaiting server confirmation. ${rejected ? `Upload needs attention: ${rejected.error} Open Pending changes. ` : ''}${message}`
    : message || (offlineMode || navigator.onLine === false ? 'Offline - working with downloaded data.' : 'Offline copy ready. No pending uploads.');
}

async function reconnectOffline({ fresh = false } = {}) {
  if (reconnectPromise) {
    await reconnectPromise;
    if (!fresh) return;
  }
  if (!currentUser || !authToken || navigator.onLine === false) return;
  const pending = performReconnect();
  reconnectPromise = pending;
  try { await pending; }
  finally { if (reconnectPromise === pending) reconnectPromise = null; }
}
async function performReconnect() {
  const accountId = currentUser.id;
  const token = authToken;
  const server = apiUrl('');
  const sameSession = () => currentUser?.id === accountId && authToken === token && apiUrl('') === server;
  try {
    const { user } = await sendApiRequest('/api/auth/me');
    if (!sameSession()) return;
    const permissionsChanged = permissionKey(currentUser) !== permissionKey(user);
    const settingsChanged = JSON.stringify(currentUser.companySettings) !== JSON.stringify(user.companySettings);
    currentUser = user;
    if (user.billingBlocked) {
      localStorage.setItem(cachedUserKey, JSON.stringify(user));
      await offlineAuth.refresh({ token: authToken, user });
      showBillingBlocked(user);
      return;
    }
    if (settingsChanged) {
      applyResidentLabels(user);
      if (currentView === 'home') renderHome();
    }
    if (permissionsChanged) profilePhoto.reset();
    void profilePhoto.load();
    localStorage.setItem(cachedUserKey, JSON.stringify(user));
    await offlineAuth.refresh({ token: authToken, user });
    if (!sameSession()) return;
    if (permissionsChanged) {
      checkCatalog.templates = [];
      const metadata = await readSyncMetadata();
      if (!sameSession()) return;
      await persistHydratedWorkspace(scopeStateToUser(state, user), { ...metadata, userId: user.id });
      document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
      document.querySelector('#ticket-photo-image').removeAttribute('src');
      if (ticketPhotoObjectUrl) URL.revokeObjectURL(ticketPhotoObjectUrl);
      ticketPhotoObjectUrl = '';
      currentView = 'home';
      showSignedIn(user);
    }
    offlineMode = false;
    await loadCheckTemplates(user);
    await offlineStore.sync();
    const offline = await offlineStore.status();
    const mappingVersion = `${apiUrl('')}:${user.id}:${JSON.stringify(offline.ids)}`;
    if (Object.keys(offline.ids).length && mappingVersion !== offlineMappingVersion) {
      state = remap(state, offline.ids);
      await databaseRequest('readwrite', (store) => store.put(state, 'state'));
      offlineMappingVersion = mappingVersion;
    }
    if (hasOpsAccess()) await syncWorkspace();
    await offlineStore.warm();
    if (androidUpdater) void androidUpdater.check();
    updateOfflineStatus(await offlineStore.status());
  } catch (error) {
    console.error('Reconnect failed:', error);
    if (currentUser) updateOfflineStatus(await offlineStore.status(), error.status === 401
      ? 'Sign in again to upload saved work. Your pending changes are still on this device.'
      : 'Server unavailable. Downloaded data and pending changes remain on this device.');
  }
}

document.querySelector('#offline-sync').addEventListener('click', () => { void reconnectOffline(); });
document.querySelector('#offline-review').addEventListener('click', async () => {
  try {
    const saved = await offlineStore.status();
    const dialog = document.querySelector('#offline-dialog');
    dialog.querySelector('[data-offline-jobs]').innerHTML = saved.jobs.filter((job) => job.state !== 'confirmed').map((job) => `<li>
      <strong>${escapeHtml(job.method)} ${escapeHtml(job.path)}</strong><p>${escapeHtml(formatDateTime(job.createdAt))} - ${escapeHtml(job.state)}</p>
      ${job.error ? `<p role="alert">${escapeHtml(job.error)}</p>` : ''}
      <button type="button" class="button secondary" data-offline-retry="${escapeHtml(job.id)}">Retry</button>
      <button type="button" class="button secondary" data-offline-discard="${escapeHtml(job.id)}">Discard this and later changes</button></li>`).join('') || '<li>No pending changes.</li>';
    dialog.showModal();
  } catch (error) { alertError(error, 'Could not load saved changes.'); }
});
document.querySelector('#offline-close').addEventListener('click', () => document.querySelector('#offline-dialog').close());
document.querySelector('#offline-dialog').addEventListener('click', async (event) => {
  const retry = event.target.closest('[data-offline-retry]');
  const discard = event.target.closest('[data-offline-discard]');
  if (!retry && !discard) return;
  try {
    if (discard) {
      if (!window.confirm('Delete this unsent change and all later queued changes? Later changes may depend on it. Uploaded changes are not undone.')) return;
      await offlineStore.discard(discard.dataset.offlineDiscard);
    } else await offlineStore.retry(retry.dataset.offlineRetry);
    document.querySelector('#offline-dialog').close();
    render();
  } catch (error) { alertError(error, 'Could not update the sync queue.'); }
});
window.setInterval(() => { void reconnectOffline(); }, 30000);

function setSyncStatus(label, message, stateName = '') {
  const indicator = document.querySelector('#sync-status');
  if (!indicator) return;
  indicator.innerHTML = `<span></span> ${escapeHtml(label)}`;
  indicator.title = message;
  indicator.dataset.syncState = stateName;
  indicator.setAttribute('aria-label', message);
}

async function readSyncMetadata() {
  const metadata = await databaseRequest('readonly', (store) => store.get('sync-meta'));
  const server = metadata?.server || localStorage.getItem(cachedServerKey);
  return server && server !== apiUrl('') ? null : metadata;
}

async function writeSyncMetadata(metadata) {
  return databaseRequest('readwrite', (store) => store.put({ ...metadata, server: apiUrl('') }, 'sync-meta'));
}

function scopeStateToUser(source, user) {
  const allowed = new Set(user.role === 'admin' ? source.properties.map((property) => property.id) : user.propertyIds || []);
  const propertyByName = new Map(source.properties.map((property) => [property.name.trim().toLocaleLowerCase(), property.id]));
  const scopedPropertyId = (record) => record.propertyId || propertyByName.get(String(record.buildingName || '').trim().toLocaleLowerCase());
  return {
    ...source,
    properties: source.properties.filter((property) => allowed.has(property.id)),
    surveys: source.surveys.filter((survey) => hasOpsAccess(user) && canUseSection(user, 'lighting') && allowed.has(scopedPropertyId(survey)))
      .map((survey) => ({ ...survey, propertyId: scopedPropertyId(survey) })),
    buildingChecks: source.buildingChecks.filter((project) => hasOpsAccess(user) && canUseSection(user, 'checks') && allowed.has(scopedPropertyId(project)))
      .map((project) => ({ ...project, propertyId: scopedPropertyId(project) }))
  };
}

function hasFullAccess(user = currentUser) {
  return isManagementRole(user?.role);
}

function hasOpsAccess(user = currentUser) {
  return (isManagementRole(user?.role) || user?.role === 'maintenance_assistant')
    && (canUseSection(user, 'lighting') || canUseSection(user, 'checks'));
}

function showSignedIn(user) {
  if (!licenceClient.check()) return;
  if (user.billingBlocked) { showBillingBlocked(user); return; }
  document.querySelector('#platform-account-screen').hidden = true;
  document.querySelector('#platform-account-button').hidden = user.role !== 'admin';
  if (currentUser?.id !== user.id) ticketListView = 'active';
  currentUser = user;
  profilePhoto.reset();
  void profilePhoto.load();
  document.querySelector('#technician-alert-banner').hidden = !isManagerRole(user.role) || !canUseSection(user, 'appliances');
  if (isManagerRole(user.role) && canUseSection(user, 'appliances')) void checkTechnicianAlerts();
  document.querySelector('#auth-screen').hidden = true;
  document.querySelector('#app-shell').hidden = false;
  licenceClient.check();
  document.querySelector('#account-summary').textContent = `${user.name} · ${user.email} · ${roleLabel(user.role)}`;
  document.querySelector('#users-nav').hidden = !canUseSection(user, 'users');
  document.querySelector('#storage-nav').hidden = user.role !== 'admin';
  document.querySelectorAll('#create-user-form option').forEach((option) => {
    if (!isManagerRole(option.value)) return;
    option.hidden = !canDelegateAccounts(user);
    option.disabled = !canDelegateAccounts(user);
  });
  document.querySelector('#billing-nav').hidden = !canUseSection(user, 'billing');
  document.querySelector('[data-view="leasing"]').hidden = !canUseSection(user, 'leasing');
  document.querySelector('[data-view="appliances"]').hidden = !canUseSection(user, 'appliances');
  document.querySelector('[data-view="tickets"]').hidden = !canUseSection(user, 'tickets');
  document.querySelector('[data-view="log-ticket"]').hidden = !canUseSection(user, 'tickets') || (!hasFullAccess(user) && user.role !== 'user');
  for (const id of operationIds) document.querySelector(`[data-view="${id}"]`).hidden = !canUseSection(user, id);
  applyResidentLabels(user);
  render();
  void reconnectOffline();
  void offlineStore.status().then((saved) => updateOfflineStatus(saved)).catch((error) => alertError(error, 'Could not load offline data.'));
}

function applyResidentLabels(user) {
  document.querySelector('[data-view="residents"] span').textContent = residentLabel(user.companySettings, true);
  document.querySelector('#create-user-form option[value=user]').textContent = residentLabel(user.companySettings);
  document.querySelector('#create-resident-type').innerHTML = residentTypeField(user.companySettings);
}

let technicianAlertsBusy = false;
async function checkTechnicianAlerts() {
  const banner = document.querySelector('#technician-alert-banner');
  if (!currentUser || !isManagerRole(currentUser.role) || !canUseSection(currentUser, 'appliances')) {
    banner.hidden = true;
    return;
  }
  if (technicianAlertsBusy || navigator.onLine === false) return;
  const owner = `${authGeneration}:${authToken}:${apiUrl('')}:${currentUser.id}:${permissionKey(currentUser)}`;
  technicianAlertsBusy = true;
  try {
    const data = await apiRequest('/api/technician-attendance?alerts=true');
    if (owner !== `${authGeneration}:${authToken}:${apiUrl('')}:${currentUser?.id}:${permissionKey(currentUser)}`) return;
    const alerts = data.rows.filter((row) => (row.kind === 'extra' && !row.cancelled_at)
      || (['missed', 'incomplete'].includes(row.status) && !row.rebooked_as));
    const key = `technician-alerts-v1:${apiUrl('')}:${currentUser.id}`;
    const seen = new Set(JSON.parse(localStorage.getItem(key) || '[]'));
    const alertKey = (row) => `${row.id}:${row.kind === 'extra' ? 'extra' : row.status}`;
    const fresh = alerts.filter((row) => !seen.has(alertKey(row)));
    banner.hidden = !alerts.length;
    banner.querySelector('[data-technician-alert-summary]').textContent =
      `${alerts.filter((row) => row.kind === 'booking').length} missed/incomplete visit(s) need rebooking. ${alerts.filter((row) => row.kind === 'extra').length} extra visit(s).`;
    if (fresh.length) {
      window.alert(`Technician visit alert\n${fresh.map((row) => `${row.technician_name} - ${row.building_name}: ${row.kind === 'extra' ? 'extra visit' : row.status}; ${row.missing.join(' and ') || 'both checks received'}`).join('\n')}\nOpen Appliance reports for the schedule and MM attendance report. Offline checks remain unconfirmed until sync.`);
      for (const row of fresh) seen.add(alertKey(row));
      localStorage.setItem(key, JSON.stringify([...seen]));
    }
  } catch (error) {
    console.error('Technician alerts could not refresh:', error);
    if (isManagerRole(currentUser?.role)) {
      banner.hidden = false;
      banner.querySelector('[data-technician-alert-summary]').textContent = 'Technician alerts unavailable. Connect and open Appliance reports to refresh attendance.';
    }
  } finally { technicianAlertsBusy = false; }
}
document.querySelector('#open-technician-schedule').addEventListener('click', () => navigateView('appliances'));
window.setInterval(() => { if (!document.hidden) void checkTechnicianAlerts(); }, 60000);
window.addEventListener('online', () => { void checkTechnicianAlerts(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void checkTechnicianAlerts(); });

function roleLabel(role) {
  return ({
    admin: 'Administrator',
    office_admin: 'Office Administrator',
    user: residentLabel(currentUser?.companySettings, false, currentUser?.residentType),
    maintenance_manager: 'Maintenance Manager',
    portfolio_manager: 'Portfolio Manager',
    building_manager: 'Building Manager',
    operations_manager: 'Operations Manager',
    maintenance_assistant: 'Maintenance Assistant / Caretaker',
    technician: 'Technician'
  })[role] || 'Account';
}

function showSignIn(message = '') {
  licenceClient.check();
  document.querySelector('#licence-screen').hidden = true;
  resetSectionTabs(userManagementSection);
  resetSectionTabs(document);
  profilePhoto.reset();
  document.querySelector('#account-dialog').close();
  document.querySelector('#app-shell').hidden = true;
  document.querySelector('#platform-account-screen').hidden = true;
  document.querySelector('#platform-account-dialog').close();
  document.querySelector('#invoice-document-dialog').close();
  document.querySelector('#invoice-document-dialog iframe').removeAttribute('srcdoc');
  document.querySelectorAll('[data-platform-statement]').forEach((element) => { element.replaceChildren(); });
  document.querySelector('#auth-screen').hidden = false;
  const companyInput = document.querySelector('#login-form [name=company]');
  if (!companyInput.value) companyInput.value = selectedCompany() || legacy.defaultClientCode;
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

document.addEventListener('change', (event) => {
  if (!event.target.matches('#create-user-form [name="role"], .managed-user-form [name="role"]')) return;
  event.target.form.elements.unitNumber.required = event.target.value === 'user';
  const permissions = event.target.form.querySelector('[data-account-permissions]');
  if (permissions) {
    permissions.hidden = !isManagerRole(event.target.value);
    const defaults = sectionsFor({ role: event.target.value });
    permissions.querySelectorAll('[name=sections]').forEach((input) => { input.checked = defaults.includes(input.value); });
    const adminRights = permissions.querySelector('[name=adminRights]');
    if (adminRights) adminRights.checked = false;
  }
  updateAccountBuildingPicker(event.target.form);
});

function updateAccountBuildingPicker(form) {
  const resident = form.elements.role?.value === 'user';
  form.querySelectorAll('[data-resident-field]').forEach((field) => {
    field.hidden = !resident;
    field.querySelectorAll('input, select').forEach((input) => { input.disabled = !resident; });
  });
  if (form.elements.unitNumber) form.elements.unitNumber.required = resident;
  const picker = form.querySelector('.building-picker');
  if (!picker) return;
  const inputs = [...picker.querySelectorAll('[name=propertyIds]')];
  const selected = inputs.filter((input) => input.checked).map((input) => input.value);
  for (const input of inputs) {
    input.type = resident ? 'radio' : 'checkbox';
    input.required = resident && !picker.disabled;
    input.checked = selected.includes(input.value) && (!resident || selected.length === 1);
  }
  picker.querySelector('.building-picker-toggle').hidden = resident;
  picker.querySelector('legend').textContent = resident ? 'Assigned building (choose one)' : 'Assigned buildings (one or more)';
  let warning = picker.querySelector('[data-building-assignment-warning]');
  if (!warning) {
    warning = document.createElement('p');
    warning.dataset.buildingAssignmentWarning = '';
    warning.setAttribute('role', 'alert');
    picker.append(warning);
  }
  warning.textContent = resident && selected.length > 1 ? 'This resident has multiple buildings. Choose exactly one before saving.' : '';
}

function accountPermissionsHtml(user = { role: 'maintenance_manager' }) {
  const selected = sectionsFor(isManagerRole(user.role) ? user : { role: 'maintenance_manager' });
  return `<fieldset data-account-permissions ${isManagerRole(user.role) ? '' : 'hidden'}>
    <legend>Manager access</legend><p>Only selected sections and assigned buildings are available. No sections selected means Home and Account only. Leasing is a test module with simulated billing; the company must have it enabled.</p>
    ${accountSections.filter(([id]) => canUseSection(currentUser, id) || (id === 'leasing' && currentUser.role === 'admin')).map(([id, label]) =>
      `<label class="check-label"><input type="checkbox" name="sections" value="${id}" ${selected.includes(id) ? 'checked' : ''} />${label}</label>`).join('')}
    ${currentUser.role === 'admin' ? `<label class="check-label"><input type="checkbox" name="adminRights" ${user.admin_rights ? 'checked' : ''} />Scoped admin rights (manage managers within selected buildings/sections)</label>
      <p>Requires User management. Does not grant all buildings, report storage settings, self-promotion or full administrator status.</p>` : ''}
    </fieldset>`;
}

function accountPermissionValues(values) {
  return isManagerRole(values.get('role'))
    ? { sections: values.getAll('sections'), adminRights: values.get('adminRights') === 'on' }
    : { sections: null, adminRights: false };
}

function applyUserFilter() {
  const query = String(document.querySelector('#user-search')?.value || '').trim().toLowerCase();
  const filter = document.querySelector('#user-filter')?.value || 'active';
  let shown = 0;
  const items = [...document.querySelectorAll('#user-list .user-record')];
  for (const item of items) {
    const matches = (!query || item.dataset.search.includes(query))
      && (filter === 'all' || (filter === 'active') === (item.dataset.active === 'true'));
    item.hidden = !matches;
    if (matches) shown += 1;
  }
  document.querySelectorAll('#user-list .user-role-section').forEach((section) => {
    section.hidden = !section.querySelector('.user-record:not([hidden])');
  });
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
    document.querySelector('#create-user-picker').innerHTML = properties.length
      ? `<p>Students/tenants require exactly one building. Managers and staff may have several. The new account belongs to this client.</p>${buildingPicker(properties.length === 1 ? [properties[0].id] : [], false)}`
      : '<p role="alert">Add a building first under Add a building, then assign it to the new user.</p>';
    document.querySelector('#create-user-permissions').innerHTML = accountPermissionsHtml({ role: 'user' });
    const propertyNames = new Map(properties.map((property) => [property.id, property.name]));
    const sections = [
      ...managerProfiles.map(([role, label]) => [role, `${label}s`]),
      ['admin', 'Admins'],
      ['user', residentLabel(currentUser.companySettings, true)],
      ['maintenance_assistant', 'Maintenance Assistants / Caretakers'],
      ['technician', 'Technicians']
    ];
    userList.innerHTML = sections.map(([role, title]) => {
      const roleUsers = users.filter((user) => user.role === role);
      if (!roleUsers.length) return '';
      return `<li class="user-role-section"><h3>${title}</h3><ul class="role-user-list">${roleUsers.map((user) => {
      const buildingNames = user.role === 'admin' ? ['All buildings'] : (user.property_ids || []).map((id) => propertyNames.get(id) || id);
      const searchText = [user.name, user.email, user.unit_number, ...buildingNames].join(' ').toLowerCase();
      return `
      <li class="user-record" data-search="${escapeHtml(searchText)}" data-active="${user.active ? 'true' : 'false'}">
        <details class="managed-user">
          <summary>
            <span class="managed-user-name"><strong>${escapeHtml(user.name)}</strong> <span>${escapeHtml(user.email)}${user.unit_number ? ` · Unit ${escapeHtml(user.unit_number)}` : ''}</span></span>
            <span class="managed-user-meta">${user.role === 'admin' ? 'All buildings' : `${buildingNames.length} building${buildingNames.length === 1 ? '' : 's'}`} · ${user.active ? 'Active' : 'Inactive'}</span>
          </summary>
          <form class="managed-user-form" data-user-id="${escapeHtml(user.id)}" data-section-group="account-${escapeHtml(user.id)}">
            ${sectionTabs(`account-${user.id}`, 'Account settings', [['details', 'Account details'], ['access', 'Buildings & access'], ...(user.role === 'admin' ? [] : [['security', 'Password & status']])])}
            <section ${sectionPanel(`account-${user.id}`, 'details')}>
            <div class="managed-user-heading"><span>${escapeHtml(buildingNames.join(', ') || 'No buildings assigned')}</span></div>
            <label>Display name<input name="name" maxlength="100" value="${escapeHtml(user.name)}" required ${user.role === 'admin' ? 'disabled' : ''} /></label>
            <label>Username<input name="email" type="text" value="${escapeHtml(user.email)}" required ${user.role === 'admin' ? 'disabled' : ''} /></label>
            ${user.role === 'admin' ? '' : `<label>Role<select name="role"><option value="user" ${user.role === 'user' ? 'selected' : ''}>${residentLabel(currentUser.companySettings)}</option>${canDelegateAccounts(currentUser) ? managerProfiles.map(([id, label]) => `<option value="${id}" ${user.role === id ? 'selected' : ''}>${label}</option>`).join('') : ''}<option value="maintenance_assistant" ${user.role === 'maintenance_assistant' ? 'selected' : ''}>Maintenance Assistant / Caretaker</option><option value="technician" ${user.role === 'technician' ? 'selected' : ''}>Technician</option></select></label>
            <div data-resident-field>${residentTypeField(currentUser.companySettings, user.resident_type)}</div>
            <label data-resident-field>Apartment/unit number (required for residents)<input name="unitNumber" maxlength="80" value="${escapeHtml(user.unit_number || '')}" ${user.role === 'user' ? 'required' : ''} /></label>`}
            </section>
            <section ${sectionPanel(`account-${user.id}`, 'access')}>
            ${user.role === 'admin' ? '' : accountPermissionsHtml(user)}
            ${buildingPicker(user.property_ids || [], user.role === 'admin')}
            </section>
            ${user.role === 'admin' ? '' : `<section ${sectionPanel(`account-${user.id}`, 'security')}>
            <label>Set new password<input name="password" type="password" minlength="4" autocomplete="new-password" /></label>
            <label class="check-label"><input type="checkbox" name="active" ${user.active ? 'checked' : ''} /> Account active</label>
            </section>`}
            ${user.role === 'admin' ? '' : '<button class="button secondary" type="submit">Save account</button>'}
          </form>
        </details>
      </li>`;
      }).join('')}</ul></li>`;
    }).join('');
    updateAccountBuildingPicker(document.querySelector('#create-user-form'));
    userList.querySelectorAll('.managed-user-form').forEach(updateAccountBuildingPicker);
    applyUserFilter();
    status.textContent = '';
  } catch (error) {
    status.textContent = error.message || 'Could not load user accounts.';
  }
}

async function renderStorageSettings(browse) {
  workspace.innerHTML = '<div class="storage-view"><p class="eyebrow">ADMINISTRATION</p><h1>Report storage</h1><p class="empty-list">Loading…</p></div>';
  try {
    const query = browse === undefined ? '' : `?browse=${encodeURIComponent(browse)}`;
    const info = await apiRequest(`/api/settings/reports${query}`);
    if (currentView !== 'storage') return;
    const segments = info.browsing ? info.browsing.split('/') : [];
    const crumbs = [`<button class="button secondary" type="button" data-storage-browse="">Server reports root</button>`]
      .concat(segments.map((name, index) => `<button class="button secondary" type="button" data-storage-browse="${escapeHtml(segments.slice(0, index + 1).join('/'))}">${escapeHtml(name)}</button>`));
    const parent = segments.slice(0, -1).join('/');
    workspace.innerHTML = `
      <div class="storage-view">
        <div class="page-heading"><div><p class="eyebrow">ADMINISTRATION</p><h1>Report storage</h1>
          <p>Choose the folder on the server where completed checklists and reports are saved. Each report is filed as <em>Building / Report type / date</em>.</p></div></div>
        <section class="storage-panel">
          <p class="account-status"><strong>Currently saving to:</strong> <code>${escapeHtml(info.absolutePath)}</code></p>
          <p class="account-status">Folders can be created anywhere inside <code>${escapeHtml(info.root)}</code> on the server. To use a different drive or location, change <code>REPORTS_DIR</code> in the server <code>.env</code> file and restart the server.</p>
          <div class="storage-crumbs">${crumbs.join('')}</div>
          <ul class="storage-folder-list">
            ${segments.length ? `<li><button class="button secondary" type="button" data-storage-browse="${escapeHtml(parent)}">↑ Up one level</button></li>` : ''}
            ${info.folders.map((name) => `<li><button class="button secondary" type="button" data-storage-browse="${escapeHtml([...segments, name].join('/'))}">📁 ${escapeHtml(name)}</button></li>`).join('') || '<li class="empty-list">No sub-folders here.</li>'}
          </ul>
          <form id="storage-form" class="storage-form" data-browsing="${escapeHtml(info.browsing)}">
            <label>New sub-folder (optional)<input name="newFolder" maxlength="80" placeholder="e.g. 2026 Checklists" /></label>
            <p class="account-status">Folder to save to: <strong>${escapeHtml(info.root)}${info.browsing ? `/${escapeHtml(info.browsing)}` : ''}</strong> (plus the new sub-folder, if entered)</p>
            <button class="button primary" type="submit">Save reports in this folder</button>
          </form>
          <p id="storage-status" class="account-status" role="status" aria-live="polite"></p>
        </section>
      </div>`;
  } catch (error) {
    if (currentView !== 'storage') return;
    workspace.innerHTML = `<div class="storage-view"><p class="eyebrow">ADMINISTRATION</p><h1>Report storage</h1><p class="storage-warning" role="alert">${escapeHtml(error.message || 'Could not load storage settings.')}</p></div>`;
  }
}

workspace.addEventListener('click', (event) => {
  const button = event.target.closest('[data-storage-browse]');
  if (button) void renderStorageSettings(button.dataset.storageBrowse);
});

workspace.addEventListener('submit', async (event) => {
  if (event.target.id !== 'storage-form') return;
  event.preventDefault();
  const form = event.target;
  const newFolder = String(new FormData(form).get('newFolder') || '').trim();
  const folder = [form.dataset.browsing, newFolder].filter(Boolean).join('/');
  try {
    const result = await apiRequest('/api/settings/reports', { method: 'PUT', body: { folder } });
    await renderStorageSettings(result.folder);
    document.querySelector('#storage-status').textContent = `Reports will now be saved to ${result.absolutePath}`;
  } catch (error) {
    alertError(error, 'Could not change the report folder.');
  }
});

const billingStatusLabels = { active: 'Active', blocked: 'Blocked', stopped: 'Billing stopped' };
const billingKindLabels = { charge: 'Charge', payment: 'Payment', credit: 'Credit' };
let billingAdminUserId = '';

function money(cents) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'ZAR' }).format((Number(cents) || 0) / 100);
}

function billingStatusHelp(status) {
  if (status === 'blocked') return 'Blocked: this resident cannot log new tickets and no further billing is loaded until the account is set back to active.';
  if (status === 'stopped') return 'Billing stopped: no new charges can be loaded. Payments and credits can still be recorded.';
  return 'Active: charges can be loaded and tickets can be logged.';
}

function statementHtml(snapshot) {
  let running = 0;
  const rows = snapshot.entries.filter((entry) => !entry.voided_at).map((entry) => {
    running += entry.kind === 'charge' ? entry.amount_cents : -entry.amount_cents;
    return `<tr><td>${escapeHtml(entry.entry_date)}</td><td>${escapeHtml(entry.description)}</td><td>${billingKindLabels[entry.kind]}</td>
      <td class="n">${entry.kind === 'charge' ? money(entry.amount_cents) : ''}</td>
      <td class="n">${entry.kind === 'charge' ? '' : money(entry.amount_cents)}</td><td class="n">${money(running)}</td></tr>`;
  }).join('') || '<tr><td colspan="6">No transactions yet.</td></tr>';
  const { account } = snapshot;
  return reportDocument({
    title: 'Account statement', subtitle: account.name, category: 'Accounts & billing',
    metadata: [['Account', account.email], ['Statement date', new Date().toISOString().slice(0, 10)], ['Account status', billingStatusLabels[account.status]]],
    summary: [['Account balance', money(snapshot.balanceCents)], ['Transactions', snapshot.entries.filter((entry) => !entry.voided_at).length]],
    notice: snapshot.offline_copy || snapshot.pending_sync ? `OFFLINE / PROVISIONAL COPY - downloaded ${snapshot.downloaded_at || 'not yet uploaded'}. Pending transactions are not confirmed by the server.` : '',
    body: `<h2>Transaction history</h2><table><thead><tr><th>Date</th><th>Description</th><th>Type</th><th class="n">Charges</th><th class="n">Payments / credits</th><th class="n">Balance</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="total"><strong>${snapshot.balanceCents > 0 ? 'Amount due' : 'Balance'}: ${money(snapshot.balanceCents)}</strong>${snapshot.balanceCents < 0 ? ' (in credit)' : ''}</p>`
  });
}

async function printStatement(snapshot) {
  return printDocument(statementHtml(snapshot), `Statement-${safeFileName(snapshot.account.name)}-${new Date().toISOString().slice(0, 10)}`);
}

async function printDocument(html, title) {
  licenceClient.assertActive();
  if (Capacitor.isNativePlatform()) {
    await PdfReport.create({ html, title });
    return;
  }
  const frame = document.createElement('iframe');
  frame.title = title;
  frame.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
  frame.srcdoc = html;
  frame.onload = () => {
    frame.contentWindow.addEventListener('afterprint', () => frame.remove(), { once: true });
    frame.contentWindow.focus();
    frame.contentWindow.print();
    window.setTimeout(() => frame.remove(), 60_000);
  };
  document.body.append(frame);
}

let billingSnapshotCache = null;
const applianceView = createApplianceView({
  workspace, apiRequest, escapeHtml, alertError, printDocument,
  isCurrent: () => currentView === 'appliances',
  getOwner: () => `${authGeneration}:${authToken}:${apiUrl('')}:${currentUser?.id}:${permissionKey(currentUser)}`,
  getUser: () => currentUser,
  composeEmail: async (request) => {
    if (Capacitor.getPlatform() === 'android') {
      await SupplierEmail.compose({ to: request.to, bcc: request.bcc, subject: request.subject, text: request.text,
        html: request.html, filename: request.filename });
      return;
    }
    window.alert('Your email app will open with this supplier in Bcc and the building email as recipient. Attach the downloaded parts report or PDF before sending. Alternatively, download the email draft, which includes the report and a Reply-To header for the building.');
    if (window.desktopApp?.openQuoteEmail) {
      const result = await window.desktopApp.openQuoteEmail(request.mailto);
      if (result.error) throw new Error(result.error);
      return;
    }
    window.location.href = request.mailto;
  },
  canManage: () => hasFullAccess(),
  draftStorage: {
    get: (key) => databaseRequest('readonly', (store) => store.get(key)),
    set: (key, value) => databaseRequest('readwrite', (store) => store.put(value, key))
  },
  draftKey: () => `laundry-draft-v2:${apiUrl('')}:${currentUser.id}:${permissionKey(currentUser)}`
});

function billingDetailHtml(snapshot, isAdmin) {
  const { account } = snapshot;
  const rows = snapshot.entries.map((entry) => `<tr class="${entry.voided_at ? 'billing-voided' : ''}">
      <td>${escapeHtml(entry.entry_date)}</td><td>${escapeHtml(entry.description)}${entry.voided_at ? ' (voided)' : ''}</td><td>${billingKindLabels[entry.kind]}</td>
      <td class="n">${money(entry.amount_cents)}</td>
      ${isAdmin ? `<td>${entry.voided_at ? '' : `<button class="button secondary" type="button" data-billing-void="${escapeHtml(entry.id)}">Void</button>`}</td>` : ''}</tr>`).join('')
    || `<tr><td colspan="${isAdmin ? 5 : 4}" class="empty-list">No transactions yet.</td></tr>`;
  const group = `billing-${account.id}`;
  return `<div data-section-group="${escapeHtml(group)}">
    ${sectionTabs(group, 'Billing account sections', [['overview', 'Overview'], ['history', 'Transactions'],
      ...(isAdmin ? [['entry', 'Add transaction'], ['status', 'Account status']] : [])])}
    <section class="storage-panel billing-panel" ${sectionPanel(group, 'overview')}>
      <h2>${escapeHtml(account.name)} <span class="billing-badge billing-${escapeHtml(account.status)}">${escapeHtml(billingStatusLabels[account.status])}</span></h2>
      ${snapshot.offline_copy || snapshot.pending_sync ? `<p role="status">Downloaded / provisional account. Last downloaded: ${escapeHtml(snapshot.downloaded_at || 'not yet uploaded')}. Queued transactions and statuses are not confirmed by the office.</p>` : ''}
      <p class="account-status">${escapeHtml(account.email)}</p>
      <p class="billing-balance">${snapshot.balanceCents > 0 ? 'Amount due' : snapshot.balanceCents < 0 ? 'In credit' : 'Balance'}: <strong>${money(Math.abs(snapshot.balanceCents))}</strong></p>
      ${account.status !== 'active' ? `<p class="storage-warning" role="status">${escapeHtml(billingStatusHelp(account.status))}${account.note ? ` Note: ${escapeHtml(account.note)}` : ''}</p>` : ''}
      <button class="button primary" type="button" data-billing-statement>Download / print statement</button>
    </section>
    <section class="storage-panel billing-panel" ${sectionPanel(group, 'history')}>
      <h2>Transactions</h2>
      <div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Date</th><th>Description</th><th>Type</th><th class="n">Amount</th>${isAdmin ? '<th></th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>
    </section>
    ${isAdmin ? `
    <section class="storage-panel billing-panel" ${sectionPanel(group, 'entry')}>
      <h2>Load a transaction</h2>
      <form id="billing-entry-form" class="storage-form">
        <label>Type<select name="kind"><option value="charge">Charge (adds to balance)</option><option value="payment">Payment received</option><option value="credit">Credit / adjustment</option></select></label>
        <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
        <label>Description<input name="description" maxlength="200" required placeholder="e.g. Rent – November" /></label>
        <label>Date<input name="date" type="date" value="${new Date().toISOString().slice(0, 10)}" required /></label>
        <button class="button primary" type="submit">Add to account</button>
      </form>
    </section>
    <section class="storage-panel billing-panel" ${sectionPanel(group, 'status')}>
      <h2>Block or stop billing</h2>
      <form id="billing-status-form" class="storage-form">
        <label>Account status<select name="status">${Object.entries(billingStatusLabels).map(([value, label]) => `<option value="${value}" ${value === account.status ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label>Note (optional, shown to the resident)<input name="note" maxlength="500" value="${escapeHtml(account.note)}" /></label>
        <p class="account-status">Stop billing: no new charges can be loaded. Block: also stops the resident logging tickets. Active: normal.</p>
        <button class="button primary" type="submit">Save status</button>
      </form>
    </section>` : ''}</div>`;
}

async function renderBilling(userId) {
  const isAdmin = hasFullAccess();
  if (isAdmin && userId !== undefined) billingAdminUserId = userId;
  workspace.innerHTML = '<div class="storage-view"><p class="eyebrow">ACCOUNTS</p><h1>Accounts &amp; billing</h1><p class="empty-list">Loading…</p></div>';
  try {
    if (isAdmin && !billingAdminUserId) {
      const { accounts } = await apiRequest('/api/billing/accounts');
      if (currentView !== 'billing') return;
      workspace.innerHTML = `<div class="storage-view">
        <div class="page-heading"><div><p class="eyebrow">ADMINISTRATION</p><h1>Accounts &amp; billing</h1>
          <p>Load charges and payments, and block or stop billing on a resident account.</p></div></div>
        ${currentUser.role === 'admin' ? '<section class="storage-panel" data-platform-account-summary role="status">Loading your company’s PrimeOps invoices...</section>' : ''}
        <section class="storage-panel billing-panel"><div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>${residentLabel(currentUser.companySettings)}</th><th>Status</th><th class="n">Balance</th><th></th></tr></thead><tbody>
        ${accounts.map((account) => `<tr><td>${escapeHtml(account.name)}<br><span class="account-status">${escapeHtml(account.email)}</span></td>
          <td><span class="billing-badge billing-${escapeHtml(account.status)}">${escapeHtml(billingStatusLabels[account.status])}</span></td>
          <td class="n">${money(account.balance_cents)}</td>
          <td><button class="button secondary" type="button" data-billing-open="${escapeHtml(account.id)}">Open account</button></td></tr>`).join('')
          || '<tr><td colspan="4" class="empty-list">No resident accounts yet. Add one under Users.</td></tr>'}
        </tbody></table></div></section></div>`;
      void refreshPlatformLedger();
      return;
    }
    const snapshot = await apiRequest(isAdmin ? `/api/billing/accounts/${encodeURIComponent(billingAdminUserId)}` : '/api/billing/me');
    if (currentView !== 'billing') return;
    billingSnapshotCache = snapshot;
    workspace.innerHTML = `<div class="storage-view">
      <div class="page-heading"><div><p class="eyebrow">${isAdmin ? 'ADMINISTRATION' : 'MY ACCOUNT'}</p><h1>${isAdmin ? 'Resident account' : 'My account'}</h1></div></div>
      ${isAdmin ? '<button class="button secondary" type="button" data-billing-back>← All residents</button>' : ''}
      ${billingDetailHtml(snapshot, isAdmin)}</div>`;
  } catch (error) {
    if (currentView !== 'billing') return;
    workspace.innerHTML = `<div class="storage-view"><p class="eyebrow">ACCOUNTS</p><h1>Accounts &amp; billing</h1><p class="storage-warning" role="alert">${escapeHtml(error.message || 'Could not load the account.')}</p></div>`;
  }
}

workspace.addEventListener('click', async (event) => {
  const open = event.target.closest('[data-billing-open]');
  if (open) return void renderBilling(open.dataset.billingOpen);
  if (event.target.closest('[data-billing-back]')) {
    billingAdminUserId = '';
    return void renderBilling();
  }
  if (event.target.closest('[data-billing-statement]') && billingSnapshotCache) {
    try { await printStatement(billingSnapshotCache); } catch (error) { alertError(error, 'Could not create the statement.'); }
    return;
  }
  const voidButton = event.target.closest('[data-billing-void]');
  if (voidButton && window.confirm('Void this entry? It will be excluded from the balance.')) {
    try {
      await apiRequest(`/api/billing/accounts/${encodeURIComponent(billingAdminUserId)}/entries/${encodeURIComponent(voidButton.dataset.billingVoid)}/void`, { method: 'POST', body: {} });
      await renderBilling();
    } catch (error) { alertError(error, 'Could not void the entry.'); }
  }
});

workspace.addEventListener('submit', async (event) => {
  const id = event.target.id;
  if (id !== 'billing-entry-form' && id !== 'billing-status-form') return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  const base = `/api/billing/accounts/${encodeURIComponent(billingAdminUserId)}`;
  try {
    if (id === 'billing-entry-form') await apiRequest(`${base}/entries`, { method: 'POST', body: data });
    else await apiRequest(`${base}/status`, { method: 'PUT', body: data });
    await renderBilling();
  } catch (error) {
    alertError(error, 'Could not save.');
  }
});

const ticketStatusLabels = {
  submitted: 'Awaiting assignment', assigned: 'Assigned', in_progress: 'In progress', contractor: 'With contractor', awaiting_stock: 'Awaiting stock',
  awaiting_access: 'Awaiting access', out_of_stock: 'Out of stock – manager to action', completed: 'Completed'
};
let ticketSignature = '';
let ticketListView = 'active';
const openTicketThreads = new Set();
let ticketFormDirty = false;

workspace.addEventListener('input', (event) => {
  if (event.target.closest('form')) ticketFormDirty = true;
});
workspace.addEventListener('toggle', (event) => {
  const id = event.target.dataset.ticketThread;
  if (!id) return;
  if (event.target.open) openTicketThreads.add(id);
  else openTicketThreads.delete(id);
}, true);

async function pollTickets() {
  if (currentView !== 'tickets' || !authToken || document.hidden) return;
  const active = document.activeElement;
  if (ticketFormDirty || (active && workspace.contains(active) && active.matches('input, textarea, select'))) return;
  try {
    const { tickets } = await apiRequest('/api/tickets', { signal: AbortSignal.timeout(10000) });
    const signature = tickets.map((ticket) => `${ticket.id}:${ticket.updated_at}:${ticket.events?.length || 0}`).join('|');
    if (ticketSignature && signature !== ticketSignature && currentView === 'tickets') await renderTickets();
    ticketSignature = signature;
    workspace.querySelector('#ticket-live-status')?.replaceChildren(document.createTextNode('Updates every 15 seconds'));
  } catch (error) {
    console.error('Ticket refresh failed:', error);
    workspace.querySelector('#ticket-live-status')?.replaceChildren(document.createTextNode('Connection lost. Retrying automatically.'));
  }
}
window.setInterval(() => { void pollTickets(); }, 15000);

async function renderTickets() {
  ticketFormDirty = false;
  const view = currentView;
  const listView = ticketListView;
  workspace.innerHTML = '<div class="tickets-view"><p class="eyebrow">MAINTENANCE</p><h1>Maintenance tickets</h1><p class="empty-list">Loading tickets…</p></div>';
  try {
    const ticketResponse = await apiRequest('/api/tickets');
    const { tickets: allTickets } = ticketResponse;
    const activeTickets = allTickets.filter((ticket) => ticket.status !== 'completed');
    const archivedTickets = allTickets.filter((ticket) => ticket.status === 'completed');
    const tickets = listView === 'archive' ? archivedTickets : activeTickets;
    if (currentView !== view || ticketListView !== listView) return;
    ticketRecords = allTickets;
    ticketSignature = allTickets.map((ticket) => `${ticket.id}:${ticket.updated_at}:${ticket.events?.length || 0}`).join('|');
    const canManage = isManagementRole(currentUser?.role);
    const canSubmit = currentUser?.role !== 'maintenance_assistant';
    const properties = state.properties;
    const assistantsByProperty = new Map();
    if (canManage && view === 'tickets' && listView === 'active') {
      const propertyIds = [...new Set(tickets.map((ticket) => ticket.property_id))];
      await Promise.all(propertyIds.map(async (propertyId) => {
        const result = await apiRequest(`/api/ticket-assignees?propertyId=${encodeURIComponent(propertyId)}`);
        assistantsByProperty.set(propertyId, result.assistants);
      }));
    }
    if (currentView !== view || ticketListView !== listView) return;
    workspace.innerHTML = `
      <div class="tickets-view">
        <div class="page-heading"><div><p class="eyebrow">MAINTENANCE</p><h1>${view === 'log-ticket' ? 'Log a ticket' : 'Maintenance tickets'}</h1>
          <p>${currentUser.role === 'maintenance_assistant' ? 'Your assigned work orders, limited to your buildings.' : isManagerRole(currentUser.role) ? 'Tickets in buildings you manage. Assign each job to an assistant in that building.' : currentUser.role === 'admin' ? 'All submitted maintenance requests and their assignments.' : 'Report a maintenance issue and track its progress.'}</p></div></div>
        ${canSubmit && view === 'log-ticket' ? `<form id="create-ticket-form" class="ticket-create-form" data-section-group="new-ticket">
          <h2>Submit a maintenance ticket</h2>
          ${sectionTabs('new-ticket', 'New ticket sections', [['issue', 'Issue details'], ['visit', 'Visit & access']])}
          <section ${sectionPanel('new-ticket', 'issue')}>
          <label>Building<select name="propertyId" required>${properties.map((property) => `<option value="${escapeHtml(property.id)}">${escapeHtml(property.name)}</option>`).join('')}</select></label>
          ${currentUser.role === 'user' ? `<p>Apartment/unit: <strong>${escapeHtml(currentUser.unitNumber || 'Not set - contact the office before logging a ticket')}</strong></p>` : '<label>Apartment/unit number<input name="unitNumber" required maxlength="80" /></label>'}
          <label>Category<select name="tag" required><option>Electrical</option><option>Plumbing</option><option>General</option></select></label>
          <label>Issue title<input name="subject" maxlength="160" required placeholder="e.g. Leaking tap in kitchen" /></label>
          <label>Describe the issue<textarea name="description" maxlength="4000" rows="4" required placeholder="Where is it and what needs attention?"></textarea></label>
          </section>
          <section ${sectionPanel('new-ticket', 'visit')}>
          <fieldset class="ticket-schedule">
            <legend>When can we attend?</legend>
            <label class="inline-choice"><input type="radio" name="when" value="standard" checked /> As soon as possible (standard: within 48 hours)</label>
            <label class="inline-choice"><input type="radio" name="when" value="scheduled" /> I want to schedule a day and time</label>
            <label id="ticket-schedule-field" hidden>Preferred date and time<input type="datetime-local" name="scheduledFor" /></label>
          </fieldset>
          <fieldset class="ticket-schedule">
            <legend>Access to the apartment</legend>
            <label class="inline-choice"><input type="checkbox" name="accessGranted" /> I grant maintenance staff access to enter my apartment if I am not there. This permission is recorded on the ticket.</label>
            <label>Access instructions (optional)<input name="accessNote" maxlength="500" placeholder="e.g. Key at reception, dog in the bedroom" /></label>
          </fieldset>
          </section>
          <button class="button primary" type="submit" ${properties.length ? '' : 'disabled'}>Submit ticket</button>
          ${properties.length ? '' : '<p class="account-status">Your account needs a building assigned before you can submit a ticket.</p>'}
        </form>` : ''}
        ${view === 'tickets' ? `<section class="ticket-list-section">
          <div class="ticket-list-switch" role="group" aria-label="Ticket lists">
            <button class="button secondary" type="button" data-ticket-list="active" aria-pressed="${listView === 'active'}">Active tickets (${activeTickets.length})</button>
            <button class="button secondary" type="button" data-ticket-list="archive" aria-pressed="${listView === 'archive'}">Archive (${archivedTickets.length})</button>
          </div>
          <div class="history-heading"><h2>${listView === 'archive' ? 'Completed ticket archive' : currentUser.role === 'user' ? 'My active tickets' : 'Active tickets'}</h2><span class="count">${tickets.length}</span></div>
          <p class="account-status">${listView === 'archive' ? 'Completed work is kept here with its conversation, activity history and completion photo.' : 'Open and assigned work, including jobs awaiting stock, access or a contractor. Completed tickets move to Archive automatically.'}</p>
          <p id="ticket-live-status" class="account-status" role="status">Updates every 15 seconds</p>
          ${tickets.length ? `<div class="ticket-list">${tickets.map((ticket) => {
            const status = ticketStatusLabels[ticket.status] || ticket.status;
            const dueText = ticket.scheduled_for
              ? `Scheduled for ${formatDateTime(ticket.scheduled_for)}`
              : `Standard: attend by ${formatDateTime(new Date(new Date(ticket.created_at).getTime() + 48 * 3600_000).toISOString())}`;
            const isOpen = ticket.status !== 'completed';
            const isAssistant = currentUser.role === 'maintenance_assistant';
            const assistantOptions = assistantsByProperty.get(ticket.property_id) || [];
            const group = `ticket-${ticket.id}`;
            return `<details class="ticket-card ticket-thread" data-ticket-thread="${escapeHtml(ticket.id)}" data-section-group="${escapeHtml(group)}" ${openTicketThreads.has(ticket.id) ? 'open' : ''}>
              <summary><span class="ticket-card-heading"><span><span class="eyebrow">${escapeHtml(ticket.building_name)} · Unit ${escapeHtml(ticket.unit_number || 'Not recorded')}</span><strong>${escapeHtml(ticket.subject)}</strong><span class="account-status">${escapeHtml(ticket.created_by_name)} · ${escapeHtml(formatDateTime(ticket.updated_at))}</span>${ticket.assigned_to_name ? `<span class="account-status">Assigned to Maintenance Assistant: <strong>${escapeHtml(ticket.assigned_to_name)}</strong></span>` : ''}</span><span class="status-chip">${escapeHtml(status)}</span></span>
              <span class="ticket-tags">${(ticket.tags || ['General']).map((tag) => `<span class="status-chip">${escapeHtml(tag)}</span>`).join('')}</span></summary>
              ${sectionTabs(group, 'Ticket sections', [['overview', 'Details'], ['conversation', 'Conversation'],
                ...(canManage || isOpen ? [['actions', 'Update ticket']] : [])])}
              ${ticket.pending_sync ? '<p role="status">Saved on this device - not yet confirmed by the server.</p>' : ''}
              <section ${sectionPanel(group, 'overview')}>
              <p class="ticket-description">${escapeHtml(ticket.description)}</p>
              ${ticket.asset_snapshot ? `<p class="ticket-meta">Asset: <strong>${escapeHtml(ticket.asset_snapshot.name)} / ${escapeHtml(ticket.asset_snapshot.assetTag)}</strong> · ${escapeHtml(ticket.asset_snapshot.location || 'Common area')}${ticket.source_asset_activity_id ? ' · Linked inspection/fault' : ''}</p>` : ''}
              <p class="ticket-meta ticket-due">${escapeHtml(dueText)} · ${ticketResponse.offline_copy ? '<strong>Offline copy: access permission may have changed. Reconnect and verify before entering the apartment.</strong>' : ticket.access_granted ? `<strong class="access-yes">Access granted</strong> (${escapeHtml(formatDateTime(ticket.access_granted_at))})${ticket.access_note ? ` – ${escapeHtml(ticket.access_note)}` : ''}` : '<span class="access-no">No access permission – resident must be present</span>'}${ticket.contractor_name ? ` · Contractor: ${escapeHtml(ticket.contractor_name)}` : ''}</p>
              <p class="ticket-meta">Submitted by ${escapeHtml(ticket.created_by_name)} · ${escapeHtml(formatDateTime(ticket.created_at))}${ticket.completed_at ? ` · Completed ${escapeHtml(formatDateTime(ticket.completed_at))}` : ''}</p>
              ${ticket.has_completion_photo ? `<button class="button secondary" type="button" data-ticket-photo="${escapeHtml(ticket.id)}">View completion photo</button>` : ''}
              </section>
              ${canManage || isOpen ? `<section ${sectionPanel(group, 'actions')}>` : ''}
              ${canManage && ticket.status !== 'completed' ? `<form class="ticket-assignment-form" data-ticket-id="${escapeHtml(ticket.id)}">
                <label>Maintenance Assistant<select name="assistantId" required><option value="">Choose an assistant</option>${assistantOptions.map((assistant) => `<option value="${escapeHtml(assistant.id)}" ${assistant.id === ticket.assigned_to ? 'selected' : ''}>${escapeHtml(assistant.name)}</option>`).join('')}</select></label>
                <button class="button secondary" type="submit">${ticket.assigned_to ? 'Update assignment' : 'Assign ticket'}</button>
                ${assistantOptions.length ? '' : '<span class="account-status">No active assistants are assigned to this building.</span>'}
              </form>` : ''}
              ${canManage && isOpen ? `<form class="ticket-status-form" data-ticket-id="${escapeHtml(ticket.id)}">
                <label>Update status<select name="status" required>
                  <option value="">Choose…</option>
                  <option value="in_progress">In progress</option>
                  <option value="awaiting_stock">Awaiting stock</option>
                  <option value="awaiting_access">Awaiting access</option>
                  <option value="contractor">Contractor</option>
                </select></label>
                <label>Contractor name (for contractor)<input name="contractorName" maxlength="120" value="${escapeHtml(ticket.contractor_name)}" /></label>
                <label>Note (optional)<input name="note" maxlength="500" /></label>
                <button class="button secondary" type="submit">Set status</button>
              </form>` : ''}
              ${isAssistant && isOpen ? `<div class="ticket-actions">
                <button class="button secondary" type="button" data-ticket-out-of-stock="${escapeHtml(ticket.id)}">Out of stock</button>
                <button class="button primary" type="button" data-ticket-capture="${escapeHtml(ticket.id)}">Done – take photo</button>
              </div>` : ''}
              ${canManage && isOpen && ticket.status !== 'submitted' ? `<button class="button secondary" type="button" data-ticket-capture="${escapeHtml(ticket.id)}">Complete with photo</button>` : ''}
              ${currentUser.role === 'user' && isOpen ? (ticket.access_granted
                ? `<button class="button secondary" type="button" data-ticket-access="withdraw" data-ticket-id="${escapeHtml(ticket.id)}">Withdraw access permission</button>`
                : `<button class="button secondary" type="button" data-ticket-access="grant" data-ticket-id="${escapeHtml(ticket.id)}">Grant access to my apartment</button>`) : ''}
              ${canManage ? `<details><summary>Edit tags</summary><form class="ticket-tags-form storage-form" data-ticket-id="${escapeHtml(ticket.id)}"><label>Tags (comma separated)<input name="tags" required value="${escapeHtml((ticket.tags || ['General']).join(', '))}" /></label><button class="button secondary" type="submit">Save tags</button></form></details>` : ''}
              ${canManage || isOpen ? '</section>' : ''}
              <section ${sectionPanel(group, 'conversation')}>
              <section class="ticket-conversation"><h4>Conversation & activity</h4>${(ticket.events || []).map((item) => `<article class="thread-message ${item.event === 'Reply' ? 'thread-reply' : 'thread-event'}"><header><strong>${escapeHtml(item.actor)}</strong> · ${escapeHtml(formatDateTime(item.at))}</header><strong>${escapeHtml(item.event)}</strong><p>${escapeHtml(item.detail)}</p></article>`).join('')}
                <form class="ticket-reply-form storage-form" data-ticket-id="${escapeHtml(ticket.id)}"><label>Reply<textarea name="message" rows="2" required maxlength="4000" placeholder="Write an update..."></textarea></label><button class="button secondary" type="submit">Send reply</button></form>
              </section>
              </section>
            </details>`;
          }).join('')}</div>` : `<p class="empty-list">${listView === 'archive' ? 'No completed tickets in the archive yet.' : 'No active tickets. Completed work is available in Archive.'}</p>`}
        </section>` : ''}
      </div>`;
  } catch (error) {
    if (currentView !== view || ticketListView !== listView) return;
    workspace.innerHTML = `<div class="tickets-view"><p class="eyebrow">MAINTENANCE</p><h1>Maintenance tickets</h1><p class="storage-warning" role="alert">${escapeHtml(error.message || 'Could not load tickets.')}</p></div>`;
  }
}

async function stopTicketCamera() {
  if (ticketCameraStream) {
    for (const track of ticketCameraStream.getTracks()) track.stop();
    ticketCameraStream = null;
  }
  document.querySelector('#ticket-camera-video').srcObject = null;
}

async function openTicketCamera(ticketId) {
  ticketCameraId = ticketId;
  ticketCapturedPhoto = '';
  const ticket = ticketRecords.find((item) => item.id === ticketId);
  if (!ticket) throw new Error('The selected ticket is no longer available.');
  if (Capacitor.isNativePlatform()) {
    try {
      const result = await CameraCapture.capture({
        buildingName: ticket.building_name,
        entryName: `Maintenance ticket: ${ticket.subject}`,
        maintenanceTicket: true
      });
      if (result.cancelled) {
        ticketCameraId = null;
        return;
      }
      if (!result.base64) throw new Error('The camera did not return a photo.');
      const photo = await prepareTicketPhoto(`data:image/jpeg;base64,${result.base64}`);
      await apiRequest(`/api/tickets/${encodeURIComponent(ticketId)}/complete`, { method: 'POST', body: { photo } });
      ticketCameraId = null;
      ticketCapturedPhoto = '';
      await renderTickets();
    } catch (error) {
      alertError(error, 'Could not capture or submit the ticket completion photo.');
    }
    return;
  }
  const preview = document.querySelector('#ticket-camera-preview');
  preview.hidden = true;
  preview.removeAttribute('src');
  document.querySelector('#complete-ticket').disabled = true;
  document.querySelector('#ticket-camera-status').textContent = 'Starting live camera… Existing photos cannot be selected.';
  document.querySelector('#ticket-camera-dialog').showModal();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Live camera access is not available in this browser. Open PrimeOps over HTTPS on a camera-enabled device.');
    ticketCameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    if (!document.querySelector('#ticket-camera-dialog').open) {
      await stopTicketCamera();
      return;
    }
    document.querySelector('#ticket-camera-video').srcObject = ticketCameraStream;
    document.querySelector('#ticket-camera-status').textContent = 'Take a new photo of the completed work to finish this ticket.';
  } catch (error) {
    document.querySelector('#ticket-camera-status').textContent = error.message || 'Camera access was denied. Allow camera access and try again.';
    await stopTicketCamera();
  }
}

function captureTicketPhoto() {
  const video = document.querySelector('#ticket-camera-video');
  if (!ticketCameraStream || !video.videoWidth || !video.videoHeight) {
    throw new Error('Wait for the live camera preview before taking a photo.');
  }
  const canvas = document.querySelector('#ticket-camera-canvas');
  const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  ticketCapturedPhoto = canvas.toDataURL('image/jpeg', 0.82);
  const preview = document.querySelector('#ticket-camera-preview');
  preview.src = ticketCapturedPhoto;
  preview.hidden = false;
  document.querySelector('#complete-ticket').disabled = false;
  document.querySelector('#ticket-camera-status').textContent = 'New camera photo captured. Submit it to mark this ticket complete.';
}

async function prepareTicketPhoto(dataUrl) {
  const [metadata, encoded] = dataUrl.split(',', 2);
  if (metadata !== 'data:image/jpeg;base64' || !encoded) throw new Error('The camera did not return a JPEG photo.');
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not prepare the camera photo for upload.');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const photo = canvas.toDataURL('image/jpeg', 0.82);
  const outputBytes = atob(photo.split(',', 2)[1]).length;
  if (outputBytes > 5 * 1024 * 1024) throw new Error('The camera photo is too large. Take another photo closer to the work.');
  return photo;
}

async function completeTicketWithPhoto() {
  if (!ticketCameraId || !ticketCapturedPhoto) throw new Error('Take a new camera photo before completing the ticket.');
  await apiRequest(`/api/tickets/${encodeURIComponent(ticketCameraId)}/complete`, {
    method: 'POST',
    body: { photo: await prepareTicketPhoto(ticketCapturedPhoto) }
  });
  document.querySelector('#ticket-camera-dialog').close();
  await stopTicketCamera();
  ticketCameraId = null;
  ticketCapturedPhoto = '';
  await renderTickets();
}

async function syncWorkspace(force = false) {
  if (!authToken || !currentUser || offlineMode || syncInProgress) return false;
  if (!force && document.querySelector('#sync-status').dataset.syncState === 'conflict') return false;
  if ((await offlineStore.status()).jobs.some((job) => job.state !== 'confirmed')) {
    setSyncStatus('PENDING', 'Upload queued changes before synchronising OHS records.', 'offline');
    return false;
  }
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

function prepareLegacyMigration(source, properties) {
  const byName = new Map(properties.map((property) => [property.name.trim().toLocaleLowerCase(), property.id]));
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
  return { ...source, surveys, buildingChecks, properties };
}

async function persistHydratedWorkspace(data, metadata) {
  await databaseRequest('readwrite', (store) => {
    store.put(data, 'state');
    return store.put({ ...metadata, server: apiUrl('') }, 'sync-meta');
  });
  state = data;
  stateLoadError = null;
}

async function connectUser(user) {
  currentUser = user;
  if (user.billingBlocked) return;
  await loadCheckTemplates(user);
  const remote = await apiRequest('/api/workspace');
  const metadata = await readSyncMetadata();
  const localHasRecords = state.surveys.length > 0 || state.buildingChecks.length > 0;
  const remoteData = normalizedWorkspace(remote.data);
  const remoteHasRecords = remoteData.surveys.length > 0 || remoteData.buildingChecks.length > 0;
  const sameAccount = metadata?.userId === user.id && metadata?.server === apiUrl('');

  if (sameAccount && metadata.dirty && hasOpsAccess(user)) {
    state = scopeStateToUser(state, user);
    await persistHydratedWorkspace(state, metadata);
    workspaceRevision = metadata.revision;
    if (metadata.revision === remote.revision) {
      await syncWorkspace();
    } else {
      setSyncStatus('CONFLICT', 'This device has unsynced changes and the server has newer data. Select to review before replacing its version.', 'conflict');
    }
    return;
  }

  if (!sameAccount && !remoteHasRecords && localHasRecords && user.role === 'admin'
      && isPrimaryCompany(selectedCompany()) && (!metadata?.server || metadata.server === apiUrl(''))) {
    await databaseRequest('readwrite', (store) => store.put(state, 'pre-backend-state'));
    const migration = prepareLegacyMigration(state, remoteData.properties);
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

async function connectOfflineUser(user) {
  currentUser = user;
  if (user.billingBlocked) { showBillingBlocked(user); return; }
  await loadCheckTemplates(user, true);
  const metadata = await readSyncMetadata();
  if (metadata?.userId === user.id && metadata?.server === apiUrl('')) {
    if (stateLoadError) throw stateLoadError;
    const saved = await databaseRequest('readonly', (store) => store.get('state'));
    if (!saved) throw new Error('The downloaded workspace is missing. Connect to download it again.');
    state = scopeStateToUser(normalizedWorkspace(saved), user);
    await persistHydratedWorkspace(state, metadata);
    workspaceRevision = metadata.revision;
  } else {
    if (hasOpsAccess(user)) throw new Error('This account has no downloaded OHS workspace for this server. Connect once to download it before working offline.');
    state = {
      surveys: [], buildingChecks: [], properties: [], activeId: null,
      activeEntryId: null, sensorCalibration: initialCalibration
    };
    workspaceRevision = null;
  }
  offlineMode = true;
  setSyncStatus('OFFLINE', 'Working on this device. Sign in online again if required before uploading saved work.', 'offline');
  showSignedIn(user);
}

async function initializeAuthentication() {
  await stateReady;
  licenceClient.assertActive();
  const session = await offlineAuth.session();
  const legacyServer = localStorage.getItem(cachedServerKey);
  const useLegacy = !legacyServer || legacyServer === apiUrl('');
  authToken = session?.token || (useLegacy ? localStorage.getItem(authTokenKey) || '' : '');
  if (!authToken) {
    showSignIn();
    return;
  }
  let verifiedUser = null;
  try {
    if (navigator.onLine === false) throw new TypeError('The device is offline.');
    const result = await sendApiRequest('/api/auth/me');
    const user = result.user;
    verifiedUser = user;
    localStorage.setItem(cachedUserKey, JSON.stringify(user));
    await offlineAuth.refresh({ token: authToken, user });
    await connectUser(user);
    localStorage.setItem(cachedServerKey, apiUrl(''));
    offlineMode = false;
    showSignedIn(user);
  } catch (error) {
    let cachedUser = verifiedUser || session?.user || null;
    if (!cachedUser && useLegacy) {
      try { cachedUser = JSON.parse(localStorage.getItem(cachedUserKey) || 'null'); } catch (cacheError) { console.error('Could not read the cached account:', cacheError); }
    }
    if (isServerUnavailable(error) && cachedUser?.id) {
      try {
        await connectOfflineUser(cachedUser);
        return;
      } catch (cacheError) {
        console.error('Could not open the offline workspace:', cacheError);
        showSignIn(cacheError.message);
        return;
      }
    }
    if (error.status === 401) {
      authToken = '';
      localStorage.removeItem(authTokenKey);
      localStorage.removeItem(cachedUserKey);
      await offlineAuth.signOut();
      document.querySelector('#offline-banner').hidden = true;
    }
    showSignIn(error.status === 401 ? 'Your sign-in has expired. Sign in again.' : 'Could not reach the backend. Check the server connection and try again.');
  }
}

const serverUrlInput = document.querySelector('#server-url');
serverUrlInput.value = savedServerUrl();
const builtInServer = String(window.APP_CONFIG?.apiBaseUrl || import.meta.env.VITE_API_BASE_URL || '').trim();
if (builtInServer) {
  document.querySelector('.server-address summary').textContent = 'Advanced: change server';
  serverUrlInput.placeholder = builtInServer;
} else if (Capacitor.isNativePlatform() && !savedServerUrl()) {
  document.querySelector('.server-address').open = true;
}

async function signInToSelectedClient(identifier, email, password) {
  const base = String(savedServerUrl() || window.APP_CONFIG?.apiBaseUrl || import.meta.env.VITE_API_BASE_URL || window.location.origin).replace(/\/+$/, '');
  const request = async (server, path, body, token) => {
    if (navigator.onLine === false) throw new TypeError('The device is offline.');
    const response = await fetch(`${server}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12000)
    });
    let result;
    try { result = await response.json(); }
    catch { throw new Error('The server did not return a valid response. Check the server address.'); }
    if (!response.ok) throw Object.assign(new Error(result.error || `The backend returned ${response.status}.`), { status: response.status });
    return result;
  };
  const code = await resolveClient({
    identifier, server: base, storage: localStorage,
    request: (path, body) => request(base, path, body)
  });
  if (code === (selectedCompany() || legacy.defaultClientCode)) return false;
  const suffix = isPrimaryCompany(code) ? '' : `-${code}`;
  const server = `${base}${isPrimaryCompany(code) ? '' : `/c/${encodeURIComponent(code)}`}`;
  const connection = await openDatabase(`primeops${suffix}`);
  try {
    await migrateLegacyDatabase(connection, suffix);
    const access = (mode, action) => new Promise((resolve, reject) => {
      const transaction = connection.transaction('workspace', mode);
      const result = action(transaction.objectStore('workspace'));
      transaction.oncomplete = () => resolve(result.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Could not access client sign-in storage.'));
    });
    const result = await signInClient({
      server, email, password,
      storage: { get: (key) => access('readonly', (store) => store.get(key)), set: (key, value) => access('readwrite', (store) => store.put(value, key)) },
      request: (path, body, token) => request(server, path, body, token)
    });
    localStorage.setItem(`primeops-token${suffix}`, result.token);
    localStorage.setItem(`primeops-user${suffix}`, JSON.stringify(result.user));
    localStorage.setItem(`primeops-server${suffix}`, server);
    localStorage.setItem(companyCodeKey, code);
    window.location.reload();
    return true;
  } finally { connection.close(); }
}

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const enteredServer = serverUrlInput.value.trim();
  if (enteredServer) {
    try {
      const url = new URL(/^https?:\/\//i.test(enteredServer) ? enteredServer : `http://${enteredServer}`);
      localStorage.setItem(serverUrlKey, url.origin);
      serverUrlInput.value = url.origin;
    } catch {
      showSignIn('Enter a valid server address such as http://192.168.1.20:3001');
      return;
    }
  } else {
    localStorage.removeItem(serverUrlKey);
  }
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const values = new FormData(form);
  button.disabled = true;
  document.querySelector('#login-error').hidden = true;
  try {
    if (await signInToSelectedClient(values.get('company'), values.get('email'), values.get('password'))) return;
    if (!await licenceClient.refresh()) throw new Error(licenceClient.state().message);
    const result = await offlineAuth.signIn(values.get('email'), values.get('password'));
    authGeneration++;
    authToken = result.token;
    localStorage.setItem(authTokenKey, authToken);
    localStorage.setItem(cachedUserKey, JSON.stringify(result.user));
    if (result.offline) {
      await connectOfflineUser(result.user);
    } else {
      try {
        await connectUser(result.user);
        offlineMode = false;
        showSignedIn(result.user);
      } catch (error) {
        if (!isServerUnavailable(error)) throw error;
        await connectOfflineUser(result.user);
      }
    }
    localStorage.setItem(cachedServerKey, apiUrl(''));
    form.reset();
    serverUrlInput.value = savedServerUrl();
  } catch (error) {
    showSignIn(error.message || 'Could not sign in.');
  } finally {
    button.disabled = false;
  }
});

const profilePhoto = wireProfilePhoto({
  apiRequest,
  getOwner: () => `${authGeneration}:${authToken}:${apiUrl('')}:${permissionKey(currentUser)}`,
  alertError
});

document.querySelector('#account-button').addEventListener('click', async () => {
  androidDownload.href = apiUrl('/api/app-updates/android/download');
  document.querySelector('#account-dialog').showModal();
  await profilePhoto.load();
});

document.querySelector('#create-user-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const status = document.querySelector('#user-management-status');
  const button = form.querySelector('[type=submit]');
  if (button.disabled) return;
  try {
    form.elements.unitNumber.required = values.get('role') === 'user';
    const invalid = [...form.elements].find((input) => input.name !== 'propertyIds' && input.willValidate && !input.validity.valid);
    if (invalid) {
      invalid.reportValidity();
      throw new Error(`${invalid.closest('label')?.textContent.trim() || 'Account details'}: ${invalid.validationMessage}`);
    }
    try { accountBuildingIds(values.get('role'), values.getAll('propertyIds')); }
    catch (error) {
      form.querySelector('[data-section-tab=access]').click();
      throw error;
    }
    button.disabled = true;
    status.textContent = 'Creating user...';
    const result = await apiRequest('/api/users', {
      method: 'POST',
      body: {
        name: values.get('name'),
        email: values.get('email'),
        password: values.get('password'),
        role: values.get('role'),
        unitNumber: values.get('unitNumber'),
        ...(values.has('residentType') ? { residentType: values.get('residentType') } : {}),
        propertyIds: values.getAll('propertyIds'),
        ...accountPermissionValues(values)
      }
    });
    form.reset();
    form.elements.unitNumber.required = true;
    await loadUserManagement();
    status.textContent = result.queued ? 'Account saved on this device, awaiting upload. It cannot sign in until the server confirms creation.' : 'Account created. The user can sign in with this client company code and their assigned username/password.';
    document.querySelector('#users-tab-accounts').click();
  } catch (error) {
    status.textContent = error.message || 'Could not create the account.';
  } finally { button.disabled = false; status.scrollIntoView({ block: 'nearest' }); }
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
    accountBuildingIds(values.get('role'), values.getAll('propertyIds'));
    await apiRequest(`/api/users/${encodeURIComponent(form.dataset.userId)}`, {
      method: 'PUT',
      body: {
        name: values.get('name'),
        email: values.get('email'),
        password: values.get('password'),
        role: values.get('role'),
        active: values.get('active') === 'on',
        unitNumber: values.get('unitNumber'),
        ...(values.has('residentType') ? { residentType: values.get('residentType') } : {}),
        propertyIds: values.getAll('propertyIds'),
        ...accountPermissionValues(values)
      }
    });
    await loadUserManagement();
    status.textContent = 'Account updated.';
  } catch (error) {
    status.textContent = error.message || 'Could not update the account.';
  }
});

document.querySelector('#close-ticket-camera').addEventListener('click', () => {
  document.querySelector('#ticket-camera-dialog').close();
});
document.querySelector('#ticket-camera-dialog').addEventListener('close', () => {
  void stopTicketCamera();
  ticketCameraId = null;
  ticketCapturedPhoto = '';
});
document.querySelector('#capture-ticket-photo').addEventListener('click', () => {
  try {
    captureTicketPhoto();
  } catch (error) {
    document.querySelector('#ticket-camera-status').textContent = error.message;
  }
});
document.querySelector('#complete-ticket').addEventListener('click', async () => {
  const button = document.querySelector('#complete-ticket');
  button.disabled = true;
  try {
    await completeTicketWithPhoto();
  } catch (error) {
    button.disabled = false;
    document.querySelector('#ticket-camera-status').textContent = error.message || 'Could not complete the ticket.';
  }
});
document.querySelector('#close-ticket-photo').addEventListener('click', () => document.querySelector('#ticket-photo-dialog').close());
document.querySelector('#ticket-photo-dialog').addEventListener('close', () => {
  if (ticketPhotoObjectUrl) URL.revokeObjectURL(ticketPhotoObjectUrl);
  ticketPhotoObjectUrl = '';
  document.querySelector('#ticket-photo-image').removeAttribute('src');
});

document.querySelector('#close-account-dialog').addEventListener('click', () => document.querySelector('#account-dialog').close());
document.querySelector('#close-account-dialog-footer').addEventListener('click', () => document.querySelector('#account-dialog').close());

async function loadPlatformStatement(target) {
  const context = `${authGeneration}:${authToken}:${apiUrl('')}`;
  target.textContent = 'Loading account statement...';
  try {
    const data = await sendApiRequest('/api/platform-account');
    if (context !== `${authGeneration}:${authToken}:${apiUrl('')}`) return;
    target.innerHTML = platformStatementHtml(data);
    target.dataset.platformRevision = String(data.company.revision);
  } catch (error) {
    if (context === `${authGeneration}:${authToken}:${apiUrl('')}`) target.textContent = error.message || 'Connect to view your account statement.';
  }
}
function showBillingBlocked(user) {
  currentUser = user;
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  for (const id of ['app-shell', 'auth-screen', 'offline-banner', 'technician-alert-banner']) document.querySelector(`#${id}`).hidden = true;
  document.querySelector('#platform-account-screen').hidden = false;
  const statement = document.querySelector('#platform-account-screen [data-platform-statement]');
  if (user.role === 'admin') void loadPlatformStatement(statement);
  else statement.textContent = 'Ask your client main administrator to view the PrimeOps account statement.';
}
document.querySelector('#platform-account-button').addEventListener('click', () => {
  const dialog = document.querySelector('#platform-account-dialog');
  dialog.showModal();
  void loadPlatformStatement(dialog.querySelector('[data-platform-statement]'));
});
let refreshingPlatformLedger = false;
async function refreshPlatformLedger() {
  if (document.hidden || currentUser?.role !== 'admin' || refreshingPlatformLedger) return;
  const targets = [...document.querySelectorAll('[data-platform-statement], [data-platform-account-summary]')]
    .filter((target) => target.getClientRects().length && !target.querySelector('button:disabled'));
  if (!targets.length) return;
  const context = `${authGeneration}:${authToken}:${apiUrl('')}`;
  refreshingPlatformLedger = true;
  try {
    const data = await sendApiRequest('/api/platform-account');
    if (context !== `${authGeneration}:${authToken}:${apiUrl('')}`) return;
    for (const target of targets) {
      if (!target.isConnected) continue;
      target.dataset.platformRevision = String(data.company.revision);
      if (target.matches('[data-platform-account-summary]')) {
        target.innerHTML = `<h2>Your company's PrimeOps invoices</h2><p>${data.invoices.filter((invoice) => !invoice.voidedAt).length} invoice(s) · Outstanding ${money(data.outstandingCents)} · Arrears ${money(data.arrearsCents)}</p><p>Separate from your residents' rent and charges.</p><button class="button primary" type="button" data-open-platform-statement>Invoices, payments &amp; PDF downloads</button>`;
      } else {
        const ledger = target.querySelector('[data-platform-ledger]');
        if (ledger) ledger.innerHTML = statementLedgerHtml(data);
        const status = target.querySelector('[data-platform-refresh-status]');
        if (status) status.textContent = `Invoices and balances updated ${new Date(data.asOf).toLocaleTimeString()}.`;
      }
    }
  } catch (error) {
    if (context !== `${authGeneration}:${authToken}:${apiUrl('')}`) return;
    for (const target of targets) {
      if (!target.isConnected) continue;
      const status = target.querySelector('[data-platform-refresh-status]') || target;
      status.textContent = `Could not refresh company invoices: ${error.message}. Reconnect and refresh the statement.`;
    }
  } finally { refreshingPlatformLedger = false; }
}
window.setInterval(() => { void refreshPlatformLedger(); }, 30000);
let checkingPlatformRevision = false;
async function checkPlatformRevision() {
  if (document.hidden || currentUser?.role !== 'admin' || checkingPlatformRevision || refreshingPlatformLedger) return;
  const targets = [...document.querySelectorAll('[data-platform-statement], [data-platform-account-summary]')]
    .filter((target) => target.getClientRects().length && !target.querySelector('button:disabled'));
  if (!targets.length) return;
  const context = `${authGeneration}:${authToken}:${apiUrl('')}`;
  checkingPlatformRevision = true;
  try {
    const data = await sendApiRequest('/api/platform-account/revision');
    if (context !== `${authGeneration}:${authToken}:${apiUrl('')}`) return;
    if (targets.some((target) => target.dataset.platformRevision !== String(data.revision))) await refreshPlatformLedger();
  } catch (error) {
    if (context !== `${authGeneration}:${authToken}:${apiUrl('')}`) return;
    for (const target of targets) {
      const status = target.querySelector('[data-platform-refresh-status]');
      if (target.isConnected && status) status.textContent = `Account updates unavailable: ${error.message}. Refresh invoices to retry.`;
    }
  } finally { checkingPlatformRevision = false; }
}
window.setInterval(() => { void checkPlatformRevision(); }, 2000);
document.querySelector('#close-platform-account').addEventListener('click', () => document.querySelector('#platform-account-dialog').close());
document.querySelector('#recheck-platform-account').addEventListener('click', async () => {
  try { await initializeAuthentication(); }
  catch (error) { document.querySelector('#platform-account-screen [data-platform-statement]').textContent = error.message; }
});
document.querySelector('#blocked-signout').addEventListener('click', () => document.querySelector('#signout-button').click());
document.querySelector('#close-invoice-document').addEventListener('click', () => {
  document.querySelector('#invoice-document-dialog').close();
  document.querySelector('#invoice-document-dialog iframe').removeAttribute('srcdoc');
});
document.querySelector('#print-invoice-document').addEventListener('click', () => document.querySelector('#invoice-document-dialog iframe').contentWindow.print());
document.addEventListener('change', async (event) => {
  if (!event.target.matches('[data-billing-document]') || !event.target.files[0]) return;
  const section = event.target.closest('details'), form = section.querySelector('[data-client-billing]');
  const target = section.querySelector('[data-billing-status]'), owner = `${authGeneration}:${authToken}:${apiUrl('')}`;
  const file = event.target.files[0], submit = form.querySelector('button');
  submit.disabled = true;
  try {
    target.textContent = 'Extracting billing details. Review every field before saving...';
    const progress = { set textContent(value) { if (owner === `${authGeneration}:${authToken}:${apiUrl('')}`) target.textContent = value; } };
    const result = await importBillingFile(file, { readSpreadsheet: readXlsxFile, readPdf: (value) => readPdfChecklistRows(value, progress, true),
      readImage: (value) => readChecklistImage(value, progress) });
    if (owner !== `${authGeneration}:${authToken}:${apiUrl('')}` || !form.isConnected) return;
    for (const [name, value] of Object.entries(result.fields)) form.elements[name].value = value;
    form.elements.reviewed.checked = false;
    section.querySelector('[data-billing-text]').textContent = result.text;
    target.textContent = 'Document read. Check the suggested fields, fill missing details, confirm VAT status and review before saving.';
  } catch (error) { if (owner === `${authGeneration}:${authToken}:${apiUrl('')}`) target.textContent = error.message; }
  finally { if (form.isConnected) submit.disabled = false; event.target.value = ''; }
});
document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-client-billing]');
  if (!form) return;
  event.preventDefault();
  const section = form.closest('details'), target = section.querySelector('[data-billing-status]'), button = form.querySelector('button');
  const context = `${authGeneration}:${authToken}:${apiUrl('')}`;
  const profile = Object.fromEntries(new FormData(form));
  profile.vatRegistered = profile.vatRegistered === 'true'; delete profile.reviewed;
  button.disabled = true;
  try {
    await sendApiRequest('/api/platform-account/profile', { method: 'PUT', body: { revision: Number(form.dataset.revision), profile } });
    if (context !== `${authGeneration}:${authToken}:${apiUrl('')}` || !form.isConnected) return;
    const statement = form.closest('[data-platform-statement]');
    await loadPlatformStatement(statement);
    if (context === `${authGeneration}:${authToken}:${apiUrl('')}` && statement.isConnected && statement.querySelector('[data-client-billing]')) {
      const saved = document.createElement('p'); saved.setAttribute('role', 'status');
      saved.textContent = 'Billing details saved. Future invoices will use these details.';
      statement.prepend(saved);
    }
  } catch (error) { if (context === `${authGeneration}:${authToken}:${apiUrl('')}`) target.textContent = error.message || 'Could not save billing details.'; }
  finally { button.disabled = false; }
});
document.addEventListener('click', async (event) => {
  if (event.target.closest('[data-open-platform-statement]')) {
    document.querySelector('#platform-account-button').click();
    return;
  }
  const refresh = event.target.closest('[data-refresh-platform-statement]');
  if (refresh) {
    const target = refresh.closest('[data-platform-statement]');
    if (target) await loadPlatformStatement(target);
    return;
  }
  const view = event.target.closest('[data-view-platform-invoice]'), pay = event.target.closest('[data-pay-platform-invoice]');
  const download = event.target.closest('[data-download-platform-invoice]');
  const simulate = event.target.closest('[data-simulate-platform-payment]');
  const simulateBlock = event.target.closest('[data-simulate-billing-block]');
  if (!view && !pay && !download && !simulate && !simulateBlock) return;
  const button = view || pay || download || simulate || simulateBlock;
  const context = `${authGeneration}:${authToken}:${apiUrl('')}`;
  button.disabled = true;
  try {
    if (download) {
      const data = await sendApiRequest(`/api/platform-account/invoice/${encodeURIComponent(download.dataset.downloadPlatformInvoice)}?format=pdf`);
      if (context !== `${authGeneration}:${authToken}:${apiUrl('')}` || !button.isConnected) return;
      const bytes = Uint8Array.from(atob(data.base64), (char) => char.charCodeAt(0));
      if (data.contentType !== 'application/pdf' || new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new Error('The server did not return a valid PDF invoice.');
      if (Capacitor.isNativePlatform()) {
        const saved = await Filesystem.writeFile({ path: data.filename, data: data.base64, directory: Directory.Cache });
        await Share.share({ title: 'PrimeOps invoice', url: saved.uri, dialogTitle: 'Save PDF invoice' });
      } else {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        const link = document.createElement('a'); link.href = url; link.download = data.filename; link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    } else if (view) {
      const data = await sendApiRequest(`/api/platform-account/invoice/${encodeURIComponent(view.dataset.viewPlatformInvoice)}`);
      if (context !== `${authGeneration}:${authToken}:${apiUrl('')}` || !button.isConnected) return;
      const dialog = document.querySelector('#invoice-document-dialog');
      dialog.querySelector('iframe').srcdoc = data.html; dialog.showModal();
    } else if (simulate || simulateBlock) {
      const outcome = simulateBlock ? 'block' : simulate.dataset.outcome;
      const body = { simulationId: crypto.randomUUID(), invoiceId: simulateBlock
        ? simulateBlock.closest('[data-platform-statement]')?.querySelector('[data-simulate-platform-payment]')?.dataset.simulatePlatformPayment
        : simulate.dataset.simulatePlatformPayment, outcome };
      if (outcome === 'partial') body.amountCents = Math.floor(Number(simulate.dataset.outstandingCents) / 2);
      if (!body.invoiceId) throw new Error('Refresh the test statement and choose an unpaid invoice.');
      await sendApiRequest('/api/platform-account/simulate-payment', { method: 'POST', body });
      if (context !== `${authGeneration}:${authToken}:${apiUrl('')}`) return;
      await initializeAuthentication();
      const target = currentUser?.billingBlocked
        ? document.querySelector('#platform-account-screen [data-platform-statement]')
        : document.querySelector('#platform-account-dialog [data-platform-statement]');
      if (target) {
        await loadPlatformStatement(target);
        const status = target.querySelector('[data-simulated-payment-status]');
        if (status) status.textContent = outcome === 'block' ? 'Test arrears lock simulated. No real payment or account charge occurred.'
          : `Test ${outcome === 'success' ? 'full' : outcome === 'partial' ? 'partial' : 'declined'} payment simulated. No money was collected.`;
      }
    } else {
      const options = await sendApiRequest('/api/platform-account/payment-options');
      if (context !== `${authGeneration}:${authToken}:${apiUrl('')}` || !button.isConnected) return;
      if (!options.configured) throw new Error(options.message);
      if (options.sandbox && !window.confirm(options.message + ' Continue with a test payment?')) return;
      const result = await sendApiRequest('/api/platform-account/checkout', { method: 'POST', body: { invoiceId: pay.dataset.payPlatformInvoice } });
      if (context !== `${authGeneration}:${authToken}:${apiUrl('')}` || !button.isConnected) return;
      if (!['https://www.payfast.co.za/eng/process', 'https://sandbox.payfast.co.za/eng/process'].includes(result.action)) throw new Error('Unexpected payment provider address.');
      const form = document.createElement('form'); form.method = 'POST'; form.action = result.action;
      for (const [name, value] of Object.entries(result.fields)) {
        const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; form.append(input);
      }
      document.body.append(form); form.submit(); form.remove();
    }
  } catch (error) { alertError(error, 'Could not download/open invoice or card payment.'); }
  finally { button.disabled = false; }
});

document.querySelector('#signout-button').addEventListener('click', async () => {
  try {
    await offlineAuth.signOut();
  } catch (error) {
    alertError(error, 'Could not sign out on this device.');
    return;
  }
  authToken = '';
  authGeneration++;
  currentUser = null;
  currentView = 'home';
  ticketListView = 'active';
  offlineMode = false;
  localStorage.removeItem(authTokenKey);
  localStorage.removeItem(cachedUserKey);
  showSignIn();
  document.querySelector('#offline-banner').hidden = true;
});

document.querySelector('#sync-status').addEventListener('click', resolveSyncConflict);
window.addEventListener('online', () => {
  void reconnectOffline();
});
window.addEventListener('offline', () => {
  offlineMode = true;
  if (currentUser) void offlineStore.status().then((saved) => updateOfflineStatus(saved, 'Offline - changes stay on this phone until uploaded. Apartment access changes need a live connection.')).catch((error) => alertError(error, 'Could not read offline storage.'));
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
  const properties = new Map();
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
    licenceClient.assertActive();
    if (stateLoadError) throw stateLoadError;
    const metadata = await readSyncMetadata();
    await databaseRequest('readwrite', (store) => {
      store.put(nextState, 'state');
      return store.put({
        server: apiUrl(''),
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
  if (view === 'tickets' && currentView !== 'tickets') ticketListView = 'active';
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
  const opsAccess = hasOpsAccess();
  const checksAccess = canUseSection(currentUser, 'checks');
  const sections = [...document.querySelectorAll('.module-nav [data-view]')]
    .filter((button) => !button.hidden && button.dataset.view !== 'home');
  const navigation = sections.map((button) => {
    const view = button.dataset.view;
    return `<button type="button" class="home-section-card" data-home-view="${escapeHtml(view)}">
      <span class="home-section-icon" aria-hidden="true">${navigationPicture(view)}</span>
      <span class="home-section-copy"><strong>${escapeHtml(button.textContent.trim())}</strong></span>
      <span class="home-section-arrow" aria-hidden="true">&rarr;</span>
    </button>`;
  }).join('');
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
      <p class="eyebrow">YOUR WORKSPACE · PRIMEOPS</p>
      <div class="home-heading">
        <div><h1>Where would you like to go?</h1><p class="home-intro">All your sections are below. Tap a card to get started, and use Home to return here.</p></div>
        <button type="button" class="button secondary" data-subscribe>Subscribe</button>
        <button type="button" class="button secondary" data-company-features>Features</button>
      </div>
      <nav class="home-section-grid" aria-label="All workspace sections">${navigation}</nav>
      ${currentUser?.role === 'admin' ? '<section class="storage-panel" data-platform-account-summary role="status">Loading your company’s PrimeOps invoices...</section>' : ''}
      ${canUseSection(currentUser, 'assets') ? '<section class="storage-panel" data-asset-reminders role="status">Checking due asset inspections...</section>' : ''}
      ${opsAccess ? '<details class="home-summary"><summary>Inspection summary & quick actions</summary>' : ''}
      ${opsAccess ? `<div class="home-total"><span>PROJECTS ON THIS DEVICE</span><strong>${state.surveys.length + state.buildingChecks.length}</strong><small>Lighting and building checks</small></div>` : ''}
      ${checksAccess ? `<section class="home-condition-summary" aria-label="Building check conditions">
        <span class="home-summary-label">BUILDING CHECKS</span>
        <button class="condition-count good" type="button" data-check-filter="good" aria-label="Show ${goodCount} good checks"><strong>${goodCount}</strong><span>Good</span></button>
        <button class="condition-count needs-attention" type="button" data-check-filter="needs-attention" aria-label="Show ${attentionCount} checks needing attention"><strong>${attentionCount}</strong><span>Needs attention</span></button>
        <button class="condition-count bad" type="button" data-check-filter="bad" aria-label="Show ${badCount} bad checks"><strong>${badCount}</strong><span>Bad</span></button>
        <button class="condition-count open" type="button" data-check-filter="open" aria-label="Show ${openCount} open checks"><strong>${openCount}</strong><span>Open</span></button>
      </section>
      <p class="account-status">${state.buildingChecks.length} saved building project(s) &middot; ${checkCount} checks &middot; ${openCount} open</p>` : ''}
      ${opsAccess ? `
      <section class="home-quick-actions">
        <div><p class="eyebrow">GET STARTED</p><h2>Start a new record</h2></div>
        ${canUseSection(currentUser, 'lighting') ? '<button class="button secondary" type="button" data-action="new">Start a light survey <span aria-hidden="true">＋</span></button>' : ''}
        ${checksAccess ? '<button class="button secondary" type="button" data-action="checks">Choose property & checklist <span aria-hidden="true">→</span></button>' : ''}
      </section>` : ''}
      ${opsAccess ? '</details>' : ''}
      <p class="workspace-footer">Records stay on this device. Keep exported reports and project files private.</p>
      <details><summary>Device backup</summary><button class="button secondary" type="button" data-device-transfer>Move device data</button></details>
    </div>`;
  void refreshPlatformLedger();
  const reminders = workspace.querySelector('[data-asset-reminders]');
  if (reminders) {
    const context = `${authGeneration}:${authToken}:${apiUrl('')}`;
    void apiRequest('/api/operations/assets').then((data) => {
      if (!reminders.isConnected || context !== `${authGeneration}:${authToken}:${apiUrl('')}`) return;
      const today = new Date().toISOString().slice(0, 10);
      const due = data.records.filter((row) => row.status !== 'retired' && row.data.nextInspectionOn && row.data.nextInspectionOn <= today);
      reminders.innerHTML = `<h2>Asset inspection reminders</h2>${due.length ? `<p>${due.length} asset(s) due or overdue.</p><ul>${due.map((row) => `<li>${escapeHtml(row.building_name)} / ${escapeHtml(row.data.name)} (${escapeHtml(row.data.assetTag)}) - due ${escapeHtml(row.data.nextInspectionOn)}</li>`).join('')}</ul><button class="button primary" type="button" data-home-view="assets">Open asset inspections</button>` : '<p>No scheduled inspections due in your building access.</p>'}`;
    }).catch((error) => {
      if (reminders.isConnected && context === `${authGeneration}:${authToken}:${apiUrl('')}`) reminders.textContent = `Asset reminders unavailable: ${error.message}. Connect and reopen Home to retry.`;
    });
  }
}

function renderCheckProjects() {
  const properties = state.properties;
  workspace.innerHTML = `
    <div class="checks-view">
      <div class="page-heading">
        <div><p class="eyebrow">OPERATIONS & OHS</p><h1>Select a property</h1>
        </div>${isManagementRole(currentUser?.role) ? '<button type="button" class="button secondary" data-manage-checklists>Create / import checklists</button>' : ''}
      </div>
      <div class="property-grid">${properties.map((property) => {
        const projects = state.buildingChecks.filter((project) => project.propertyId === property.id);
        const open = projects.reduce((count, project) => count + (project.runStatus === 'submitted' ? 0 : 1), 0);
        return `<article class="building-card">
          <div class="building-card-top"><span class="eyebrow">${escapeHtml(property.city || 'PROPERTY')}</span><span class="status-chip">${templatesForBuilding(property.id).length} forms</span></div>
          <h2>${escapeHtml(property.name)}</h2><p>${escapeHtml(property.city || 'Location not set')}</p>
          <div class="building-stats"><span><strong>${projects.length}</strong> saved runs</span><span><strong>${open}</strong> drafts</span></div>
          <button class="button dark" type="button" data-action="select-property" data-property-id="${escapeHtml(property.id)}">Open property →</button>
        </article>`;
      }).join('') || '<p>No buildings yet. Add one under Users.</p>'}</div>
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
  const templates = templatesForBuilding(property.id).map((template) => {
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
    <div class="checks-view property-checklists-view" data-section-group="property-forms-${escapeHtml(property.id)}">
      <div class="page-heading"><div><p class="eyebrow">${escapeHtml(property.city || 'PROPERTY')} · MONTHLY CHECKS</p>
        <h1>${escapeHtml(property.name)}</h1><p>Choose a standard form to answer and submit this month’s inspection.</p></div>
        <div class="page-heading-actions"><button class="button secondary" type="button" data-action="checks">All properties</button>
          ${isManagementRole(currentUser?.role) ? '<button class="button secondary" type="button" data-manage-checklists>Create / import checklists</button>' : ''}
          <button class="button secondary" type="button" data-action="import-checks">Import completed checklist</button></div>
      </div>
      ${sectionTabs(`property-forms-${property.id}`, 'Building form sections', [['new', 'Start a check'], ['saved', 'Saved checks']])}
      <section ${sectionPanel(`property-forms-${property.id}`, 'new')}>
      <div class="form-template-grid">${templates || '<p>No checklists yet. Create or import one.</p>'}</div>
      </section>
      <section ${sectionPanel(`property-forms-${property.id}`, 'saved')}>
      <section class="detail-panel"><div class="history-heading"><h2>Saved monthly runs</h2><span class="count">${projects.length}</span></div>
        <div class="saved-month-run-list">${savedRuns || '<p class="empty-list">No monthly runs saved for this property yet.</p>'}</div></section>
      ${legacyRuns ? `<section class="detail-panel"><div class="history-heading"><h2>Existing checklists</h2><span class="count">${projects.filter((project) => !project.templateId).length}</span></div>
        <div class="saved-month-run-list">${legacyRuns}</div></section>` : ''}
      </section>
    </div>`;
}

async function startPropertyTemplate(propertyId, templateId) {
  await stateReady;
  if (stateLoadError) throw stateLoadError;
  const property = state.properties.find((item) => item.id === propertyId);
  const template = templatesForBuilding(propertyId).find((item) => item.id === templateId);
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
    sourceColumns: template.sourceColumns || null,
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
      sourceCells: question.sourceCells || null,
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
    const template = projectTemplate(project);
    const questions = project.checks.map((check, index) => {
      const photos = (check.photos || []).map((photo) => `<figure><img src="${escapeHtml(photo.data)}" alt="Evidence for ${escapeHtml(check.title)}"><figcaption>${escapeHtml(formatDateTime(photo.createdAt))}</figcaption></figure>`).join('');
      const edits = project.firstSubmittedAt
        ? (check.history || []).filter((entry) => entry.createdAt > project.firstSubmittedAt)
        : [];
      const history = edits.map((entry) => `<li>${escapeHtml(formatDateTime(entry.createdAt))} · ${escapeHtml(entry.changedBy || 'Not recorded')} · ${entry.previousAnswer ? `${escapeHtml(entry.previousAnswer)} → ` : ''}${escapeHtml(entry.answer || 'No answer recorded')}</li>`).join('');
      return `<article class="report-check"><h2>${index + 1}. ${escapeHtml(check.title)}${edits.length ? ' <small>(Edited)</small>' : ''}</h2>
        <p><strong>Answer:</strong> ${reportBadge(check.answer || 'Not answered', !check.answer ? 'attention' : check.answer === 'Fail' ? 'bad' : check.answer === 'Pass' ? 'good' : 'neutral')}</p>${photos ? `<h3>Photos</h3>${photos}` : ''}
        ${history ? `<h3>Edited after submission</h3><ul>${history}</ul>` : ''}</article>`;
    }).join('');
    return reportDocument({
      title: template?.title || project.templateTitle, subtitle: project.buildingName, category: 'Monthly property check',
      metadata: [
        ['City', state.properties.find((item) => item.id === project.propertyId)?.city || 'Not recorded'],
        ['Inspection date', formatDate(project.inspectionDate)], ['Inspector', project.inspectorName],
        ['Submitted by', project.submittedBy || project.lastChangedBy || 'Not recorded'],
        ['Submitted', formatDateTime(project.submittedAt || project.updatedAt)]
      ],
      summary: [['Checklist items', project.checks.length], ['Answered', project.checks.filter((check) => check.answer).length],
        ['Unanswered', project.checks.filter((check) => !check.answer).length],
        ['Evidence photos', project.checks.reduce((total, check) => total + (check.photos || []).length, 0)]],
      body: `${project.sourceColumns?.length ? `<h2>Imported checklist spreadsheet</h2><table><thead><tr>${project.sourceColumns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}<th>Answer</th></tr></thead><tbody>${project.checks.map((check) => `<tr>${project.sourceColumns.map((_, column) => `<td>${escapeHtml(check.sourceCells?.[column] || '')}</td>`).join('')}<td>${escapeHtml(check.answer || 'Not answered')}</td></tr>`).join('')}</tbody></table>` : ''}${questions}`
    });
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
        <strong>Status:</strong> ${reportBadge(statusLabel(check.status))} ·
        <strong>Condition:</strong> ${reportBadge(conditionLabel(check.condition), check.condition === 'good' ? 'good' : check.condition === 'bad' ? 'bad' : 'attention')} ·
        <strong>Severity:</strong> ${escapeHtml(check.severity.replaceAll('-', ' '))}</p>
      ${check.description ? `<p><strong>Description:</strong> ${escapeHtml(check.description)}</p>` : ''}
      ${check.notes ? `<p class="notes"><strong>Inspector notes:</strong> ${escapeHtml(check.notes)}</p>` : ''}
      ${photos ? `<h3>Photos</h3>${photos}` : '<p>No photos attached.</p>'}
      ${history ? `<h3>History</h3><ul>${history}</ul>` : ''}</article>`;
  }).join('');
  return reportDocument({
    title: 'Building checklist', subtitle: project.buildingName, category: 'Property condition',
    metadata: [['Inspector', project.inspectorName], ['Inspection date', formatDate(project.inspectionDate)],
      ['Report generated', formatDateTime(new Date().toISOString())]],
    summary: [['Checklist items', project.checks.length], ['Good condition', project.checks.filter((check) => check.condition === 'good').length],
      ['Needs attention / bad', project.checks.filter((check) => ['needs-attention', 'bad'].includes(check.condition)).length],
      ['Not assessed', project.checks.filter((check) => !check.condition || check.condition === 'not-assessed').length]],
    body: checks || '<p>No checklist items recorded.</p>'
  });
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
  const template = projectTemplate(project);
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
    <div class="checks-view monthly-form-view" data-section-group="monthly-${escapeHtml(project.id)}">
      <div class="page-heading"><div><p class="eyebrow">${escapeHtml(property.city)} · ${escapeHtml(formatMonth(project.monthKey))}</p>
        <h1>${escapeHtml(property.name)}</h1><p>${escapeHtml(template.title)} · ${answeredCount} of ${project.checks.length} answered</p>
        <p class="checklist-guidance">${project.firstSubmittedAt ? `Submitted ${escapeHtml(formatDateTime(project.submittedAt))} by ${escapeHtml(project.submittedBy || 'Not recorded')}. Edit time-sensitive items below, then resubmit to save an updated report; earlier reports are kept.` : 'Answer the form questions below. Attach photos where prompted. This monthly run is saved separately from previous months.'}</p></div>
        <div class="page-heading-actions"><button class="button secondary" type="button" data-action="property-checklists">All ${escapeHtml(property.name)} forms</button>
          <button class="button secondary" type="button" data-action="start-next-month" data-project-id="${escapeHtml(project.id)}">Next month <span aria-hidden="true">＋</span></button></div>
      </div>
      ${sectionTabs(`monthly-${project.id}`, 'Monthly check sections', [['details', 'Inspection details'], ['questions', 'Questions'], ['reports', 'Submitted reports']], project.inspectorName ? 'questions' : 'details')}
      <form id="monthly-template-form" data-project-id="${escapeHtml(project.id)}">
        <section ${sectionPanel(`monthly-${project.id}`, 'details')}>
        <div class="check-project-fields monthly-run-fields">
          <label>Inspector<input name="inspectorName" maxlength="100" value="${escapeHtml(project.inspectorName || '')}" required /></label>
          <label>Inspection date<input name="inspectionDate" type="date" value="${escapeHtml(project.inspectionDate)}" required /></label>
          <label>Changed by<input name="changedBy" maxlength="100" value="${escapeHtml(project.lastChangedBy || '')}" required /></label>
        </div>
        </section>
        <section ${sectionPanel(`monthly-${project.id}`, 'questions')}>
        ${project.sourceColumns?.length ? `<div class="import-sheet-scroll"><table class="import-sheet"><thead><tr>${project.sourceColumns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}<th>Checklist answer / evidence</th></tr></thead><tbody>${project.checks.map((check, index) => `<tr>${project.sourceColumns.map((_, column) => `<td>${escapeHtml(check.sourceCells?.[column] || '')}</td>`).join('')}<td>${renderTemplateQuestion(check, index)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="template-question-list">${project.checks.map((check, index) => renderTemplateQuestion(check, index)).join('')}</div>`}
        </section>
        <div class="checklist-submit-bar"><button class="button secondary" type="submit">${project.firstSubmittedAt ? 'Save changes' : 'Save progress'}</button>
          <button class="button primary" type="submit" data-submit-monthly="true">${project.firstSubmittedAt ? 'Save & resubmit edited report' : 'Submit monthly check'}</button></div>
      </form>
      <section class="detail-panel" ${sectionPanel(`monthly-${project.id}`, 'reports')}><div class="history-heading"><h2>Previous submissions</h2><span class="count">${project.reports?.length || 0}</span></div>
        <div class="report-revision-list">${reports || '<p class="empty-list">No report submitted for this month yet.</p>'}</div></section>
    </div>`;
}

async function saveMonthlyTemplate(form, submitRun) {
  await stateReady;
  if (stateLoadError) throw stateLoadError;
  const project = state.buildingChecks.find((item) => item.id === form.dataset.projectId);
  if (!project?.templateId) throw new Error('The monthly checklist is no longer available.');
  const template = projectTemplate(project);
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
    <div class="checks-view" data-section-group="legacy-${escapeHtml(project.id)}">
      <div class="page-heading"><div><p class="eyebrow">BUILDING CHECKS · ${escapeHtml(formatMonth(project.monthKey || project.inspectionDate))}</p>
        <h1>Edit building checklist</h1><p>${project.checks.length} checks · expand items to update them without leaving this list</p>
        <p class="checklist-guidance">Last saved by ${escapeHtml(project.lastChangedBy || 'Not recorded')} · ${escapeHtml(formatDateTime(project.updatedAt || project.createdAt))}</p>
        <p class="checklist-guidance">Set condition, severity, status, notes, and photos; save once for the entire building. Repaired checks need a new repair note, and verification is available only after repair.</p></div>
        <div class="page-heading-actions"><button class="button secondary" type="button" data-action="checks">All buildings</button>
          <button class="button primary" type="button" data-action="start-next-month" data-project-id="${escapeHtml(project.id)}">Create next month <span aria-hidden="true">＋</span></button></div>
      </div>
      ${sectionTabs(`legacy-${project.id}`, 'Checklist sections', [['details', 'Inspection details'], ['items', 'Checklist items'], ['reports', 'Reports']], 'items')}
      <form id="checklist-edit-form" data-project-id="${escapeHtml(project.id)}">
        <section ${sectionPanel(`legacy-${project.id}`, 'details')}>
        <div class="check-project-fields">
          <label>Building name<input name="buildingName" maxlength="100" value="${escapeHtml(project.buildingName)}" required /></label>
          <label>Inspector name<input name="inspectorName" maxlength="100" value="${escapeHtml(project.inspectorName)}" required /></label>
          <label>Inspection date<input name="inspectionDate" type="date" value="${escapeHtml(project.inspectionDate)}" required /></label>
          <label>Changed by<input name="changedBy" maxlength="100" value="${escapeHtml(project.lastChangedBy)}" required /></label>
        </div>
        </section>
        <section ${sectionPanel(`legacy-${project.id}`, 'items')}>
        <div class="checklist-edit-heading"><h2>Checklist items</h2><button class="button secondary" type="button" data-action="add-check-to-list">＋ Add check</button></div>
        <div class="check-list" id="checklist-edit-list">${project.checks.map((check, index) => renderChecklistEditorRow(check, index, index === 0)).join('')}</div>
        </section>
        <div class="checklist-submit-bar">
          <button class="button secondary" type="submit">Save checklist</button>
          <button class="button primary" type="submit" data-export-report="true">Save checklist & export building report</button>
        </div>
      </form>
      <section class="detail-panel" ${sectionPanel(`legacy-${project.id}`, 'reports')}><div class="history-heading"><h2>Saved building reports</h2><span class="count">${project.reports?.length || 0}</span></div>
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
  return reportDocument({
    title: check.title, subtitle: project.buildingName, category: 'Building condition record',
    metadata: [['Inspector', project.inspectorName], ['Inspection date', formatDate(project.inspectionDate)], ['Location', check.location || 'Not specified']],
    summary: [['Status', statusLabel(check.status)], ['Condition', conditionLabel(check.condition)], ['Severity', check.severity.replaceAll('-', ' ')]],
    body: `${check.description ? `<p><strong>Check description:</strong> ${escapeHtml(check.description)}</p>` : ''}${check.reference ? `<p><strong>Reference:</strong> ${escapeHtml(check.reference)}</p>` : ''}
    <h2>Current inspector notes</h2><p class="notes">${escapeHtml(check.notes || 'No notes recorded.')}</p><h2>Condition photos</h2>${photos || '<p>No photos attached.</p>'}
    <h2>Repair and inspection history</h2>${history || '<p>No updates recorded.</p>'}`
  });
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
    <div class="check-detail" data-section-group="check-${escapeHtml(check.id)}">
      <div class="breadcrumbs"><button class="text-button" type="button" data-action="checks">Building checks</button><span>›</span><span>${escapeHtml(project.buildingName)}</span></div>
      <div class="page-heading"><div><p class="eyebrow">${escapeHtml(check.category || 'BUILDING CHECK')}</p><h1>${escapeHtml(check.title)}</h1>
        <p>${escapeHtml(check.location || 'Location not specified')} · ${escapeHtml(project.buildingName)}</p></div>
        <div class="detail-actions"><button class="button secondary" type="button" data-action="update-check">Edit check</button>
        <button class="button primary" type="button" data-action="export-check">Save & export report</button></div>
      </div>
      ${sectionTabs(`check-${check.id}`, 'Building check sections', [['overview', 'Details'], ['photos', 'Photos'], ['reports', 'Reports'], ['history', 'History']])}
      <section ${sectionPanel(`check-${check.id}`, 'overview')}>
      <div class="condition-overview"><span class="status-chip ${check.status === 'verified' ? 'complete' : 'attention'}">${escapeHtml(statusLabel(check.status))}</span>
        <div><span>Condition</span><strong class="condition-value ${escapeHtml(check.condition)}">${escapeHtml(conditionLabel(check.condition))}</strong></div>
        <div><span>Severity</span><strong>${escapeHtml(check.severity.replaceAll('-', ' '))}</strong></div>
        <div><span>Last updated</span><strong>${escapeHtml(formatDateTime(check.updatedAt || check.createdAt))}</strong></div>
      </div>
      ${check.description ? `<section class="detail-panel"><h2>Check description</h2><p>${escapeHtml(check.description)}</p>${check.reference ? `<p class="muted">Reference: ${escapeHtml(check.reference)}</p>` : ''}</section>` : ''}
      <section class="detail-panel"><h2>Inspector notes</h2><p class="notes">${escapeHtml(check.notes || 'No notes recorded.')}</p></section>
      </section>
      <section class="detail-panel" ${sectionPanel(`check-${check.id}`, 'photos')}><h2>Condition photos <span class="count">${check.photos.length}</span></h2><div class="check-photo-grid">${photos || '<p class="empty-list">No condition photos attached yet.</p>'}</div></section>
      <section class="detail-panel" ${sectionPanel(`check-${check.id}`, 'reports')}><div class="history-heading"><h2>Saved report revisions</h2><span class="count">${check.reports?.length || 0}</span></div>
        <p class="muted">Each saved version is a snapshot. Edit the check and save a new report to keep the earlier version.</p>
        <div class="report-revision-list">${reports || '<p class="empty-list">No reports saved yet. Save and export a report to create the first version.</p>'}</div></section>
      <section class="detail-panel" ${sectionPanel(`check-${check.id}`, 'history')}><h2>Repair and inspection history</h2><div class="history-list">${history || '<p class="empty-list">Updates and repair evidence will appear here.</p>'}</div></section>
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

async function createChecklistOcrWorker(status) {
  const { createWorker } = await import('tesseract.js');
  return createWorker('eng', undefined, {
    workerPath: `${ocrAssetPath}worker.min.js`, corePath: `${ocrAssetPath}core`, langPath: `${ocrAssetPath}lang`,
    workerBlobURL: false,
    logger: (message) => {
      if (message.status === 'recognizing text') status.textContent = `Reading scanned checklist: ${Math.round(message.progress * 100)}%`;
      else if (message.status === 'loading language traineddata') status.textContent = 'Loading offline English OCR data...';
    }
  });
}
async function readChecklistImage(file, status) {
  const worker = await createChecklistOcrWorker(status);
  try {
    const result = await worker.recognize(file);
    return result.data.text.split(/\r?\n/).filter((line) => line.trim()).map((line) => line.trim().split(/\t+|\s{2,}/));
  } finally { await worker.terminate(); }
}
async function readPdfChecklistRows(file, status, preserveTable = false) {
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
    const lines = [], tableRows = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      status.textContent = `Reading PDF text · page ${pageNumber} of ${pdf.numPages}`;
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      let pageLines = pdfPageLines(textContent.items);
      let pageRows = pdfTableRows(textContent.items);
      if (pageLines.join(' ').length < 40) {
        if (!ocrWorker) {
          status.textContent = 'Preparing offline English OCR…';
          ocrWorker = await createChecklistOcrWorker(status);
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
        pageRows = pageLines.filter((line) => line.trim()).map((line) => line.trim().split(/\t+|\s{2,}/));
        canvas.width = 0;
        canvas.height = 0;
      }
      lines.push(...pageLines);
      tableRows.push(...pageRows);
      page.cleanup();
    }
    if (preserveTable) {
      if (!tableRows.some((row) => row.some((cell) => cell.trim()))) throw new Error('No readable checklist text was found. Try a clearer scan.');
      return tableRows;
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
  const filename = 'PrimeOps-Building-Checks-Template.csv';
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
  document.querySelector('.module-nav').classList.remove('is-open');
  document.querySelector('#section-menu-toggle').setAttribute('aria-expanded', 'false');
  const ticketsOnly = !hasOpsAccess();
  const section = ['checks', 'property-checks', 'check-project', 'check-filter', 'check-detail'].includes(currentView) ? 'checks'
    : currentView === 'log-ticket' ? 'tickets' : currentView;
  if (accountSections.some(([id]) => id === section) && !canUseSection(currentUser, section)) currentView = 'home';
  if (currentUser?.role === 'user' && !['home', 'tickets', 'log-ticket', 'billing', 'security', 'residents', 'incidents', 'leasing'].includes(currentView)) currentView = 'home';
  if (currentUser?.role === 'technician' && !['home', 'appliances'].includes(currentView)) currentView = 'home';
  if (currentUser?.role === 'maintenance_assistant' && ['users', 'billing', 'storage', 'appliances', 'log-ticket'].includes(currentView)) currentView = 'tickets';
  const mainView = ['property-checks', 'check-project', 'check-filter', 'check-detail'].includes(currentView) ? 'checks' : currentView;
  for (const button of document.querySelectorAll('.module-nav [data-view]')) {
    if (button.dataset.view === mainView) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  document.querySelector('#section-menu-current').textContent = document.querySelector(`.module-nav [data-view="${mainView}"]`)?.textContent.trim() || 'Home';
  renderSurveyList();
  const homeButton = document.querySelector('#home-button');
  const backButton = document.querySelector('#back-button');
  const lightingNav = document.querySelector('[data-view="lighting"]');
  const checksNav = document.querySelector('[data-view="checks"]');
  const homeNav = document.querySelector('[data-view="home"]');
  homeButton.hidden = currentView === 'home';
  backButton.hidden = currentView === 'home';
  homeNav.hidden = false;
  homeNav.classList.toggle('active', currentView === 'home');
  lightingNav.classList.toggle('active', currentView === 'lighting');
  document.querySelector('[data-view="users"]').classList.toggle('active', currentView === 'users');
  document.querySelector('[data-view="tickets"]').classList.toggle('active', currentView === 'tickets');
  document.querySelector('[data-view="storage"]').classList.toggle('active', currentView === 'storage');
  document.querySelector('[data-view="billing"]').classList.toggle('active', currentView === 'billing');
  document.querySelector('[data-view="leasing"]').classList.toggle('active', currentView === 'leasing');
  document.querySelector('[data-view="log-ticket"]').classList.toggle('active', currentView === 'log-ticket');
  document.querySelector('[data-view="appliances"]').classList.toggle('active', currentView === 'appliances');
  document.querySelectorAll('[data-view="lighting"], [data-view="checks"]').forEach((button) => {
    button.hidden = ticketsOnly || !canUseSection(currentUser, button.dataset.view);
  });
  checksNav.classList.toggle('active', ['checks', 'property-checks', 'check-project', 'check-filter', 'check-detail'].includes(currentView));
  surveyList.hidden = currentView !== 'lighting';
  document.querySelector('.rail-heading').hidden = currentView !== 'lighting';
  document.querySelector('#new-survey').hidden = currentView !== 'lighting';
  document.querySelector('#import-project').hidden = currentView !== 'lighting';
  if (currentView === 'home') {
    renderHome();
    return;
  }
  if (operationIds.includes(currentView)) {
    void operationsView.render(currentView);
    return;
  }
  if (currentView === 'leasing') {
    void leasingView.render();
    return;
  }
  if (currentView === 'appliances') {
    void applianceView.render();
    return;
  }
  if (['tickets', 'log-ticket'].includes(currentView)) {
    void renderTickets();
    return;
  }
  if (currentView === 'billing') {
    if (!hasFullAccess() && currentUser?.role !== 'user') {
      currentView = 'home';
      renderHome();
      return;
    }
    void renderBilling();
    return;
  }
  if (currentView === 'storage') {
    if (currentUser?.role !== 'admin') {
      currentView = 'home';
      renderHome();
      return;
    }
    void renderStorageSettings();
    return;
  }
  if (currentView === 'users') {
    if (!hasFullAccess()) {
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
    <div class="survey-view" data-section-group="lighting-${escapeHtml(survey.id)}">
      <div class="survey-topline">
        <div class="survey-title">
          <p class="eyebrow">OHS LIGHTING PROJECT / ${escapeHtml(formatDate(survey.inspectionDate).toUpperCase())}</p>
          <h2>${escapeHtml(survey.buildingName || 'Building name required')}</h2>
          <p class="survey-meta">Inspector: ${escapeHtml(survey.inspectorName || 'Required')} · Inspection date: ${escapeHtml(formatDate(survey.inspectionDate))} · ${totalReadings} readings</p>
          ${survey.restoredFromReportId ? '<p class="survey-meta restored-note">Editable copy restored from a saved report; original project and report are preserved.</p>' : ''}
        </div>
      </div>
      ${sectionTabs(`lighting-${survey.id}`, 'Lighting project sections', [
        ['measure', 'Measure'], ['entries', 'Entries'], ['readings', 'Readings'], ['photos', 'Photos'], ['reports', 'Reports']
      ], entry ? 'measure' : 'entries')}
      <div class="entry-toolbar">
        <label for="entry-select">INSPECTION ENTRY</label>
        <select id="entry-select" ${survey.entries.length ? '' : 'disabled'}>
          ${survey.entries.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === entry?.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}
        </select>
      </div>
      <section ${sectionPanel(`lighting-${survey.id}`, 'entries')}>
      <h3>Inspection entries</h3>
      <button class="button secondary" type="button" data-action="project-details">Project details</button>
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
      <div class="project-entries section-label"><h3>ALL PROJECT ENTRIES</h3></div>
      <div class="entry-list">${survey.entries.length ? survey.entries.map((item) => `
        <button type="button" class="entry-card ${item.id === entry?.id ? 'active' : ''}" data-entry="${escapeHtml(item.id)}">
          <strong>${escapeHtml(item.name || 'Unnamed entry')}</strong>
          <span>${item.readings.length} readings · ${item.photos.length} photos</span>
        </button>`).join('') : '<p class="empty-list">No inspection entries yet.</p>'}</div>
      </section>
      <section ${sectionPanel(`lighting-${survey.id}`, 'measure')}>
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
      </section>
      <section ${sectionPanel(`lighting-${survey.id}`, 'readings')}>
      <div class="list-heading section-label"><h3>READINGS · ${escapeHtml(entry?.name || 'NO ENTRY')}</h3><span class="count">${readings.length} ${readings.length === 1 ? 'reading' : 'readings'}</span></div>
      <div class="reading-list">
        <div class="reading-row header"><span>MEASURED</span><span>TARGET</span><span>ASSESSMENT</span><span>RECORDED</span></div>
        ${readings.length ? readings.map(readingRow).join('') : '<p class="empty-list">No readings in this entry yet.</p>'}
      </div>
      </section>
      <section ${sectionPanel(`lighting-${survey.id}`, 'photos')}>
      <div class="photo-heading section-label"><h3>PHOTOS · ${escapeHtml(entry?.name || 'NO ENTRY')}</h3><button class="button subtle" type="button" data-action="photo" ${entry ? '' : 'disabled'}>Add photo</button></div>
      ${photos.length ? `<div class="photo-strip">${photos.map(photoTile).join('')}</div>` : '<p class="photo-empty">No photos attached to this entry.</p>'}
      </section>
      <section ${sectionPanel(`lighting-${survey.id}`, 'reports')}>
        <h3>Reports & sharing</h3>
        <div class="top-actions">
          <button class="button secondary" type="button" data-action="reports">Saved reports (${survey.reports?.length || 0})</button>
          <button class="button secondary" type="button" data-action="share-project">Share project</button>
          <button class="button dark" type="button" data-action="export">Export PDF report <span aria-hidden="true">↗</span></button>
        </div>
      </section>
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
  surveyForm.elements.propertyId.innerHTML = hasFullAccess()
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
      `PRIMEOPS  |  ${survey.buildingName}`,
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
        <td>${reportBadge(assessment, target === null ? 'neutral' : reading.lux >= target ? 'good' : 'bad')}</td>
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

  return reportDocument({
    title: 'Lighting survey report', subtitle: survey.buildingName, category: 'OHS lighting assessment',
    metadata: [['Inspector', survey.inspectorName], ['Inspection date', formatDate(survey.inspectionDate)],
      ['Project ID', survey.id], ['Report generated', formatDateTime(new Date().toISOString())]],
    summary: [['Inspection entries', survey.entries.length], ['Measurements', allReadings.length], ['Evidence photos', allPhotos.length], ['Average lux', average]],
    body: `<button class="no-print" onclick="window.print()">Print / Save as PDF</button><h2>Inspection entries and measurements</h2>${entries || '<p>No inspection entries recorded.</p>'}`,
    footer: `Recommended target: ${recommendedLux} lx; confirm the applicable standard for the task and jurisdiction. Sensor readings retain the raw phone value and the adjusted value. The current adjustment factor (${normalizeCalibration(state.sensorCalibration).factor.toFixed(4)}) is based on an unverified comparison supplied in the app and is not certified calibration. Manual values are identified separately. Confirm workplace lighting requirements for the relevant jurisdiction and task.`
  });
}

function safeFileName(value) {
  return value.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'survey';
}

function reportMeta(building, kind, createdAt, revision) {
  return { building, kind, date: localDateString(new Date(createdAt)), revision: revision || 1 };
}

async function saveReportToServer(html, meta) {
  if (!meta || !authToken) return '';
  try {
    const result = await apiRequest('/api/reports', {
      method: 'POST',
      body: { html, ...meta },
      signal: AbortSignal.timeout(60000)
    });
    return result.queued ? 'Report saved on this device. The server copy will upload when connected.' : `Saved on the server: ${result.path}`;
  } catch (error) {
    return `Not saved on the server: ${error.message}`;
  }
}

function downloadReportHtmlFile(report, survey, reportId) {
  const filename = `OHS-Report-${safeFileName(survey.buildingName)}-${reportId.slice(0, 8)}.html`;
  const url = URL.createObjectURL(new Blob([report], { type: 'text/html;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return filename;
}

async function downloadReport(report, survey, reportId, meta) {
  // The server copy must never block or prevent the local download.
  const serverNote = await saveReportToServer(report, meta).catch((error) => `Not saved on the server: ${error.message}`);
  const serverFailed = serverNote.startsWith('Not saved on the server');
  if (window.desktopApp?.saveReportPdf && meta) {
    const result = await window.desktopApp.saveReportPdf({ html: report, ...meta });
    if (result?.error) throw new Error(result.error);
    window.alert(`Report saved to:\n${result.path}${serverNote ? `\n\n${serverNote}` : ''}`);
    return;
  }
  if (serverNote) window.alert(serverFailed && !Capacitor.isNativePlatform()
    ? `${serverNote}\n\nA copy of the report will be downloaded to this device so it can still be sent to management.`
    : serverNote);
  if (serverFailed && !Capacitor.isNativePlatform()) downloadReportHtmlFile(report, survey, reportId);
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
    format: 'primeops-project',
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
  const filename = `PrimeOps-Project-${safeFileName(survey.buildingName)}.json`;
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
      text: `Editable PrimeOps project: ${survey.buildingName}`,
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
  if (!['primeops-project', legacy.projectFormat].includes(bundle?.format) || bundle.version !== 1 || !bundle.project) {
    throw new Error('This file is not a supported PrimeOps project package.');
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
  const button = event.target.closest('[data-action], [data-photo], [data-entry], [data-check-filter], [data-ticket-capture], [data-ticket-photo], [data-ticket-out-of-stock], [data-ticket-access], [data-ticket-list], [data-home-view]');
  if (!button) return;
  if (button.dataset.homeView) {
    const section = [...document.querySelectorAll('.module-nav [data-view]')]
      .find((item) => item.dataset.view === button.dataset.homeView && !item.hidden);
    if (section) navigateView(section.dataset.view);
    return;
  }
  if (button.dataset.ticketList) {
    const selected = button.dataset.ticketList;
    if (!['active', 'archive'].includes(selected) || selected === ticketListView) return;
    if (ticketFormDirty && !window.confirm('Switch ticket lists and discard your unsent form text? Submitted changes are kept.')) return;
    ticketListView = selected;
    await renderTickets();
    return;
  }
  if (button.dataset.ticketOutOfStock) {
    const note = window.prompt('What is out of stock? (optional note for the maintenance manager)', '');
    if (note === null) return;
    try {
      await apiRequest(`/api/tickets/${encodeURIComponent(button.dataset.ticketOutOfStock)}/status`, { method: 'PUT', body: { status: 'out_of_stock', note } });
      await renderTickets();
    } catch (error) {
      alertError(error, 'Could not mark the ticket out of stock.');
    }
    return;
  }
  if (button.dataset.ticketAccess) {
    const grant = button.dataset.ticketAccess === 'grant';
    const note = grant ? window.prompt('Access instructions (optional), e.g. where the key is:', '') : '';
    if (note === null) return;
    if (grant && !window.confirm('Do you give maintenance staff permission to enter your apartment while you are not there? This will be recorded on the ticket.')) return;
    try {
      await apiRequest(`/api/tickets/${encodeURIComponent(button.dataset.ticketId)}/access`, { method: 'PUT', body: { granted: grant, note } });
      await renderTickets();
    } catch (error) {
      alertError(error, 'Could not update access permission.');
    }
    return;
  }
  if (button.dataset.ticketCapture) {
    await openTicketCamera(button.dataset.ticketCapture);
    return;
  }
  if (button.dataset.ticketPhoto) {
    const photoSession = `${authGeneration}:${authToken}:${apiUrl('')}:${permissionKey(currentUser)}`;
    const assertPhotoSession = () => {
      if (photoSession !== `${authGeneration}:${authToken}:${apiUrl('')}:${permissionKey(currentUser)}`) throw new Error('The signed-in account or building access changed. Reopen this screen.');
    };
    try {
      const localPhoto = await offlineStore.photo(button.dataset.ticketPhoto);
      assertPhotoSession();
      if (localPhoto) {
        document.querySelector('#ticket-photo-image').src = localPhoto;
        document.querySelector('#ticket-photo-dialog').showModal();
        return;
      }
      const response = await fetch(apiUrl(`/api/tickets/${encodeURIComponent(button.dataset.ticketPhoto)}/photo`), {
        headers: { Authorization: `Bearer ${authToken}` },
        signal: AbortSignal.timeout(12000)
      });
      if (!response.ok) throw new Error('Could not load the completion photo.');
      const photo = await response.blob();
      const cachedPhoto = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not save this photo for offline viewing.'));
        reader.readAsDataURL(photo);
      });
      assertPhotoSession();
      await offlineStore.cachePhoto(button.dataset.ticketPhoto, cachedPhoto);
      assertPhotoSession();
      ticketPhotoObjectUrl = URL.createObjectURL(photo);
      document.querySelector('#ticket-photo-image').src = ticketPhotoObjectUrl;
      document.querySelector('#ticket-photo-dialog').showModal();
    } catch (error) {
      alertError(error, 'Could not load the completion photo.');
    }
    return;
  }
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
  currentView = ['home', 'lighting', 'checks', 'tickets', 'log-ticket', 'appliances', 'users', 'storage', 'billing', 'property-checks', 'check-project', 'check-filter'].includes(event.state?.view)
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

workspace.addEventListener('change', (event) => {
  if (event.target.name !== 'when') return;
  const scheduled = event.target.value === 'scheduled';
  const field = document.querySelector('#ticket-schedule-field');
  field.hidden = !scheduled;
  field.querySelector('input').required = scheduled;
});

workspace.addEventListener('submit', async (event) => {
  if (event.target.id === 'create-ticket-form') {
    event.preventDefault();
    const values = new FormData(event.target);
    try {
      await apiRequest('/api/tickets', {
        method: 'POST',
        body: {
          propertyId: values.get('propertyId'),
          subject: values.get('subject'),
          description: values.get('description'),
          unitNumber: currentUser.role === 'user' ? currentUser.unitNumber : values.get('unitNumber'),
          tags: [values.get('tag')],
          scheduledFor: values.get('when') === 'scheduled' && values.get('scheduledFor') ? new Date(String(values.get('scheduledFor'))).toISOString() : null,
          accessGranted: values.get('accessGranted') === 'on',
          accessNote: values.get('accessNote')
        }
      });
      navigateView('tickets');
    } catch (error) {
      alertError(error, 'Could not submit the maintenance ticket.');
    }
    return;
  }
  if (event.target.matches('.ticket-status-form')) {
    event.preventDefault();
    const form = event.target;
    const values = new FormData(form);
    try {
      await apiRequest(`/api/tickets/${encodeURIComponent(form.dataset.ticketId)}/status`, {
        method: 'PUT',
        body: { status: values.get('status'), contractorName: values.get('contractorName'), note: values.get('note') }
      });
      await renderTickets();
    } catch (error) {
      alertError(error, 'Could not update the ticket status.');
    }
    if (event.target.matches('.ticket-reply-form, .ticket-tags-form')) {
      event.preventDefault();
      const form = event.target;
      const data = new FormData(form);
      const isReply = form.matches('.ticket-reply-form');
      const button = form.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        await apiRequest(`/api/tickets/${encodeURIComponent(form.dataset.ticketId)}/${isReply ? 'replies' : 'tags'}`, {
          method: isReply ? 'POST' : 'PUT',
          body: isReply ? { message: data.get('message') } : { tags: String(data.get('tags')).split(',').map((tag) => tag.trim()).filter(Boolean) }
        });
        openTicketThreads.add(form.dataset.ticketId);
        await renderTickets();
      } catch (error) {
        alertError(error, 'Could not save your update.');
      } finally {
        button.disabled = false;
      }
      return;
    }
    return;
  }
  if (event.target.matches('.ticket-assignment-form')) {
    event.preventDefault();
    const form = event.target;
    const values = new FormData(form);
    try {
      await apiRequest(`/api/tickets/${encodeURIComponent(form.dataset.ticketId)}/assignment`, {
        method: 'PUT',
        body: { assistantId: values.get('assistantId') }
      });
      await renderTickets();
    } catch (error) {
      alertError(error, 'Could not assign the ticket.');
    }
    return;
  }
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
void stateReady.then(() => checkSystemLicence()).catch((error) => {
  console.error('Authentication initialization failed:', error);
  showSignIn('Could not initialize the app. Check the backend connection and try again.');
});
