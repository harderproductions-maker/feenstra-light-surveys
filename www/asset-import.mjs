import { readDocumentRows } from './checklist-import.mjs';
const aliases = {
  assetTag: ['asset tag', 'asset number', 'asset no', 'asset id', 'tag', 'barcode', 'reference'],
  name: ['asset name', 'asset description', 'name', 'description', 'item', 'equipment'],
  category: ['category', 'type', 'asset type', 'class'],
  serialNumber: ['serial number', 'serial no', 'serial', 's/n'],
  location: ['location', 'room', 'floor', 'area'],
  notes: ['notes', 'remarks', 'comments', 'condition notes'],
  propertyId: ['building', 'property', 'building name', 'property name', 'building code']
};
export const assetImportFields = Object.keys(aliases);
export function assetTable(input) {
  if (!Array.isArray(input) || input.some((row) => !Array.isArray(row))) throw new Error('The document has no readable table.');
  const rows = input.map((row) => row.map((cell) => cell instanceof Date ? cell.toISOString().slice(0, 10) : String(cell ?? '').trim())).filter((row) => row.some(Boolean));
  if (rows.length < 2) throw new Error('Use a header row and at least one asset row. For scans, check OCR text and column mapping.');
  if (rows.length > 501 || Math.max(...rows.map((row) => row.length)) > 30) throw new Error('Import at most 500 assets and 30 columns at a time; split larger documents.');
  const columns = Array.from({ length: Math.max(...rows.map((row) => row.length)) }, (_, index) => rows[0][index] || `Column ${index + 1}`);
  const mapping = {};
  for (const [field, names] of Object.entries(aliases)) {
    const matches = columns.map((column, index) => names.includes(column.toLowerCase().replace(/[:.]+$/, '').trim()) ? index : -1).filter((index) => index >= 0);
    mapping[field] = matches.length === 1 ? matches[0] : -1;
  }
  return { columns, rows: rows.slice(1).map((row) => columns.map((_, index) => row[index] || '')), mapping };
}
export async function readAssetFile(file, readers) { return assetTable(await readDocumentRows(file, readers)); }
export function mappedAssets(table, mapping, properties, { propertyId, category, intervalDays, nextInspectionOn }) {
  if (mapping.name < 0 || mapping.assetTag < 0) throw new Error('Map an asset tag/reference and an asset name. OCR guesses must be reviewed.');
  if (!Number.isInteger(intervalDays) || intervalDays < 0 || intervalDays > 3650) throw new Error('Inspection interval must be 0-3650 whole days.');
  return table.rows.map((cells, index) => {
    const data = Object.fromEntries(assetImportFields.filter((field) => field !== 'propertyId').map((field) => [field, mapping[field] >= 0 ? cells[mapping[field]] : '']));
    let buildingId = propertyId;
    if (mapping.propertyId >= 0) {
      const value = cells[mapping.propertyId].toLowerCase();
      const matches = properties.filter((building) => building.id.toLowerCase() === value || building.name.toLowerCase() === value);
      if (matches.length !== 1) throw new Error(`Row ${index + 2}: building "${cells[mapping.propertyId]}" is missing, ambiguous or outside your access. Correct the source or import using one selected building.`);
      buildingId = matches[0].id;
    }
    if (!properties.some((building) => building.id === buildingId)) throw new Error('Choose an assigned building, or map a recognised building column.');
    data.category ||= category.trim();
    return { propertyId: buildingId, data: { ...data, condition: 'unknown', inspectionIntervalDays: intervalDays, nextInspectionOn },
      source: { columns: table.columns, cells } };
  });
}
