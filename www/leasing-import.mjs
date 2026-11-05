export const leasingImportTypes = [
  ['units', 'Building audit (unit schedule)'], ['parking', 'Parking audit'], ['tenants', 'Tenant list'], ['leases', 'Lease schedule (imported as drafts)'],
  ['schedule', 'Move-in / vacate / works schedule'], ['balances', 'Opening TEST balances'], ['buildings', 'Buildings list (main admin only)']
];
export const leasingImportUpdates = ['units', 'parking'];
export const leasingImportFields = {
  buildings: ['name', 'city'],
  units: ['number', 'floor', 'unitType', 'bedrooms', 'bathrooms', 'parkingBays', 'floorArea', 'status', 'description', 'building'],
  parking: ['bayNumber', 'level', 'bayType', 'unit', 'status', 'notes', 'building'],
  tenants: ['building', 'code', 'firstName', 'lastName', 'phone', 'email'],
  leases: ['building', 'unit', 'number', 'tenantCodes', 'startsOn', 'endsOn', 'rent', 'deposit', 'notes'],
  schedule: ['building', 'unit', 'leaseNumber', 'kind', 'title', 'startsOn', 'endsOn', 'notes'],
  balances: ['leaseNumber', 'kind', 'amount', 'date', 'description']
};
const aliases = {
  name: ['name', 'building', 'property', 'building name', 'property name'],
  building: ['building', 'property', 'building name', 'property name', 'building code'],
  city: ['city', 'town'],
  number: ['number', 'unit number', 'unit', 'apartment', 'lease number', 'lease reference'],
  floor: ['floor', 'floor number', 'level'],
  unitType: ['unit type', 'apartment type'],
  bedrooms: ['bedrooms', 'bedroom', 'beds'],
  bathrooms: ['bathrooms', 'bathroom', 'baths'],
  parkingBays: ['parking bays', 'parking bay', 'parking', 'parking spaces'],
  floorArea: ['floor area', 'floor area m2', 'area m2', 'size m2'],
  status: ['status', 'occupancy', 'occupancy status', 'unit status', 'bay status', 'allocation status'],
  unit: ['unit', 'unit number', 'apartment', 'apartment number', 'assigned unit', 'allocated unit', 'allocated to', 'assigned to'],
  bayNumber: ['bay number', 'bay', 'bay no', 'bay id', 'parking bay', 'parking bay number', 'parking number', 'parking space', 'space number'],
  level: ['level', 'parking level', 'floor', 'basement'],
  bayType: ['bay type', 'parking type', 'space type', 'type'],
  code: ['tenant code', 'tenant reference', 'account number', 'code'],
  firstName: ['first name', 'first names', 'given name', 'firstname'],
  lastName: ['last name', 'surname', 'lastname'],
  phone: ['phone', 'telephone', 'mobile', 'cell'],
  email: ['email', 'email address'],
  tenantCodes: ['tenant codes', 'tenant code', 'tenant reference'],
  startsOn: ['start date', 'starts on', 'lease start', 'from'],
  endsOn: ['end date', 'ends on', 'lease end', 'to'],
  rent: ['rent', 'monthly rent', 'monthly rental', 'rental'],
  deposit: ['deposit', 'deposit required'],
  notes: ['notes', 'remarks', 'comments'],
  description: ['description', 'reference', 'details'],
  leaseNumber: ['lease number', 'lease reference', 'lease'],
  kind: ['kind', 'type', 'transaction type', 'schedule type'],
  title: ['title', 'subject'],
  amount: ['amount', 'opening balance', 'balance'],
  date: ['date', 'entry date', 'balance date']
};
const heading = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const fieldMatches = (field, column) => (aliases[field] || [field]).some((alias) => heading(alias) === heading(column));
export function leasingImportTable(rows, kind, header = 0) {
  if (!leasingImportFields[kind]) throw new Error('Choose a supported leasing import type.');
  if (!Number.isInteger(header) || header < 0 || !Array.isArray(rows) || rows.some((row) => !Array.isArray(row))) throw new Error('Choose a valid header row in a readable table.');
  if (!header) {
    const detected = rows.slice(0, 30).findIndex((row) => leasingImportFields[kind].filter((field) => row.some((cell) => fieldMatches(field, cell))).length >= 2);
    header = detected >= 0 ? detected + 1 : 1;
  }
  const content = rows.slice(header - 1).map((row) => row.map((cell) => cell instanceof Date ? cell.toISOString().slice(0, 10) : String(cell ?? '').trim())).filter((row) => row.some(Boolean));
  if (content.length < 2 || content.length > 501) throw new Error('Import a header and 1-500 rows at a time.');
  const width = Math.max(...content.map((row) => row.length));
  if (width > 30 || width < 1) throw new Error('Import at most 30 source columns.');
  const columns = Array.from({ length: width }, (_, index) => content[0][index] || `Column ${index + 1}`);
  const mapping = Object.fromEntries(leasingImportFields[kind].map((field) => {
    const matches = columns.map((column, i) => fieldMatches(field, column) ? i : -1).filter((i) => i >= 0);
    return [field, matches.length === 1 ? matches[0] : -1];
  }));
  return { kind, columns, rows: content.slice(1).map((row) => columns.map((_, i) => row[i] || '')), mapping, headingRows: rows.slice(0, header - 1), header };
}
export function suggestedImportKind(rows) {
  const top = (rows || []).slice(0, 30).filter(Array.isArray);
  const scores = leasingImportTypes.map(([kind]) => [kind, Math.max(0, ...top.map((row) => leasingImportFields[kind].filter((field) => row.some((cell) => fieldMatches(field, cell))).length))]);
  const best = scores.reduce((a, b) => b[1] > a[1] ? b : a, ['', 1]);
  return scores.filter(([, score]) => score === best[1]).length === 1 ? best[0] : '';
}
export function suggestedImportBuilding(table, filename, properties) {
  const normalize = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const sources = [filename.replace(/\.[^.]+$/, ''), ...table.headingRows.flat()].map(normalize);
  const matches = properties.filter((p) => [p.id, p.name].some((value) => {
    const key = normalize(value);
    return key && sources.some((source) => source === key || (key.length >= 4 && ` ${source} `.includes(` ${key} `)));
  }));
  return matches.length === 1 ? matches[0].id : '';
}
export function mappedLeasingRows(table, mapping, { properties, propertyId = '' } = {}) {
  return table.rows.map((cells, index) => {
    const row = Object.fromEntries(leasingImportFields[table.kind].map((field) => [field, Number(mapping[field]) >= 0 ? cells[Number(mapping[field])] || '' : '']));
    if (properties && 'building' in row) {
      const selected = properties.find((p) => p.id === propertyId);
      if (!selected) throw new Error('Select the assigned building this file belongs to before building the preview.');
      const key = (row.building || propertyId).trim().toLowerCase();
      const matches = properties.filter((p) => p.id.toLowerCase() === key || p.name.toLowerCase() === key);
      if (matches.length !== 1) throw new Error(`Row ${index + 1}: building is missing, unrecognised or ambiguous. Select an assigned building or correct the mapped building column.`);
      if (matches[0].id !== selected.id) throw new Error(`Row ${index + 1}: the file building does not match the selected building "${selected.name}". Import separate buildings in separate batches.`);
      row.building = matches[0].name;
    }
    return row;
  });
}
