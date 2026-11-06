import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptSensitiveText,
  deriveUserAesKey,
  encryptSensitiveText,
} from './encryption';

test('Cifrado y descifrado simétrico AES-GCM 256 bits con clave derivada PBKDF2', async () => {
  const userId = '1000204276828-google-sub-id-test';
  const salt = 'custom-user-salt-16bytes!';
  const systemSecret = 'system-secret-key-32chars-minimum!!';

  const key = await deriveUserAesKey(userId, salt, systemSecret);

  const originalNote = 'Compra de medicamentos en Farmacity';
  const encrypted = await encryptSensitiveText(originalNote, key);

  assert.ok(encrypted !== null);
  assert.ok(encrypted.startsWith('enc:'));
  assert.notEqual(encrypted, originalNote);

  const decrypted = await decryptSensitiveText(encrypted, key);
  assert.equal(decrypted, originalNote);
});

test('Dos cifrados del mismo texto producen textos cifrados distintos debido a IVs únicos de 12 bytes', async () => {
  const userId = 'google-sub-user-2';
  const salt = 'salt-for-testing-2!';
  const secret = 'system-secret-key-32chars-minimum!!';

  const key = await deriveUserAesKey(userId, salt, secret);
  const text = 'Honorarios de consultoría mensual';

  const enc1 = await encryptSensitiveText(text, key);
  const enc2 = await encryptSensitiveText(text, key);

  assert.notEqual(enc1, enc2);

  const dec1 = await decryptSensitiveText(enc1, key);
  const dec2 = await decryptSensitiveText(enc2, key);

  assert.equal(dec1, text);
  assert.equal(dec2, text);
});

test('Texto manipulado o corrompido falla la autenticación GCM (AEAD tag mismatch)', async () => {
  const key = await deriveUserAesKey('user-3', 'salt-3-for-tests!!', 'secret-key-32-chars-long-enough!!');
  const original = 'Transferencia confidencial';
  const encrypted = (await encryptSensitiveText(original, key))!;

  // Corromper el último carácter del ciphertext
  const corrupted = encrypted.slice(0, -2) + 'XX';
  const result = await decryptSensitiveText(corrupted, key);

  assert.equal(result, '[Dato protegido - error de autenticación]');
});

test('Compatibilidad hacia atrás: texto plano sin prefijo enc: se devuelve intacto', async () => {
  const key = await deriveUserAesKey('user-4', 'salt-4-for-tests!!', 'secret-key-32-chars-long-enough!!');
  const plainLegacy = 'Gasto en supermercado previo a la encriptación';

  const result = await decryptSensitiveText(plainLegacy, key);
  assert.equal(result, plainLegacy);
});
