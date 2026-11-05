export function wireCompanyFeatures({ apiRequest, getUser, getContext, refreshUser, escape }) {
  const dialog = document.createElement('dialog');
  dialog.id = 'company-features-dialog';
  dialog.className = 'survey-dialog company-features-dialog';
  dialog.setAttribute('aria-label', 'Company features');
  document.body.append(dialog);
  let context;
  async function load() {
    const expected = context;
    const [data, settings] = await Promise.all([apiRequest('/api/company-features'), apiRequest('/api/company-settings')]);
    if (expected !== getContext()) return;
    const pending = data.requests.find((item) => item.status === 'pending');
    const admin = getUser()?.role === 'admin';
    dialog.innerHTML = `<div class="dialog-heading"><h2>Company features</h2><button class="button secondary" type="button" data-close-features>Close</button></div>
      <div class="company-features-body" tabindex="0" role="region" aria-label="Available company features and settings">
      ${admin ? `<details><summary>Client settings: residents & security</summary><form data-company-settings data-revision="${settings.revision}">
        <label>Residents<select name="residentMode"><option value="students" ${settings.residentMode === 'students' ? 'selected' : ''}>Students</option><option value="tenants" ${settings.residentMode === 'tenants' ? 'selected' : ''}>Tenants</option><option value="both" ${settings.residentMode === 'both' ? 'selected' : ''}>Both</option></select></label>
        <label>Security telephone number<input name="securityPhone" type="tel" maxlength="40" value="${escape(settings.securityPhone)}" /></label>
        <p>Existing accounts and building assignments are kept. With Both, choose Student or Tenant when creating/editing a resident. Messages and visitor approvals are handled by your existing administrators/managers.</p>
        <button class="button secondary" type="submit">Save client settings</button></form></details>` : ''}
      <p>${data.setupComplete ? 'Extra features: R100 each, once-off test admin fee.' : 'Choose 1-5 features for free setup.'} Owner approval required. No payment collected.</p>
      ${pending ? `<div class="storage-panel"><p role="status">Awaiting owner approval · R${pending.feeCents / 100}${pending.feeCents
        ? ` · Test fee simulation: ${escape(pending.simulatedPaymentStatus || 'unpaid')} (R${(pending.simulatedPaidCents || 0) / 100} recorded; no money collected)`
        : ' · No fee is due'}</p>
        ${admin && pending.feeCents > 0 ? `<div class="operation-actions" aria-label="Test feature fee payment">
          <button type="button" class="button secondary" data-simulate-feature-payment="success">Simulate paid</button>
          <button type="button" class="button secondary" data-simulate-feature-payment="partial">Simulate partial payment</button>
          <button type="button" class="button secondary" data-simulate-feature-payment="declined">Simulate declined payment</button>
        </div>` : ''}</div>` : ''}
      <p>${data.catalog.length} available features. Uncheck active features to remove access immediately. Saved data is kept; reactivation requires owner approval and the usual activation fee.</p>
      <form data-feature-form><fieldset><legend>Available features</legend>${data.catalog.map((item) => `<label class="inline-choice">
        <input type="checkbox" name="features" value="${escape(item.id)}" ${data.enabled.includes(item.id) ? `checked ${admin ? '' : 'disabled'}` : !admin || pending ? 'disabled' : ''} />
        ${escape(item.name)}${data.enabled.includes(item.id) ? ' — Active' : ''}</label>`).join('')}</fieldset>
        <p data-feature-total></p><button class="button primary" ${!admin ? 'disabled' : ''}>Save feature selections</button>
      </form><p data-feature-status role="status">${admin ? '' : 'Your company administrator chooses features.'}</p></div>`;
    const total = () => {
      const selected = [...dialog.querySelectorAll('[name=features]:checked')].map((item) => item.value);
      const count = selected.filter((id) => !data.enabled.includes(id)).length;
      const removed = data.enabled.filter((id) => !selected.includes(id)).length;
      dialog.querySelector('[data-feature-total]').textContent = `${count} selected for activation · ${removed} to remove · R${data.setupComplete ? count * data.extraFeatureFeeCents / 100 : 0}${data.setupComplete ? ' once-off test fee' : ' setup'}`;
    };
    const featureForm = dialog.querySelector('[data-feature-form]');
    featureForm.dataset.enabled = JSON.stringify(data.enabled);
    featureForm.dataset.pendingRequest = pending?.id || '';
    featureForm.addEventListener('change', total);
    total();
  }
  document.addEventListener('click', async (event) => {
    if (!event.target.closest('[data-company-features]')) return;
    context = getContext();
    const expected = context;
    dialog.innerHTML = '<div class="dialog-heading"><h2>Company features</h2><button type="button" data-close-features>Close</button></div><p data-feature-status role="status">Loading features...</p>';
    dialog.showModal();
    try { await refreshUser(); await load(); }
    catch (error) {
      if (expected === getContext()) dialog.querySelector('[data-feature-status]').textContent = error.message || 'Connect to view features.';
    }
  });
  dialog.addEventListener('click', (event) => {
    if (event.target.closest('[data-close-features]')) dialog.close();
  });
  dialog.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-simulate-feature-payment]');
    if (!button || context !== getContext()) return;
    const expected = context;
    button.disabled = true;
    try {
      await apiRequest('/api/company-features/simulate-payment', { method: 'POST', body: {
        requestId: dialog.querySelector('[data-feature-form]').dataset.pendingRequest,
        outcome: button.dataset.simulateFeaturePayment
      } });
      if (expected !== getContext()) return;
      await load();
      if (expected === getContext()) dialog.querySelector('[data-feature-status]').textContent = 'Test fee outcome recorded. No payment was collected; owner approval is still required.';
    } catch (error) {
      if (expected === getContext()) dialog.querySelector('[data-feature-status]').textContent = error.message || 'Could not simulate the feature fee.';
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });
  dialog.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (context !== getContext()) return;
    const expected = context;
    const button = event.target.querySelector('button');
    button.disabled = true;
    try {
      if (event.target.matches('[data-company-settings]')) {
        const values = new FormData(event.target);
        await apiRequest('/api/company-settings', { method: 'PUT', body: {
          residentMode: values.get('residentMode'), securityPhone: values.get('securityPhone'),
          revision: Number(event.target.dataset.revision)
        } });
        if (expected !== getContext()) return;
        await refreshUser();
        await load();
        if (expected === getContext()) dialog.querySelector('[data-feature-status]').textContent = 'Client settings saved.';
        return;
      }
      const enabled = JSON.parse(event.target.dataset.enabled);
      const selected = [...dialog.querySelectorAll('[name=features]:checked')].map((item) => item.value);
      const features = selected.filter((id) => !enabled.includes(id));
      const removed = enabled.filter((id) => !selected.includes(id));
      if (!features.length && !removed.length) throw new Error('Select a new feature or uncheck an active feature.');
      if (features.length) await apiRequest('/api/company-features/requests', { method: 'POST', body: { features } });
      if (expected !== getContext()) return;
      if (removed.length) await apiRequest('/api/company-features/remove', { method: 'POST', body: { features: removed } });
      if (expected !== getContext()) return;
      await refreshUser();
      await load();
      if (expected === getContext()) dialog.querySelector('[data-feature-status]').textContent = 'Feature selections saved. Removed features retain their saved data; additions await owner approval.';
    } catch (error) {
      if (expected === getContext()) dialog.querySelector('[data-feature-status]').textContent = error.message || 'Could not request features.';
    } finally { button.disabled = false; }
  });
}
