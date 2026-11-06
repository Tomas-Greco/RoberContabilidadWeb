import type { D1Database, Response as CfResponse } from '@cloudflare/workers-types';
import type { UserSession } from '../../src/shared/types';

export interface Env {
  DB: D1Database;
  GOOGLE_CLIENT_ID: string;
  SESSION_SECRET: string;
}

export interface RequestData extends Record<string, unknown> {
  user: UserSession | null;
}

export function jsonResponse(
  data: unknown,
  status = 200,
  headers?: Record<string, string>
): CfResponse {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
  }) as unknown as CfResponse;
}

export function errorResponse(message: string, status = 400): CfResponse {
  return jsonResponse({ error: message }, status);
}
