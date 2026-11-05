const { test } = require('node:test');
const assert = require('node:assert/strict');
const { balances, money, date, forecast, accountFigures, createPlatformAccounts } = require('./platform-accounts.cjs');

test('rand values use exact cents and reject invalid or oversized amounts', () => {
  assert.equal(money('1500.25'), 150025);
  assert.equal(money('0.01'), 1);
  assert.equal(money('9999999.99'), 999999999);
  for (const value of ['0', '-1', '1.001', '1e3', '10000000', 'NaN', 100, null]) assert.throws(() => money(value));
  assert.equal(date('2028-02-29'), '2028-02-29');
  for (const value of ['2026-02-29', '2026-11-31', '2026-1-01', '', null]) assert.throws(() => date(value));
});

test('12-month forecasts include unbilled monthly fees and do not duplicate service invoices or received advances', () => {
  const now = new Date('2026-11-03T10:00:00Z');
  const company = { active: true, monthlyFeeCents: 10000, startsOn: '2026-11-01', endsOn: null };
  const invoices = [
    { serviceMonth: '2026-11-01', dueOn: '2026-11-15', amountCents: 12000, paidCents: 12000, outstandingCents: 0 },
    { serviceMonth: null, dueOn: '2026-12-10', amountCents: 2000, paidCents: 0, outstandingCents: 2000 },
    { serviceMonth: '2027-01-01', dueOn: '2027-01-01', amountCents: 10000, paidCents: 10000, outstandingCents: 0 }
  ];
  const result = forecast(company, invoices, 17000, now);
  assert.equal(result.months.length, 12);
  assert.equal(result.months[0].month, '2026-11');
  assert.equal(result.months[11].month, '2027-10');
  assert.deepEqual(result.months.slice(0, 4), [
    { month: '2026-11', expectedCents: 12000, paidCents: 12000, creditCents: 0, collectCents: 0, overdueCents: 0 },
    { month: '2026-12', expectedCents: 12000, paidCents: 0, creditCents: 12000, collectCents: 0, overdueCents: 0 },
    { month: '2027-01', expectedCents: 10000, paidCents: 10000, creditCents: 0, collectCents: 0, overdueCents: 0 },
    { month: '2027-02', expectedCents: 10000, paidCents: 0, creditCents: 5000, collectCents: 5000, overdueCents: 0 }
  ]);
  assert.equal(result.projectedCents, 124000);
  assert.equal(result.projectedCollectionCents, 85000);
  assert.equal(result.coveredThrough, '2027-01');
  assert.equal(result.coveredMonths, 3);
  assert.equal(result.paidAhead, true);
  assert.equal(result.paidAheadCents, 27000);
});

test('forecast start/end months and inactive clients exclude unbilled fees; arrears stay separate', () => {
  const now = new Date('2026-12-15T00:00:00Z');
  const plan = { active: true, monthlyFeeCents: 10000, startsOn: '2027-01-01', endsOn: '2027-02-01' };
  const result = forecast(plan, [], 0, now);
  assert.equal(result.projectedCents, 20000);
  assert.deepEqual(result.months.filter((row) => row.expectedCents > 0).map((row) => row.month), ['2027-01', '2027-02']);
  assert.equal(forecast({ ...plan, active: false }, [], 0, now).projectedCents, 0);
  assert.equal(forecast({ active: true, monthlyFeeCents: 0, startsOn: null }, [], 0, now).projectedCents, 0);
  const overdue = { serviceMonth: '2026-12-01', dueOn: '2026-12-01', amountCents: 10000, paidCents: 2500, outstandingCents: 7500 };
  const arrears = forecast({ ...plan, startsOn: '2026-12-01' }, [overdue], 0, now);
  assert.equal(arrears.months[0].overdueCents, 7500);
  assert.equal(arrears.months[0].collectCents, 0);
  assert.equal(arrears.coveredThrough, null);
});

test('advance receipts are income once, allocations are not new income, and reversals remove cash and coverage', () => {
  const company = { active: true, monthlyFeeCents: 10000, startsOn: '2026-11-01' };
  const invoices = [{ serviceMonth: '2026-11-01', dueOn: '2026-11-01', amountCents: 10000, paidCents: 10000, outstandingCents: 0 }];
  const payments = [{ amountCents: 10000, paidOn: '2026-11-03', creditId: 'advance' }, { amountCents: 5000, paidOn: '2026-10-10', creditId: null }];
  const credits = [{ amountCents: 40000, paidOn: '2026-11-02', availableCents: 30000 }];
  const result = accountFigures(company, invoices, payments, credits, new Date('2026-11-03Z'));
  assert.equal(result.incomeCents, 45000);
  assert.equal(result.monthIncomeCents, 40000);
  assert.equal(result.prepaidCents, 30000);
  assert.equal(result.forecast.coveredThrough, '2027-02');
  const reversed = accountFigures(company, [{ ...invoices[0], paidCents: 0, outstandingCents: 10000 }],
    payments.map((payment) => ({ ...payment, reversedAt: '2026-11-04' })),
    [{ ...credits[0], reversedAt: '2026-11-04', availableCents: 0 }], new Date('2026-11-05Z'));
  assert.equal(reversed.incomeCents, 0);
  assert.equal(reversed.prepaidCents, 0);
  assert.equal(reversed.arrearsCents, 10000);
  assert.equal(reversed.daysOverdue, 4);
});

test('arrears block only after seven complete UTC grace days; extensions do not erase debt', () => {
  const invoices = [{ amountCents: 10000, paidCents: 2500, outstandingCents: 7500, dueOn: '2026-11-01' }];
  assert.equal(balances(invoices, null, new Date('2026-11-01T23:59:59Z')).arrearsCents, 0);
  assert.equal(balances(invoices, null, new Date('2026-11-02T00:00:00Z')).arrearsCents, 7500);
  assert.equal(balances(invoices, null, new Date('2026-11-08T23:59:59.999Z')).blocked, false);
  assert.equal(balances(invoices, null, new Date('2026-11-09T00:00:00Z')).blocked, true);
  const extended = balances(invoices, '2026-11-10T12:00:00Z', new Date('2026-11-10T11:59:59Z'));
  assert.equal(extended.blocked, false);
  assert.equal(extended.arrearsCents, 7500);
  assert.equal(balances(invoices, '2026-11-10T12:00:00Z', new Date('2026-11-10T12:00:00Z')).blocked, true);
  assert.equal(balances([{ ...invoices[0], paidCents: 10000, outstandingCents: 0 }], null, new Date('2026-12-01Z')).blocked, false);
  assert.equal(balances([{ ...invoices[0], voidedAt: '2026-11-10' }], null, new Date('2026-12-01Z')).outstandingCents, 0);
});

test('TEST/DEMO accounts stay unblocked by default but can exercise a simulated billing lock', () => {
  const company = { active: true, testAccount: true, simulatedBlocked: false, monthlyFeeCents: 10000, startsOn: '2026-11-01' };
  const invoice = { serviceMonth: '2026-10-01', dueOn: '2026-10-01', amountCents: 10000, paidCents: 0, outstandingCents: 10000 };
  const inputs = [[invoice], [], []];
  assert.equal(accountFigures(company, ...inputs, new Date('2026-11-20Z')).blocked, false);
  assert.equal(accountFigures({ ...company, simulatedBlocked: true }, ...inputs, new Date('2026-11-20Z')).blocked, true);
});

function simulationFixture(testAccount = true) {
  const state = {
    company: { testAccount, simulatedBlocked: false, revision: 0 },
    invoices: new Map([
      ...['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003']
        .map((id) => [id, { id, amountCents: 10000, voidedAt: null }])
    ]),
    payments: [],
    simulations: [],
    events: []
  };
  const client = {
    async query(sql, values = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('SELECT billing_test_account AS "testAccount"')) return { rows: [{
        testAccount: state.company.testAccount, simulatedBlocked: state.company.simulatedBlocked
      }] };
      if (sql.includes('FROM public.platform_test_payment_simulations WHERE id=$1')) {
        return { rows: state.simulations.filter((row) => row.id === values[0]) };
      }
      if (sql.includes('FROM public.platform_invoices WHERE id=$1 AND company_code=$2')) {
        const invoice = state.invoices.get(values[0]);
        return { rows: invoice ? [{ ...invoice }] : [] };
      }
      if (sql.includes('FROM public.platform_payments WHERE invoice_id=$1')) {
        return { rows: [{ paid: state.payments.filter((row) => row.invoiceId === values[0] && !row.reversedAt)
          .reduce((sum, row) => sum + row.amountCents, 0) }] };
      }
      if (sql.includes('INSERT INTO public.platform_payments')) {
        state.payments.push({ id: values[0], invoiceId: values[1], companyCode: values[2], reference: values[3],
          amountCents: values[4], createdBy: 'TEST SIMULATION' });
        return { rowCount: 1 };
      }
      if (sql.includes('UPDATE public.companies SET billing_simulated_blocked=TRUE')) {
        state.company.simulatedBlocked = true; return { rowCount: 1 };
      }
      if (sql.includes('UPDATE public.companies SET billing_simulated_blocked=FALSE')) {
        state.company.simulatedBlocked = false; return { rowCount: 1 };
      }
      if (sql.includes('INSERT INTO public.platform_test_payment_simulations')) {
        state.simulations.push({ id: values[0], company_code: values[1], invoice_id: values[2], outcome: values[3], amount_cents: values[4] });
        return { rowCount: 1 };
      }
      if (sql.includes('INSERT INTO public.platform_account_events')) {
        state.events.push({ actor: values[2], action: 'test_payment_simulation', detail: values[3] });
        return { rowCount: 1 };
      }
      if (sql.includes('UPDATE public.companies SET billing_revision=')) {
        state.company.revision++; return { rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {}
  };
  const service = createPlatformAccounts({ pool: { connect: async () => client }, companies: { current: () => ({ code: 'TEST' }) } });
  return { state, simulate: (options) => service.simulateTestPayment('TEST', 'client-admin', options) };
}

test('test-payment simulator records full, partial and declined outcomes as audited no-money receipts', async () => {
  const { state, simulate } = simulationFixture();
  const [fullInvoice, partialInvoice, declinedInvoice] = ['00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'];
  const full = await simulate({ simulationId: '00000000-0000-4000-8000-000000000101', invoiceId: fullInvoice, outcome: 'success' });
  assert.equal(full.amountCents, 10000);
  assert.equal(state.payments[0].createdBy, 'TEST SIMULATION');
  assert.equal((await simulate({ simulationId: '00000000-0000-4000-8000-000000000101', invoiceId: fullInvoice, outcome: 'success' })).duplicate, true);
  assert.equal(state.payments.length, 1);
  const partial = await simulate({ simulationId: '00000000-0000-4000-8000-000000000102', invoiceId: partialInvoice, outcome: 'partial', amountCents: 4999 });
  assert.equal(partial.amountCents, 4999);
  const declined = await simulate({ simulationId: '00000000-0000-4000-8000-000000000103', invoiceId: declinedInvoice, outcome: 'declined' });
  assert.equal(declined.amountCents, 0);
  assert.equal(state.payments.length, 2);
  assert.equal(state.simulations.length, 3);
  assert.equal(state.events.length, 3);
});

test('simulated lock can be cleared by a full demo payment and rejects live accounts and reused IDs', async () => {
  const { state, simulate } = simulationFixture();
  const invoiceId = '00000000-0000-4000-8000-000000000001';
  await simulate({ simulationId: '00000000-0000-4000-8000-000000000201', invoiceId, outcome: 'block' });
  assert.equal(state.company.simulatedBlocked, true);
  await simulate({ simulationId: '00000000-0000-4000-8000-000000000202', invoiceId, outcome: 'success' });
  assert.equal(state.company.simulatedBlocked, false);
  await assert.rejects(simulationFixture(false).simulate({
    simulationId: '00000000-0000-4000-8000-000000000203', invoiceId, outcome: 'success'
  }), /TEST \/ DEMO/);
  await assert.rejects(simulate({
    simulationId: '00000000-0000-4000-8000-000000000201', invoiceId, outcome: 'success'
  }), /already used/);
});

test('simulated partial payments must be positive and below the outstanding balance', async () => {
  const { simulate } = simulationFixture();
  const invoiceId = '00000000-0000-4000-8000-000000000001';
  for (const amountCents of [0, 10000, 10001, 1.5, '500']) {
    await assert.rejects(simulate({
      simulationId: '00000000-0000-4000-8000-000000000301', invoiceId, outcome: 'partial', amountCents
    }), /partial test payment/);
  }
});
