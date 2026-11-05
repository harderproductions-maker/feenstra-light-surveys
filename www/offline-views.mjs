import { reportHtml } from './appliance-report.mjs';
import { snapshotEntries, machineNumberKey } from './laundry.mjs';
import { assetSummary } from './machine-assets.mjs';
import { canAccessBuilding, canManageBuildingAccount, canAccessBillingAccount } from './building-access.mjs';
import { bookingWindow, localDay } from './technician-visits.mjs';
import { sectionForPath, canUseSection, isManagerRole, isManagementRole } from './account-access.mjs';

export function remap(value, ids) {
  if (typeof value === 'string') return ids[value] || value;
  if (Array.isArray(value)) return value.map((item) => remap(item, ids));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item, ids)]));
  return value;
}

export function mappedPath(path, ids) {
  const [pathname, query] = path.split('?');
  const mapped = pathname.split('/').map((part) => {
    const id = decodeURIComponent(part);
    return ids[id] ? encodeURIComponent(ids[id]) : part;
  }).join('/');
  if (!query) return mapped;
  const params = new URLSearchParams(query);
  for (const [key, value] of params) if (ids[value]) params.set(key, ids[value]);
  return `${mapped}?${params}`;
}

export function isOfflineWrite(path, method) {
  return ['POST', 'PUT'].includes(method) && /^\/api\/(technician-checkins|reports|users(?:\/[^/]+)?|properties|billing\/accounts\/[^/]+\/(?:status|entries(?:\/[^/]+\/void)?)|appliance-parts(?:\/[^/]+)?|appliance-reports|tickets(?:\/[^/]+\/(?:assignment|status|complete|replies|tags))?)$/.test(path);
}

export function isOfflineRead(path) {
  return /^\/api\/(auth\/profile-photo|check-templates|building-quote-contacts|technician-schedule|properties|users|tickets|ticket-assignees(?:\?.*)?|billing\/(?:me|accounts(?:\/[^/]+)?)|appliance-assets|appliance-parts|appliance-reports(?:\/[^/]+\/export)?)$/.test(path);
}

function missing() {
  throw new Error('This information has not been downloaded to this phone yet. Connect to the server once to make it available offline.');
}

export function projectView(path, cache, jobs, user, ids = {}) {
  path = mappedPath(path, ids);
  const section = sectionForPath(path);
  if (section && !canUseSection(user, section)) throw new Error('Your account does not have access to this section.');
  const cached = cache[path];
  const changes = jobs.filter((job) => !job.scopeBlocked && (job.state !== 'confirmed' || !cached || job.confirmedAt > cached.at))
    .map((job) => ({ ...job, path: mappedPath(job.path, ids), body: remap(job.body, ids), localId: ids[job.localId] || job.localId }));
  let result = cached ? structuredClone(cached.value) : null;
  const read = (key) => projectView(key, cache, jobs, user, ids);
  const pending = (job) => job.state !== 'confirmed';
  const allowedBuilding = (id) => canAccessBuilding(user, id)
    || (isManagerRole(user.role) && changes.some((job) => job.path === '/api/properties' && job.localId === id));
  const propertyName = (id) => read('/api/properties').properties.find((property) => property.id === id)?.name || id;
  const users = () => canUseSection(user, 'users') ? read('/api/users').users : [];
  const upsert = (list, row) => {
    const index = list.findIndex((entry) => entry.id === row.id);
    if (index < 0) list.unshift(row);
    else list[index] = { ...list[index], ...row };
  };
  if (path === '/api/check-templates') {
    if (!result) return missing();
    result.templates = result.templates.filter((template) => !template.propertyIds?.length || template.propertyIds.some(allowedBuilding));
  } else if (path === '/api/auth/profile-photo') {
    if (!result) return missing();
  } else if (path === '/api/building-quote-contacts') {
    if (!result) return missing();
    if (!isManagementRole(user.role)) throw new Error('Manager access is required for supplier contacts.');
    result.contacts = result.contacts.filter((contact) => allowedBuilding(contact.property_id));
  } else if (path === '/api/technician-schedule') {
    if (!result) return missing();
    result.visits = result.visits.filter((visit) => allowedBuilding(visit.property_id)
      && (isManagementRole(user.role) || visit.technician_id === user.id));
    result.locations = result.locations.filter((location) => allowedBuilding(location.property_id));
    result.requests = (result.requests || []).filter((request) => allowedBuilding(request.property_id)
      && (isManagementRole(user.role) || request.technician_id === user.id));
    result.absences = isManagementRole(user.role)
      ? (result.absences || []).filter((absence) => allowedBuilding(absence.property_id)) : [];
    if (user.role === 'technician') result.technicians = [];
    else result.technicians = result.technicians.map((technician) => ({
      ...technician, property_ids: technician.property_ids.filter(allowedBuilding)
    })).filter((technician) => technician.property_ids.length);
    for (const job of changes.filter((item) => item.path === '/api/technician-checkins')) {
      const current = result.visits.find((visit) => visit.id === job.body.id);
      if (!allowedBuilding(job.body.propertyId)) continue;
      if (current) current.started_at = job.body.location.capturedAt;
      else if (job.body.extra) {
        upsert(result.visits, { id: job.body.id, property_id: job.body.propertyId, technician_id: user.id,
          kind: 'extra', ...bookingWindow({ date: localDay(job.body.location.capturedAt), allDay: true }),
          started_at: job.body.location.capturedAt, pending_sync: pending(job), ...job.response?.visit });
      }
    }
  } else if (path === '/api/properties') {
    if (!result) return missing();
    for (const job of changes.filter((item) => item.path === path && item.method === 'POST')) {
      upsert(result.properties, job.response?.property || { id: job.localId, name: job.body.name, city: job.body.city || '', pending_sync: pending(job) });
    }
    result.properties = result.properties.filter((property) => allowedBuilding(property.id));
  } else if (path === '/api/users') {
    if (!result) return missing();
    for (const job of changes.filter((item) => /^\/api\/users(?:\/[^/]+)?$/.test(item.path))) {
      const body = job.body;
      const id = job.method === 'POST' ? job.localId : decodeURIComponent(job.path.split('/')[3]);
      upsert(result.users, {
        id,
        name: body.name, email: body.email, role: body.role, unit_number: body.unitNumber || '',
        resident_type: body.residentType || result.users.find((row) => row.id === id)?.resident_type
          || (user.companySettings?.residentMode === 'tenants' ? 'tenant' : 'student'),
        active: body.active !== false, property_ids: body.propertyIds, sections: body.sections ?? null,
        admin_rights: body.adminRights === true, created_at: job.createdAt,
        ...job.response?.user, pending_sync: pending(job)
      });
    }
    result.users = result.users.filter((account) => canManageBuildingAccount(user, account));
  } else if (path === '/api/appliance-assets') {
    if (!result) return missing();
    result.assets = result.assets.filter((asset) => allowedBuilding(asset.property_id));
    result.reports = result.reports.filter((report) => allowedBuilding(report.property_id));
    result.events = result.events.filter((event) => result.assets.some((asset) => asset.id === event.asset_id));
    result.properties = result.properties.filter((property) => allowedBuilding(property.id));
    const reportChanges = changes.filter((item) => item.path === '/api/appliance-reports' && allowedBuilding(item.body.propertyId));
    for (const job of reportChanges) {
      const entries = snapshotEntries(job.body.entries, job.body.expectedParts || read('/api/appliance-parts').parts);
      for (const entry of entries) {
        const key = machineNumberKey(entry.machineNumber);
        let asset = result.assets.find((asset) => asset.active && asset.property_id === job.body.propertyId
          && asset.appliance_type === job.body.applianceType && asset.machine_key === key);
        if (asset && entry.replaceAssetId === asset.id && asset.serial_number.toUpperCase() !== entry.serialNumber.toUpperCase()) {
          asset.active = false;
          asset.retired_at = entry.checkAudit.completed.capturedAt;
          asset = null;
        }
        const saved = job.response?.report?.entries?.find((row) => row.machineNumber === entry.machineNumber);
        if (!asset) {
          asset = { id: saved?.assetId || `pending-${job.localId}-${key}`, property_id: job.body.propertyId,
            appliance_type: job.body.applianceType, machine_number: entry.machineNumber, machine_key: key,
            serial_number: entry.serialNumber, model_number: entry.modelNumber, active: true, pending_sync: pending(job) };
          result.assets.push(asset);
        }
        entry.assetId = saved?.assetId || asset.id;
      }
      upsert(result.reports, { id: job.localId, property_id: job.body.propertyId, created_at: job.createdAt, entries });
    }
    if (reportChanges.length) Object.assign(result, assetSummary(result.assets, result.reports, result.events));
    else {
      result.machines = result.machines.filter((machine) => allowedBuilding(machine.property_id));
      result.buildings = result.buildings.filter((building) => allowedBuilding(building.property_id));
      result.requests = result.requests.filter((request) => allowedBuilding(request.property_id));
    }
  } else if (path === '/api/appliance-parts') {
    if (!result) return missing();
    for (const job of changes.filter((item) => /^\/api\/appliance-parts(?:\/[^/]+)?$/.test(item.path))) {
      upsert(result.parts, {
        id: job.method === 'POST' ? job.localId : decodeURIComponent(job.path.split('/')[3]),
        name: job.body.name.trim(), part_number: (job.body.partNumber || '').trim(), supplier: job.body.supplier || '',
        machine_type: job.body.machineType,
        active: job.body.active !== false, ...job.response?.part, pending_sync: pending(job)
      });
    }
  } else if (path.startsWith('/api/ticket-assignees')) {
    if (!result && cache['/api/users']) result = { assistants: [] };
    if (!result) return missing();
    const propertyId = new URLSearchParams(path.split('?')[1]).get('propertyId');
    if (!allowedBuilding(propertyId)) throw new Error('You cannot access this building.');
    for (const entry of users().filter((entry) => entry.role === 'maintenance_assistant' && entry.active && entry.property_ids.includes(propertyId))) {
      upsert(result.assistants, { id: entry.id, name: entry.name });
    }
    if (canUseSection(user, 'users')) result.assistants = result.assistants.filter((assistant) => {
      const entry = users().find((entry) => entry.id === assistant.id);
      return !entry || (entry.active && entry.role === 'maintenance_assistant' && entry.property_ids.includes(propertyId));
    });
  } else if (path === '/api/tickets') {
    if (!result) return missing();
    for (const job of changes.filter((item) => item.path === path || item.path.startsWith('/api/tickets/'))) {
      const body = job.body;
      if (job.path === path) {
        upsert(result.tickets, {
          id: job.localId, property_id: body.propertyId, building_name: propertyName(body.propertyId), unit_number: body.unitNumber,
          subject: body.subject, description: body.description, tags: body.tags, status: 'submitted',
          created_by: user.id, created_by_name: user.name, created_at: job.createdAt, updated_at: job.createdAt,
          scheduled_for: body.scheduledFor, access_granted: false, access_note: '', contractor_name: '', events: [],
          ...job.response?.ticket, pending_sync: pending(job)
        });
        continue;
      }
      const ticket = result.tickets.find((entry) => entry.id === decodeURIComponent(job.path.split('/')[3]));
      if (!ticket) continue;
      const action = job.path.split('/')[4];
      let event = '';
      let detail = body.note || '';
      if (action === 'assignment') {
        ticket.assigned_to = body.assistantId;
        ticket.assigned_to_name = users().find((entry) => entry.id === body.assistantId)?.name
          || read(`/api/ticket-assignees?propertyId=${encodeURIComponent(ticket.property_id)}`).assistants.find((entry) => entry.id === body.assistantId)?.name || body.assistantId;
        ticket.status = 'assigned';
        ticket.contractor_name = '';
        event = 'Assigned to maintenance assistant';
        detail = ticket.assigned_to_name;
      } else if (action === 'status') {
        ticket.status = body.status;
        if (body.status === 'contractor') {
          ticket.assigned_to = null;
          ticket.assigned_to_name = null;
          ticket.contractor_name = body.contractorName;
        }
        event = body.status.replaceAll('_', ' ');
      } else if (action === 'complete') {
        ticket.status = 'completed';
        ticket.has_completion_photo = true;
        ticket.completed_at = job.createdAt;
        event = 'Completed with photo';
      } else if (action === 'replies') {
        event = 'Reply';
        detail = body.message;
      } else if (action === 'tags') {
        ticket.tags = body.tags;
        event = 'Tags updated';
        detail = body.tags.join(', ');
      }
      ticket.events ||= [];
      ticket.events.push({ event, detail, actor: user.name, at: job.createdAt });
      ticket.updated_at = job.createdAt;
      ticket.pending_sync = pending(job);
    }
    result.tickets = result.tickets.filter((ticket) => allowedBuilding(ticket.property_id)
      && (isManagementRole(user.role)
        || (user.role === 'user' && ticket.created_by === user.id)
        || (user.role === 'maintenance_assistant' && ticket.assigned_to === user.id)));
  } else if (path === '/api/appliance-reports') {
    if (!result) return missing();
    for (const job of changes.filter((item) => item.path === path && item.method === 'POST')) {
      const parts = read('/api/appliance-parts').parts;
      const full = isManagementRole(user.role);
      let entries = job.body.entries ? snapshotEntries(job.body.entries, job.body.expectedParts || parts) : null;
      if (entries && !full) entries = entries.map(({ checkAudit, photo, ...entry }) => ({ ...entry, photo: { data: photo.data, source: photo.source } }));
      upsert(result.reports, {
        id: job.localId, property_id: job.body.propertyId, visit_id: job.body.visitId, building_name: propertyName(job.body.propertyId),
        created_by: user.id, technician_name: user.name, unit_number: job.body.unitNumber, appliance_type: job.body.applianceType,
        model_number: job.body.modelNumber, fault: job.body.fault, notes: job.body.notes, created_at: job.createdAt,
        entries, expected_count: job.body.expectedCount,
        parts: (job.body.parts || []).map((selection) => ({ ...(job.body.expectedParts || parts).find((part) => part.id === selection.id), ...selection })),
        ...(full ? { check_audit: job.body.checkAudit } : {}),
        ...job.response?.report, pending_sync: pending(job)
      });
    }
    result.reports = result.reports.filter((report) => allowedBuilding(report.property_id)
      && (isManagementRole(user.role) || (user.role === 'technician' && report.created_by === user.id)));
  } else if (/^\/api\/appliance-reports\/[^/]+\/export$/.test(path)) {
    const report = read('/api/appliance-reports').reports.find((entry) => entry.id === decodeURIComponent(path.split('/')[3]));
    if (!report) return missing();
    result = { html: reportHtml(report, isManagementRole(user.role)), title: `Appliance-${report.id}` };
  } else if (path === '/api/billing/accounts') {
    if (!result) return missing();
    for (const job of changes.filter((item) => item.path === '/api/users' && item.method === 'POST' && item.body.role === 'user')) {
      upsert(result.accounts, { id: job.localId, name: job.body.name, email: job.body.email, property_ids: job.body.propertyIds, active: true, status: 'active', balance_cents: 0, pending_sync: pending(job) });
    }
    result.accounts = result.accounts.filter((account) => canAccessBillingAccount(user, account));
    for (const account of result.accounts) {
      const key = `/api/billing/accounts/${encodeURIComponent(account.id)}`;
      if (cache[key] || changes.some((job) => job.path.startsWith(`${key}/`))) {
        const snapshot = read(key);
        Object.assign(account, { status: snapshot.account.status, balance_cents: snapshot.balanceCents, pending_sync: snapshot.pending_sync });
      }
    }
  } else if (path === '/api/billing/me' || /^\/api\/billing\/accounts\/[^/]+$/.test(path)) {
    const id = path === '/api/billing/me' ? user.id : decodeURIComponent(path.split('/')[4]);
    if (!result) {
      const created = changes.find((job) => job.localId === id && job.path === '/api/users' && job.body.role === 'user');
      if (!created) return missing();
      result = { account: { id, name: created.body.name, email: created.body.email, property_ids: created.body.propertyIds, status: 'active', note: '' }, entries: [], balanceCents: 0 };
    }
    if (path === '/api/billing/me' ? result.account.id !== user.id
      : !canAccessBillingAccount(user, result.account)) throw new Error('This account is outside your assigned buildings.');
    for (const job of changes.filter((item) => item.path.startsWith(`/api/billing/accounts/${encodeURIComponent(id)}/`))) {
      if (job.path.endsWith('/status')) Object.assign(result.account, { status: job.body.status, note: job.body.note || '' });
      else if (job.path.endsWith('/void')) {
        const entry = result.entries.find((item) => item.id === decodeURIComponent(job.path.split('/')[6]));
        if (entry) entry.voided_at = job.createdAt;
      } else if (job.path.endsWith('/entries')) {
        upsert(result.entries, {
          id: job.localId, kind: job.body.kind, amount_cents: Math.round(Number(job.body.amount) * 100),
          description: job.body.description, entry_date: job.body.date || job.createdAt.slice(0, 10), created_at: job.createdAt, voided_at: null
        });
      }
      result.pending_sync = pending(job);
    }
    result.entries.sort((a, b) => a.entry_date.localeCompare(b.entry_date) || a.created_at.localeCompare(b.created_at));
    result.balanceCents = result.entries.filter((entry) => !entry.voided_at).reduce((total, entry) => total + (entry.kind === 'charge' ? entry.amount_cents : -entry.amount_cents), 0);
  } else {
    return missing();
  }
  return result;
}

export function optimisticResult(job, cache, jobs, user, ids) {
  const path = mappedPath(job.path, ids);
  const localId = ids[job.localId] || job.localId;
  const find = (key, list) => projectView(key, cache, jobs, user, ids)[list].find((item) => item.id === localId);
  if (path === '/api/technician-checkins') return { visit: projectView('/api/technician-schedule', cache, jobs, user, ids).visits.find((visit) => visit.id === job.body.id) };
  if (path === '/api/users') return { user: find(path, 'users') };
  if (path.startsWith('/api/users/')) return { user: projectView('/api/users', cache, jobs, user, ids).users.find((item) => item.id === decodeURIComponent(path.split('/')[3])) };
  if (path === '/api/properties') return { property: find(path, 'properties') };
  if (path === '/api/appliance-parts') return { part: find(path, 'parts') };
  if (path === '/api/appliance-reports') return { report: find(path, 'reports') };
  if (path === '/api/tickets') return { ticket: find(path, 'tickets') };
  if (path.startsWith('/api/billing/accounts/')) return projectView(path.split('/').slice(0, 5).join('/'), cache, jobs, user, ids);
  return { success: true };
}
