import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight } from 'lucide-react';
import {
  calculateAccountBalance,
  calculateConsolidatedBalances,
  calculateMonthlySummary,
} from '../shared/ledger';
import { formatMoney } from '../shared/money';
import type { AccountRecord, CategoryRecord, TransactionRecord } from '../shared/types';
import type { ActiveTab } from './TopNav';

interface DashboardViewProps {
  accounts: ReadonlyArray<AccountRecord>;
  categories: ReadonlyArray<CategoryRecord>;
  transactions: ReadonlyArray<TransactionRecord>;
  onNavigate: (tab: ActiveTab) => void;
  onOpenNewTransaction: () => void;
}

const ACCOUNT_TYPE_LABELS: Record<AccountRecord['type'], string> = {
  cash: 'Efectivo',
  bank: 'Banco',
  wallet: 'Billetera',
  other: 'Otra',
};

export function DashboardView({
  accounts,
  categories,
  transactions,
  onNavigate,
  onOpenNewTransaction,
}: DashboardViewProps) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const consolidated = calculateConsolidatedBalances(accounts, transactions);
  const monthly = calculateMonthlySummary(currentMonth, transactions);

  const activeAccounts = accounts.filter((a) => a.archived === 0);
  const activeTransactions = transactions.filter((t) => t.voided_at === null).slice(0, 8);

  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const categoryMap = new Map(categories.map((c) => [c.id, c]));

  return (
    <div className="space-y-8">
      {/* Encabezado */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
            Resumen Patrimonial
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600 mt-1">
            <span>Saldos calculados en tiempo real desde el libro diario</span>
            <span aria-hidden="true">·</span>
            <span>Período {currentMonth}</span>
            <span aria-hidden="true">·</span>
            <span className="text-xs text-slate-500">Cifrado AES-GCM 256 activo</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onNavigate('quick-capture')}
            className="py-2 px-4 rounded-lg border border-slate-200 bg-white text-slate-700 text-sm font-medium hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap"
          >
            Carga Rápida
          </button>
        </div>
      </div>

      {/* Tarjetas Bimonetarias Segregadas (RN-03: Nunca mezclar ARS y USD) */}
      <section aria-label="Totales consolidados por moneda" className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Bloque ARS */}
        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-slate-500">
              Disponible en Pesos Argentinos (ARS)
            </span>
            <span className="text-xs font-mono text-slate-500">ARS</span>
          </div>
          <p
            data-testid="total-ars"
            className="text-3xl font-semibold text-slate-900 font-mono tabular-nums tracking-tight"
          >
            {formatMoney(consolidated.ARS, 'ARS')}
          </p>

          <div className="mt-5 pt-4 border-t border-slate-100 grid grid-cols-2 gap-4 text-xs">
            <div>
              <span className="text-slate-500 block">Ingresos del mes</span>
              <span className="font-mono tabular-nums font-medium text-emerald-700 mt-0.5 block">
                +{formatMoney(monthly.ARS.income, 'ARS')}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">Gastos del mes</span>
              <span className="font-mono tabular-nums font-medium text-red-700 mt-0.5 block">
                -{formatMoney(monthly.ARS.expense, 'ARS')}
              </span>
            </div>
          </div>
        </div>

        {/* Bloque USD */}
        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-slate-500">
              Disponible en Dólares Estadounidenses (USD)
            </span>
            <span className="text-xs font-mono text-slate-500">USD</span>
          </div>
          <p
            data-testid="total-usd"
            className="text-3xl font-semibold text-slate-900 font-mono tabular-nums tracking-tight"
          >
            {formatMoney(consolidated.USD, 'USD')}
          </p>

          <div className="mt-5 pt-4 border-t border-slate-100 grid grid-cols-2 gap-4 text-xs">
            <div>
              <span className="text-slate-500 block">Ingresos del mes</span>
              <span className="font-mono tabular-nums font-medium text-emerald-700 mt-0.5 block">
                +{formatMoney(monthly.USD.income, 'USD')}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">Gastos del mes</span>
              <span className="font-mono tabular-nums font-medium text-red-700 mt-0.5 block">
                -{formatMoney(monthly.USD.expense, 'USD')}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Grilla Principal: Cuentas Activas + Últimos Movimientos */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Cuentas */}
        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-slate-900">Cuentas Activas</h2>
            <button
              type="button"
              onClick={() => onNavigate('accounts')}
              className="text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
            >
              Administrar
            </button>
          </div>

          {activeAccounts.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm text-slate-500 mb-3">
                Aún no tenés cuentas registradas.
              </p>
              <button
                type="button"
                onClick={() => onNavigate('accounts')}
                className="py-2 px-3.5 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 cursor-pointer"
              >
                Crear primera cuenta
              </button>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {activeAccounts.map((acc) => {
                const balanceCents = calculateAccountBalance(
                  acc.opening_balance,
                  acc.id,
                  transactions
                );
                return (
                  <li key={acc.id} className="py-3 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 truncate">{acc.name}</p>
                      <p className="text-xs text-slate-500">
                        {ACCOUNT_TYPE_LABELS[acc.type]} · {acc.currency}
                      </p>
                    </div>
                    <span
                      className={`text-sm font-mono tabular-nums font-medium shrink-0 ${
                        balanceCents < 0 ? 'text-red-700' : 'text-slate-900'
                      }`}
                    >
                      {formatMoney(balanceCents, acc.currency)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Últimos Movimientos */}
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-slate-900">Últimos Movimientos</h2>
            <button
              type="button"
              onClick={() => onNavigate('transactions')}
              className="text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
            >
              Ver historial completo
            </button>
          </div>

          {activeTransactions.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm text-slate-500 mb-3">
                No hay movimientos activos registrados.
              </p>
              <button
                type="button"
                onClick={onOpenNewTransaction}
                className="py-2 px-3.5 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 cursor-pointer"
              >
                Registrar primer movimiento
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-100 text-xs font-medium text-slate-500">
                    <th className="py-2 pr-3">Fecha</th>
                    <th className="py-2 px-3">Detalle</th>
                    <th className="py-2 pl-3 text-right">Importe</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {activeTransactions.map((tx) => {
                    const acc = accountMap.get(tx.account_id);
                    const counterAcc = tx.counter_account_id
                      ? accountMap.get(tx.counter_account_id)
                      : undefined;
                    const cat = tx.category_id ? categoryMap.get(tx.category_id) : undefined;

                    return (
                      <tr key={tx.id} className="hover:bg-slate-50/80">
                        <td className="py-2.5 pr-3 font-mono text-xs text-slate-500 whitespace-nowrap tabular-nums">
                          {tx.date}
                        </td>
                        <td className="py-2.5 px-3">
                          <div className="flex items-center gap-2">
                            {tx.type === 'income' && (
                              <ArrowDownLeft
                                className="w-3.5 h-3.5 text-emerald-600 shrink-0"
                                aria-label="Ingreso"
                              />
                            )}
                            {tx.type === 'expense' && (
                              <ArrowUpRight
                                className="w-3.5 h-3.5 text-red-600 shrink-0"
                                aria-label="Gasto"
                              />
                            )}
                            {tx.type === 'transfer' && (
                              <ArrowLeftRight
                                className="w-3.5 h-3.5 text-slate-500 shrink-0"
                                aria-label="Transferencia"
                              />
                            )}
                            <span className="font-medium text-slate-900 truncate max-w-[220px]">
                              {tx.type === 'transfer'
                                ? `${acc?.name ?? ''} → ${counterAcc?.name ?? ''}`
                                : cat?.name ?? tx.note ?? 'Movimiento'}
                            </span>
                          </div>
                          <p className="text-xs text-slate-500 truncate max-w-[260px]">
                            {acc?.name}
                            {tx.note ? ` · ${tx.note}` : ''}
                          </p>
                        </td>
                        <td
                          className={`py-2.5 pl-3 text-right font-mono tabular-nums font-medium whitespace-nowrap ${
                            tx.type === 'income'
                              ? 'text-emerald-700'
                              : tx.type === 'expense'
                              ? 'text-red-700'
                              : 'text-slate-700'
                          }`}
                        >
                          {tx.type === 'income' ? '+' : tx.type === 'expense' ? '-' : ''}
                          {formatMoney(tx.amount, tx.currency)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
