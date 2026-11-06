import { assertNonNegativeCents, assertPositiveCents } from './money';
import type {
  AccountRecord,
  ConsolidatedBalances,
  Currency,
  MonthlySummary,
  TransactionRecord,
  TransactionType,
} from './types';

export class LedgerRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerRuleError';
  }
}

/**
 * RN-08: Función única centralizada para calcular el saldo de una cuenta
 * a partir de su opening_balance y las transacciones NO anuladas (voided_at === null).
 * RN-01: Las transferencias se almacenan en una sola fila:
 *   - Restan en account_id (origen)
 *   - Suman en counter_account_id (destino)
 */
export function calculateAccountBalance(
  openingBalanceCents: number,
  accountId: string,
  transactions: ReadonlyArray<TransactionRecord>
): number {
  let balance = assertNonNegativeCents(openingBalanceCents, 'opening_balance');

  for (const tx of transactions) {
    if (tx.voided_at !== null) {
      continue;
    }

    if (tx.type === 'income' && tx.account_id === accountId) {
      balance += tx.amount;
    } else if (tx.type === 'expense' && tx.account_id === accountId) {
      balance -= tx.amount;
    } else if (tx.type === 'transfer') {
      if (tx.account_id === accountId) {
        balance -= tx.amount;
      }
      if (tx.counter_account_id === accountId) {
        balance += tx.amount;
      }
    }
  }

  return balance;
}

/**
 * RN-03: Segregación estricta de monedas.
 * Calcula los saldos consolidados en ARS y USD por separado sin mezclar ni convertir.
 */
export function calculateConsolidatedBalances(
  accounts: ReadonlyArray<AccountRecord>,
  transactions: ReadonlyArray<TransactionRecord>
): ConsolidatedBalances {
  let arsTotal = 0;
  let usdTotal = 0;

  for (const account of accounts) {
    if (account.archived === 1) {
      continue;
    }
    const bal = calculateAccountBalance(account.opening_balance, account.id, transactions);
    if (account.currency === 'ARS') {
      arsTotal += bal;
    } else if (account.currency === 'USD') {
      usdTotal += bal;
    }
  }

  return { ARS: arsTotal, USD: usdTotal };
}

/**
 * Calcula ingresos y gastos del mes (YYYY-MM) por moneda, excluyendo transferencias (RN-01)
 * y transacciones anuladas (RN-07).
 */
export function calculateMonthlySummary(
  monthYYYYMM: string,
  transactions: ReadonlyArray<TransactionRecord>
): MonthlySummary {
  const summary: MonthlySummary = {
    ARS: { income: 0, expense: 0 },
    USD: { income: 0, expense: 0 },
  };

  for (const tx of transactions) {
    if (tx.voided_at !== null) {
      continue;
    }
    if (!tx.date.startsWith(monthYYYYMM)) {
      continue;
    }
    if (tx.type === 'transfer') {
      continue;
    }

    if (tx.type === 'income') {
      summary[tx.currency].income += tx.amount;
    } else if (tx.type === 'expense') {
      summary[tx.currency].expense += tx.amount;
    }
  }

  return summary;
}

/**
 * Convierte una fecha YYYY-MM-DD a días UTC desde epoch para comparación exacta sin zonas horarias.
 */
function parseIsoDateDays(dateStr: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10) - 1;
  const day = Number.parseInt(match[3], 10);
  const utcMs = Date.UTC(year, month, day);
  return Math.floor(utcMs / 86_400_000);
}

export interface DuplicateCheckCandidate {
  date: string;
  amount: number;
  account_id: string;
  currency: Currency;
  excludeTransactionId?: string;
}

/**
 * Detección de posibles duplicados:
 * Busca movimientos activos (voided_at === null) con mismo importe, cuenta y moneda
 * dentro de una ventana de ±2 días.
 */
export function findPotentialDuplicates(
  candidate: DuplicateCheckCandidate,
  transactions: ReadonlyArray<TransactionRecord>
): TransactionRecord[] {
  const candidateDays = parseIsoDateDays(candidate.date);
  if (candidateDays === null) {
    return [];
  }

  return transactions.filter((tx) => {
    if (tx.voided_at !== null) return false;
    if (candidate.excludeTransactionId && tx.id === candidate.excludeTransactionId) return false;
    if (tx.amount !== candidate.amount) return false;
    if (tx.account_id !== candidate.account_id) return false;
    if (tx.currency !== candidate.currency) return false;

    const txDays = parseIsoDateDays(tx.date);
    if (txDays === null) return false;

    return Math.abs(txDays - candidateDays) <= 2;
  });
}

export interface ValidateTransactionParams {
  date: string;
  type: TransactionType;
  account: AccountRecord;
  counterAccount: AccountRecord | null;
  categoryId: string | null;
  amountCents: number;
  currency: Currency;
}

/**
 * Valida todas las invariantes contables (RN-01, RN-03, RN-06) antes de persistir un movimiento.
 */
export function validateTransactionInvariants(params: ValidateTransactionParams): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.date)) {
    throw new LedgerRuleError('La fecha debe tener formato YYYY-MM-DD.');
  }

  assertPositiveCents(params.amountCents, 'amount');

  if (params.account.currency !== params.currency) {
    throw new LedgerRuleError(
      `La cuenta "${params.account.name}" opera en ${params.account.currency}, no se puede registrar en ${params.currency} (RN-03).`
    );
  }

  if (params.type === 'transfer') {
    if (!params.counterAccount) {
      throw new LedgerRuleError('Una transferencia requiere una cuenta destino (RN-01).');
    }
    if (params.counterAccount.id === params.account.id) {
      throw new LedgerRuleError('La cuenta origen y destino de una transferencia deben ser distintas.');
    }
    if (params.counterAccount.currency !== params.currency) {
      throw new LedgerRuleError(
        `No se pueden mezclar monedas en una transferencia: "${params.account.name}" (${params.account.currency}) vs "${params.counterAccount.name}" (${params.counterAccount.currency}) (RN-03).`
      );
    }
    if (params.categoryId !== null) {
      throw new LedgerRuleError('Las transferencias entre cuentas propias no llevan categoría (RN-01).');
    }
  } else {
    if (params.counterAccount !== null) {
      throw new LedgerRuleError('Solo las transferencias pueden tener cuenta destino.');
    }
  }
}
