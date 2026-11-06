import { useState, type FormEvent } from 'react';
import { Archive, Plus } from 'lucide-react';
import { calculateAccountBalance } from '../shared/ledger';
import { assertNonNegativeCents, formatMoney, toCents } from '../shared/money';
import type {
  AccountRecord,
  AccountType,
  CategoryKind,
  CategoryRecord,
  Currency,
  TransactionRecord,
} from '../shared/types';

interface AccountsCategoriesViewProps {
  accounts: ReadonlyArray<AccountRecord>;
  categories: ReadonlyArray<CategoryRecord>;
  transactions: ReadonlyArray<TransactionRecord>;
  onCreateAccount: (input: {
    name: string;
    type: AccountType;
    currency: Currency;
    opening_balance: number;
  }) => Promise<void>;
  onToggleArchiveAccount: (id: string, archived: 0 | 1) => Promise<void>;
  onCreateCategory: (input: {
    name: string;
    kind: CategoryKind;
    parent_id?: string | null;
  }) => Promise<void>;
}

const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  cash: 'Efectivo',
  bank: 'Banco',
  wallet: 'Billetera',
  other: 'Otra',
};

export function AccountsCategoriesView({
  accounts,
  categories,
  transactions,
  onCreateAccount,
  onToggleArchiveAccount,
  onCreateCategory,
}: AccountsCategoriesViewProps) {
  const [accName, setAccName] = useState('');
  const [accType, setAccType] = useState<AccountType>('bank');
  const [accCurrency, setAccCurrency] = useState<Currency>('ARS');
  const [accOpening, setAccOpening] = useState('0');
  const [accError, setAccError] = useState<string | null>(null);
  const [accSubmitting, setAccSubmitting] = useState(false);

  const [catName, setCatName] = useState('');
  const [catKind, setCatKind] = useState<CategoryKind>('expense');
  const [catParentId, setCatParentId] = useState<string>('');
  const [catError, setCatError] = useState<string | null>(null);
  const [catSubmitting, setCatSubmitting] = useState(false);

  const handleAccountSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setAccError(null);

    let openingCents: number;
    try {
      openingCents = assertNonNegativeCents(toCents(accOpening || '0'), 'saldo inicial');
    } catch (err) {
      setAccError(err instanceof Error ? err.message : 'Saldo inicial inválido.');
      return;
    }

    setAccSubmitting(true);
    try {
      await onCreateAccount({
        name: accName.trim(),
        type: accType,
        currency: accCurrency,
        opening_balance: openingCents,
      });
      setAccName('');
      setAccOpening('0');
    } catch (err) {
      setAccError(err instanceof Error ? err.message : 'Error al crear la cuenta.');
    } finally {
      setAccSubmitting(false);
    }
  };

  const handleCategorySubmit = async (e: FormEvent) => {
    e.preventDefault();
    setCatError(null);
    if (!catName.trim()) {
      setCatError('Ingresá un nombre para la categoría.');
      return;
    }

    setCatSubmitting(true);
    try {
      await onCreateCategory({
        name: catName.trim(),
        kind: catKind,
        parent_id: catParentId || null,
      });
      setCatName('');
      setCatParentId('');
    } catch (err) {
      setCatError(err instanceof Error ? err.message : 'Error al crear la categoría.');
    } finally {
      setCatSubmitting(false);
    }
  };

  const parentCandidates = categories.filter(
    (c) => c.archived === 0 && c.kind === catKind && c.parent_id === null
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
          Cuentas y Categorías
        </h1>
        <p className="text-sm text-slate-600 mt-1">
          Cada cuenta opera en una única moneda fija (ARS o USD) y acepta saldo inicial ≥ 0.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Sección Cuentas */}
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-6">
          <h2 className="text-base font-semibold text-slate-900">Cuentas</h2>

          <form onSubmit={handleAccountSubmit} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
            <div className="sm:col-span-2">
              <label htmlFor="acc-name" className="block text-xs font-medium text-slate-700 mb-1">
                Nombre
              </label>
              <input
                id="acc-name"
                type="text"
                required
                placeholder="Ej. Galicia, Brubank, Efectivo"
                value={accName}
                onChange={(e) => setAccName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
              />
            </div>

            <div>
              <label htmlFor="acc-type" className="block text-xs font-medium text-slate-700 mb-1">
                Tipo
              </label>
              <select
                id="acc-type"
                value={accType}
                onChange={(e) => setAccType(e.target.value as AccountType)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm bg-white"
              >
                <option value="bank">Banco</option>
                <option value="wallet">Billetera</option>
                <option value="cash">Efectivo</option>
                <option value="other">Otra</option>
              </select>
            </div>

            <div>
              <label htmlFor="acc-currency" className="block text-xs font-medium text-slate-700 mb-1">
                Moneda
              </label>
              <select
                id="acc-currency"
                value={accCurrency}
                onChange={(e) => setAccCurrency(e.target.value as Currency)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm bg-white"
              >
                <option value="ARS">ARS</option>
                <option value="USD">USD</option>
              </select>
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="acc-opening" className="block text-xs font-medium text-slate-700 mb-1">
                Saldo Inicial (≥ 0)
              </label>
              <input
                id="acc-opening"
                type="text"
                inputMode="decimal"
                value={accOpening}
                onChange={(e) => setAccOpening(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm font-mono tabular-nums"
              />
            </div>

            <div className="sm:col-span-2">
              <button
                type="submit"
                disabled={accSubmitting}
                className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-4 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
              >
                <Plus className="w-4 h-4" aria-hidden="true" />
                <span>Agregar Cuenta</span>
              </button>
            </div>
          </form>

          {accError && (
            <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
              {accError}
            </div>
          )}

          <ul className="divide-y divide-slate-100">
            {accounts.map((acc) => {
              const bal = calculateAccountBalance(acc.opening_balance, acc.id, transactions);
              return (
                <li
                  key={acc.id}
                  className={`py-3 flex items-center justify-between gap-4 ${
                    acc.archived === 1 ? 'opacity-50' : ''
                  }`}
                >
                  <div>
                    <p className="text-sm font-medium text-slate-900">{acc.name}</p>
                    <p className="text-xs text-slate-500">
                      {ACCOUNT_TYPE_LABELS[acc.type]} · {acc.currency} · Inicial:{' '}
                      <span className="font-mono tabular-nums">
                        {formatMoney(acc.opening_balance, acc.currency)}
                      </span>
                    </p>
                  </div>

                  <div className="flex items-center gap-4">
                    <span className="text-sm font-mono tabular-nums font-medium text-slate-900">
                      {formatMoney(bal, acc.currency)}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        onToggleArchiveAccount(acc.id, acc.archived === 1 ? 0 : 1)
                      }
                      title={acc.archived === 1 ? 'Desarchivar cuenta' : 'Archivar cuenta'}
                      aria-label={
                        acc.archived === 1
                          ? `Desarchivar ${acc.name}`
                          : `Archivar ${acc.name}`
                      }
                      className="p-1.5 rounded-lg text-slate-400 hover:text-slate-900 hover:bg-slate-100 cursor-pointer"
                    >
                      <Archive className="w-4 h-4" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Sección Categorías */}
        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-6">
          <h2 className="text-base font-semibold text-slate-900">Categorías</h2>

          <form onSubmit={handleCategorySubmit} className="space-y-3">
            <div>
              <label htmlFor="cat-name" className="block text-xs font-medium text-slate-700 mb-1">
                Nombre
              </label>
              <input
                id="cat-name"
                type="text"
                required
                placeholder="Ej. Farmacia, Educación, Dividendos"
                value={catName}
                onChange={(e) => setCatName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="cat-kind" className="block text-xs font-medium text-slate-700 mb-1">
                  Tipo
                </label>
                <select
                  id="cat-kind"
                  value={catKind}
                  onChange={(e) => {
                    setCatKind(e.target.value as CategoryKind);
                    setCatParentId('');
                  }}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm bg-white"
                >
                  <option value="expense">Gasto</option>
                  <option value="income">Ingreso</option>
                </select>
              </div>

              <div>
                <label htmlFor="cat-parent" className="block text-xs font-medium text-slate-700 mb-1">
                  Categoría Padre (opcional)
                </label>
                <select
                  id="cat-parent"
                  value={catParentId}
                  onChange={(e) => setCatParentId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm bg-white"
                >
                  <option value="">Ninguna (principal)</option>
                  {parentCandidates.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <button
              type="submit"
              disabled={catSubmitting}
              className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-4 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
              <span>Agregar Categoría</span>
            </button>
          </form>

          {catError && (
            <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
              {catError}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 pt-2">
            <div>
              <h3 className="text-xs font-semibold text-slate-500 mb-2">Gastos</h3>
              <ul className="space-y-1.5 text-sm text-slate-800">
                {categories
                  .filter((c) => c.kind === 'expense' && c.archived === 0)
                  .map((c) => (
                    <li key={c.id} className="truncate">
                      {c.parent_id ? `↳ ${c.name}` : c.name}
                    </li>
                  ))}
              </ul>
            </div>

            <div>
              <h3 className="text-xs font-semibold text-slate-500 mb-2">Ingresos</h3>
              <ul className="space-y-1.5 text-sm text-slate-800">
                {categories
                  .filter((c) => c.kind === 'income' && c.archived === 0)
                  .map((c) => (
                    <li key={c.id} className="truncate">
                      {c.parent_id ? `↳ ${c.name}` : c.name}
                    </li>
                  ))}
              </ul>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
