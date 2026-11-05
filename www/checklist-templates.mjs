import { importChecklistFile } from './checklist-import.mjs';
import { isManagementRole } from './account-access.mjs';

export function wireChecklistTemplates({ getUser, getProperties, getTemplates, getPropertyId, apiRequest, reload, escape, readSpreadsheet, readPdf, readImage }) {
  const types = [['yes-no', 'Yes / No'], ['yes-no-na', 'Yes / No / N/A'], ['pass-fail-na', 'Pass / Fail / N/A'],
    ['text', 'Short text'], ['textarea', 'Long text'], ['number', 'Number'], ['rating', 'Rating 0-10'], ['date', 'Date']];
  const dialog = document.createElement('dialog');
  dialog.className = 'survey-dialog checklist-template-dialog';
  dialog.id = 'checklist-template-dialog';
  document.body.append(dialog);
  let sourceColumns = [], sourceRows = [], importing = false, importGeneration = 0, ownerId = '';
  const row = (question = {}) => `<div class="template-editor-question">
    <label>Question<input data-question-label value="${escape(question.label || '')}" maxlength="1000" required /></label>
    <label>Answer<select data-question-type>${types.map(([id, name]) => `<option value="${id}" ${question.type === id ? 'selected' : ''}>${name}</option>`).join('')}</select></label>
    <label class="inline-choice"><input type="checkbox" data-question-photo ${question.photo ? 'checked' : ''} /> Allow photos</label>
    <button class="button secondary" type="button" data-remove-question>Remove question</button></div>`;
  function show() {
    const user = getUser();
    if (!isManagementRole(user.role)) return;
    const properties = getProperties();
    sourceColumns = []; sourceRows = []; importing = false; importGeneration++; ownerId = user.id;
    dialog.innerHTML = `<div class="dialog-heading"><h2>Checklists</h2><button class="icon-button quiet" type="button" data-close-templates aria-label="Close">×</button></div>
      <details><summary>Existing checklists (${getTemplates().length})</summary><ul class="ticket-list">${getTemplates().map((template) => `<li><strong>${escape(template.title)}</strong><button type="button" class="button secondary" data-export-template="${escape(template.id)}">Export</button>${user.role === 'admin' || (template.propertyIds?.length && template.propertyIds.every((id) => properties.some((property) => property.id === id))) ? `<button type="button" class="button secondary" data-archive-template="${escape(template.id)}">Archive</button>` : ''}</li>`).join('')}</ul></details>
      <form id="checklist-template-form" class="storage-form">
        <h3>Create / import checklist</h3>
        <label>Import a checklist / spreadsheet<input type="file" data-import-template accept=".json,.xlsx,.csv,.tsv,.txt,.pdf,.docx,.png,.jpg,.jpeg,.webp" /></label>
        <details><summary>Supported files</summary><p>PDF (including scanned pages), Excel .xlsx, Word .docx, CSV, TSV, text, JSON and images, up to 25 MB. Tables keep their readable columns and row text. Scans use English OCR: review the generated checklist before saving. Fonts, pictures and page design are not reproduced exactly. Old .doc/.xls files must be saved as .docx/.xlsx.</p></details>
        <label>Title<input name="title" maxlength="150" required /></label>
        ${user.role === 'admin' ? '<label class="inline-choice"><input type="checkbox" name="companyWide" /> All company buildings</label>' : ''}
        <fieldset><legend>Buildings</legend>${properties.map((property) => `<label class="inline-choice"><input type="checkbox" name="propertyIds" value="${escape(property.id)}" ${property.id === getPropertyId() ? 'checked' : ''} /> ${escape(property.name)}</label>`).join('')}</fieldset>
        <div data-template-questions>${row()}</div>
        <div data-template-source></div>
        <button type="button" class="button secondary" data-add-question>+ Question</button>
        <button type="submit" class="button primary">Save checklist</button>
      </form><p data-template-status role="status"></p>`;
    dialog.showModal();
  }
  function download(template) {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ title: template.title, questions: template.questions,
      ...(template.sourceColumns ? { sourceColumns: template.sourceColumns } : {}) }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'checklist-template.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-manage-checklists]')) show();
  });
  dialog.addEventListener('click', async (event) => {
    if (event.target.closest('[data-close-templates]')) { importGeneration++; dialog.close(); return; }
    if (event.target.closest('[data-add-question]')) {
      dialog.querySelector('[data-template-questions]').insertAdjacentHTML('beforeend', row());
      if (sourceColumns.length) { sourceRows.push(sourceColumns.map(() => '')); renderSource(); }
    }
    if (event.target.closest('[data-remove-question]')) {
      const question = event.target.closest('.template-editor-question');
      const index = [...dialog.querySelectorAll('.template-editor-question')].indexOf(question);
      question.remove();
      if (sourceColumns.length) { sourceRows.splice(index, 1); renderSource(); }
    }
    const exportButton = event.target.closest('[data-export-template]');
    if (exportButton) download(getTemplates().find((template) => template.id === exportButton.dataset.exportTemplate));
    const archive = event.target.closest('[data-archive-template]');
    if (archive) {
      archive.disabled = true;
      try {
        await apiRequest(`/api/check-templates/${encodeURIComponent(archive.dataset.archiveTemplate)}/archive`, { method: 'PUT', body: {} });
        await reload();
        dialog.close();
      } catch (error) { dialog.querySelector('[data-template-status]').textContent = error.message; }
      finally { archive.disabled = false; }
    }
  });
  function renderSource() {
    const container = dialog.querySelector('[data-template-source]');
    container.innerHTML = sourceColumns.length ? `<h3>Imported spreadsheet preview</h3><p>Original readable columns and values are kept. Edit cells here; edit the generated questions and answer types above.</p>
      <div class="import-sheet-scroll"><table class="import-sheet"><thead><tr>${sourceColumns.map((column, index) => `<th><input data-source-column="${index}" aria-label="Column ${index + 1}" maxlength="150" value="${escape(column)}" /></th>`).join('')}</tr></thead>
      <tbody>${sourceRows.map((values, rowIndex) => `<tr>${values.map((cell, index) => `<td><textarea data-source-row="${rowIndex}" data-source-cell="${index}" aria-label="Row ${rowIndex + 1}, ${escape(sourceColumns[index])}" maxlength="2000">${escape(cell)}</textarea></td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '';
  }
  dialog.addEventListener('input', (event) => {
    if (event.target.hasAttribute('data-source-column')) sourceColumns[Number(event.target.dataset.sourceColumn)] = event.target.value;
    if (event.target.hasAttribute('data-source-cell')) sourceRows[Number(event.target.dataset.sourceRow)][Number(event.target.dataset.sourceCell)] = event.target.value;
  });
  dialog.addEventListener('close', () => { importGeneration++; });
  dialog.addEventListener('change', async (event) => {
    if (!event.target.matches('[data-import-template]') || !event.target.files[0]) return;
    const file = event.target.files[0];
    const generation = ++importGeneration, user = getUser();
    const current = () => generation === importGeneration && getUser()?.id === user.id && dialog.open;
    importing = true;
    const button = dialog.querySelector('[type=submit]');
    button.disabled = true;
    try {
      const progress = { set textContent(value) { if (current()) dialog.querySelector('[data-template-status]').textContent = value; } };
      const data = await importChecklistFile(file, { readSpreadsheet,
        readPdf: (value) => readPdf(value, progress), readImage: (value) => readImage(value, progress),
        status: (value) => { progress.textContent = value; } });
      if (!current()) return;
      sourceColumns = data.sourceColumns || [];
      sourceRows = data.questions.map((question) => question.sourceCells || sourceColumns.map(() => ''));
      dialog.querySelector('[name=title]').value = String(data.title || file.name).slice(0, 150);
      dialog.querySelector('[data-template-questions]').innerHTML = data.questions.map((question) => row({ ...question, type: question.type || 'yes-no-na' })).join('');
      renderSource();
      dialog.querySelector('[data-template-status]').textContent = `Created ${data.questions.length} editable questions${sourceColumns.length ? ` and ${sourceColumns.length} spreadsheet columns` : ''}. Review them, select buildings and save.`;
    } catch (error) { if (current()) dialog.querySelector('[data-template-status]').textContent = error.message || 'Import failed.'; }
    finally { if (current()) { importing = false; button.disabled = false; } event.target.value = ''; }
  });
  dialog.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target, button = form.querySelector('[type=submit]');
    button.disabled = true;
    try {
      if (getUser()?.id !== ownerId) throw new Error('The signed-in account changed. Reopen this checklist.');
      if (importing) throw new Error('Wait for the file to finish importing.');
      const propertyIds = form.elements.companyWide?.checked ? [] : [...form.querySelectorAll('[name=propertyIds]:checked')].map((input) => input.value);
      if (!propertyIds.length && !form.elements.companyWide?.checked) throw new Error('Select at least one building.');
      const questions = [...form.querySelectorAll('.template-editor-question')].map((element, index) => ({
        label: element.querySelector('[data-question-label]').value,
        type: element.querySelector('[data-question-type]').value,
        photo: element.querySelector('[data-question-photo]').checked,
        ...(sourceColumns.length ? { sourceCells: sourceRows[index] } : {})
      }));
      await apiRequest('/api/check-templates', { method: 'POST', body: { title: form.elements.title.value, propertyIds, questions,
        ...(sourceColumns.length ? { sourceColumns } : {}) } });
      await reload();
      dialog.close();
    } catch (error) { dialog.querySelector('[data-template-status]').textContent = error.message || 'Checklist save failed.'; }
    finally { button.disabled = false; }
  });
}
