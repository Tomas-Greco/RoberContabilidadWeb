import type { PagesFunction } from '@cloudflare/workers-types';
import type { DraftSource, MovementDraftRecord, ParsedMovementDraft } from '../../src/shared/types';
import { errorResponse, jsonResponse, type Env, type RequestData } from './_types';

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (context) => {
  const userId = context.data.user!.id;
  const { results } = await context.env.DB.prepare(
    `SELECT id, user_id, source, raw_input, extracted_json, uncertain_fields, status, matched_transaction_id, created_at
     FROM movement_drafts
     WHERE user_id = ? AND status = 'pending'
     ORDER BY created_at DESC`
  )
    .bind(userId)
    .all<MovementDraftRecord>();

  return jsonResponse({ drafts: results });
};

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (context) => {
  const userId = context.data.user!.id;

  let body: {
    source?: DraftSource;
    raw_input?: string;
    parsed?: ParsedMovementDraft;
  };

  try {
    body = (await context.request.json()) as typeof body;
  } catch {
    return errorResponse('Cuerpo JSON inválido.', 400);
  }

  if (!body.source || !body.parsed) {
    return errorResponse('Faltan datos del borrador.', 400);
  }

  const id = crypto.randomUUID();
  const createdAt = Math.floor(Date.now() / 1000);
  const extractedJson = JSON.stringify(body.parsed);
  const uncertainJson = JSON.stringify(body.parsed.uncertain_fields);

  await context.env.DB.prepare(
    `INSERT INTO movement_drafts (id, user_id, source, raw_input, extracted_json, uncertain_fields, status, matched_transaction_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?)`
  )
    .bind(id, userId, body.source, body.raw_input ?? null, extractedJson, uncertainJson, createdAt)
    .run();

  const draft: MovementDraftRecord = {
    id,
    user_id: userId,
    source: body.source,
    raw_input: body.raw_input ?? null,
    extracted_json: extractedJson,
    uncertain_fields: uncertainJson,
    status: 'pending',
    matched_transaction_id: null,
    created_at: createdAt,
  };

  return jsonResponse({ draft }, 201);
};

export const onRequestPatch: PagesFunction<Env, string, RequestData> = async (context) => {
  const userId = context.data.user!.id;

  let body: {
    id?: string;
    status?: 'confirmed' | 'discarded';
    matched_transaction_id?: string | null;
  };

  try {
    body = (await context.request.json()) as typeof body;
  } catch {
    return errorResponse('Cuerpo JSON inválido.', 400);
  }

  if (!body.id || !body.status) {
    return errorResponse('Faltan id o status del borrador.', 400);
  }

  await context.env.DB.prepare(
    'UPDATE movement_drafts SET status = ?, matched_transaction_id = ? WHERE id = ? AND user_id = ?'
  )
    .bind(body.status, body.matched_transaction_id ?? null, body.id, userId)
    .run();

  return jsonResponse({ ok: true });
};
