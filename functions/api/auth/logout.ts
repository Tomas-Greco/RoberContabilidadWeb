import type { PagesFunction } from '@cloudflare/workers-types';
import { buildClearSessionCookieHeader } from '../_crypto';
import { jsonResponse, type Env, type RequestData } from '../_types';

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (context) => {
  const isHttps = new URL(context.request.url).protocol === 'https:';
  return jsonResponse(
    { ok: true },
    200,
    { 'Set-Cookie': buildClearSessionCookieHeader(isHttps) }
  );
};
