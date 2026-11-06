export type Currency = 'ARS' | 'USD';

export type AccountType = 'cash' | 'bank' | 'wallet' | 'other';

export interface AccountRecord {
  id: string;
  user_id: string;
  name: string;
  type: AccountType;
  currency: Currency;
  opening_balance: number; // Centavos enteros >= 0
  csv_column_map: string | null;
  archived: 0 | 1;
  created_at: number;
}

export type CategoryKind = 'income' | 'expense';

export interface CategoryRecord {
  id: string;
  user_id: string;
  name: string;
  kind: CategoryKind;
  parent_id: string | null;
  archived: 0 | 1;
}

export type TransactionType = 'income' | 'expense' | 'transfer';

export type TransactionSource = 'manual' | 'nlp' | 'capture' | 'import';

export interface TransactionRecord {
  id: string;
  user_id: string;
  date: string; // YYYY-MM-DD
  type: TransactionType;
  account_id: string;
  counter_account_id: string | null; // Obligatorio si type === 'transfer', null en otros
  category_id: string | null; // null si type === 'transfer'
  amount: number; // Centavos enteros > 0
  currency: Currency;
  note: string | null;
  source: TransactionSource;
  voided_at: number | null; // null = activo; unix timestamp = anulado
  created_at: number;
}

export type DraftSource = 'nlp' | 'capture';

export type DraftStatus = 'pending' | 'confirmed' | 'discarded';

export type UncertainField =
  | 'date'
  | 'type'
  | 'account_id'
  | 'counter_account_id'
  | 'category_id'
  | 'amount'
  | 'currency';

export interface ParsedMovementDraft {
  date: string | null;
  type: TransactionType | null;
  account_id: string | null;
  counter_account_id: string | null;
  category_id: string | null;
  amount: number | null; // Centavos enteros > 0
  currency: Currency | null;
  note: string;
  uncertain_fields: UncertainField[];
}

export interface MovementDraftRecord {
  id: string;
  user_id: string;
  source: DraftSource;
  raw_input: string | null;
  extracted_json: string; // JSON serializado de ParsedMovementDraft
  uncertain_fields: string; // JSON serializado de UncertainField[]
  status: DraftStatus;
  matched_transaction_id: string | null;
  created_at: number;
}

export interface UserSession {
  id: string;
  email: string;
  name: string;
  picture: string | null;
}

export interface ConsolidatedBalances {
  ARS: number;
  USD: number;
}

export interface MonthlyCurrencySummary {
  income: number;
  expense: number;
}

export interface MonthlySummary {
  ARS: MonthlyCurrencySummary;
  USD: MonthlyCurrencySummary;
}

// === MÓDULO V2: INVERSIONES Y PATRIMONIO ===

export type AssetClass = 'stock' | 'cedear' | 'bond' | 'crypto' | 'fci' | 'other';

export interface PortfolioRecord {
  id: string;
  user_id: string;
  name: string;
  broker: string | null;
  base_currency: Currency;
  created_at: number;
}

export interface AssetRecord {
  id: string;
  ticker: string; // Único en mayúsculas (ej. AAPL, SPY, AL30, GGAL)
  name: string;
  asset_class: AssetClass;
  currency: Currency;
}

export interface HoldingRecord {
  id: string;
  user_id: string;
  portfolio_id: string;
  asset_id: string;
  quantity: number; // REAL >= 0 (admite fracciones ej. FCI o cripto)
  avg_cost: number; // Centavos enteros >= 0 (RN-06)
  last_price: number; // Centavos enteros >= 0 (RN-06)
  last_price_date: string | null;
}

export interface PortfolioCashRecord {
  portfolio_id: string;
  user_id: string;
  currency: Currency;
  amount: number; // Centavos enteros >= 0 (RN-06)
}

export type SnapshotRowUncertainField = 'ticker' | 'quantity' | 'avg_cost' | 'last_price';

export interface ParsedPortfolioSnapshotRow {
  row_id: string;
  raw_line: string;
  ticker: string | null;
  asset_name: string;
  asset_class: AssetClass;
  quantity: number | null;
  avg_cost: number | null; // Centavos enteros >= 0
  last_price: number | null; // Centavos enteros >= 0
  uncertain_fields: SnapshotRowUncertainField[];
}

export interface PortfolioSnapshotDraftRecord {
  id: string;
  user_id: string;
  portfolio_id: string;
  raw_text: string | null;
  rows_json: string; // JSON serializado de ParsedPortfolioSnapshotRow[]
  status: DraftStatus;
  created_at: number;
}

export type TradeSide = 'buy' | 'sell';

export interface TradeRecord {
  id: string;
  user_id: string;
  portfolio_id: string;
  asset_id: string;
  side: TradeSide;
  quantity: number; // REAL > 0
  price: number; // Centavos enteros > 0 (RN-06)
  fee: number; // Centavos enteros >= 0 (RN-06)
  date: string; // YYYY-MM-DD
  settlement_account_id: string | null; // Solo informativo (RN-02)
  realized_gain: number | null; // Centavos enteros (calculado en ventas, RN-02)
  note: string | null;
  created_at: number;
}

export type PortfolioIncomeType = 'dividend' | 'interest';

export interface PortfolioIncomeRecord {
  id: string;
  user_id: string;
  portfolio_id: string;
  asset_id: string | null;
  type: PortfolioIncomeType;
  amount: number; // Centavos enteros > 0 (RN-06)
  currency: Currency;
  date: string; // YYYY-MM-DD
  note: string | null;
}

export interface CurrencyWealthBreakdown {
  accountsBalance: number; // V1: Saldo de cuentas activas
  portfoliosMarketValue: number; // V2: Valor de mercado de tenencias
  portfoliosCash: number; // V2: Efectivo líquido en brokers
  totalNetWorth: number; // Suma exacta en centavos enteros
}

export interface TotalWealthSummary {
  ARS: CurrencyWealthBreakdown;
  USD: CurrencyWealthBreakdown;
}

