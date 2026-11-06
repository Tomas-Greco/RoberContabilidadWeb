import type { PagesFunction } from '@cloudflare/workers-types';
import { jsonResponse, type Env, type RequestData } from '../_types';

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (context) => {
  return jsonResponse({ user: context.data.user });
};
