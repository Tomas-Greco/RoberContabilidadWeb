import * as XLSX from 'xlsx';
import { calculateAccountBalance, calculateConsolidatedBalances } from '../shared/ledger';
import { fromCents } from '../shared/money';
import type { AccountRecord, CategoryRecord, TransactionRecord } from '../shared/types';

const TYPE_LABELS: Record<TransactionRecord['type'], string> = {
  income: 'Ingreso',
  expense: 'Gasto',
  transfer: 'Transferencia',
};

const ACCOUNT_TYPE_LABELS: Record<AccountRecord['type'], string> = {
  cash: 'Efectivo',
  bank: 'Banco',
  wallet: 'Billetera',
  other: 'Otra',
};

/**
 * Genera y descarga un archivo .xlsx nativo en el navegador del cliente
 * con pestañas separadas de Saldos y Movimientos, respetando la segregación ARS / USD (RN-03).
 */
export function exportLedgerToExcel(
  accounts: ReadonlyArray<AccountRecord>,
  categories: ReadonlyArray<CategoryRecord>,
  transactions: ReadonlyArray<TransactionRecord>
): void {
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const categoryMap = new Map(categories.map((c) => [c.id, c]));
  const consolidated = calculateConsolidatedBalances(accounts, transactions);

  // Hoja 1: Saldos por Cuenta + Totales Segregados
  const balancesRows = accounts.map((acc) => {
    const currentCents = calculateAccountBalance(acc.opening_balance, acc.id, transactions);
    return {
      Cuenta: acc.name,
      Tipo: ACCOUNT_TYPE_LABELS[acc.type],
      Moneda: acc.currency,
      'Saldo Inicial': fromCents(acc.opening_balance),
      'Saldo Actual': fromCents(currentCents),
      Estado: acc.archived === 1 ? 'Archivada' : 'Activa',
    };
  });

  balancesRows.push(
    {
      Cuenta: 'TOTAL CONSOLIDADO ARS',
      Tipo: 'Efectivo',
      Moneda: 'ARS',
      'Saldo Inicial': 0,
      'Saldo Actual': fromCents(consolidated.ARS),
      Estado: 'Activa',
    },
    {
      Cuenta: 'TOTAL CONSOLIDADO USD',
      Tipo: 'Efectivo',
      Moneda: 'USD',
      'Saldo Inicial': 0,
      'Saldo Actual': fromCents(consolidated.USD),
      Estado: 'Activa',
    }
  );

  // Hoja 2: Historial de Movimientos
  const txRows = transactions.map((tx) => {
    const acc = accountMap.get(tx.account_id);
    const counterAcc = tx.counter_account_id ? accountMap.get(tx.counter_account_id) : undefined;
    const cat = tx.category_id ? categoryMap.get(tx.category_id) : undefined;

    return {
      Fecha: tx.date,
      Tipo: TYPE_LABELS[tx.type],
      Cuenta: acc?.name ?? tx.account_id,
      'Cuenta Destino': counterAcc?.name ?? '',
      Categoría: cat?.name ?? (tx.type === 'transfer' ? 'Transferencia entre cuentas' : ''),
      Moneda: tx.currency,
      Importe: fromCents(tx.amount),
      Nota: tx.note ?? '',
      Origen: tx.source,
      Estado: tx.voided_at !== null ? 'Anulado' : 'Activo',
    };
  });

  const wb = XLSX.utils.book_new();
  const wsBalances = XLSX.utils.json_to_sheet(balancesRows);
  const wsTransactions = XLSX.utils.json_to_sheet(txRows);

  XLSX.utils.book_append_sheet(wb, wsBalances, 'Saldos');
  XLSX.utils.book_append_sheet(wb, wsTransactions, 'Movimientos');

  const today = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `patrimonio_contable_${today}.xlsx`);
}
