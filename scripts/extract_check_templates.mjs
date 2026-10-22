import fs from 'node:fs/promises';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const docsDirectory = path.resolve('Docs');
const outputPath = path.resolve('www/building-check-templates.json');
const properties = [
  { id: 'hatfield-studios', name: 'Hatfield Studios', city: 'Pretoria' },
  { id: 'brooklyn-studios', name: 'Brooklyn Studios', city: 'Pretoria' },
  { id: 'festivals-edge', name: 'Festival’s Edge', city: 'Pretoria' },
  { id: 'studios-at-burnett', name: 'Studios@Burnett', city: 'Pretoria' },
  { id: 'fountains-view', name: 'Fountains View', city: 'Pretoria' },
  { id: 'hluma-studios', name: 'Hluma Studios', city: 'Pretoria' },
  { id: 'kingsway-place', name: 'Kingsway Place', city: 'Johannesburg' },
  { id: 'apex-studios', name: 'Apex Studios', city: 'Johannesburg' },
  { id: 'braamfontein-central', name: 'Braamfontein Project / Central Studios', city: 'Johannesburg' },
  { id: 'arteria-parktown', name: 'Arteria Parktown', city: 'Johannesburg' },
  { id: 'horizon-heights', name: 'Horizon Heights', city: 'Johannesburg' },
  { id: 'crescent-studios', name: 'Crescent Studios', city: 'Johannesburg' },
  { id: 'richmond-central', name: 'Richmond Central', city: 'Johannesburg' },
  { id: 'the-richmond', name: 'The Richmond', city: 'Johannesburg' },
  { id: 'peak-studios', name: 'Peak Studios', city: 'Cape Town' },
  { id: 'varsity-studios', name: 'Varsity Studios', city: 'South Africa' }
];

function slug(value) {
  return value.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

function fieldType(label, sample) {
  const normalized = label.toLowerCase();
  const value = String(sample || '').trim();
  if (/\b(date|when was|expiry|last service|next service)\b/.test(normalized)) return 'date';
  if (/\b(how many|number of|quantity|count|meter reading)\b/.test(normalized)) return 'number';
  if (/^meter reading photo submission/i.test(normalized)) return 'yes-no';
  if (/^meter reading$/i.test(normalized)) return 'number';
  if (/^date of (?:the )?last meeting/i.test(normalized)) return 'date';
  if (/^date of last (?:testing|service)/i.test(normalized)) return 'date';
  if (/^\d+(?:\.\d+)?\s*\/\s*\d+$/.test(value)) return 'rating';
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return 'number';
  if (/^(pass|fail)$/i.test(value)) return 'pass-fail-na';
  if (/^(yes|no)$/i.test(value)) return 'yes-no';
  if (/^(n\/?a|not applicable)$/i.test(value)) return 'yes-no-na';
  if (value) return 'text';
  if (normalized.endsWith('?')) return 'yes-no-na';
  return 'text';
}

function sampleForField(items, field) {
  const match = items
    .filter((item) => item.page === field.page && item.x >= 350 && Math.abs(item.y - field.y) <= 2.5)
    .sort((left, right) => left.x - right.x)[0];
  return match?.text || '';
}

async function readTemplate(fileName) {
  const filePath = path.join(docsDirectory, fileName);
  const document = await getDocument({
    data: new Uint8Array(await fs.readFile(filePath)),
    disableFontFace: true,
    useWorkerFetch: false
  }).promise;
  const items = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    for (const item of (await page.getTextContent()).items) {
      if (typeof item.str !== 'string' || !item.str.trim()) continue;
      items.push({
        page: pageNumber,
        x: Number(item.transform?.[4] || 0),
        y: Number(item.transform?.[5] || 0),
        text: item.str.trim()
      });
    }
    await page.cleanup();
  }

  const titleItem = items.find((item) => /^Building[- ]?check\s*[-:]/i.test(item.text));
  if (!titleItem) throw new Error(`Could not determine checklist title in ${fileName}.`);
  const title = titleItem.text.replace(/^Building[- ]?check\s*[-:]\s*/i, '').trim();
  const scoreSection = items.findIndex((item) => /^\(\d+\s*\/\s*\d+\)$/.test(item.text));
  const categoryHeader = items.findIndex((item) => item.text === title && item.page === 1 && item.y < 500);
  const start = scoreSection >= 0 ? scoreSection + 1 : categoryHeader >= 0 ? categoryHeader + 1 : titleItem ? items.indexOf(titleItem) + 1 : 0;
  const scoreSummary = items.findIndex((item, index) => index > start && item.text === 'Checklist Score');
  const body = items.slice(start, scoreSummary < 0 ? items.length : scoreSummary);
  const fields = [];

  for (const item of body) {
    if (/^upload\s+picture$/i.test(item.text)) {
      if (fields.length) fields.at(-1).photo = true;
      continue;
    }
    if (/^upload\s+/i.test(item.text) || /\bphoto$/i.test(item.text)) {
      if (fields.length) fields.at(-1).attachmentLabel = item.text.replace(/^upload\s*/i, '').trim() || 'Photo';
      continue;
    }
    if (item.x >= 350 || item.x >= 320) continue;
    if (/^(?:Checklist Score|Section|Total|Score|\(\d+\s*\/\s*\d+\))$/i.test(item.text)) continue;
    if (/^Building[- ]?check\s*[-:]/i.test(item.text) || item.text === title || item.text === 'Checklist') continue;
    const sample = sampleForField(items, item);
    fields.push({
      id: `${slug(item.text).slice(0, 48) || 'question'}-${fields.length + 1}`,
      label: item.text,
      type: fieldType(item.text, sample),
      photo: false,
      required: false
    });
  }

  await document.destroy();
  if (!fields.length) throw new Error(`No question fields were extracted from ${fileName}.`);
  return {
    id: slug(title),
    title,
    sourceFile: fileName,
    questions: fields
  };
}

const fileNames = (await fs.readdir(docsDirectory))
  .filter((name) => name.toLowerCase().endsWith('.pdf'))
  .sort((left, right) => left.localeCompare(right));
if (fileNames.length !== 21) {
  throw new Error(`Expected 21 monthly checklist PDFs in Docs, found ${fileNames.length}.`);
}

const templates = [];
for (const fileName of fileNames) templates.push(await readTemplate(fileName));
await fs.writeFile(outputPath, `${JSON.stringify({ properties, templates }, null, 2)}\n`);
console.log(`Extracted ${templates.length} forms with ${templates.reduce((count, template) => count + template.questions.length, 0)} fields.`);