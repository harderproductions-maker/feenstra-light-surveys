import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { csvRows, checklistFromRows, importChecklistFile, pdfTableRows, validateImport } from './checklist-import.mjs';
const { validateTemplate } = createRequire(import.meta.url)('../server/check-templates.cjs');

test('CSV preserves quoted cells, multiline values, empty answer columns and original headings', () => {
  const rows = csvRows('Number,Question,Location,Result\r\n1,"Check doors, locks",Entrance,\r\n2,"Inspect lights\nand signs",Passage,\r\n');
  const imported = checklistFromRows(rows, 'Safety checklist');
  assert.deepEqual(imported.sourceColumns, ['Number', 'Question', 'Location', 'Result']);
  assert.equal(imported.questions.length, 2);
  assert.equal(imported.questions[0].label, 'Check doors, locks');
  assert.deepEqual(imported.questions[1].sourceCells, ['2', 'Inspect lights\nand signs', 'Passage', '']);
  const saved = validateTemplate({ ...imported, propertyIds: ['building'] });
  assert.deepEqual(saved.sourceColumns, imported.sourceColumns);
  assert.deepEqual(saved.questions[0].sourceCells, imported.questions[0].sourceCells);
  assert.throws(() => csvRows('"unclosed'), /unclosed/);
});
test('ordinary spreadsheets need no special Question header and preserve duplicate checklist rows', () => {
  const imported = checklistFromRows([['Door check', '', 'Ground floor'], ['Door check', '', 'First floor']], 'Doors');
  assert.equal(imported.questions.length, 2);
  assert.equal(imported.questions[0].label, 'Door check - Ground floor');
  assert.deepEqual(imported.questions[0].sourceCells, ['Door check', '', 'Ground floor']);
  const standard = checklistFromRows([['Question', 'Type', 'Photo'], ['Reading?', 'number', 'yes']], 'Meters');
  assert.equal(standard.questions[0].type, 'number');
  assert.equal(standard.questions[0].photo, true);
});
test('oversized/malformed imports are rejected explicitly rather than silently dropping rows or columns', () => {
  assert.throws(() => checklistFromRows(Array.from({ length: 201 }, (_, index) => [`Question ${index}`]), 'Large'), /1-200/);
  assert.throws(() => checklistFromRows([Array(31).fill('cell')], 'Wide'), /30 columns/);
  assert.throws(() => validateImport({ questions: [{ label: 'x'.repeat(1001) }] }), /1000/);
  assert.throws(() => validateImport({ sourceColumns: ['Question'], questions: [{ label: 'Check', sourceCells: [] }] }), /match/);
  assert.throws(() => validateTemplate({ title: 'Bad', propertyIds: [], sourceColumns: ['Check'], questions: [{ label: 'Check', type: 'text', photo: false, sourceCells: ['x', 'y'] }] }), /match/);
});
test('PDF text grouping retains column order using actual text coordinates', () => {
  const item = (str, x, y, width = 60) => ({ str, transform: [1, 0, 0, 1, x, y], width });
  const rows = pdfTableRows([item('Entrance', 350, 680), item('Check', 50, 680, 30), item('doors', 85, 680, 40),
    item('Location', 350, 700), item('Question', 50, 700)]);
  assert.deepEqual(rows, [['Question', 'Location'], ['Check doors', 'Entrance']]);
  assert.deepEqual(checklistFromRows(rows, 'PDF').questions[0].sourceCells, ['Check doors', 'Entrance']);
});
test('file routing accepts PDF, Excel, Word, images, CSV, text and JSON, with explicit unsupported errors', async () => {
  const calls = [];
  const reader = (kind) => async () => { calls.push(kind); return [['Question', 'Area'], ['Inspect exit', 'Hall']]; };
  const readers = { readSpreadsheet: reader('xlsx'), readPdf: reader('pdf'), readDocx: reader('docx'), readImage: reader('image') };
  for (const ext of ['xlsx', 'pdf', 'docx', 'png']) {
    const data = await importChecklistFile(new File(['fixture'], `Checklist.${ext}`), readers);
    assert.equal(data.questions[0].label, 'Inspect exit');
  }
  assert.deepEqual(calls, ['xlsx', 'pdf', 'docx', 'image']);
  const csv = await importChecklistFile(new File(['Check,Location\nExit,Hall'], 'list.csv'), readers);
  assert.equal(csv.questions[0].label, 'Exit');
  const txt = await importChecklistFile(new File(['First check\nSecond check'], 'list.txt'), readers);
  assert.equal(txt.questions.length, 2);
  const json = await importChecklistFile(new File([JSON.stringify({ questions: [{ label: 'JSON check' }] })], 'list.json'), readers);
  assert.equal(json.questions[0].type, 'yes-no-na');
  await assert.rejects(importChecklistFile(new File(['not a file'], 'list.doc'), readers), /Supported files/);
  await assert.rejects(importChecklistFile({ name: 'large.pdf', size: 26 * 1024 * 1024 }, readers), /25 MB/);
});
