import { createOfflineAuth, isServerUnavailable } from './offline-auth.mjs';
import { createLicenceClient } from './licence.mjs';

export async function resolveClient({ identifier, server, storage, request }) {
  const entered = String(identifier || '').trim();
  if (!entered || entered.length > 120) throw new Error('Enter your client code or company name.');
  const key = `primeops-client:${server}:${entered.toLowerCase()}`;
  let company;
  try {
    company = await request('/api/auth/company', { identifier: entered });
  } catch (error) {
    if (!isServerUnavailable(error)) throw error;
    const saved = storage.getItem(key);
    if (saved) return saved;
    if (/^[A-Z0-9][A-Z0-9-]{1,39}$/i.test(entered)) return entered.toUpperCase();
    throw new Error('Connect once to find this company by name, or enter its client code for offline sign-in.');
  }
  if (!/^[A-Z0-9][A-Z0-9-]{1,39}$/.test(company.code)) throw new Error('The server returned an invalid client code.');
  storage.setItem(key, company.code);
  return company.code;
}

export async function signInClient({ server, storage, request, email, password }) {
  const licence = createLicenceClient({
    storage, getServer: () => server,
    request: (path, options) => request(path, options?.body),
    onChange() {}
  });
  if (!await licence.refresh()) throw new Error(licence.state().message);
  const auth = createOfflineAuth({
    storage, getServer: () => server,
    authenticate: async (username, secret) => {
      const { token } = await request('/api/auth/login', { email: username, password: secret });
      const { user } = await request('/api/auth/me', undefined, token);
      return { token, user };
    }
  });
  return auth.signIn(email, password);
}
