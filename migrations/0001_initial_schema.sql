-- Migración Inicial: Esquema Relacional Completo (V1, V2, V3)
-- Motor: Cloudflare D1 (SQLite)
-- Reglas:
--   - Multitenant estricto por user_id
--   - Importes monetarios en centavos enteros (INTEGER)
--   - Transferencias en una sola fila (account_id -> counter_account_id)
--   - Anulación lógica mediante voided_at (nunca DELETE físico)

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, -- Google 'sub' ID único
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    picture TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- === MÓDULO V1: CONTABILIDAD CORE ===

CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('cash', 'bank', 'wallet', 'other')),
    currency TEXT NOT NULL CHECK(currency IN ('ARS', 'USD')),
    opening_balance INTEGER NOT NULL DEFAULT 0 CHECK(opening_balance >= 0),
    csv_column_map TEXT, -- JSON opcional para recordar el mapeo CSV de esta cuenta (V3)
    archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);

CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('income', 'expense')),
    parent_id TEXT REFERENCES categories(id),
    archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_categories_user ON categories(user_id);

CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL, -- YYYY-MM-DD
    type TEXT NOT NULL CHECK(type IN ('income', 'expense', 'transfer')),
    account_id TEXT NOT NULL REFERENCES accounts(id),
    counter_account_id TEXT REFERENCES accounts(id), -- Obligatorio si type = 'transfer', NULL en otros
    category_id TEXT REFERENCES categories(id), -- NULL si type = 'transfer'
    amount INTEGER NOT NULL CHECK(amount > 0), -- Siempre en centavos > 0
    currency TEXT NOT NULL CHECK(currency IN ('ARS', 'USD')),
    note TEXT,
    source TEXT NOT NULL CHECK(source IN ('manual', 'nlp', 'capture', 'import')),
    voided_at INTEGER, -- NULL = activo; timestamp = anulado
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    CHECK (
        (type = 'transfer' AND counter_account_id IS NOT NULL AND counter_account_id != account_id AND category_id IS NULL)
        OR
        (type IN ('income', 'expense') AND counter_account_id IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, date);
CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_counter_account ON transactions(counter_account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_dup_lookup ON transactions(user_id, account_id, currency, amount, voided_at);

CREATE TABLE IF NOT EXISTS movement_drafts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK(source IN ('nlp', 'capture')),
    raw_input TEXT,
    extracted_json TEXT NOT NULL,
    uncertain_fields TEXT, -- JSON array de campos que el parser no pudo asegurar
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'discarded')),
    matched_transaction_id TEXT REFERENCES transactions(id),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_movement_drafts_user ON movement_drafts(user_id, status);

-- === MÓDULO V2: INVERSIONES Y PATRIMONIO ===

CREATE TABLE IF NOT EXISTS portfolios (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    broker TEXT,
    base_currency TEXT NOT NULL CHECK(base_currency IN ('ARS', 'USD')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_portfolios_user ON portfolios(user_id);

CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    ticker TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    asset_class TEXT NOT NULL CHECK(asset_class IN ('stock', 'cedear', 'bond', 'crypto', 'fci', 'other')),
    currency TEXT NOT NULL CHECK(currency IN ('ARS', 'USD'))
);

CREATE TABLE IF NOT EXISTS holdings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(id),
    quantity REAL NOT NULL DEFAULT 0 CHECK(quantity >= 0),
    avg_cost INTEGER NOT NULL DEFAULT 0 CHECK(avg_cost >= 0), -- Centavos (>= 0 permitido)
    last_price INTEGER NOT NULL DEFAULT 0 CHECK(last_price >= 0), -- Centavos (>= 0 permitido)
    last_price_date TEXT,
    UNIQUE(portfolio_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_holdings_portfolio ON holdings(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_holdings_user ON holdings(user_id);

CREATE TABLE IF NOT EXISTS portfolio_cash (
    portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    currency TEXT NOT NULL CHECK(currency IN ('ARS', 'USD')),
    amount INTEGER NOT NULL DEFAULT 0 CHECK(amount >= 0), -- Centavos (>= 0 permitido)
    PRIMARY KEY (portfolio_id, currency)
);
CREATE INDEX IF NOT EXISTS idx_portfolio_cash_user ON portfolio_cash(user_id);

CREATE TABLE IF NOT EXISTS portfolio_snapshot_drafts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    raw_text TEXT,
    rows_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'discarded')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_portfolio_snapshot_drafts_user ON portfolio_snapshot_drafts(user_id, status);

CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(id),
    side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
    quantity REAL NOT NULL CHECK(quantity > 0),
    price INTEGER NOT NULL CHECK(price > 0), -- Centavos (> 0 obligatorio)
    fee INTEGER NOT NULL DEFAULT 0 CHECK(fee >= 0), -- Centavos (>= 0 permitido)
    date TEXT NOT NULL,
    settlement_account_id TEXT REFERENCES accounts(id), -- Solo informativo, no mueve saldo V1
    realized_gain INTEGER, -- Centavos (calculado en ventas)
    note TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_trades_portfolio ON trades(portfolio_id, date);
CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id);

CREATE TABLE IF NOT EXISTS portfolio_incomes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    asset_id TEXT REFERENCES assets(id),
    type TEXT NOT NULL CHECK(type IN ('dividend', 'interest')),
    amount INTEGER NOT NULL CHECK(amount > 0),
    currency TEXT NOT NULL CHECK(currency IN ('ARS', 'USD')),
    date TEXT NOT NULL,
    note TEXT
);
CREATE INDEX IF NOT EXISTS idx_portfolio_incomes_user ON portfolio_incomes(user_id, date);

-- === MÓDULO V3: AUTOMATIZACIÓN, PRESUPUESTOS Y ANÁLISIS ===

CREATE TABLE IF NOT EXISTS import_batches (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    filename TEXT NOT NULL,
    column_map TEXT NOT NULL, -- JSON del mapeo utilizado
    status TEXT NOT NULL DEFAULT 'staging' CHECK(status IN ('staging', 'completed', 'cancelled')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_import_batches_user ON import_batches(user_id);

CREATE TABLE IF NOT EXISTS import_rows (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
    raw_json TEXT NOT NULL,
    date TEXT,
    amount INTEGER, -- Centavos
    description TEXT,
    type_guess TEXT CHECK(type_guess IN ('income', 'expense')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'skipped')),
    duplicate_of TEXT REFERENCES transactions(id),
    matched_transaction_id TEXT REFERENCES transactions(id)
);
CREATE INDEX IF NOT EXISTS idx_import_rows_batch ON import_rows(batch_id);
CREATE INDEX IF NOT EXISTS idx_import_rows_user ON import_rows(user_id);

CREATE TABLE IF NOT EXISTS budgets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id TEXT NOT NULL REFERENCES categories(id),
    period TEXT NOT NULL, -- Formato YYYY-MM
    limit_amount INTEGER NOT NULL CHECK(limit_amount > 0),
    currency TEXT NOT NULL CHECK(currency IN ('ARS', 'USD')),
    UNIQUE(user_id, category_id, period, currency)
);
CREATE INDEX IF NOT EXISTS idx_budgets_user_period ON budgets(user_id, period);

CREATE TABLE IF NOT EXISTS savings_goals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    target_amount INTEGER NOT NULL CHECK(target_amount > 0),
    currency TEXT NOT NULL CHECK(currency IN ('ARS', 'USD')),
    target_date TEXT,
    archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_savings_goals_user ON savings_goals(user_id);

CREATE TABLE IF NOT EXISTS savings_contributions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    goal_id TEXT NOT NULL REFERENCES savings_goals(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL CHECK(amount > 0),
    date TEXT NOT NULL,
    note TEXT
);
CREATE INDEX IF NOT EXISTS idx_savings_contributions_user ON savings_contributions(user_id, goal_id);

CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('budget_exceeded', 'large_expense', 'low_balance')),
    category_id TEXT REFERENCES categories(id),
    account_id TEXT REFERENCES accounts(id),
    threshold INTEGER NOT NULL CHECK(threshold >= 0),
    currency TEXT NOT NULL CHECK(currency IN ('ARS', 'USD')),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id, active);
