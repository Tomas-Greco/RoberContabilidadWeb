import { useMemo, useState } from 'react';
import { Ban, Download, Search } from 'lucide-react';
import { exportLedgerToExcel } from '../services/excelExport';
import { formatMoney } from '../shared/money';
import type {
  AccountRecord,
  CategoryRecord,
  Currency,
  TransactionRecord,
  TransactionType,
} from '../shared/types';

interface TransactionsViewProps {
  accounts: ReadonlyArray<AccountRecord>;
  categories: ReadonlyArray<CategoryRecord>;
  transactions: ReadonlyArray<TransactionRecord>;
  onVoidTransaction: (id: string) => Promise<void>;
}

const TYPE_LABELS: Record<TransactionType, string> = {
  income: 'Ingreso',
  expense: 'Gasto',
  transfer: 'Transferencia',
};

export function TransactionsView({
  accounts,
  categories,
  transactions,
  onVoidTransaction,
}: TransactionsViewProps) {
  const [currencyFilter, setCurrencyFilter] = useState<'ALL' | Currency>('ALL');
  const [typeFilter, setTypeFilter] = useState<'ALL' | TransactionType>('ALL');
  const [accountFilter, setAccountFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [showVoided, setShowVoided] = useState<boolean>(false);
  const [voidingId, setVoidingId] = useState<string | null>(null);

  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const categoryMap = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return transactions.filter((tx) => {
      if (!showVoided && tx.voided_at !== null) return false;
      if (currencyFilter !== 'ALL' && tx.currency !== currencyFilter) return false;
      if (typeFilter !== 'ALL' && tx.type !== typeFilter) return false;
      if (
        accountFilter !== 'ALL' &&
        tx.account_id !== accountFilter &&
        tx.counter_account_id !== accountFilter
      ) {
        return false;
      }
      if (q) {
        const accName = accountMap.get(tx.account_id)?.name.toLowerCase() ?? '';
        const catName = tx.category_id
          ? categoryMap.get(tx.category_id)?.name.toLowerCase() ?? ''
          : '';
        const note = tx.note?.toLowerCase() ?? '';
        if (!accName.includes(q) && !catName.includes(q) && !note.includes(q) && !tx.date.includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [
    transactions,
    showVoided,
    currencyFilter,
    typeFilter,
    accountFilter,
    searchQuery,
    accountMap,
    categoryMap,
  ]);

  const handleVoid = async (id: string) => {
    setVoidingId(id);
    try {
      await onVoidTransaction(id);
    } finally {
      setVoidingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
            Historial de Movimientos
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Registro inmutable con anulación lógica (voided_at) y exportación nativa a Excel.
          </p>
        </div>

        <button
          type="button"
          onClick={() => exportLedgerToExcel(accounts, categories, transactions)}
          className="inline-flex items-center gap-2 py-2 px-4 rounded-lg border border-slate-200 bg-white text-slate-900 text-sm font-medium hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
        >
          <Download className="w-4 h-4" aria-hidden="true" />
          <span>Exportar Excel (.xlsx)</span>
        </button>
      </div>

      {/* Barra de Filtros Multicriterio */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-center">
        <div className="relative">
          <Search
            className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2"
            aria-hidden="true"
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar nota, cuenta o categoría..."
            aria-label="Buscar movimientos"
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-slate-900"
          />
        </div>

        <select
          aria-label="Filtrar por moneda"
          value={currencyFilter}
          onChange={(e) => setCurrencyFilter(e.target.value as 'ALL' | Currency)}
          className="px-3 py-2 rounded-lg border border-slate-200 text-sm bg-white"
        >
          <option value="ALL">Todas las monedas</option>
          <option value="ARS">Solo ARS</option>
          <option value="USD">Solo USD</option>
        </select>

        <select
          aria-label="Filtrar por tipo"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as 'ALL' | TransactionType)}
          className="px-3 py-2 rounded-lg border border-slate-200 text-sm bg-white"
        >
          <option value="ALL">Todos los tipos</option>
          <option value="expense">Gastos</option>
          <option value="income">Ingresos</option>
          <option value="transfer">Transferencias</option>
        </select>

        <select
          aria-label="Filtrar por cuenta"
          value={accountFilter}
          onChange={(e) => setAccountFilter(e.target.value)}
          className="px-3 py-2 rounded-lg border border-slate-200 text-sm bg-white"
        >
          <option value="ALL">Todas las cuentas</option>
          {accounts.map((acc) => (
            <option key={acc.id} value={acc.id}>
              {acc.name} ({acc.currency})
            </option>
          ))}
        </select>

        <label className="flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showVoided}
            onChange={(e) => setShowVoided(e.target.checked)}
          />
          <span>Mostrar anulados</span>
        </label>
      </div>

      {/* Tabla de Movimientos */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500">
            No se encontraron movimientos con los filtros seleccionados.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/60 text-xs font-medium text-slate-500">
                  <th className="py-3 px-4">Fecha</th>
                  <th className="py-3 px-4">Tipo</th>
                  <th className="py-3 px-4">Cuenta</th>
                  <th className="py-3 px-4">Categoría / Nota</th>
                  <th className="py-3 px-4 text-right">Importe</th>
                  <th className="py-3 px-4 text-right">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filtered.map((tx) => {
                  const acc = accountMap.get(tx.account_id);
                  const counterAcc = tx.counter_account_id
                    ? accountMap.get(tx.counter_account_id)
                    : undefined;
                  const cat = tx.category_id ? categoryMap.get(tx.category_id) : undefined;
                  const isVoided = tx.voided_at !== null;

                  return (
                    <tr
                      key={tx.id}
                      className={`hover:bg-slate-50/80 ${isVoided ? 'opacity-50 line-through' : ''}`}
                    >
                      <td className="py-3 px-4 font-mono text-xs text-slate-600 whitespace-nowrap tabular-nums">
                        {tx.date}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-700 whitespace-nowrap">
                        {TYPE_LABELS[tx.type]}
                      </td>
                      <td className="py-3 px-4 text-slate-900 whitespace-nowrap">
                        {tx.type === 'transfer'
                          ? `${acc?.name ?? ''} → ${counterAcc?.name ?? ''}`
                          : acc?.name ?? ''}
                      </td>
                      <td className="py-3 px-4">
                        <span className="font-medium text-slate-900">
                          {cat?.name ?? (tx.type === 'transfer' ? 'Transferencia interna' : 'Sin categoría')}
                        </span>
                        {tx.note && (
                          <span className="text-xs text-slate-500 block truncate max-w-xs">
                            {tx.note}
                          </span>
                        )}
                      </td>
                      <td
                        className={`py-3 px-4 text-right font-mono tabular-nums font-medium whitespace-nowrap ${
                          tx.type === 'income'
                            ? 'text-emerald-700'
                            : tx.type === 'expense'
                            ? 'text-red-700'
                            : 'text-slate-800'
                        }`}
                      >
                        {tx.type === 'income' ? '+' : tx.type === 'expense' ? '-' : ''}
                        {formatMoney(tx.amount, tx.currency)}
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        {isVoided ? (
                          <span className="text-xs text-slate-500">Anulado</span>
                        ) : (
                          <button
                            type="button"
                            disabled={voidingId === tx.id}
                            onClick={() => handleVoid(tx.id)}
                            aria-label={`Anular movimiento del ${tx.date}`}
                            className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-red-700 cursor-pointer disabled:opacity-50"
                          >
                            <Ban className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Anular</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
