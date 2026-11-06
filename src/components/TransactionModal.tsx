import { useState, type FormEvent } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { findPotentialDuplicates } from '../shared/ledger';
import { assertPositiveCents, formatMoney, toCents } from '../shared/money';
import type {
  AccountRecord,
  CategoryRecord,
  Currency,
  TransactionRecord,
  TransactionSource,
  TransactionType,
} from '../shared/types';

interface TransactionModalProps {
  accounts: ReadonlyArray<AccountRecord>;
  categories: ReadonlyArray<CategoryRecord>;
  existingTransactions: ReadonlyArray<TransactionRecord>;
  onClose: () => void;
  onSubmit: (input: {
    date: string;
    type: TransactionType;
    account_id: string;
    counter_account_id: string | null;
    category_id: string | null;
    amount: number;
    currency: Currency;
    note: string | null;
    source: TransactionSource;
  }) => Promise<void>;
}

export function TransactionModal({
  accounts,
  categories,
  existingTransactions,
  onClose,
  onSubmit,
}: TransactionModalProps) {
  const activeAccounts = accounts.filter((a) => a.archived === 0);
  const defaultAccount = activeAccounts[0];

  const [type, setType] = useState<TransactionType>('expense');
  const [date, setDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [accountId, setAccountId] = useState<string>(defaultAccount?.id ?? '');
  const [counterAccountId, setCounterAccountId] = useState<string>('');
  const [categoryId, setCategoryId] = useState<string>('');
  const [amountInput, setAmountInput] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<TransactionRecord[]>([]);
  const [duplicateConfirmed, setDuplicateConfirmed] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const selectedAccount = activeAccounts.find((a) => a.id === accountId);
  const currency: Currency = selectedAccount?.currency ?? 'ARS';

  // Filtrar cuentas destino de la misma moneda (RN-03)
  const validCounterAccounts = activeAccounts.filter(
    (a) => a.id !== accountId && a.currency === currency
  );

  const filteredCategories = categories.filter(
    (c) => c.archived === 0 && (type === 'income' ? c.kind === 'income' : c.kind === 'expense')
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!selectedAccount) {
      setError('Seleccioná una cuenta válida.');
      return;
    }

    let amountCents: number;
    try {
      amountCents = assertPositiveCents(toCents(amountInput), 'importe');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Importe inválido.');
      return;
    }

    if (type === 'transfer') {
      if (!counterAccountId) {
        setError('Seleccioná la cuenta destino para la transferencia.');
        return;
      }
    }

    // Detección de posibles duplicados (±2 días)
    if (!duplicateConfirmed) {
      const found = findPotentialDuplicates(
        {
          date,
          amount: amountCents,
          account_id: selectedAccount.id,
          currency,
        },
        existingTransactions
      );
      if (found.length > 0) {
        setDuplicates(found);
        return;
      }
    }

    setSubmitting(true);
    try {
      await onSubmit({
        date,
        type,
        account_id: selectedAccount.id,
        counter_account_id: type === 'transfer' ? counterAccountId : null,
        category_id: type === 'transfer' ? null : categoryId || null,
        amount: amountCents,
        currency,
        note: note.trim() || null,
        source: 'manual',
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar el movimiento.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-tx-title"
      className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 id="modal-tx-title" className="text-lg font-semibold text-slate-900">
            Nuevo Movimiento
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar modal"
            className="btn-secondary p-1.5"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Selector de Tipo */}
          <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 border border-slate-200 rounded-lg">
            {(
              [
                { id: 'expense', label: 'Gasto' },
                { id: 'income', label: 'Ingreso' },
                { id: 'transfer', label: 'Transferencia' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  setType(opt.id);
                  setDuplicates([]);
                  setDuplicateConfirmed(false);
                }}
                className={`py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                  type === opt.id
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-700 hover:bg-white'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="tx-date" className="block text-xs font-medium text-slate-700 mb-1">
                Fecha
              </label>
              <input
                id="tx-date"
                type="date"
                required
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  setDuplicates([]);
                  setDuplicateConfirmed(false);
                }}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm font-mono focus:outline-none focus:border-slate-900"
              />
            </div>

            <div>
              <label htmlFor="tx-amount" className="block text-xs font-medium text-slate-700 mb-1">
                Importe ({currency})
              </label>
              <input
                id="tx-amount"
                type="text"
                inputMode="decimal"
                required
                placeholder="15.500,50"
                value={amountInput}
                onChange={(e) => {
                  setAmountInput(e.target.value);
                  setDuplicates([]);
                  setDuplicateConfirmed(false);
                }}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm font-mono tabular-nums focus:outline-none focus:border-slate-900"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="tx-account" className="block text-xs font-medium text-slate-700 mb-1">
                {type === 'transfer' ? 'Cuenta Origen' : 'Cuenta'}
              </label>
              <select
                id="tx-account"
                value={accountId}
                onChange={(e) => {
                  setAccountId(e.target.value);
                  setCounterAccountId('');
                  setDuplicates([]);
                  setDuplicateConfirmed(false);
                }}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm bg-white focus:outline-none focus:border-slate-900"
              >
                {activeAccounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.name} ({acc.currency})
                  </option>
                ))}
              </select>
            </div>

            {type === 'transfer' ? (
              <div>
                <label
                  htmlFor="tx-counter-account"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Cuenta Destino ({currency})
                </label>
                <select
                  id="tx-counter-account"
                  value={counterAccountId}
                  onChange={(e) => setCounterAccountId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm bg-white focus:outline-none focus:border-slate-900"
                >
                  <option value="">Seleccionar destino...</option>
                  {validCounterAccounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.name} ({acc.currency})
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div>
                <label
                  htmlFor="tx-category"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Categoría
                </label>
                <select
                  id="tx-category"
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm bg-white focus:outline-none focus:border-slate-900"
                >
                  <option value="">Sin categoría</option>
                  {filteredCategories.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div>
            <label htmlFor="tx-note" className="block text-xs font-medium text-slate-700 mb-1">
              Nota / Descripción
            </label>
            <input
              id="tx-note"
              type="text"
              placeholder="Ej. Compra semanal o referencia"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-slate-900"
            />
          </div>

          {/* Alerta de posible duplicado (±2 días) */}
          {duplicates.length > 0 && (
            <div
              role="alert"
              className="p-3.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-2"
            >
              <div className="flex items-center gap-2 font-semibold">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                <span>Posible movimiento duplicado (±2 días)</span>
              </div>
              <p>
                Ya existe {duplicates.length} movimiento(s) activo(s) por{' '}
                <strong className="font-mono">
                  {formatMoney(duplicates[0].amount, duplicates[0].currency)}
                </strong>{' '}
                en esta cuenta el {duplicates[0].date}.
              </p>
              <label className="flex items-center gap-2 font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={duplicateConfirmed}
                  onChange={(e) => setDuplicateConfirmed(e.target.checked)}
                />
                <span>Confirmo que no es un duplicado y deseo registrarlo igual</span>
              </label>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700"
            >
              {error}
            </div>
          )}

          <div className="pt-2 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary py-2 px-4 text-sm"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="btn-primary py-2 px-4 text-sm disabled:opacity-50"
            >
              {submitting ? 'Guardando...' : 'Guardar Movimiento'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
