import { aggregateParts, combinedReportHtml } from './appliance-report.mjs';
import { reportEscape } from './report-layout.mjs';

export function validQuoteEmail(value) {
  return typeof value === 'string' && value.length <= 254
    && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(value);
}

export function validateQuoteContacts(input) {
  const email = String(input?.email || '').trim();
  if (email && !validQuoteEmail(email)) throw new Error('Enter one valid building quotation email.');
  if (!Array.isArray(input?.suppliers) || input.suppliers.length > 30) throw new Error('Add up to 30 supplier contacts per building.');
  const suppliers = input.suppliers.map((supplier) => {
    const name = String(supplier?.name || '').trim(), email = String(supplier?.email || '').trim();
    if (!name || name.length > 150 || /[\r\n]/.test(name) || !validQuoteEmail(email)) throw new Error('Each supplier needs a name and one valid email address.');
    return { name, email };
  });
  if (new Set(suppliers.map((supplier) => supplier.email.toLowerCase())).size !== suppliers.length) throw new Error('A supplier email is listed more than once.');
  return { email, suppliers };
}

export function buildingQuoteRequests(reports, contacts, properties) {
  if (!reports.length || reports.length > 200) throw new Error('Select between 1 and 200 saved reports for the quotation.');
  const groups = new Map();
  for (const report of reports) {
    const property = properties.find((item) => item.id === report?.property_id);
    if (!property) throw new Error('A selected report belongs to an unavailable building. Refresh your reports.');
    if (!groups.has(property.id)) groups.set(property.id, { property, reports: [] });
    groups.get(property.id).reports.push({ ...report, building_name: property.name });
  }
  return [...groups.values()].map(({ property, reports }) => {
    const settings = contacts.find((contact) => contact.property_id === property.id);
    const clean = validateQuoteContacts(settings || { email: '', suppliers: [] });
    if (!clean.email || !clean.suppliers.length) throw new Error(`Add a building quotation email and at least one supplier for ${property.name}.`);
    const parts = aggregateParts(reports);
    if (!parts.length) throw new Error(`The selected reports for ${property.name} have no parts to quote.`);
    const provisional = reports.some((report) => report.pending_sync || report.offline_copy);
    const subject = `Request for quotation - ${property.name} - appliance parts`;
    const lines = parts.map((part) => `${part.name} | Part number: ${part.part_number || 'PENDING - please confirm'} | Quantity: ${part.quantity}\n${part.references.map((reference) => `  Machine ${reference.machine}; model ${reference.model}; report ${reference.report}; quantity ${reference.quantity}`).join('\n')}`).join('\n\n');
    const text = `Please provide a quotation for the following appliance parts for ${property.name}.\n\nSend your quotation directly to the BUILDING EMAIL: ${clean.email}. Please do not reply to other recipients. Suppliers receive separate Bcc requests.\n\nPlease include unit prices, VAT, availability, delivery charges and lead times. This is a request for quotation, not an order.\n\n${provisional ? 'PROVISIONAL OFFLINE COPY - report details must be verified before ordering.\n\n' : ''}${lines}\n\nPlease see the attached replacement parts report.\n\nThank you.`;
    const html = combinedReportHtml(reports, 'parts').replace('<body>', `<body><h1>Quotation request: ${reportEscape(property.name)}</h1><p>Please send quotations to ${reportEscape(clean.email)}. This is not a purchase order.</p>`);
    const filename = `Parts-quote-${property.name.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60) || property.id}.html`;
    return { propertyId: property.id, building: property.name, replyTo: clean.email, suppliers: clean.suppliers, subject, text, html, filename, provisional };
  });
}

export function quoteMailto(request, supplier) {
  return `mailto:${encodeURIComponent(request.replyTo)}?${new URLSearchParams({ bcc: supplier.email, subject: request.subject, body: request.text })}`;
}

function base64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).match(/.{1,76}/g).join('\r\n');
}

export function quoteEmailDraft(request, supplier) {
  if (!validQuoteEmail(supplier.email) || !validQuoteEmail(request.replyTo)) throw new Error('Quotation email addresses are invalid.');
  const boundary = `primeops-quote-${crypto.randomUUID()}`;
  return [
    `To: ${request.replyTo}`, `Bcc: ${supplier.email}`, `Reply-To: ${request.replyTo}`,
    `Subject: =?UTF-8?B?${base64(request.subject).replace(/\r\n/g, '')}?=`, 'X-Unsent: 1', 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64(request.text),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8',
    `Content-Disposition: attachment; filename="${request.filename.replace(/[^A-Za-z0-9_.-]/g, '-')}"`,
    'Content-Transfer-Encoding: base64', '', base64(request.html), `--${boundary}--`, ''
  ].join('\r\n');
}
