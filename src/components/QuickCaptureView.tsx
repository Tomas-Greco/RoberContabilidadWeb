import { useState, type ChangeEvent, type FormEvent } from 'react';
import { AlertTriangle, Check, FileText, Image as ImageIcon, Trash2 } from 'lucide-react';
import { runBrowserOcr } from '../services/ocrService';
import { findPotentialDuplicates } from '../shared/ledger';
import { assertPositiveCents, formatMoney, fromCents, toCents } from '../shared/money';
import { parseMovementText } from '../shared/nlp-parser';
import type {
  AccountRecord,
  CategoryRecord,
  Currency,
  DraftSource,
  MovementDraftRecord,
  ParsedMovementDraft,
  TransactionRecord,
  TransactionSource,
  TransactionType,
  UncertainField,
} from '../shared/types';

interface QuickCaptureViewProps {
  accounts: ReadonlyArray<AccountRecord>;
  categories: ReadonlyArray<CategoryRecord>;
  transactions: ReadonlyArray<TransactionRecord>;
  drafts: ReadonlyArray<MovementDraftRecord>;
  onCreateDraft: (input: {
    source: DraftSource;
    raw_input: string;
    parsed: ParsedMovementDraft;
  }) => Promise<MovementDraftRecord>;
  onConfirmDraft: (
    draftId: string,
    txInput: {
      date: string;
      type: TransactionType;
      account_id: string;
      counter_account_id: string | null;
      category_id: string | null;
      amount: number;
      currency: Currency;
      note: string | null;
      source: TransactionSource;
    }
  ) => Promise<void>;
  onDiscardDraft: (draftId: string) => Promise<void>;
}

const EXAMPLE_PHRASES = [
  'gasté 15.500,50 en supermercado con Santander',
  'transferí 10000 de MercadoPago a Efectivo hoy',
  'cobré 850 USD de honorarios en Caja USD hoy',
];

export function QuickCaptureView({
  accounts,
  categories,
  transactions,
  drafts,
  onCreateDraft,
  onConfirmDraft,
  onDiscardDraft,
}: QuickCaptureViewProps) {
  const [mode, setMode] = useState<'nlp' | 'capture'>('nlp');
  const [textInput, setTextInput] = useState<string>('');
  const [ocrProgress, setOcrProgress] = useState<number | null>(null);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState<boolean>(false);

  const handleAnalyzeText = async (e: FormEvent) => {
    e.preventDefault();
    if (!textInput.trim()) return;
    setAnalyzing(true);
    try {
      const parsed = parseMovementText(textInput, accounts, categories);
      await onCreateDraft({
        source: 'nlp',
        raw_input: textInput.trim(),
        parsed,
      });
      setTextInput('');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setOcrError(null);
    setOcrProgress(0);
    setAnalyzing(true);

    try {
      const result = await runBrowserOcr(file, (pct) => setOcrProgress(pct));
      const parsed = parseMovementText(result.text, accounts, categories);
      await onCreateDraft({
        source: 'capture',
        raw_input: result.text || `[Captura: ${file.name}]`,
        parsed,
      });
    } catch {
      setOcrError(
        'No se pudo procesar la imagen con OCR en el navegador. Podés pegar el texto del comprobante o crear un borrador manual.'
      );
    } finally {
      setOcrProgress(null);
      setAnalyzing(false);
      e.target.value = '';
    }
  };

  const handleCreateManualDraft = async () => {
    const emptyParsed: ParsedMovementDraft = {
      date: null,
      type: 'expense',
      account_id: null,
      counter_account_id: null,
      category_id: null,
      amount: null,
      currency: null,
      note: '',
      uncertain_fields: ['date', 'account_id', 'category_id', 'amount', 'currency'],
    };
    await onCreateDraft({
      source: 'capture',
      raw_input: 'Carga manual desde comprobante',
      parsed: emptyParsed,
    });
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
          Carga Rápida y Revisión en Staging
        </h1>
        <p className="text-sm text-slate-600 mt-1">
          Motor determinístico sin IA y OCR en navegador. Ningún movimiento impacta tu saldo hasta
          que lo confirmes en la bandeja de revisión.
        </p>
      </div>

      {/* Panel de Entrada */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="inline-flex gap-1.5 p-1 bg-slate-100 border border-slate-200 rounded-xl">
          <button
            type="button"
            onClick={() => setMode('nlp')}
            className={`inline-flex items-center gap-2 px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
              mode === 'nlp' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-700 hover:bg-white'
            }`}
          >
            <FileText className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Texto Libre (Parser Determinístico)</span>
          </button>
          <button
            type="button"
            onClick={() => setMode('capture')}
            className={`inline-flex items-center gap-2 px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
              mode === 'capture' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-700 hover:bg-white'
            }`}
          >
            <ImageIcon className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Captura / Comprobante (OCR Local)</span>
          </button>
        </div>

        {mode === 'nlp' ? (
          <form onSubmit={handleAnalyzeText} className="space-y-4">
            <div>
              <label htmlFor="nlp-input" className="block text-xs font-medium text-slate-700 mb-1.5">
                Escribí el movimiento en lenguaje natural
              </label>
              <div className="flex flex-col sm:flex-row gap-3">
                <input
                  id="nlp-input"
                  type="text"
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder="Ej. gasté 15.500,50 en supermercado con Santander"
                  className="flex-1 px-3.5 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-slate-900"
                />
                <button
                  type="submit"
                  disabled={analyzing || !textInput.trim()}
                  className="btn-primary py-2.5 px-5 text-sm disabled:opacity-50 whitespace-nowrap"
                >
                  {analyzing ? 'Analizando...' : 'Analizar a Borrador'}
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-xs font-medium text-slate-500">Ejemplos rápidos:</span>
              {EXAMPLE_PHRASES.map((phrase) => (
                <button
                  key={phrase}
                  type="button"
                  onClick={() => setTextInput(phrase)}
                  className="btn-accent-soft text-xs px-2.5 py-1"
                >
                  {phrase}
                </button>
              ))}
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            <div>
              <label
                htmlFor="ocr-file"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                Seleccioná una imagen de ticket o comprobante (procesado 100% en tu navegador)
              </label>
              <input
                id="ocr-file"
                type="file"
                accept="image/*"
                disabled={analyzing}
                onChange={handleFileChange}
                className="block w-full text-sm text-slate-600 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border file:border-slate-200 file:text-xs file:font-medium file:bg-white file:text-slate-900 hover:file:bg-slate-50 cursor-pointer"
              />
            </div>

            {ocrProgress !== null && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-slate-600">
                  <span>Reconociendo texto con Tesseract.js (spa)...</span>
                  <span className="font-mono tabular-nums">{ocrProgress}%</span>
                </div>
                <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-slate-900 transition-all"
                    style={{ width: `${ocrProgress}%` }}
                  />
                </div>
              </div>
            )}

            {ocrError && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-center justify-between gap-4"
              >
                <span>{ocrError}</span>
                <button
                  type="button"
                  onClick={handleCreateManualDraft}
                  className="px-3 py-1.5 rounded-md bg-slate-900 text-white font-medium whitespace-nowrap cursor-pointer"
                >
                  Cargar borrador manual
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Bandeja de Revisión Obligatoria (Staging) */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-slate-900">
          Borradores Pendientes de Confirmación ({drafts.length})
        </h2>

        {drafts.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
            No hay borradores pendientes. Escribí una frase arriba o subí un comprobante para
            generar un borrador editable.
          </div>
        ) : (
          <div className="space-y-4">
            {drafts.map((draft) => (
              <DraftReviewCard
                key={draft.id}
                draft={draft}
                accounts={accounts}
                categories={categories}
                transactions={transactions}
                onConfirm={onConfirmDraft}
                onDiscard={onDiscardDraft}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

interface DraftReviewCardProps {
  draft: MovementDraftRecord;
  accounts: ReadonlyArray<AccountRecord>;
  categories: ReadonlyArray<CategoryRecord>;
  transactions: ReadonlyArray<TransactionRecord>;
  onConfirm: QuickCaptureViewProps['onConfirmDraft'];
  onDiscard: (draftId: string) => Promise<void>;
}

function DraftReviewCard({
  draft,
  accounts,
  categories,
  transactions,
  onConfirm,
  onDiscard,
}: DraftReviewCardProps) {
  const initialParsed = JSON.parse(draft.extracted_json) as ParsedMovementDraft;
  const uncertainSet = new Set<UncertainField>(
    JSON.parse(draft.uncertain_fields || '[]') as UncertainField[]
  );

  const activeAccounts = accounts.filter((a) => a.archived === 0);

  const [type, setType] = useState<TransactionType>(initialParsed.type ?? 'expense');
  const [date, setDate] = useState<string>(initialParsed.date ?? '');
  const [accountId, setAccountId] = useState<string>(initialParsed.account_id ?? '');
  const [counterAccountId, setCounterAccountId] = useState<string>(
    initialParsed.counter_account_id ?? ''
  );
  const [categoryId, setCategoryId] = useState<string>(initialParsed.category_id ?? '');
  const [amountInput, setAmountInput] = useState<string>(
    initialParsed.amount !== null ? String(fromCents(initialParsed.amount)) : ''
  );
  const [note, setNote] = useState<string>(initialParsed.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [duplicateConfirmed, setDuplicateConfirmed] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const selectedAccount = activeAccounts.find((a) => a.id === accountId);
  const currency: Currency = selectedAccount?.currency ?? initialParsed.currency ?? 'ARS';

  const validCounterAccounts = activeAccounts.filter(
    (a) => a.id !== accountId && a.currency === currency
  );

  const filteredCategories = categories.filter(
    (c) => c.archived === 0 && (type === 'income' ? c.kind === 'income' : c.kind === 'expense')
  );

  let parsedCents: number | null = null;
  try {
    if (amountInput.trim()) {
      parsedCents = assertPositiveCents(toCents(amountInput), 'importe');
    }
  } catch {
    parsedCents = null;
  }

  const potentialDuplicates =
    date && parsedCents && selectedAccount
      ? findPotentialDuplicates(
          {
            date,
            amount: parsedCents,
            account_id: selectedAccount.id,
            currency: selectedAccount.currency,
          },
          transactions
        )
      : [];

  const handleConfirm = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!date) {
      setError('Completá la fecha del movimiento antes de confirmar.');
      return;
    }
    if (!selectedAccount) {
      setError('Seleccioná la cuenta.');
      return;
    }
    if (!parsedCents) {
      setError('Ingresá un importe válido mayor a 0.');
      return;
    }
    if (type === 'transfer' && !counterAccountId) {
      setError('Seleccioná la cuenta destino de la transferencia.');
      return;
    }
    if (potentialDuplicates.length > 0 && !duplicateConfirmed) {
      setError('Confirmá la casilla de posible duplicado antes de guardar.');
      return;
    }

    setSubmitting(true);
    try {
      await onConfirm(draft.id, {
        date,
        type,
        account_id: selectedAccount.id,
        counter_account_id: type === 'transfer' ? counterAccountId : null,
        category_id: type === 'transfer' ? null : categoryId || null,
        amount: parsedCents,
        currency: selectedAccount.currency,
        note: note.trim() || null,
        source: draft.source,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al confirmar el borrador.');
    } finally {
      setSubmitting(false);
    }
  };

  const uncertainBorder = (field: UncertainField) =>
    uncertainSet.has(field) ? 'border-amber-400 bg-amber-50/40' : 'border-slate-200 bg-white';

  return (
    <form
      onSubmit={handleConfirm}
      data-testid="staging-draft-card"
      className="bg-white border border-slate-200 rounded-xl p-6 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-100">
        <div className="text-xs text-slate-500">
          <span className="font-medium text-slate-700">
            {draft.source === 'nlp' ? 'Texto libre' : 'Captura OCR'}
          </span>
          {draft.raw_input ? ` · "${draft.raw_input}"` : ''}
        </div>
        {uncertainSet.size > 0 && (
          <span className="text-xs font-medium text-amber-800">
            Campos inciertos marcados en ámbar ({uncertainSet.size})
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">Tipo</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as TransactionType)}
            className={`w-full px-3 py-2 rounded-lg border text-sm ${uncertainBorder('type')}`}
          >
            <option value="expense">Gasto</option>
            <option value="income">Ingreso</option>
            <option value="transfer">Transferencia</option>
          </select>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs font-medium text-slate-700">Fecha</label>
            {!date && (
              <button
                type="button"
                onClick={() => setDate(new Date().toISOString().slice(0, 10))}
                className="btn-accent-soft py-0.5 px-2 text-[11px]"
              >
                Usar hoy
              </button>
            )}
          </div>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={`w-full px-3 py-2 rounded-lg border text-sm font-mono ${uncertainBorder('date')}`}
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">
            Importe ({currency})
          </label>
          <input
            type="text"
            inputMode="decimal"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            placeholder="0,00"
            className={`w-full px-3 py-2 rounded-lg border text-sm font-mono tabular-nums ${uncertainBorder('amount')}`}
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">
            {type === 'transfer' ? 'Cuenta Origen' : 'Cuenta'}
          </label>
          <select
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              setCounterAccountId('');
            }}
            className={`w-full px-3 py-2 rounded-lg border text-sm ${uncertainBorder('account_id')}`}
          >
            <option value="">Seleccionar cuenta...</option>
            {activeAccounts.map((acc) => (
              <option key={acc.id} value={acc.id}>
                {acc.name} ({acc.currency})
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {type === 'transfer' ? (
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Cuenta Destino ({currency})
            </label>
            <select
              value={counterAccountId}
              onChange={(e) => setCounterAccountId(e.target.value)}
              className={`w-full px-3 py-2 rounded-lg border text-sm ${uncertainBorder('counter_account_id')}`}
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
            <label className="block text-xs font-medium text-slate-700 mb-1">Categoría</label>
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className={`w-full px-3 py-2 rounded-lg border text-sm ${uncertainBorder('category_id')}`}
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

        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">Nota</label>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
          />
        </div>
      </div>

      {potentialDuplicates.length > 0 && (
        <div
          role="alert"
          className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-1.5"
        >
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>Posible duplicado detectado (±2 días)</span>
          </div>
          <p>
            Existe un movimiento activo por{' '}
            <strong className="font-mono">
              {formatMoney(potentialDuplicates[0].amount, potentialDuplicates[0].currency)}
            </strong>{' '}
            el {potentialDuplicates[0].date}.
          </p>
          <label className="flex items-center gap-2 font-medium cursor-pointer">
            <input
              type="checkbox"
              checked={duplicateConfirmed}
              onChange={(e) => setDuplicateConfirmed(e.target.checked)}
            />
            <span>Confirmar igualmente</span>
          </label>
        </div>
      )}

      {error && (
        <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={() => onDiscard(draft.id)}
          className="btn-danger-soft py-2 px-3.5 text-xs"
        >
          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Descartar</span>
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="btn-primary py-2 px-4 text-xs disabled:opacity-50"
        >
          <Check className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{submitting ? 'Confirmando...' : 'Confirmar Movimiento'}</span>
        </button>
      </div>
    </form>
  );
}
