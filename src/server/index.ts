import type { D1Database } from '@cloudflare/workers-types';
import {
  buildClearSessionCookieHeader,
  buildSessionCookieHeader,
  parseCookies,
  SESSION_COOKIE_NAME,
  signSessionJwt,
  verifySessionJwt,
} from '../../functions/api/_crypto';
import {
  decryptSensitiveText,
  deriveUserAesKey,
  encryptSensitiveText,
} from '../shared/encryption';
import { LedgerRuleError, validateTransactionInvariants } from '../shared/ledger';
import { assertNonNegativeCents, assertPositiveCents, MoneyValidationError } from '../shared/money';
import type {
  AccountRecord,
  AccountType,
  CategoryKind,
  CategoryRecord,
  Currency,
  DraftSource,
  MovementDraftRecord,
  ParsedMovementDraft,
  TransactionRecord,
  TransactionSource,
  TransactionType,
  UserSession,
} from '../shared/types';

export interface Env {
  DB: D1Database;
  GOOGLE_CLIENT_ID?: string;
  SESSION_SECRET?: string;
  RESTRICT_TO_AR?: string;
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
}

function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

const DEFAULT_CATEGORIES: ReadonlyArray<{ name: string; kind: 'income' | 'expense' }> = [
  { name: 'Supermercado', kind: 'expense' },
  { name: 'Alimentación', kind: 'expense' },
  { name: 'Transporte', kind: 'expense' },
  { name: 'Servicios', kind: 'expense' },
  { name: 'Salud', kind: 'expense' },
  { name: 'Entretenimiento', kind: 'expense' },
  { name: 'Sueldo', kind: 'income' },
  { name: 'Honorarios', kind: 'income' },
  { name: 'Otros Ingresos', kind: 'income' },
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 0. Bloqueo geográfico opcional por subdominio (Cloudflare 'cf-ipcountry')
    if (env.RESTRICT_TO_AR === '1' || env.RESTRICT_TO_AR === 'true') {
      const country = request.headers.get('cf-ipcountry');
      if (country && country.toUpperCase() !== 'AR') {
        return new Response('Acceso restringido: Esta aplicación solo está disponible en Argentina.', {
          status: 403,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    }

    const url = new URL(request.url);
    const pathname = url.pathname;
    const isHttps = url.protocol === 'https:';

    // Rutas de API backend
    if (pathname.startsWith('/api/')) {
      const secret =
        env.SESSION_SECRET ||
        'patrimonio-contable-default-session-secret-production-32chars';

      // 1. /api/auth/google
      if (pathname === '/api/auth/google' && request.method === 'POST') {
        let body: { credential?: string };
        try {
          body = (await request.json()) as { credential?: string };
        } catch {
          return err('Cuerpo JSON inválido.', 400);
        }

        const credential = body.credential?.trim();
        if (!credential) {
          return err('Falta el token de Google (credential).', 400);
        }

        const googleRes = await fetch(
          `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`,
          { headers: { Accept: 'application/json' } }
        );

        if (!googleRes.ok) {
          return err('Token de Google inválido o expirado.', 401);
        }

        const tokenInfo = (await googleRes.json()) as {
          iss?: string;
          aud?: string;
          sub?: string;
          email?: string;
          name?: string;
          picture?: string;
        };

        const clientId =
          env.GOOGLE_CLIENT_ID ||
          '1000204276828-dfpdv7cfnske1hctbbecivnc0icqqjbf.apps.googleusercontent.com';

        if (tokenInfo.aud !== clientId) {
          return err('El token no corresponde a esta aplicación.', 401);
        }

        const user: UserSession = {
          id: tokenInfo.sub!,
          email: tokenInfo.email!,
          name: tokenInfo.name?.trim() || tokenInfo.email!.split('@')[0],
          picture: tokenInfo.picture ?? null,
        };

        if (env.DB) {
          const existingUser = await env.DB.prepare('SELECT id FROM users WHERE id = ?')
            .bind(user.id)
            .first<{ id: string }>();

          await env.DB.prepare(
            `INSERT INTO users (id, email, name, picture) VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture`
          )
            .bind(user.id, user.email, user.name, user.picture)
            .run();

          if (!existingUser) {
            const stmts = DEFAULT_CATEGORIES.map((cat) =>
              env.DB.prepare(
                'INSERT INTO categories (id, user_id, name, kind, parent_id, archived) VALUES (?, ?, ?, ?, NULL, 0)'
              ).bind(crypto.randomUUID(), user.id, cat.name, cat.kind)
            );
            await env.DB.batch(stmts);
          }
        }

        const sessionJwt = await signSessionJwt(user, secret);
        return json(
          { user },
          200,
          { 'Set-Cookie': buildSessionCookieHeader(sessionJwt, isHttps) }
        );
      }

      // 2. /api/auth/logout
      if (pathname === '/api/auth/logout' && request.method === 'POST') {
        return json({ ok: true }, 200, {
          'Set-Cookie': buildClearSessionCookieHeader(isHttps),
        });
      }

      // Middleware de autenticación para el resto de /api/*
      const cookies = parseCookies(request.headers.get('Cookie'));
      const token = cookies[SESSION_COOKIE_NAME];
      const user = token ? await verifySessionJwt(token, secret) : null;

      if (pathname === '/api/auth/me') {
        return json({ user });
      }

      if (!user) {
        return err('No autenticado. Iniciá sesión con Google para continuar.', 401);
      }

      if (!env.DB) {
        return err('Base de datos D1 no vinculada.', 500);
      }

      // Clave AES-GCM 256 derivada para este usuario autenticado
      const userAesKey = await deriveUserAesKey(user.id, user.id, secret);

      // 3. /api/accounts
      if (pathname === '/api/accounts') {
        if (request.method === 'GET') {
          const { results } = await env.DB.prepare(
            'SELECT id, user_id, name, type, currency, opening_balance, csv_column_map, archived, created_at FROM accounts WHERE user_id = ? ORDER BY created_at ASC'
          )
            .bind(user.id)
            .all<AccountRecord>();
          return json({ accounts: results });
        }

        if (request.method === 'POST') {
          const body = (await request.json()) as {
            name: string;
            type: AccountType;
            currency: Currency;
            opening_balance?: number;
          };
          const name = body.name?.trim();
          if (!name) return err('El nombre de la cuenta es obligatorio.');
          const opening = assertNonNegativeCents(body.opening_balance ?? 0, 'opening_balance');
          const id = crypto.randomUUID();
          const createdAt = Math.floor(Date.now() / 1000);

          await env.DB.prepare(
            'INSERT INTO accounts (id, user_id, name, type, currency, opening_balance, csv_column_map, archived, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)'
          )
            .bind(id, user.id, name, body.type, body.currency, opening, createdAt)
            .run();

          return json({
            account: {
              id,
              user_id: user.id,
              name,
              type: body.type,
              currency: body.currency,
              opening_balance: opening,
              csv_column_map: null,
              archived: 0,
              created_at: createdAt,
            },
          }, 201);
        }

        if (request.method === 'PATCH') {
          const body = (await request.json()) as { id: string; archived?: 0 | 1; name?: string };
          const existing = await env.DB.prepare(
            'SELECT * FROM accounts WHERE id = ? AND user_id = ?'
          )
            .bind(body.id, user.id)
            .first<AccountRecord>();
          if (!existing) return err('Cuenta no encontrada.', 404);

          const nextArchived = body.archived !== undefined ? body.archived : existing.archived;
          const nextName = body.name?.trim() || existing.name;

          await env.DB.prepare(
            'UPDATE accounts SET name = ?, archived = ? WHERE id = ? AND user_id = ?'
          )
            .bind(nextName, nextArchived, body.id, user.id)
            .run();

          return json({ account: { ...existing, name: nextName, archived: nextArchived } });
        }
      }

      // 4. /api/categories
      if (pathname === '/api/categories') {
        if (request.method === 'GET') {
          const { results } = await env.DB.prepare(
            'SELECT id, user_id, name, kind, parent_id, archived FROM categories WHERE user_id = ? ORDER BY kind ASC, name ASC'
          )
            .bind(user.id)
            .all<CategoryRecord>();
          return json({ categories: results });
        }

        if (request.method === 'POST') {
          const body = (await request.json()) as {
            name: string;
            kind: CategoryKind;
            parent_id?: string | null;
          };
          const name = body.name?.trim();
          if (!name) return err('El nombre de la categoría es obligatorio.');
          const id = crypto.randomUUID();

          await env.DB.prepare(
            'INSERT INTO categories (id, user_id, name, kind, parent_id, archived) VALUES (?, ?, ?, ?, ?, 0)'
          )
            .bind(id, user.id, name, body.kind, body.parent_id ?? null)
            .run();

          return json({
            category: {
              id,
              user_id: user.id,
              name,
              kind: body.kind,
              parent_id: body.parent_id ?? null,
              archived: 0,
            },
          }, 201);
        }
      }

      // 5. /api/transactions (Cifrado simétrico AES-GCM 256 bits para notas sensibles)
      if (pathname === '/api/transactions') {
        if (request.method === 'GET') {
          const { results } = await env.DB.prepare(
            'SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC, created_at DESC'
          )
            .bind(user.id)
            .all<TransactionRecord>();

          // Descifrar notas transparentemente con la clave AES-GCM del usuario
          const decryptedTransactions = await Promise.all(
            results.map(async (tx) => ({
              ...tx,
              note: await decryptSensitiveText(tx.note, userAesKey),
            }))
          );

          return json({ transactions: decryptedTransactions });
        }

        if (request.method === 'POST') {
          const body = (await request.json()) as {
            date: string;
            type: TransactionType;
            account_id: string;
            counter_account_id?: string | null;
            category_id?: string | null;
            amount: number;
            currency: Currency;
            note?: string | null;
            source?: TransactionSource;
          };

          const account = await env.DB.prepare(
            'SELECT * FROM accounts WHERE id = ? AND user_id = ?'
          )
            .bind(body.account_id, user.id)
            .first<AccountRecord>();
          if (!account) return err('Cuenta origen no encontrada.', 404);

          let counterAccount: AccountRecord | null = null;
          if (body.counter_account_id) {
            counterAccount = await env.DB.prepare(
              'SELECT * FROM accounts WHERE id = ? AND user_id = ?'
            )
              .bind(body.counter_account_id, user.id)
              .first<AccountRecord>();
            if (!counterAccount) return err('Cuenta destino no encontrada.', 404);
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
          } catch (e) {
            if (e instanceof LedgerRuleError || e instanceof MoneyValidationError) {
              return err(e.message, 400);
            }
            return err('Error de validación contable.', 400);
          }

          const id = crypto.randomUUID();
          const createdAt = Math.floor(Date.now() / 1000);
          const source = body.source ?? 'manual';
          const plainNote = body.note?.trim() || null;

          // Cifrar la nota con AES-GCM 256 bits antes de persistir en SQLite D1
          const encryptedNote = await encryptSensitiveText(plainNote, userAesKey);

          await env.DB.prepare(
            `INSERT INTO transactions (id, user_id, date, type, account_id, counter_account_id, category_id, amount, currency, note, source, voided_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
          )
            .bind(
              id,
              user.id,
              body.date,
              body.type,
              account.id,
              counterAccount ? counterAccount.id : null,
              categoryId,
              body.amount,
              body.currency,
              encryptedNote,
              source,
              createdAt
            )
            .run();

          return json({
            transaction: {
              id,
              user_id: user.id,
              date: body.date,
              type: body.type,
              account_id: account.id,
              counter_account_id: counterAccount ? counterAccount.id : null,
              category_id: categoryId,
              amount: body.amount,
              currency: body.currency,
              note: plainNote,
              source,
              voided_at: null,
              created_at: createdAt,
            },
          }, 201);
        }

        if (request.method === 'PATCH') {
          const body = (await request.json()) as { id: string; action: 'void' };
          const existing = await env.DB.prepare(
            'SELECT * FROM transactions WHERE id = ? AND user_id = ?'
          )
            .bind(body.id, user.id)
            .first<TransactionRecord>();
          if (!existing) return err('Movimiento no encontrado.', 404);
          if (existing.voided_at !== null) return err('El movimiento ya está anulado.');

          const voidedAt = Math.floor(Date.now() / 1000);
          await env.DB.prepare(
            'UPDATE transactions SET voided_at = ? WHERE id = ? AND user_id = ?'
          )
            .bind(voidedAt, body.id, user.id)
            .run();

          return json({
            transaction: {
              ...existing,
              note: await decryptSensitiveText(existing.note, userAesKey),
              voided_at: voidedAt,
            },
          });
        }
      }

      // 6. /api/drafts (Cifrado simétrico de raw_input de comprobantes)
      if (pathname === '/api/drafts') {
        if (request.method === 'GET') {
          const { results } = await env.DB.prepare(
            "SELECT * FROM movement_drafts WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC"
          )
            .bind(user.id)
            .all<MovementDraftRecord>();

          const decryptedDrafts = await Promise.all(
            results.map(async (draft) => ({
              ...draft,
              raw_input: await decryptSensitiveText(draft.raw_input, userAesKey),
            }))
          );

          return json({ drafts: decryptedDrafts });
        }

        if (request.method === 'POST') {
          const body = (await request.json()) as {
            source: DraftSource;
            raw_input?: string;
            parsed: ParsedMovementDraft;
          };
          const id = crypto.randomUUID();
          const createdAt = Math.floor(Date.now() / 1000);
          const rawInput = body.raw_input ?? null;
          const encryptedRawInput = await encryptSensitiveText(rawInput, userAesKey);
          const extractedJson = JSON.stringify(body.parsed);
          const uncertainJson = JSON.stringify(body.parsed.uncertain_fields);

          await env.DB.prepare(
            `INSERT INTO movement_drafts (id, user_id, source, raw_input, extracted_json, uncertain_fields, status, matched_transaction_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?)`
          )
            .bind(id, user.id, body.source, encryptedRawInput, extractedJson, uncertainJson, createdAt)
            .run();

          return json({
            draft: {
              id,
              user_id: user.id,
              source: body.source,
              raw_input: rawInput,
              extracted_json: extractedJson,
              uncertain_fields: uncertainJson,
              status: 'pending',
              matched_transaction_id: null,
              created_at: createdAt,
            },
          }, 201);
        }

        if (request.method === 'PATCH') {
          const body = (await request.json()) as {
            id: string;
            status: 'confirmed' | 'discarded';
            matched_transaction_id?: string | null;
          };
          await env.DB.prepare(
            'UPDATE movement_drafts SET status = ?, matched_transaction_id = ? WHERE id = ? AND user_id = ?'
          )
            .bind(body.status, body.matched_transaction_id ?? null, body.id, user.id)
            .run();
          return json({ ok: true });
        }
      }
    }

    // Servir assets estáticos del frontend (HTML, JS, CSS)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
