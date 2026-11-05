const test = require('node:test');
const assert = require('node:assert/strict');
const { signature, parameterString, configuration } = require('./payfast.cjs');
test('Payfast encoding/signature follow ordered form encoding and require explicit private configuration', () => {
  const entries = [['merchant_id', '10000100'], ['item_name', 'Service & operations'], ['amount', '100.00']];
  assert.equal(parameterString(entries), 'merchant_id=10000100&item_name=Service+%26+operations&amount=100.00');
  assert.equal(signature(entries, 'pass phrase'), require('node:crypto').createHash('md5')
    .update('merchant_id=10000100&item_name=Service+%26+operations&amount=100.00&passphrase=pass+phrase').digest('hex'));
  assert.equal(configuration({}), null);
  const env = { PAYFAST_MERCHANT_ID: 'test', PAYFAST_MERCHANT_KEY: 'test', PAYFAST_PASSPHRASE: 'test', PUBLIC_APP_URL: 'https://app.example.test', PAYFAST_SANDBOX: 'true' };
  assert.equal(configuration(env).base, 'https://sandbox.payfast.co.za');
  assert.equal(configuration({ ...env, PAYFAST_SANDBOX: 'false' }).base, 'https://www.payfast.co.za');
  assert.throws(() => configuration({ ...env, PUBLIC_APP_URL: 'http://example.test' }), /HTTPS/);
  assert.throws(() => configuration({ ...env, PUBLIC_APP_URL: 'https://example.test/path' }), /without a path/);
  assert.throws(() => configuration({ ...env, PAYFAST_SANDBOX: undefined }), /explicitly/);
});
