import { readDatabaseEntries, writeDatabaseEntries } from './product-migration.mjs';

const encode = (value) => btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(''));
const decode = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
async function keyFor(password, salt, usages) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 250000 },
    key, { name: 'AES-GCM', length: 256 }, false, usages);
}
export async function encryptTransfer(data, password) {
  if (password.length < 12) throw new Error('Use a backup password of at least 12 characters.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(password, salt, ['encrypt']);
  const bytes = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(data)));
  return { format: 'primeops-device-transfer', version: 1, salt: encode(salt), iv: encode(iv), data: encode(new Uint8Array(bytes)) };
}
export async function decryptTransfer(bundle, password) {
  if (bundle?.format !== 'primeops-device-transfer' || bundle.version !== 1 || typeof bundle.data !== 'string'
      || typeof bundle.salt !== 'string' || typeof bundle.iv !== 'string' || bundle.salt.length !== 24 || bundle.iv.length !== 16) {
    throw new Error('Choose a valid PrimeOps device backup.');
  }
  const key = await keyFor(password, decode(bundle.salt), ['decrypt']);
  let bytes;
  try { bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(bundle.iv) }, key, decode(bundle.data)); }
  catch { throw new Error('Backup password is incorrect or the file is damaged.'); }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export function wireDeviceTransfer({ getDatabase, getCompany, getUser, ready, saveNativeBackup }) {
  const dialog = document.createElement('dialog');
  dialog.id = 'device-transfer-dialog';
  dialog.className = 'survey-dialog';
  document.body.append(dialog);
  let company;
  const settingKeys = () => {
    const suffix = company ? `-${company}` : '';
    return new Set(['primeops-theme', 'primeops-server-url',
      ...['token', 'user', 'server'].map((key) => `primeops-${key}${suffix}`)]);
  };
  document.addEventListener('click', (event) => {
    if (!event.target.closest('[data-device-transfer]')) return;
    company = getCompany();
    dialog.innerHTML = `<div class="dialog-heading"><h2>Move device data</h2><button type="button" class="button secondary" data-close-transfer>Close</button></div>
      <p>Includes this company's offline work, pending uploads and saved sign-ins. Keep the encrypted file and password private. Do not uninstall the old app until you have checked the new copy.</p>
      <form><label>Backup password<input name="password" type="password" minlength="12" required autocomplete="off" /></label>
      <button class="button primary" name="action" value="export">Export encrypted backup</button>
      <label>Restore backup<input name="backup" type="file" accept=".json" /></label>
      <button class="button secondary" name="action" value="import">Restore into this app</button></form>
      <p data-transfer-status role="status"></p>`;
    dialog.showModal();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target.closest('[data-close-transfer]')) dialog.close();
  });
  dialog.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const button = event.submitter;
    if (!button) return;
    const password = form.elements.password.value;
    dialog.querySelectorAll('button').forEach((item) => { item.disabled = true; });
    try {
      await ready();
      if (company !== getCompany()) throw new Error('The company changed. Reopen device transfer.');
      const database = getDatabase();
      if (button.value === 'export') {
        const settings = Object.fromEntries([...settingKeys()].filter((key) => localStorage.getItem(key) !== null).map((key) => [key, localStorage.getItem(key)]));
        const data = await encryptTransfer({ company, entries: await readDatabaseEntries(database), settings }, password);
        const contents = JSON.stringify(data);
        const filename = 'PrimeOps-device-backup.json';
        if (saveNativeBackup) await saveNativeBackup(contents, filename);
        else {
          const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
          const link = document.createElement('a');
          link.href = url; link.download = filename; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        }
        dialog.querySelector('[data-transfer-status]').textContent = 'Backup ready. Save a copy and keep the old app until restore is verified.';
      } else {
        if (getUser()) throw new Error('Sign out before restoring a device backup.');
        const file = form.elements.backup.files[0];
        if (!file || file.size > 200 * 1024 * 1024) throw new Error('Choose a device backup smaller than 200 MB.');
        const data = await decryptTransfer(JSON.parse(await file.text()), password);
        if (data.company !== company || !Array.isArray(data.entries) || !data.settings || typeof data.settings !== 'object'
            || data.entries.some((entry) => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string')
            || Object.entries(data.settings).some(([key, value]) => !settingKeys().has(key) || typeof value !== 'string')) {
          throw new Error('Backup does not match the selected company or its format is invalid.');
        }
        const existing = await readDatabaseEntries(database);
        if (existing.some(([key, value]) => key === 'state' && (value?.surveys?.length || value?.buildingChecks?.length)
            || key.startsWith('offline-v1:') && value?.jobs?.some((job) => job.state !== 'confirmed'))) {
          throw new Error('This app already has local work. Export it first and contact your administrator before combining devices.');
        }
        await writeDatabaseEntries(database, data.entries);
        for (const [key, value] of Object.entries(data.settings)) {
          if (key !== 'primeops-company-code') localStorage.setItem(key, value);
        }
        form.reset();
        location.reload();
      }
    } catch (error) { dialog.querySelector('[data-transfer-status]').textContent = error.message || 'Device transfer failed. Your original data is retained.'; }
    finally { dialog.querySelectorAll('button').forEach((item) => { item.disabled = false; }); }
  });
}
