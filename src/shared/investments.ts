import { calculateConsolidatedBalances } from './ledger';
import { assertNonNegativeCents, assertPositiveCents, toCents } from './money';
import type {
  AccountRecord,
  AssetClass,
  AssetRecord,
  Currency,
  HoldingRecord,
  ParsedPortfolioSnapshotRow,
  PortfolioCashRecord,
  PortfolioRecord,
  SnapshotRowUncertainField,
  TotalWealthSummary,
  TradeSide,
  TransactionRecord,
} from './types';

export class InvestmentRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvestmentRuleError';
  }
}

export interface TradeExecutionInput {
  currentQuantity: number;
  currentAvgCostCents: number;
  side: TradeSide;
  tradeQuantity: number;
  tradePriceCents: number;
  feeCents?: number;
}

export interface TradeExecutionResult {
  nextQuantity: number;
  nextAvgCostCents: number;
  realizedGainCents: number | null;
}

/**
 * RN-02 (Contabilidad de Inversiones):
 * - Comprar un activo financiero recalcula el Costo Promedio Ponderado (PPP / avg_cost),
 *   incorporando las comisiones (fee) en el costo de adquisición por unidad.
 * - Vender un activo financiero NO altera el costo promedio de las unidades restantes;
 *   solo la diferencia entre el producido neto de venta y el costo promedio proporcional
 *   constituye resultado realizado (realized_gain).
 * - RN-06: Precios de operación > 0; avg_cost y fee >= 0.
 */
export function applyTradeToHolding(input: TradeExecutionInput): TradeExecutionResult {
  const currentQty = Number(input.currentQuantity);
  if (!Number.isFinite(currentQty) || currentQty < 0) {
    throw new InvestmentRuleError('La tenencia actual no puede ser negativa.');
  }

  const currentAvgCost = assertNonNegativeCents(input.currentAvgCostCents, 'avg_cost');
  const tradeQty = Number(input.tradeQuantity);
  if (!Number.isFinite(tradeQty) || tradeQty <= 0) {
    throw new InvestmentRuleError('La cantidad a operar debe ser estrictamente mayor a 0.');
  }

  const tradePrice = assertPositiveCents(input.tradePriceCents, 'price');
  const fee = assertNonNegativeCents(input.feeCents ?? 0, 'fee');

  if (input.side === 'buy') {
    const previousTotalCost = currentQty * currentAvgCost;
    const buyTotalCost = tradeQty * tradePrice + fee;
    const nextQuantity = Number((currentQty + tradeQty).toFixed(8));
    const nextAvgCostCents = Math.round((previousTotalCost + buyTotalCost) / nextQuantity);

    return {
      nextQuantity,
      nextAvgCostCents: assertNonNegativeCents(nextAvgCostCents, 'next_avg_cost'),
      realizedGainCents: null,
    };
  }

  // Side === 'sell'
  if (tradeQty > currentQty + 1e-9) {
    throw new InvestmentRuleError(
      `No podés vender ${tradeQty} unidades porque solo tenés ${currentQty} disponibles en cartera.`
    );
  }

  const rawRemaining = currentQty - tradeQty;
  const nextQuantity = rawRemaining <= 1e-8 ? 0 : Number(rawRemaining.toFixed(8));

  // RN-02: Al vender parcialmente, el costo promedio de las unidades restantes NO cambia.
  // Si se vende la totalidad (nextQuantity === 0), el avg_cost vuelve a 0.
  const nextAvgCostCents = nextQuantity === 0 ? 0 : currentAvgCost;

  // Resultado realizado = (Precio de venta - Costo Promedio Ponderado) * Cantidad vendida - Comisión
  const grossDiffPerUnit = tradePrice - currentAvgCost;
  const realizedGainCents = Math.round(grossDiffPerUnit * tradeQty - fee);

  return {
    nextQuantity,
    nextAvgCostCents,
    realizedGainCents,
  };
}

export interface HoldingValuationMetrics {
  marketValueCents: number;
  totalCostCents: number;
  unrealizedGainCents: number;
  unrealizedGainPct: number;
}

/**
 * Calcula la valuación de mercado, el costo total invertido y el resultado no realizado (latente)
 * de una posición (tenencia) en centavos enteros.
 */
export function calculateHoldingMetrics(holding: Pick<HoldingRecord, 'quantity' | 'avg_cost' | 'last_price'>): HoldingValuationMetrics {
  const qty = Math.max(0, holding.quantity);
  const avgCost = assertNonNegativeCents(holding.avg_cost, 'avg_cost');
  const lastPrice = assertNonNegativeCents(holding.last_price, 'last_price');

  const marketValueCents = Math.round(qty * lastPrice);
  const totalCostCents = Math.round(qty * avgCost);
  const unrealizedGainCents = marketValueCents - totalCostCents;
  const unrealizedGainPct =
    totalCostCents > 0 ? Number(((unrealizedGainCents / totalCostCents) * 100).toFixed(2)) : 0;

  return {
    marketValueCents,
    totalCostCents,
    unrealizedGainCents,
    unrealizedGainPct,
  };
}

/**
 * Calcula el Patrimonio Total Bimonetario (V1 + V2) respetando RN-03 (Segregación Estricta de Monedas):
 * Patrimonio Total = Saldo de Cuentas Activas (V1) + Valor de Mercado de Carteras (V2) + Efectivo de Carteras (V2)
 */
export function calculateTotalWealth(params: {
  accounts: ReadonlyArray<AccountRecord>;
  transactions: ReadonlyArray<TransactionRecord>;
  portfolios: ReadonlyArray<PortfolioRecord>;
  holdings: ReadonlyArray<HoldingRecord>;
  assets: ReadonlyArray<AssetRecord>;
  portfolioCash: ReadonlyArray<PortfolioCashRecord>;
}): TotalWealthSummary {
  const accountsBalances = calculateConsolidatedBalances(params.accounts, params.transactions);
  const assetMap = new Map(params.assets.map((a) => [a.id, a]));
  const portfolioMap = new Map(params.portfolios.map((p) => [p.id, p]));

  let marketValueARS = 0;
  let marketValueUSD = 0;

  for (const h of params.holdings) {
    if (h.quantity <= 0) continue;
    const asset = assetMap.get(h.asset_id);
    const portfolio = portfolioMap.get(h.portfolio_id);
    const currency: Currency = asset?.currency ?? portfolio?.base_currency ?? 'ARS';
    const valCents = Math.round(h.quantity * h.last_price);

    if (currency === 'ARS') {
      marketValueARS += valCents;
    } else if (currency === 'USD') {
      marketValueUSD += valCents;
    }
  }

  let cashARS = 0;
  let cashUSD = 0;

  for (const cash of params.portfolioCash) {
    const validCash = assertNonNegativeCents(cash.amount, 'portfolio_cash');
    if (cash.currency === 'ARS') {
      cashARS += validCash;
    } else if (cash.currency === 'USD') {
      cashUSD += validCash;
    }
  }

  return {
    ARS: {
      accountsBalance: accountsBalances.ARS,
      portfoliosMarketValue: marketValueARS,
      portfoliosCash: cashARS,
      totalNetWorth: accountsBalances.ARS + marketValueARS + cashARS,
    },
    USD: {
      accountsBalance: accountsBalances.USD,
      portfoliosMarketValue: marketValueUSD,
      portfoliosCash: cashUSD,
      totalNetWorth: accountsBalances.USD + marketValueUSD + cashUSD,
    },
  };
}

/**
 * Regla de Dominio V2 (Cotizaciones Externas):
 * Yahoo Finance se invoca ÚNICAMENTE para activos con moneda 'USD' y que NO sean CEDEARs en ARS.
 * Prohibido auto-cotizar CEDEARs o activos en ARS a partir del subyacente en USD
 * debido a ratios de conversión y tipo de cambio CCL variable.
 */
export function canAutoQuoteWithYahoo(asset: Pick<AssetRecord, 'currency' | 'asset_class'>): boolean {
  return asset.currency === 'USD' && asset.asset_class !== 'cedear';
}

export interface CategoryExpenseSlice {
  categoryId: string | null;
  categoryName: string;
  amountCents: number;
  percentage: number;
}

/**
 * Calcula la distribución de gastos por categoría para una moneda y período opcional (YYYY-MM),
 * excluyendo transferencias (RN-01) y movimientos anulados (RN-07).
 */
export function calculateExpenseByCategory(params: {
  transactions: ReadonlyArray<TransactionRecord>;
  categories: ReadonlyArray<{ id: string; name: string }>;
  currency: Currency;
  monthYYYYMM?: string;
}): CategoryExpenseSlice[] {
  const catMap = new Map(params.categories.map((c) => [c.id, c.name]));
  const totalsByCat = new Map<string | null, number>();
  let grandTotal = 0;

  for (const tx of params.transactions) {
    if (tx.voided_at !== null) continue;
    if (tx.type !== 'expense') continue;
    if (tx.currency !== params.currency) continue;
    if (params.monthYYYYMM && !tx.date.startsWith(params.monthYYYYMM)) continue;

    const prev = totalsByCat.get(tx.category_id) ?? 0;
    totalsByCat.set(tx.category_id, prev + tx.amount);
    grandTotal += tx.amount;
  }

  if (grandTotal <= 0) return [];

  const slices: CategoryExpenseSlice[] = [];
  for (const [catId, amountCents] of totalsByCat.entries()) {
    const categoryName = catId ? (catMap.get(catId) ?? 'Otra Categoría') : 'Sin Categoría';
    const percentage = Number(((amountCents / grandTotal) * 100).toFixed(1));
    slices.push({
      categoryId: catId,
      categoryName,
      amountCents,
      percentage,
    });
  }

  slices.sort((a, b) => b.amountCents - a.amountCents);
  return slices;
}

export interface AssetAllocationSlice {
  label: string;
  subLabel: string;
  valueCents: number;
  percentage: number;
  kind: 'holding' | 'cash';
}

/**
 * Calcula la composición porcentual de la cartera (activos + liquidez en broker)
 * para una moneda específica sin mezclar divisas (RN-03).
 */
export function calculatePortfolioAllocation(params: {
  holdings: ReadonlyArray<HoldingRecord>;
  assets: ReadonlyArray<AssetRecord>;
  portfolios: ReadonlyArray<PortfolioRecord>;
  portfolioCash: ReadonlyArray<PortfolioCashRecord>;
  currency: Currency;
  portfolioIdFilter?: string;
}): AssetAllocationSlice[] {
  const assetMap = new Map(params.assets.map((a) => [a.id, a]));
  const portfolioMap = new Map(params.portfolios.map((p) => [p.id, p]));

  const items: Array<{ label: string; subLabel: string; valueCents: number; kind: 'holding' | 'cash' }> = [];
  let totalValue = 0;

  for (const h of params.holdings) {
    if (h.quantity <= 0) continue;
    if (
      params.portfolioIdFilter &&
      params.portfolioIdFilter !== 'ALL' &&
      h.portfolio_id !== params.portfolioIdFilter
    ) {
      continue;
    }
    const asset = assetMap.get(h.asset_id);
    const port = portfolioMap.get(h.portfolio_id);
    const curr = asset?.currency ?? port?.base_currency ?? 'ARS';
    if (curr !== params.currency) continue;

    const valCents = Math.round(h.quantity * h.last_price);
    if (valCents <= 0) continue;

    items.push({
      label: asset?.ticker ?? h.asset_id,
      subLabel: asset?.name ?? port?.name ?? '',
      valueCents: valCents,
      kind: 'holding',
    });
    totalValue += valCents;
  }

  let cashTotal = 0;
  for (const c of params.portfolioCash) {
    if (
      params.portfolioIdFilter &&
      params.portfolioIdFilter !== 'ALL' &&
      c.portfolio_id !== params.portfolioIdFilter
    ) {
      continue;
    }
    if (c.currency !== params.currency) continue;
    if (c.amount > 0) {
      cashTotal += c.amount;
    }
  }

  if (cashTotal > 0) {
    items.push({
      label: 'Liquidez (Efectivo)',
      subLabel: 'Disponible sin invertir en broker',
      valueCents: cashTotal,
      kind: 'cash',
    });
    totalValue += cashTotal;
  }

  if (totalValue <= 0) return [];

  items.sort((a, b) => b.valueCents - a.valueCents);

  return items.map((item) => ({
    ...item,
    percentage: Number(((item.valueCents / totalValue) * 100).toFixed(1)),
  }));
}

const KNOWN_TICKER_METADATA: Record<string, { name: string; asset_class: AssetClass }> = {
  AAPL: { name: 'Apple Inc.', asset_class: 'stock' },
  SPY: { name: 'SPDR S&P 500 ETF Trust', asset_class: 'stock' },
  QQQ: { name: 'Invesco QQQ Trust', asset_class: 'stock' },
  MSFT: { name: 'Microsoft Corporation', asset_class: 'stock' },
  NVDA: { name: 'NVIDIA Corporation', asset_class: 'stock' },
  GOOGL: { name: 'Alphabet Inc.', asset_class: 'stock' },
  AMZN: { name: 'Amazon.com Inc.', asset_class: 'stock' },
  MELI: { name: 'MercadoLibre Inc.', asset_class: 'stock' },
  KO: { name: 'The Coca-Cola Company', asset_class: 'stock' },
  TSLA: { name: 'Tesla Inc.', asset_class: 'stock' },
  GGAL: { name: 'Grupo Financiero Galicia', asset_class: 'stock' },
  YPFD: { name: 'YPF S.A.', asset_class: 'stock' },
  PAMP: { name: 'Pampa Energía S.A.', asset_class: 'stock' },
  AL30: { name: 'Bono Rep. Argentina Step Up 2030', asset_class: 'bond' },
  GD30: { name: 'Bono Global Rep. Argentina 2030', asset_class: 'bond' },
  AL35: { name: 'Bono Rep. Argentina 2035', asset_class: 'bond' },
  BTC: { name: 'Bitcoin', asset_class: 'crypto' },
  ETH: { name: 'Ethereum', asset_class: 'crypto' },
  USDT: { name: 'Tether USD', asset_class: 'crypto' },
};

const IGNORED_HEADER_WORDS = new Set([
  'ESPECIE',
  'ACTIVO',
  'TICKER',
  'CANTIDAD',
  'TENENCIA',
  'NOMINALES',
  'PRECIO',
  'PPC',
  'PPP',
  'COSTO',
  'TOTAL',
  'VALUACION',
  'RESULTADO',
  'VARIACION',
  'CARTERA',
  'PORTAFOLIO',
  'MONEDA',
  'SALDO',
  'PESOS',
  'DOLARES',
  'ARS',
  'USD',
]);

/**
 * Parser determinístico de capturas de portafolio de brokers (IOL, Balanz, Bull Market, PPI, Cocos, etc.)
 * Aplica estrictamente:
 * - Lección Técnica 2: Limpieza previa de TODOS los porcentajes (con 1, 2 o 3 decimales como "+12,340 %" o "-0,000%")
 *   ANTES de evaluar números o importes.
 * - Lección Técnica 1: Orden de alternancia en Regex de montos — SIEMPRE evaluar primero el patrón
 *   con separador de miles explícito (`\d{1,3}(?:\.\d{3})+`) y recién después el número plano (`\d+`).
 * - RN-05 (Cero Invención de Datos): Si un campo (ticker, cantidad, costo promedio o último precio)
 *   no puede determinarse con certeza, queda `null` y se marca en `uncertain_fields`.
 */
export function parsePortfolioSnapshotText(
  rawText: string,
  portfolioBaseCurrency: Currency,
  existingAssets: ReadonlyArray<AssetRecord> = []
): ParsedPortfolioSnapshotRow[] {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const assetByTicker = new Map(existingAssets.map((a) => [a.ticker.toUpperCase(), a]));
  const rows: ParsedPortfolioSnapshotRow[] = [];

  // Lección 1: Alternancia ordenada — primero miles explícitos (argentino o anglosajón), luego número plano
  const numberTokenRegex =
    /(?:^|[^\d.,+-])([+-]?(?:\d{1,3}(?:\.\d{3})+(?:,\d{1,4})?|\d{1,3}(?:,\d{3})+(?:\.\d{1,4})?|\d+(?:[.,]\d{1,4})?))(?=$|[^\d.,])/g;

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx];

    // Lección 2: Eliminar TODOS los porcentajes (ej. "0,000 %", "+14,25%", "-3.450 %") ANTES de extraer importes
    const withoutPercentages = rawLine.replace(/[+-]?\b\d+(?:[.,]\d{1,4})?\s*%/g, ' ');

    // Limpiar símbolos de moneda aislados para facilitar el escaneo de tokens
    const cleanedLine = withoutPercentages.replace(/\b(?:U\$S|US\$|USD|ARS)\b|\$/gi, ' ');

    // Buscar primer token alfanumérico que parezca un Ticker (2 a 6 letras/números, empezando con letra)
    const tokens = cleanedLine
      .split(/\s+/)
      .map((t) => t.replace(/[^A-Za-z0-9.]/g, '').toUpperCase())
      .filter((t) => t.length > 0);

    if (tokens.length === 0) continue;

    // Descartar líneas que sean puramente encabezados de tabla
    const headerHits = tokens.filter((t) => IGNORED_HEADER_WORDS.has(t)).length;
    if (headerHits >= 2) {
      continue;
    }

    let ticker: string | null = null;
    for (const token of tokens) {
      if (IGNORED_HEADER_WORDS.has(token)) continue;
      if (/^[A-Z]{2,5}[0-9]{0,2}$/.test(token)) {
        ticker = token;
        break;
      }
    }

    // Extraer todos los números de la línea (sin el ticker por si el ticker tiene números como AL30 o GD30)
    const lineWithoutTicker = ticker
      ? cleanedLine.replace(new RegExp(`\\b${ticker}\\b`, 'i'), ' ')
      : cleanedLine;

    const rawNumbers: string[] = [];
    let match: RegExpExecArray | null;
    numberTokenRegex.lastIndex = 0;
    while ((match = numberTokenRegex.exec(lineWithoutTicker)) !== null) {
      if (match[1]) {
        // Ignorar signos negativos correspondientes a pérdidas latentes si hay suficientes columnas
        rawNumbers.push(match[1]);
      }
    }

    // Si no hay ni ticker ni números en la línea, omitir ruido visual
    if (!ticker && rawNumbers.length === 0) {
      continue;
    }

    const positiveRawNumbers = rawNumbers.filter((n) => !n.startsWith('-'));
    const uncertain_fields: SnapshotRowUncertainField[] = [];

    if (!ticker) {
      uncertain_fields.push('ticker');
    }

    let quantity: number | null = null;
    let avg_cost: number | null = null;
    let last_price: number | null = null;

    if (positiveRawNumbers.length >= 1) {
      const qVal = parseFlexibleFloat(positiveRawNumbers[0]);
      if (qVal !== null && qVal >= 0) {
        quantity = qVal;
      } else {
        uncertain_fields.push('quantity');
      }
    } else {
      uncertain_fields.push('quantity');
    }

    if (positiveRawNumbers.length >= 2) {
      try {
        const c1 = toCents(positiveRawNumbers[1].replace(/^\+/, ''));
        if (c1 >= 0) {
          avg_cost = c1;
        } else {
          uncertain_fields.push('avg_cost');
        }
      } catch {
        uncertain_fields.push('avg_cost');
      }
    } else {
      uncertain_fields.push('avg_cost');
    }

    if (positiveRawNumbers.length >= 3) {
      try {
        const c2 = toCents(positiveRawNumbers[2].replace(/^\+/, ''));
        if (c2 >= 0) {
          last_price = c2;
        } else {
          uncertain_fields.push('last_price');
        }
      } catch {
        uncertain_fields.push('last_price');
      }
    } else {
      uncertain_fields.push('last_price');
    }

    const existing = ticker ? assetByTicker.get(ticker) : undefined;
    const known = ticker ? KNOWN_TICKER_METADATA[ticker] : undefined;

    let defaultClass: AssetClass = 'stock';
    if (existing) {
      defaultClass = existing.asset_class;
    } else if (known) {
      defaultClass =
        portfolioBaseCurrency === 'ARS' && known.asset_class === 'stock' && !['GGAL', 'YPFD', 'PAMP'].includes(ticker ?? '')
          ? 'cedear'
          : known.asset_class;
    } else if (portfolioBaseCurrency === 'ARS') {
      defaultClass = 'cedear';
    }

    const assetName = existing?.name ?? known?.name ?? (ticker ? `Activo ${ticker}` : '');

    rows.push({
      row_id: `snap-row-${idx + 1}`,
      raw_line: rawLine,
      ticker,
      asset_name: assetName,
      asset_class: defaultClass,
      quantity,
      avg_cost,
      last_price,
      uncertain_fields,
    });
  }

  return rows;
}

function parseFlexibleFloat(raw: string): number | null {
  const unsigned = raw.trim().replace(/^[+-]/, '');
  let normalized: string;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(unsigned)) {
    normalized = unsigned.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(unsigned)) {
    normalized = unsigned.replace(/,/g, '');
  } else if (/^\d+(,\d+)?$/.test(unsigned)) {
    normalized = unsigned.replace(',', '.');
  } else if (/^\d+(\.\d+)?$/.test(unsigned)) {
    normalized = unsigned;
  } else {
    return null;
  }
  const num = Number.parseFloat(normalized);
  return Number.isFinite(num) ? num : null;
}
