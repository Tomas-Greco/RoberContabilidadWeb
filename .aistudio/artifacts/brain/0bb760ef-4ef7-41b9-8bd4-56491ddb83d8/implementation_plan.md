# Plan de Implementación: Cifrado AES-GCM 256 con Web Crypto API basado en Google Auth

Sistema de cifrado simétrico autenticado (AEAD) transparente y de costo $0 para la contabilidad personal, utilizando exclusivamente la **Web Crypto API nativa** (`crypto.subtle`). No requiere librerías externas ni exige al usuario recordar contraseñas: la clave criptográfica se deriva del identificador único e inmutable de Google (`sub`), una sal criptográfica de usuario y la clave de sesión del sistema.

---

### User Review & Critical Decisions

> [!IMPORTANT]
> **Decisiones de Diseño Criptográfico y Usabilidad:**
> 1. **Cero fricción para el usuario:** El usuario inicia sesión normalmente con Google y no debe ingresar ni memorizar ninguna clave adicional.
> 2. **Campos a Cifrar:** Se cifran exclusivamente los campos sensibles de contenido libre (el campo `note` de las transacciones, la descripción o nombre de cuentas sensibles y el contenido en borrador `raw_input` de los comprobantes).
> 3. **Campos en Claro Preservados:** Las fechas (`date`), tipos (`type`), monedas (`currency`), saldos iniciales y los importes numéricos en centavos (`amount`) se conservan sin cifrar a nivel de columna para permitir sumatorias instantáneas, cálculos de saldo (RN-08), detección de duplicados en ±2 días e indexación en SQLite D1.

---

### 1. Overview & Core Concept

- **Qué hace:** Aplica cifrado simétrico **AES-GCM de 256 bits** con vector de inicialización único (IV de 12 bytes / 96 bits) por cada registro y derivación de clave **PBKDF2** (HMAC-SHA-256 con 100.000 iteraciones).
- **Cómo protege:** En la base de datos Cloudflare D1, el texto de las notas o descripciones personales se almacena en formato binario empaquetado `[12 bytes IV + ciphertext + 16 bytes auth tag]` codificado en Base64Url con el prefijo `enc:`. Si alguien obtiene un volcado de la base de datos D1, las descripciones son completamente ilegibles.
- **Transparencia:** Para el usuario la interfaz sigue viéndose igual: al iniciar sesión, el Worker descifra en vuelo el campo para enviarlo a la UI, y al guardar un nuevo movimiento, lo cifra antes de persistirlo en D1.

---

### 2. User Experience & Visual Design

- **Flujo de Usuario:**
  1. El usuario hace login con Google con un solo clic.
  2. En el Dashboard y en el Historial de Movimientos, las notas y categorías se visualizan en texto claro de forma inmediata.
  3. En la interfaz se incorpora un indicador sutil y sobrio en el pie de página o en el resumen: *"Cifrado AES-GCM 256 activo con tu identidad de Google"*.
  4. Ningún modal de contraseña extra interrumpe la carga rápida por texto libre ni el OCR de comprobantes.

---

### 3. Key Product Decisions & Trade-Offs

- **Derivación de Clave (KDF):**
  - *Elección:* Clave maestra derivada con `PBKDF2` combinando el identificador único de Google (`user.id` / `sub`), una sal específica por usuario guardada en la tabla `users` (16 bytes generados con `crypto.getRandomValues`) y el `SESSION_SECRET` del entorno.
  - *Ventaja:* No depende de que el usuario recuerde nada; el identificador `sub` de Google es permanente e inmutable para esa cuenta de Google.
- **Formato del Ciphertext en BD:**
  - *Elección:* Formato compacto `enc:<iv_base64url>.<ciphertext_and_tag_base64url>`.
  - *Ventaja:* Retrocompatible. Si un registro histórico previo no tiene el prefijo `enc:`, el sistema lo lee como texto plano sin romperse, permitiendo una migración fluida.

---

### 4. Technical Architecture & Data Strategy

```
┌────────────────────────────────────────────────────────┐
│                   Navegador Web                        │
│       Google One-Tap Login  ──> Token Credential       │
└──────────────────────────┬─────────────────────────────┘
                           │ HTTPS POST /api/auth/google
┌──────────────────────────▼─────────────────────────────┐
│             Cloudflare Worker (src/server/index.ts)    │
│  1. Valida Google ID Token                             │
│  2. Obtiene Google sub ID ('user.id')                  │
│  3. Deriva Clave AES-GCM-256 via PBKDF2 (crypto.subtle)│
│     [Material: user.id + SESSION_SECRET + user.salt]   │
└──────────────────────────┬─────────────────────────────┘
                           │ Cifrado/Descifrado transparente
┌──────────────────────────▼─────────────────────────────┐
│            Cloudflare D1 (SQLite)                      │
│  - date, type, amount, currency (Plano para filtros)   │
│  - note: "enc:96bitIV.ciphertextWithGcmTag"            │
│  - raw_input: "enc:..."                                │
└────────────────────────────────────────────────────────┘
```

#### Plan de Pasos de Código:
1. **Módulo de Cifrado Puro (`src/shared/encryption.ts`):**
   - `deriveUserKey(userId, userSalt, systemSecret)` usando `PBKDF2` y `HMAC-SHA-256`.
   - `encryptText(plainText, key)` generando IV de 12 bytes aleatorios y empaquetando `enc:iv.ciphertext`.
   - `decryptText(cipherText, key)` con autenticación AEAD y fallback seguro para texto plano legado.
2. **Pruebas Unitarias (`src/shared/encryption.test.ts`):**
   - Validar que dos textos idénticos generen cifrados distintos (debido al IV aleatorio).
   - Validar que un texto manipulado falle la autenticación GCM.
3. **Integración en `src/server/index.ts`:**
   - Cifrar `note` en `POST /api/transactions` y descifrarlo en `GET /api/transactions`.
   - Cifrar `raw_input` en `POST /api/drafts` y descifrarlo en `GET /api/drafts`.
