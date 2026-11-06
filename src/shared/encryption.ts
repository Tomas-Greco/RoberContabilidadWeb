/**
 * Módulo puro de cifrado simétrico simétrico de extremo a extremo (E2EE)
 * basado exclusivamente en estándares modernos de la Web Crypto API nativa (crypto.subtle).
 * 
 * - Algoritmo: AES-GCM de 256 bits (cifrado autenticado AEAD).
 * - Derivación de clave: PBKDF2 con HMAC-SHA-256 (100.000 iteraciones).
 * - IV (Vector de Inicialización): 12 bytes (96 bits) aleatorios por cada operación.
 * - Salting: Sal criptográfica de 16 bytes generada con crypto.getRandomValues().
 */

function toBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const PBKDF2_ITERATIONS = 100_000;
const AES_KEY_LENGTH = 256;
const GCM_IV_LENGTH = 12; // 96 bits recomendado para AES-GCM
const MAX_KEY_CACHE_SIZE = 128;

const derivedKeyCache = new Map<string, Promise<CryptoKey>>();

/**
 * Deriva una CryptoKey de AES-GCM de 256 bits de forma determinística
 * a partir del ID de Google del usuario ('sub'), una sal criptográfica y la clave de sesión del sistema.
 * Incluye caché en memoria por isolate para evitar recalcular 100.000 iteraciones PBKDF2 en cada request.
 */
export async function deriveUserAesKey(
  googleSubId: string,
  userSalt: string,
  systemSecret: string
): Promise<CryptoKey> {
  const cacheKey = `${googleSubId}:${userSalt}:${systemSecret}`;
  const cached = derivedKeyCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const keyPromise = (async () => {
    const encoder = new TextEncoder();
    const keyMaterialText = `${googleSubId}:${systemSecret}`;
    const keyMaterialBytes = encoder.encode(keyMaterialText);

    // 1. Importar el material base como clave cruda para PBKDF2
    const baseKey = await crypto.subtle.importKey(
      'raw',
      keyMaterialBytes,
      'PBKDF2',
      false,
      ['deriveKey']
    );

    // 2. Preparar la sal (debe tener al menos 16 bytes)
    const saltBytes = encoder.encode(userSalt.padEnd(16, '0'));

    // 3. Derivar la clave simétrica AES-GCM de 256 bits
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltBytes,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      baseKey,
      { name: 'AES-GCM', length: AES_KEY_LENGTH },
      false,
      ['encrypt', 'decrypt']
    );
  })();

  if (derivedKeyCache.size >= MAX_KEY_CACHE_SIZE) {
    const oldestKey = derivedKeyCache.keys().next().value;
    if (oldestKey) derivedKeyCache.delete(oldestKey);
  }
  derivedKeyCache.set(cacheKey, keyPromise);

  try {
    return await keyPromise;
  } catch (err) {
    derivedKeyCache.delete(cacheKey);
    throw err;
  }
}

const ENC_PREFIX = 'enc:';

/**
 * Cifra un texto en claro con AES-GCM 256 bits y un IV aleatorio de 12 bytes.
 * Devuelve un string seguro para almacenar en SQLite: "enc:<iv_base64url>.<ciphertext_and_tag_base64url>"
 */
export async function encryptSensitiveText(
  plainText: string | null | undefined,
  aesKey: CryptoKey
): Promise<string | null> {
  if (plainText === null || plainText === undefined || plainText === '') {
    return null;
  }

  // Generar IV criptográfico único de 12 bytes (96 bits)
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_LENGTH));
  const encodedText = new TextEncoder().encode(plainText);

  const cipherBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    aesKey,
    encodedText
  );

  const ivStr = toBase64Url(iv);
  const cipherStr = toBase64Url(cipherBuffer);

  return `${ENC_PREFIX}${ivStr}.${cipherStr}`;
}

/**
 * Descifra un string cifrado en formato "enc:<iv>.<ciphertext>".
 * Si el texto no está cifrado (datos legados anteriores al cifrado), lo devuelve tal cual.
 */
export async function decryptSensitiveText(
  cipherText: string | null | undefined,
  aesKey: CryptoKey
): Promise<string | null> {
  if (!cipherText) {
    return null;
  }

  // Compatibilidad con registros históricos no cifrados
  if (!cipherText.startsWith(ENC_PREFIX)) {
    return cipherText;
  }

  const raw = cipherText.slice(ENC_PREFIX.length);
  const dotIdx = raw.indexOf('.');
  if (dotIdx === -1) {
    return cipherText;
  }

  const ivStr = raw.slice(0, dotIdx);
  const dataStr = raw.slice(dotIdx + 1);

  try {
    const iv = fromBase64Url(ivStr);
    const dataBytes = fromBase64Url(dataStr);

    const decryptedBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv.buffer as ArrayBuffer,
      },
      aesKey,
      dataBytes.buffer as ArrayBuffer
    );

    return new TextDecoder().decode(decryptedBuffer);
  } catch {
    // Si la autenticación GCM falla (tampering o clave errónea)
    return '[Dato protegido - error de autenticación]';
  }
}
