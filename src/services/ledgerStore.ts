import {
  applyTradeToHolding,
  canAutoQuoteWithYahoo,
  recalculateHoldingFromTrades,
} from '../shared/investments';
import { validateTransactionInvariants } from '../shared/ledger';
import { assertNonNegativeCents, assertPositiveCents } from '../shared/money';
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

const LOCAL_STORAGE_KEY = 'patrimonio_local_d1_v2';

interface LocalDbState {
  user: UserSession | null;
  accounts: AccountRecord[];
  categories: CategoryRecord[];
  transactions: TransactionRecord[];
  drafts: MovementDraftRecord[];
  // Módulo V2: Inversiones y Patrimonio
  portfolios: PortfolioRecord[];
  assets: AssetRecord[];
  holdings: HoldingRecord[];
  portfolioCash: PortfolioCashRecord[];
  trades: TradeRecord[];
  portfolioIncomes: PortfolioIncomeRecord[];
  snapshotDrafts: PortfolioSnapshotDraftRecord[];
}

function getTodayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDaysIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function createSeedState(user: UserSession): LocalDbState {
  const now = Math.floor(Date.now() / 1000);
  const uid = user.id;

  const accounts: AccountRecord[] = [
    {
      id: 'acc-santander',
      user_id: uid,
      name: 'Santander',
      type: 'bank',
      currency: 'ARS',
      opening_balance: 45000000, // $450.000,00
      csv_column_map: null,
      archived: 0,
      created_at: now - 86400 * 10,
    },
    {
      id: 'acc-mp',
      user_id: uid,
      name: 'MercadoPago',
      type: 'wallet',
      currency: 'ARS',
      opening_balance: 12500000, // $125.000,00
      csv_column_map: null,
      archived: 0,
      created_at: now - 86400 * 9,
    },
    {
      id: 'acc-efectivo',
      user_id: uid,
      name: 'Efectivo',
      type: 'cash',
      currency: 'ARS',
      opening_balance: 3800000, // $38.000,00
      csv_column_map: null,
      archived: 0,
      created_at: now - 86400 * 8,
    },
    {
      id: 'acc-caja-usd',
      user_id: uid,
      name: 'Caja USD',
      type: 'bank',
      currency: 'USD',
      opening_balance: 240000, // USD 2,400.00
      csv_column_map: null,
      archived: 0,
      created_at: now - 86400 * 7,
    },
  ];

  const categories: CategoryRecord[] = [
    { id: 'cat-super', user_id: uid, name: 'Supermercado', kind: 'expense', parent_id: null, archived: 0 },
    { id: 'cat-alim', user_id: uid, name: 'Alimentación', kind: 'expense', parent_id: null, archived: 0 },
    { id: 'cat-transp', user_id: uid, name: 'Transporte', kind: 'expense', parent_id: null, archived: 0 },
    { id: 'cat-serv', user_id: uid, name: 'Servicios', kind: 'expense', parent_id: null, archived: 0 },
    { id: 'cat-salud', user_id: uid, name: 'Salud', kind: 'expense', parent_id: null, archived: 0 },
    { id: 'cat-sueldo', user_id: uid, name: 'Sueldo', kind: 'income', parent_id: null, archived: 0 },
    { id: 'cat-hon', user_id: uid, name: 'Honorarios', kind: 'income', parent_id: null, archived: 0 },
  ];

  const transactions: TransactionRecord[] = [
    {
      id: 'tx-seed-1',
      user_id: uid,
      date: shiftDaysIso(-3),
      type: 'income',
      account_id: 'acc-santander',
      counter_account_id: null,
      category_id: 'cat-sueldo',
      amount: 125000000, // $1.250.000,00
      currency: 'ARS',
      note: 'Acreditación de haberes mensual',
      source: 'manual',
      voided_at: null,
      created_at: now - 86400 * 3,
    },
    {
      id: 'tx-seed-2',
      user_id: uid,
      date: shiftDaysIso(-2),
      type: 'transfer',
      account_id: 'acc-santander',
      counter_account_id: 'acc-mp',
      category_id: null,
      amount: 18000000, // $180.000,00
      currency: 'ARS',
      note: 'Fondeo billetera para gastos diarios',
      source: 'manual',
      voided_at: null,
      created_at: now - 86400 * 2,
    },
    {
      id: 'tx-seed-3',
      user_id: uid,
      date: shiftDaysIso(-1),
      type: 'expense',
      account_id: 'acc-mp',
      counter_account_id: null,
      category_id: 'cat-super',
      amount: 6425050, // $64.250,50
      currency: 'ARS',
      note: 'Compra semanal supermercado',
      source: 'nlp',
      voided_at: null,
      created_at: now - 86400,
    },
    {
      id: 'tx-seed-4',
      user_id: uid,
      date: getTodayIso(),
      type: 'income',
      account_id: 'acc-caja-usd',
      counter_account_id: null,
      category_id: 'cat-hon',
      amount: 85000, // USD 850.00
      currency: 'USD',
      note: 'Consultoría arquitectura cloud',
      source: 'manual',
      voided_at: null,
      created_at: now - 3600,
    },
  ];

  // Datos iniciales de Módulo V2: Inversiones y Patrimonio
  const portfolios: PortfolioRecord[] = [
    {
      id: 'port-iol-ars',
      user_id: uid,
      name: 'Cartera Local CEDEARs',
      broker: 'InvertirOnline (IOL)',
      base_currency: 'ARS',
      created_at: now - 86400 * 15,
    },
    {
      id: 'port-ibkr-usd',
      user_id: uid,
      name: 'Cartera Global ETFs',
      broker: 'Interactive Brokers',
      base_currency: 'USD',
      created_at: now - 86400 * 14,
    },
  ];

  const assets: AssetRecord[] = [
    {
      id: 'asset-aapl-cedear',
      ticker: 'AAPL.BA',
      name: 'Apple Inc. CEDEAR',
      asset_class: 'cedear',
      currency: 'ARS',
    },
    {
      id: 'asset-al30',
      ticker: 'AL30',
      name: 'Bono Rep. Argentina Step Up 2030',
      asset_class: 'bond',
      currency: 'ARS',
    },
    {
      id: 'asset-spy-usd',
      ticker: 'SPY',
      name: 'SPDR S&P 500 ETF Trust',
      asset_class: 'stock',
      currency: 'USD',
    },
    {
      id: 'asset-msft-usd',
      ticker: 'MSFT',
      name: 'Microsoft Corporation',
      asset_class: 'stock',
      currency: 'USD',
    },
  ];

  const holdings: HoldingRecord[] = [
    {
      id: 'hold-aapl-ars',
      user_id: uid,
      portfolio_id: 'port-iol-ars',
      asset_id: 'asset-aapl-cedear',
      quantity: 25,
      avg_cost: 1850000, // $18.500,00
      last_price: 2140000, // $21.400,00 -> Valuación $535.000,00
      last_price_date: getTodayIso(),
    },
    {
      id: 'hold-al30-ars',
      user_id: uid,
      portfolio_id: 'port-iol-ars',
      asset_id: 'asset-al30',
      quantity: 400,
      avg_cost: 68500, // $685,00
      last_price: 76200, // $762,00 -> Valuación $304.800,00
      last_price_date: getTodayIso(),
    },
    {
      id: 'hold-spy-usd',
      user_id: uid,
      portfolio_id: 'port-ibkr-usd',
      asset_id: 'asset-spy-usd',
      quantity: 4,
      avg_cost: 51000, // USD 510.00
      last_price: 58250, // USD 582.50 -> Valuación USD 2,330.00
      last_price_date: getTodayIso(),
    },
    {
      id: 'hold-msft-usd',
      user_id: uid,
      portfolio_id: 'port-ibkr-usd',
      asset_id: 'asset-msft-usd',
      quantity: 3,
      avg_cost: 40500, // USD 405.00
      last_price: 42800, // USD 428.00 -> Valuación USD 1,284.00
      last_price_date: getTodayIso(),
    },
  ];

  const portfolioCash: PortfolioCashRecord[] = [
    {
      portfolio_id: 'port-iol-ars',
      user_id: uid,
      currency: 'ARS',
      amount: 8500000, // $85.000,00 líquido en IOL
    },
    {
      portfolio_id: 'port-ibkr-usd',
      user_id: uid,
      currency: 'USD',
      amount: 34000, // USD 340.00 líquido en IBKR
    },
  ];

  const trades: TradeRecord[] = [
    {
      id: 'tr-seed-1',
      user_id: uid,
      portfolio_id: 'port-iol-ars',
      asset_id: 'asset-aapl-cedear',
      side: 'buy',
      quantity: 25,
      price: 1840000,
      fee: 250000,
      date: shiftDaysIso(-12),
      settlement_account_id: 'acc-santander',
      realized_gain: null,
      note: 'Compra inicial CEDEAR Apple',
      created_at: now - 86400 * 12,
    },
    {
      id: 'tr-seed-2',
      user_id: uid,
      portfolio_id: 'port-ibkr-usd',
      asset_id: 'asset-spy-usd',
      side: 'buy',
      quantity: 4,
      price: 51000,
      fee: 0,
      date: shiftDaysIso(-10),
      settlement_account_id: 'acc-caja-usd',
      realized_gain: null,
      note: 'Posición core S&P 500',
      created_at: now - 86400 * 10,
    },
    {
      id: 'tr-seed-3',
      user_id: uid,
      portfolio_id: 'port-iol-ars',
      asset_id: 'asset-al30',
      side: 'buy',
      quantity: 400,
      price: 68500,
      fee: 0,
      date: shiftDaysIso(-8),
      settlement_account_id: 'acc-santander',
      realized_gain: null,
      note: 'Compra Bono Soberano AL30',
      created_at: now - 86400 * 8,
    },
    {
      id: 'tr-seed-4',
      user_id: uid,
      portfolio_id: 'port-ibkr-usd',
      asset_id: 'asset-msft-usd',
      side: 'buy',
      quantity: 3,
      price: 40500,
      fee: 0,
      date: shiftDaysIso(-6),
      settlement_account_id: 'acc-caja-usd',
      realized_gain: null,
      note: 'Compra acciones Microsoft',
      created_at: now - 86400 * 6,
    },
  ];

  const portfolioIncomes: PortfolioIncomeRecord[] = [
    {
      id: 'inc-seed-1',
      user_id: uid,
      portfolio_id: 'port-ibkr-usd',
      asset_id: 'asset-spy-usd',
      type: 'dividend',
      amount: 685, // USD 6.85
      currency: 'USD',
      date: shiftDaysIso(-5),
      note: 'Dividendo trimestral SPY',
    },
    {
      id: 'inc-seed-2',
      user_id: uid,
      portfolio_id: 'port-iol-ars',
      asset_id: 'asset-al30',
      type: 'interest',
      amount: 1620000, // $16.200,00
      currency: 'ARS',
      date: shiftDaysIso(-4),
      note: 'Cupón renta bono soberano',
    },
  ];

  return {
    user,
    accounts,
    categories,
    transactions,
    drafts: [],
    portfolios,
    assets,
    holdings,
    portfolioCash,
    trades,
    portfolioIncomes,
    snapshotDrafts: [],
  };
}

function ensureCompleteLocalState(partial: Partial<LocalDbState>, fallbackUser: UserSession): LocalDbState {
  const seed = createSeedState(fallbackUser);
  return {
    user: partial.user ?? fallbackUser,
    accounts: partial.accounts ?? seed.accounts,
    categories: partial.categories ?? seed.categories,
    transactions: partial.transactions ?? seed.transactions,
    drafts: partial.drafts ?? [],
    portfolios: partial.portfolios ?? seed.portfolios,
    assets: partial.assets ?? seed.assets,
    holdings: partial.holdings ?? seed.holdings,
    portfolioCash: partial.portfolioCash ?? seed.portfolioCash,
    trades: partial.trades ?? seed.trades,
    portfolioIncomes: partial.portfolioIncomes ?? seed.portfolioIncomes,
    snapshotDrafts: partial.snapshotDrafts ?? [],
  };
}

function readLocalState(): LocalDbState | null {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalDbState>;
    if (!parsed.user) return null;
    return ensureCompleteLocalState(parsed, parsed.user);
  } catch {
    return null;
  }
}

function writeLocalState(state: LocalDbState): void {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state));
}

type ApiFetchResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'error'; status: number; error: string }
  | { kind: 'fallback' };

let isLocalFallbackMode = false;

async function tryApiFetch<T>(url: string, init?: RequestInit): Promise<ApiFetchResult<T>> {
  if (isLocalFallbackMode) {
    return { kind: 'fallback' };
  }

  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      isLocalFallbackMode = true;
      return { kind: 'fallback' };
    }

    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) {
      return { kind: 'error', status: res.status, error: data.error ?? 'Error en el servidor.' };
    }
    return { kind: 'ok', data };
  } catch {
    isLocalFallbackMode = true;
    return { kind: 'fallback' };
  }
}

export interface LedgerSnapshot {
  user: UserSession | null;
  accounts: AccountRecord[];
  categories: CategoryRecord[];
  transactions: TransactionRecord[];
  drafts: MovementDraftRecord[];
  portfolios: PortfolioRecord[];
  assets: AssetRecord[];
  holdings: HoldingRecord[];
  portfolioCash: PortfolioCashRecord[];
  trades: TradeRecord[];
  portfolioIncomes: PortfolioIncomeRecord[];
  snapshotDrafts: PortfolioSnapshotDraftRecord[];
}

const EMPTY_SNAPSHOT: LedgerSnapshot = {
  user: null,
  accounts: [],
  categories: [],
  transactions: [],
  drafts: [],
  portfolios: [],
  assets: [],
  holdings: [],
  portfolioCash: [],
  trades: [],
  portfolioIncomes: [],
  snapshotDrafts: [],
};

export const ledgerStore = {
  async loadAll(): Promise<LedgerSnapshot> {
    const bootRes = await tryApiFetch<LedgerSnapshot>('/api/bootstrap');
    if (bootRes.kind === 'ok' && bootRes.data.user) {
      return bootRes.data;
    }
    if (bootRes.kind === 'error' && bootRes.status === 401) {
      return EMPTY_SNAPSHOT;
    }

    const meRes = await tryApiFetch<{ user: UserSession | null }>('/api/auth/me');
    if (meRes.kind === 'fallback') {
      const local = readLocalState();
      if (!local || !local.user) {
        return EMPTY_SNAPSHOT;
      }
      return local;
    }

    if (meRes.kind !== 'ok' || !meRes.data.user) {
      return EMPTY_SNAPSHOT;
    }

    const [accRes, catRes, txRes, draftRes, invRes] = await Promise.all([
      tryApiFetch<{ accounts: AccountRecord[] }>('/api/accounts'),
      tryApiFetch<{ categories: CategoryRecord[] }>('/api/categories'),
      tryApiFetch<{ transactions: TransactionRecord[] }>('/api/transactions'),
      tryApiFetch<{ drafts: MovementDraftRecord[] }>('/api/drafts'),
      tryApiFetch<{
        portfolios: PortfolioRecord[];
        assets: AssetRecord[];
        holdings: HoldingRecord[];
        portfolioCash: PortfolioCashRecord[];
        trades: TradeRecord[];
        portfolioIncomes: PortfolioIncomeRecord[];
        snapshotDrafts: PortfolioSnapshotDraftRecord[];
      }>('/api/investments'),
    ]);

    return {
      user: meRes.data.user,
      accounts: accRes.kind === 'ok' ? accRes.data.accounts : [],
      categories: catRes.kind === 'ok' ? catRes.data.categories : [],
      transactions: txRes.kind === 'ok' ? txRes.data.transactions : [],
      drafts: draftRes.kind === 'ok' ? draftRes.data.drafts : [],
      portfolios: invRes.kind === 'ok' ? invRes.data.portfolios : [],
      assets: invRes.kind === 'ok' ? invRes.data.assets : [],
      holdings: invRes.kind === 'ok' ? invRes.data.holdings : [],
      portfolioCash: invRes.kind === 'ok' ? invRes.data.portfolioCash : [],
      trades: invRes.kind === 'ok' ? invRes.data.trades : [],
      portfolioIncomes: invRes.kind === 'ok' ? invRes.data.portfolioIncomes : [],
      snapshotDrafts: invRes.kind === 'ok' ? invRes.data.snapshotDrafts : [],
    };
  },

  async loginWithGoogleCredential(credential: string): Promise<UserSession> {
    const res = await tryApiFetch<{ user: UserSession }>('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ credential }),
    });

    if (res.kind === 'fallback') {
      const payloadPart = credential.split('.')[1];
      const decoded = JSON.parse(atob(payloadPart.replace(/-/g, '+').replace(/_/g, '/'))) as {
        sub: string;
        email: string;
        name?: string;
        picture?: string;
      };
      const user: UserSession = {
        id: decoded.sub,
        email: decoded.email,
        name: decoded.name ?? decoded.email.split('@')[0],
        picture: decoded.picture ?? null,
      };
      const existing = readLocalState();
      if (existing && existing.user?.id === user.id) {
        writeLocalState({ ...existing, user });
      } else {
        writeLocalState(createSeedState(user));
      }
      return user;
    }

    if (res.kind === 'error') {
      throw new Error(res.error);
    }
    return res.data.user;
  },

  async loginDemoPreview(): Promise<UserSession> {
    const demoUser: UserSession = {
      id: 'google-sub-demo-1001',
      email: 'usuario.demo@patrimonio.app',
      name: 'Tomás Greco',
      picture: null,
    };
    const existing = readLocalState();
    if (existing && existing.user?.id === demoUser.id) {
      writeLocalState({ ...existing, user: demoUser });
    } else {
      writeLocalState(createSeedState(demoUser));
    }
    return demoUser;
  },

  async logout(): Promise<void> {
    const res = await tryApiFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
    if (res.kind === 'fallback') {
      const existing = readLocalState();
      if (existing) {
        writeLocalState({ ...existing, user: null });
      }
    }
  },

  async createAccount(input: {
    name: string;
    type: AccountType;
    currency: Currency;
    opening_balance: number;
  }): Promise<AccountRecord> {
    const openingCents = assertNonNegativeCents(input.opening_balance, 'opening_balance');
    const res = await tryApiFetch<{ account: AccountRecord }>('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({ ...input, opening_balance: openingCents }),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) throw new Error('Sesión no iniciada.');
      const account: AccountRecord = {
        id: crypto.randomUUID(),
        user_id: state.user.id,
        name: input.name.trim(),
        type: input.type,
        currency: input.currency,
        opening_balance: openingCents,
        csv_column_map: null,
        archived: 0,
        created_at: Math.floor(Date.now() / 1000),
      };
      writeLocalState({ ...state, accounts: [...state.accounts, account] });
      return account;
    }

    if (res.kind === 'error') throw new Error(res.error);
    return res.data.account;
  },

  async toggleArchiveAccount(id: string, archived: 0 | 1): Promise<AccountRecord> {
    const res = await tryApiFetch<{ account: AccountRecord }>('/api/accounts', {
      method: 'PATCH',
      body: JSON.stringify({ id, archived }),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) throw new Error('Sesión no iniciada.');
      let updated: AccountRecord | null = null;
      const accounts = state.accounts.map((a) => {
        if (a.id === id) {
          updated = { ...a, archived };
          return updated;
        }
        return a;
      });
      if (!updated) throw new Error('Cuenta no encontrada.');
      writeLocalState({ ...state, accounts });
      return updated;
    }

    if (res.kind === 'error') throw new Error(res.error);
    return res.data.account;
  },

  async createCategory(input: {
    name: string;
    kind: CategoryKind;
    parent_id?: string | null;
  }): Promise<CategoryRecord> {
    const res = await tryApiFetch<{ category: CategoryRecord }>('/api/categories', {
      method: 'POST',
      body: JSON.stringify(input),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) throw new Error('Sesión no iniciada.');
      const category: CategoryRecord = {
        id: crypto.randomUUID(),
        user_id: state.user.id,
        name: input.name.trim(),
        kind: input.kind,
        parent_id: input.parent_id ?? null,
        archived: 0,
      };
      writeLocalState({ ...state, categories: [...state.categories, category] });
      return category;
    }

    if (res.kind === 'error') throw new Error(res.error);
    return res.data.category;
  },

  async createTransaction(input: {
    date: string;
    type: TransactionType;
    account_id: string;
    counter_account_id: string | null;
    category_id: string | null;
    amount: number;
    currency: Currency;
    note: string | null;
    source: TransactionSource;
  }): Promise<TransactionRecord> {
    const res = await tryApiFetch<{ transaction: TransactionRecord }>('/api/transactions', {
      method: 'POST',
      body: JSON.stringify(input),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) throw new Error('Sesión no iniciada.');
      const account = state.accounts.find((a) => a.id === input.account_id);
      if (!account) throw new Error('Cuenta origen no encontrada.');
      const counterAccount = input.counter_account_id
        ? state.accounts.find((a) => a.id === input.counter_account_id) ?? null
        : null;
      const categoryId = input.type === 'transfer' ? null : input.category_id;

      validateTransactionInvariants({
        date: input.date,
        type: input.type,
        account,
        counterAccount,
        categoryId,
        amountCents: input.amount,
        currency: input.currency,
      });

      const transaction: TransactionRecord = {
        id: crypto.randomUUID(),
        user_id: state.user.id,
        date: input.date,
        type: input.type,
        account_id: input.account_id,
        counter_account_id: counterAccount ? counterAccount.id : null,
        category_id: categoryId,
        amount: input.amount,
        currency: input.currency,
        note: input.note?.trim() || null,
        source: input.source,
        voided_at: null,
        created_at: Math.floor(Date.now() / 1000),
      };

      writeLocalState({
        ...state,
        transactions: [transaction, ...state.transactions],
      });
      return transaction;
    }

    if (res.kind === 'error') throw new Error(res.error);
    return res.data.transaction;
  },

  async voidTransaction(id: string): Promise<TransactionRecord> {
    const res = await tryApiFetch<{ transaction: TransactionRecord }>('/api/transactions', {
      method: 'PATCH',
      body: JSON.stringify({ id, action: 'void' }),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) throw new Error('Sesión no iniciada.');
      const voidedAt = Math.floor(Date.now() / 1000);
      let updated: TransactionRecord | null = null;
      const transactions = state.transactions.map((t) => {
        if (t.id === id) {
          updated = { ...t, voided_at: voidedAt };
          return updated;
        }
        return t;
      });
      if (!updated) throw new Error('Movimiento no encontrado.');
      writeLocalState({ ...state, transactions });
      return updated;
    }

    if (res.kind === 'error') throw new Error(res.error);
    return res.data.transaction;
  },

  async createDraft(input: {
    source: DraftSource;
    raw_input: string;
    parsed: ParsedMovementDraft;
  }): Promise<MovementDraftRecord> {
    const res = await tryApiFetch<{ draft: MovementDraftRecord }>('/api/drafts', {
      method: 'POST',
      body: JSON.stringify(input),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) throw new Error('Sesión no iniciada.');
      const draft: MovementDraftRecord = {
        id: crypto.randomUUID(),
        user_id: state.user.id,
        source: input.source,
        raw_input: input.raw_input,
        extracted_json: JSON.stringify(input.parsed),
        uncertain_fields: JSON.stringify(input.parsed.uncertain_fields),
        status: 'pending',
        matched_transaction_id: null,
        created_at: Math.floor(Date.now() / 1000),
      };
      writeLocalState({ ...state, drafts: [draft, ...state.drafts] });
      return draft;
    }

    if (res.kind === 'error') throw new Error(res.error);
    return res.data.draft;
  },

  async resolveDraft(
    id: string,
    status: 'confirmed' | 'discarded',
    matchedTransactionId: string | null = null
  ): Promise<void> {
    const res = await tryApiFetch<{ ok: boolean }>('/api/drafts', {
      method: 'PATCH',
      body: JSON.stringify({ id, status, matched_transaction_id: matchedTransactionId }),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) return;
      const drafts = state.drafts.filter((d) => d.id !== id);
      writeLocalState({ ...state, drafts });
      return;
    }

    if (res.kind === 'error') throw new Error(res.error);
  },

  // === MÉTODOS V2: INVERSIONES Y PATRIMONIO ===

  async createPortfolio(input: {
    name: string;
    broker: string | null;
    base_currency: Currency;
  }): Promise<PortfolioRecord> {
    const res = await tryApiFetch<{ portfolio: PortfolioRecord }>('/api/portfolios', {
      method: 'POST',
      body: JSON.stringify(input),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) throw new Error('Sesión no iniciada.');
      const portfolio: PortfolioRecord = {
        id: crypto.randomUUID(),
        user_id: state.user.id,
        name: input.name.trim(),
        broker: input.broker?.trim() || null,
        base_currency: input.base_currency,
        created_at: Math.floor(Date.now() / 1000),
      };
      const initialCash: PortfolioCashRecord = {
        portfolio_id: portfolio.id,
        user_id: state.user.id,
        currency: portfolio.base_currency,
        amount: 0,
      };
      writeLocalState({
        ...state,
        portfolios: [...state.portfolios, portfolio],
        portfolioCash: [...state.portfolioCash, initialCash],
      });
      return portfolio;
    }

    if (res.kind === 'error') throw new Error(res.error);
    return res.data.portfolio;
  },

  async updatePortfolio(input: {
    id: string;
    name: string;
    broker: string | null;
    base_currency: Currency;
  }): Promise<PortfolioRecord> {
    const res = await tryApiFetch<{ portfolio: PortfolioRecord }>('/api/portfolios', {
      method: 'PATCH',
      body: JSON.stringify(input),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) throw new Error('Sesión no iniciada.');
      let updated: PortfolioRecord | null = null;
      const portfolios = state.portfolios.map((p) => {
        if (p.id === input.id) {
          updated = {
            ...p,
            name: input.name.trim(),
            broker: input.broker?.trim() || null,
            base_currency: input.base_currency,
          };
          return updated;
        }
        return p;
      });
      if (!updated) throw new Error('Cartera no encontrada.');

      const hasCashForCurrency = state.portfolioCash.some(
        (c) => c.portfolio_id === input.id && c.currency === input.base_currency
      );
      const portfolioCash = hasCashForCurrency
        ? state.portfolioCash
        : [
            ...state.portfolioCash,
            {
              portfolio_id: input.id,
              user_id: state.user.id,
              currency: input.base_currency,
              amount: 0,
            },
          ];

      writeLocalState({ ...state, portfolios, portfolioCash });
      return updated;
    }

    if (res.kind === 'error') throw new Error(res.error);
    return res.data.portfolio;
  },

  async deletePortfolio(id: string): Promise<void> {
    const res = await tryApiFetch<{ ok: boolean }>('/api/portfolios', {
      method: 'DELETE',
      body: JSON.stringify({ id }),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) throw new Error('Sesión no iniciada.');
      writeLocalState({
        ...state,
        portfolios: state.portfolios.filter((p) => p.id !== id),
        holdings: state.holdings.filter((h) => h.portfolio_id !== id),
        portfolioCash: state.portfolioCash.filter((c) => c.portfolio_id !== id),
        trades: state.trades.filter((t) => t.portfolio_id !== id),
        portfolioIncomes: state.portfolioIncomes.filter((i) => i.portfolio_id !== id),
        snapshotDrafts: state.snapshotDrafts.filter((d) => d.portfolio_id !== id),
      });
      return;
    }

    if (res.kind === 'error') throw new Error(res.error);
  },

  async createAsset(input: {
    ticker: string;
    name: string;
    asset_class: AssetClass;
    currency: Currency;
  }): Promise<AssetRecord> {
    const ticker = input.ticker.trim().toUpperCase();
    const res = await tryApiFetch<{ asset: AssetRecord }>('/api/assets', {
      method: 'POST',
      body: JSON.stringify({ ...input, ticker }),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) throw new Error('Sesión no iniciada.');
      const existing = state.assets.find((a) => a.ticker.toUpperCase() === ticker);
      if (existing) return existing;

      const asset: AssetRecord = {
        id: crypto.randomUUID(),
        ticker,
        name: input.name.trim() || `Activo ${ticker}`,
        asset_class: input.asset_class,
        currency: input.currency,
      };
      writeLocalState({
        ...state,
        assets: [...state.assets, asset],
      });
      return asset;
    }

    if (res.kind === 'error') throw new Error(res.error);
    return res.data.asset;
  },

  async updateAsset(input: {
    id: string;
    ticker: string;
    name: string;
    asset_class: AssetClass;
    currency: Currency;
  }): Promise<AssetRecord> {
    const ticker = input.ticker.trim().toUpperCase();
    const res = await tryApiFetch<{ asset: AssetRecord }>('/api/assets', {
      method: 'PATCH',
      body: JSON.stringify({ ...input, ticker }),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) throw new Error('Sesión no iniciada.');
      const duplicate = state.assets.find(
        (a) => a.ticker.toUpperCase() === ticker && a.id !== input.id
      );
      if (duplicate) throw new Error(`Ya existe otro activo con el ticker ${ticker}.`);

      let updated: AssetRecord | null = null;
      const assets = state.assets.map((a) => {
        if (a.id === input.id) {
          updated = {
            ...a,
            ticker,
            name: input.name.trim() || `Activo ${ticker}`,
            asset_class: input.asset_class,
            currency: input.currency,
          };
          return updated;
        }
        return a;
      });
      if (!updated) throw new Error('Activo no encontrado.');
      writeLocalState({ ...state, assets });
      return updated;
    }

    if (res.kind === 'error') throw new Error(res.error);
    return res.data.asset;
  },

  async deleteAsset(id: string): Promise<void> {
    const res = await tryApiFetch<{ ok: boolean }>('/api/assets', {
      method: 'DELETE',
      body: JSON.stringify({ id }),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) throw new Error('Sesión no iniciada.');
      writeLocalState({
        ...state,
        assets: state.assets.filter((a) => a.id !== id),
        holdings: state.holdings.filter((h) => h.asset_id !== id),
        trades: state.trades.filter((t) => t.asset_id !== id),
        portfolioIncomes: state.portfolioIncomes.map((inc) =>
          inc.asset_id === id ? { ...inc, asset_id: null } : inc
        ),
      });
      return;
    }

    if (res.kind === 'error') throw new Error(res.error);
  },

  async updateHoldingPrice(input: {
    id: string;
    last_price: number;
    last_price_date?: string;
  }): Promise<HoldingRecord> {
    const lastPrice = assertNonNegativeCents(input.last_price, 'last_price');
    const dateStr = input.last_price_date || getTodayIso();
    const res = await tryApiFetch<{ holding: HoldingRecord }>('/api/holdings', {
      method: 'PATCH',
      body: JSON.stringify({ id: input.id, last_price: lastPrice, last_price_date: dateStr }),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) throw new Error('Sesión no iniciada.');
      let updated: HoldingRecord | null = null;
      const holdings = state.holdings.map((h) => {
        if (h.id === input.id) {
          updated = { ...h, last_price: lastPrice, last_price_date: dateStr };
          return updated;
        }
        return h;
      });
      if (!updated) throw new Error('Tenencia no encontrada.');
      writeLocalState({ ...state, holdings });
      return updated;
    }

    if (res.kind === 'error') throw new Error(res.error);
    return res.data.holding;
  },

  async deleteHolding(id: string): Promise<void> {
    const res = await tryApiFetch<{ ok: boolean }>('/api/holdings', {
      method: 'DELETE',
      body: JSON.stringify({ id }),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) throw new Error('Sesión no iniciada.');
      const target = state.holdings.find((h) => h.id === id);
      if (!target) return;
      writeLocalState({
        ...state,
        holdings: state.holdings.filter((h) => h.id !== id),
        trades: state.trades.filter(
          (t) => !(t.portfolio_id === target.portfolio_id && t.asset_id === target.asset_id)
        ),
      });
      return;
    }

    if (res.kind === 'error') throw new Error(res.error);
  },

  async updatePortfolioCash(input: {
    portfolio_id: string;
    currency: Currency;
    amount: number;
  }): Promise<PortfolioCashRecord> {
    const amountCents = assertNonNegativeCents(input.amount, 'portfolio_cash');
    const res = await tryApiFetch<{ cash: PortfolioCashRecord }>('/api/portfolio-cash', {
      method: 'PUT',
      body: JSON.stringify({ ...input, amount: amountCents }),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) throw new Error('Sesión no iniciada.');
      const cashRecord: PortfolioCashRecord = {
        portfolio_id: input.portfolio_id,
        user_id: state.user.id,
        currency: input.currency,
        amount: amountCents,
      };
      const exists = state.portfolioCash.some(
        (c) => c.portfolio_id === input.portfolio_id && c.currency === input.currency
      );
      const portfolioCash = exists
        ? state.portfolioCash.map((c) =>
            c.portfolio_id === input.portfolio_id && c.currency === input.currency ? cashRecord : c
          )
        : [...state.portfolioCash, cashRecord];

      writeLocalState({ ...state, portfolioCash });
      return cashRecord;
    }

    if (res.kind === 'error') throw new Error(res.error);
    return res.data.cash;
  },

  /**
   * RN-02: Registra una compra o venta de activos recalculando avg_cost o realized_gain.
   * Separación estricta: NO crea ni modifica filas en 'transactions' de V1; settlement_account_id es informativo.
   */
  async recordTrade(input: {
    portfolio_id: string;
    asset_id: string;
    side: TradeSide;
    quantity: number;
    price: number;
    fee: number;
    date: string;
    settlement_account_id: string | null;
    note: string | null;
  }): Promise<{ trade: TradeRecord; holding: HoldingRecord }> {
    const res = await tryApiFetch<{ trade: TradeRecord; holding: HoldingRecord }>('/api/trades', {
      method: 'POST',
      body: JSON.stringify(input),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) throw new Error('Sesión no iniciada.');
      const existingHolding = state.holdings.find(
        (h) => h.portfolio_id === input.portfolio_id && h.asset_id === input.asset_id
      );

      const execResult = applyTradeToHolding({
        currentQuantity: existingHolding?.quantity ?? 0,
        currentAvgCostCents: existingHolding?.avg_cost ?? 0,
        side: input.side,
        tradeQuantity: input.quantity,
        tradePriceCents: input.price,
        feeCents: input.fee,
      });

      const trade: TradeRecord = {
        id: crypto.randomUUID(),
        user_id: state.user.id,
        portfolio_id: input.portfolio_id,
        asset_id: input.asset_id,
        side: input.side,
        quantity: input.quantity,
        price: input.price,
        fee: assertNonNegativeCents(input.fee, 'fee'),
        date: input.date,
        settlement_account_id: input.settlement_account_id,
        realized_gain: execResult.realizedGainCents,
        note: input.note?.trim() || null,
        created_at: Math.floor(Date.now() / 1000),
      };

      const holding: HoldingRecord = {
        id: existingHolding?.id ?? crypto.randomUUID(),
        user_id: state.user.id,
        portfolio_id: input.portfolio_id,
        asset_id: input.asset_id,
        quantity: execResult.nextQuantity,
        avg_cost: execResult.nextAvgCostCents,
        last_price: input.price,
        last_price_date: input.date,
      };

      const holdings = existingHolding
        ? state.holdings.map((h) => (h.id === existingHolding.id ? holding : h))
        : [...state.holdings, holding];

      writeLocalState({
        ...state,
        trades: [trade, ...state.trades],
        holdings,
      });
      return { trade, holding };
    }

    if (res.kind === 'error') throw new Error(res.error);
    return res.data;
  },

  async updateTrade(input: {
    id: string;
    side: TradeSide;
    quantity: number;
    price: number;
    fee: number;
    date: string;
    settlement_account_id: string | null;
    note: string | null;
  }): Promise<void> {
    const res = await tryApiFetch<{ ok: boolean }>('/api/trades', {
      method: 'PATCH',
      body: JSON.stringify(input),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) throw new Error('Sesión no iniciada.');
      const target = state.trades.find((t) => t.id === input.id);
      if (!target) throw new Error('Operación no encontrada.');

      const pairTrades = state.trades
        .filter((t) => t.portfolio_id === target.portfolio_id && t.asset_id === target.asset_id)
        .map((t) =>
          t.id === input.id
            ? {
                ...t,
                side: input.side,
                quantity: input.quantity,
                price: assertPositiveCents(input.price, 'price'),
                fee: assertNonNegativeCents(input.fee, 'fee'),
                date: input.date,
                settlement_account_id: input.settlement_account_id,
                note: input.note?.trim() || null,
              }
            : t
        );

      const existingHolding = state.holdings.find(
        (h) => h.portfolio_id === target.portfolio_id && h.asset_id === target.asset_id
      );

      const recalc = recalculateHoldingFromTrades(
        pairTrades,
        existingHolding?.last_price ?? input.price,
        existingHolding?.last_price_date ?? input.date
      );

      const updatedPairMap = new Map(recalc.updatedTrades.map((t) => [t.id, t]));
      const nextTrades = state.trades.map((t) => updatedPairMap.get(t.id) ?? t);

      const nextHolding: HoldingRecord = {
        id: existingHolding?.id ?? crypto.randomUUID(),
        user_id: state.user.id,
        portfolio_id: target.portfolio_id,
        asset_id: target.asset_id,
        quantity: recalc.quantity,
        avg_cost: recalc.avgCostCents,
        last_price: recalc.lastPriceCents,
        last_price_date: recalc.lastPriceDate,
      };

      const nextHoldings = existingHolding
        ? state.holdings.map((h) => (h.id === existingHolding.id ? nextHolding : h))
        : [...state.holdings, nextHolding];

      writeLocalState({
        ...state,
        trades: nextTrades,
        holdings: nextHoldings,
      });
      return;
    }

    if (res.kind === 'error') throw new Error(res.error);
  },

  async deleteTrade(id: string): Promise<void> {
    const res = await tryApiFetch<{ ok: boolean }>('/api/trades', {
      method: 'DELETE',
      body: JSON.stringify({ id }),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) throw new Error('Sesión no iniciada.');
      const target = state.trades.find((t) => t.id === id);
      if (!target) throw new Error('Operación no encontrada.');

      const remainingPairTrades = state.trades.filter(
        (t) =>
          t.portfolio_id === target.portfolio_id &&
          t.asset_id === target.asset_id &&
          t.id !== id
      );

      const existingHolding = state.holdings.find(
        (h) => h.portfolio_id === target.portfolio_id && h.asset_id === target.asset_id
      );

      const recalc = recalculateHoldingFromTrades(
        remainingPairTrades,
        existingHolding?.last_price ?? 0,
        existingHolding?.last_price_date ?? null
      );

      const updatedPairMap = new Map(recalc.updatedTrades.map((t) => [t.id, t]));
      const nextTrades = state.trades
        .filter((t) => t.id !== id)
        .map((t) => updatedPairMap.get(t.id) ?? t);

      let nextHoldings = state.holdings;
      if (existingHolding) {
        if (remainingPairTrades.length === 0) {
          nextHoldings = state.holdings.filter((h) => h.id !== existingHolding.id);
        } else {
          nextHoldings = state.holdings.map((h) =>
            h.id === existingHolding.id
              ? {
                  ...h,
                  quantity: recalc.quantity,
                  avg_cost: recalc.avgCostCents,
                  last_price: recalc.lastPriceCents,
                  last_price_date: recalc.lastPriceDate,
                }
              : h
          );
        }
      }

      writeLocalState({
        ...state,
        trades: nextTrades,
        holdings: nextHoldings,
      });
      return;
    }

    if (res.kind === 'error') throw new Error(res.error);
  },

  async createPortfolioIncome(input: {
    portfolio_id: string;
    asset_id: string | null;
    type: PortfolioIncomeType;
    amount: number;
    currency: Currency;
    date: string;
    note: string | null;
  }): Promise<PortfolioIncomeRecord> {
    const amount = assertPositiveCents(input.amount, 'amount');
    const res = await tryApiFetch<{ income: PortfolioIncomeRecord }>('/api/portfolio-incomes', {
      method: 'POST',
      body: JSON.stringify({ ...input, amount }),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) throw new Error('Sesión no iniciada.');
      const income: PortfolioIncomeRecord = {
        id: crypto.randomUUID(),
        user_id: state.user.id,
        portfolio_id: input.portfolio_id,
        asset_id: input.asset_id,
        type: input.type,
        amount,
        currency: input.currency,
        date: input.date,
        note: input.note?.trim() || null,
      };
      writeLocalState({
        ...state,
        portfolioIncomes: [income, ...state.portfolioIncomes],
      });
      return income;
    }

    if (res.kind === 'error') throw new Error(res.error);
    return res.data.income;
  },

  async deletePortfolioIncome(id: string): Promise<void> {
    const res = await tryApiFetch<{ ok: boolean }>('/api/portfolio-incomes', {
      method: 'DELETE',
      body: JSON.stringify({ id }),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) throw new Error('Sesión no iniciada.');
      writeLocalState({
        ...state,
        portfolioIncomes: state.portfolioIncomes.filter((i) => i.id !== id),
      });
      return;
    }

    if (res.kind === 'error') throw new Error(res.error);
  },

  async createSnapshotDraft(input: {
    portfolio_id: string;
    raw_text: string;
    rows: ParsedPortfolioSnapshotRow[];
  }): Promise<PortfolioSnapshotDraftRecord> {
    const res = await tryApiFetch<{ draft: PortfolioSnapshotDraftRecord }>(
      '/api/portfolio-snapshot-drafts',
      {
        method: 'POST',
        body: JSON.stringify(input),
      }
    );

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) throw new Error('Sesión no iniciada.');
      const draft: PortfolioSnapshotDraftRecord = {
        id: crypto.randomUUID(),
        user_id: state.user.id,
        portfolio_id: input.portfolio_id,
        raw_text: input.raw_text,
        rows_json: JSON.stringify(input.rows),
        status: 'pending',
        created_at: Math.floor(Date.now() / 1000),
      };
      writeLocalState({
        ...state,
        snapshotDrafts: [draft, ...state.snapshotDrafts],
      });
      return draft;
    }

    if (res.kind === 'error') throw new Error(res.error);
    return res.data.draft;
  },

  async confirmSnapshotDraft(input: {
    draft_id: string;
    portfolio_id: string;
    rows: Array<{
      ticker: string;
      asset_name: string;
      asset_class: AssetClass;
      quantity: number;
      avg_cost: number;
      last_price: number;
    }>;
  }): Promise<void> {
    const res = await tryApiFetch<{ ok: boolean }>('/api/portfolio-snapshot-drafts', {
      method: 'PATCH',
      body: JSON.stringify({
        id: input.draft_id,
        action: 'confirm',
        portfolio_id: input.portfolio_id,
        rows: input.rows,
      }),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) throw new Error('Sesión no iniciada.');
      const portfolio = state.portfolios.find((p) => p.id === input.portfolio_id);
      if (!portfolio) throw new Error('Cartera destino no encontrada.');

      const nextAssets = [...state.assets];
      const nextHoldings = [...state.holdings];
      const today = getTodayIso();

      for (const row of input.rows) {
        const ticker = row.ticker.trim().toUpperCase();
        if (!ticker || row.quantity < 0) continue;
        const avgCost = assertNonNegativeCents(row.avg_cost, 'avg_cost');
        const lastPrice = assertNonNegativeCents(row.last_price, 'last_price');

        let asset = nextAssets.find((a) => a.ticker.toUpperCase() === ticker);
        if (!asset) {
          asset = {
            id: crypto.randomUUID(),
            ticker,
            name: row.asset_name.trim() || `Activo ${ticker}`,
            asset_class: row.asset_class,
            currency: portfolio.base_currency,
          };
          nextAssets.push(asset);
        }

        const existingIdx = nextHoldings.findIndex(
          (h) => h.portfolio_id === portfolio.id && h.asset_id === asset!.id
        );
        const holdingRecord: HoldingRecord = {
          id: existingIdx >= 0 ? nextHoldings[existingIdx].id : crypto.randomUUID(),
          user_id: state.user.id,
          portfolio_id: portfolio.id,
          asset_id: asset.id,
          quantity: row.quantity,
          avg_cost: avgCost,
          last_price: lastPrice,
          last_price_date: today,
        };

        if (existingIdx >= 0) {
          nextHoldings[existingIdx] = holdingRecord;
        } else {
          nextHoldings.push(holdingRecord);
        }
      }

      writeLocalState({
        ...state,
        assets: nextAssets,
        holdings: nextHoldings,
        snapshotDrafts: state.snapshotDrafts.filter((d) => d.id !== input.draft_id),
      });
      return;
    }

    if (res.kind === 'error') throw new Error(res.error);
  },

  async discardSnapshotDraft(draftId: string): Promise<void> {
    const res = await tryApiFetch<{ ok: boolean }>('/api/portfolio-snapshot-drafts', {
      method: 'PATCH',
      body: JSON.stringify({ id: draftId, action: 'discard' }),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) return;
      writeLocalState({
        ...state,
        snapshotDrafts: state.snapshotDrafts.filter((d) => d.id !== draftId),
      });
      return;
    }

    if (res.kind === 'error') throw new Error(res.error);
  },

  /**
   * Actualiza cotizaciones externas desde Yahoo Finance ÚNICAMENTE para activos en USD (no CEDEARs).
   */
  async refreshUsdQuotesFromYahoo(
    holdingIds?: string[]
  ): Promise<{ updatedCount: number; skippedReasons: string[] }> {
    const res = await tryApiFetch<{
      updatedHoldings: HoldingRecord[];
      skippedReasons: string[];
    }>('/api/quotes/yahoo', {
      method: 'POST',
      body: JSON.stringify({ holding_ids: holdingIds }),
    });

    if (res.kind === 'fallback') {
      const state = readLocalState();
      if (!state?.user) throw new Error('Sesión no iniciada.');
      const assetMap = new Map(state.assets.map((a) => [a.id, a]));
      const today = getTodayIso();
      let updatedCount = 0;
      const skippedReasons: string[] = [];

      const simulatedUsdQuotesCents: Record<string, number> = {
        SPY: 58640, // USD 586.40
        MSFT: 43215, // USD 432.15
        AAPL: 22980, // USD 229.80
        QQQ: 50420, // USD 504.20
        NVDA: 13850, // USD 138.50
        GOOGL: 18290, // USD 182.90
        AMZN: 21040, // USD 210.40
        MELI: 204500, // USD 2,045.00
      };

      const holdings = state.holdings.map((h) => {
        if (h.quantity <= 0) return h;
        if (holdingIds && !holdingIds.includes(h.id)) return h;
        const asset = assetMap.get(h.asset_id);
        if (!asset) return h;

        if (!canAutoQuoteWithYahoo(asset)) {
          skippedReasons.push(
            `${asset.ticker} (${asset.currency}): Cotización manual (CEDEAR / ARS sujeto a ratio y CCL).`
          );
          return h;
        }

        const nextPrice = simulatedUsdQuotesCents[asset.ticker] ?? Math.round(h.last_price * 1.01);
        updatedCount++;
        return {
          ...h,
          last_price: nextPrice,
          last_price_date: today,
        };
      });

      writeLocalState({ ...state, holdings });
      return { updatedCount, skippedReasons };
    }

    if (res.kind === 'error') throw new Error(res.error);
    return {
      updatedCount: res.data.updatedHoldings.length,
      skippedReasons: res.data.skippedReasons,
    };
  },
};
