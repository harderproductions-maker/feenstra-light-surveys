import { compare, hash } from 'bcryptjs';

export function isServerUnavailable(error) {
  return error?.status >= 500 || (!error?.status
    && (error instanceof TypeError || ['TimeoutError', 'AbortError'].includes(error?.name)));
}

export function createOfflineAuth({ storage, getServer, authenticate }) {
  let sessionGeneration = 0;
  const accountKey = (email, server = getServer()) => `offline-auth-v1:${server}:${String(email).trim().toLowerCase()}`;
  const sessionKey = (server = getServer()) => `offline-session-v1:${server}`;
  function requireServer(server) {
    if (getServer() !== server) throw new Error('The server address changed. Sign in again to the selected server.');
  }

  async function remember(email, password, session, server) {
    const verifier = await hash(password, 12);
    requireServer(server);
    await storage.set(accountKey(email, server), { ...session, verifier });
    await storage.set(sessionKey(server), session);
  }

  async function signIn(email, password) {
    const normalizedEmail = String(email).trim().toLowerCase();
    const server = getServer();
    let session;
    try {
      session = await authenticate(normalizedEmail, password);
    } catch (error) {
      requireServer(server);
      if (!isServerUnavailable(error)) {
        if ([401, 403].includes(error.status)) await storage.set(accountKey(normalizedEmail, server), null);
        throw error;
      }
      const saved = await storage.get(accountKey(normalizedEmail, server));
      if (!saved) throw new Error('The server is unavailable. Sign in to this account while connected once on this device before signing in offline.');
      if (!await compare(password, saved.verifier)) throw new Error('Username or password is incorrect for the saved offline account.');
      requireServer(server);
      session = { token: saved.token, user: saved.user };
      await storage.set(sessionKey(server), session);
      return { ...session, offline: true };
    }
    requireServer(server);
    await remember(normalizedEmail, password, session, server);
    return { ...session, offline: false };
  }

  async function refresh(session) {
    const generation = sessionGeneration;
    const server = getServer();
    const key = accountKey(session.user.email, server);
    const saved = await storage.get(key);
    if (generation !== sessionGeneration) return;
    if (saved?.user.id === session.user.id) await storage.set(key, { ...saved, ...session });
    if (generation !== sessionGeneration) return;
    await storage.set(sessionKey(server), session);
  }

  return {
    signIn,
    refresh,
    session: () => storage.get(sessionKey()),
    signOut: () => {
      sessionGeneration++;
      return storage.set(sessionKey(), null);
    }
  };
}
