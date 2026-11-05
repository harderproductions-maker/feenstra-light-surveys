const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const money = (cents) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(cents / 100);

export function statementHtml(data) {
  return `<h2>${escape(data.company.name)}: PrimeOps account</h2>
    <button type="button" class="button secondary" data-refresh-platform-statement>Refresh invoices &amp; payments</button>
    ${!data.company.testAccount && data.invoiceReadiness?.client.ready === false ? '<p role="status"><strong>Billing details needed:</strong> open Your billing details below and save your legal name, billing address, accounts email and VAT status so PrimeOps can issue your invoices.</p>' : ''}
    <p data-platform-refresh-status role="status">Submitted invoices and balances update automatically while this statement is open. Your saved billing details are reused for every invoice.</p>
    ${billingProfileForm(data)}<section data-platform-ledger>${statementLedgerHtml(data)}</section>`;
}
export function statementLedgerHtml(data) {
  return `${data.company.testAccount ? `<p role="status"><strong>TEST / DEMO BILLING - presentation only.</strong> No money is collected. Simulated payments change only this demo ledger. ${data.blocked ? 'The simulated arrears lock is active.' : 'Workspace access is not blocked unless you explicitly simulate the arrears lock.'}</p>
    ${!data.blocked && data.invoices.some((invoice) => !invoice.voidedAt && invoice.outstandingCents > 0)
      ? '<button type="button" class="button secondary" data-simulate-billing-block>Simulate arrears lock</button>' : ''}`
    : `<p>${data.blocked ? 'Workspace blocked for overdue invoices.' : 'Not blocked for arrears.'}
    Unpaid invoices block access after the due date plus seven complete UTC calendar days.</p>`}
    <p data-simulated-payment-status role="status" aria-live="polite"></p>
    ${data.company.billingError ? `<p role="alert">Automatic billing needs attention: ${escape(data.company.billingError)}</p>` : ''}
    <p><strong>Outstanding: ${money(data.outstandingCents)}</strong> / Arrears: ${money(data.arrearsCents)} / Payments received: ${money(data.incomeCents)}</p>
    <p>Advance credit available: <strong>${money(data.prepaidCents ?? 0)}</strong>. Credit pays existing invoices first, then remains available for future invoices.</p>
    ${data.company.overrideUntil ? `<p>Payment agreement access until ${escape(new Date(data.company.overrideUntil).toLocaleString())}${Date.parse(data.company.overrideUntil) <= Date.parse(data.asOf) ? ' (expired)' : ''}.</p>` : ''}
    <h3>Invoices</h3>${data.invoices.length ? data.invoices.map((invoice) => `<article class="card">
    <p><strong>${escape(invoice.reference)}</strong> / ${escape(invoice.description)}${invoice.voidedAt ? ' / VOID' : ''}</p>
    <p>Issued ${escape(invoice.issuedOn)} / Due ${escape(invoice.dueOn)} / Amount ${money(invoice.amountCents)} / Paid ${money(invoice.paidCents)} / Unpaid ${money(invoice.outstandingCents)}</p>
    ${invoice.document ? `<button type="button" class="button primary" data-download-platform-invoice="${escape(invoice.id)}">Download PDF invoice</button>
      <button type="button" class="button secondary" data-view-platform-invoice="${escape(invoice.id)}">View / print invoice</button>` : ''}
    ${data.company.testAccount && !invoice.voidedAt && invoice.outstandingCents > 0
      ? `<div class="operation-actions" aria-label="Test payment outcomes">
        <button type="button" class="button secondary" data-simulate-platform-payment="${escape(invoice.id)}" data-outcome="success">Simulate full payment</button>
        ${invoice.outstandingCents > 1 ? `<button type="button" class="button secondary" data-simulate-platform-payment="${escape(invoice.id)}" data-outcome="partial"
          data-outstanding-cents="${invoice.outstandingCents}">Simulate partial payment</button>` : ''}
        <button type="button" class="button secondary" data-simulate-platform-payment="${escape(invoice.id)}" data-outcome="declined">Simulate declined payment</button>
      </div>` : ''}
    ${!data.company.testAccount && !invoice.voidedAt && invoice.outstandingCents > 0 ? `<button type="button" class="button primary" data-pay-platform-invoice="${escape(invoice.id)}">Pay by credit / debit card</button>` : ''}
    </article>`).join('') : '<p>No invoices.</p>'}
    <h3>Recorded payments</h3>${data.payments.length ? data.payments.map((payment) => `<p>${escape(payment.paidOn)} / ${escape(payment.reference)} /
    Invoice ${escape(data.invoices.find((invoice) => invoice.id === payment.invoiceId)?.reference)} / ${money(payment.amountCents)}${payment.reference.startsWith('SIM-') ? ' / SIMULATED' : ''}${payment.creditId ? ' / Advance credit applied (not new income)' : ''}${payment.reversedAt ? ' / REVERSED' : ''}</p>`).join('') : '<p>No payments.</p>'}
    <h3>Advance receipts</h3>${(data.credits || []).map((credit) => `<p>${escape(credit.paidOn)} / ${escape(credit.reference)} / Received ${money(credit.amountCents)} / Credit available ${money(credit.availableCents)}${credit.reversedAt ? ' / REVERSED' : ''}</p>`).join('') || '<p>No advance receipts.</p>'}
    <p>This statement is read-only. Contact PrimeOps about payments or a payment agreement. Figures are in ZAR, as at ${escape(new Date(data.asOf).toLocaleString())}.</p>`;
}
function billingProfileForm(data) {
  const profile = data.company.debtorProfile || {};
  return `<details${data.invoiceReadiness?.client.ready === false ? ' open' : ''}><summary>Your billing details / upload document</summary>
    <p>Upload a company billing document and review the extracted details before saving. PDF/scans, DOCX, XLSX, CSV, text and images are supported. Extraction stays on this device; only reviewed fields are saved. Future invoices use your saved details; old invoices keep their issued details.</p>
    <label>Billing document<input type="file" data-billing-document accept=".pdf,.docx,.xlsx,.csv,.tsv,.txt,.png,.jpg,.jpeg,.webp" /></label>
    <details><summary>Extracted document text</summary><pre data-billing-text></pre></details>
    <form data-client-billing data-revision="${data.company.revision}">
    ${[['legalName', 'Company / legal name', 160], ['registrationNumber', 'Registration number', 80], ['vatNumber', 'VAT number (if registered)', 80],
      ['billingAddress', 'Billing address', 1000], ['contactName', 'Accounts contact name', 120], ['contactEmail', 'Accounts email', 200], ['contactPhone', 'Accounts phone', 80]]
      .map(([name, label, max]) => `<label>${label}<input name="${name}" value="${escape(profile[name])}" maxlength="${max}"${['legalName', 'billingAddress', 'contactEmail'].includes(name) ? ' required' : ''}${name === 'contactEmail' ? ' type="email"' : ''} /></label>`).join('')}
    <label>VAT registered?<select name="vatRegistered" required><option value="">Confirm VAT status</option><option value="false"${profile.vatRegistered === false ? ' selected' : ''}>No</option><option value="true"${profile.vatRegistered === true ? ' selected' : ''}>Yes</option></select></label>
    <label class="inline-choice"><input type="checkbox" name="reviewed" required />I reviewed these billing details and confirm they are correct.</label>
    <button class="button primary">Save billing details</button></form><p data-billing-status role="status"></p></details>`;
}
