import { useMemo, useState, type FormEvent } from 'react';
import { Camera, Check, HelpCircle, Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
import { runBrowserOcr } from '../services/ocrService';
import {
  applyTradeToHolding,
  calculateHoldingMetrics,
  calculatePortfolioAllocation,
  canAutoQuoteWithYahoo,
  parsePortfolioSnapshotText,
} from '../shared/investments';
import { formatMoney, fromCents, toCents } from '../shared/money';
import type {
  AccountRecord,
  AssetClass,
  AssetRecord,
  Currency,
  HoldingRecord,
  ParsedPortfolioSnapshotRow,
  PortfolioCashRecord,
  PortfolioIncomeRecord,
  PortfolioIncomeType,
  PortfolioRecord,
  PortfolioSnapshotDraftRecord,
  TradeRecord,
  TradeSide,
} from '../shared/types';
import { SvgDonutChart } from './SvgDonutChart';

interface InvestmentsViewProps {
  accounts: ReadonlyArray<AccountRecord>;
  portfolios: ReadonlyArray<PortfolioRecord>;
  assets: ReadonlyArray<AssetRecord>;
  holdings: ReadonlyArray<HoldingRecord>;
  portfolioCash: ReadonlyArray<PortfolioCashRecord>;
  trades: ReadonlyArray<TradeRecord>;
  portfolioIncomes: ReadonlyArray<PortfolioIncomeRecord>;
  snapshotDrafts: ReadonlyArray<PortfolioSnapshotDraftRecord>;
  onCreatePortfolio: (input: {
    name: string;
    broker: string | null;
    base_currency: Currency;
  }) => Promise<PortfolioRecord>;
  onCreateAsset: (input: {
    ticker: string;
    name: string;
    asset_class: AssetClass;
    currency: Currency;
  }) => Promise<AssetRecord>;
  onUpdateHoldingPrice: (input: { id: string; last_price: number }) => Promise<void>;
  onUpdatePortfolioCash: (input: {
    portfolio_id: string;
    currency: Currency;
    amount: number;
  }) => Promise<void>;
  onRecordTrade: (input: {
    portfolio_id: string;
    asset_id: string;
    side: TradeSide;
    quantity: number;
    price: number;
    fee: number;
    date: string;
    settlement_account_id: string | null;
    note: string | null;
  }) => Promise<void>;
  onCreatePortfolioIncome: (input: {
    portfolio_id: string;
    asset_id: string | null;
    type: PortfolioIncomeType;
    amount: number;
    currency: Currency;
    date: string;
    note: string | null;
  }) => Promise<void>;
  onCreateSnapshotDraft: (input: {
    portfolio_id: string;
    raw_text: string;
    rows: ParsedPortfolioSnapshotRow[];
  }) => Promise<void>;
  onConfirmSnapshotDraft: (input: {
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
  }) => Promise<void>;
  onDiscardSnapshotDraft: (draftId: string) => Promise<void>;
  onRefreshUsdQuotes: () => Promise<{ updatedCount: number; skippedReasons: string[] }>;
}

type InvestmentsSubTab =
  | 'holdings'
  | 'trades'
  | 'snapshot'
  | 'incomes'
  | 'catalog';

const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  stock: 'Acción / ETF',
  cedear: 'CEDEAR',
  bond: 'Bono / ON',
  crypto: 'Cripto',
  fci: 'Fondo Común (FCI)',
  other: 'Otro',
};

const ALLOCATION_COLORS = [
  '#6366f1', // indigo-500
  '#0ea5e9', // sky-500
  '#10b981', // emerald-500
  '#f59e0b', // amber-500
  '#8b5cf6', // violet-500
  '#ec4899', // pink-500
  '#06b6d4', // cyan-500
  '#64748b', // slate-500
];

function getTodayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function InvestmentsView({
  accounts,
  portfolios,
  assets,
  holdings,
  portfolioCash,
  trades,
  portfolioIncomes,
  snapshotDrafts,
  onCreatePortfolio,
  onCreateAsset,
  onUpdateHoldingPrice,
  onUpdatePortfolioCash,
  onRecordTrade,
  onCreatePortfolioIncome,
  onCreateSnapshotDraft,
  onConfirmSnapshotDraft,
  onDiscardSnapshotDraft,
  onRefreshUsdQuotes,
}: InvestmentsViewProps) {
  const [subTab, setSubTab] = useState<InvestmentsSubTab>('holdings');
  const [selectedPortfolioId, setSelectedPortfolioId] = useState<string>('ALL');
  const [showGlossary, setShowGlossary] = useState<boolean>(false);
  const [allocationCurrency, setAllocationCurrency] = useState<Currency>('ARS');
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Estado edición inline de último precio conocido
  const [editingPriceHoldingId, setEditingPriceHoldingId] = useState<string | null>(null);
  const [editingPriceValue, setEditingPriceValue] = useState<string>('');

  // Estado edición inline de efectivo líquido en el broker (portfolio_cash)
  const [editingCashKey, setEditingCashKey] = useState<string | null>(null);
  const [editingCashValue, setEditingCashValue] = useState<string>('');

  // Estado formulario operación de compra/venta (Trade)
  const [tradePortfolioId, setTradePortfolioId] = useState<string>(portfolios[0]?.id ?? '');
  const [tradeSide, setTradeSide] = useState<TradeSide>('buy');
  const [tradeAssetId, setTradeAssetId] = useState<string>(assets[0]?.id ?? '');
  const [tradeQty, setTradeQty] = useState<string>('');
  const [tradePrice, setTradePrice] = useState<string>('');
  const [tradeFee, setTradeFee] = useState<string>('0');
  const [tradeDate, setTradeDate] = useState<string>(getTodayIso());
  const [tradeSettlementAcc, setTradeSettlementAcc] = useState<string>('');
  const [tradeNote, setTradeNote] = useState<string>('');

  // Estado formulario Reconstrucción desde Captura (Staging OCR / Texto)
  const [snapPortfolioId, setSnapPortfolioId] = useState<string>(portfolios[0]?.id ?? '');
  const [snapRawText, setSnapRawText] = useState<string>('');
  const [ocrProgress, setOcrProgress] = useState<number | null>(null);

  // Estado formulario Dividendo / Interés
  const [incPortfolioId, setIncPortfolioId] = useState<string>(portfolios[0]?.id ?? '');
  const [incAssetId, setIncAssetId] = useState<string>('');
  const [incType, setIncType] = useState<PortfolioIncomeType>('dividend');
  const [incAmount, setIncAmount] = useState<string>('');
  const [incCurrency, setIncCurrency] = useState<Currency>('USD');
  const [incDate, setIncDate] = useState<string>(getTodayIso());
  const [incNote, setIncNote] = useState<string>('');

  // Estado formulario Nueva Cartera
  const [newPortName, setNewPortName] = useState<string>('');
  const [newPortBroker, setNewPortBroker] = useState<string>('');
  const [newPortCurrency, setNewPortCurrency] = useState<Currency>('ARS');

  // Estado formulario Nuevo Activo (Maestro)
  const [newAssetTicker, setNewAssetTicker] = useState<string>('');
  const [newAssetName, setNewAssetName] = useState<string>('');
  const [newAssetClass, setNewAssetClass] = useState<AssetClass>('cedear');
  const [newAssetCurrency, setNewAssetCurrency] = useState<Currency>('ARS');

  const portfolioMap = useMemo(() => new Map(portfolios.map((p) => [p.id, p])), [portfolios]);
  const assetMap = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const visibleHoldings = useMemo(
    () =>
      holdings.filter((h) => {
        if (h.quantity <= 0) return false;
        if (selectedPortfolioId !== 'ALL' && h.portfolio_id !== selectedPortfolioId) return false;
        return true;
      }),
    [holdings, selectedPortfolioId]
  );

  // Calcular subtotales de inversiones segregados por moneda (RN-03)
  const { totalMarketARS, totalCostARS, totalMarketUSD, totalCostUSD, totalCashARS, totalCashUSD } =
    useMemo(() => {
      let mARS = 0;
      let cARS = 0;
      let mUSD = 0;
      let cUSD = 0;

      for (const h of visibleHoldings) {
        const asset = assetMap.get(h.asset_id);
        const port = portfolioMap.get(h.portfolio_id);
        const currency = asset?.currency ?? port?.base_currency ?? 'ARS';
        const m = calculateHoldingMetrics(h);
        if (currency === 'ARS') {
          mARS += m.marketValueCents;
          cARS += m.totalCostCents;
        } else {
          mUSD += m.marketValueCents;
          cUSD += m.totalCostCents;
        }
      }

      let cashARS = 0;
      let cashUSD = 0;
      for (const c of portfolioCash) {
        if (selectedPortfolioId !== 'ALL' && c.portfolio_id !== selectedPortfolioId) continue;
        if (c.currency === 'ARS') cashARS += c.amount;
        else cashUSD += c.amount;
      }

      return {
        totalMarketARS: mARS,
        totalCostARS: cARS,
        totalMarketUSD: mUSD,
        totalCostUSD: cUSD,
        totalCashARS: cashARS,
        totalCashUSD: cashUSD,
      };
    }, [visibleHoldings, assetMap, portfolioMap, portfolioCash, selectedPortfolioId]);

  const allocationARS = useMemo(
    () =>
      calculatePortfolioAllocation({
        holdings: visibleHoldings,
        assets,
        portfolios,
        portfolioCash,
        currency: 'ARS',
        portfolioIdFilter: selectedPortfolioId,
      }),
    [visibleHoldings, assets, portfolios, portfolioCash, selectedPortfolioId]
  );
  const allocationUSD = useMemo(
    () =>
      calculatePortfolioAllocation({
        holdings: visibleHoldings,
        assets,
        portfolios,
        portfolioCash,
        currency: 'USD',
        portfolioIdFilter: selectedPortfolioId,
      }),
    [visibleHoldings, assets, portfolios, portfolioCash, selectedPortfolioId]
  );
  const activeAllocation = allocationCurrency === 'ARS' ? allocationARS : allocationUSD;

  // Simulador en vivo para el formulario de Compra / Venta
  const tradePreview = useMemo(() => {
    const targetPortfolioId = tradePortfolioId || portfolios[0]?.id;
    const targetAssetId = tradeAssetId || assets[0]?.id;
    if (!targetPortfolioId || !targetAssetId) return null;

    const asset = assetMap.get(targetAssetId);
    const port = portfolioMap.get(targetPortfolioId);
    const currency = asset?.currency ?? port?.base_currency ?? 'ARS';
    const existingHolding = holdings.find(
      (h) => h.portfolio_id === targetPortfolioId && h.asset_id === targetAssetId
    );
    const currentQty = existingHolding?.quantity ?? 0;
    const currentAvgCost = existingHolding?.avg_cost ?? 0;

    const qtyNum = Number.parseFloat(tradeQty.replace(',', '.'));
    if (!Number.isFinite(qtyNum) || qtyNum <= 0 || !tradePrice.trim()) {
      return {
        status: 'incomplete' as const,
        currency,
        ticker: asset?.ticker ?? '',
        currentQty,
        currentAvgCost,
      };
    }

    try {
      const priceCents = toCents(tradePrice);
      const feeCents = tradeFee.trim() ? toCents(tradeFee) : 0;
      const grossCents = Math.round(qtyNum * priceCents);
      const totalCents =
        tradeSide === 'buy' ? grossCents + feeCents : Math.max(0, grossCents - feeCents);

      const simulation = applyTradeToHolding({
        currentQuantity: currentQty,
        currentAvgCostCents: currentAvgCost,
        side: tradeSide,
        tradeQuantity: qtyNum,
        tradePriceCents: priceCents,
        feeCents,
      });

      return {
        status: 'ready' as const,
        currency,
        ticker: asset?.ticker ?? '',
        currentQty,
        currentAvgCost,
        totalCents,
        newQuantity: simulation.nextQuantity,
        newAvgCostCents: simulation.nextAvgCostCents,
        realizedGainCents: simulation.realizedGainCents,
      };
    } catch (err) {
      return {
        status: 'error' as const,
        currency,
        ticker: asset?.ticker ?? '',
        currentQty,
        currentAvgCost,
        errorMessage: err instanceof Error ? err.message : 'Revisá los valores ingresados.',
      };
    }
  }, [
    tradePortfolioId,
    portfolios,
    tradeAssetId,
    assets,
    assetMap,
    portfolioMap,
    holdings,
    tradeQty,
    tradePrice,
    tradeFee,
    tradeSide,
  ]);

  const handleYahooRefresh = async () => {
    setFeedback(null);
    try {
      const res = await onRefreshUsdQuotes();
      const skipMsg =
        res.skippedReasons.length > 0
          ? ` (${res.skippedReasons.length} activos en ARS/CEDEAR omitidos por regla de dominio)`
          : '';
      setFeedback({
        type: 'ok',
        text: `Cotizaciones Yahoo Finance actualizadas para ${res.updatedCount} activos en USD.${skipMsg}`,
      });
    } catch (e) {
      setFeedback({
        type: 'err',
        text: e instanceof Error ? e.message : 'Error al consultar Yahoo Finance.',
      });
    }
  };

  const handleSubmitTrade = async (e: FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    const targetPortfolioId = tradePortfolioId || portfolios[0]?.id;
    const targetAssetId = tradeAssetId || assets[0]?.id;
    if (!targetPortfolioId || !targetAssetId) {
      setFeedback({ type: 'err', text: 'Seleccioná una cartera y un activo válido.' });
      return;
    }

    const qtyNum = Number.parseFloat(tradeQty.replace(',', '.'));
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      setFeedback({ type: 'err', text: 'La cantidad debe ser un número mayor a 0.' });
      return;
    }

    try {
      const priceCents = toCents(tradePrice);
      const feeCents = tradeFee.trim() ? toCents(tradeFee) : 0;

      await onRecordTrade({
        portfolio_id: targetPortfolioId,
        asset_id: targetAssetId,
        side: tradeSide,
        quantity: qtyNum,
        price: priceCents,
        fee: feeCents,
        date: tradeDate,
        settlement_account_id: tradeSettlementAcc || null,
        note: tradeNote.trim() || null,
      });

      setTradeQty('');
      setTradePrice('');
      setTradeFee('0');
      setTradeNote('');
      setFeedback({
        type: 'ok',
        text:
          tradeSide === 'buy'
            ? 'Compra registrada: el Precio Promedio de Compra (PPP) fue recalculado automáticamente.'
            : 'Venta registrada: se calculó tu ganancia/pérdida realizada sin alterar el precio promedio de las unidades que conservás (RN-02).',
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Error al registrar operación.',
      });
    }
  };

  const handleAnalyzeSnapshot = async (e: FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    const targetPortfolioId = snapPortfolioId || portfolios[0]?.id;
    const port = portfolioMap.get(targetPortfolioId);
    if (!port) {
      setFeedback({ type: 'err', text: 'Seleccioná una cartera destino para la captura.' });
      return;
    }
    if (!snapRawText.trim()) {
      setFeedback({ type: 'err', text: 'Pegá el texto de la captura o subí una imagen para analizar.' });
      return;
    }

    const rows = parsePortfolioSnapshotText(snapRawText, port.base_currency, assets);
    if (rows.length === 0) {
      setFeedback({
        type: 'err',
        text: 'No se detectaron filas de tenencias. Verificá que cada línea incluya al menos un Ticker o cantidad.',
      });
      return;
    }

    await onCreateSnapshotDraft({
      portfolio_id: port.id,
      raw_text: snapRawText,
      rows,
    });
    setSnapRawText('');
    setFeedback({
      type: 'ok',
      text: `Se creó un borrador de cartera en staging con ${rows.length} fila(s) para revisión obligatoria (RN-04).`,
    });
  };

  const handleSnapshotImageUpload = async (file: File) => {
    setFeedback(null);
    setOcrProgress(5);
    try {
      const res = await runBrowserOcr(file, (pct) => setOcrProgress(pct));
      setSnapRawText(res.text);
      setFeedback({
        type: 'ok',
        text: `OCR completado en navegador (${res.confidence}% confianza). Revisá el texto o generá la tabla de borrador.`,
      });
    } catch {
      setFeedback({
        type: 'err',
        text: 'El motor OCR no pudo procesar la imagen. Podés pegar o escribir las filas manualmente abajo.',
      });
    } finally {
      setOcrProgress(null);
    }
  };

  const handleSubmitIncome = async (e: FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    const targetPortfolioId = incPortfolioId || portfolios[0]?.id;
    if (!targetPortfolioId) {
      setFeedback({ type: 'err', text: 'Seleccioná una cartera.' });
      return;
    }
    try {
      const amountCents = toCents(incAmount);
      await onCreatePortfolioIncome({
        portfolio_id: targetPortfolioId,
        asset_id: incAssetId || null,
        type: incType,
        amount: amountCents,
        currency: incCurrency,
        date: incDate,
        note: incNote.trim() || null,
      });
      setIncAmount('');
      setIncNote('');
      setFeedback({
        type: 'ok',
        text: 'Rendimiento de cartera (dividendo/interés) registrado correctamente.',
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Error al registrar dividendo/interés.',
      });
    }
  };

  const handleCreatePortfolioSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    if (!newPortName.trim()) {
      setFeedback({ type: 'err', text: 'El nombre de la cartera es obligatorio.' });
      return;
    }
    try {
      const created = await onCreatePortfolio({
        name: newPortName.trim(),
        broker: newPortBroker.trim() || null,
        base_currency: newPortCurrency,
      });
      setNewPortName('');
      setNewPortBroker('');
      if (!tradePortfolioId) setTradePortfolioId(created.id);
      if (!snapPortfolioId) setSnapPortfolioId(created.id);
      setFeedback({ type: 'ok', text: `Cartera "${created.name}" creada en ${created.base_currency}.` });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Error al crear cartera.',
      });
    }
  };

  const handleCreateAssetSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    if (!newAssetTicker.trim() || !newAssetName.trim()) {
      setFeedback({ type: 'err', text: 'El ticker y el nombre del activo son obligatorios.' });
      return;
    }
    try {
      const created = await onCreateAsset({
        ticker: newAssetTicker.trim().toUpperCase(),
        name: newAssetName.trim(),
        asset_class: newAssetClass,
        currency: newAssetCurrency,
      });
      setNewAssetTicker('');
      setNewAssetName('');
      if (!tradeAssetId) setTradeAssetId(created.id);
      setFeedback({
        type: 'ok',
        text: `Activo ${created.ticker} (${created.name}) registrado en el maestro de activos.`,
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Error al crear activo.',
      });
    }
  };

  return (
    <div className="space-y-8">
      {/* Encabezado y Acciones Superiores */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
            Inversiones y Carteras
          </h1>
          <div className="flex flex-wrap items-center gap-2.5 text-sm text-slate-600 mt-1.5">
            <span>Seguimiento claro de cuánto invertiste, cuánto vale hoy y cuánto ganaste</span>
            <button
              type="button"
              onClick={() => setShowGlossary((prev) => !prev)}
              className="btn-accent-soft py-1 px-2.5 text-xs"
            >
              <HelpCircle className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{showGlossary ? 'Ocultar diccionario simple' : '¿Qué significan estos términos?'}</span>
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={handleYahooRefresh}
            className="btn-secondary py-2 px-3.5 text-xs sm:text-sm whitespace-nowrap"
          >
            <RefreshCw className="w-4 h-4" aria-hidden="true" />
            <span>Actualizar precios USD (Yahoo)</span>
          </button>
        </div>
      </div>

      {/* Diccionario simple para personas no economistas */}
      {showGlossary && (
        <section
          aria-label="Explicación simple de términos de inversión"
          className="bg-white border border-slate-200 rounded-xl p-5 grid grid-cols-1 md:grid-cols-4 gap-4 text-xs text-slate-600"
        >
          <div className="space-y-1">
            <p className="font-semibold text-slate-900">1. Costo Promedio (PPP)</p>
            <p>
              Es el precio promedio al que compraste cada unidad de un activo (incluyendo comisiones). Te sirve para saber a partir de qué precio estás ganando dinero.
            </p>
          </div>
          <div className="space-y-1">
            <p className="font-semibold text-slate-900">2. Resultado Latente (No vendido)</p>
            <p>
              Es lo que vas ganando o perdiendo "en los papeles" según el precio de hoy, pero sin haber vendido todavía tus activos.
            </p>
          </div>
          <div className="space-y-1">
            <p className="font-semibold text-slate-900">3. Resultado Realizado (Al vender)</p>
            <p>
              Cuando vendés una parte o todo, la ganancia o pérdida se vuelve real. El costo promedio de las unidades que te quedan no se altera (RN-02).
            </p>
          </div>
          <div className="space-y-1">
            <p className="font-semibold text-slate-900">4. Efectivo en Broker</p>
            <p>
              Es el dinero que ya transferiste a tu cuenta de inversión (ej. IOL, Balanz, PPI) y está listo para invertir o retirar.
            </p>
          </div>
        </section>
      )}

      {feedback && (
        <div
          role="status"
          className={`p-3.5 rounded-lg border text-sm ${
            feedback.type === 'ok'
              ? 'bg-emerald-50/70 border-emerald-200 text-emerald-900'
              : 'bg-red-50/70 border-red-200 text-red-900'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* Resumen Bimonetario de Carteras (RN-03: ARS y USD estrictamente separados) */}
      <section aria-label="Valuación consolidada de carteras" className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Cartera ARS */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-slate-500">
                Total en Carteras en Pesos (Activos + Efectivo Broker)
              </span>
              <span className="text-xs font-mono text-slate-500">ARS</span>
            </div>
            <p
              data-testid="investments-total-ars"
              className="text-2xl font-semibold text-slate-900 font-mono tabular-nums tracking-tight"
            >
              {formatMoney(totalMarketARS + totalCashARS, 'ARS')}
            </p>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100 grid grid-cols-3 gap-3 text-xs">
            <div>
              <span className="text-slate-500 block">Invertido (Costo)</span>
              <span className="font-mono tabular-nums font-medium text-slate-700 mt-0.5 block">
                {formatMoney(totalCostARS, 'ARS')}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">Valor Hoy (Mercado)</span>
              <span className="font-mono tabular-nums font-medium text-slate-900 mt-0.5 block">
                {formatMoney(totalMarketARS, 'ARS')}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">Ganancia / Pérdida</span>
              <span
                className={`font-mono tabular-nums font-medium mt-0.5 block ${
                  totalMarketARS - totalCostARS >= 0 ? 'text-emerald-700' : 'text-red-700'
                }`}
              >
                {totalMarketARS - totalCostARS >= 0 ? '+' : ''}
                {formatMoney(totalMarketARS - totalCostARS, 'ARS')}
              </span>
            </div>
          </div>

          <div className="mt-3 pt-2.5 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
            <span>Efectivo disponible en brokers (ARS):</span>
            <span className="font-mono tabular-nums font-medium text-slate-900">
              {formatMoney(totalCashARS, 'ARS')}
            </span>
          </div>
        </div>

        {/* Cartera USD */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-slate-500">
                Total en Carteras en Dólares (Activos + Efectivo Broker)
              </span>
              <span className="text-xs font-mono text-slate-500">USD</span>
            </div>
            <p
              data-testid="investments-total-usd"
              className="text-2xl font-semibold text-slate-900 font-mono tabular-nums tracking-tight"
            >
              {formatMoney(totalMarketUSD + totalCashUSD, 'USD')}
            </p>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100 grid grid-cols-3 gap-3 text-xs">
            <div>
              <span className="text-slate-500 block">Invertido (Costo)</span>
              <span className="font-mono tabular-nums font-medium text-slate-700 mt-0.5 block">
                {formatMoney(totalCostUSD, 'USD')}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">Valor Hoy (Mercado)</span>
              <span className="font-mono tabular-nums font-medium text-slate-900 mt-0.5 block">
                {formatMoney(totalMarketUSD, 'USD')}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">Ganancia / Pérdida</span>
              <span
                className={`font-mono tabular-nums font-medium mt-0.5 block ${
                  totalMarketUSD - totalCostUSD >= 0 ? 'text-emerald-700' : 'text-red-700'
                }`}
              >
                {totalMarketUSD - totalCostUSD >= 0 ? '+' : ''}
                {formatMoney(totalMarketUSD - totalCostUSD, 'USD')}
              </span>
            </div>
          </div>

          <div className="mt-3 pt-2.5 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
            <span>Efectivo disponible en brokers (USD):</span>
            <span className="font-mono tabular-nums font-medium text-slate-900">
              {formatMoney(totalCashUSD, 'USD')}
            </span>
          </div>
        </div>
      </section>

      {/* Selector de Sub-sección Funcional */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-3">
        <div className="flex flex-wrap items-center gap-1.5 p-1 bg-slate-100 border border-slate-200 rounded-xl">
          <button
            type="button"
            onClick={() => setSubTab('holdings')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
              subTab === 'holdings'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-700 hover:bg-white hover:text-slate-900'
            }`}
          >
            Mis Inversiones y Gráficos
          </button>
          <button
            type="button"
            onClick={() => setSubTab('trades')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
              subTab === 'trades'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-700 hover:bg-white hover:text-slate-900'
            }`}
          >
            Operar Compra / Venta
          </button>
          <button
            type="button"
            onClick={() => setSubTab('snapshot')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
              subTab === 'snapshot'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-700 hover:bg-white hover:text-slate-900'
            }`}
          >
            Reconstruir por Captura
            {snapshotDrafts.length > 0 ? ` (${snapshotDrafts.length})` : ''}
          </button>
          <button
            type="button"
            onClick={() => setSubTab('incomes')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
              subTab === 'incomes'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-700 hover:bg-white hover:text-slate-900'
            }`}
          >
            Dividendos e Intereses
          </button>
          <button
            type="button"
            onClick={() => setSubTab('catalog')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
              subTab === 'catalog'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-700 hover:bg-white hover:text-slate-900'
            }`}
          >
            Carteras y Activos
          </button>
        </div>

        {/* Filtro rápido por cartera */}
        <div className="flex items-center gap-2">
          <label htmlFor="portfolio-filter" className="text-xs font-medium text-slate-600">
            Cartera:
          </label>
          <select
            id="portfolio-filter"
            value={selectedPortfolioId}
            onChange={(e) => setSelectedPortfolioId(e.target.value)}
            className="py-1.5 px-2.5 text-xs rounded-lg border border-slate-200 bg-white text-slate-900"
          >
            <option value="ALL">Todas las carteras ({portfolios.length})</option>
            {portfolios.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.base_currency})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* SUB-VISTA 1: TENENCIAS, GRÁFICO DE COMPOSICIÓN Y EFECTIVO LÍQUIDO EN BROKERS */}
      {subTab === 'holdings' && (
        <div className="space-y-6">
          {/* Gráfico de Distribución de Cartera (ARS / USD separados) */}
          <section
            aria-label="Gráfico de composición de cartera"
            className="bg-white border border-slate-200 rounded-xl p-6"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  ¿Cómo está distribuida tu cartera de inversión?
                </h2>
                <p className="text-xs text-slate-500">
                  Proporción de cada activo sobre el total invertido y su rendimiento acumulado.
                </p>
              </div>
              <div className="inline-flex gap-1 p-1 rounded-lg bg-slate-100 border border-slate-200 self-start">
                <button
                  type="button"
                  onClick={() => setAllocationCurrency('ARS')}
                  className={`px-3 py-1.5 text-xs font-mono font-semibold rounded-md transition-colors cursor-pointer ${
                    allocationCurrency === 'ARS'
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'text-slate-700 hover:bg-white'
                  }`}
                >
                  Activos ARS ({allocationARS.length})
                </button>
                <button
                  type="button"
                  onClick={() => setAllocationCurrency('USD')}
                  className={`px-3 py-1.5 text-xs font-mono font-semibold rounded-md transition-colors cursor-pointer ${
                    allocationCurrency === 'USD'
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'text-slate-700 hover:bg-white'
                  }`}
                >
                  Activos USD ({allocationUSD.length})
                </button>
              </div>
            </div>

            {activeAllocation.length === 0 ? (
              <div className="py-6 text-center text-sm text-slate-500">
                No tenés activos valuados en {allocationCurrency} en la cartera seleccionada.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
                <div className="md:col-span-4 flex justify-center">
                  <SvgDonutChart
                    slices={activeAllocation.map((item, idx) => ({
                      label: item.label,
                      percentage: item.percentage,
                      color: ALLOCATION_COLORS[idx % ALLOCATION_COLORS.length],
                    }))}
                    centerTitle={allocationCurrency}
                    centerSubtitle={`${activeAllocation.length} posiciones`}
                  />
                </div>
                <div className="md:col-span-8 space-y-3">
                  {activeAllocation.map((item, idx) => {
                    const color = ALLOCATION_COLORS[idx % ALLOCATION_COLORS.length];
                    return (
                      <div key={`${item.label}-${idx}`} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className="w-2.5 h-2.5 rounded-xs shrink-0"
                              style={{ backgroundColor: color }}
                            />
                            <span className="font-mono font-semibold text-slate-900">
                              {item.label}
                            </span>
                            <span className="text-slate-500 truncate">{item.subLabel}</span>
                          </div>
                          <div className="flex items-center gap-3 font-mono tabular-nums shrink-0">
                            <span className="font-semibold text-slate-900">
                              {formatMoney(item.valueCents, allocationCurrency)}
                            </span>
                            <span className="text-slate-500 w-12 text-right">
                              {item.percentage}%
                            </span>
                          </div>
                        </div>
                        <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{
                              width: `${Math.min(100, Math.max(2, item.percentage))}%`,
                              backgroundColor: color,
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

          <section className="bg-white border border-slate-200 rounded-xl p-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Detalle de tus Inversiones (Posiciones en Cartera)
                </h2>
                <p className="text-xs text-slate-500">
                  Hacé clic sobre el "Precio Hoy" de cualquier activo para actualizar su cotización manualmente.
                </p>
              </div>
            </div>

            {visibleHoldings.length === 0 ? (
              <div className="py-10 text-center">
                <p className="text-sm text-slate-500 mb-3">
                  No hay tenencias activas en la cartera seleccionada.
                </p>
                <div className="flex items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => setSubTab('trades')}
                    className="py-2 px-3.5 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 cursor-pointer"
                  >
                    Registrar Compra
                  </button>
                  <button
                    type="button"
                    onClick={() => setSubTab('snapshot')}
                    className="py-2 px-3.5 rounded-lg border border-slate-200 bg-white text-slate-700 text-xs font-medium hover:bg-slate-50 cursor-pointer"
                  >
                    Importar Captura de Broker
                  </button>
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs font-medium text-slate-500">
                      <th className="py-2.5 pr-3">Activo</th>
                      <th className="py-2.5 px-3">Cartera</th>
                      <th className="py-2.5 px-3 text-right">Cantidad</th>
                      <th className="py-2.5 px-3 text-right">
                        <div>Precio Compra Prom.</div>
                        <div className="text-[10px] font-normal text-slate-400">PPP Unitario</div>
                      </th>
                      <th className="py-2.5 px-3 text-right">
                        <div>Precio Hoy</div>
                        <div className="text-[10px] font-normal text-slate-400">Click para editar</div>
                      </th>
                      <th className="py-2.5 px-3 text-right">
                        <div>Cuánto Vale Hoy</div>
                        <div className="text-[10px] font-normal text-slate-400">vs. Invertido</div>
                      </th>
                      <th className="py-2.5 pl-3 text-right">
                        <div>Ganancia / Pérdida</div>
                        <div className="text-[10px] font-normal text-slate-400">Latente hoy</div>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {visibleHoldings.map((h) => {
                      const asset = assetMap.get(h.asset_id);
                      const port = portfolioMap.get(h.portfolio_id);
                      const currency = asset?.currency ?? port?.base_currency ?? 'ARS';
                      const metrics = calculateHoldingMetrics(h);
                      const isEditingPrice = editingPriceHoldingId === h.id;

                      return (
                        <tr key={h.id} className="hover:bg-slate-50/80">
                          <td className="py-3 pr-3">
                            <div className="font-mono font-semibold text-slate-900">
                              {asset?.ticker ?? h.asset_id}
                            </div>
                            <div className="text-xs text-slate-500">
                              {asset?.name} · {asset ? ASSET_CLASS_LABELS[asset.asset_class] : ''} · {currency}
                            </div>
                          </td>
                          <td className="py-3 px-3 text-xs text-slate-600">
                            <div className="font-medium text-slate-800">{port?.name}</div>
                            {port?.broker && <div className="text-slate-500">{port.broker}</div>}
                          </td>
                          <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-900">
                            {h.quantity}
                          </td>
                          <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-700">
                            {formatMoney(h.avg_cost, currency)}
                          </td>
                          <td className="py-3 px-3 text-right font-mono tabular-nums">
                            {isEditingPrice ? (
                              <div className="inline-flex items-center justify-end gap-1.5">
                                <input
                                  type="text"
                                  aria-label={`Nuevo precio para ${asset?.ticker ?? 'activo'}`}
                                  value={editingPriceValue}
                                  onChange={(e) => setEditingPriceValue(e.target.value)}
                                  className="w-28 py-1 px-2 text-xs font-mono text-right border border-slate-300 rounded bg-white"
                                />
                                <button
                                  type="button"
                                  onClick={async () => {
                                    try {
                                      const cents = toCents(editingPriceValue);
                                      await onUpdateHoldingPrice({ id: h.id, last_price: cents });
                                      setEditingPriceHoldingId(null);
                                      setFeedback({
                                        type: 'ok',
                                        text: `Precio de ${asset?.ticker ?? 'activo'} actualizado.`,
                                      });
                                    } catch (err) {
                                      setFeedback({
                                        type: 'err',
                                        text:
                                          err instanceof Error
                                            ? err.message
                                            : 'Precio inválido.',
                                      });
                                    }
                                  }}
                                  className="btn-primary p-1.5 text-xs"
                                  aria-label={`Guardar precio de ${asset?.ticker ?? 'activo'}`}
                                >
                                  <Check className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ) : (
                              <div>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingPriceHoldingId(h.id);
                                    setEditingPriceValue(String(fromCents(h.last_price)));
                                  }}
                                  className="btn-accent-soft py-1 px-2.5 text-xs font-mono tabular-nums"
                                >
                                  {formatMoney(h.last_price, currency)}
                                </button>
                                <div className="text-[11px] text-slate-400 whitespace-nowrap mt-1">
                                  {h.last_price_date ?? 'Sin fecha'} · {asset && canAutoQuoteWithYahoo(asset) ? 'Yahoo USD' : 'Manual'}
                                </div>
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-3 text-right font-mono tabular-nums">
                            <div className="font-semibold text-slate-900">
                              {formatMoney(metrics.marketValueCents, currency)}
                            </div>
                            <div className="text-[11px] text-slate-400">
                              Costo: {formatMoney(metrics.totalCostCents, currency)}
                            </div>
                          </td>
                          <td
                            className={`py-3 pl-3 text-right font-mono tabular-nums font-medium ${
                              metrics.unrealizedGainCents >= 0 ? 'text-emerald-700' : 'text-red-700'
                            }`}
                          >
                            <div>
                              {metrics.unrealizedGainCents >= 0 ? '+' : ''}
                              {formatMoney(metrics.unrealizedGainCents, currency)}
                            </div>
                            <div className="text-xs">
                              ({metrics.unrealizedGainPct >= 0 ? '+' : ''}
                              {metrics.unrealizedGainPct}%)
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Efectivo Líquido en el Broker (portfolio_cash - RN-06 permite >= 0) */}
          <section className="bg-white border border-slate-200 rounded-xl p-6">
            <div className="mb-4">
              <h2 className="text-base font-semibold text-slate-900">
                Efectivo Disponible en tus Brokers (Sin Invertir)
              </h2>
              <p className="text-xs text-slate-500">
                Dinero líquido en tus cuentas de inversión listo para comprar activos. Hacé clic en el importe para actualizarlo (admite $0,00).
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {portfolios.map((port) => {
                const cashRec = portfolioCash.find(
                  (c) => c.portfolio_id === port.id && c.currency === port.base_currency
                );
                const amountCents = cashRec?.amount ?? 0;
                const key = `${port.id}:${port.base_currency}`;
                const isEditing = editingCashKey === key;

                return (
                  <div
                    key={key}
                    className="p-4 rounded-lg border border-slate-200 flex items-center justify-between gap-4"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 truncate">{port.name}</p>
                      <p className="text-xs text-slate-500">
                        {port.broker || 'Broker'} · Liquidez {port.base_currency}
                      </p>
                    </div>

                    {isEditing ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          aria-label={`Efectivo líquido en ${port.name}`}
                          value={editingCashValue}
                          onChange={(e) => setEditingCashValue(e.target.value)}
                          className="w-24 py-1 px-2 text-xs font-mono text-right border border-slate-300 rounded bg-white"
                        />
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              const cents = toCents(editingCashValue);
                              await onUpdatePortfolioCash({
                                portfolio_id: port.id,
                                currency: port.base_currency,
                                amount: cents,
                              });
                              setEditingCashKey(null);
                              setFeedback({
                                type: 'ok',
                                text: `Efectivo líquido de "${port.name}" actualizado.`,
                              });
                            } catch (err) {
                              setFeedback({
                                type: 'err',
                                text:
                                  err instanceof Error
                                    ? err.message
                                    : 'Importe inválido.',
                              });
                            }
                          }}
                          className="btn-primary p-1.5 text-xs"
                          aria-label={`Guardar efectivo de ${port.name}`}
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingCashKey(key);
                          setEditingCashValue(String(fromCents(amountCents)));
                        }}
                        className="btn-accent-soft py-1 px-2.5 font-mono tabular-nums text-xs shrink-0"
                      >
                        {formatMoney(amountCents, port.base_currency)}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {/* SUB-VISTA 2: OPERAR COMPRA / VENTA (TRADES - RN-02) */}
      {subTab === 'trades' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6">
            <h2 className="text-base font-semibold text-slate-900 mb-1">
              Registrar Compra o Venta de un Activo
            </h2>
            <p className="text-xs text-slate-500 mb-4">
              Cargá tu operación y mirá en el simulador inferior cómo quedará tu inversión antes de confirmar.
            </p>

            <form onSubmit={handleSubmitTrade} className="space-y-4">
              <div className="grid grid-cols-2 gap-2 p-1 bg-slate-100 border border-slate-200 rounded-lg">
                <button
                  type="button"
                  onClick={() => setTradeSide('buy')}
                  className={`py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                    tradeSide === 'buy'
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'text-slate-700 hover:bg-white'
                  }`}
                >
                  Comprar (Sumar activos)
                </button>
                <button
                  type="button"
                  onClick={() => setTradeSide('sell')}
                  className={`py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                    tradeSide === 'sell'
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'text-slate-700 hover:bg-white'
                  }`}
                >
                  Vender (Tomar ganancia)
                </button>
              </div>

              <div>
                <label htmlFor="trade-portfolio" className="block text-xs font-medium text-slate-700 mb-1">
                  Cartera donde operaste
                </label>
                <select
                  id="trade-portfolio"
                  value={tradePortfolioId}
                  onChange={(e) => setTradePortfolioId(e.target.value)}
                  className="w-full py-2 px-3 text-sm rounded-lg border border-slate-200 bg-white text-slate-900"
                >
                  {portfolios.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.base_currency})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="trade-asset" className="block text-xs font-medium text-slate-700 mb-1">
                  Activo (Ticker)
                </label>
                <select
                  id="trade-asset"
                  value={tradeAssetId}
                  onChange={(e) => setTradeAssetId(e.target.value)}
                  className="w-full py-2 px-3 text-sm rounded-lg border border-slate-200 bg-white text-slate-900"
                >
                  {assets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.ticker} — {a.name} ({a.currency})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="trade-qty" className="block text-xs font-medium text-slate-700 mb-1">
                    Cantidad de unidades
                  </label>
                  <input
                    id="trade-qty"
                    type="text"
                    required
                    placeholder="Ej. 10"
                    value={tradeQty}
                    onChange={(e) => setTradeQty(e.target.value)}
                    className="w-full py-2 px-3 text-sm font-mono rounded-lg border border-slate-200 bg-white text-slate-900"
                  />
                </div>
                <div>
                  <label htmlFor="trade-price" className="block text-xs font-medium text-slate-700 mb-1">
                    Precio por unidad
                  </label>
                  <input
                    id="trade-price"
                    type="text"
                    required
                    placeholder="Ej. 21400,00"
                    value={tradePrice}
                    onChange={(e) => setTradePrice(e.target.value)}
                    className="w-full py-2 px-3 text-sm font-mono rounded-lg border border-slate-200 bg-white text-slate-900"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="trade-fee" className="block text-xs font-medium text-slate-700 mb-1">
                    Comisión del broker
                  </label>
                  <input
                    id="trade-fee"
                    type="text"
                    value={tradeFee}
                    onChange={(e) => setTradeFee(e.target.value)}
                    className="w-full py-2 px-3 text-sm font-mono rounded-lg border border-slate-200 bg-white text-slate-900"
                  />
                </div>
                <div>
                  <label htmlFor="trade-date" className="block text-xs font-medium text-slate-700 mb-1">
                    Fecha
                  </label>
                  <input
                    id="trade-date"
                    type="date"
                    required
                    value={tradeDate}
                    onChange={(e) => setTradeDate(e.target.value)}
                    className="w-full py-2 px-3 text-sm font-mono rounded-lg border border-slate-200 bg-white text-slate-900"
                  />
                </div>
              </div>

              {/* Simulador de Impacto en Vivo (UX para no economistas) */}
              {tradePreview && (
                <div
                  data-testid="trade-live-preview"
                  className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 text-xs space-y-2"
                >
                  <div className="flex items-center justify-between text-slate-500">
                    <span className="font-semibold text-slate-800">
                      Vista previa ({tradePreview.ticker})
                    </span>
                    <span className="font-mono">
                      Tenés hoy: {tradePreview.currentQty} u. (PPP{' '}
                      {formatMoney(tradePreview.currentAvgCost, tradePreview.currency)})
                    </span>
                  </div>

                  {tradePreview.status === 'incomplete' && (
                    <p className="text-slate-500">
                      Ingresá cantidad y precio unitario para ver el importe total y cómo cambiará tu posición.
                    </p>
                  )}

                  {tradePreview.status === 'error' && (
                    <p className="text-red-700 font-medium">{tradePreview.errorMessage}</p>
                  )}

                  {tradePreview.status === 'ready' && (
                    <div className="pt-2 border-t border-slate-200/80 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-600">
                          {tradeSide === 'buy'
                            ? 'Total a invertir (con comisión):'
                            : 'Total neto a cobrar:'}
                        </span>
                        <span className="font-mono tabular-nums font-semibold text-slate-900">
                          {formatMoney(tradePreview.totalCents, tradePreview.currency)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-600">Nueva cantidad en cartera:</span>
                        <span className="font-mono tabular-nums font-medium text-slate-900">
                          {tradePreview.currentQty} → {tradePreview.newQuantity} u.
                        </span>
                      </div>
                      {tradeSide === 'buy' ? (
                        <div className="flex items-center justify-between">
                          <span className="text-slate-600">Nuevo Precio Promedio (PPP):</span>
                          <span className="font-mono tabular-nums font-medium text-slate-900">
                            {formatMoney(tradePreview.newAvgCostCents, tradePreview.currency)}
                          </span>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between">
                          <span className="text-slate-600">Ganancia / Pérdida Realizada:</span>
                          <span
                            className={`font-mono tabular-nums font-semibold ${
                              (tradePreview.realizedGainCents ?? 0) >= 0
                                ? 'text-emerald-700'
                                : 'text-red-700'
                            }`}
                          >
                            {(tradePreview.realizedGainCents ?? 0) >= 0 ? '+' : ''}
                            {formatMoney(
                              tradePreview.realizedGainCents ?? 0,
                              tradePreview.currency
                            )}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div>
                <label htmlFor="trade-settlement" className="block text-xs font-medium text-slate-700 mb-1">
                  Cuenta de origen/destino (Solo informativa — no descuenta saldo de Cuentas V1)
                </label>
                <select
                  id="trade-settlement"
                  value={tradeSettlementAcc}
                  onChange={(e) => setTradeSettlementAcc(e.target.value)}
                  className="w-full py-2 px-3 text-sm rounded-lg border border-slate-200 bg-white text-slate-900"
                >
                  <option value="">Sin especificar</option>
                  {accounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.name} ({acc.currency})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="trade-note" className="block text-xs font-medium text-slate-700 mb-1">
                  Nota opcional (Cifrada con AES-GCM 256)
                </label>
                <input
                  id="trade-note"
                  type="text"
                  placeholder="Opcional: detalle de la orden"
                  value={tradeNote}
                  onChange={(e) => setTradeNote(e.target.value)}
                  className="w-full py-2 px-3 text-sm rounded-lg border border-slate-200 bg-white text-slate-900"
                />
              </div>

              <button
                type="submit"
                className="btn-primary w-full py-2.5 px-4 text-sm"
              >
                {tradeSide === 'buy' ? 'Confirmar Compra' : 'Confirmar Venta'}
              </button>
            </form>
          </section>

          {/* Historial de Operaciones (Trades) */}
          <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6">
            <h2 className="text-base font-semibold text-slate-900 mb-4">
              Historial de Compras y Ventas
            </h2>

            {trades.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-500">
                No hay operaciones registradas todavía.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs font-medium text-slate-500">
                      <th className="py-2 pr-3">Fecha</th>
                      <th className="py-2 px-3">Operación</th>
                      <th className="py-2 px-3 text-right">Cantidad</th>
                      <th className="py-2 px-3 text-right">Precio Unit.</th>
                      <th className="py-2 pl-3 text-right">Ganancia / Pérdida Realizada</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {trades.map((tr) => {
                      const asset = assetMap.get(tr.asset_id);
                      const port = portfolioMap.get(tr.portfolio_id);
                      const settlement = tr.settlement_account_id
                        ? accountMap.get(tr.settlement_account_id)
                        : undefined;
                      const currency = asset?.currency ?? port?.base_currency ?? 'ARS';

                      return (
                        <tr key={tr.id} className="hover:bg-slate-50/80">
                          <td className="py-2.5 pr-3 font-mono text-xs text-slate-500 whitespace-nowrap tabular-nums">
                            {tr.date}
                          </td>
                          <td className="py-2.5 px-3">
                            <div className="font-medium text-slate-900">
                              <span
                                className={
                                  tr.side === 'buy' ? 'text-emerald-700' : 'text-amber-700'
                                }
                              >
                                {tr.side === 'buy' ? 'Compra' : 'Venta'}
                              </span>{' '}
                              · <span className="font-mono">{asset?.ticker ?? tr.asset_id}</span>
                            </div>
                            <div className="text-xs text-slate-500">
                              {port?.name}
                              {settlement ? ` · Liq: ${settlement.name}` : ''}
                              {tr.note ? ` · ${tr.note}` : ''}
                            </div>
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-900">
                            {tr.quantity}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                            {formatMoney(tr.price, currency)}
                          </td>
                          <td className="py-2.5 pl-3 text-right font-mono tabular-nums">
                            {tr.realized_gain !== null ? (
                              <span
                                className={`font-medium ${
                                  tr.realized_gain >= 0 ? 'text-emerald-700' : 'text-red-700'
                                }`}
                              >
                                {tr.realized_gain >= 0 ? '+' : ''}
                                {formatMoney(tr.realized_gain, currency)}
                              </span>
                            ) : (
                              <span className="text-xs text-slate-400">—</span>
                            )}
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
      )}

      {/* SUB-VISTA 3: RECONSTRUCCIÓN DE CARTERA POR CAPTURA (STAGING RN-04 + RN-05) */}
      {subTab === 'snapshot' && (
        <div className="space-y-6">
          <section className="bg-white border border-slate-200 rounded-xl p-6">
            <h2 className="text-base font-semibold text-slate-900 mb-1">
              Reconstrucción de Cartera desde Captura de Broker (OCR / Texto)
            </h2>
            <p className="text-xs text-slate-500 mb-4">
              Subí una captura de pantalla de tu broker o pegá las líneas de tu tenencia. El sistema limpia porcentajes automáticamente y te muestra una tabla editable para que revises todo antes de guardar (RN-04 y RN-05).
            </p>

            <form onSubmit={handleAnalyzeSnapshot} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="snap-portfolio" className="block text-xs font-medium text-slate-700 mb-1">
                    Cartera Destino
                  </label>
                  <select
                    id="snap-portfolio"
                    value={snapPortfolioId}
                    onChange={(e) => setSnapPortfolioId(e.target.value)}
                    className="w-full py-2 px-3 text-sm rounded-lg border border-slate-200 bg-white text-slate-900"
                  >
                    {portfolios.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.base_currency})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <span className="block text-xs font-medium text-slate-700 mb-1">
                    Imagen de Captura (Opcional — Tesseract.js Local)
                  </span>
                  <label className="inline-flex items-center gap-2 py-2 px-3.5 rounded-lg border border-slate-200 bg-slate-50 text-slate-700 text-xs font-medium hover:bg-slate-100 cursor-pointer">
                    <Camera className="w-4 h-4" aria-hidden="true" />
                    <span>
                      {ocrProgress !== null
                        ? `Procesando OCR (${ocrProgress}%)...`
                        : 'Seleccionar imagen de portafolio'}
                    </span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleSnapshotImageUpload(file);
                      }}
                    />
                  </label>
                </div>
              </div>

              <div>
                <label htmlFor="snap-raw-text" className="block text-xs font-medium text-slate-700 mb-1">
                  Texto de Tenencias (1 activo por línea: Ticker, Cantidad, Costo Promedio, Precio Actual)
                </label>
                <textarea
                  id="snap-raw-text"
                  rows={4}
                  placeholder={`Ejemplo:\nAAPL 15 0,000 % 18.500,00 +12,45% 21.400,00\nGGAL 100 -1,20% 10580 11200`}
                  value={snapRawText}
                  onChange={(e) => setSnapRawText(e.target.value)}
                  className="w-full p-3 text-sm font-mono rounded-lg border border-slate-200 bg-white text-slate-900"
                />
              </div>

              <button
                type="submit"
                className="btn-primary py-2 px-4 text-sm"
              >
                <Upload className="w-4 h-4" aria-hidden="true" />
                <span>Generar Borrador de Cartera en Revisión</span>
              </button>
            </form>
          </section>

          {/* Tabla Editable de Borradores de Captura de Portafolio */}
          {snapshotDrafts.map((draft) => (
            <SnapshotDraftReviewCard
              key={draft.id}
              draft={draft}
              portfolio={portfolioMap.get(draft.portfolio_id)}
              onConfirm={async (rows) => {
                await onConfirmSnapshotDraft({
                  draft_id: draft.id,
                  portfolio_id: draft.portfolio_id,
                  rows,
                });
                setFeedback({
                  type: 'ok',
                  text: 'Tenencias reconstruidas y confirmadas en bloque correctamente.',
                });
                setSubTab('holdings');
              }}
              onDiscard={async () => {
                await onDiscardSnapshotDraft(draft.id);
                setFeedback({ type: 'ok', text: 'Borrador de captura descartado.' });
              }}
            />
          ))}
        </div>
      )}

      {/* SUB-VISTA 4: DIVIDENDOS E INTERESES (PORTFOLIO INCOMES) */}
      {subTab === 'incomes' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6">
            <h2 className="text-base font-semibold text-slate-900 mb-1">
              Registrar Dividendo o Interés Cobrado
            </h2>
            <p className="text-xs text-slate-500 mb-4">
              Anotá acá los pagos de dividendos de acciones/CEDEARs o intereses de bonos y fondos que se acreditaron en tu broker.
            </p>

            <form onSubmit={handleSubmitIncome} className="space-y-4">
              <div>
                <label htmlFor="inc-portfolio" className="block text-xs font-medium text-slate-700 mb-1">
                  Cartera
                </label>
                <select
                  id="inc-portfolio"
                  value={incPortfolioId}
                  onChange={(e) => {
                    setIncPortfolioId(e.target.value);
                    const p = portfolioMap.get(e.target.value);
                    if (p) setIncCurrency(p.base_currency);
                  }}
                  className="w-full py-2 px-3 text-sm rounded-lg border border-slate-200 bg-white text-slate-900"
                >
                  {portfolios.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.base_currency})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="inc-type" className="block text-xs font-medium text-slate-700 mb-1">
                    Tipo de Renta
                  </label>
                  <select
                    id="inc-type"
                    value={incType}
                    onChange={(e) => setIncType(e.target.value as PortfolioIncomeType)}
                    className="w-full py-2 px-3 text-sm rounded-lg border border-slate-200 bg-white text-slate-900"
                  >
                    <option value="dividend">Dividendo</option>
                    <option value="interest">Interés / Cupón</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="inc-asset" className="block text-xs font-medium text-slate-700 mb-1">
                    Activo Origen (Opcional)
                  </label>
                  <select
                    id="inc-asset"
                    value={incAssetId}
                    onChange={(e) => setIncAssetId(e.target.value)}
                    className="w-full py-2 px-3 text-sm rounded-lg border border-slate-200 bg-white text-slate-900"
                  >
                    <option value="">General de Cartera</option>
                    {assets.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.ticker} — {a.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label htmlFor="inc-amount" className="block text-xs font-medium text-slate-700 mb-1">
                    Importe Neto Cobrado
                  </label>
                  <input
                    id="inc-amount"
                    type="text"
                    required
                    placeholder="Ej. 25,50"
                    value={incAmount}
                    onChange={(e) => setIncAmount(e.target.value)}
                    className="w-full py-2 px-3 text-sm font-mono rounded-lg border border-slate-200 bg-white text-slate-900"
                  />
                </div>
                <div>
                  <label htmlFor="inc-currency" className="block text-xs font-medium text-slate-700 mb-1">
                    Moneda
                  </label>
                  <select
                    id="inc-currency"
                    value={incCurrency}
                    onChange={(e) => setIncCurrency(e.target.value as Currency)}
                    className="w-full py-2 px-3 text-sm font-mono rounded-lg border border-slate-200 bg-white text-slate-900"
                  >
                    <option value="ARS">ARS</option>
                    <option value="USD">USD</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="inc-date" className="block text-xs font-medium text-slate-700 mb-1">
                    Fecha de Cobro
                  </label>
                  <input
                    id="inc-date"
                    type="date"
                    required
                    value={incDate}
                    onChange={(e) => setIncDate(e.target.value)}
                    className="w-full py-2 px-3 text-sm font-mono rounded-lg border border-slate-200 bg-white text-slate-900"
                  />
                </div>
                <div>
                  <label htmlFor="inc-note" className="block text-xs font-medium text-slate-700 mb-1">
                    Nota
                  </label>
                  <input
                    id="inc-note"
                    type="text"
                    placeholder="Ej. Cupón semestral"
                    value={incNote}
                    onChange={(e) => setIncNote(e.target.value)}
                    className="w-full py-2 px-3 text-sm rounded-lg border border-slate-200 bg-white text-slate-900"
                  />
                </div>
              </div>

              <button
                type="submit"
                className="btn-primary w-full py-2.5 px-4 text-sm"
              >
                Registrar Rendimiento
              </button>
            </form>
          </section>

          <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6">
            <h2 className="text-base font-semibold text-slate-900 mb-4">
              Historial de Dividendos e Intereses
            </h2>
            {portfolioIncomes.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-500">
                Aún no hay dividendos ni intereses registrados.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs font-medium text-slate-500">
                      <th className="py-2 pr-3">Fecha</th>
                      <th className="py-2 px-3">Concepto</th>
                      <th className="py-2 pl-3 text-right">Importe</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {portfolioIncomes.map((inc) => {
                      const port = portfolioMap.get(inc.portfolio_id);
                      const asset = inc.asset_id ? assetMap.get(inc.asset_id) : undefined;
                      return (
                        <tr key={inc.id} className="hover:bg-slate-50/80">
                          <td className="py-2.5 pr-3 font-mono text-xs text-slate-500 whitespace-nowrap tabular-nums">
                            {inc.date}
                          </td>
                          <td className="py-2.5 px-3">
                            <div className="font-medium text-slate-900">
                              {inc.type === 'dividend' ? 'Dividendo' : 'Interés / Cupón'}
                              {asset ? ` · ${asset.ticker}` : ''}
                            </div>
                            <div className="text-xs text-slate-500">
                              {port?.name}
                              {inc.note ? ` · ${inc.note}` : ''}
                            </div>
                          </td>
                          <td className="py-2.5 pl-3 text-right font-mono tabular-nums font-medium text-emerald-700 whitespace-nowrap">
                            +{formatMoney(inc.amount, inc.currency)}
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
      )}

      {/* SUB-VISTA 5: MAESTRO DE CARTERAS Y ACTIVOS */}
      {subTab === 'catalog' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Alta de Cartera */}
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
            <div>
              <h2 className="text-base font-semibold text-slate-900 mb-1">
                Nueva Cartera de Inversión
              </h2>
              <p className="text-xs text-slate-500">
                Cada cartera representa tu cuenta en un broker o banco y tiene una moneda base fija (ARS o USD).
              </p>
            </div>

            <form onSubmit={handleCreatePortfolioSubmit} className="space-y-4">
              <div>
                <label htmlFor="new-port-name" className="block text-xs font-medium text-slate-700 mb-1">
                  Nombre de la Cartera
                </label>
                <input
                  id="new-port-name"
                  type="text"
                  required
                  placeholder="Ej. Cartera Retiro / Bonos Soberanos"
                  value={newPortName}
                  onChange={(e) => setNewPortName(e.target.value)}
                  className="w-full py-2 px-3 text-sm rounded-lg border border-slate-200 bg-white text-slate-900"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="new-port-broker" className="block text-xs font-medium text-slate-700 mb-1">
                    Broker / Institución
                  </label>
                  <input
                    id="new-port-broker"
                    type="text"
                    placeholder="Ej. Balanz, PPI, IOL, IBKR"
                    value={newPortBroker}
                    onChange={(e) => setNewPortBroker(e.target.value)}
                    className="w-full py-2 px-3 text-sm rounded-lg border border-slate-200 bg-white text-slate-900"
                  />
                </div>
                <div>
                  <label htmlFor="new-port-curr" className="block text-xs font-medium text-slate-700 mb-1">
                    Moneda Base
                  </label>
                  <select
                    id="new-port-curr"
                    value={newPortCurrency}
                    onChange={(e) => setNewPortCurrency(e.target.value as Currency)}
                    className="w-full py-2 px-3 text-sm font-mono rounded-lg border border-slate-200 bg-white text-slate-900"
                  >
                    <option value="ARS">ARS (Pesos)</option>
                    <option value="USD">USD (Dólares)</option>
                  </select>
                </div>
              </div>

              <button
                type="submit"
                className="btn-primary py-2 px-4 text-sm"
              >
                <Plus className="w-4 h-4" />
                <span>Crear Cartera</span>
              </button>
            </form>

            <div className="pt-4 border-t border-slate-100">
              <h3 className="text-xs font-semibold text-slate-500 mb-2">
                Carteras Registradas ({portfolios.length})
              </h3>
              <ul className="divide-y divide-slate-100 text-sm">
                {portfolios.map((p) => (
                  <li key={p.id} className="py-2.5 flex items-center justify-between">
                    <div>
                      <span className="font-medium text-slate-900">{p.name}</span>
                      {p.broker && <span className="text-xs text-slate-500"> · {p.broker}</span>}
                    </div>
                    <span className="font-mono text-xs text-slate-600">{p.base_currency}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          {/* Maestro de Activos */}
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
            <div>
              <h2 className="text-base font-semibold text-slate-900 mb-1">
                Catálogo de Activos Financieros
              </h2>
              <p className="text-xs text-slate-500">
                Si querés invertir en una acción, CEDEAR, bono o cripto que aún no está en la lista, agregalo acá por su código (Ticker).
              </p>
            </div>

            <form onSubmit={handleCreateAssetSubmit} className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label htmlFor="new-asset-ticker" className="block text-xs font-medium text-slate-700 mb-1">
                    Ticker Único
                  </label>
                  <input
                    id="new-asset-ticker"
                    type="text"
                    required
                    placeholder="Ej. NVDA"
                    value={newAssetTicker}
                    onChange={(e) => setNewAssetTicker(e.target.value.toUpperCase())}
                    className="w-full py-2 px-3 text-sm font-mono uppercase rounded-lg border border-slate-200 bg-white text-slate-900"
                  />
                </div>
                <div className="col-span-2">
                  <label htmlFor="new-asset-name" className="block text-xs font-medium text-slate-700 mb-1">
                    Nombre del Instrumento
                  </label>
                  <input
                    id="new-asset-name"
                    type="text"
                    required
                    placeholder="Ej. NVIDIA Corp."
                    value={newAssetName}
                    onChange={(e) => setNewAssetName(e.target.value)}
                    className="w-full py-2 px-3 text-sm rounded-lg border border-slate-200 bg-white text-slate-900"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="new-asset-class" className="block text-xs font-medium text-slate-700 mb-1">
                    Clase de Activo
                  </label>
                  <select
                    id="new-asset-class"
                    value={newAssetClass}
                    onChange={(e) => setNewAssetClass(e.target.value as AssetClass)}
                    className="w-full py-2 px-3 text-sm rounded-lg border border-slate-200 bg-white text-slate-900"
                  >
                    <option value="cedear">CEDEAR</option>
                    <option value="stock">Acción / ETF</option>
                    <option value="bond">Bono / Obligación Negociable</option>
                    <option value="fci">Fondo Común de Inversión (FCI)</option>
                    <option value="crypto">Criptoactivo</option>
                    <option value="other">Otro</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="new-asset-curr" className="block text-xs font-medium text-slate-700 mb-1">
                    Moneda de Cotización
                  </label>
                  <select
                    id="new-asset-curr"
                    value={newAssetCurrency}
                    onChange={(e) => setNewAssetCurrency(e.target.value as Currency)}
                    className="w-full py-2 px-3 text-sm font-mono rounded-lg border border-slate-200 bg-white text-slate-900"
                  >
                    <option value="ARS">ARS</option>
                    <option value="USD">USD</option>
                  </select>
                </div>
              </div>

              <button
                type="submit"
                className="btn-primary py-2 px-4 text-sm"
              >
                <Plus className="w-4 h-4" />
                <span>Agregar Activo al Maestro</span>
              </button>
            </form>

            <div className="pt-4 border-t border-slate-100">
              <h3 className="text-xs font-semibold text-slate-500 mb-2">
                Activos Registrados ({assets.length})
              </h3>
              <ul className="divide-y divide-slate-100 text-sm max-h-56 overflow-y-auto">
                {assets.map((a) => (
                  <li key={a.id} className="py-2 flex items-center justify-between">
                    <div>
                      <span className="font-mono font-semibold text-slate-900">{a.ticker}</span>
                      <span className="text-slate-600"> · {a.name}</span>
                    </div>
                    <span className="text-xs text-slate-500">
                      {ASSET_CLASS_LABELS[a.asset_class]} · {a.currency}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

interface EditableSnapshotRow {
  row_id: string;
  ticker: string;
  asset_name: string;
  asset_class: AssetClass;
  quantity: string;
  avg_cost: string;
  last_price: string;
  uncertain_fields: string[];
}

function SnapshotDraftReviewCard({
  draft,
  portfolio,
  onConfirm,
  onDiscard,
}: {
  draft: PortfolioSnapshotDraftRecord;
  portfolio: PortfolioRecord | undefined;
  onConfirm: (
    rows: Array<{
      ticker: string;
      asset_name: string;
      asset_class: AssetClass;
      quantity: number;
      avg_cost: number;
      last_price: number;
    }>
  ) => Promise<void>;
  onDiscard: () => Promise<void>;
}) {
  const initialParsed = (() => {
    try {
      return JSON.parse(draft.rows_json) as ParsedPortfolioSnapshotRow[];
    } catch {
      return [];
    }
  })();

  const [rows, setRows] = useState<EditableSnapshotRow[]>(() =>
    initialParsed.map((r) => ({
      row_id: r.row_id,
      ticker: r.ticker ?? '',
      asset_name: r.asset_name ?? '',
      asset_class: r.asset_class ?? 'cedear',
      quantity: r.quantity !== null ? String(r.quantity) : '',
      avg_cost: r.avg_cost !== null ? String(fromCents(r.avg_cost)) : '',
      last_price: r.last_price !== null ? String(fromCents(r.last_price)) : '',
      uncertain_fields: r.uncertain_fields ?? [],
    }))
  );
  const [rowError, setRowError] = useState<string | null>(null);

  const handleConfirmClick = async () => {
    setRowError(null);
    const validated: Array<{
      ticker: string;
      asset_name: string;
      asset_class: AssetClass;
      quantity: number;
      avg_cost: number;
      last_price: number;
    }> = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const ticker = r.ticker.trim().toUpperCase();
      if (!ticker) {
        setRowError(`Fila #${i + 1}: El Ticker es obligatorio (RN-05).`);
        return;
      }
      const q = Number.parseFloat(r.quantity.replace(',', '.'));
      if (!Number.isFinite(q) || q < 0) {
        setRowError(`Fila #${i + 1} (${ticker}): Cantidad inválida.`);
        return;
      }
      try {
        const avgCostCents = toCents(r.avg_cost);
        const lastPriceCents = toCents(r.last_price);
        if (avgCostCents < 0 || lastPriceCents < 0) {
          setRowError(`Fila #${i + 1} (${ticker}): Los costos y precios no pueden ser negativos.`);
          return;
        }
        validated.push({
          ticker,
          asset_name: r.asset_name.trim() || `Activo ${ticker}`,
          asset_class: r.asset_class,
          quantity: q,
          avg_cost: avgCostCents,
          last_price: lastPriceCents,
        });
      } catch {
        setRowError(
          `Fila #${i + 1} (${ticker}): Completá el Costo Promedio y el Último Precio antes de confirmar.`
        );
        return;
      }
    }

    await onConfirm(validated);
  };

  return (
    <section className="bg-white border border-slate-300 rounded-xl p-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-slate-900">
            Borrador de Captura en Revisión · {portfolio?.name ?? 'Cartera'} ({portfolio?.base_currency ?? 'ARS'})
          </h3>
          <p className="text-xs text-slate-500">
            RN-04 y RN-05: Completá cualquier campo marcado en amarillo antes de confirmar en bloque.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleConfirmClick}
            className="btn-primary py-2 px-3.5 text-xs"
          >
            <Check className="w-4 h-4" />
            <span>Confirmar Tenencias en Bloque</span>
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="btn-danger-soft py-2 px-3 text-xs"
          >
            <Trash2 className="w-4 h-4" />
            <span>Descartar</span>
          </button>
        </div>
      </div>

      {rowError && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
          {rowError}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-200 text-xs font-medium text-slate-500">
              <th className="py-2 pr-2">Ticker</th>
              <th className="py-2 px-2">Nombre Activo</th>
              <th className="py-2 px-2">Clase</th>
              <th className="py-2 px-2 text-right">Cantidad</th>
              <th className="py-2 px-2 text-right">Costo Promedio (PPP)</th>
              <th className="py-2 pl-2 text-right">Último Precio</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-xs">
            {rows.map((r, idx) => (
              <tr key={r.row_id}>
                <td className="py-2 pr-2">
                  <input
                    type="text"
                    aria-label={`Ticker fila ${idx + 1}`}
                    value={r.ticker}
                    onChange={(e) => {
                      const next = [...rows];
                      next[idx] = { ...r, ticker: e.target.value.toUpperCase() };
                      setRows(next);
                    }}
                    className={`w-24 py-1.5 px-2 font-mono uppercase rounded border ${
                      !r.ticker ? 'border-amber-400 bg-amber-50/40' : 'border-slate-200'
                    }`}
                  />
                </td>
                <td className="py-2 px-2">
                  <input
                    type="text"
                    aria-label={`Nombre activo fila ${idx + 1}`}
                    value={r.asset_name}
                    onChange={(e) => {
                      const next = [...rows];
                      next[idx] = { ...r, asset_name: e.target.value };
                      setRows(next);
                    }}
                    className="w-40 py-1.5 px-2 rounded border border-slate-200"
                  />
                </td>
                <td className="py-2 px-2">
                  <select
                    aria-label={`Clase activo fila ${idx + 1}`}
                    value={r.asset_class}
                    onChange={(e) => {
                      const next = [...rows];
                      next[idx] = { ...r, asset_class: e.target.value as AssetClass };
                      setRows(next);
                    }}
                    className="py-1.5 px-2 rounded border border-slate-200 bg-white"
                  >
                    <option value="cedear">CEDEAR</option>
                    <option value="stock">Acción / ETF</option>
                    <option value="bond">Bono / ON</option>
                    <option value="fci">FCI</option>
                    <option value="crypto">Cripto</option>
                    <option value="other">Otro</option>
                  </select>
                </td>
                <td className="py-2 px-2 text-right">
                  <input
                    type="text"
                    aria-label={`Cantidad fila ${idx + 1}`}
                    value={r.quantity}
                    onChange={(e) => {
                      const next = [...rows];
                      next[idx] = { ...r, quantity: e.target.value };
                      setRows(next);
                    }}
                    className={`w-24 py-1.5 px-2 font-mono text-right rounded border ${
                      !r.quantity ? 'border-amber-400 bg-amber-50/40' : 'border-slate-200'
                    }`}
                  />
                </td>
                <td className="py-2 px-2 text-right">
                  <input
                    type="text"
                    aria-label={`Costo promedio fila ${idx + 1}`}
                    placeholder="Incierta (RN-05)"
                    value={r.avg_cost}
                    onChange={(e) => {
                      const next = [...rows];
                      next[idx] = { ...r, avg_cost: e.target.value };
                      setRows(next);
                    }}
                    className={`w-28 py-1.5 px-2 font-mono text-right rounded border ${
                      !r.avg_cost ? 'border-amber-400 bg-amber-50/40' : 'border-slate-200'
                    }`}
                  />
                </td>
                <td className="py-2 pl-2 text-right">
                  <input
                    type="text"
                    aria-label={`Último precio fila ${idx + 1}`}
                    placeholder="Incierta (RN-05)"
                    value={r.last_price}
                    onChange={(e) => {
                      const next = [...rows];
                      next[idx] = { ...r, last_price: e.target.value };
                      setRows(next);
                    }}
                    className={`w-28 py-1.5 px-2 font-mono text-right rounded border ${
                      !r.last_price ? 'border-amber-400 bg-amber-50/40' : 'border-slate-200'
                    }`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
