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
import {
  applyTradeToHolding,
  canAutoQuoteWithYahoo,
  InvestmentRuleError,
  recalculateHoldingFromTrades,
} from '../shared/investments';
import { LedgerRuleError, validateTransactionInvariants } from '../shared/ledger';
import { assertNonNegativeCents, assertPositiveCents, MoneyValidationError, toCents } from '../shared/money';
import type {
  AccountRecord,
  AccountType,
  AssetClass,
  AssetRecord,
  CategoryKind,
  CategoryRecord,
  Currency,
  DraftSource,
  HoldingRecord,
  MovementDraftRecord,
  ParsedMovementDraft,
  ParsedPortfolioSnapshotRow,
  PortfolioCashRecord,
  PortfolioIncomeRecord,
  PortfolioIncomeType,
  PortfolioRecord,
  PortfolioSnapshotDraftRecord,
  TradeRecord,
  TradeSide,
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
      'Cache-Control': 'no-store',
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

let v2SchemaInitialized = false;

async function ensureV2Schema(db: D1Database): Promise<void> {
  if (v2SchemaInitialized) return;
  try {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS portfolios (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        broker TEXT,
        base_currency TEXT NOT NULL CHECK(base_currency IN ('ARS', 'USD')),
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_portfolios_user ON portfolios(user_id)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        ticker TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        asset_class TEXT NOT NULL CHECK(asset_class IN ('stock', 'cedear', 'bond', 'crypto', 'fci', 'other')),
        currency TEXT NOT NULL CHECK(currency IN ('ARS', 'USD'))
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS holdings (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES assets(id),
        quantity REAL NOT NULL DEFAULT 0 CHECK(quantity >= 0),
        avg_cost INTEGER NOT NULL DEFAULT 0 CHECK(avg_cost >= 0),
        last_price INTEGER NOT NULL DEFAULT 0 CHECK(last_price >= 0),
        last_price_date TEXT,
        UNIQUE(portfolio_id, asset_id)
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_holdings_portfolio ON holdings(portfolio_id)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS portfolio_cash (
        portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        currency TEXT NOT NULL CHECK(currency IN ('ARS', 'USD')),
        amount INTEGER NOT NULL DEFAULT 0 CHECK(amount >= 0),
        PRIMARY KEY (portfolio_id, currency)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS portfolio_snapshot_drafts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
        raw_text TEXT,
        rows_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'discarded')),
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES assets(id),
        side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
        quantity REAL NOT NULL CHECK(quantity > 0),
        price INTEGER NOT NULL CHECK(price > 0),
        fee INTEGER NOT NULL DEFAULT 0 CHECK(fee >= 0),
        date TEXT NOT NULL,
        settlement_account_id TEXT REFERENCES accounts(id),
        realized_gain INTEGER,
        note TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_trades_portfolio ON trades(portfolio_id, date)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS portfolio_incomes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
        asset_id TEXT REFERENCES assets(id),
        type TEXT NOT NULL CHECK(type IN ('dividend', 'interest')),
        amount INTEGER NOT NULL CHECK(amount > 0),
        currency TEXT NOT NULL CHECK(currency IN ('ARS', 'USD')),
        date TEXT NOT NULL,
        note TEXT
      )`),
    ]);
    v2SchemaInitialized = true;
  } catch {
    // Si las tablas ya existen o D1 restringe batch DDL, continúa sin romper
  }
}

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

      // Clave AES-GCM 256 derivada para este usuario autenticado (con caché en memoria por isolate)
      const userAesKey = await deriveUserAesKey(user.id, user.id, secret);

      // 2.5 /api/bootstrap (Carga consolidada V1 + V2 en 1 sola consulta batch D1 y 1 HTTP request)
      if (pathname === '/api/bootstrap' && request.method === 'GET') {
        await ensureV2Schema(env.DB);

        const [
          accountsRes,
          categoriesRes,
          transactionsRes,
          draftsRes,
          portfoliosRes,
          assetsRes,
          holdingsRes,
          cashRes,
          tradesRes,
          incomesRes,
          snapDraftsRes,
        ] = await env.DB.batch([
          env.DB.prepare(
            'SELECT id, user_id, name, type, currency, opening_balance, csv_column_map, archived, created_at FROM accounts WHERE user_id = ? ORDER BY created_at ASC'
          ).bind(user.id),
          env.DB.prepare(
            'SELECT id, user_id, name, kind, parent_id, archived FROM categories WHERE user_id = ? ORDER BY kind ASC, name ASC'
          ).bind(user.id),
          env.DB.prepare(
            'SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC, created_at DESC'
          ).bind(user.id),
          env.DB.prepare(
            "SELECT * FROM movement_drafts WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC"
          ).bind(user.id),
          env.DB.prepare('SELECT * FROM portfolios WHERE user_id = ? ORDER BY created_at ASC').bind(
            user.id
          ),
          env.DB.prepare('SELECT * FROM assets ORDER BY ticker ASC'),
          env.DB.prepare('SELECT * FROM holdings WHERE user_id = ?').bind(user.id),
          env.DB.prepare('SELECT * FROM portfolio_cash WHERE user_id = ?').bind(user.id),
          env.DB.prepare(
            'SELECT * FROM trades WHERE user_id = ? ORDER BY date DESC, created_at DESC'
          ).bind(user.id),
          env.DB.prepare('SELECT * FROM portfolio_incomes WHERE user_id = ? ORDER BY date DESC').bind(
            user.id
          ),
          env.DB.prepare(
            "SELECT * FROM portfolio_snapshot_drafts WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC"
          ).bind(user.id),
        ]);

        const [
          decryptedTransactions,
          decryptedDrafts,
          decryptedTrades,
          decryptedIncomes,
          decryptedSnapshotDrafts,
        ] = await Promise.all([
          Promise.all(
            ((transactionsRes.results as TransactionRecord[]) ?? []).map(async (tx) => ({
              ...tx,
              note: await decryptSensitiveText(tx.note, userAesKey),
            }))
          ),
          Promise.all(
            ((draftsRes.results as MovementDraftRecord[]) ?? []).map(async (draft) => ({
              ...draft,
              raw_input: await decryptSensitiveText(draft.raw_input, userAesKey),
            }))
          ),
          Promise.all(
            ((tradesRes.results as TradeRecord[]) ?? []).map(async (t) => ({
              ...t,
              note: await decryptSensitiveText(t.note, userAesKey),
            }))
          ),
          Promise.all(
            ((incomesRes.results as PortfolioIncomeRecord[]) ?? []).map(async (inc) => ({
              ...inc,
              note: await decryptSensitiveText(inc.note, userAesKey),
            }))
          ),
          Promise.all(
            ((snapDraftsRes.results as PortfolioSnapshotDraftRecord[]) ?? []).map(async (d) => ({
              ...d,
              raw_text: await decryptSensitiveText(d.raw_text, userAesKey),
            }))
          ),
        ]);

        return json({
          user,
          accounts: (accountsRes.results as AccountRecord[]) ?? [],
          categories: (categoriesRes.results as CategoryRecord[]) ?? [],
          transactions: decryptedTransactions,
          drafts: decryptedDrafts,
          portfolios: (portfoliosRes.results as PortfolioRecord[]) ?? [],
          assets: (assetsRes.results as AssetRecord[]) ?? [],
          holdings: (holdingsRes.results as HoldingRecord[]) ?? [],
          portfolioCash: (cashRes.results as PortfolioCashRecord[]) ?? [],
          trades: decryptedTrades,
          portfolioIncomes: decryptedIncomes,
          snapshotDrafts: decryptedSnapshotDrafts,
        });
      }

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

      // 7. /api/maintenance/encrypt-legacy (Cifra notas y borradores anteriores que estaban en texto plano)
      if (pathname === '/api/maintenance/encrypt-legacy' && request.method === 'POST') {
        const unencryptedTxs = await env.DB.prepare(
          "SELECT id, note FROM transactions WHERE user_id = ? AND note IS NOT NULL AND note NOT LIKE 'enc:%'"
        )
          .bind(user.id)
          .all<{ id: string; note: string }>();

        let encryptedCount = 0;
        if (unencryptedTxs.results && unencryptedTxs.results.length > 0) {
          for (const tx of unencryptedTxs.results) {
            const encNote = await encryptSensitiveText(tx.note, userAesKey);
            await env.DB.prepare(
              'UPDATE transactions SET note = ? WHERE id = ? AND user_id = ?'
            )
              .bind(encNote, tx.id, user.id)
              .run();
            encryptedCount++;
          }
        }

        const unencryptedDrafts = await env.DB.prepare(
          "SELECT id, raw_input FROM movement_drafts WHERE user_id = ? AND raw_input IS NOT NULL AND raw_input NOT LIKE 'enc:%'"
        )
          .bind(user.id)
          .all<{ id: string; raw_input: string }>();

        if (unencryptedDrafts.results && unencryptedDrafts.results.length > 0) {
          for (const draft of unencryptedDrafts.results) {
            const encInput = await encryptSensitiveText(draft.raw_input, userAesKey);
            await env.DB.prepare(
              'UPDATE movement_drafts SET raw_input = ? WHERE id = ? AND user_id = ?'
            )
              .bind(encInput, draft.id, user.id)
              .run();
            encryptedCount++;
          }
        }

        return json({ ok: true, encryptedCount });
      }

      // === MÓDULO V2: ENDPOINTS DE INVERSIONES Y PATRIMONIO ===
      await ensureV2Schema(env.DB);

      // 8. /api/investments (Snapshot completo de tablas V2 para el usuario autenticado)
      if (pathname === '/api/investments' && request.method === 'GET') {
        const [
          portfoliosRes,
          assetsRes,
          holdingsRes,
          cashRes,
          tradesRes,
          incomesRes,
          snapDraftsRes,
        ] = await Promise.all([
          env.DB.prepare('SELECT * FROM portfolios WHERE user_id = ? ORDER BY created_at ASC')
            .bind(user.id)
            .all<PortfolioRecord>(),
          env.DB.prepare('SELECT * FROM assets ORDER BY ticker ASC').all<AssetRecord>(),
          env.DB.prepare('SELECT * FROM holdings WHERE user_id = ?')
            .bind(user.id)
            .all<HoldingRecord>(),
          env.DB.prepare('SELECT * FROM portfolio_cash WHERE user_id = ?')
            .bind(user.id)
            .all<PortfolioCashRecord>(),
          env.DB.prepare('SELECT * FROM trades WHERE user_id = ? ORDER BY date DESC, created_at DESC')
            .bind(user.id)
            .all<TradeRecord>(),
          env.DB.prepare('SELECT * FROM portfolio_incomes WHERE user_id = ? ORDER BY date DESC')
            .bind(user.id)
            .all<PortfolioIncomeRecord>(),
          env.DB.prepare(
            "SELECT * FROM portfolio_snapshot_drafts WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC"
          )
            .bind(user.id)
            .all<PortfolioSnapshotDraftRecord>(),
        ]);

        const decryptedTrades = await Promise.all(
          (tradesRes.results ?? []).map(async (t) => ({
            ...t,
            note: await decryptSensitiveText(t.note, userAesKey),
          }))
        );

        const decryptedIncomes = await Promise.all(
          (incomesRes.results ?? []).map(async (inc) => ({
            ...inc,
            note: await decryptSensitiveText(inc.note, userAesKey),
          }))
        );

        const decryptedSnapshotDrafts = await Promise.all(
          (snapDraftsRes.results ?? []).map(async (d) => ({
            ...d,
            raw_text: await decryptSensitiveText(d.raw_text, userAesKey),
          }))
        );

        return json({
          portfolios: portfoliosRes.results ?? [],
          assets: assetsRes.results ?? [],
          holdings: holdingsRes.results ?? [],
          portfolioCash: cashRes.results ?? [],
          trades: decryptedTrades,
          portfolioIncomes: decryptedIncomes,
          snapshotDrafts: decryptedSnapshotDrafts,
        });
      }

      // 9. /api/portfolios (Alta, Edición y Eliminación de Carteras)
      if (pathname === '/api/portfolios') {
        if (request.method === 'POST') {
          const body = (await request.json()) as {
            name: string;
            broker?: string | null;
            base_currency: Currency;
          };
          const name = body.name?.trim();
          if (!name) return err('El nombre de la cartera es obligatorio.');
          if (body.base_currency !== 'ARS' && body.base_currency !== 'USD') {
            return err('La moneda base debe ser ARS o USD (RN-03).');
          }

          const id = crypto.randomUUID();
          const createdAt = Math.floor(Date.now() / 1000);
          const broker = body.broker?.trim() || null;

          await env.DB.batch([
            env.DB.prepare(
              'INSERT INTO portfolios (id, user_id, name, broker, base_currency, created_at) VALUES (?, ?, ?, ?, ?, ?)'
            ).bind(id, user.id, name, broker, body.base_currency, createdAt),
            env.DB.prepare(
              'INSERT INTO portfolio_cash (portfolio_id, user_id, currency, amount) VALUES (?, ?, ?, 0) ON CONFLICT(portfolio_id, currency) DO NOTHING'
            ).bind(id, user.id, body.base_currency),
          ]);

          return json(
            {
              portfolio: {
                id,
                user_id: user.id,
                name,
                broker,
                base_currency: body.base_currency,
                created_at: createdAt,
              },
            },
            201
          );
        }

        if (request.method === 'PATCH') {
          const body = (await request.json()) as {
            id: string;
            name: string;
            broker?: string | null;
            base_currency: Currency;
          };
          const existing = await env.DB.prepare(
            'SELECT * FROM portfolios WHERE id = ? AND user_id = ?'
          )
            .bind(body.id, user.id)
            .first<PortfolioRecord>();
          if (!existing) return err('Cartera no encontrada.', 404);

          const name = body.name?.trim();
          if (!name) return err('El nombre de la cartera es obligatorio.');
          const baseCurrency: Currency =
            body.base_currency === 'USD' ? 'USD' : body.base_currency === 'ARS' ? 'ARS' : existing.base_currency;
          const broker = body.broker !== undefined ? body.broker?.trim() || null : existing.broker;

          await env.DB.batch([
            env.DB.prepare(
              'UPDATE portfolios SET name = ?, broker = ?, base_currency = ? WHERE id = ? AND user_id = ?'
            ).bind(name, broker, baseCurrency, existing.id, user.id),
            env.DB.prepare(
              'INSERT INTO portfolio_cash (portfolio_id, user_id, currency, amount) VALUES (?, ?, ?, 0) ON CONFLICT(portfolio_id, currency) DO NOTHING'
            ).bind(existing.id, user.id, baseCurrency),
          ]);

          return json({
            portfolio: {
              ...existing,
              name,
              broker,
              base_currency: baseCurrency,
            },
          });
        }

        if (request.method === 'DELETE') {
          const body = (await request.json()) as { id: string };
          const existing = await env.DB.prepare(
            'SELECT * FROM portfolios WHERE id = ? AND user_id = ?'
          )
            .bind(body.id, user.id)
            .first<PortfolioRecord>();
          if (!existing) return err('Cartera no encontrada.', 404);

          await env.DB.batch([
            env.DB.prepare('DELETE FROM trades WHERE portfolio_id = ? AND user_id = ?').bind(
              existing.id,
              user.id
            ),
            env.DB.prepare('DELETE FROM holdings WHERE portfolio_id = ? AND user_id = ?').bind(
              existing.id,
              user.id
            ),
            env.DB.prepare(
              'DELETE FROM portfolio_incomes WHERE portfolio_id = ? AND user_id = ?'
            ).bind(existing.id, user.id),
            env.DB.prepare(
              'DELETE FROM portfolio_cash WHERE portfolio_id = ? AND user_id = ?'
            ).bind(existing.id, user.id),
            env.DB.prepare(
              'DELETE FROM portfolio_snapshot_drafts WHERE portfolio_id = ? AND user_id = ?'
            ).bind(existing.id, user.id),
            env.DB.prepare('DELETE FROM portfolios WHERE id = ? AND user_id = ?').bind(
              existing.id,
              user.id
            ),
          ]);

          return json({ ok: true });
        }
      }

      // 10. /api/assets (Alta, Edición y Eliminación de Activos Financieros)
      if (pathname === '/api/assets') {
        if (request.method === 'POST') {
          const body = (await request.json()) as {
            ticker: string;
            name: string;
            asset_class: AssetClass;
            currency: Currency;
          };
          const ticker = body.ticker?.trim().toUpperCase();
          const name = body.name?.trim();
          if (!ticker || !name) {
            return err('El ticker y el nombre del activo son obligatorios.');
          }

          const existing = await env.DB.prepare('SELECT * FROM assets WHERE ticker = ?')
            .bind(ticker)
            .first<AssetRecord>();
          if (existing) {
            return json({ asset: existing });
          }

          const id = crypto.randomUUID();
          await env.DB.prepare(
            'INSERT INTO assets (id, ticker, name, asset_class, currency) VALUES (?, ?, ?, ?, ?)'
          )
            .bind(id, ticker, name, body.asset_class, body.currency)
            .run();

          return json(
            {
              asset: {
                id,
                ticker,
                name,
                asset_class: body.asset_class,
                currency: body.currency,
              },
            },
            201
          );
        }

        if (request.method === 'PATCH') {
          const body = (await request.json()) as {
            id: string;
            ticker: string;
            name: string;
            asset_class: AssetClass;
            currency: Currency;
          };
          const existing = await env.DB.prepare('SELECT * FROM assets WHERE id = ?')
            .bind(body.id)
            .first<AssetRecord>();
          if (!existing) return err('Activo no encontrado.', 404);

          const ticker = body.ticker?.trim().toUpperCase();
          const name = body.name?.trim();
          if (!ticker || !name) {
            return err('El ticker y el nombre del activo son obligatorios.');
          }

          const conflict = await env.DB.prepare(
            'SELECT id FROM assets WHERE ticker = ? AND id != ?'
          )
            .bind(ticker, existing.id)
            .first<{ id: string }>();
          if (conflict) {
            return err(`Ya existe otro activo con el ticker ${ticker}.`, 400);
          }

          await env.DB.prepare(
            'UPDATE assets SET ticker = ?, name = ?, asset_class = ?, currency = ? WHERE id = ?'
          )
            .bind(ticker, name, body.asset_class, body.currency, existing.id)
            .run();

          return json({
            asset: {
              id: existing.id,
              ticker,
              name,
              asset_class: body.asset_class,
              currency: body.currency,
            },
          });
        }

        if (request.method === 'DELETE') {
          const body = (await request.json()) as { id: string };
          const existing = await env.DB.prepare('SELECT * FROM assets WHERE id = ?')
            .bind(body.id)
            .first<AssetRecord>();
          if (!existing) return err('Activo no encontrado.', 404);

          await env.DB.batch([
            env.DB.prepare('DELETE FROM trades WHERE asset_id = ? AND user_id = ?').bind(
              existing.id,
              user.id
            ),
            env.DB.prepare('DELETE FROM holdings WHERE asset_id = ? AND user_id = ?').bind(
              existing.id,
              user.id
            ),
            env.DB.prepare(
              'UPDATE portfolio_incomes SET asset_id = NULL WHERE asset_id = ? AND user_id = ?'
            ).bind(existing.id, user.id),
            env.DB.prepare('DELETE FROM assets WHERE id = ?').bind(existing.id),
          ]);

          return json({ ok: true });
        }
      }

      // 11. /api/holdings (Actualización manual de precio o eliminación de posición)
      if (pathname === '/api/holdings') {
        if (request.method === 'PATCH') {
          const body = (await request.json()) as {
            id: string;
            last_price: number;
            last_price_date?: string;
          };
          const lastPrice = assertNonNegativeCents(body.last_price, 'last_price');
          const dateStr = body.last_price_date || new Date().toISOString().slice(0, 10);

          const existing = await env.DB.prepare(
            'SELECT * FROM holdings WHERE id = ? AND user_id = ?'
          )
            .bind(body.id, user.id)
            .first<HoldingRecord>();
          if (!existing) return err('Tenencia no encontrada.', 404);

          await env.DB.prepare(
            'UPDATE holdings SET last_price = ?, last_price_date = ? WHERE id = ? AND user_id = ?'
          )
            .bind(lastPrice, dateStr, body.id, user.id)
            .run();

          return json({
            holding: {
              ...existing,
              last_price: lastPrice,
              last_price_date: dateStr,
            },
          });
        }

        if (request.method === 'DELETE') {
          const body = (await request.json()) as { id: string };
          const existing = await env.DB.prepare(
            'SELECT * FROM holdings WHERE id = ? AND user_id = ?'
          )
            .bind(body.id, user.id)
            .first<HoldingRecord>();
          if (!existing) return err('Tenencia no encontrada.', 404);

          await env.DB.batch([
            env.DB.prepare(
              'DELETE FROM trades WHERE portfolio_id = ? AND asset_id = ? AND user_id = ?'
            ).bind(existing.portfolio_id, existing.asset_id, user.id),
            env.DB.prepare('DELETE FROM holdings WHERE id = ? AND user_id = ?').bind(
              existing.id,
              user.id
            ),
          ]);

          return json({ ok: true });
        }
      }

      // 12. /api/portfolio-cash (RN-06: Efectivo líquido en el broker admite >= 0 centavos)
      if (pathname === '/api/portfolio-cash' && request.method === 'PUT') {
        const body = (await request.json()) as {
          portfolio_id: string;
          currency: Currency;
          amount: number;
        };
        const amount = assertNonNegativeCents(body.amount, 'portfolio_cash');

        const portfolio = await env.DB.prepare(
          'SELECT * FROM portfolios WHERE id = ? AND user_id = ?'
        )
          .bind(body.portfolio_id, user.id)
          .first<PortfolioRecord>();
        if (!portfolio) return err('Cartera no encontrada.', 404);

        await env.DB.prepare(
          `INSERT INTO portfolio_cash (portfolio_id, user_id, currency, amount)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(portfolio_id, currency) DO UPDATE SET amount = excluded.amount`
        )
          .bind(portfolio.id, user.id, body.currency, amount)
          .run();

        return json({
          cash: {
            portfolio_id: portfolio.id,
            user_id: user.id,
            currency: body.currency,
            amount,
          },
        });
      }

      // 13. /api/trades (RN-02: Alta, Edición y Eliminación de Compras/Ventas recalculando avg_cost y realized_gain)
      if (pathname === '/api/trades') {
        if (request.method === 'POST') {
          const body = (await request.json()) as {
            portfolio_id: string;
            asset_id: string;
            side: TradeSide;
            quantity: number;
            price: number;
            fee?: number;
            date: string;
            settlement_account_id?: string | null;
            note?: string | null;
          };

          const portfolio = await env.DB.prepare(
            'SELECT * FROM portfolios WHERE id = ? AND user_id = ?'
          )
            .bind(body.portfolio_id, user.id)
            .first<PortfolioRecord>();
          if (!portfolio) return err('Cartera no encontrada.', 404);

          const asset = await env.DB.prepare('SELECT * FROM assets WHERE id = ?')
            .bind(body.asset_id)
            .first<AssetRecord>();
          if (!asset) return err('Activo no encontrado.', 404);

          const existingHolding = await env.DB.prepare(
            'SELECT * FROM holdings WHERE portfolio_id = ? AND asset_id = ? AND user_id = ?'
          )
            .bind(portfolio.id, asset.id, user.id)
            .first<HoldingRecord>();

          let execResult;
          try {
            execResult = applyTradeToHolding({
              currentQuantity: existingHolding?.quantity ?? 0,
              currentAvgCostCents: existingHolding?.avg_cost ?? 0,
              side: body.side,
              tradeQuantity: body.quantity,
              tradePriceCents: body.price,
              feeCents: body.fee ?? 0,
            });
          } catch (e) {
            if (e instanceof InvestmentRuleError || e instanceof MoneyValidationError) {
              return err(e.message, 400);
            }
            return err('Error al procesar la operación de inversión.', 400);
          }

          const tradeId = crypto.randomUUID();
          const createdAt = Math.floor(Date.now() / 1000);
          const feeCents = assertNonNegativeCents(body.fee ?? 0, 'fee');
          const plainNote = body.note?.trim() || null;
          const encryptedNote = await encryptSensitiveText(plainNote, userAesKey);
          const holdingId = existingHolding?.id ?? crypto.randomUUID();

          await env.DB.batch([
            env.DB.prepare(
              `INSERT INTO trades (id, user_id, portfolio_id, asset_id, side, quantity, price, fee, date, settlement_account_id, realized_gain, note, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              tradeId,
              user.id,
              portfolio.id,
              asset.id,
              body.side,
              body.quantity,
              body.price,
              feeCents,
              body.date,
              body.settlement_account_id ?? null,
              execResult.realizedGainCents,
              encryptedNote,
              createdAt
            ),
            env.DB.prepare(
              `INSERT INTO holdings (id, user_id, portfolio_id, asset_id, quantity, avg_cost, last_price, last_price_date)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(portfolio_id, asset_id) DO UPDATE SET
                 quantity = excluded.quantity,
                 avg_cost = excluded.avg_cost,
                 last_price = excluded.last_price,
                 last_price_date = excluded.last_price_date`
            ).bind(
              holdingId,
              user.id,
              portfolio.id,
              asset.id,
              execResult.nextQuantity,
              execResult.nextAvgCostCents,
              body.price,
              body.date
            ),
          ]);

          return json(
            {
              trade: {
                id: tradeId,
                user_id: user.id,
                portfolio_id: portfolio.id,
                asset_id: asset.id,
                side: body.side,
                quantity: body.quantity,
                price: body.price,
                fee: feeCents,
                date: body.date,
                settlement_account_id: body.settlement_account_id ?? null,
                realized_gain: execResult.realizedGainCents,
                note: plainNote,
                created_at: createdAt,
              },
              holding: {
                id: holdingId,
                user_id: user.id,
                portfolio_id: portfolio.id,
                asset_id: asset.id,
                quantity: execResult.nextQuantity,
                avg_cost: execResult.nextAvgCostCents,
                last_price: body.price,
                last_price_date: body.date,
              },
            },
            201
          );
        }

        if (request.method === 'PATCH') {
          const body = (await request.json()) as {
            id: string;
            side: TradeSide;
            quantity: number;
            price: number;
            fee?: number;
            date: string;
            settlement_account_id?: string | null;
            note?: string | null;
          };

          const existingTrade = await env.DB.prepare(
            'SELECT * FROM trades WHERE id = ? AND user_id = ?'
          )
            .bind(body.id, user.id)
            .first<TradeRecord>();
          if (!existingTrade) return err('Operación no encontrada.', 404);

          const feeCents = assertNonNegativeCents(body.fee ?? 0, 'fee');
          const priceCents = assertPositiveCents(body.price, 'price');
          const plainNote = body.note?.trim() || null;
          const encryptedNote = await encryptSensitiveText(plainNote, userAesKey);

          const { results: pairTrades } = await env.DB.prepare(
            'SELECT * FROM trades WHERE portfolio_id = ? AND asset_id = ? AND user_id = ? ORDER BY date ASC, created_at ASC'
          )
            .bind(existingTrade.portfolio_id, existingTrade.asset_id, user.id)
            .all<TradeRecord>();

          const candidateTrades = (pairTrades ?? []).map((t) =>
            t.id === existingTrade.id
              ? {
                  ...t,
                  side: body.side,
                  quantity: body.quantity,
                  price: priceCents,
                  fee: feeCents,
                  date: body.date,
                  settlement_account_id: body.settlement_account_id ?? null,
                  note: encryptedNote,
                }
              : t
          );

          const existingHolding = await env.DB.prepare(
            'SELECT * FROM holdings WHERE portfolio_id = ? AND asset_id = ? AND user_id = ?'
          )
            .bind(existingTrade.portfolio_id, existingTrade.asset_id, user.id)
            .first<HoldingRecord>();

          let recalc;
          try {
            recalc = recalculateHoldingFromTrades(
              candidateTrades,
              existingHolding?.last_price ?? priceCents,
              existingHolding?.last_price_date ?? body.date
            );
          } catch (e) {
            if (e instanceof InvestmentRuleError || e instanceof MoneyValidationError) {
              return err(e.message, 400);
            }
            return err('No se puede aplicar este cambio porque dejaría una venta posterior sin saldo suficiente.', 400);
          }

          const stmts = recalc.updatedTrades.map((tr) =>
            env.DB.prepare(
              'UPDATE trades SET side = ?, quantity = ?, price = ?, fee = ?, date = ?, settlement_account_id = ?, realized_gain = ?, note = ? WHERE id = ? AND user_id = ?'
            ).bind(
              tr.side,
              tr.quantity,
              tr.price,
              tr.fee,
              tr.date,
              tr.settlement_account_id,
              tr.realized_gain,
              tr.note,
              tr.id,
              user.id
            )
          );

          if (existingHolding) {
            stmts.push(
              env.DB.prepare(
                'UPDATE holdings SET quantity = ?, avg_cost = ?, last_price = ?, last_price_date = ? WHERE id = ? AND user_id = ?'
              ).bind(
                recalc.quantity,
                recalc.avgCostCents,
                recalc.lastPriceCents,
                recalc.lastPriceDate,
                existingHolding.id,
                user.id
              )
            );
          }

          await env.DB.batch(stmts);
          return json({ ok: true });
        }

        if (request.method === 'DELETE') {
          const body = (await request.json()) as { id: string };
          const existingTrade = await env.DB.prepare(
            'SELECT * FROM trades WHERE id = ? AND user_id = ?'
          )
            .bind(body.id, user.id)
            .first<TradeRecord>();
          if (!existingTrade) return err('Operación no encontrada.', 404);

          const { results: pairTrades } = await env.DB.prepare(
            'SELECT * FROM trades WHERE portfolio_id = ? AND asset_id = ? AND user_id = ? ORDER BY date ASC, created_at ASC'
          )
            .bind(existingTrade.portfolio_id, existingTrade.asset_id, user.id)
            .all<TradeRecord>();

          const remainingTrades = (pairTrades ?? []).filter((t) => t.id !== existingTrade.id);

          const existingHolding = await env.DB.prepare(
            'SELECT * FROM holdings WHERE portfolio_id = ? AND asset_id = ? AND user_id = ?'
          )
            .bind(existingTrade.portfolio_id, existingTrade.asset_id, user.id)
            .first<HoldingRecord>();

          let recalc;
          try {
            recalc = recalculateHoldingFromTrades(
              remainingTrades,
              existingHolding?.last_price ?? 0,
              existingHolding?.last_price_date ?? null
            );
          } catch (e) {
            if (e instanceof InvestmentRuleError || e instanceof MoneyValidationError) {
              return err(
                `No se puede eliminar esta compra porque existe una venta posterior que depende de estas unidades (${e.message}). Eliminá primero la venta posterior.`,
                400
              );
            }
            return err('No se puede eliminar esta operación por consistencia de cartera.', 400);
          }

          const stmts = [
            env.DB.prepare('DELETE FROM trades WHERE id = ? AND user_id = ?').bind(
              existingTrade.id,
              user.id
            ),
            ...recalc.updatedTrades.map((tr) =>
              env.DB.prepare(
                'UPDATE trades SET realized_gain = ? WHERE id = ? AND user_id = ?'
              ).bind(tr.realized_gain, tr.id, user.id)
            ),
          ];

          if (existingHolding) {
            if (remainingTrades.length === 0) {
              stmts.push(
                env.DB.prepare('DELETE FROM holdings WHERE id = ? AND user_id = ?').bind(
                  existingHolding.id,
                  user.id
                )
              );
            } else {
              stmts.push(
                env.DB.prepare(
                  'UPDATE holdings SET quantity = ?, avg_cost = ?, last_price = ?, last_price_date = ? WHERE id = ? AND user_id = ?'
                ).bind(
                  recalc.quantity,
                  recalc.avgCostCents,
                  recalc.lastPriceCents,
                  recalc.lastPriceDate,
                  existingHolding.id,
                  user.id
                )
              );
            }
          }

          await env.DB.batch(stmts);
          return json({ ok: true });
        }
      }

      // 14. /api/portfolio-incomes (Dividendos e intereses de cartera)
      if (pathname === '/api/portfolio-incomes') {
        if (request.method === 'DELETE') {
          const body = (await request.json()) as { id: string };
          await env.DB.prepare('DELETE FROM portfolio_incomes WHERE id = ? AND user_id = ?')
            .bind(body.id, user.id)
            .run();
          return json({ ok: true });
        }
      }
      if (pathname === '/api/portfolio-incomes' && request.method === 'POST') {
        const body = (await request.json()) as {
          portfolio_id: string;
          asset_id?: string | null;
          type: PortfolioIncomeType;
          amount: number;
          currency: Currency;
          date: string;
          note?: string | null;
        };

        const amount = assertPositiveCents(body.amount, 'amount');
        const id = crypto.randomUUID();
        const plainNote = body.note?.trim() || null;
        const encryptedNote = await encryptSensitiveText(plainNote, userAesKey);

        await env.DB.prepare(
          `INSERT INTO portfolio_incomes (id, user_id, portfolio_id, asset_id, type, amount, currency, date, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            id,
            user.id,
            body.portfolio_id,
            body.asset_id ?? null,
            body.type,
            amount,
            body.currency,
            body.date,
            encryptedNote
          )
          .run();

        return json(
          {
            income: {
              id,
              user_id: user.id,
              portfolio_id: body.portfolio_id,
              asset_id: body.asset_id ?? null,
              type: body.type,
              amount,
              currency: body.currency,
              date: body.date,
              note: plainNote,
            },
          },
          201
        );
      }

      // 15. /api/portfolio-snapshot-drafts (RN-04: Staging obligatorio para capturas de cartera)
      if (pathname === '/api/portfolio-snapshot-drafts') {
        if (request.method === 'POST') {
          const body = (await request.json()) as {
            portfolio_id: string;
            raw_text?: string | null;
            rows: ParsedPortfolioSnapshotRow[];
          };
          const id = crypto.randomUUID();
          const createdAt = Math.floor(Date.now() / 1000);
          const rawText = body.raw_text ?? null;
          const encryptedRawText = await encryptSensitiveText(rawText, userAesKey);
          const rowsJson = JSON.stringify(body.rows);

          await env.DB.prepare(
            `INSERT INTO portfolio_snapshot_drafts (id, user_id, portfolio_id, raw_text, rows_json, status, created_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?)`
          )
            .bind(id, user.id, body.portfolio_id, encryptedRawText, rowsJson, createdAt)
            .run();

          return json(
            {
              draft: {
                id,
                user_id: user.id,
                portfolio_id: body.portfolio_id,
                raw_text: rawText,
                rows_json: rowsJson,
                status: 'pending',
                created_at: createdAt,
              },
            },
            201
          );
        }

        if (request.method === 'PATCH') {
          const body = (await request.json()) as {
            id: string;
            action: 'confirm' | 'discard';
            portfolio_id?: string;
            rows?: Array<{
              ticker: string;
              asset_name: string;
              asset_class: AssetClass;
              quantity: number;
              avg_cost: number;
              last_price: number;
            }>;
          };

          if (body.action === 'discard') {
            await env.DB.prepare(
              "UPDATE portfolio_snapshot_drafts SET status = 'discarded' WHERE id = ? AND user_id = ?"
            )
              .bind(body.id, user.id)
              .run();
            return json({ ok: true });
          }

          const portfolio = await env.DB.prepare(
            'SELECT * FROM portfolios WHERE id = ? AND user_id = ?'
          )
            .bind(body.portfolio_id ?? '', user.id)
            .first<PortfolioRecord>();
          if (!portfolio) return err('Cartera destino no encontrada.', 404);

          const today = new Date().toISOString().slice(0, 10);

          for (const row of body.rows ?? []) {
            const ticker = row.ticker.trim().toUpperCase();
            if (!ticker || row.quantity < 0) continue;
            const avgCost = assertNonNegativeCents(row.avg_cost, 'avg_cost');
            const lastPrice = assertNonNegativeCents(row.last_price, 'last_price');

            let asset = await env.DB.prepare('SELECT * FROM assets WHERE ticker = ?')
              .bind(ticker)
              .first<AssetRecord>();

            if (!asset) {
              const newAssetId = crypto.randomUUID();
              await env.DB.prepare(
                'INSERT INTO assets (id, ticker, name, asset_class, currency) VALUES (?, ?, ?, ?, ?)'
              )
                .bind(
                  newAssetId,
                  ticker,
                  row.asset_name.trim() || `Activo ${ticker}`,
                  row.asset_class,
                  portfolio.base_currency
                )
                .run();
              asset = {
                id: newAssetId,
                ticker,
                name: row.asset_name.trim() || `Activo ${ticker}`,
                asset_class: row.asset_class,
                currency: portfolio.base_currency,
              };
            }

            await env.DB.prepare(
              `INSERT INTO holdings (id, user_id, portfolio_id, asset_id, quantity, avg_cost, last_price, last_price_date)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(portfolio_id, asset_id) DO UPDATE SET
                 quantity = excluded.quantity,
                 avg_cost = excluded.avg_cost,
                 last_price = excluded.last_price,
                 last_price_date = excluded.last_price_date`
            )
              .bind(
                crypto.randomUUID(),
                user.id,
                portfolio.id,
                asset.id,
                row.quantity,
                avgCost,
                lastPrice,
                today
              )
              .run();
          }

          await env.DB.prepare(
            "UPDATE portfolio_snapshot_drafts SET status = 'confirmed' WHERE id = ? AND user_id = ?"
          )
            .bind(body.id, user.id)
            .run();

          return json({ ok: true });
        }
      }

      // 16. /api/quotes/yahoo (Cotizaciones externas solo para activos en USD, prohibido CEDEARs/ARS)
      if (pathname === '/api/quotes/yahoo' && request.method === 'POST') {
        const body = (await request.json()) as { holding_ids?: string[] };
        const { results: holdings } = await env.DB.prepare(
          'SELECT * FROM holdings WHERE user_id = ? AND quantity > 0'
        )
          .bind(user.id)
          .all<HoldingRecord>();

        const { results: assets } = await env.DB.prepare('SELECT * FROM assets').all<AssetRecord>();
        const assetMap = new Map((assets ?? []).map((a) => [a.id, a]));
        const today = new Date().toISOString().slice(0, 10);

        const updatedHoldings: HoldingRecord[] = [];
        const skippedReasons: string[] = [];

        for (const h of holdings ?? []) {
          if (body.holding_ids && !body.holding_ids.includes(h.id)) continue;
          const asset = assetMap.get(h.asset_id);
          if (!asset) continue;

          if (!canAutoQuoteWithYahoo(asset)) {
            skippedReasons.push(
              `${asset.ticker} (${asset.currency}): Cotización manual (CEDEAR / ARS sujeto a ratio y CCL).`
            );
            continue;
          }

          try {
            const endpoints = [
              `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
                asset.ticker
              )}?interval=1d&range=1d`,
              `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
                asset.ticker
              )}?interval=1d&range=1d`,
            ];

            let marketPrice: number | undefined;
            for (const yahooUrl of endpoints) {
              const yRes = await fetch(yahooUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (compatible; PatrimonioContable/2.0)',
                  Accept: 'application/json',
                },
              });
              if (!yRes.ok) continue;

              const yData = (await yRes.json()) as {
                chart?: {
                  result?: Array<{
                    meta?: { regularMarketPrice?: number };
                  }>;
                };
              };
              const candidate = yData.chart?.result?.[0]?.meta?.regularMarketPrice;
              if (typeof candidate === 'number' && candidate > 0) {
                marketPrice = candidate;
                break;
              }
            }

            if (typeof marketPrice === 'number' && marketPrice > 0) {
              const priceCents = toCents(marketPrice);
              await env.DB.prepare(
                'UPDATE holdings SET last_price = ?, last_price_date = ? WHERE id = ? AND user_id = ?'
              )
                .bind(priceCents, today, h.id, user.id)
                .run();
              updatedHoldings.push({
                ...h,
                last_price: priceCents,
                last_price_date: today,
              });
            }
          } catch {
            // Si Yahoo Finance no responde para un ticker puntual, continúa con el siguiente
          }
        }

        return json({ updatedHoldings, skippedReasons });
      }
    }

    // Servir assets estáticos del frontend (HTML, JS, CSS)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
