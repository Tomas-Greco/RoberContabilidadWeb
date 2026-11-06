import type { PagesFunction } from '@cloudflare/workers-types';
import { assertNonNegativeCents, MoneyValidationError } from '../../src/shared/money';
import type { AccountRecord, AccountType, Currency } from '../../src/shared/types';
import { errorResponse, jsonResponse, type Env, type RequestData } from './_types';

const VALID_ACCOUNT_TYPES = new Set<AccountType>(['cash', 'bank', 'wallet', 'other']);
const VALID_CURRENCIES = new Set<Currency>(['ARS', 'USD']);

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (context) => {
  const userId = context.data.user!.id;
  const { results } = await context.env.DB.prepare(
    'SELECT id, user_id, name, type, currency, opening_balance, csv_column_map, archived, created_at FROM accounts WHERE user_id = ? ORDER BY created_at ASC'
  )
    .bind(userId)
    .all<AccountRecord>();

  return jsonResponse({ accounts: results });
};

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (context) => {
  const userId = context.data.user!.id;

  let body: {
    name?: string;
    type?: AccountType;
    currency?: Currency;
    opening_balance?: number;
  };

  try {
    body = (await context.request.json()) as typeof body;
  } catch {
    return errorResponse('Cuerpo JSON inválido.', 400);
  }

  const name = body.name?.trim();
  if (!name) {
    return errorResponse('El nombre de la cuenta es obligatorio.', 400);
  }

  if (!body.type || !VALID_ACCOUNT_TYPES.has(body.type)) {
    return errorResponse('Tipo de cuenta inválido.', 400);
  }

  if (!body.currency || !VALID_CURRENCIES.has(body.currency)) {
    return errorResponse('Moneda inválida. Debe ser ARS o USD.', 400);
  }

  let openingBalance = 0;
  try {
    openingBalance = assertNonNegativeCents(body.opening_balance ?? 0, 'opening_balance');
  } catch (err) {
    const msg = err instanceof MoneyValidationError ? err.message : 'Saldo inicial inválido.';
    return errorResponse(msg, 400);
  }

  const id = crypto.randomUUID();
  const createdAt = Math.floor(Date.now() / 1000);

  await context.env.DB.prepare(
    'INSERT INTO accounts (id, user_id, name, type, currency, opening_balance, csv_column_map, archived, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)'
  )
    .bind(id, userId, name, body.type, body.currency, openingBalance, createdAt)
    .run();

  const account: AccountRecord = {
    id,
    user_id: userId,
    name,
    type: body.type,
    currency: body.currency,
    opening_balance: openingBalance,
    csv_column_map: null,
    archived: 0,
    created_at: createdAt,
  };

  return jsonResponse({ account }, 201);
};

export const onRequestPatch: PagesFunction<Env, string, RequestData> = async (context) => {
  const userId = context.data.user!.id;

  let body: { id?: string; name?: string; archived?: 0 | 1 };
  try {
    body = (await context.request.json()) as typeof body;
  } catch {
    return errorResponse('Cuerpo JSON inválido.', 400);
  }

  if (!body.id) {
    return errorResponse('Falta el id de la cuenta.', 400);
  }

  const existing = await context.env.DB.prepare(
    'SELECT id, user_id, name, type, currency, opening_balance, csv_column_map, archived, created_at FROM accounts WHERE id = ? AND user_id = ?'
  )
    .bind(body.id, userId)
    .first<AccountRecord>();

  if (!existing) {
    return errorResponse('Cuenta no encontrada.', 404);
  }

  const nextName = body.name?.trim() || existing.name;
  const nextArchived: 0 | 1 = body.archived === 1 ? 1 : body.archived === 0 ? 0 : existing.archived;

  await context.env.DB.prepare(
    'UPDATE accounts SET name = ?, archived = ? WHERE id = ? AND user_id = ?'
  )
    .bind(nextName, nextArchived, body.id, userId)
    .run();

  return jsonResponse({
    account: { ...existing, name: nextName, archived: nextArchived },
  });
};
