import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNonNegativeCents,
  assertPositiveCents,
  fromCents,
  MoneyValidationError,
  toCents,
} from './money';
import {
  calculateAccountBalance,
  calculateConsolidatedBalances,
  findPotentialDuplicates,
} from './ledger';
import { parseMovementText } from './nlp-parser';
import type { AccountRecord, CategoryRecord, TransactionRecord } from './types';

test('toCents convierte formatos argentinos, anglosajones y decimales sin error IEEE 754', () => {
  assert.equal(toCents('15.500,50'), 1550050);
  assert.equal(toCents('10580'), 1058000);
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents('15,500.50'), 1550050);
  assert.equal(fromCents(1550050), 15500.5);
});

test('Validadores diferenciados del cero: assertPositiveCents (>0) vs assertNonNegativeCents (>=0)', () => {
  assert.equal(assertNonNegativeCents(0), 0);
  assert.equal(assertNonNegativeCents(500), 500);
  assert.throws(() => assertNonNegativeCents(-1), MoneyValidationError);

  assert.equal(assertPositiveCents(1), 1);
  assert.throws(() => assertPositiveCents(0), MoneyValidationError);
  assert.throws(() => assertPositiveCents(-100), MoneyValidationError);
});

test('Cálculo de saldos con transferencias en una sola fila y anulación lógica (voided_at)', () => {
  const accounts: AccountRecord[] = [
    {
      id: 'acc-mp',
      user_id: 'u1',
      name: 'MercadoPago',
      type: 'wallet',
      currency: 'ARS',
      opening_balance: 100000, // $1.000,00
      csv_column_map: null,
      archived: 0,
      created_at: 1700000000,
    },
    {
      id: 'acc-ef',
      user_id: 'u1',
      name: 'Efectivo',
      type: 'cash',
      currency: 'ARS',
      opening_balance: 0, // $0,00 permitido
      csv_column_map: null,
      archived: 0,
      created_at: 1700000000,
    },
    {
      id: 'acc-usd',
      user_id: 'u1',
      name: 'Caja USD',
      type: 'bank',
      currency: 'USD',
      opening_balance: 50000, // USD 500.00
      csv_column_map: null,
      archived: 0,
      created_at: 1700000000,
    },
  ];

  const txs: TransactionRecord[] = [
    {
      id: 'tx-1',
      user_id: 'u1',
      date: '2026-11-01',
      type: 'transfer',
      account_id: 'acc-mp',
      counter_account_id: 'acc-ef',
      category_id: null,
      amount: 40000, // $400,00
      currency: 'ARS',
      note: 'Retiro a efectivo',
      source: 'manual',
      voided_at: null,
      created_at: 1700000100,
    },
    {
      id: 'tx-2-voided',
      user_id: 'u1',
      date: '2026-11-02',
      type: 'expense',
      account_id: 'acc-ef',
      counter_account_id: null,
      category_id: 'cat-1',
      amount: 25000,
      currency: 'ARS',
      note: 'Gasto anulado',
      source: 'manual',
      voided_at: 1700000200, // Anulado: no debe impactar saldo
      created_at: 1700000150,
    },
  ];

  assert.equal(calculateAccountBalance(100000, 'acc-mp', txs), 60000);
  assert.equal(calculateAccountBalance(0, 'acc-ef', txs), 40000);

  const consolidated = calculateConsolidatedBalances(accounts, txs);
  assert.deepEqual(consolidated, { ARS: 100000, USD: 50000 });
});

test('Detección de posibles duplicados en ventana de ±2 días', () => {
  const existing: TransactionRecord[] = [
    {
      id: 'tx-1',
      user_id: 'u1',
      date: '2026-11-05',
      type: 'expense',
      account_id: 'acc-1',
      counter_account_id: null,
      category_id: 'cat-1',
      amount: 1550050,
      currency: 'ARS',
      note: 'Supermercado',
      source: 'manual',
      voided_at: null,
      created_at: 1700000000,
    },
  ];

  const dupWithin2Days = findPotentialDuplicates(
    { date: '2026-11-07', amount: 1550050, account_id: 'acc-1', currency: 'ARS' },
    existing
  );
  assert.equal(dupWithin2Days.length, 1);

  const outside2Days = findPotentialDuplicates(
    { date: '2026-11-08', amount: 1550050, account_id: 'acc-1', currency: 'ARS' },
    existing
  );
  assert.equal(outside2Days.length, 0);
});

test('Parser determinístico NLP: extrae monto, tipo, cuentas, categoría y respeta Lecciones 1 y 2 + RN-05', () => {
  const accounts = [
    { id: 'acc-santander', name: 'Santander', currency: 'ARS' as const, type: 'bank' as const, archived: 0 as const },
    { id: 'acc-mp', name: 'MercadoPago', currency: 'ARS' as const, type: 'wallet' as const, archived: 0 as const },
    { id: 'acc-ef', name: 'Efectivo', currency: 'ARS' as const, type: 'cash' as const, archived: 0 as const },
    { id: 'acc-balanz', name: 'Balanz', currency: 'USD' as const, type: 'other' as const, archived: 0 as const },
  ];

  const categories: Array<Pick<CategoryRecord, 'id' | 'name' | 'kind' | 'archived'>> = [
    { id: 'cat-super', name: 'Supermercado', kind: 'expense', archived: 0 },
    { id: 'cat-sueldo', name: 'Sueldo', kind: 'income', archived: 0 },
  ];

  // Caso 1: Gasto con formato argentino y sin fecha explícita (RN-05 marca 'date' como incierto)
  const res1 = parseMovementText(
    'gasté 15.500,50 en supermercado con Santander',
    accounts,
    categories,
    '2026-11-05'
  );
  assert.equal(res1.amount, 1550050);
  assert.equal(res1.type, 'expense');
  assert.equal(res1.currency, 'ARS');
  assert.equal(res1.account_id, 'acc-santander');
  assert.equal(res1.category_id, 'cat-super');
  assert.equal(res1.date, null);
  assert.ok(res1.uncertain_fields.includes('date'));

  // Caso 2: Transferencia en una sola fila
  const res2 = parseMovementText(
    'transferí 10000 de MercadoPago a Efectivo hoy',
    accounts,
    categories,
    '2026-11-05'
  );
  assert.equal(res2.amount, 1000000);
  assert.equal(res2.type, 'transfer');
  assert.equal(res2.account_id, 'acc-mp');
  assert.equal(res2.counter_account_id, 'acc-ef');
  assert.equal(res2.category_id, null);
  assert.equal(res2.date, '2026-11-05');
  assert.equal(res2.uncertain_fields.length, 0);

  // Caso 3: Lección 2 (limpiar porcentajes "0,000 %") + Lección 1 (no truncar "10580" a "105")
  const res3 = parseMovementText(
    'pagué 0,000 % comisión 10580 USD en Balanz ayer',
    accounts,
    categories,
    '2026-11-05'
  );
  assert.equal(res3.amount, 1058000);
  assert.equal(res3.currency, 'USD');
  assert.equal(res3.account_id, 'acc-balanz');
  assert.equal(res3.date, '2026-11-04');
});
