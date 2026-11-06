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
