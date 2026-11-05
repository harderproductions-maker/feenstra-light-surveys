import { readDocumentRows } from './checklist-import.mjs';
const fields = {
  legalName: ['legal name', 'company name', 'business name', 'registered name'],
  registrationNumber: ['registration number', 'company registration', 'reg no', 'registration no'],
  vatNumber: ['vat number', 'vat registration number', 'vat no'],
  billingAddress: ['billing address', 'registered address', 'physical address', 'postal address', 'address'],
  contactName: ['accounts contact', 'contact name', 'contact person'],
  contactEmail: ['accounts email', 'billing email', 'email address', 'email'],
  contactPhone: ['accounts phone', 'telephone', 'phone', 'tel', 'contact number']
};
export function extractBillingRows(rows) {
  const result = {}, lines = rows.map((row) => row.map((cell) => String(cell ?? '').trim()).filter(Boolean)).filter((row) => row.length);
  for (const [field, labels] of Object.entries(fields)) {
    const matches = [];
    for (const row of lines) {
      const label = row[0].toLowerCase().replace(/[:.]+$/, '').trim();
      if (labels.includes(label) && row.length > 1) matches.push(row.slice(1).join(', '));
      else if (row.length === 1) {
        const split = /^([^:]+):\s*(.+)$/.exec(row[0]);
        if (split && labels.includes(split[1].trim().toLowerCase())) matches.push(split[2].trim());
      }
    }
    // Conflicting labels are left for explicit review rather than silently selecting a value.
    const unique = [...new Set(matches)];
    if (unique.length === 1) result[field] = unique[0];
  }
  return { fields: result, text: lines.map((row) => row.join(' | ')).join('\n') };
}
export async function importBillingFile(file, readers) {
  const rows = await readDocumentRows(file, readers);
  const result = extractBillingRows(rows);
  if (!result.text.trim()) throw new Error('No readable billing details were found. Enter the details manually.');
  if (result.text.length > 100000) throw new Error('The billing document contains too much text. Upload a shorter document.');
  return result;
}
