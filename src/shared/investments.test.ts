import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTradeToHolding,
  calculateExpenseByCategory,
  calculateHoldingMetrics,
  calculatePortfolioAllocation,
  calculateTotalWealth,
  canAutoQuoteWithYahoo,
  InvestmentRuleError,
  parsePortfolioSnapshotText,
} from './investments';
import type {
  AccountRecord,
  AssetRecord,
  HoldingRecord,
  PortfolioCashRecord,
  PortfolioRecord,
  TransactionRecord,
} from './types';

test('RN-02: Compras recalculan el Costo Promedio Ponderado (avg_cost) y ventas parciales NO cambian el avg_cost de las unidades restantes', () => {
  // 1. Primera compra: 10 unidades a $100,00 (10000 centavos) sin comisión
  const buy1 = applyTradeToHolding({
    currentQuantity: 0,
    currentAvgCostCents: 0,
    side: 'buy',
    tradeQuantity: 10,
    tradePriceCents: 10000,
    feeCents: 0,
  });
  assert.equal(buy1.nextQuantity, 10);
  assert.equal(buy1.nextAvgCostCents, 10000);
  assert.equal(buy1.realizedGainCents, null);

  // 2. Segunda compra: 10 unidades a $200,00 (20000 centavos) -> nuevo avg_cost debe ser $150,00 (15000 centavos)
  const buy2 = applyTradeToHolding({
    currentQuantity: buy1.nextQuantity,
    currentAvgCostCents: buy1.nextAvgCostCents,
    side: 'buy',
    tradeQuantity: 10,
    tradePriceCents: 20000,
    feeCents: 0,
  });
  assert.equal(buy2.nextQuantity, 20);
  assert.equal(buy2.nextAvgCostCents, 15000);
  assert.equal(buy2.realizedGainCents, null);

  // 3. Venta parcial: 5 unidades a $250,00 (25000 centavos) con comisión de $10,00 (1000 centavos)
  // Ganancia realizada esperada = (25000 - 15000) * 5 - 1000 = 50000 - 1000 = 49000 centavos ($490,00)
  // El avg_cost de las 15 unidades restantes DEBE mantenerse exactamente en 15000 centavos (RN-02)
  const sellPartial = applyTradeToHolding({
    currentQuantity: buy2.nextQuantity,
    currentAvgCostCents: buy2.nextAvgCostCents,
    side: 'sell',
    tradeQuantity: 5,
    tradePriceCents: 25000,
    feeCents: 1000,
  });
  assert.equal(sellPartial.nextQuantity, 15);
  assert.equal(sellPartial.nextAvgCostCents, 15000);
  assert.equal(sellPartial.realizedGainCents, 49000);

  // 4. Intentar vender más unidades de las disponibles lanza error de dominio
  assert.throws(() => {
    applyTradeToHolding({
      currentQuantity: 15,
      currentAvgCostCents: 15000,
      side: 'sell',
      tradeQuantity: 20,
      tradePriceCents: 25000,
    });
  }, InvestmentRuleError);
});

test('Valuación de tenencias (calculateHoldingMetrics): valor de mercado, costo total y resultado latente', () => {
  const metrics = calculateHoldingMetrics({
    quantity: 15,
    avg_cost: 15000, // $150,00
    last_price: 22000, // $220,00
  });
  assert.equal(metrics.totalCostCents, 225000); // $2.250,00
  assert.equal(metrics.marketValueCents, 330000); // $3.300,00
  assert.equal(metrics.unrealizedGainCents, 105000); // +$1.050,00
  assert.equal(metrics.unrealizedGainPct, 46.67);
});

test('Parser de captura de portafolio: aplica Lecciones 1 y 2 (limpieza de % con 3 decimales y números planos como 10580) y RN-05', () => {
  const rawOcr = [
    'Especie Cantidad PPC Precio Actual Variación Total',
    'AAPL 15 0,000 % 18.500,00 +12,450% 21.200,50 318.007,50',
    'GGAL 100 -2,340 % 10580 11200',
    'AL30 500',
  ].join('\n');

  const rows = parsePortfolioSnapshotText(rawOcr, 'ARS', []);
  assert.equal(rows.length, 3);

  // Fila 1: AAPL ignora "0,000 %" y "+12,450%" gracias a Lección 2
  assert.equal(rows[0].ticker, 'AAPL');
  assert.equal(rows[0].quantity, 15);
  assert.equal(rows[0].avg_cost, 1850000); // $18.500,00
  assert.equal(rows[0].last_price, 2120050); // $21.200,50
  assert.deepEqual(rows[0].uncertain_fields, []);

  // Fila 2: GGAL no trunca "10580" en "105" gracias a Lección 1
  assert.equal(rows[1].ticker, 'GGAL');
  assert.equal(rows[1].quantity, 100);
  assert.equal(rows[1].avg_cost, 1058000); // $10.580,00
  assert.equal(rows[1].last_price, 1120000); // $11.200,00
  assert.deepEqual(rows[1].uncertain_fields, []);

  // Fila 3: AL30 solo tiene cantidad -> RN-05 marca avg_cost y last_price como inciertos sin inventar datos
  assert.equal(rows[2].ticker, 'AL30');
  assert.equal(rows[2].quantity, 500);
  assert.equal(rows[2].avg_cost, null);
  assert.equal(rows[2].last_price, null);
  assert.deepEqual(rows[2].uncertain_fields, ['avg_cost', 'last_price']);
});

test('Patrimonio Total Bimonetario (V1 + V2) y regla de cotización Yahoo Finance (RN-03)', () => {
  const accounts: AccountRecord[] = [
    {
      id: 'a-ars',
      user_id: 'u1',
      name: 'Banco ARS',
      type: 'bank',
      currency: 'ARS',
      opening_balance: 50000000, // $500.000,00
      csv_column_map: null,
      archived: 0,
      created_at: 1,
    },
    {
      id: 'a-usd',
      user_id: 'u1',
      name: 'Banco USD',
      type: 'bank',
      currency: 'USD',
      opening_balance: 100000, // USD 1,000.00
      csv_column_map: null,
      archived: 0,
      created_at: 1,
    },
  ];

  const transactions: TransactionRecord[] = [];

  const portfolios: PortfolioRecord[] = [
    { id: 'p-ars', user_id: 'u1', name: 'Broker Local', broker: 'IOL', base_currency: 'ARS', created_at: 1 },
    { id: 'p-usd', user_id: 'u1', name: 'Broker Exterior', broker: 'IBKR', base_currency: 'USD', created_at: 1 },
  ];

  const assets: AssetRecord[] = [
    { id: 'as-cedear-spy', ticker: 'SPY.BA', name: 'CEDEAR SPY', asset_class: 'cedear', currency: 'ARS' },
    { id: 'as-us-spy', ticker: 'SPY', name: 'SPDR S&P 500 ETF', asset_class: 'stock', currency: 'USD' },
  ];

  // Prohibido auto-cotizar CEDEARs o activos en ARS con Yahoo Finance
  assert.equal(canAutoQuoteWithYahoo(assets[0]), false);
  assert.equal(canAutoQuoteWithYahoo(assets[1]), true);

  const holdings: HoldingRecord[] = [
    {
      id: 'h-1',
      user_id: 'u1',
      portfolio_id: 'p-ars',
      asset_id: 'as-cedear-spy',
      quantity: 10,
      avg_cost: 2500000,
      last_price: 3000000, // 10 * $30.000,00 = $300.000,00 (30000000 centavos)
      last_price_date: '2026-11-05',
    },
    {
      id: 'h-2',
      user_id: 'u1',
      portfolio_id: 'p-usd',
      asset_id: 'as-us-spy',
      quantity: 2,
      avg_cost: 50000,
      last_price: 58000, // 2 * USD 580.00 = USD 1,160.00 (116000 centavos)
      last_price_date: '2026-11-05',
    },
  ];

  const portfolioCash: PortfolioCashRecord[] = [
    { portfolio_id: 'p-ars', user_id: 'u1', currency: 'ARS', amount: 5000000 }, // $50.000,00
    { portfolio_id: 'p-usd', user_id: 'u1', currency: 'USD', amount: 0 }, // RN-06: $0,00 permitido
  ];

  const wealth = calculateTotalWealth({
    accounts,
    transactions,
    portfolios,
    holdings,
    assets,
    portfolioCash,
  });

  // ARS: 500.000 (cuentas) + 300.000 (cartera) + 50.000 (efectivo broker) = 850.000,00
  assert.equal(wealth.ARS.accountsBalance, 50000000);
  assert.equal(wealth.ARS.portfoliosMarketValue, 30000000);
  assert.equal(wealth.ARS.portfoliosCash, 5000000);
  assert.equal(wealth.ARS.totalNetWorth, 85000000);

  // USD: 1.000 (cuentas) + 1.160 (cartera) + 0 (efectivo broker) = 2.160,00
  assert.equal(wealth.USD.accountsBalance, 100000);
  assert.equal(wealth.USD.portfoliosMarketValue, 116000);
  assert.equal(wealth.USD.portfoliosCash, 0);
  assert.equal(wealth.USD.totalNetWorth, 216000);

  // Distribución porcentual de cartera en ARS (300.000 SPY.BA + 50.000 Liquidez = 350.000)
  const allocArs = calculatePortfolioAllocation({
    holdings,
    assets,
    portfolios,
    portfolioCash,
    currency: 'ARS',
  });
  assert.equal(allocArs.length, 2);
  assert.equal(allocArs[0].label, 'SPY.BA');
  assert.equal(allocArs[0].percentage, 85.7);
  assert.equal(allocArs[1].label, 'Liquidez (Efectivo)');
  assert.equal(allocArs[1].percentage, 14.3);

  // Distribución de gastos por categoría excluyendo transferencias y anulados
  const expenseSlices = calculateExpenseByCategory({
    transactions: [
      {
        id: 't1',
        user_id: 'u1',
        date: '2026-11-05',
        type: 'expense',
        account_id: 'a-ars',
        counter_account_id: null,
        category_id: 'c1',
        amount: 30000,
        currency: 'ARS',
        note: null,
        source: 'manual',
        voided_at: null,
        created_at: 1,
      },
      {
        id: 't2',
        user_id: 'u1',
        date: '2026-11-05',
        type: 'expense',
        account_id: 'a-ars',
        counter_account_id: null,
        category_id: 'c2',
        amount: 10000,
        currency: 'ARS',
        note: null,
        source: 'manual',
        voided_at: null,
        created_at: 1,
      },
      {
        id: 't3',
        user_id: 'u1',
        date: '2026-11-05',
        type: 'transfer',
        account_id: 'a-ars',
        counter_account_id: 'a-ars-2',
        category_id: null,
        amount: 90000,
        currency: 'ARS',
        note: null,
        source: 'manual',
        voided_at: null,
        created_at: 1,
      },
    ],
    categories: [
      { id: 'c1', name: 'Supermercado' },
      { id: 'c2', name: 'Transporte' },
    ],
    currency: 'ARS',
  });
  assert.equal(expenseSlices.length, 2);
  assert.equal(expenseSlices[0].categoryName, 'Supermercado');
  assert.equal(expenseSlices[0].percentage, 75);
  assert.equal(expenseSlices[1].categoryName, 'Transporte');
  assert.equal(expenseSlices[1].percentage, 25);
});

test('RN-02: recalculateHoldingFromTrades recalcula PPP y resultado realizado al editar o borrar operaciones', async () => {
  const { recalculateHoldingFromTrades } = await import('./investments');

  const initialTrades = [
    {
      id: 'tr-1',
      user_id: 'u1',
      portfolio_id: 'p1',
      asset_id: 'a1',
      side: 'buy' as const,
      quantity: 10,
      price: 10000, // $100,00
      fee: 0,
      date: '2026-11-01',
      settlement_account_id: null,
      realized_gain: null,
      note: null,
      created_at: 100,
    },
    {
      id: 'tr-2',
      user_id: 'u1',
      portfolio_id: 'p1',
      asset_id: 'a1',
      side: 'sell' as const,
      quantity: 4,
      price: 15000, // $150,00
      fee: 0,
      date: '2026-11-02',
      settlement_account_id: null,
      realized_gain: null,
      note: null,
      created_at: 200,
    },
  ];

  // Si se edita el precio de compra inicial de $100,00 a $120,00 (12000 centavos):
  const editedTrades = initialTrades.map((t) =>
    t.id === 'tr-1' ? { ...t, price: 12000 } : t
  );
  const recalc = recalculateHoldingFromTrades(editedTrades);
  assert.equal(recalc.quantity, 6);
  assert.equal(recalc.avgCostCents, 12000);
  const sellTrade = recalc.updatedTrades.find((t) => t.id === 'tr-2')!;
  // Ganancia realizada de vender 4 a $150 con PPP $120 = 4 * $30 = $120,00 (12000 centavos)
  assert.equal(sellTrade.realized_gain, 12000);

  // Si se borra la venta (tr-2), quedan las 10 unidades originales a $120,00:
  const afterDeleteSell = recalculateHoldingFromTrades([editedTrades[0]]);
  assert.equal(afterDeleteSell.quantity, 10);
  assert.equal(afterDeleteSell.avgCostCents, 12000);
});


