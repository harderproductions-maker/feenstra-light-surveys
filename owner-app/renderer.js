let token = '', server = '', dashboard = null, busy = false, openClientCode = '';
let accountStatement = null;
let financialAccounts = null;
let invoiceSettings = null;
const money = (cents) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(cents / 100);
const platformRole = (role) => ({ owner: 'Owner', supervisor: 'Supervisor', administrator: 'Administrator' })[role];
const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const $ = (selector) => document.querySelector(selector);
const desktop = !!window.ownerApp;
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#theme-toggle').textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
  $('#theme-toggle').setAttribute('aria-pressed', String(theme === 'dark'));
}
setTheme(localStorage.getItem('primeops-admin-theme') === 'light' ? 'light' : 'dark');
$('#theme-toggle').addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('primeops-admin-theme', theme);
  setTheme(theme);
});
$('#connect [name=server]').value = desktop ? localStorage.getItem('owner-server') || '' : window.location.origin;
function status(message) { $('#status').textContent = message; }
async function request(path, method = 'GET', body) {
  if (/^(issue|decline|settings|client-access|buildings|checklists|subscription|subscription-decline|features-review|operators(?:\/[^/]+(?:\/password)?)?|accounts\/(?:send|profile|plan|prepayments|invoices|payments|extension|correction))$/.test(path) && method !== 'GET') {
    if (!openClientCode || body?.companyCode !== openClientCode) throw new Error('Open the client account before making changes for that client.');
  }
  let result;
  const apiPath = `/api/license/owner/${path}`;
  if (desktop) {
    result = await window.ownerApp.request({ server, path: apiPath, method, body, token });
  } else {
    const response = await fetch(apiPath, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(path === 'accounts/invoices' || path === 'accounts/send' ? 45000 : 20000), redirect: 'error', credentials: 'omit'
    });
    let data;
    try { data = await response.json(); }
    catch { throw new Error('The backend did not return JSON. Check the server and reload this page.'); }
    result = { status: response.status, data };
  }
  if (result.status === 401 && token) { signOut(); }
  if (result.status >= 400) throw new Error(result.data.error || `Server error ${result.status}`);
  return result.data;
}
async function action(work) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button, input, select').forEach((element) => { element.disabled = true; });
  status('');
  try { await work(); }
  catch (error) {
    console.error(error); status(error.message || 'Action failed. Retry.');
  }
  finally {
    busy = false;
    document.querySelectorAll('button, input, select').forEach((element) => { element.disabled = false; });
    $('#copy-token').disabled = !openClientCode || !dashboard?.licence?.token;
  }
}
function signOut() {
  token = ''; dashboard = null; openClientCode = '';
  $('#register').reset(); $('#company-form').reset();
  $('#password-form').reset();
  invoiceSettings = null; $('#invoice-settings-form').reset(); $('#owner-invoice-dialog').close(); $('#owner-invoice-dialog iframe').removeAttribute('srcdoc');
  $('#staff-form').reset(); $('#staff-list').replaceChildren();
  $('#home-finances').replaceChildren(); $('#accounts-list').replaceChildren(); $('#accounts-summary').replaceChildren();
  financialAccounts = null;
  for (const id of ['home-overdue', 'home-prepaid', 'home-forecast', 'accounts-forecast', 'home-payment-status']) $(`#${id}`).replaceChildren();
  $('#account-filter').value = 'all';
  $('#platform-identity').hidden = true;
  $('[data-tab=staff]').hidden = true;
  $('#home-button').hidden = true;
  $('[data-tab=home]').click();
  $('#dashboard').hidden = true; $('#signout').hidden = true; $('#login-section').hidden = false;
  $('#login').reset();
}
function companyCode() {
  if (!openClientCode) throw new Error('Open a client account first.');
  return openClientCode;
}
function closeClient() {
  accountStatement = null;
  for (const id of ['invoice', 'payment', 'extension', 'correction', 'debtor-profile', 'forecast-plan', 'prepayment']) $(`#${id}-form`).reset();
  $('#operator-list').replaceChildren(); $('#debtor-profile-summary').replaceChildren();
  for (const id of ['client-account-summary', 'account-invoices', 'account-payments', 'account-credits', 'account-events', 'client-forecast']) $(`#${id}`).replaceChildren();
  $('#payment-form [name=invoiceId]').replaceChildren(); $('#correction-form [name=record]').replaceChildren();
  openClientCode = '';
  $('#client-context').hidden = true;
  $('#client-navigation').hidden = true;
  $('#dashboard').dataset.clientOpen = 'false';
  $('#building-form').reset();
  $('#client-access-form').reset();
  $('#owner-checklist-form').reset();
  $('#questions').replaceChildren(); addQuestion();
  $('#import-checklist').value = '';
  $('#buildings').replaceChildren(); $('#checklists').replaceChildren();
  $('#checklist-buildings').replaceChildren();
  if (dashboard) delete dashboard.licence;
}
function showTab(name) {
  const button = $(`[data-tab="${name}"]`);
  if (!button || button.hidden) return;
  if (button.hasAttribute('data-client-tab')) {
    if (!openClientCode) { status('Open a client account from Clients first.'); return; }
  } else closeClient();
  document.querySelectorAll('[data-tab]').forEach((item) => {
    item.setAttribute('aria-pressed', String(item === button));
    $(`#${item.dataset.tab}`).hidden = item !== button;
  });
}
async function openClient(code) {
  await refresh(code);
  showTab('licensing');
}
function renderClients() {
  $('#client-list').replaceChildren(...dashboard.companies.map((client) => {
    const row = document.createElement('article');
    row.className = 'client-account';
    const detail = document.createElement('div');
    const name = document.createElement('h3'); name.textContent = client.name;
    const code = document.createElement('p'); code.textContent = `Client code: ${client.code} / ${client.active === false ? 'Inactive' : 'Active'}`;
    detail.append(name, code);
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = 'Open account';
    button.dataset.openClient = client.code;
    button.addEventListener('click', () => action(() => openClient(client.code)));
    row.append(detail, button);
    return row;
  }));
}
function baseTokenId() {
  if (!dashboard?.licence?.token) return 'first-activation';
  return JSON.parse(atob(dashboard.licence.token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))).id;
}
async function refresh(code = openClientCode) {
  const updated = await request(`dashboard${code ? `?companyCode=${encodeURIComponent(code)}` : '?scope=platform'}`);
  if (!updated?.account || !['owner', 'administrator', 'supervisor'].includes(updated.account.role)
      || typeof updated.account.displayName !== 'string'
      || typeof updated.ownership?.displayName !== 'string') {
    signOut();
    throw new Error('The backend did not return valid platform account details. Restart the backend, refresh this page and sign in again.');
  }
  if (code && (updated.companyCode !== code || !updated.licence)) throw new Error('The backend did not return the requested client account. No client was opened.');
  const content = code ? await request(`content?companyCode=${encodeURIComponent(code)}`) : null;
  const subscription = code ? await request(`subscription?companyCode=${encodeURIComponent(code)}`) : null;
  const features = code ? await request(`features?companyCode=${encodeURIComponent(code)}`) : null;
  const staff = updated.account.role === 'owner' ? await request('staff') : null;
  const financials = await request('accounts');
  invoiceSettings = await request('invoice-settings');
  const statement = code ? await request(`accounts?companyCode=${encodeURIComponent(code)}`) : null;
  const operators = code ? await request(`operators?companyCode=${encodeURIComponent(code)}`) : null;
  if (openClientCode !== code) {
    closeClient();
  }
  dashboard = updated;
  openClientCode = code;
  $('#platform-identity').textContent = `PrimeOps owner: ${dashboard.ownership.displayName} | Signed in: ${dashboard.account.displayName} (${platformRole(dashboard.account.role)})`;
  $('#platform-identity').hidden = false;
  $('[data-tab=staff]').hidden = dashboard.account.role !== 'owner';
  $('#team-card').hidden = dashboard.account.role !== 'owner';
  $('#client-count').textContent = String(dashboard.companies.length);
  $('#home-role').textContent = platformRole(dashboard.account.role);
  renderAccounts(financials);
  renderInvoiceSettings();
  if (staff) renderStaff(staff);
  renderClients();
  $('#registration').hidden = true; $('#login-section').hidden = true;
  $('#dashboard').hidden = false; $('#signout').hidden = false; $('#home-button').hidden = false;
  if (!code) { closeClient(); return; }
  $('#client-context').hidden = false;
  $('#client-navigation').hidden = false;
  $('#dashboard').dataset.clientOpen = 'true';
  renderAccount(statement);
  renderOperators(operators);
  $('#open-client-name').textContent = dashboard.licence.companyName;
  $('#open-client-code').textContent = `Client code: ${code}. Changes here apply only to this client account.`;
  $('#company-name').textContent = dashboard.licence.companyName;
  $('#company-code').textContent = dashboard.companyCode;
  $('#licence-state').textContent = dashboard.licence.state;
  $('#licence-state').dataset.state = dashboard.licence.state;
  $('#issue').textContent = dashboard.licence.token ? 'Renew licence for one year' : 'Register annual licence';
  $('#expiry').textContent = dashboard.licence.token
    ? new Date(JSON.parse(atob(dashboard.licence.token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))).expiresAt).toLocaleString() : 'Not activated';
  $('#testing').checked = dashboard.testRenewalEnabled;
  const claims = dashboard.licence.token ? JSON.parse(atob(dashboard.licence.token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))) : null;
  const accessForm = $('#client-access-form');
  accessForm.elements.active.checked = dashboard.companies.find((client) => client.code === code)?.active !== false;
  accessForm.elements.startsAt.value = claims ? (claims.v === 1 ? claims.issuedAt : claims.termStart).slice(0, 19) : new Date().toISOString().slice(0, 19);
  accessForm.elements.expiresAt.value = claims ? claims.expiresAt.slice(0, 19) : '';
  accessForm.elements.reason.value = '';
  $('#requests').replaceChildren();
  for (const item of dashboard.requests) {
    const row = document.createElement('article');
    row.className = 'request';
    const summary = document.createElement('p');
    summary.textContent = `${item.requested_by} / ${item.status} / ${new Date(item.created_at).toLocaleString()}`;
    row.append(summary);
    if (item.status === 'pending') {
      for (const approve of [true, false]) {
        const button = document.createElement('button');
        button.textContent = approve ? 'Approve & renew' : 'Decline';
        button.addEventListener('click', () => action(async () => {
          await request(approve ? 'issue' : 'decline', 'POST', { companyCode: companyCode(), requestId: item.id, baseTokenId: item.base_token_id });
          await refresh(); status(approve ? 'Renewed.' : 'Declined.');
        }));
        row.append(button);
      }
    }
    $('#requests').append(row);
  }
  if (!dashboard.requests.length) $('#requests').textContent = 'No requests.';
  renderContent(content);
  renderSubscription(subscription);
  renderFeatures(features);
}
function renderStaff(data) {
  $('#platform-owner').textContent = `PrimeOps owner: ${data.owner.displayName} (${data.owner.username}). Full control of the platform.`;
  $('#staff-list').replaceChildren();
  for (const user of data.staff) {
    const row = document.createElement('article');
    row.className = 'request';
    const summary = document.createElement('p');
    summary.textContent = `${user.displayName} (${user.username}) / ${platformRole(user.role)} / ${user.active ? 'Active' : 'Inactive'}`;
    const roleLabel = document.createElement('label');
    roleLabel.textContent = 'Platform role';
    const role = document.createElement('select');
    role.setAttribute('aria-label', `Role for ${user.username}`);
    for (const id of ['administrator', 'supervisor']) role.add(new Option(platformRole(id), id, false, user.role === id));
    role.addEventListener('change', () => action(async () => {
      await request(`staff/${user.id}`, 'PUT', { active: user.active, role: role.value });
      renderStaff(await request('staff'));
      status('Staff role changed; previous sessions are signed out.');
    }));
    roleLabel.append(role);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.textContent = user.active ? 'Deactivate' : 'Reactivate';
    toggle.dataset.staffToggle = user.id;
    toggle.addEventListener('click', () => action(async () => {
      await request(`staff/${user.id}`, 'PUT', { active: !user.active });
      renderStaff(await request('staff'));
      status(user.active ? 'Staff account deactivated; its sessions are signed out.' : 'Staff account reactivated.');
    }));
    const form = document.createElement('form');
    const label = document.createElement('label');
    label.textContent = 'Reset staff password';
    const input = document.createElement('input');
    input.type = 'password'; input.required = true; input.minLength = 12; input.maxLength = 72;
    input.autocomplete = 'new-password'; input.name = 'password';
    label.append(input);
    const reset = document.createElement('button');
    reset.textContent = 'Reset password';
    form.append(label, reset);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void action(async () => {
        await request(`staff/${user.id}`, 'PUT', { active: user.active, password: input.value });
        form.reset();
        status('Staff password reset; previous sessions are signed out.');
      });
    });
    row.append(summary, roleLabel, toggle, form);
    $('#staff-list').append(row);
  }
  if (!data.staff.length) $('#staff-list').textContent = 'No platform staff yet. Add your first team member above.';
}
$('#staff-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  void action(async () => {
    await request('staff', 'POST', body);
    form.reset();
    renderStaff(await request('staff'));
    status('PrimeOps staff member added. Share their login through a secure channel.');
  });
});
  function financialMetrics(target, data) {
    target.replaceChildren(...[
      ['Income received (all time)', data.incomeCents], ['Income received (this UTC month)', data.monthIncomeCents],
      ['Outstanding', data.outstandingCents], ['Arrears', data.arrearsCents], ['Advance credit held', data.prepaidCents],
      ['Projected charges (12 months)', data.forecast.projectedCents],
      ['Expected new cash (12 months, excluding arrears)', data.forecast.projectedCollectionCents]
    ].map(([label, amount]) => {
      const item = document.createElement('div'), value = document.createElement('strong'), title = document.createElement('span');
      value.textContent = money(amount); title.textContent = label; item.append(value, title); return item;
    }));
  }
  function renderAccounts(data) {
    financialAccounts = data;
    financialMetrics($('#home-finances'), data);
    financialMetrics($('#accounts-summary'), data);
    $('#home-payment-status').textContent = `${data.overdueClients} client(s) behind on payments / ${data.prepaidClients} with advance payments / ${data.accounts.filter((client) => !client.monthlyFeeCents || !client.startsOn).length} without a configured monthly forecast. Configure fees inside each client account.`;
    renderForecast($('#home-forecast'), data.forecast);
    renderForecast($('#accounts-forecast'), data.forecast);
    renderAccountRows($('#home-overdue'), data.accounts.filter((client) => client.arrearsCents > 0).sort((a, b) => b.arrearsCents - a.arrearsCents));
    renderAccountRows($('#home-prepaid'), data.accounts.filter((client) => client.forecast.paidAhead));
    filterAccounts();
  }
  function filterAccounts() {
    if (!financialAccounts) return;
    const filter = $('#account-filter').value;
    renderAccountRows($('#accounts-list'), financialAccounts.accounts.filter((client) => filter === 'overdue' ? client.arrearsCents > 0
      : filter === 'prepaid' ? client.forecast.paidAhead : filter === 'unconfigured' ? !client.monthlyFeeCents || !client.startsOn : true));
  }
  $('#account-filter').addEventListener('change', filterAccounts);
  function renderForecast(target, forecast) {
    target.innerHTML = `<p>Planning estimate in ZAR, not guaranteed income. Arrears are shown separately. Advance-credit coverage is estimated. Monthly invoices are automatic; test accounts show simulated presentation charges only. Platform totals exclude test accounts. Service-month invoices are not forecast again.</p>
      ${forecast.months.map((row) => `<p><strong>${escapeText(row.month)}</strong> / Charges ${money(row.expectedCents)} / Already paid ${money(row.paidCents)} / Advance cover ${money(row.creditCents)} / Expected new cash ${money(row.collectCents)}</p>`).join('')}`;
  }
  function renderAccountRows(target, clients) {
    target.replaceChildren(...clients.map((client) => {
      const row = document.createElement('article'); row.className = 'client-account';
      const detail = document.createElement('p');
      detail.textContent = `${client.name} (${client.code}) / Income ${money(client.incomeCents)} / Outstanding ${money(client.outstandingCents)} / Arrears ${money(client.arrearsCents)}${client.daysOverdue ? ` (${client.daysOverdue} days; oldest due ${client.oldestOverdueOn})` : ''} / Credit held ${money(client.prepaidCents)}${client.forecast.coveredThrough ? ` / Forecast covered through ${client.forecast.coveredThrough} (${client.forecast.coveredMonths} full month(s), maximum 12-month horizon)` : ''}${client.forecast.paidAhead && !client.forecast.coveredThrough ? ' / Advance payment recorded; no continuous full-month cover estimated' : ''} / ${client.blocked ? 'Blocked for arrears' : 'Not blocked for arrears'}${client.active ? '' : ' / Manually inactive'}`;
      detail.textContent += client.testAccount ? ' / TEST / DEMO billing (simulated)'
        : ` / Live billing${client.billingError ? ` / BILLING ACTION REQUIRED: ${client.billingError}` : ''}`;
      const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Open account';
      button.dataset.openBilling = client.code;
      button.addEventListener('click', () => action(async () => { await openClient(client.code); showTab('client-account'); }));
      row.append(detail, button); return row;
    }));
    if (!clients.length) target.textContent = 'No clients in this category.';
  }
  function renderAccount(data) {
    accountStatement = data;
    const summary = $('#client-account-summary');
    summary.replaceChildren();
    const title = document.createElement('p');
    title.textContent = `${data.company.name} / ${data.blocked ? 'Blocked for arrears' : 'Not blocked for arrears'}${data.company.overrideUntil ? ` / Agreement until ${new Date(data.company.overrideUntil).toLocaleString()}${new Date(data.company.overrideUntil) <= new Date() ? ' (expired)' : ''}` : ''}${data.company.overrideReason ? ` / ${data.company.overrideReason}` : ''}`;
    const billing = document.createElement('p');
    billing.textContent = data.company.testAccount ? `TEST / DEMO: ${money(data.company.monthlyFeeCents)} per month. Automatic presentation invoices and simulated payments only. Do not pay; no emails, real collection or access blocking.`
      : `Live billing: ${money(data.company.monthlyFeeCents)} per month. ${data.company.billingError ? `BILLING ACTION REQUIRED: ${data.company.billingError}` : 'Automatic invoices on registration and on the 1st of each month.'}`;
    if (data.company.testAccount && data.company.billingError) billing.textContent += ` BILLING ACTION REQUIRED: ${data.company.billingError}`;
    summary.append(billing);
    const metrics = document.createElement('div'); metrics.className = 'home-summary'; financialMetrics(metrics, data); summary.append(title, metrics);
    const authorised = ['owner', 'supervisor'].includes(dashboard.account.role);
    $('#debtor-profile-form').hidden = !authorised;
    const profile = data.company.debtorProfile;
    const readiness = data.invoiceReadiness;
    $('#invoice-readiness').innerHTML = data.company.testAccount
      ? '<p>TEST / DEMO invoices are ready for presentations without live seller/client setup. These are illustrative documents only: no email, real collection or access blocking.</p>'
      : readiness?.ready
      ? '<p>Ready to issue. Invoice setup saved. Every invoice reuses this layout and the saved seller/client details. Enter the amount and submit to update the client account; email runs separately.</p>'
      : `<p><strong>Invoice setup required before creating an invoice.</strong> No invoice has been created by opening or filling this form.</p>
        ${readiness?.seller.ready === false ? `<p>${escapeText(readiness.seller.message)}</p>${dashboard.account.role === 'owner' ? '<button type="button" data-go="invoice-setup">Complete seller invoice setup</button>' : '<p>Ask the platform Owner to complete Invoice setup.</p>'}` : ''}
        ${readiness?.client.ready === false ? `<p>${escapeText(readiness.client.message)}</p><button type="button" data-open-debtor-profile>Complete this client's billing details</button><p>The client can also save these details under PrimeOps statement.</p>` : ''}`;
    $('#debtor-profile-summary').textContent = `${profile.legalName || data.company.name} / Registration: ${profile.registrationNumber || 'Not set'} / VAT: ${profile.vatNumber || 'Not set'} / Address: ${profile.billingAddress || 'Not set'} / Contact: ${profile.contactName || 'Not set'} ${profile.contactEmail || ''} ${profile.contactPhone || ''} / Terms: ${profile.paymentTermsDays ?? 30} days${profile.internalNotes ? ` / Internal notes: ${profile.internalNotes}` : ''}`;
    for (const input of $('#debtor-profile-form').elements) {
      if (input.name) input.value = profile[input.name] ?? (input.name === 'paymentTermsDays' ? 30 : input.name === 'legalName' ? data.company.name : '');
    }
    for (const id of ['invoice', 'extension', 'correction', 'forecast-plan']) $(`#${id}-editor`).hidden = !authorised;
    $('#forecast-plan-form [name=monthlyFee]').value = (data.company.monthlyFeeCents / 100).toFixed(2);
    $('#forecast-plan-form [name=monthlyFee]').readOnly = true;
    $('#forecast-plan-form [name=startsOn]').value = data.company.startsOn?.slice(0, 7) || new Date().toISOString().slice(0, 7);
    $('#forecast-plan-form [name=endsOn]').value = data.company.endsOn?.slice(0, 7) || '';
    renderForecast($('#client-forecast'), data.forecast);
    const day = new Date().toISOString().slice(0, 10);
    $('#invoice-form [name=issuedOn]').value ||= day; $('#payment-form [name=paidOn]').value ||= day;
    $('#invoice-form [name=description]').value ||= 'PrimeOps monthly service';
    const due = new Date(`${day}T00:00:00.000Z`); due.setUTCDate(due.getUTCDate() + (profile.paymentTermsDays ?? 30));
    $('#invoice-form [name=dueOn]').value ||= due.toISOString().slice(0, 10);
    $('#prepayment-form [name=paidOn]').value ||= day;
    $('#invoice-form [name=dueOn]').value ||= new Date(Date.parse(day) + (profile.paymentTermsDays ?? 30) * 86400000).toISOString().slice(0, 10);
    $('#payment-form [name=invoiceId]').replaceChildren(new Option('Choose invoice', ''), ...data.invoices.filter((invoice) => !invoice.voidedAt && invoice.outstandingCents > 0)
      .map((invoice) => new Option(`${invoice.reference} / ${money(invoice.outstandingCents)} unpaid`, invoice.id)));
    $('#correction-form [name=record]').replaceChildren(new Option('Choose record', ''),
      ...data.invoices.filter((invoice) => !invoice.voidedAt && invoice.paidCents === 0).map((invoice) => new Option(`Void invoice: ${invoice.reference}`, `invoice:${invoice.id}`)),
      ...data.payments.filter((payment) => !payment.reversedAt && !payment.creditId).map((payment) => new Option(`Reverse payment: ${payment.reference}`, `payment:${payment.id}`)),
      ...data.credits.filter((credit) => !credit.reversedAt).map((credit) => new Option(`Reverse advance receipt: ${credit.reference}`, `credit:${credit.id}`)));
    const list = (selector, rows) => {
      $(selector).replaceChildren(...rows.map((text) => { const p = document.createElement('p'); p.textContent = text; return p; }));
      if (!rows.length) $(selector).textContent = 'No records.';
    };
    list('#account-invoices', data.invoices.map((invoice) => `${invoice.reference} / ${invoice.description} / ${money(invoice.amountCents)} / Issued ${invoice.issuedOn} / Due ${invoice.dueOn}${invoice.serviceMonth ? ` / Service month ${invoice.serviceMonth.slice(0, 7)}` : ''} / Paid ${money(invoice.paidCents)} / Unpaid ${money(invoice.outstandingCents)}${invoice.voidedAt ? ' / VOID' : ''}`));
    for (const [index, invoice] of data.invoices.entries()) {
      const row = $('#account-invoices').children[index];
      row.append(document.createElement('br'));
      const delivery = document.createElement('span');
      delivery.textContent = `Email: ${invoice.emailStatus}${invoice.emailError ? ` / ${invoice.emailError}` : ''} `;
      row.append(delivery);
      if (invoice.document) {
        const view = document.createElement('button'); view.type = 'button'; view.textContent = 'View / print invoice';
        view.dataset.viewOwnerInvoice = invoice.id;
        view.addEventListener('click', () => action(async () => {
          const result = await request(`accounts/invoice?companyCode=${encodeURIComponent(companyCode())}&id=${invoice.id}`);
          $('#owner-invoice-dialog iframe').srcdoc = result.html; $('#owner-invoice-dialog').showModal();
        }));
        row.append(view);
        const download = document.createElement('button'); download.type = 'button'; download.textContent = 'Download PDF invoice';
        download.dataset.downloadOwnerInvoice = invoice.id;
        download.addEventListener('click', () => action(async () => {
          const result = await request(`accounts/invoice?companyCode=${encodeURIComponent(companyCode())}&id=${invoice.id}&format=pdf`);
          const bytes = Uint8Array.from(atob(result.base64), (char) => char.charCodeAt(0));
          if (result.contentType !== 'application/pdf' || new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new Error('The server did not return a valid PDF invoice.');
          const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
          const link = document.createElement('a'); link.href = url; link.download = result.filename; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 60000);
          status('PDF invoice downloaded.');
        }));
        row.append(download);
        if (authorised && !data.company.testAccount && !invoice.voidedAt) {
          const send = document.createElement('button'); send.type = 'button'; send.textContent = 'Email / retry email';
          send.addEventListener('click', () => action(async () => {
            const result = await request('accounts/send', 'POST', { companyCode: companyCode(), invoiceId: invoice.id });
            await refreshAccount(); status(result.delivery.message);
          }));
          row.append(send);
        }
      }
    }
    list('#account-payments', data.payments.map((payment) => `${payment.reference} / ${data.invoices.find((invoice) => invoice.id === payment.invoiceId)?.reference} / ${payment.paidOn} / ${money(payment.amountCents)}${payment.creditId ? ' / Credit allocation (not new income)' : ''} / Recorded by ${payment.createdBy}${payment.reversedAt ? ' / REVERSED' : ''}`));
    list('#account-credits', data.credits.map((credit) => `${credit.reference} / ${credit.paidOn} / Received ${money(credit.amountCents)} / Credit remaining ${money(credit.availableCents)}${credit.reversedAt ? ' / REVERSED' : ''}`));
    list('#account-events', data.events.map((event) => `${new Date(event.createdAt).toLocaleString()} / ${event.actor} (${platformRole(event.actorRole)}) / ${event.action.replaceAll('_', ' ')} / ${JSON.stringify(event.detail)}`));
  }
  async function refreshAccount() {
    renderAccount(await request(`accounts?companyCode=${encodeURIComponent(companyCode())}`));
    renderAccounts(await request('accounts'));
  }
  $('#refresh-accounts').addEventListener('click', () => action(async () => { renderAccounts(await request('accounts')); status('Accounts refreshed.'); }));
  $('#refresh-client-account').addEventListener('click', () => action(refreshAccount));
  $('#invoice-readiness').addEventListener('click', (event) => {
    if (event.target.closest('[data-go="invoice-setup"]')) {
      $('[data-tab="invoice-setup"]').click();
      return;
    }
    if (!event.target.closest('[data-open-debtor-profile]')) return;
    $('#debtor-profile-editor').open = true;
    $('#debtor-profile-editor').scrollIntoView({ block: 'start', behavior: 'smooth' });
    $('#debtor-profile-form [name=legalName]').focus({ preventScroll: true });
  });
  $('#forecast-plan-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    void action(async () => {
      await request('accounts/plan', 'PUT', { ...body, companyCode: companyCode(), revision: accountStatement?.company.revision });
      await refreshAccount(); status('Monthly forecast saved.');
    });
  });
  $('#debtor-profile-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const profile = Object.fromEntries(new FormData(event.currentTarget));
    profile.paymentTermsDays = Number(profile.paymentTermsDays);
    profile.vatRegistered = profile.vatRegistered === 'true';
    void action(async () => {
      await request('accounts/profile', 'PUT', { companyCode: companyCode(), revision: accountStatement?.company.revision, profile });
      await refreshAccount(); status('Debtor profile saved.');
    });
  });
  function renderOperators(data) {
    const managerRoles = ['office_admin', 'maintenance_manager', 'portfolio_manager', 'building_manager', 'operations_manager'];
    const roles = [['office_admin', 'Office Administrator'], ['portfolio_manager', 'Portfolio Manager'], ['building_manager', 'Building Manager'], ['operations_manager', 'Operations Manager'], ['maintenance_manager', 'Maintenance Manager'], ['maintenance_assistant', 'Maintenance Assistant / Caretaker'], ['technician', 'Technician']];
    const newUser = { id: 'new', isNew: true, name: '', email: '', role: 'office_admin', sections: ['leasing', 'billing'], active: true,
      propertyIds: data.properties.length === 1 ? [data.properties[0].id] : [] };
    $('#operator-list').replaceChildren(...[newUser, ...data.users.filter((user) => user.role !== 'user')].map((user) => {
      const row = document.createElement('details');
      row.dataset.operator = user.id;
      const summary = document.createElement('summary');
      summary.textContent = user.isNew ? 'Add a client user' : `${user.name} (${user.email}) / ${user.role === 'admin' ? 'Main client administrator (all buildings)' : roles.find(([id]) => id === user.role)?.[1]} / ${user.active ? 'Active' : 'Inactive'}`;
      row.append(summary);
      if (!user.isNew && (user.role !== 'admin' || ['owner', 'supervisor'].includes(dashboard.account.role))) {
        const passwordForm = document.createElement('form');
        passwordForm.innerHTML = `<h3>Set / reset client password</h3>
          <label>New password<input name="newPassword" type="password" required minlength="12" maxlength="72" autocomplete="new-password" /></label>
          <label>Confirm new password<input name="confirmPassword" type="password" required minlength="12" maxlength="72" autocomplete="new-password" /></label>
          <p>At least 12 characters, at most 72 bytes. Existing online sessions will require sign-in again.</p><button>Set new password</button>`;
        passwordForm.addEventListener('submit', (event) => {
          event.preventDefault();
          if (passwordForm.elements.newPassword.value !== passwordForm.elements.confirmPassword.value) {
            status('New passwords do not match.'); return;
          }
          const body = { ...Object.fromEntries(new FormData(passwordForm)), companyCode: companyCode(), version: user.version };
          passwordForm.reset();
          void action(async () => {
            await request(`operators/${user.id}/password`, 'PUT', body);
            renderOperators(await request(`operators?companyCode=${encodeURIComponent(companyCode())}`));
            status('Client password set. The client must sign in with the new password.');
          });
        });
        row.append(passwordForm);
      }
      if (user.role === 'admin') {
        const notice = document.createElement('p'); notice.textContent = 'Protected main account: role and all-building access cannot be changed here. The Owner or a Supervisor can set its password above.'; row.append(notice); return row;
      }
      const form = document.createElement('form');
      form.innerHTML = `<label>Display name<input name="name" required maxlength="100" value="${escapeText(user.name)}" /></label>
        <label>Username<input name="email" required maxlength="100" value="${escapeText(user.email)}" /></label>
        <label>Role<select name="role">${roles.map(([id, label]) => `<option value="${id}"${id === user.role ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
        ${user.isNew ? '<p>New staff users are active. Choose at least one assigned building. Students and tenants are managed in the client app.</p>' : `<label class="inline"><input name="active" type="checkbox"${user.active ? ' checked' : ''} />Active</label>`}
        <fieldset data-operator-buildings></fieldset>
        <fieldset data-operator-sections><legend>Manager permissions</legend>
        <label class="inline"><input name="customSections" type="checkbox"${Array.isArray(user.sections) ? ' checked' : ''} />Limit to selected sections (otherwise role defaults)</label>
        ${data.sections.map(([id, label]) => `<label class="inline"><input name="sections" type="checkbox" value="${id}"${!Array.isArray(user.sections) || user.sections.includes(id) ? ' checked' : ''} />${escapeText(label)}</label>`).join('')}
        <label class="inline"><input name="adminRights" type="checkbox"${user.adminRights ? ' checked' : ''} />Scoped admin rights</label>
        <p>Scoped admin rights require User management. Section grants do not activate unapproved client features.</p></fieldset>
        <label>${user.isNew ? 'Password' : 'New password (leave blank to keep existing)'}<input name="password" type="password" minlength="4" maxlength="200" autocomplete="new-password" ${user.isNew ? 'required' : ''} /></label>
        <button>${user.isNew ? 'Create client user' : 'Save operator'}</button>`;
      function picker(selected) {
        const resident = form.elements.role.value === 'user';
        const invalid = resident && selected.length > 1;
        form.querySelector('[data-operator-buildings]').innerHTML = `<legend>${resident ? 'Exactly one building' : 'Assigned buildings (one or more)'}</legend>
          ${invalid ? '<p role="alert">Choose one building before saving this student/tenant.</p>' : ''}
          ${data.properties.map((property) => `<label class="inline"><input type="${resident ? 'radio' : 'checkbox'}" name="propertyIds" value="${escapeText(property.id)}"${!invalid && selected.includes(property.id) ? ' checked' : ''}${resident ? ' required' : ''} />${escapeText(property.name)}</label>`).join('')}`;
        form.querySelector('[data-operator-sections]').hidden = !managerRoles.includes(form.elements.role.value);
      }
      picker(user.propertyIds);
      form.elements.role.addEventListener('change', () => {
        const office = form.elements.role.value === 'office_admin';
        form.elements.customSections.checked = office;
        form.querySelectorAll('[name=sections]').forEach((input) => { input.checked = !office || ['leasing', 'billing'].includes(input.value); });
        form.elements.adminRights.checked = false;
        picker([...form.querySelectorAll('[name=propertyIds]:checked')].map((input) => input.value));
      });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const body = Object.fromEntries(new FormData(form));
        body.companyCode = companyCode(); body.version = user.version; body.active = user.isNew || form.elements.active.checked;
        body.propertyIds = [...form.querySelectorAll('[name=propertyIds]:checked')].map((input) => input.value);
        if (!body.propertyIds.length) { status('Choose at least one assigned building.'); return; }
        body.sections = managerRoles.includes(body.role) && form.elements.customSections.checked ? [...form.querySelectorAll('[name=sections]:checked')].map((input) => input.value) : null;
        body.adminRights = managerRoles.includes(body.role) && form.elements.adminRights.checked;
        form.elements.password.value = '';
        void action(async () => {
          await request(user.isNew ? 'operators' : `operators/${user.id}`, user.isNew ? 'POST' : 'PUT', body);
          renderOperators(await request(`operators?companyCode=${encodeURIComponent(companyCode())}`));
          status(user.isNew ? 'Client user created with their role and assigned buildings.' : 'Operator role, assigned buildings and access saved.');
        });
      });
      row.append(form); return row;
    }));
  }
  $('#refresh-operators').addEventListener('click', () => action(async () => {
    renderOperators(await request(`operators?companyCode=${encodeURIComponent(companyCode())}`));
    status('Client operators refreshed.');
  }));
  for (const [id, endpoint, message] of [
    ['invoice', 'invoices', 'Invoice created.'], ['payment', 'payments', 'Payment recorded.'],
    ['prepayment', 'prepayments', 'Advance payment recorded.'],
    ['extension', 'extension', 'Payment agreement updated.'], ['correction', 'correction', 'Correction recorded with history.']
  ]) {
    $(`#${id}-form`).addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const body = Object.fromEntries(new FormData(form));
      const code = companyCode();
      body.companyCode = code; body.revision = accountStatement?.company.revision;
      if (id === 'extension') body.until = event.submitter?.value === 'revoke' ? null : `${body.until.length === 16 ? `${body.until}:00` : body.until}.000Z`;
      if (id === 'correction') { [body.kind, body.id] = body.record.split(':'); delete body.record; }
      if (id === 'extension' || id === 'correction') form.elements.password.value = '';
      void action(async () => {
        if (id === 'invoice') $('#invoice-create-status').textContent = 'Creating invoice...';
        let result;
        try {
          if (id === 'invoice' && accountStatement?.invoiceReadiness?.ready === false) {
            if (!accountStatement.invoiceReadiness.client.ready) $('#debtor-profile-editor').open = true;
            throw new Error('Invoice not created: complete the seller Invoice setup and this client’s billing details shown above, then submit again.');
          }
          result = await request(`accounts/${endpoint}`, 'POST', body);
        }
        catch (error) {
          if (id === 'invoice') $('#invoice-create-status').textContent = `Invoice creation was not confirmed: ${error.message} Refresh the statement before retrying.`;
          throw error;
        }
        form.reset();
        if (id === 'invoice') {
          renderAccount(result);
          $('#invoice-create-status').textContent = 'Invoice submitted. Client account and balance updated.';
        } else await refreshAccount();
        const notice = id === 'invoice'
          ? `Invoice created and available in the client app under PrimeOps statement. ${result.delivery?.message || ''}`
          : result.delivery?.message || message;
        if (id === 'invoice') $('#invoice-create-status').textContent = notice;
        status(notice);
        if (id === 'invoice') renderAccounts(await request('accounts'));
      });
    });
  }
const questionTypes = [['yes-no','Yes / No'],['yes-no-na','Yes / No / N/A'],['pass-fail-na','Pass / Fail / N/A'],['text','Text'],['textarea','Long text'],['number','Number'],['rating','Rating 0-10'],['date','Date']];
function renderInvoiceSettings() {
  const form = $('#invoice-settings-form');
  form.hidden = dashboard.account.role !== 'owner';
  $('#invoice-delivery-setup').textContent = invoiceSettings.emailConfigured ? 'SMTP configured. Email acceptance/failure is shown on each invoice.' : 'SMTP not configured: invoices will be available in app, but no email can be sent.';
  for (const input of form.elements) if (input.name) {
    const seller = invoiceSettings.seller;
    input.value = input.name === 'vatRate' ? (seller.vatBasisPoints ?? 0) / 100 : seller[input.name] ?? (input.name === 'jurisdiction' ? 'ZA' : '');
  }
}
$('#invoice-settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const seller = Object.fromEntries(new FormData(event.currentTarget));
  seller.vatRegistered = seller.vatRegistered === 'true';
  seller.vatBasisPoints = Math.round(Number(seller.vatRate) * 100); delete seller.vatRate;
  void action(async () => {
    invoiceSettings = await request('invoice-settings', 'PUT', { revision: invoiceSettings.revision, seller });
    renderInvoiceSettings(); status('Invoice seller details saved. Verify tax particulars with your accountant.');
  });
});
$('#close-owner-invoice').addEventListener('click', () => { $('#owner-invoice-dialog').close(); $('#owner-invoice-dialog iframe').removeAttribute('srcdoc'); });
$('#print-owner-invoice').addEventListener('click', () => $('#owner-invoice-dialog iframe').contentWindow.print());
function addQuestion(question = {}) {
  const row = document.createElement('div');
  row.className = 'question';
  const label = document.createElement('label');
  label.textContent = 'Question';
  const input = document.createElement('input');
  input.required = true; input.maxLength = 1000; input.value = question.label || '';
  input.dataset.label = ''; label.append(input);
  const type = document.createElement('select');
  type.dataset.type = '';
  type.setAttribute('aria-label','Answer type');
  type.replaceChildren(...questionTypes.map(([id,name])=>new Option(name,id,false,id===(question.type||'yes-no-na'))));
  const photoLabel=document.createElement('label'); photoLabel.className='inline'; photoLabel.textContent='Allow photos';
  const photo=document.createElement('input'); photo.type='checkbox'; photo.dataset.photo=''; photo.checked=question.photo===true; photoLabel.prepend(photo);
  const remove=document.createElement('button'); remove.type='button'; remove.textContent='Remove question'; remove.addEventListener('click',()=>row.remove());
  row.append(label,type,photoLabel,remove); $('#questions').append(row);
}
addQuestion();
$('#add-question').addEventListener('click',()=>addQuestion());
async function loadContent() {
  renderContent(await request(`content?companyCode=${encodeURIComponent(companyCode())}`));
}
function renderContent(content) {
  $('#content-company').textContent=`Editing: ${dashboard.licence.companyName} (${companyCode()})`;
  $('#buildings').replaceChildren(...content.properties.map(property=>{const li=document.createElement('li');li.textContent=`${property.name} / ${property.city}`;return li;}));
  $('#checklist-buildings').replaceChildren(...content.properties.map(property=>{
    const label=document.createElement('label');label.className='inline';label.textContent=property.name;
    const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.name='propertyIds';checkbox.value=property.id;label.prepend(checkbox);return label;
  }));
  $('#checklists').replaceChildren(...content.templates.map(template=>{
    const li=document.createElement('li');li.textContent=`${template.title} (${template.questions.length} questions)`;return li;
  }));
}
function renderSubscription(data) {
  $('#subscription-company').textContent = `${dashboard.licence.companyName} (${companyCode()})`;
  const plan = data.plans.find((item) => item.id === data.plan);
  $('#subscription-current').textContent = `${plan.name} / ${money(plan.monthlyFeeCents)} per month / ${data.activeUsers} active users`;
  $('#subscription-form [name=plan]').value = data.plan;
  $('#subscription-requests').replaceChildren();
  for (const item of data.requests) {
    const row = document.createElement('article');
    row.className = 'request';
    const summary = document.createElement('p');
    summary.textContent = `${data.plans.find((plan) => plan.id === item.plan).name} / ${item.requested_by} / ${item.status}`;
    row.append(summary);
    if (item.status === 'pending') {
      for (const approve of [true, false]) {
        const button = document.createElement('button');
        button.textContent = approve ? 'Approve plan' : 'Decline plan';
        button.dataset.subscriptionReview = approve ? 'approve' : 'decline';
        button.addEventListener('click', () => action(async () => {
          await request(approve ? 'subscription' : 'subscription-decline', approve ? 'PUT' : 'POST',
            { companyCode: companyCode(), plan: item.plan, requestId: item.id });
          await refresh(); status(approve ? 'Plan approved.' : 'Plan declined.');
        }));
        row.append(button);
      }
    }
    $('#subscription-requests').append(row);
  }
  if (!data.requests.length) $('#subscription-requests').textContent = 'No requests.';
}
function renderFeatures(data) {
  $('#features-company').textContent = `${dashboard.licence.companyName} (${companyCode()})`;
  const name = (id) => data.catalog.find((item) => item.id === id)?.name || id;
  $('#features-active').replaceChildren(...data.enabled.map((id) => {
    const item = document.createElement('li'); item.textContent = name(id); return item;
  }));
  $('#feature-requests').replaceChildren();
  for (const item of data.requests) {
    const row = document.createElement('article');
    row.className = 'request';
    const summary = document.createElement('p');
    summary.textContent = `${item.features.map(name).join(', ')} / ${item.initialSetup ? 'Initial setup' : 'Additional features'} / R${item.feeCents / 100} / ${item.status}${item.feeCents ? ` / test fee ${item.simulatedPaymentStatus || 'unpaid'}: R${(item.simulatedPaidCents || 0) / 100} simulated` : ''}`;
    row.append(summary);
    if (item.status === 'pending') {
      for (const approve of [true, false]) {
        const button = document.createElement('button');
        button.textContent = approve ? 'Approve & activate' : 'Decline';
        button.dataset.featureReview = String(approve);
        button.addEventListener('click', () => action(async () => {
          await request('features-review', 'POST', { companyCode: companyCode(), requestId: item.id, approve });
          await refresh(); status(approve ? 'Features activated.' : 'Feature request declined.');
        }));
        row.append(button);
      }
    }
    $('#feature-requests').append(row);
  }
  if (!data.requests.length) $('#feature-requests').textContent = 'No requests.';
}
$('#subscription-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const plan = event.currentTarget.elements.plan.value;
  void action(async () => {
    await request('subscription', 'PUT', { companyCode: companyCode(), plan });
    await refresh(); status('Plan updated.');
  });
});
$('#building-form').addEventListener('submit',event=>{
  event.preventDefault();
  const body={...Object.fromEntries(new FormData(event.currentTarget)),companyCode:companyCode()};
  void action(async()=>{await request('buildings','POST',body);$('#building-form').reset();await loadContent();status('Building added.');});
});
$('#import-checklist').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file)return;
  try{
    if(file.size>2*1024*1024)throw new Error('Choose a file smaller than 2 MB.');
    const data=JSON.parse(await file.text());
    if(!Array.isArray(data.questions)||!data.questions.length||data.questions.length>200||data.questions.some(question=>typeof question.label!=='string'||!questionTypes.some(([id])=>id===(question.type||'yes-no-na'))))throw new Error('Import a checklist with 1-200 valid questions.');
    $('#owner-checklist-form [name=title]').value=String(data.title||file.name).slice(0,150);$('#questions').replaceChildren();data.questions.forEach(addQuestion);status('Imported. Select buildings and save.');
  }catch(error){status(error.message||'Import failed.');}
  event.target.value='';
});
$('#owner-checklist-form').addEventListener('submit',event=>{
  event.preventDefault();
  const form=event.currentTarget;
  const propertyIds=form.elements.companyWide.checked?[]:[...form.querySelectorAll('[name=propertyIds]:checked')].map(input=>input.value);
  const questions=[...$('#questions').children].map(row=>({label:row.querySelector('[data-label]').value,type:row.querySelector('[data-type]').value,photo:row.querySelector('[data-photo]').checked}));
  const body={companyCode:companyCode(),title:form.elements.title.value,propertyIds,questions};
  void action(async()=>{
    if(!propertyIds.length&&!form.elements.companyWide.checked)throw new Error('Select at least one building.');
    await request('checklists','POST',body);form.reset();$('#questions').replaceChildren();addQuestion();await loadContent();status('Checklist saved.');
  });
});
$('#connect').addEventListener('submit', (event) => {
  event.preventDefault();
  const entered = $('#connect [name=server]').value;
  void action(async () => {
    const url = new URL(entered);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Enter an HTTPS server address.');
    if (!desktop && url.origin !== window.location.origin) throw new Error('Open /admin/ on the server you want to manage.');
    token = ''; dashboard = null; $('#dashboard').hidden = true; $('#signout').hidden = true;
    $('#registration').hidden = true; $('#login-section').hidden = true;
    server = url.origin;
    const result = await request('setup');
    if (desktop) localStorage.setItem('owner-server', server);
    $('#registration').hidden = result.registered; $('#login-section').hidden = !result.registered;
  });
});
$('#register').addEventListener('submit', (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget));
  void action(async () => {
    await request('register', 'POST', body);
    $('#register').reset(); $('#registration').hidden = true; $('#login-section').hidden = false;
    status('PrimeOps administrator registered and initial client licence activated. Sign in.');
  });
});
$('#login').addEventListener('submit', (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget));
  void action(async () => {
    token = (await request('login', 'POST', body)).token;
    $('#login').reset(); await refresh(''); showTab('home');
  });
});
$('#signout').addEventListener('click', signOut);
$('#password-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  void action(async () => {
    if (form.elements.newPassword.value !== form.elements.confirmPassword.value) {
      throw new Error('New passwords do not match.');
    }
    await request('password', 'PUT', {
      currentPassword: form.elements.currentPassword.value,
      newPassword: form.elements.newPassword.value
    });
    signOut();
    status('Administrator password changed. Sign in with your new password.');
  });
});
$('#close-client').addEventListener('click', () => showTab('clients'));
$('#client-access-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  void action(async () => {
    await request('client-access', 'PUT', {
      companyCode: companyCode(), baseTokenId: baseTokenId(), active: form.elements.active.checked,
      startsAt: new Date(`${form.elements.startsAt.value}Z`).toISOString(),
      expiresAt: new Date(`${form.elements.expiresAt.value}Z`).toISOString(),
      reason: form.elements.reason.value
    });
    await refresh();
    status('Client status and signed access dates updated. Connected devices receive the changes on their next check.');
  });
});
$('#issue').addEventListener('click', () => action(async () => {
  await request('issue', 'POST', { companyCode: companyCode(), baseTokenId: baseTokenId() });
  await refresh(); status('Annual licence activated. Devices receive it when they connect.');
}));
$('#testing').addEventListener('change', () => {
  const enabled = $('#testing').checked;
  void action(async () => {
    try { await request('settings', 'PUT', { companyCode: companyCode(), testRenewalEnabled: enabled }); }
    finally { await refresh(); }
  });
});
$('#copy-token').addEventListener('click', () => action(async () => {
  if (!dashboard?.licence?.token) throw new Error('Generate a token first.');
  await navigator.clipboard.writeText(dashboard.licence.token);
  status('Token copied.');
}));
document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => {
  showTab(button.dataset.tab);
}));
$('#home-button').addEventListener('click', () => $('[data-tab=home]').click());
document.querySelectorAll('[data-go]').forEach((button) => button.addEventListener('click', () => {
  $(`[data-tab="${button.dataset.go}"]`).click();
}));
$('#company-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget));
  body.billingProfile = {
    legalName: body.name, registrationNumber: '', vatNumber: body.billingVatNumber,
    vatRegistered: body.billingVatRegistered === 'true', billingAddress: body.billingAddress,
    contactEmail: body.billingEmail, contactName: '', contactPhone: '', internalNotes: '', paymentTermsDays: 30
  };
  for (const key of ['billingVatNumber', 'billingVatRegistered', 'billingAddress', 'billingEmail']) delete body[key];
  void action(async () => {
    const result = await request('companies', 'POST', body);
    $('#company-form').reset();
    await refresh('');
    showTab('clients');
    status(`Client ${result.company.name} added with an active annual licence. ${result.billing?.error
      ? `BILLING ACTION REQUIRED: ${result.billing.error} Complete invoice setup / debtor details; billing retries automatically.`
      : 'The first subscription invoice has been issued. Monthly billing is automatic.'}`);
  });
});
if (!desktop) {
  $('#connect').hidden = true;
  server = window.location.origin;
  void action(async () => {
    try {
      const result = await request('setup');
      $('#registration').hidden = result.registered;
      $('#login-section').hidden = !result.registered;
    } catch (error) {
      $('#connect').hidden = false;
      throw error;
    }
  });
}
