import { isOfflineRead, isOfflineWrite, mappedPath, remap, projectView, optimisticResult } from './offline-views.mjs';
import { validateLaundryReport, reportSelections, partsForMachine } from './laundry.mjs';
import { permissionKey, canAccessBuilding } from './building-access.mjs';
import { assertCanMove, assertVisitPoint, bookingWindow, localDay } from './technician-visits.mjs';
import { sectionForPath, canUseSection, canDelegateAccounts, sectionsFor, accountBuildingIds, managerRoles, isManagerRole, isManagementRole } from './account-access.mjs';

export function createOfflineStore({ storage, send, getUser, getServer, notify, getSession = () => '', now = () => new Date().toISOString() }) {
  let busy = false;
  let serial = Promise.resolve();
  const capture = () => {
    const user = getUser();
    if (!user?.id) throw new Error('Sign in before using offline storage.');
    return { key: `offline-v1:${getServer()}:${user.id}`, user: structuredClone(user), permissions: permissionKey(user), session: getSession() };
  };
  function isCurrent(owner) {
    return !!getUser()?.id && owner.key === `offline-v1:${getServer()}:${getUser().id}`
      && owner.permissions === permissionKey(getUser()) && owner.session === getSession();
  }
  function assertCurrent(owner) {
    if (!isCurrent(owner)) throw Object.assign(new Error('The signed-in account or building access changed (including section permissions). Reopen this screen.'), { code: 'OFFLINE_SESSION_CHANGED' });
  }
  const fresh = (owner) => ({ cache: {}, jobs: [], ids: {}, photos: {}, role: owner.user.role, permissions: owner.permissions });
  async function load(owner) {
    assertCurrent(owner);
    const state = await storage.get(owner.key) || fresh(owner);
    assertCurrent(owner);
    if (state.permissions !== owner.permissions) {
      state.cache = {};
      state.photos = {};
      state.role = owner.user.role;
      state.permissions = owner.permissions;
      state.jobs = state.jobs.filter((job) => job.state !== 'confirmed');
      for (const job of state.jobs) if (job.state !== 'confirmed') {
        job.state = 'blocked';
        job.scopeBlocked = true;
        job.error = 'Your role or buildings changed, or your section access changed. Discard this saved action and re-enter it in an allowed section/building.';
      }
      await save(state, owner);
    }
    return state;
  }
  function locked(action) {
    const task = serial.then(action);
    serial = task.catch(() => {});
    return task;
  }
  async function save(state, owner) {
    assertCurrent(owner);
    await storage.set(owner.key, state);
    assertCurrent(owner);
    notify(state);
  }
  function networkError(error) {
    return !error.status && (error instanceof TypeError || ['TimeoutError', 'AbortError'].includes(error.name));
  }
  async function snapshot(path, value, owner) {
    await locked(async () => {
      const state = await load(owner);
      state.cache[mappedPath(path, state.ids)] = { value, at: now() };
      await save(state, owner);
    });
  }
  function requirePermission(path, method, user) {
    if (user.billingBlocked) throw new Error('This client account is blocked for overdue PrimeOps invoices. Connect to view the account statement or contact PrimeOps.');
    const full = isManagementRole(user.role);
    const appliance = user.role === 'technician' || full;
    if (path.startsWith('/api/building-quote-contacts') && !full) throw new Error('Manager access is required for supplier contacts.');
    if (path === '/api/technician-absences' && !full) throw new Error('Only MMs and administrators can record a no-show.');
    if (path === '/api/technician-checkins' && user.role !== 'technician') throw new Error('Only technicians check in to visits.');
    if (path === '/api/technician-schedule' && !appliance) throw new Error('Technician or manager access is required.');
    if ((path.startsWith('/api/users') || path.startsWith('/api/billing/accounts')) && !full) throw new Error('Manager access is required.');
    if (path.startsWith('/api/appliance-') && !appliance) throw new Error('Appliance access is required.');
    if (path.startsWith('/api/appliance-parts') && method !== 'GET' && !full) throw new Error('Manager access is required to change parts.');
    if (path.startsWith('/api/tickets') && user.role === 'technician') throw new Error('Technicians cannot access tickets.');
    if (path === '/api/billing/me' && user.role !== 'user') throw new Error('Only students have a personal billing account.');
    if (path === '/api/properties' && method !== 'GET' && !full) throw new Error('Manager access is required.');
    if (path === '/api/reports' && !isManagementRole(user.role) && user.role !== 'maintenance_assistant') throw new Error('Your role cannot save OHS reports.');
    const section = sectionForPath(path === '/api/properties' && method === 'POST' ? '/api/properties:create' : path);
    if (section && !canUseSection(user, section)) throw new Error('Your account does not have access to this section.');
  }
  function validate(job, state, user) {
    const body = job.body || {};
    if (job.scopeBlocked) throw new Error(job.error);
    requirePermission(job.path, job.method, user);
    if (job.path === '/api/reports' && !canUseSection(user, body.section || (body.kind === 'Lighting survey' ? 'lighting' : 'checks'))) {
      throw new Error('Your account cannot save reports for this section.');
    }
    const read = (path) => projectView(path, state.cache, state.jobs, user, state.ids);
    const positive = (value) => Number.isFinite(Number(value)) && Number(value) >= 0.01;
    if (job.path === '/api/technician-checkins' || (job.path === '/api/appliance-reports' && user.role === 'technician')) {
      const schedule = read('/api/technician-schedule');
      const reports = read('/api/appliance-reports').reports;
      const id = job.path === '/api/technician-checkins' ? body.id : body.visitId;
      let visit = schedule.visits.find((item) => item.id === id);
      if (!visit && body.extra && job.path === '/api/technician-checkins') {
        visit = { id, technician_id: user.id, property_id: body.propertyId, ...bookingWindow({ date: localDay(body.location?.capturedAt), allDay: true }) };
      }
      if (!visit || visit.technician_id !== user.id || visit.property_id !== body.propertyId) throw new Error('Choose a downloaded visit or start an extra visit at an assigned building.');
      assertCanMove(schedule.visits, reports, id);
      const boundary = schedule.locations.find((pin) => pin.property_id === body.propertyId);
      const points = job.path === '/api/technician-checkins' ? [body.location]
        : [body.checkAudit, ...body.entries.map((entry) => entry.checkAudit)].flatMap((audit) => [audit.started, audit.completed]);
      for (const point of points) assertVisitPoint(visit, point, boundary);
    }
    if (job.path === '/api/tickets') {
      if (user.role === 'maintenance_assistant') throw new Error('Assistants cannot log tickets.');
      if (body.accessGranted) throw new Error('Connect before granting apartment access. Unsent permission cannot be relied on.');
      if (!body.subject?.trim() || body.subject.length > 160 || !body.description?.trim() || body.description.length > 4000) throw new Error('Enter a title (up to 160 characters) and description (up to 4,000).');
      if (!body.unitNumber?.trim()) throw new Error('An apartment/unit number is required.');
      if (!body.tags?.length) throw new Error('Choose a ticket category.');
      if (!read('/api/properties').properties.some((property) => property.id === body.propertyId)) throw new Error('Choose a downloaded building.');
      if (body.scheduledFor && (!Number.isFinite(Date.parse(body.scheduledFor)) || Date.parse(body.scheduledFor) < Date.now())) throw new Error('Choose a future scheduled date.');
      read('/api/tickets');
    }
    if (job.path.startsWith('/api/tickets/')) {
      const ticket = read('/api/tickets').tickets.find((item) => item.id === decodeURIComponent(job.path.split('/')[3]));
      if (!ticket) throw new Error('Download this ticket before updating it offline.');
      const action = job.path.split('/')[4];
      if (action !== 'replies' && action !== 'tags' && ticket.status === 'completed') throw new Error('This ticket is already complete.');
      if (action === 'status' && user.role === 'maintenance_assistant' && body.status !== 'out_of_stock') throw new Error('Assistants may only flag out of stock or complete with a photo.');
      if (action === 'status' && isManagementRole(user.role) && !['in_progress', 'awaiting_stock', 'awaiting_access', 'contractor'].includes(body.status)) throw new Error('Choose a valid manager status.');
      if (action === 'status' && body.status === 'contractor' && !body.contractorName?.trim()) throw new Error('Enter the contractor name.');
      if (['assignment', 'tags'].includes(action) && !isManagementRole(user.role)) throw new Error('Manager access is required.');
      if (['complete', 'status'].includes(action) && !isManagementRole(user.role) && user.role !== 'maintenance_assistant') throw new Error('Only maintenance staff may change ticket status.');
      if (action === 'complete' && !body.photo?.startsWith('data:image/jpeg;base64,')) throw new Error('Take a completion photo first.');
      if (action === 'replies' && (!body.message?.trim() || body.message.length > 4000)) throw new Error('Enter a reply of up to 4,000 characters.');
    }
    if (job.path.startsWith('/api/billing/accounts/')) {
      const snapshot = read(job.path.split('/').slice(0, 5).join('/'));
      if (job.path.endsWith('/entries')) {
        if (!['charge', 'payment', 'credit'].includes(body.kind) || !positive(body.amount) || Number(body.amount) > 10000000 || !body.description?.trim()) throw new Error('Choose a transaction type, description and valid positive amount.');
        if (body.kind === 'charge' && snapshot.account.status !== 'active') throw new Error('Billing is blocked or stopped. Activate the account before adding charges.');
      }
    }
    if (job.path.startsWith('/api/users')) {
      if (!body.name?.trim() || !body.email?.trim() || !body.propertyIds?.length) throw new Error('Enter a name, username and at least one building.');
      if (!['user', ...managerRoles, 'maintenance_assistant', 'technician'].includes(body.role)) throw new Error('Choose a valid account role.');
      accountBuildingIds(body.role, body.propertyIds);
      if (body.role === 'user' && !body.unitNumber?.trim()) throw new Error('Resident accounts require a unit number.');
      if (body.residentType !== undefined && !['student', 'tenant'].includes(body.residentType)) throw new Error('Choose Student or Tenant for this resident.');
      if ((job.method === 'POST' || body.password) && String(body.password || '').length < 4) throw new Error('Use a password of at least four characters.');
      read('/api/users');
      if (user.role !== 'admin' && (body.role === 'admin' || (isManagerRole(body.role) && !canDelegateAccounts(user))
          || body.adminRights || sectionsFor({ ...body, companyFeatures: isManagerRole(body.role) ? undefined : user.companyFeatures }).some((section) => !canUseSection(user, section))
          || body.propertyIds.some((id) => !canAccessBuilding(user, id)))) throw new Error('Assign accounts only within your own buildings and permissions. Only full administrators grant scoped admin rights.');
      if (job.method === 'PUT' && !read('/api/users').users.some((entry) => entry.id === decodeURIComponent(job.path.split('/')[3]))) throw new Error('This account is outside your assigned buildings.');
    }
    if (job.path.startsWith('/api/appliance-parts')) {
      if (!['Washer', 'Dryer', 'Combo'].includes(body.machineType)) throw new Error('Choose the machine type for this part.');
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 150
          || (body.partNumber !== undefined && (typeof body.partNumber !== 'string' || body.partNumber.length > 100))) {
        throw new Error('Enter a part name (up to 150 characters). The optional part number must be at most 100 characters.');
      }
      read('/api/appliance-parts');
    }
    if (job.path === '/api/appliance-reports') {
      validateLaundryReport(body);
      if (!read('/api/properties').properties.some((property) => property.id === body.propertyId)) throw new Error('Choose a downloaded building you can access.');
      const parts = partsForMachine(read('/api/appliance-parts').parts, body.applianceType);
      body.expectedParts = reportSelections(body).map((selection) => {
        const part = parts.find((item) => item.id === selection.id && item.active);
        if (!part || !Number.isInteger(selection.quantity) || selection.quantity < 1 || selection.quantity > 999) throw new Error('Choose available parts and valid quantities.');
        return { id: part.id, name: part.name, part_number: part.part_number, supplier: part.supplier };
      });
      read('/api/appliance-reports');
    }
    if (job.path === '/api/reports' && (typeof body.html !== 'string' || !body.html || body.html.length > 60 * 1024 * 1024)) throw new Error('The report is empty or too large to upload.');
    if (job.path === '/api/reports' && user.role !== 'admin'
        && !read('/api/properties').properties.some((property) => property.name === body.building)) throw new Error('You cannot upload reports for this building.');
  }
  function baseline(path, state, user) {
    const read = (key) => projectView(key, state.cache, state.jobs, user, state.ids);
    if (/^\/api\/users\/[^/]+$/.test(path)) {
      const row = read('/api/users').users.find((user) => user.id === decodeURIComponent(path.split('/')[3]));
      if (!row) throw new Error('Download this account before editing it.');
      return { name: row.name, email: row.email, role: row.role, active: row.active, unit_number: row.unit_number, resident_type: row.resident_type,
        sections: row.sections ?? null, admin_rights: row.admin_rights === true, property_ids: [...row.property_ids].sort() };
    }
    if (/^\/api\/appliance-parts\/[^/]+$/.test(path)) {
      const row = read('/api/appliance-parts').parts.find((part) => part.id === decodeURIComponent(path.split('/')[3]));
      if (!row) throw new Error('Download this part before editing it.');
      return { name: row.name, part_number: row.part_number, supplier: row.supplier, active: row.active, machine_type: row.machine_type };
    }
    if (/^\/api\/billing\/accounts\/[^/]+\/status$/.test(path)) {
      const { account } = read(path.split('/').slice(0, 5).join('/'));
      return { status: account.status, note: account.note };
    }
    if (/^\/api\/tickets\/[^/]+\/(assignment|status|complete|tags)$/.test(path)) {
      const ticket = read('/api/tickets').tickets.find((item) => item.id === decodeURIComponent(path.split('/')[3]));
      if (!ticket) throw new Error('Download this ticket before editing it.');
      return { status: ticket.status, assigned_to: ticket.assigned_to || null, tags: ticket.tags || ['General'], contractor_name: ticket.contractor_name || '' };
    }
    return undefined;
  }
  async function queue(path, options, owner, operationId) {
    return locked(async () => {
      const state = await load(owner);
      const body = structuredClone(options.body || {});
      if (path === '/api/tickets' && owner.user.role === 'user') body.unitNumber = owner.user.unitNumber;
      const job = {
        id: operationId || crypto.randomUUID(), localId: `local-${crypto.randomUUID()}`, path, method: options.method || 'POST',
        body, createdAt: now(), state: 'pending', error: '', headers: {}
      };
      validate(job, state, owner.user);
      state.jobs.push(job);
      // Check the view can be projected before making a durable queue entry.
      const result = optimisticResult(job, state.cache, state.jobs, owner.user, state.ids);
      await save(state, owner);
      return { ...result, queued: true };
    });
  }
  async function request(path, options = {}, owner = getUser() ? capture() : null) {
    const user = owner?.user;
    const method = options.method || 'GET';
    const readable = isOfflineRead(path);
    const writable = isOfflineWrite(path, method);
    if (!user || options.auth === false) return send(path, options);
    assertCurrent(owner);
    requirePermission(path, method, user);
    if (path === '/api/technician-absences') requirePermission(path, method, user);
    if (method === 'PUT' && path === '/api/auth/profile-photo') {
      const value = await send(path, options);
      assertCurrent(owner);
      await snapshot(path, value, owner);
      return value;
    }
    if (!readable && !writable) {
      const value = await send(path, options);
      assertCurrent(owner);
      if (method === 'PUT' && path.startsWith('/api/building-quote-contacts/') && value.contact) {
        await locked(async () => {
          const state = await load(owner);
          const key = '/api/building-quote-contacts';
          const contacts = state.cache[key]?.value.contacts || [];
          state.cache[key] = { value: { contacts: [
            ...contacts.filter((item) => item.property_id !== value.contact.property_id), value.contact
          ] }, at: now() };
          await save(state, owner);
        });
      }
      return value;
    }
    requirePermission(path, method, user);
    let state = await load(owner);
    const unresolved = state.jobs.some((job) => job.state !== 'confirmed');
    if (method !== 'GET' && writable) {
      options = { ...options, body: structuredClone(options.body || {}) };
      options.body.offlineBase = baseline(path, state, user);
      if (path === '/api/tickets' && user.role === 'user') options.body.unitNumber = user.unitNumber;
      if (path === '/api/appliance-reports') {
        validateLaundryReport(options.body);
        const parts = partsForMachine(projectView('/api/appliance-parts', state.cache, state.jobs, user, state.ids).parts, options.body.applianceType);
        options.body.expectedParts = reportSelections(options.body).map((selection) => {
          const part = parts.find((item) => item.id === selection.id);
          if (!part) throw new Error('Reload the parts catalogue before saving.');
          return { id: part.id, name: part.name, part_number: part.part_number, supplier: part.supplier };
        });
      }
      if (unresolved || navigator.onLine === false || /local-/.test(path) || JSON.stringify(options.body || {}).includes('local-')) return queue(path, options, owner);
      const headers = new Headers(options.headers || {});
      headers.set('X-Operation-ID', crypto.randomUUID());
      try {
        const value = await send(path, { ...options, headers });
        assertCurrent(owner);
        return value;
      } catch (error) {
        assertCurrent(owner);
        if (!networkError(error) && !(error.status >= 500)) throw error;
        // Retain the same operation ID if the response was lost after the server committed.
        return queue(path, options, owner, headers.get('X-Operation-ID'));
      }
    }
    if (method === 'GET' && readable) {
      const projectedChanges = state.jobs.some((job) => job.state !== 'confirmed' && !job.scopeBlocked);
      if (!projectedChanges && navigator.onLine !== false) {
        try {
          const value = await send(mappedPath(path, state.ids), options);
          await snapshot(path, value, owner);
          state = await load(owner);
          return projectView(path, state.cache, state.jobs, user, state.ids);
        } catch (error) {
          assertCurrent(owner);
          if (!networkError(error) && !(error.status >= 500)) throw error;
        }
      }
      state = await load(owner);
      const value = projectView(path, state.cache, state.jobs, user, state.ids);
      value.offline_copy = true;
      value.downloaded_at = state.cache[mappedPath(path, state.ids)]?.at || null;
      notify(state, 'Showing downloaded data. Pending changes are not yet on the server.');
      return value;
    }
    return send(path, options);
  }
  async function sync() {
    if (busy || !getUser() || navigator.onLine === false) return;
    busy = true;
    const owner = capture();
    try {
      const { user: verifiedUser } = await send('/api/auth/me');
      assertCurrent(owner);
      if (!verifiedUser || verifiedUser.id !== owner.user.id || permissionKey(verifiedUser) !== owner.permissions) {
        throw new Error('Your building access changed. Reconnect to refresh your account before syncing.');
      }
      while (isCurrent(owner)) {
        let state = await load(owner);
        const job = state.jobs.find((item) => item.state !== 'confirmed');
        if (!job || job.state === 'blocked') break;
        try {
          const path = mappedPath(job.path, state.ids);
          const response = await send(path, {
            method: job.method, headers: { 'X-Operation-ID': job.id }, body: remap(job.body, state.ids)
          });
          assertCurrent(owner);
          await locked(async () => {
            state = await load(owner);
            const current = state.jobs.find((item) => item.id === job.id);
            current.state = 'confirmed';
            current.confirmedAt = now();
            current.error = '';
            current.response = response;
            const resource = response.user || response.property || response.part || response.report || response.ticket;
            if (job.method === 'POST' && resource?.id && !/\/(complete|replies)$/.test(path)) state.ids[job.localId] = resource.id;
            if (/\/entries$/.test(path) && response.entries) {
              if (response.entryId) state.ids[job.localId] = response.entryId;
            }
            if (path.endsWith('/complete')) {
              state.photos ||= {};
              state.photos[decodeURIComponent(path.split('/')[3])] = job.body.photo;
            }
            await save(state, owner);
          });
        } catch (error) {
          assertCurrent(owner);
          if (networkError(error) || error.status >= 500) {
            notify(state, 'Server unavailable. Changes remain saved on this device.');
            break;
          }
          await locked(async () => {
            state = await load(owner);
            const current = state.jobs.find((item) => item.id === job.id);
            current.state = 'blocked';
            current.error = error.message;
            await save(state, owner);
          });
          break;
        }
      }
      assertCurrent(owner);
      const state = await load(owner);
      if (!state.jobs.some((job) => job.state !== 'confirmed')) {
        if (!state.jobs.some((job) => job.state === 'confirmed')) {
          notify(state);
          return;
        }
        // Refresh authoritative views before dropping confirmed local projections.
        const paths = Object.keys(state.cache);
        for (const path of paths) {
          const value = await send(mappedPath(path, state.ids));
          await snapshot(mappedPath(path, state.ids), value, owner);
        }
        await locked(async () => {
          const latest = await load(owner);
          latest.jobs = latest.jobs.filter((job) => job.state !== 'confirmed');
          await save(latest, owner);
        });
      }
    } catch (error) {
      console.error('Offline synchronisation paused:', error);
      if (isCurrent(owner)) notify(await load(owner), error.status === 401 ? 'Sign in again to upload saved changes. They have not been deleted.' : error.message);
    } finally {
      busy = false;
    }
  }
  async function warm() {
    const user = getUser();
    if (!user || navigator.onLine === false) return;
    const owner = capture();
    const full = isManagementRole(user.role);
    const paths = ['/api/properties'];
    if (canUseSection(user, 'tickets')) paths.push('/api/tickets');
    if (canUseSection(user, 'checks')) paths.push('/api/check-templates');
    if (full && canUseSection(user, 'users')) paths.push('/api/users');
    if (full && canUseSection(user, 'billing')) paths.push('/api/billing/accounts');
    if (user.role === 'user') paths.push('/api/billing/me');
    if (canUseSection(user, 'appliances')) paths.push('/api/appliance-parts', '/api/appliance-reports', '/api/technician-schedule', '/api/appliance-assets');
    const saved = await load(owner);
    const download = async (path) => {
      assertCurrent(owner);
      const cached = saved.cache[path];
      if (cached && Date.now() - Date.parse(cached.at) < 5 * 60_000) return cached.value;
      return request(path, {}, owner);
    };
    for (const path of paths) await download(path);
    if (full) {
      const state = await load(owner);
      const properties = projectView('/api/properties', state.cache, state.jobs, user, state.ids).properties;
      if (canUseSection(user, 'tickets')) {
        for (const property of properties) await download(`/api/ticket-assignees?propertyId=${encodeURIComponent(property.id)}`);
      }
      if (canUseSection(user, 'billing')) {
        const accounts = projectView('/api/billing/accounts', state.cache, state.jobs, user, state.ids).accounts;
        for (const account of accounts) await download(`/api/billing/accounts/${encodeURIComponent(account.id)}`);
      }
    }
  }
  async function retry(id) {
    const owner = capture();
    await locked(async () => {
      const state = await load(owner);
      const job = state.jobs.find((item) => item.id === id);
      if (state.role !== getUser().role) throw new Error('Review your account role before retrying.');
      if (job) {
        validate(job, state, owner.user);
        job.state = 'pending';
        job.error = '';
      }
      await save(state, owner);
    });
    assertCurrent(owner);
    await sync();
  }
  async function discard(id) {
    const owner = capture();
    if (busy) throw new Error('Wait for synchronisation to finish before discarding changes.');
    await locked(async () => {
      const state = await load(owner);
      const index = state.jobs.findIndex((job) => job.id === id);
      if (index < 0) return;
      // Later entries may reference a newly created resource or depend on an earlier status change.
      state.jobs.splice(index);
      await save(state, owner);
    });
  }
  async function photo(id) {
    const owner = capture();
    const state = await load(owner);
    if (!projectView('/api/tickets', state.cache, state.jobs, owner.user, state.ids).tickets.some((ticket) => ticket.id === id)) throw new Error('This ticket is not available in your assigned buildings.');
    const job = state.jobs.findLast((item) => !item.scopeBlocked && mappedPath(item.path, state.ids) === `/api/tickets/${encodeURIComponent(id)}/complete`);
    return job?.body.photo || state.photos?.[id] || null;
  }
  async function cachePhoto(id, data) {
    const owner = capture();
    await locked(async () => {
      const state = await load(owner);
      if (!projectView('/api/tickets', state.cache, state.jobs, owner.user, state.ids).tickets.some((ticket) => ticket.id === id)) throw new Error('This ticket is not available in your assigned buildings.');
      state.photos ||= {};
      state.photos[id] = data;
      await save(state, owner);
    });
  }
  const status = () => {
    const owner = capture();
    return locked(() => load(owner));
  };
  return { request, sync, warm, status, retry, discard, photo, cachePhoto };
}
