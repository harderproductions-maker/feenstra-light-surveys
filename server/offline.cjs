const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');

const schema = `CREATE TABLE IF NOT EXISTS offline_receipts (
  user_id TEXT NOT NULL REFERENCES app_users(id),
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_body JSONB,
  PRIMARY KEY (user_id, operation_id)
);
ALTER TABLE offline_receipts ADD COLUMN IF NOT EXISTS permission_key TEXT`;

function createOfflineTransactions(database) {
  const context = new AsyncLocalStorage();
  const pool = {
    query: (...args) => (context.getStore() || database).query(...args),
    connect: () => database.connect()
  };
  function middleware(authenticate, apiError) {
    return (req, res, next) => {
      const operation = req.get('X-Operation-ID');
      if (!operation) return next();
      if (!/^[a-f0-9-]{36}$/i.test(operation) || !['POST', 'PUT'].includes(req.method)
          || !/^\/api\/(technician-checkins|reports|users(?:\/[^/]+)?|properties|billing\/accounts\/[^/]+\/(?:status|entries(?:\/[^/]+\/void)?)|appliance-assets\/parts|appliance-parts(?:\/[^/]+)?|appliance-reports|tickets(?:\/[^/]+\/(?:assignment|status|complete|replies|tags))?)$/.test(req.path)) {
        return apiError(res, 400, 'This action cannot be submitted through offline sync.');
      }
      return authenticate(req, res, async () => {
        let client;
        let finishing = false;
        const send = res.json.bind(res);
        const hash = crypto.createHash('sha256').update(JSON.stringify([req.method, req.originalUrl, req.body])).digest('hex');
        async function permissionKey() {
          const { rows } = await client.query(
            `SELECT u.role, u.unit_number, u.active,u.sections,u.admin_rights,
              ARRAY(SELECT up.property_id FROM user_properties up JOIN app_properties p ON p.id = up.property_id
                WHERE up.user_id = u.id AND p.active = TRUE ORDER BY up.property_id) AS properties
             FROM app_users u WHERE u.id = $1`, [req.user.id]
          );
          const ticketId = /^\/api\/tickets\/([^/]+)\//.exec(req.path)?.[1];
          const ticket = ticketId ? (await client.query(
            'SELECT property_id, created_by, assigned_to FROM maintenance_tickets WHERE id = $1', [decodeURIComponent(ticketId)]
          )).rows : [];
          return crypto.createHash('sha256').update(JSON.stringify([rows, ticket])).digest('hex');
        }
        async function release(rollback) {
          if (!client) return;
          const connection = client;
          client = null;
          try {
            if (rollback) await connection.query('ROLLBACK');
          } finally {
            connection.release();
          }
        }
        try {
          client = await database.connect();
          await client.query('BEGIN');
          await client.query(`INSERT INTO offline_receipts (user_id, operation_id, request_hash) VALUES ($1, $2, $3)
            ON CONFLICT DO NOTHING`, [req.user.id, operation, hash]);
          const { rows } = await client.query('SELECT * FROM offline_receipts WHERE user_id = $1 AND operation_id = $2 FOR UPDATE', [req.user.id, operation]);
          if (rows[0].request_hash !== hash) {
            await release(true);
            return apiError(res, 409, 'This offline operation ID was already used for a different action.');
          }
          if (rows[0].response_status !== null) {
            const receipt = rows[0];
            const allowed = receipt.permission_key === await permissionKey();
            await release(true);
            if (!allowed) return apiError(res, 403, 'Your access changed after this saved action. Refresh your account before reviewing it.');
            return res.status(receipt.response_status).json(receipt.response_body);
          }
          if (req.body?.offlineBase) {
            let query;
            const segments = req.path.split('/');
            let resourceId = segments[3];
            if (/^\/api\/users\/[^/]+$/.test(req.path)) {
              query = `SELECT u.display_name AS name, u.email, u.role, u.active, u.unit_number,u.resident_type,u.sections,u.admin_rights,
                ARRAY(SELECT property_id FROM user_properties WHERE user_id = u.id ORDER BY property_id) AS property_ids
                FROM app_users u WHERE id = $1 FOR UPDATE`;
            } else if (/^\/api\/appliance-parts\/[^/]+$/.test(req.path)) {
              query = 'SELECT name, part_number, supplier, active, machine_type FROM appliance_parts WHERE id = $1 FOR UPDATE';
            } else if (/^\/api\/billing\/accounts\/[^/]+\/status$/.test(req.path)) {
              resourceId = segments[4];
              query = `SELECT COALESCE(b.status, 'active') AS status, COALESCE(b.note, '') AS note FROM app_users u
                LEFT JOIN billing_accounts b ON b.user_id = u.id WHERE u.id = $1`;
              await client.query('SELECT id FROM app_users WHERE id = $1 FOR UPDATE', [resourceId]);
            } else if (/^\/api\/tickets\/[^/]+\/(assignment|status|complete|tags)$/.test(req.path)) {
              query = 'SELECT status, assigned_to, tags, contractor_name FROM maintenance_tickets WHERE id = $1 FOR UPDATE';
            }
            if (query) {
              const { rows: current } = await client.query(query, [resourceId]);
              const matches = current[0] && Object.entries(req.body.offlineBase).every(([key, value]) => JSON.stringify(current[0][key]) === JSON.stringify(value));
              if (!matches) {
                await release(true);
                return apiError(res, 409, 'This record changed on the server while you were offline. Review the current record before resubmitting.');
              }
            }
          }
          res.json = (body) => {
            if (finishing) return res;
            finishing = true;
            const status = res.statusCode;
            void (async () => {
              try {
                if (status >= 400) {
                  await release(true);
                } else {
                  await client.query(`UPDATE offline_receipts SET response_status = $3, response_body = $4::jsonb, permission_key = $5
                    WHERE user_id = $1 AND operation_id = $2`, [req.user.id, operation, status, JSON.stringify(body), await permissionKey()]);
                  await client.query('COMMIT');
                  await release(false);
                }
                send(body);
              } catch (error) {
                console.error('Offline operation commit failed:', error.message);
                await release(true);
                res.status(503);
                send({ error: 'Could not confirm this saved change. Retry with the same operation ID.' });
              }
            })();
            return res;
          };
          res.on('finish', () => {
            if (!finishing) void release(true).catch((error) => console.error('Offline transaction cleanup failed:', error.message));
          });
          context.run(client, next);
        } catch (error) {
          console.error('Offline operation failed:', error.message);
          await release(true);
          return apiError(res, 503, 'Could not receive the offline change. It remains saved on your device.');
        }
      });
    };
  }
  return { pool, current: () => context.getStore(), middleware };
}

module.exports = { createOfflineTransactions, schema };
