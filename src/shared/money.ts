import type { Currency } from './types';

export class MoneyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyValidationError';
  }
}

/**
 * Valida que un importe en centavos sea un entero estrictamente mayor a 0 (> 0).
 * Obligatorio para transacciones, compras, ventas y dividendos (RN-06).
 */
export function assertPositiveCents(cents: number, fieldName = 'amount'): number {
  if (typeof cents !== 'number' || !Number.isFinite(cents) || !Number.isInteger(cents)) {
    throw new MoneyValidationError(`El campo "${fieldName}" debe ser un entero exacto en centavos.`);
  }
  if (cents <= 0) {
    throw new MoneyValidationError(`El campo "${fieldName}" debe ser estrictamente mayor a 0.`);
  }
  return cents;
}

/**
 * Valida que un importe en centavos sea un entero mayor o igual a 0 (>= 0).
 * Obligatorio para saldos iniciales, efectivo en cartera y costo promedio ponderado (RN-06).
 */
export function assertNonNegativeCents(cents: number, fieldName = 'balance'): number {
  if (typeof cents !== 'number' || !Number.isFinite(cents) || !Number.isInteger(cents)) {
    throw new MoneyValidationError(`El campo "${fieldName}" debe ser un entero exacto en centavos.`);
  }
  if (cents < 0) {
    throw new MoneyValidationError(`El campo "${fieldName}" no puede ser negativo.`);
  }
  return cents;
}

/**
 * Convierte una entrada numérica o string (formato argentino "15.500,50" o estándar "15500.50")
 * a centavos enteros exactos sin errores de coma flotante IEEE 754.
 */
export function toCents(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new MoneyValidationError('El importe numérico no es finito.');
    }
    return Math.round((input + Number.EPSILON) * 100);
  }

  const trimmed = input.trim().replace(/\s+/g, '');
  if (!trimmed) {
    throw new MoneyValidationError('El importe está vacío.');
  }

  // Detectar signo negativo
  const isNegative = trimmed.startsWith('-');
  const unsigned = trimmed.replace(/^[+-]/, '');

  // Caso 1: Formato argentino con miles (.) y decimales (,) -> ej. "15.500,50"
  let normalized: string;
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(unsigned)) {
    normalized = unsigned.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(unsigned)) {
    // Caso 2: Formato anglosajón con miles (,) y decimales (.) -> ej. "15,500.50"
    normalized = unsigned.replace(/,/g, '');
  } else if (/^\d+(,\d{1,2})?$/.test(unsigned)) {
    // Caso 3: Número plano con coma decimal -> ej. "15500,50" o "10580"
    normalized = unsigned.replace(',', '.');
  } else if (/^\d+(\.\d{1,2})?$/.test(unsigned)) {
    // Caso 4: Número plano con punto decimal -> ej. "15500.50"
    normalized = unsigned;
  } else {
    throw new MoneyValidationError(`Formato de importe inválido: "${input}".`);
  }

  const [intPart, decPart = ''] = normalized.split('.');
  const paddedDec = (decPart + '00').slice(0, 2);
  const cents = Number.parseInt(intPart, 10) * 100 + Number.parseInt(paddedDec, 10);

  if (!Number.isSafeInteger(cents)) {
    throw new MoneyValidationError('El importe excede el rango entero seguro.');
  }

  return isNegative ? -cents : cents;
}

/**
 * Convierte centavos enteros a número decimal para inputs de UI.
 */
export function fromCents(cents: number): number {
  if (!Number.isInteger(cents)) {
    throw new MoneyValidationError('Los centavos deben ser un número entero.');
  }
  return cents / 100;
}

const ARS_FORMATTER = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const USD_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Formatea centavos enteros en su moneda correspondiente sin mezclar divisas (RN-03).
 */
export function formatMoney(cents: number, currency: Currency): string {
  const value = cents / 100;
  if (currency === 'USD') {
    return `USD ${USD_FORMATTER.format(value)}`;
  }
  return ARS_FORMATTER.format(value);
}
