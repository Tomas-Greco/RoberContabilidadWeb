import { validateTransactionInvariants } from '../shared/ledger';
import { assertNonNegativeCents } from '../shared/money';
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

const LOCAL_STORAGE_KEY = 'patrimonio_local_d1_v1';

interface LocalDbState {
  user: UserSession | null;
  accounts: AccountRecord[];
  categories: CategoryRecord[];
  transactions: TransactionRecord[];
  drafts: MovementDraftRecord[];
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

  return {
    user,
    accounts,
    categories,
    transactions,
    drafts: [],
  };
}

function readLocalState(): LocalDbState | null {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as LocalDbState;
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
      // En Vite dev server sin wrangler pages dev, /api/* devuelve index.html o 404
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
}

export const ledgerStore = {
  async loadAll(): Promise<LedgerSnapshot> {
    const meRes = await tryApiFetch<{ user: UserSession | null }>('/api/auth/me');
    if (meRes.kind === 'fallback') {
      const local = readLocalState();
      if (!local || !local.user) {
        return { user: null, accounts: [], categories: [], transactions: [], drafts: [] };
      }
      return local;
    }

    if (meRes.kind !== 'ok' || !meRes.data.user) {
      return { user: null, accounts: [], categories: [], transactions: [], drafts: [] };
    }

    const [accRes, catRes, txRes, draftRes] = await Promise.all([
      tryApiFetch<{ accounts: AccountRecord[] }>('/api/accounts'),
      tryApiFetch<{ categories: CategoryRecord[] }>('/api/categories'),
      tryApiFetch<{ transactions: TransactionRecord[] }>('/api/transactions'),
      tryApiFetch<{ drafts: MovementDraftRecord[] }>('/api/drafts'),
    ]);

    return {
      user: meRes.data.user,
      accounts: accRes.kind === 'ok' ? accRes.data.accounts : [],
      categories: catRes.kind === 'ok' ? catRes.data.categories : [],
      transactions: txRes.kind === 'ok' ? txRes.data.transactions : [],
      drafts: draftRes.kind === 'ok' ? draftRes.data.drafts : [],
    };
  },

  async loginWithGoogleCredential(credential: string): Promise<UserSession> {
    const res = await tryApiFetch<{ user: UserSession }>('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ credential }),
    });

    if (res.kind === 'fallback') {
      // Decodificar payload del JWT de Google en modo local preview
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
};
