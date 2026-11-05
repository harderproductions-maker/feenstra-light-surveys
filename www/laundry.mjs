import { validateAudit } from './appliance-audit.mjs';

export const machineStatus = { working: 'Working', needs_repair: 'Needs repair' };
export const defaultModels = { Washer: 'SWNMN2SP303SW01', Dryer: 'SSEMNAGS303NW01' };

export function partNumberLabel(part) {
  return part.part_number || 'Part number pending';
}

export function partsForMachine(parts, type) {
  return parts.filter((part) => part.active && part.machine_type === type);
}

export function machineNumberKey(value) {
  const number = String(value).trim();
  return /^\d+$/.test(number) ? number.replace(/^0+(?=\d)/, '') : number.toLowerCase();
}

export function validateLaundryReport(body) {
  if (body.visitId !== undefined && body.visitId !== null
      && (typeof body.visitId !== 'string' || !body.visitId.trim() || body.visitId.length > 100)) {
    throw new Error('Choose a valid technician visit.');
  }
  if (typeof body.propertyId !== 'string' || !body.propertyId.trim() || body.propertyId.length > 100
      || !Object.hasOwn(defaultModels, body.applianceType)) {
    throw new Error('Choose a building and Washer or Dryer report.');
  }
  if (!Number.isInteger(body.expectedCount) || body.expectedCount < 1 || body.expectedCount > 200) {
    throw new Error('Enter the total number of machines present (1 to 200).');
  }
  if (!Array.isArray(body.entries) || body.entries.length < 1 || body.entries.length > body.expectedCount) {
    throw new Error('Save at least one checked machine, without exceeding the number present.');
  }
  const numbers = new Set();
  const serials = new Set();
  const photos = new Set();
  const entries = body.entries.map((entry) => {
    if (!entry || typeof entry.machineNumber !== 'string' || !entry.machineNumber.trim() || entry.machineNumber.length > 40
        || typeof entry.modelNumber !== 'string' || !entry.modelNumber.trim() || entry.modelNumber.length > 150
        || !Object.hasOwn(machineStatus, entry.status)) {
      throw new Error('Every machine needs a number, model and Working or Needs repair selection.');
    }
    const number = entry.machineNumber.trim();
    const key = machineNumberKey(number);
    if (numbers.has(key)) throw new Error(`Machine ${number} was already checked.`);
    numbers.add(key);
    if (typeof entry.serialNumber !== 'string' || !entry.serialNumber.trim() || entry.serialNumber.length > 100) {
      throw new Error('Enter the machine serial number (up to 100 characters).');
    }
    const serial = entry.serialNumber.trim().toUpperCase();
    if (serials.has(serial)) throw new Error('Each physical machine must have a different serial number.');
    serials.add(serial);
    if (entry.replaceAssetId !== undefined && (typeof entry.replaceAssetId !== 'string' || !entry.replaceAssetId || entry.replaceAssetId.length > 100)) {
      throw new Error('Choose the machine being replaced.');
    }
    if (typeof entry.notes !== 'string' || entry.notes.length > 4000) throw new Error('Machine notes must be at most 4,000 characters.');
    if (!Array.isArray(entry.parts) || entry.parts.length > 50
        || entry.parts.some((part) => !part || typeof part.id !== 'string' || !Number.isInteger(part.quantity) || part.quantity < 1 || part.quantity > 999)
        || new Set(entry.parts.map((part) => part.id)).size !== entry.parts.length) {
      throw new Error('Choose distinct parts and quantities from 1 to 999.');
    }
    if (entry.status === 'working' && entry.parts.length) throw new Error('Select Needs repair before adding replacement parts.');
    if (!entry.photo || entry.photo.source !== 'camera' || typeof entry.photo.data !== 'string'
        || entry.photo.data.length > 180000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(entry.photo.data)
        || typeof entry.photo.capturedAt !== 'string' || !Number.isFinite(Date.parse(entry.photo.capturedAt))) {
      throw new Error(`Take a new camera photo of machine ${number}. Gallery uploads are not accepted.`);
    }
    if (photos.has(entry.photo.data)) throw new Error('Take a separate photo for every machine.');
    photos.add(entry.photo.data);
    const checkAudit = validateAudit(entry.checkAudit);
    const photoTime = Date.parse(entry.photo.capturedAt);
    if (photoTime < Date.parse(checkAudit.started.capturedAt) - 15000
        || photoTime > Date.parse(checkAudit.completed.capturedAt) + 15000) {
      throw new Error('The photo must be taken during this machine check. Take a new photo.');
    }
    return {
      machineNumber: number, modelNumber: entry.modelNumber.trim(), status: entry.status, notes: entry.notes.trim(),
      ...(entry.serialNumber ? { serialNumber: entry.serialNumber.trim() } : {}),
      ...(entry.replaceAssetId ? { replaceAssetId: entry.replaceAssetId } : {}),
      parts: entry.parts.map(({ id, quantity }) => ({ id, quantity })),
      photo: { data: entry.photo.data, source: 'camera', capturedAt: new Date(photoTime).toISOString() },
      checkAudit
    };
  });
  const checkAudit = validateAudit(body.checkAudit);
  if (entries.some((entry) => Date.parse(entry.checkAudit.started.capturedAt) < Date.parse(checkAudit.started.capturedAt)
      || Date.parse(entry.checkAudit.completed.capturedAt) > Date.parse(checkAudit.completed.capturedAt))) {
    throw new Error('Machine check times must fall within the report start and completion.');
  }
  return { propertyId: body.propertyId.trim(), applianceType: body.applianceType, expectedCount: body.expectedCount, entries, checkAudit,
    ...(body.visitId ? { visitId: body.visitId } : {}) };
}

export function reportSelections(body) {
  const selections = body.entries ? body.entries.flatMap((entry) => entry.parts) : (body.parts || []);
  return [...new Map(selections.map((part) => [part.id, part])).values()];
}

export function snapshotEntries(entries, catalogue) {
  return entries.map((entry) => ({
    ...entry,
    parts: entry.parts.map((part) => {
      const row = catalogue.find((row) => row.id === part.id);
      if (!row) throw new Error('A selected part is unavailable. Reload the parts catalogue.');
      return { id: row.id, name: row.name, part_number: row.part_number, supplier: row.supplier, quantity: part.quantity };
    })
  }));
}
