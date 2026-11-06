import type { PagesFunction } from '@cloudflare/workers-types';
import { LedgerRuleError, validateTransactionInvariants } from '../../src/shared/ledger';
import { MoneyValidationError } from '../../src/shared/money';
import type {
  AccountRecord,
  Currency,
  TransactionRecord,
  TransactionSource,
  TransactionType,
} from '../../src/shared/types';
import { errorResponse, jsonResponse, type Env, type RequestData } from './_types';

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (context) => {
  const userId = context.data.user!.id;
  const { results } = await context.env.DB.prepare(
    `SELECT id, user_id, date, type, account_id, counter_account_id, category_id, amount, currency, note, source, voided_at, created_at
     FROM transactions
     WHERE user_id = ?
     ORDER BY date DESC, created_at DESC`
  )
    .bind(userId)
    .all<TransactionRecord>();

  return jsonResponse({ transactions: results });
};

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (context) => {
  const userId = context.data.user!.id;

  let body: {
    date?: string;
    type?: TransactionType;
    account_id?: string;
    counter_account_id?: string | null;
    category_id?: string | null;
    amount?: number;
    currency?: Currency;
    note?: string | null;
    source?: TransactionSource;
  };

  try {
    body = (await context.request.json()) as typeof body;
  } catch {
    return errorResponse('Cuerpo JSON inválido.', 400);
  }

  if (!body.date || !body.type || !body.account_id || body.amount === undefined || !body.currency) {
    return errorResponse('Faltan campos obligatorios para registrar el movimiento.', 400);
  }

  const account = await context.env.DB.prepare(
    'SELECT id, user_id, name, type, currency, opening_balance, csv_column_map, archived, created_at FROM accounts WHERE id = ? AND user_id = ?'
  )
    .bind(body.account_id, userId)
    .first<AccountRecord>();

  if (!account) {
    return errorResponse('Cuenta origen no encontrada.', 404);
  }

  let counterAccount: AccountRecord | null = null;
  if (body.counter_account_id) {
    counterAccount = await context.env.DB.prepare(
      'SELECT id, user_id, name, type, currency, opening_balance, csv_column_map, archived, created_at FROM accounts WHERE id = ? AND user_id = ?'
    )
      .bind(body.counter_account_id, userId)
      .first<AccountRecord>();

    if (!counterAccount) {
      return errorResponse('Cuenta destino no encontrada.', 404);
    }
  }

  const categoryId = body.type === 'transfer' ? null : (body.category_id ?? null);

  try {
    validateTransactionInvariants({
      date: body.date,
      type: body.type,
      account,
      counterAccount,
      categoryId,
      amountCents: body.amount,
      currency: body.currency,
    });
  } catch (err) {
    if (err instanceof LedgerRuleError || err instanceof MoneyValidationError) {
      return errorResponse(err.message, 400);
    }
    return errorResponse('Error de validación contable.', 400);
  }

  const id = crypto.randomUUID();
  const createdAt = Math.floor(Date.now() / 1000);
  const source: TransactionSource = body.source ?? 'manual';
  const note = body.note?.trim() || null;

  await context.env.DB.prepare(
    `INSERT INTO transactions (id, user_id, date, type, account_id, counter_account_id, category_id, amount, currency, note, source, voided_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
  )
    .bind(
      id,
      userId,
      body.date,
      body.type,
      account.id,
      counterAccount ? counterAccount.id : null,
      categoryId,
      body.amount,
      body.currency,
      note,
      source,
      createdAt
    )
    .run();

  const transaction: TransactionRecord = {
    id,
    user_id: userId,
    date: body.date,
    type: body.type,
    account_id: account.id,
    counter_account_id: counterAccount ? counterAccount.id : null,
    category_id: categoryId,
    amount: body.amount,
    currency: body.currency,
    note,
    source,
    voided_at: null,
    created_at: createdAt,
  };

  return jsonResponse({ transaction }, 201);
};

export const onRequestPatch: PagesFunction<Env, string, RequestData> = async (context) => {
  const userId = context.data.user!.id;

  let body: { id?: string; action?: 'void'; note?: string };
  try {
    body = (await context.request.json()) as typeof body;
  } catch {
    return errorResponse('Cuerpo JSON inválido.', 400);
  }

  if (!body.id) {
    return errorResponse('Falta el id del movimiento.', 400);
  }

  const existing = await context.env.DB.prepare(
    'SELECT id, user_id, date, type, account_id, counter_account_id, category_id, amount, currency, note, source, voided_at, created_at FROM transactions WHERE id = ? AND user_id = ?'
  )
    .bind(body.id, userId)
    .first<TransactionRecord>();

  if (!existing) {
    return errorResponse('Movimiento no encontrado.', 404);
  }

  // RN-07: Anulación lógica mediante voided_at (nunca DELETE físico)
  if (body.action === 'void') {
    if (existing.voided_at !== null) {
      return errorResponse('El movimiento ya se encuentra anulado.', 400);
    }
    const voidedAt = Math.floor(Date.now() / 1000);
    await context.env.DB.prepare(
      'UPDATE transactions SET voided_at = ? WHERE id = ? AND user_id = ?'
    )
      .bind(voidedAt, body.id, userId)
      .run();

    return jsonResponse({
      transaction: { ...existing, voided_at: voidedAt },
    });
  }

  return errorResponse('Acción no soportada.', 400);
};
