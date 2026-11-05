const answerTypes = ['yes-no', 'yes-no-na', 'pass-fail-na', 'text', 'textarea', 'number', 'rating', 'date'];
const heading = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const questionHeaders = ['question', 'questions', 'check', 'check item', 'inspection item', 'item', 'description', 'requirement', 'task'];
export function csvRows(text) {
  const rows = [], row = [];
  let value = '', quoted = false;
  const delimiter = text.split(/\r?\n/, 1)[0].includes('\t') ? '\t' : text.split(/\r?\n/, 1)[0].includes(';') && !text.split(/\r?\n/, 1)[0].includes(',') ? ';' : ',';
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && (character === delimiter || character === '\n' || character === '\r')) {
      row.push(value); value = '';
      if (character !== delimiter) {
        rows.push([...row]); row.length = 0;
        if (character === '\r' && text[index + 1] === '\n') index++;
      }
    } else value += character;
  }
  if (quoted) throw new Error('The CSV has an unclosed quoted field.');
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}
export function validateImport(data, title = '') {
  if (!data || !Array.isArray(data.questions) || !data.questions.length || data.questions.length > 200) throw new Error('Import a checklist containing 1-200 questions.');
  const sourceColumns = data.sourceColumns;
  if (sourceColumns != null && (!Array.isArray(sourceColumns) || !sourceColumns.length || sourceColumns.length > 30
      || sourceColumns.some((cell) => typeof cell !== 'string' || cell.length > 150))) throw new Error('Use 1-30 column headings of up to 150 characters.');
  const questions = data.questions.map((question) => {
    if (!question || typeof question.label !== 'string' || !question.label.trim() || question.label.length > 1000
        || !answerTypes.includes(question.type || 'yes-no-na')) throw new Error('Each question needs text (up to 1000 characters) and a valid answer type.');
    if (question.sourceCells !== undefined && (!sourceColumns || !Array.isArray(question.sourceCells)
        || question.sourceCells.length !== sourceColumns.length || question.sourceCells.some((cell) => typeof cell !== 'string' || cell.length > 2000))) {
      throw new Error('Each spreadsheet row must match its column headings, with cells up to 2000 characters.');
    }
    return { label: question.label.trim(), type: question.type || 'yes-no-na', photo: question.photo === true,
      ...(question.sourceCells ? { sourceCells: question.sourceCells } : {}) };
  });
  return { title: String(data.title || title).slice(0, 150), questions, ...(sourceColumns ? { sourceColumns } : {}) };
}
export function checklistFromRows(input, title) {
  const rows = input.map((row) => row.map((value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').trim()))
    .filter((row) => row.some(Boolean));
  if (!rows.length) throw new Error('The file has no readable checklist rows.');
  const headerIndex = rows.findIndex((row) => row.some((cell) => questionHeaders.includes(heading(cell))));
  const width = Math.max(...rows.map((row) => row.length));
  if (width > 30) throw new Error('The checklist has more than 30 columns. Choose a smaller checklist table.');
  const headers = headerIndex >= 0 ? rows[headerIndex] : Array.from({ length: width }, (_, index) => width === 1 ? 'Question' : `Column ${index + 1}`);
  const sourceColumns = Array.from({ length: width }, (_, index) => headers[index] || `Column ${index + 1}`);
  const normalized = sourceColumns.map(heading);
  const questionIndex = normalized.findIndex((cell) => questionHeaders.includes(cell));
  const typeIndex = normalized.indexOf('type');
  const photoIndex = normalized.indexOf('photo');
  const content = headerIndex >= 0 ? rows.slice(headerIndex + 1) : rows;
  const questions = content.filter((row) => !row.every((cell, index) => heading(cell) === normalized[index])).map((values) => {
    const cells = sourceColumns.map((_, index) => values[index] || '');
    const label = questionIndex >= 0 && cells[questionIndex] ? cells[questionIndex] : cells.filter(Boolean).join(' - ');
    const type = typeIndex >= 0 ? cells[typeIndex].toLowerCase() : '';
    return { label, type: answerTypes.includes(type) ? type : 'yes-no-na',
      photo: photoIndex >= 0 && /^(yes|true|1)$/i.test(cells[photoIndex]), sourceCells: cells };
  });
  return validateImport({ title, questions, sourceColumns });
}
export function pdfTableRows(items) {
  const lines = [];
  for (const item of items) {
    if (!item.str?.trim() || !item.transform) continue;
    const y = item.transform[5], x = item.transform[4];
    let line = lines.find((entry) => Math.abs(entry.y - y) <= 3);
    if (!line) { line = { y, items: [] }; lines.push(line); }
    line.items.push({ text: item.str.trim(), x, end: x + (item.width || 0) });
  }
  const grouped = lines.sort((a, b) => b.y - a.y).map((line) => {
    const cells = [];
    let end = -Infinity;
    for (const item of line.items.sort((a, b) => a.x - b.x)) {
      if (cells.length && item.x - end <= 16) cells[cells.length - 1].text += ` ${item.text}`;
      else cells.push({ text: item.text, x: item.x });
      end = item.end;
    }
    return cells;
  });
  const header = grouped.find((row) => row.some((cell) => questionHeaders.includes(heading(cell.text))));
  if (!header || header.length < 2) return grouped.map((row) => row.map((cell) => cell.text));
  return grouped.map((row) => {
    const values = header.map(() => '');
    for (const cell of row) {
      let column = 0;
      for (let index = 1; index < header.length; index++) if (cell.x >= header[index].x - 8) column = index;
      values[column] += `${values[column] ? ' ' : ''}${cell.text}`;
    }
    return values;
  });
}
export async function importChecklistFile(file, { readSpreadsheet, readPdf, readImage, readDocx, status = () => {} }) {
  if (file.size > 25 * 1024 * 1024) throw new Error('Choose a file smaller than 25 MB.');
  const extension = file.name.split('.').at(-1).toLowerCase();
  const title = file.name.replace(/\.[^.]+$/, '');
  status('Reading file and creating an editable checklist...');
  if (extension === 'json') return validateImport(JSON.parse(await file.text()), title);
  return checklistFromRows(await readDocumentRows(file, { readSpreadsheet, readPdf, readImage, readDocx }), title);
}
export async function readDocumentRows(file, { readSpreadsheet, readPdf, readImage, readDocx }) {
  if (file.size > 25 * 1024 * 1024) throw new Error('Choose a file smaller than 25 MB.');
  const extension = file.name.split('.').at(-1).toLowerCase();
  let rows;
  if (extension === 'xlsx') rows = await readSpreadsheet(file);
  else if (['csv', 'tsv'].includes(extension)) rows = csvRows(await file.text());
  else if (extension === 'txt') rows = (await file.text()).split(/\r?\n/).map((line) => [line]);
  else if (extension === 'pdf') rows = await readPdf(file);
  else if (extension === 'docx') rows = readDocx ? await readDocx(file) : await readDocxRows(file, { readImage });
  else if (['png', 'jpg', 'jpeg', 'webp'].includes(extension)) rows = await readImage(file);
  else throw new Error('Supported files: PDF (including scans), Excel .xlsx, Word .docx, CSV, TSV, text, JSON, JPG, PNG and WebP. Save old .doc/.xls files as .docx/.xlsx first.');
  return rows;
}
export async function readDocxRows(file, { readImage } = {}) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error('This is not a readable Word .docx document.');
  const xml = await entry.async('string');
  if (xml.length > 5 * 1024 * 1024) throw new Error('The Word document contains too much text. Split it into smaller checklists.');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('The Word document could not be read.');
  const body = document.getElementsByTagNameNS('*', 'body')[0];
  if (!body) throw new Error('The Word document is empty.');
  const text = (node) => [...node.getElementsByTagNameNS('*', 't')].map((item) => item.textContent).join(' ');
  const rows = [];
  for (const child of body.children) {
    if (child.localName === 'tbl') {
      for (const row of child.children) {
        if (row.localName === 'tr') rows.push([...row.children].filter((cell) => cell.localName === 'tc').map(text));
      }
    } else if (child.localName === 'p' && text(child).trim()) rows.push([text(child)]);
  }
  if (!rows.some((row) => row.some((value) => value.trim()))) {
    const images = zip.file(/^word\/media\/[^/]+\.(?:png|jpe?g|webp)$/i);
    if (images.length && !readImage) throw new Error('This Word document contains scanned images. Export it to PDF or upload the images for OCR.');
    if (images.length > 100) throw new Error('The scanned Word document has more than 100 images. Split it into smaller documents.');
    let total = 0;
    for (const image of images) {
      const bytes = await image.async('uint8array');
      total += bytes.length;
      if (total > 25 * 1024 * 1024) throw new Error('Embedded Word scans exceed 25 MB. Split the document before OCR.');
      const type = /\.png$/i.test(image.name) ? 'image/png' : /\.webp$/i.test(image.name) ? 'image/webp' : 'image/jpeg';
      rows.push(...await readImage(new File([bytes], image.name.split('/').at(-1), { type })));
    }
  }
  return rows;
}
