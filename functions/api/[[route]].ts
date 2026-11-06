import type { PagesFunction, Response as CfResponse } from '@cloudflare/workers-types';
import server, { type Env } from '../../src/server/index';

/**
 * Catch-all de Cloudflare Pages Functions (/api/*).
 * Delega todas las rutas de API al handler unificado de src/server/index.ts
 * para garantizar paridad exacta (V1 + V2 + cifrado AES-GCM 256 + /api/bootstrap)
 * tanto en despliegues de Cloudflare Pages como de Cloudflare Workers.
 */
export const onRequest: PagesFunction<Env> = async (context) => {
  const res = await server.fetch(context.request as unknown as Request, context.env);
  return res as unknown as CfResponse;
};
