import type { PagesFunction } from '@cloudflare/workers-types';
import type { UserSession } from '../../../src/shared/types';
import { buildSessionCookieHeader, signSessionJwt } from '../_crypto';
import { errorResponse, jsonResponse, type Env, type RequestData } from '../_types';

interface GoogleTokenInfoResponse {
  iss?: string;
  aud?: string;
  sub?: string;
  email?: string;
  email_verified?: string | boolean;
  name?: string;
  picture?: string;
  exp?: string;
  error_description?: string;
}

const DEFAULT_CATEGORIES: ReadonlyArray<{ name: string; kind: 'income' | 'expense' }> = [
  { name: 'Supermercado', kind: 'expense' },
  { name: 'Alimentación', kind: 'expense' },
  { name: 'Transporte', kind: 'expense' },
  { name: 'Servicios', kind: 'expense' },
  { name: 'Salud', kind: 'expense' },
  { name: 'Entretenimiento', kind: 'expense' },
  { name: 'Sueldo', kind: 'income' },
  { name: 'Honorarios', kind: 'income' },
  { name: 'Otros Ingresos', kind: 'income' },
];

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (context) => {
  let body: { credential?: string };
  try {
    body = (await context.request.json()) as { credential?: string };
  } catch {
    return errorResponse('Cuerpo JSON inválido.', 400);
  }

  const credential = body.credential?.trim();
  if (!credential) {
    return errorResponse('Falta el token de Google Identity Services (credential).', 400);
  }

  // Verificar ID Token contra el endpoint oficial de Google sin librerías pesadas de Node
  const verifyUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`;
  const googleRes = await fetch(verifyUrl, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (!googleRes.ok) {
    return errorResponse('Token de Google inválido o expirado.', 401);
  }

  const tokenInfo = (await googleRes.json()) as GoogleTokenInfoResponse;

  // Validar emisor (iss)
  if (
    tokenInfo.iss !== 'accounts.google.com' &&
    tokenInfo.iss !== 'https://accounts.google.com'
  ) {
    return errorResponse('Emisor del token de Google no autorizado.', 401);
  }

  // Validar audiencia (aud) contra GOOGLE_CLIENT_ID configurado en Cloudflare
  if (!context.env.GOOGLE_CLIENT_ID || tokenInfo.aud !== context.env.GOOGLE_CLIENT_ID) {
    return errorResponse('El token no corresponde al Client ID de esta aplicación.', 401);
  }

  // Validar expiración
  const expSeconds = Number.parseInt(tokenInfo.exp ?? '0', 10);
  if (!Number.isFinite(expSeconds) || expSeconds < Math.floor(Date.now() / 1000)) {
    return errorResponse('El token de Google ha expirado.', 401);
  }

  const emailVerified =
    tokenInfo.email_verified === true || tokenInfo.email_verified === 'true';
  if (!tokenInfo.sub || !tokenInfo.email || !emailVerified) {
    return errorResponse('La cuenta de Google debe tener el correo verificado.', 401);
  }

  const user: UserSession = {
    id: tokenInfo.sub,
    email: tokenInfo.email,
    name: tokenInfo.name?.trim() || tokenInfo.email.split('@')[0],
    picture: tokenInfo.picture ?? null,
  };

  // Verificar si el usuario ya existe en D1 para sembrar categorías iniciales en su primer ingreso
  const existingUser = await context.env.DB.prepare('SELECT id FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ id: string }>();

  await context.env.DB.prepare(
    `INSERT INTO users (id, email, name, picture)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       email = excluded.email,
       name = excluded.name,
       picture = excluded.picture`
  )
    .bind(user.id, user.email, user.name, user.picture)
    .run();

  if (!existingUser) {
    const stmts = DEFAULT_CATEGORIES.map((cat) =>
      context.env.DB.prepare(
        'INSERT INTO categories (id, user_id, name, kind, parent_id, archived) VALUES (?, ?, ?, ?, NULL, 0)'
      ).bind(crypto.randomUUID(), user.id, cat.name, cat.kind)
    );
    await context.env.DB.batch(stmts);
  }

  const sessionJwt = await signSessionJwt(user, context.env.SESSION_SECRET);
  const isHttps = new URL(context.request.url).protocol === 'https:';

  return jsonResponse(
    { user },
    200,
    { 'Set-Cookie': buildSessionCookieHeader(sessionJwt, isHttps) }
  );
};
