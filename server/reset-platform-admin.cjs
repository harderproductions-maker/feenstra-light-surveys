const bcrypt = require('bcryptjs');

async function resetAdministrator(database, username, password) {
  username = typeof username === 'string' ? username.trim().toLowerCase() : '';
  if (!username || username.length > 100 || typeof password !== 'string'
      || password.length < 12 || Buffer.byteLength(password) > 72) {
    throw new Error('Choose an administrator username and a password of 12-72 bytes.');
  }
  const hash = await bcrypt.hash(password, 12);
  const { rows: staff } = await database.query('SELECT id FROM platform_staff WHERE username=$1', [username]);
  if (staff[0]) throw new Error('That username belongs to a platform staff member. Choose a different owner username.');
  const { rows } = await database.query(`UPDATE licence_owner
    SET username=$1,password_hash=$2,session_version=session_version+1
    WHERE id=1 RETURNING username`, [username, hash]);
  if (!rows[0]) throw new Error('Platform administration has not been set up. Use the private administrator page first.');
  return rows[0].username;
}

async function main() {
  const { Client } = require('pg');
  const { Writable } = require('node:stream');
  const readline = require('node:readline/promises');
  if (!process.stdin.isTTY) throw new Error('Run this command in an interactive terminal; passwords are not accepted as command arguments.');
  const username = process.argv[2];
  if (!username) throw new Error('Usage: node server/reset-platform-admin.cjs <administrator-username>');
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    }
  });
  const controller = new AbortController();
  const terminal = readline.createInterface({ input: process.stdin, output, terminal: true });
  terminal.on('SIGINT', () => { controller.abort(); terminal.close(); });
  async function secret(prompt) {
    process.stdout.write(prompt);
    muted = true;
    try { return await terminal.question('', { signal: controller.signal }); }
    finally { muted = false; process.stdout.write('\n'); }
  }
  let password;
  try {
    password = await secret('New PrimeOps administrator password (hidden): ');
    if (password !== await secret('Confirm password (hidden): ')) throw new Error('Passwords do not match. Nothing was changed.');
  } finally { terminal.close(); }
  let connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    if (!process.env.POSTGRES_PASSWORD) throw new Error('Set DATABASE_URL or the POSTGRES connection settings before resetting the administrator.');
    const url = new URL('postgres://127.0.0.1');
    url.hostname = process.env.POSTGRES_HOST || '127.0.0.1';
    url.port = process.env.POSTGRES_PORT || '5432';
    url.username = process.env.POSTGRES_USER || 'primeops';
    url.password = process.env.POSTGRES_PASSWORD;
    url.pathname = `/${process.env.POSTGRES_DB || 'primeops'}`;
    connectionString = url.href;
  }
  const database = new Client({ connectionString, connectionTimeoutMillis: 10000 });
  await database.connect();
  try {
    const name = await resetAdministrator(database, username, password);
    console.log(`PrimeOps administrator reset: ${name}. All previous platform sessions were signed out.`);
    console.log('Client accounts, signing keys, licences and records were not changed.');
  } finally { await database.end(); }
}

module.exports = { resetAdministrator };
if (require.main === module) {
  main().catch((error) => {
    console.error(`Administrator reset failed: ${error.message}`);
    process.exitCode = 1;
  });
}
