import { buildingQuoteRequests, quoteEmailDraft, quoteMailto, validateQuoteContacts } from './parts-quotes.mjs';

export function quotationPanel(properties, escape) {
  return `<section class="storage-panel" id="appliance-panel-quotes" role="tabpanel" aria-labelledby="appliance-tab-quotes" data-appliance-panel="quotes" hidden>
    <h2>Supplier quotation requests</h2>
    <p>Set the building email where quotations should be returned and its supplier contacts. Select saved reports below, then prepare a separate parts request per building. No email is sent automatically.</p>
    <details><summary>Building email and suppliers</summary>
      <form id="building-quote-contacts-form" class="storage-form">
        <label>Building<select name="propertyId" required>${properties.map((property) => `<option value="${escape(property.id)}">${escape(property.name)}</option>`).join('')}</select></label>
        <label>Building quotation email<input type="email" name="email" maxlength="254" placeholder="quotes@building.example" /></label>
        <div data-quote-suppliers></div>
        <button type="button" class="button secondary" data-add-quote-supplier>Add supplier</button>
        <button type="submit" class="button primary">Save building contacts</button>
        <p data-quote-contacts-status role="status">Open this tab while connected once to download contacts. Changes to contact settings require a connection.</p>
      </form>
    </details>
    <div data-quote-report-selection></div>
    <button type="button" class="button primary" data-prepare-building-quotes>Prepare requests per building</button>
    <p data-quote-status role="status"></p><div data-quote-requests></div>
  </section>`;
}

export function downloadQuoteFile(contents, filename, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function wireQuotations({ workspace, apiRequest, getOwner, isCurrent, getReports, getProperties, escape, composeEmail, printDocument, alertError }) {
  let contacts = [], requests = [], loadedOwner = null, loading = false, dirty = false, selectedProperty = '';
  function invalidateRequests() {
    requests = [];
    workspace.querySelector('[data-quote-requests]')?.replaceChildren();
  }
  function markDirty() {
    dirty = true;
    invalidateRequests();
    workspace.querySelector('[data-quote-contacts-status]').textContent = 'Unsaved contact changes. Save before preparing quotation requests.';
  }
  const supplierRow = (supplier = { name: '', email: '' }) => `<fieldset class="quote-supplier-row">
    <legend>Supplier</legend><label>Name<input name="supplierName" value="${escape(supplier.name)}" maxlength="150" required /></label>
    <label>Email<input name="supplierEmail" type="email" value="${escape(supplier.email)}" maxlength="254" required /></label>
    <button type="button" class="button secondary" data-remove-quote-supplier>Remove supplier</button></fieldset>`;
  function fillContacts() {
    const form = workspace.querySelector('#building-quote-contacts-form');
    const contact = contacts.find((item) => item.property_id === form.elements.propertyId.value);
    selectedProperty = form.elements.propertyId.value;
    dirty = false;
    form.elements.email.value = contact?.email || '';
    form.querySelector('[data-quote-suppliers]').innerHTML = (contact?.suppliers || []).map(supplierRow).join('');
  }
  async function load() {
    if (loading) return;
    const owner = getOwner(), host = workspace.querySelector('[data-quote-report-selection]');
    if (!host) return;
    loading = true;
    loadedOwner = null;
    try {
      const data = await apiRequest('/api/building-quote-contacts');
      if (owner !== getOwner() || !host.isConnected || !isCurrent()) return;
      contacts = data.contacts;
      requests = [];
      loadedOwner = owner;
      fillContacts();
      workspace.querySelector('[data-quote-contacts-status]').textContent = data.offline_copy
        ? 'Downloaded contacts. Reconnect before changing building emails or suppliers.' : 'Building quotation contacts loaded.';
      const reports = getReports();
      host.innerHTML = `<h3>Choose reports for quotation</h3><p>Only include reports whose parts are still needed; repeat selections can request the same parts again.</p>
        ${reports.map((report) => `<label class="inline-choice"><input type="checkbox" data-quote-report="${escape(report.id)}" />
          ${escape(report.building_name)} - ${escape(report.appliance_type)} - ${escape(new Date(report.created_at).toLocaleDateString())}${report.pending_sync ? ' (pending sync)' : ''}</label>`).join('') || '<p>No saved reports available.</p>'}`;
      workspace.querySelector('[data-quote-requests]').replaceChildren();
    } catch (error) {
      if (owner === getOwner() && host.isConnected) workspace.querySelector('[data-quote-contacts-status]').textContent = error.message;
      alertError(error, 'Could not load building quotation contacts.');
    } finally { loading = false; }
  }
  workspace.addEventListener('change', (event) => {
    if (!isCurrent()) return;
    if (event.target.form?.id === 'building-quote-contacts-form' && event.target.name === 'propertyId') {
      if (dirty && !confirm('Discard unsaved building email and supplier changes?')) {
        event.target.value = selectedProperty;
        return;
      }
      fillContacts();
    }
    if (event.target.matches('[data-quote-report]')) {
      requests = [];
      workspace.querySelector('[data-quote-requests]').replaceChildren();
    }
  });
  workspace.addEventListener('input', (event) => {
    if (isCurrent() && event.target.form?.id === 'building-quote-contacts-form' && event.target.name !== 'propertyId') markDirty();
  });
  workspace.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!isCurrent() || form.id !== 'building-quote-contacts-form') return;
    event.preventDefault();
    const owner = getOwner();
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    form.inert = true;
    try {
      const body = validateQuoteContacts({
        email: form.elements.email.value,
        suppliers: [...form.querySelectorAll('.quote-supplier-row')].map((row) => ({
          name: row.querySelector('[name=supplierName]').value, email: row.querySelector('[name=supplierEmail]').value
        }))
      });
      const propertyId = form.elements.propertyId.value;
      const { contact } = await apiRequest(`/api/building-quote-contacts/${encodeURIComponent(propertyId)}`, { method: 'PUT', body });
      if (owner === getOwner() && form.isConnected && isCurrent()) {
        contacts = [...contacts.filter((item) => item.property_id !== propertyId), contact];
        invalidateRequests();
        fillContacts();
        form.querySelector('[data-quote-contacts-status]').textContent = 'Building email and supplier contacts saved.';
      }
    } catch (error) { alertError(error, 'Could not save building contacts. A server connection is required.'); }
    finally { button.disabled = false; form.inert = false; }
  });
  workspace.addEventListener('click', async (event) => {
    if (!isCurrent()) return;
    if (event.target.closest('[data-appliance-tab="quotes"]')) {
      if (loadedOwner !== getOwner() || !workspace.querySelector('[data-quote-report]')) await load();
      return;
    }
    if (event.target.closest('[data-add-quote-supplier]')) {
      workspace.querySelector('[data-quote-suppliers]').insertAdjacentHTML('beforeend', supplierRow());
      markDirty();
      return;
    }
    const remove = event.target.closest('[data-remove-quote-supplier]');
    if (remove) { remove.closest('.quote-supplier-row').remove(); markDirty(); return; }
    const prepare = event.target.closest('[data-prepare-building-quotes]');
    const email = event.target.closest('[data-compose-quote]');
    const draft = event.target.closest('[data-download-quote-draft]');
    const attachment = event.target.closest('[data-download-quote-report]');
    const pdf = event.target.closest('[data-print-quote-report]');
    if (!prepare && !email && !draft && !attachment && !pdf) return;
    try {
      if (loadedOwner !== getOwner()) throw new Error('Open the Quotations tab to download building contacts first.');
      if (prepare) {
        if (dirty) throw new Error('Save the building email and supplier changes before preparing requests.');
        const ids = [...workspace.querySelectorAll('[data-quote-report]:checked')].map((box) => box.dataset.quoteReport);
        const reports = ids.map((id) => getReports().find((report) => report.id === id));
        requests = buildingQuoteRequests(reports, contacts, getProperties());
        workspace.querySelector('[data-quote-requests]').innerHTML = requests.map((request, index) => `<article class="calendar-visit">
          <h3>${escape(request.building)}</h3><p>Quotes must be sent to: <strong>${escape(request.replyTo)}</strong></p>
          ${request.provisional ? '<p role="alert">Provisional offline report - verify before ordering.</p>' : ''}
          <div class="ticket-actions"><button type="button" class="button secondary" data-download-quote-report="${index}">Download parts report</button>
            <button type="button" class="button secondary" data-print-quote-report="${index}">Save / print PDF</button></div>
          <p>Prepare a separate email per supplier in Bcc. The building email is the visible recipient and quote destination. Suppliers cannot see other suppliers. Check Bcc, recipients and attachments before pressing Send in your email app.</p>
          ${request.suppliers.map((supplier, supplierIndex) => `<div class="quote-recipient"><strong>${escape(supplier.name)}</strong> (${escape(supplier.email)})
            <div class="ticket-actions"><button type="button" class="button primary" data-compose-quote="${index}" data-supplier-index="${supplierIndex}">Open email app</button>
              <button type="button" class="button secondary" data-download-quote-draft="${index}" data-supplier-index="${supplierIndex}">Download email draft with report</button></div></div>`).join('')}</article>`).join('');
        workspace.querySelector('[data-quote-status]').textContent = `${requests.length} building request(s) prepared. Nothing has been sent.`;
        return;
      }
      const action = email || draft || attachment || pdf;
      const index = Number(email?.dataset.composeQuote ?? draft?.dataset.downloadQuoteDraft ?? attachment?.dataset.downloadQuoteReport ?? pdf?.dataset.printQuoteReport);
      const request = requests[index];
      if (!request) throw new Error('Prepare the building quotation request again.');
      const supplier = request.suppliers[Number(action.dataset.supplierIndex)];
      if (email) {
        await composeEmail({ ...request, to: request.replyTo, bcc: supplier.email, mailto: quoteMailto(request, supplier) });
        workspace.querySelector('[data-quote-status]').textContent = 'Email preparation opened. Check the email app and press Send there. The app cannot confirm delivery or supplier replies.';
      } else if (draft) downloadQuoteFile(quoteEmailDraft(request, supplier), request.filename.replace(/\.html$/, '.eml'), 'message/rfc822');
      else if (attachment) downloadQuoteFile(request.html, request.filename, 'text/html;charset=utf-8');
      else await printDocument(request.html, request.filename.replace(/\.html$/, ''));
    } catch (error) { alertError(error, 'Could not prepare supplier quotation request.'); }
  });
  return { load, reset: () => { loadedOwner = null; contacts = []; requests = []; dirty = false; } };
}
