export function wireSubscriptions({ apiRequest, getUser, getContext, escape }) {
  const dialog = document.createElement('dialog');
  dialog.id = 'subscription-dialog';
  dialog.className = 'survey-dialog';
  document.body.append(dialog);
  let context;
  const current = (expected = context) => expected === getContext();
  async function load() {
    const expected = context;
    const data = await apiRequest('/api/subscription');
    if (!current(expected)) return;
    const plan = data.plans.find((item) => item.id === data.plan);
    const pending = data.requests.find((item) => item.status === 'pending');
    const manager = isManagementRole(getUser()?.role);
    dialog.innerHTML = `<div class="dialog-heading"><h2>Subscribe</h2><button class="icon-button quiet" type="button" data-close-subscription aria-label="Close">×</button></div>
      <p>Current: <strong>${escape(plan.name)}</strong> · ${data.activeUsers} active users</p>
      <p>Same features in every plan. Monthly invoices are automatic. Existing test accounts show TEST / DEMO charges for presentations only; nothing is payable.</p>
      ${pending ? '<p role="status">Plan request awaiting owner approval.</p>' : ''}
      <div class="subscription-plans">${data.plans.map((item) => `<section class="subscription-plan">
        <h3>${escape(item.name)}</h3><p>${escape(item.users)}</p>
        <p>R${(item.monthlyFeeCents / 100).toFixed(2)} / month</p>
        <button class="button ${item.id === data.plan ? 'secondary' : 'primary'}" type="button" data-request-plan="${escape(item.id)}"
          ${item.id === data.plan || pending || !manager ? 'disabled' : ''}>${item.id === data.plan ? 'Current plan' : 'Request plan'}</button>
      </section>`).join('')}</div>
      <p>${manager ? 'Requests need owner approval. All active accounts, including admins, count. Basic accepts fewer than 5 users.' : 'Ask your MM or administrator to request a plan.'}</p>
      <p data-subscription-status role="status"></p>`;
  }
  document.addEventListener('click', async (event) => {
    if (!event.target.closest('[data-subscribe]')) return;
    context = getContext();
    const expected = context;
    dialog.innerHTML = '<div class="dialog-heading"><h2>Subscribe</h2><button type="button" class="button secondary" data-close-subscription>Close</button></div><p data-subscription-status role="status">Loading plans...</p>';
    dialog.showModal();
    try { await load(); }
    catch (error) {
      if (current(expected)) dialog.querySelector('[data-subscription-status]').textContent = error.message || 'Connect to view subscription plans.';
    }
  });
  dialog.addEventListener('click', async (event) => {
    if (event.target.closest('[data-close-subscription]')) { dialog.close(); return; }
    const button = event.target.closest('[data-request-plan]');
    if (!button || !current()) return;
    const expected = context;
    dialog.querySelectorAll('[data-request-plan]').forEach((item) => { item.disabled = true; });
    try {
      await apiRequest('/api/subscription/requests', { method: 'POST', body: { plan: button.dataset.requestPlan } });
      if (!current(expected)) return;
      await load();
    } catch (error) {
      if (current(expected)) {
        dialog.querySelector('[data-subscription-status]').textContent = error.message || 'Could not request the plan. Reopen to retry.';
      }
    }
  });
}
import { isManagementRole } from './account-access.mjs';
