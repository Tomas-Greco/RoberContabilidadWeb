import { calculateHoldingMetrics, calculateTotalWealth } from '../shared/investments';
import { calculateAccountBalance, calculateConsolidatedBalances } from '../shared/ledger';
import { fromCents } from '../shared/money';
import type {
  AccountRecord,
  AssetRecord,
  CategoryRecord,
  HoldingRecord,
  PortfolioCashRecord,
  PortfolioIncomeRecord,
  PortfolioRecord,
  TradeRecord,
  TransactionRecord,
} from '../shared/types';

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

const ASSET_CLASS_LABELS: Record<AssetRecord['asset_class'], string> = {
  stock: 'Acción / ETF',
  cedear: 'CEDEAR',
  bond: 'Bono / ON',
  crypto: 'Cripto',
  fci: 'Fondo Común (FCI)',
  other: 'Otro',
};

export interface ExcelInvestmentBundle {
  portfolios: ReadonlyArray<PortfolioRecord>;
  assets: ReadonlyArray<AssetRecord>;
  holdings: ReadonlyArray<HoldingRecord>;
  portfolioCash: ReadonlyArray<PortfolioCashRecord>;
  trades: ReadonlyArray<TradeRecord>;
  portfolioIncomes: ReadonlyArray<PortfolioIncomeRecord>;
}

/**
 * Genera y descarga un archivo .xlsx nativo en el navegador del cliente
 * con pestañas separadas de Saldos, Movimientos e Inversiones (V2),
 * respetando estrictamente la segregación bimonetaria ARS / USD (RN-03).
 * Carga SheetJS (xlsx) bajo demanda para no penalizar el tiempo de carga inicial.
 */
export async function exportLedgerToExcel(
  accounts: ReadonlyArray<AccountRecord>,
  categories: ReadonlyArray<CategoryRecord>,
  transactions: ReadonlyArray<TransactionRecord>,
  investments?: ExcelInvestmentBundle
): Promise<void> {
  const XLSX = await import('xlsx');
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
      Cuenta: 'TOTAL SALDO CUENTAS ARS (V1)',
      Tipo: 'Efectivo',
      Moneda: 'ARS',
      'Saldo Inicial': 0,
      'Saldo Actual': fromCents(consolidated.ARS),
      Estado: 'Activa',
    },
    {
      Cuenta: 'TOTAL SALDO CUENTAS USD (V1)',
      Tipo: 'Efectivo',
      Moneda: 'USD',
      'Saldo Inicial': 0,
      'Saldo Actual': fromCents(consolidated.USD),
      Estado: 'Activa',
    }
  );

  if (investments) {
    const wealth = calculateTotalWealth({
      accounts,
      transactions,
      portfolios: investments.portfolios,
      holdings: investments.holdings,
      assets: investments.assets,
      portfolioCash: investments.portfolioCash,
    });

    balancesRows.push(
      {
        Cuenta: 'PATRIMONIO TOTAL ARS (Cuentas + Carteras + Efectivo Broker)',
        Tipo: 'Otra',
        Moneda: 'ARS',
        'Saldo Inicial': 0,
        'Saldo Actual': fromCents(wealth.ARS.totalNetWorth),
        Estado: 'Activa',
      },
      {
        Cuenta: 'PATRIMONIO TOTAL USD (Cuentas + Carteras + Efectivo Broker)',
        Tipo: 'Otra',
        Moneda: 'USD',
        'Saldo Inicial': 0,
        'Saldo Actual': fromCents(wealth.USD.totalNetWorth),
        Estado: 'Activa',
      }
    );
  }

  // Hoja 2: Historial de Movimientos V1
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

  XLSX.utils.book_append_sheet(wb, wsBalances, 'Saldos y Patrimonio');
  XLSX.utils.book_append_sheet(wb, wsTransactions, 'Movimientos');

  if (investments) {
    const portfolioMap = new Map(investments.portfolios.map((p) => [p.id, p]));
    const assetMap = new Map(investments.assets.map((a) => [a.id, a]));

    // Hoja 3: Tenencias de Inversión y Liquidez en Brokers (V2)
    const holdingsRows: Array<Record<string, string | number>> = investments.holdings
      .filter((h) => h.quantity > 0)
      .map((h) => {
        const port = portfolioMap.get(h.portfolio_id);
        const asset = assetMap.get(h.asset_id);
        const metrics = calculateHoldingMetrics(h);
        const currency = asset?.currency ?? port?.base_currency ?? 'ARS';

        return {
          Cartera: port?.name ?? h.portfolio_id,
          Broker: port?.broker ?? '',
          Ticker: asset?.ticker ?? h.asset_id,
          Activo: asset?.name ?? '',
          Clase: asset ? ASSET_CLASS_LABELS[asset.asset_class] : '',
          Moneda: currency,
          Cantidad: h.quantity,
          'Costo Promedio (PPP)': fromCents(h.avg_cost),
          'Último Precio': fromCents(h.last_price),
          'Costo Total': fromCents(metrics.totalCostCents),
          'Valor de Mercado': fromCents(metrics.marketValueCents),
          'Resultado Latente': fromCents(metrics.unrealizedGainCents),
          'Rendimiento (%)': metrics.unrealizedGainPct,
          'Fecha Precio': h.last_price_date ?? '',
        };
      });

    for (const cash of investments.portfolioCash) {
      const port = portfolioMap.get(cash.portfolio_id);
      holdingsRows.push({
        Cartera: port?.name ?? cash.portfolio_id,
        Broker: port?.broker ?? '',
        Ticker: `CASH-${cash.currency}`,
        Activo: 'Efectivo líquido en Broker',
        Clase: 'Liquidez',
        Moneda: cash.currency,
        Cantidad: 1,
        'Costo Promedio (PPP)': fromCents(cash.amount),
        'Último Precio': fromCents(cash.amount),
        'Costo Total': fromCents(cash.amount),
        'Valor de Mercado': fromCents(cash.amount),
        'Resultado Latente': 0,
        'Rendimiento (%)': 0,
        'Fecha Precio': '',
      });
    }

    const wsHoldings = XLSX.utils.json_to_sheet(holdingsRows);
    XLSX.utils.book_append_sheet(wb, wsHoldings, 'Inversiones');

    // Hoja 4: Operaciones (Trades) y Rendimientos (Dividendos / Intereses)
    const operationsRows: Array<Record<string, string | number>> = investments.trades.map((tr) => {
      const port = portfolioMap.get(tr.portfolio_id);
      const asset = assetMap.get(tr.asset_id);
      const settlementAcc = tr.settlement_account_id
        ? accountMap.get(tr.settlement_account_id)
        : undefined;

      return {
        Fecha: tr.date,
        Categoría: tr.side === 'buy' ? 'Compra Activo' : 'Venta Activo',
        Cartera: port?.name ?? tr.portfolio_id,
        Ticker: asset?.ticker ?? tr.asset_id,
        Moneda: asset?.currency ?? port?.base_currency ?? 'ARS',
        Cantidad: tr.quantity,
        'Precio Unitario': fromCents(tr.price),
        Comisión: fromCents(tr.fee),
        'Resultado Realizado (Venta)':
          tr.realized_gain !== null ? fromCents(tr.realized_gain) : '',
        'Cuenta Liquidación (Info)': settlementAcc?.name ?? '',
        Nota: tr.note ?? '',
      };
    });

    for (const inc of investments.portfolioIncomes) {
      const port = portfolioMap.get(inc.portfolio_id);
      const asset = inc.asset_id ? assetMap.get(inc.asset_id) : undefined;
      operationsRows.push({
        Fecha: inc.date,
        Categoría: inc.type === 'dividend' ? 'Dividendo' : 'Interés / Cupón',
        Cartera: port?.name ?? inc.portfolio_id,
        Ticker: asset?.ticker ?? '',
        Moneda: inc.currency,
        Cantidad: 1,
        'Precio Unitario': fromCents(inc.amount),
        Comisión: 0,
        'Resultado Realizado (Venta)': fromCents(inc.amount),
        'Cuenta Liquidación (Info)': '',
        Nota: inc.note ?? '',
      });
    }

    const wsOps = XLSX.utils.json_to_sheet(operationsRows);
    XLSX.utils.book_append_sheet(wb, wsOps, 'Operaciones y Rentas');
  }

  const today = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `patrimonio_contable_${today}.xlsx`);
}
