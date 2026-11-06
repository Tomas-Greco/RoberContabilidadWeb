import { toCents } from './money';
import type {
  AccountRecord,
  CategoryRecord,
  Currency,
  ParsedMovementDraft,
  TransactionType,
  UncertainField,
} from './types';

export type AccountSummary = Pick<AccountRecord, 'id' | 'name' | 'currency' | 'type' | 'archived'>;
export type CategorySummary = Pick<CategoryRecord, 'id' | 'name' | 'kind' | 'archived'>;

const TRANSFER_KEYWORDS = /\b(transferi|transferir|transferencia|transf|pase|pasar|movi|mover|envie|enviar)\b/i;
const INCOME_KEYWORDS = /\b(cobre|cobrar|ingreso|ingrese|sueldo|salario|honorarios|venta|vendi|vender|recibi|recibir|deposito|deposite|reintegro)\b/i;
const EXPENSE_KEYWORDS = /\b(gaste|gastar|gasto|pague|pagar|pago|compre|comprar|compra|abone|abonar|debito|debite|consumo|factura|ticket)\b/i;

const USD_KEYWORDS = /\b(usd|u\$s|us\$|dolar|dolares)\b/i;
const ARS_KEYWORDS = /\b(ars|peso|pesos)\b|\$(?!\s*(?:us|u\$))/i;

const CATEGORY_SYNONYMS: Record<string, string[]> = {
  supermercado: ['supermercado', 'super', 'coto', 'carrefour', 'dia', 'jumbo', 'almacen', 'verduleria', 'carniceria'],
  alimentacion: ['comida', 'almuerzo', 'cena', 'desayuno', 'restaurante', 'bar', 'cafe', 'delivery', 'pedidosya', 'rappi'],
  transporte: ['nafta', 'combustible', 'ypf', 'shell', 'sube', 'uber', 'cabify', 'taxi', 'colectivo', 'subte', 'peaje'],
  servicios: ['luz', 'edenor', 'edesur', 'gas', 'metrogas', 'agua', 'aysa', 'internet', 'fibertel', 'movistar', 'claro', 'personal', 'expensas', 'alquiler'],
  salud: ['farmacia', 'medico', 'obra social', 'prepaga', 'osde', 'swiss', 'odontologo'],
  entretenimiento: ['cine', 'netflix', 'spotify', 'steam', 'teatro', 'recital'],
  sueldo: ['sueldo', 'salario', 'haberes', 'aguinaldo'],
  honorarios: ['honorarios', 'factura', 'freelance', 'consultoria'],
};

function normalizeText(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shiftIsoDate(isoDate: string, deltaDays: number): string {
  const [y, m, d] = isoDate.split('-').map((n) => Number.parseInt(n, 10));
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function extractDate(text: string, referenceDate?: string): string | null {
  // 1. Fecha ISO explícita YYYY-MM-DD
  const isoMatch = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  // 2. Fecha DD/MM/YYYY o DD-MM-YYYY
  const dmyMatch = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/.exec(text);
  if (dmyMatch) {
    const day = dmyMatch[1].padStart(2, '0');
    const month = dmyMatch[2].padStart(2, '0');
    const year = dmyMatch[3];
    return `${year}-${month}-${day}`;
  }

  // 3. Palabras relativas ("hoy", "ayer")
  const today = referenceDate ?? new Date().toISOString().slice(0, 10);
  if (/\bhoy\b/i.test(text)) {
    return today;
  }
  if (/\bayer\b/i.test(text)) {
    return shiftIsoDate(today, -1);
  }

  return null;
}

/**
 * Extrae el monto en centavos aplicando obligatoriamente las Lecciones Técnicas 1 y 2:
 * - Lección 2: Eliminar todos los porcentajes ("0,000 %", "10.5%") ANTES de buscar montos.
 * - Lección 1: Evaluar SIEMPRE primero el patrón con separador de miles explícito
 *   y recién después el número plano para no truncar cifras como "10580" en "105".
 */
function extractAmountCents(rawText: string): number | null {
  // Lección 2: Limpieza previa de porcentajes (con 0, 1, 2 o 3 decimales)
  const withoutPercentages = rawText.replace(/\b\d+(?:[.,]\d+)?\s*%/g, ' ');

  // Evitar confundir fechas DD/MM/YYYY o YYYY-MM-DD con montos
  const withoutDates = withoutPercentages
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, ' ');

  // Lección 1: Alternancia ordenada — primero separador de miles explícito, luego número plano
  const amountRegex =
    /(?:^|[^\d.,])(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?=$|[^\d.,])/;

  const match = amountRegex.exec(withoutDates);
  if (!match || !match[1]) {
    return null;
  }

  try {
    const cents = toCents(match[1]);
    return cents > 0 ? cents : null;
  } catch {
    return null;
  }
}

function findAccountMatches(
  normalizedText: string,
  accounts: ReadonlyArray<AccountSummary>
): Array<{ account: AccountSummary; index: number }> {
  const activeAccounts = accounts.filter((a) => a.archived === 0);
  const matches: Array<{ account: AccountSummary; index: number }> = [];

  for (const account of activeAccounts) {
    const normName = normalizeText(account.name);
    if (!normName) continue;
    const regex = new RegExp(`\\b${escapeRegExp(normName)}\\b`, 'i');
    const m = regex.exec(normalizedText);
    if (m) {
      matches.push({ account, index: m.index });
    }
  }

  // Ordenar por posición de aparición en la frase (útil para "de Origen a Destino")
  matches.sort((a, b) => a.index - b.index);
  return matches;
}

function findCategoryMatch(
  normalizedText: string,
  categories: ReadonlyArray<CategorySummary>,
  txType: TransactionType | null
): string | null {
  if (txType === 'transfer') {
    return null;
  }

  const activeCategories = categories.filter(
    (c) => c.archived === 0 && (txType === null || c.kind === txType)
  );

  // 1. Coincidencia directa por nombre de categoría del usuario
  for (const cat of activeCategories) {
    const normCat = normalizeText(cat.name);
    if (!normCat) continue;
    const regex = new RegExp(`\\b${escapeRegExp(normCat)}\\b`, 'i');
    if (regex.test(normalizedText)) {
      return cat.id;
    }
  }

  // 2. Coincidencia por sinónimos léxicos mapeados a las categorías del usuario
  for (const [canonicalKey, synonyms] of Object.entries(CATEGORY_SYNONYMS)) {
    const hasSynonym = synonyms.some((syn) =>
      new RegExp(`\\b${escapeRegExp(syn)}\\b`, 'i').test(normalizedText)
    );
    if (!hasSynonym) continue;

    const matchedCat = activeCategories.find((c) => {
      const normCat = normalizeText(c.name);
      return normCat.includes(canonicalKey) || synonyms.some((s) => normCat.includes(s));
    });
    if (matchedCat) {
      return matchedCat.id;
    }
  }

  return null;
}

/**
 * Parser 100% determinístico en TypeScript (CERO IA) para carga rápida por texto libre.
 * Cumple RN-05 (Cero Invención de Datos): todo campo que no pueda deducirse con certeza
 * queda en `null` y se incluye en `uncertain_fields` para revisión en staging.
 */
export function parseMovementText(
  rawInput: string,
  accounts: ReadonlyArray<AccountSummary>,
  categories: ReadonlyArray<CategorySummary>,
  referenceDate?: string
): ParsedMovementDraft {
  const trimmed = rawInput.trim();
  const normalized = normalizeText(trimmed);
  const uncertain_fields: UncertainField[] = [];

  // 1. Tipo de movimiento
  let type: TransactionType | null = null;
  if (TRANSFER_KEYWORDS.test(normalized)) {
    type = 'transfer';
  } else if (INCOME_KEYWORDS.test(normalized)) {
    type = 'income';
  } else if (EXPENSE_KEYWORDS.test(normalized)) {
    type = 'expense';
  } else {
    uncertain_fields.push('type');
  }

  // 2. Monto en centavos
  const amount = extractAmountCents(trimmed);
  if (amount === null) {
    uncertain_fields.push('amount');
  }

  // 3. Fecha (RN-05: si no está explícita en el texto, queda null y se marca incierta)
  const date = extractDate(trimmed, referenceDate);
  if (date === null) {
    uncertain_fields.push('date');
  }

  // 4. Cuentas (origen y destino si es transferencia)
  const accountMatches = findAccountMatches(normalized, accounts);
  let account_id: string | null = null;
  let counter_account_id: string | null = null;

  if (type === 'transfer') {
    if (accountMatches.length >= 2) {
      account_id = accountMatches[0].account.id;
      counter_account_id = accountMatches[1].account.id;
    } else if (accountMatches.length === 1) {
      // Verificar si aparece después de "a " / "hacia " (destino) o "de " / "desde " (origen)
      const beforeMatch = normalized.slice(0, accountMatches[0].index);
      if (/\b(a|hacia|para)\s*$/i.test(beforeMatch)) {
        counter_account_id = accountMatches[0].account.id;
        uncertain_fields.push('account_id');
      } else {
        account_id = accountMatches[0].account.id;
        uncertain_fields.push('counter_account_id');
      }
    } else {
      uncertain_fields.push('account_id', 'counter_account_id');
    }
  } else {
    if (accountMatches.length >= 1) {
      account_id = accountMatches[0].account.id;
    } else {
      uncertain_fields.push('account_id');
    }
  }

  // 5. Moneda (explícita en texto o heredada de la cuenta identificada)
  let currency: Currency | null = null;
  if (USD_KEYWORDS.test(normalized)) {
    currency = 'USD';
  } else if (ARS_KEYWORDS.test(normalized)) {
    currency = 'ARS';
  } else if (accountMatches.length >= 1) {
    currency = accountMatches[0].account.currency;
  } else {
    uncertain_fields.push('currency');
  }

  // 6. Categoría (solo para income / expense; en transfer siempre null según RN-01)
  let category_id: string | null = null;
  if (type !== 'transfer') {
    category_id = findCategoryMatch(normalized, categories, type);
    if (category_id === null) {
      uncertain_fields.push('category_id');
    }
  }

  return {
    date,
    type,
    account_id,
    counter_account_id,
    category_id,
    amount,
    currency,
    note: trimmed,
    uncertain_fields,
  };
}
