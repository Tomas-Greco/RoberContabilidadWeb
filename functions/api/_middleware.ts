import type { PagesFunction } from '@cloudflare/workers-types';
import { parseCookies, SESSION_COOKIE_NAME, verifySessionJwt } from './_crypto';
import { errorResponse, type Env, type RequestData } from './_types';

const PUBLIC_API_PATHS = new Set<string>([
  '/api/auth/google',
  '/api/auth/logout',
  '/api/health',
]);

export const onRequest: PagesFunction<Env, string, RequestData> = async (context) => {
  const url = new URL(context.request.url);
  const cookies = parseCookies(context.request.headers.get('Cookie'));
  const token = cookies[SESSION_COOKIE_NAME];

  const user = token ? await verifySessionJwt(token, context.env.SESSION_SECRET) : null;
  context.data.user = user;

  if (PUBLIC_API_PATHS.has(url.pathname)) {
    return context.next();
  }

  if (!user) {
    return errorResponse('No autenticado. Iniciá sesión con Google para continuar.', 401);
  }

  return context.next();
};
