function decode(value) {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0));
}

export async function verifyLicenceToken(token, publicKey, systemId) {
  if (typeof token !== 'string' || token.length > 4096) throw new Error('The downloaded licence token is invalid.');
  const parts = token.split('.');
  if (parts.length !== 3 || !['PO1', legacy.tokenPrefix].includes(parts[0]) || !parts.slice(1).every((part) => /^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error('The downloaded licence token is invalid.');
  }
  const key = await crypto.subtle.importKey('jwk', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, decode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) {
    throw new Error('The downloaded licence signature is invalid. Connect to the correct server.');
  }
  const claims = JSON.parse(new TextDecoder().decode(decode(parts[1])));
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const next = new Date(claims.termStart);
  const month = next.getUTCMonth();
  next.setUTCFullYear(next.getUTCFullYear() + 1);
  if (next.getUTCMonth() !== month) next.setUTCDate(0);
  if (![1, 2].includes(claims.v) || claims.systemId !== systemId || !uuid.test(claims.systemId) || !uuid.test(claims.id)
      || (claims.previousId !== null && !uuid.test(claims.previousId))
      || !['issuedAt', 'termStart', 'expiresAt'].every((name) => typeof claims[name] === 'string'
        && Number.isFinite(Date.parse(claims[name])) && new Date(claims[name]).toISOString() === claims[name])
      || (claims.v === 1 && (claims.termStart < claims.issuedAt || claims.expiresAt !== next.toISOString()))
      || (claims.v === 2 && (typeof claims.active !== 'boolean' || claims.expiresAt <= claims.termStart))) {
    throw new Error('The downloaded licence is not a valid annual licence for this system.');
  }
  return claims;
}

export function licenceWarning(expiresAt, now = new Date()) {
  const expiry = new Date(expiresAt);
  const monthBefore = new Date(expiry);
  const day = monthBefore.getUTCDate();
  monthBefore.setUTCDate(1);
  monthBefore.setUTCMonth(monthBefore.getUTCMonth() - 1);
  const lastDay = new Date(Date.UTC(monthBefore.getUTCFullYear(), monthBefore.getUTCMonth() + 1, 0)).getUTCDate();
  monthBefore.setUTCDate(Math.min(day, lastDay));
  const remaining = expiry.getTime() - new Date(now).getTime();
  if (remaining <= 0) return 'expired';
  if (remaining <= 86400000) return 'one day';
  if (remaining <= 7 * 86400000) return 'one week';
  if (new Date(now) >= monthBefore) return 'one month';
  return null;
}

export function createLicenceClient({ storage, getServer, request, onChange, now = () => Date.now(), monotonic = () => performance.now() }) {
  let saved = null, claims = null, active = false, anchor = null, currentServer = null;
  let message = 'Connect to verify the annual system licence.';
  let generation = 0;
  const key = (server) => `system-licence-v1:${server}`;
  const time = () => Math.max(now(), anchor ? anchor.time + Math.max(0, monotonic() - anchor.tick) : 0);
  function state() {
    return { active, message, systemId: saved?.systemId || '', token: saved?.token || '',
      ownerRegistered: saved?.ownerRegistered || false, testRenewalEnabled: saved?.testRenewalEnabled || false,
      companyName: saved?.companyName || '', companyCode: saved?.companyCode || '',
      expiresAt: claims?.expiresAt || null, warning: claims ? licenceWarning(claims.expiresAt, time()) : null };
  }
  function publish() { onChange(state()); }
  function check() {
    if (getServer() !== currentServer) {
      active = false;
      message = 'The server changed. Connect to verify its annual licence.';
    } else if (saved && now() + 300000 < saved.highWater) {
      active = false;
      message = 'The device clock moved backwards. Correct the date/time and reconnect.';
    } else if (claims?.v === 2 && !claims.active) {
      active = false;
      message = 'This client account is inactive. Contact PrimeOps.';
    } else if (claims?.v === 2 && time() < Date.parse(claims.termStart)) {
      active = false;
      message = 'The licence period has not started yet.';
    } else if (claims && time() >= Date.parse(claims.expiresAt)) {
      active = false;
      message = 'The annual licence has expired. Ask the owner to renew it.';
    }
    publish();
    return active;
  }
  function assertActive() {
    if (!check()) throw Object.assign(new Error(message), { status: 423, code: 'LICENSE_REQUIRED' });
  }
  async function accept(value, server, attempt) {
    const verified = value.token && value.publicKey
      ? await verifyLicenceToken(value.token, value.publicKey, value.systemId) : null;
    if (getServer() !== server || attempt !== generation) return false;
    const serverTime = Date.parse(value.serverTime);
    if (!Number.isFinite(serverTime)) throw new Error('The server licence time is invalid.');
    saved = { ...value, highWater: Math.max(serverTime, now()) };
    claims = verified;
    currentServer = server;
    anchor = { time: saved.highWater, tick: monotonic() };
    active = value.state === 'active' && !!verified;
    message = value.message;
    await storage.set(key(server), saved);
    if (getServer() !== server || attempt !== generation) return false;
    check();
    return active;
  }
  async function refresh() {
    const server = getServer(), attempt = ++generation;
    let received = false;
    try {
      const value = await request('/api/license', { auth: false });
      received = true;
      return await accept(value, server, attempt);
    } catch (error) {
      if (getServer() !== server || attempt !== generation) return false;
      if (received) {
        active = false;
        message = `Could not verify the downloaded licence: ${error.message}`;
        publish();
        throw error;
      }
      if (error.status && error.status < 500) throw error;
      console.error('Live licence check failed:', error.message);
      const cached = await storage.get(key(server));
      if (getServer() !== server || attempt !== generation) return false;
      if (!cached) {
        active = false;
        saved = null;
        claims = null;
        currentServer = server;
        message = 'Connect to this server once to download its signed annual licence.';
        publish();
        return false;
      }
      const verified = cached.token && cached.publicKey
        ? await verifyLicenceToken(cached.token, cached.publicKey, cached.systemId) : null;
      if (getServer() !== server || attempt !== generation) return false;
      saved = cached;
      claims = verified;
      currentServer = server;
      anchor = { time: Math.max(now(), cached.highWater), tick: monotonic() };
      active = cached.state === 'active' && !!claims;
      message = cached.message;
      return check();
    }
  }
  return {
    refresh, check, assertActive, state,
    block(text) { active = false; message = text; publish(); },
    async checkpoint() {
      check();
      if (saved && currentServer === getServer()) {
        saved.highWater = Math.max(saved.highWater, time());
        await storage.set(key(currentServer), saved);
      }
    },
    async activate(token) {
      const server = getServer(), attempt = ++generation;
      const value = await request('/api/license/activate', { auth: false, method: 'POST', body: { token } });
      return accept(value, server, attempt);
    },
    async renew({ mode, username, password }) {
      const server = getServer(), attempt = ++generation;
      const baseTokenId = claims?.id || 'first-activation';
      const result = await request('/api/license/renew', { auth: false, method: 'POST', body: { mode, username, password, baseTokenId } });
      return accept(result.licence, server, attempt);
    }
  };
}
import legacy from './legacy-identifiers.json' with { type: 'json' };
