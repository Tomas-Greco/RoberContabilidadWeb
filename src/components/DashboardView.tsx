import { useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  Download,
  HelpCircle,
  Settings,
} from 'lucide-react';
import {
  calculateExpenseByCategory,
  calculateTotalWealth,
} from '../shared/investments';
import {
  calculateAccountBalance,
  calculateMonthlySummary,
} from '../shared/ledger';
import { formatMoney } from '../shared/money';
import type {
  AccountRecord,
  AssetRecord,
  CategoryRecord,
  Currency,
  HoldingRecord,
  PortfolioCashRecord,
  PortfolioIncomeRecord,
  PortfolioRecord,
  TradeRecord,
  TransactionRecord,
} from '../shared/types';
import { SvgDonutChart } from './SvgDonutChart';
import type { ActiveTab } from './TopNav';

interface DashboardViewProps {
  accounts: ReadonlyArray<AccountRecord>;
  categories: ReadonlyArray<CategoryRecord>;
  transactions: ReadonlyArray<TransactionRecord>;
  portfolios: ReadonlyArray<PortfolioRecord>;
  assets: ReadonlyArray<AssetRecord>;
  holdings: ReadonlyArray<HoldingRecord>;
  portfolioCash: ReadonlyArray<PortfolioCashRecord>;
  trades: ReadonlyArray<TradeRecord>;
  portfolioIncomes: ReadonlyArray<PortfolioIncomeRecord>;
  onNavigate: (tab: ActiveTab) => void;
  onOpenNewTransaction: () => void;
}

const ACCOUNT_TYPE_LABELS: Record<AccountRecord['type'], string> = {
  cash: 'Efectivo',
  bank: 'Banco',
  wallet: 'Billetera',
  other: 'Otra',
};

const SLICE_COLORS = [
  '#6366f1', // indigo-500
  '#0ea5e9', // sky-500
  '#10b981', // emerald-500
  '#f59e0b', // amber-500
  '#8b5cf6', // violet-500
  '#ec4899', // pink-500
];

function calcPercent(part: number, total: number): number {
  if (total <= 0 || part <= 0) return 0;
  return Math.min(100, Math.max(0, Number(((part / total) * 100).toFixed(1))));
}

export function DashboardView({
  accounts,
  categories,
  transactions,
  portfolios,
  assets,
  holdings,
  portfolioCash,
  trades,
  portfolioIncomes,
  onNavigate,
  onOpenNewTransaction,
}: DashboardViewProps) {
  const [expenseChartCurrency, setExpenseChartCurrency] = useState<Currency>('ARS');
  const [showPlainGuide, setShowPlainGuide] = useState<boolean>(false);

  const currentMonth = useMemo(() => new Date().toISOString().slice(0, 7), []);
  const wealth = useMemo(
    () =>
      calculateTotalWealth({
        accounts,
        transactions,
        portfolios,
        holdings,
        assets,
        portfolioCash,
      }),
    [accounts, transactions, portfolios, holdings, assets, portfolioCash]
  );
  const monthly = useMemo(
    () => calculateMonthlySummary(currentMonth, transactions),
    [currentMonth, transactions]
  );

  const expenseSlices = useMemo(
    () =>
      calculateExpenseByCategory({
        transactions,
        categories,
        currency: expenseChartCurrency,
      }),
    [transactions, categories, expenseChartCurrency]
  );

  const activeAccounts = useMemo(
    () => accounts.filter((a) => a.archived === 0),
    [accounts]
  );
  const activeTransactions = useMemo(
    () => transactions.filter((t) => t.voided_at === null).slice(0, 8),
    [transactions]
  );
  const activeHoldingsCount = useMemo(
    () => holdings.filter((h) => h.quantity > 0).length,
    [holdings]
  );

  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const categoryMap = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  // Porcentajes de composición patrimonial para barras gráficas
  const arsAccPct = calcPercent(wealth.ARS.accountsBalance, wealth.ARS.totalNetWorth);
  const arsPortPct = calcPercent(wealth.ARS.portfoliosMarketValue, wealth.ARS.totalNetWorth);
  const arsCashPct = calcPercent(wealth.ARS.portfoliosCash, wealth.ARS.totalNetWorth);

  const usdAccPct = calcPercent(wealth.USD.accountsBalance, wealth.USD.totalNetWorth);
  const usdPortPct = calcPercent(wealth.USD.portfoliosMarketValue, wealth.USD.totalNetWorth);
  const usdCashPct = calcPercent(wealth.USD.portfoliosCash, wealth.USD.totalNetWorth);

  return (
    <div className="space-y-8">
      {/* Encabezado */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
            Resumen de tu Dinero y Patrimonio
          </h1>
          <div className="flex flex-wrap items-center gap-2.5 text-sm text-slate-600 mt-1.5">
            <span>Tus cuentas, ahorros e inversiones explicados de forma simple</span>
            <span aria-hidden="true">·</span>
            <span>Período {currentMonth}</span>
            <button
              type="button"
              onClick={() => setShowPlainGuide((v) => !v)}
              className="btn-accent-soft py-1 px-2.5 text-xs"
            >
              <HelpCircle className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{showPlainGuide ? 'Ocultar guía rápida' : '¿Cómo leer este resumen?'}</span>
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={async () => {
              const { exportLedgerToExcel } = await import('../services/excelExport');
              await exportLedgerToExcel(accounts, categories, transactions, {
                portfolios,
                assets,
                holdings,
                portfolioCash,
                trades,
                portfolioIncomes,
              });
            }}
            className="btn-secondary py-2 px-3.5 text-xs sm:text-sm whitespace-nowrap"
          >
            <Download className="w-4 h-4" aria-hidden="true" />
            <span>Exportar Excel</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('investments')}
            className="btn-secondary py-2 px-3.5 text-xs sm:text-sm whitespace-nowrap"
          >
            <span>Ver Inversiones</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('quick-capture')}
            className="btn-secondary py-2 px-3.5 text-xs sm:text-sm whitespace-nowrap"
          >
            <span>Carga Rápida</span>
          </button>
        </div>
      </div>

      {/* Guía amigable para personas no afines a la economía */}
      {showPlainGuide && (
        <section
          aria-label="Guía rápida de conceptos"
          className="bg-white border border-slate-200 rounded-xl p-5 grid grid-cols-1 md:grid-cols-3 gap-5 text-xs text-slate-600 shadow-2xs"
        >
          <div>
            <p className="font-semibold text-slate-900 mb-1">1. ¿Qué es tu Patrimonio Total?</p>
            <p>
              Es la suma de todo lo que tenés hoy: el dinero listo para usar en tus bancos o billeteras, más lo que valen tus inversiones actuales y el saldo disponible en tu broker. Pesos y Dólares nunca se mezclan para evitar distorsiones por tipo de cambio.
            </p>
          </div>
          <div>
            <p className="font-semibold text-slate-900 mb-1">2. ¿Qué pasa cuando transferís entre tus cuentas?</p>
            <p>
              Pasar plata de tu banco a tu billetera virtual o a efectivo no te hace más rico ni más pobre: por eso el sistema lo registra como un movimiento neutro que no infla tus gastos del mes.
            </p>
          </div>
          <div>
            <p className="font-semibold text-slate-900 mb-1">3. ¿Comprar una inversión es un gasto?</p>
            <p>
              No. Comprar una acción, bono o CEDEAR es cambiar efectivo por un activo que conserva valor. Solo se registra ganancia o pérdida real cuando decidís venderlo.
            </p>
          </div>
        </section>
      )}

      {/* Tarjetas Bimonetarias con Gráfico de Composición Patrimonial (RN-03: Nunca mezclar ARS y USD) */}
      <section aria-label="Patrimonio total consolidado por moneda" className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Bloque ARS */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5 shadow-2xs">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-slate-500">
                Patrimonio Total en Pesos Argentinos (ARS)
              </span>
              <span className="text-xs font-mono font-semibold text-slate-500">ARS</span>
            </div>
            <p
              data-testid="total-net-worth-ars"
              className="text-3xl font-semibold text-slate-900 font-mono tabular-nums tracking-tight"
            >
              {formatMoney(wealth.ARS.totalNetWorth, 'ARS')}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Todo tu dinero disponible e invertido en pesos hoy
            </p>
          </div>

          {/* Barra gráfica apilada de composición patrimonial ARS */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>Composición de tu patrimonio en ARS</span>
              <span className="font-mono tabular-nums">100%</span>
            </div>
            <div
              role="img"
              aria-label={`Composición en ARS: Cuentas ${arsAccPct}%, Inversiones ${arsPortPct}%, Efectivo Broker ${arsCashPct}%`}
              className="w-full h-3 bg-slate-100 rounded-md overflow-hidden flex"
            >
              <div
                style={{ width: `${arsAccPct}%` }}
                className="bg-indigo-500 h-full transition-all"
                title={`En cuentas y billeteras: ${arsAccPct}%`}
              />
              <div
                style={{ width: `${arsPortPct}%` }}
                className="bg-sky-500 h-full transition-all"
                title={`Invertido en activos: ${arsPortPct}%`}
              />
              <div
                style={{ width: `${arsCashPct}%` }}
                className="bg-emerald-500 h-full transition-all"
                title={`Disponible en broker: ${arsCashPct}%`}
              />
            </div>

            <div className="pt-2 grid grid-cols-3 gap-3 text-xs">
              <div>
                <span className="text-slate-500 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-xs bg-indigo-500 shrink-0" />
                  <span>En Cuentas ({arsAccPct}%)</span>
                </span>
                <span
                  data-testid="total-ars"
                  className="font-mono tabular-nums font-medium text-slate-900 mt-0.5 block"
                >
                  {formatMoney(wealth.ARS.accountsBalance, 'ARS')}
                </span>
              </div>
              <div>
                <span className="text-slate-500 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-xs bg-sky-500 shrink-0" />
                  <span>Invertido ({arsPortPct}%)</span>
                </span>
                <span
                  data-testid="market-value-ars"
                  className="font-mono tabular-nums font-medium text-sky-600 dark:text-sky-400 mt-0.5 block"
                >
                  {formatMoney(wealth.ARS.portfoliosMarketValue, 'ARS')}
                </span>
              </div>
              <div>
                <span className="text-slate-500 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-xs bg-emerald-500 shrink-0" />
                  <span>En Broker ({arsCashPct}%)</span>
                </span>
                <span
                  data-testid="broker-cash-ars"
                  className="font-mono tabular-nums font-medium text-emerald-700 mt-0.5 block"
                >
                  {formatMoney(wealth.ARS.portfoliosCash, 'ARS')}
                </span>
              </div>
            </div>
          </div>

          {/* Gráfico comparativo de Flujo Mensual ARS */}
          <MonthlyCashflowBar
            currency="ARS"
            incomeCents={monthly.ARS.income}
            expenseCents={monthly.ARS.expense}
          />
        </div>

        {/* Bloque USD */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5 shadow-2xs">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-slate-500">
                Patrimonio Total en Dólares Estadounidenses (USD)
              </span>
              <span className="text-xs font-mono font-semibold text-slate-500">USD</span>
            </div>
            <p
              data-testid="total-net-worth-usd"
              className="text-3xl font-semibold text-slate-900 font-mono tabular-nums tracking-tight"
            >
              {formatMoney(wealth.USD.totalNetWorth, 'USD')}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Todo tu dinero disponible e invertido en dólares hoy
            </p>
          </div>

          {/* Barra gráfica apilada de composición patrimonial USD */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>Composición de tu patrimonio en USD</span>
              <span className="font-mono tabular-nums">100%</span>
            </div>
            <div
              role="img"
              aria-label={`Composición en USD: Cuentas ${usdAccPct}%, Inversiones ${usdPortPct}%, Efectivo Broker ${usdCashPct}%`}
              className="w-full h-3 bg-slate-100 rounded-md overflow-hidden flex"
            >
              <div
                style={{ width: `${usdAccPct}%` }}
                className="bg-indigo-500 h-full transition-all"
                title={`En cuentas bancarias USD: ${usdAccPct}%`}
              />
              <div
                style={{ width: `${usdPortPct}%` }}
                className="bg-sky-500 h-full transition-all"
                title={`Invertido en activos USD: ${usdPortPct}%`}
              />
              <div
                style={{ width: `${usdCashPct}%` }}
                className="bg-emerald-500 h-full transition-all"
                title={`Disponible en broker USD: ${usdCashPct}%`}
              />
            </div>

            <div className="pt-2 grid grid-cols-3 gap-3 text-xs">
              <div>
                <span className="text-slate-500 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-xs bg-indigo-500 shrink-0" />
                  <span>En Cuentas ({usdAccPct}%)</span>
                </span>
                <span
                  data-testid="total-usd"
                  className="font-mono tabular-nums font-medium text-slate-900 mt-0.5 block"
                >
                  {formatMoney(wealth.USD.accountsBalance, 'USD')}
                </span>
              </div>
              <div>
                <span className="text-slate-500 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-xs bg-sky-500 shrink-0" />
                  <span>Invertido ({usdPortPct}%)</span>
                </span>
                <span
                  data-testid="market-value-usd"
                  className="font-mono tabular-nums font-medium text-sky-600 dark:text-sky-400 mt-0.5 block"
                >
                  {formatMoney(wealth.USD.portfoliosMarketValue, 'USD')}
                </span>
              </div>
              <div>
                <span className="text-slate-500 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-xs bg-emerald-500 shrink-0" />
                  <span>En Broker ({usdCashPct}%)</span>
                </span>
                <span
                  data-testid="broker-cash-usd"
                  className="font-mono tabular-nums font-medium text-emerald-700 mt-0.5 block"
                >
                  {formatMoney(wealth.USD.portfoliosCash, 'USD')}
                </span>
              </div>
            </div>
          </div>

          {/* Gráfico comparativo de Flujo Mensual USD */}
          <MonthlyCashflowBar
            currency="USD"
            incomeCents={monthly.USD.income}
            expenseCents={monthly.USD.expense}
          />
        </div>
      </section>

      {/* Panel Gráfico de Distribución de Gastos por Categoría */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 shadow-2xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              ¿En qué se va tu dinero? (Distribución de Gastos por Categoría)
            </h2>
            <p className="text-xs text-slate-500">
              Muestra el peso porcentual de cada rubro sobre tus gastos totales en la moneda elegida (sin contar transferencias entre cuentas propias).
            </p>
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 border border-slate-200 rounded-lg self-start">
            <button
              type="button"
              onClick={() => setExpenseChartCurrency('ARS')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                expenseChartCurrency === 'ARS'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-700 hover:bg-white'
              }`}
            >
              Gastos en ARS
            </button>
            <button
              type="button"
              onClick={() => setExpenseChartCurrency('USD')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                expenseChartCurrency === 'USD'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-700 hover:bg-white'
              }`}
            >
              Gastos en USD
            </button>
          </div>
        </div>

        {expenseSlices.length === 0 ? (
          <div className="py-6 text-center text-sm text-slate-500">
            Aún no registraste gastos en {expenseChartCurrency}. Cuando anotes un consumo, verás acá el gráfico por categoría.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
            {/* Gráfico Donut SVG nativo */}
            <div className="md:col-span-4 flex flex-col items-center justify-center">
              <SvgDonutChart
                slices={expenseSlices.map((s, idx) => ({
                  label: s.categoryName,
                  percentage: s.percentage,
                  color: SLICE_COLORS[idx % SLICE_COLORS.length],
                }))}
                centerTitle={expenseChartCurrency}
                centerSubtitle={`${expenseSlices.length} rubro(s)`}
              />
            </div>

            {/* Barras horizontales con importes y porcentajes */}
            <div className="md:col-span-8 space-y-3">
              {expenseSlices.map((slice, idx) => {
                const barColor = SLICE_COLORS[idx % SLICE_COLORS.length];
                return (
                  <div key={slice.categoryId ?? 'none'} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-900">{slice.categoryName}</span>
                      <span className="font-mono tabular-nums text-slate-700">
                        {formatMoney(slice.amountCents, expenseChartCurrency)} ·{' '}
                        <strong>{slice.percentage}%</strong>
                      </span>
                    </div>
                    <div className="w-full h-2.5 bg-slate-100 rounded-md overflow-hidden">
                      <div
                        className="h-full rounded-md transition-all"
                        style={{
                          width: `${Math.max(3, slice.percentage)}%`,
                          backgroundColor: barColor,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>

      {/* Grilla Principal: Cuentas Activas + Últimos Movimientos */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Cuentas */}
        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between shadow-2xs">
          <div>
            <div className="flex items-center justify-between gap-2 mb-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">Tus Cuentas y Billeteras</h2>
                <p className="text-xs text-slate-500">Dinero disponible para gastos o transferencias</p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('accounts')}
                className="btn-secondary py-1.5 px-3 text-xs shrink-0"
              >
                <Settings className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Administrar</span>
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
                  className="btn-primary py-2 px-3.5 text-xs"
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
                  const currencyTotal =
                    acc.currency === 'ARS'
                      ? wealth.ARS.accountsBalance
                      : wealth.USD.accountsBalance;
                  const sharePct = calcPercent(balanceCents, currencyTotal);

                  return (
                    <li key={acc.id} className="py-3 space-y-1.5">
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-900 truncate">{acc.name}</p>
                          <p className="text-xs text-slate-500">
                            {ACCOUNT_TYPE_LABELS[acc.type]} · {acc.currency} · {sharePct}% del efectivo en {acc.currency}
                          </p>
                        </div>
                        <span
                          className={`text-sm font-mono tabular-nums font-medium shrink-0 ${
                            balanceCents < 0 ? 'text-red-700' : 'text-slate-900'
                          }`}
                        >
                          {formatMoney(balanceCents, acc.currency)}
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-indigo-500 rounded-full"
                          style={{ width: `${sharePct}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="mt-6 pt-4 border-t border-slate-100 flex items-center justify-between gap-2 text-xs text-slate-600">
            <span>
              {portfolios.length} carteras de inversión · {activeHoldingsCount} activos en cartera
            </span>
            <button
              type="button"
              onClick={() => onNavigate('investments')}
              className="btn-accent-soft py-1.5 px-3 text-xs shrink-0"
            >
              <span>Ir a Inversiones</span>
              <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        </section>

        {/* Últimos Movimientos */}
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 shadow-2xs">
          <div className="flex items-center justify-between gap-2 mb-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Últimos Movimientos</h2>
              <p className="text-xs text-slate-500">Tus ingresos, gastos y transferencias más recientes</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('transactions')}
              className="btn-secondary py-1.5 px-3 text-xs shrink-0"
            >
              <span>Ver historial completo</span>
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
                className="btn-primary py-2 px-3.5 text-xs"
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

function MonthlyCashflowBar({
  currency,
  incomeCents,
  expenseCents,
}: {
  currency: Currency;
  incomeCents: number;
  expenseCents: number;
}) {
  const maxVal = Math.max(incomeCents, expenseCents, 1);
  const incWidth = Math.round((incomeCents / maxVal) * 100);
  const expWidth = Math.round((expenseCents / maxVal) * 100);
  const netSavings = incomeCents - expenseCents;
  const savingsRatePct =
    incomeCents > 0 ? Math.round(((incomeCents - expenseCents) / incomeCents) * 100) : 0;

  return (
    <div className="pt-3 border-t border-slate-100 space-y-2.5 text-xs">
      <div className="flex items-center justify-between text-slate-600">
        <span className="font-medium">Balance del mes (Lo que entró vs. lo que salió)</span>
        {incomeCents > 0 && (
          <span
            className={`font-mono tabular-nums font-medium ${
              netSavings >= 0 ? 'text-emerald-700' : 'text-red-700'
            }`}
          >
            {savingsRatePct >= 0
              ? `Ahorraste el ${savingsRatePct}%`
              : `Gasto superó ingresos`}
          </span>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-slate-500">Ingresos del mes</span>
          <span className="font-mono tabular-nums font-medium text-emerald-700">
            +{formatMoney(incomeCents, currency)}
          </span>
        </div>
        <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-emerald-500 rounded-full transition-all"
            style={{ width: `${incomeCents > 0 ? Math.max(4, incWidth) : 0}%` }}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-slate-500">Gastos del mes</span>
          <span className="font-mono tabular-nums font-medium text-red-700">
            -{formatMoney(expenseCents, currency)}
          </span>
        </div>
        <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-rose-500 rounded-full transition-all"
            style={{ width: `${expenseCents > 0 ? Math.max(4, expWidth) : 0}%` }}
          />
        </div>
      </div>
    </div>
  );
}
