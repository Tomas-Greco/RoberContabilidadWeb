import type { PagesFunction } from '@cloudflare/workers-types';
import type { CategoryKind, CategoryRecord } from '../../src/shared/types';
import { errorResponse, jsonResponse, type Env, type RequestData } from './_types';

const VALID_KINDS = new Set<CategoryKind>(['income', 'expense']);

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (context) => {
  const userId = context.data.user!.id;
  const { results } = await context.env.DB.prepare(
    'SELECT id, user_id, name, kind, parent_id, archived FROM categories WHERE user_id = ? ORDER BY kind ASC, name ASC'
  )
    .bind(userId)
    .all<CategoryRecord>();

  return jsonResponse({ categories: results });
};

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (context) => {
  const userId = context.data.user!.id;

  let body: { name?: string; kind?: CategoryKind; parent_id?: string | null };
  try {
    body = (await context.request.json()) as typeof body;
  } catch {
    return errorResponse('Cuerpo JSON inválido.', 400);
  }

  const name = body.name?.trim();
  if (!name) {
    return errorResponse('El nombre de la categoría es obligatorio.', 400);
  }

  if (!body.kind || !VALID_KINDS.has(body.kind)) {
    return errorResponse('El tipo de categoría debe ser income o expense.', 400);
  }

  const parentId = body.parent_id ?? null;
  if (parentId) {
    const parent = await context.env.DB.prepare(
      'SELECT id, kind FROM categories WHERE id = ? AND user_id = ?'
    )
      .bind(parentId, userId)
      .first<{ id: string; kind: CategoryKind }>();

    if (!parent || parent.kind !== body.kind) {
      return errorResponse('Categoría padre inválida.', 400);
    }
  }

  const id = crypto.randomUUID();
  await context.env.DB.prepare(
    'INSERT INTO categories (id, user_id, name, kind, parent_id, archived) VALUES (?, ?, ?, ?, ?, 0)'
  )
    .bind(id, userId, name, body.kind, parentId)
    .run();

  const category: CategoryRecord = {
    id,
    user_id: userId,
    name,
    kind: body.kind,
    parent_id: parentId,
    archived: 0,
  };

  return jsonResponse({ category }, 201);
};
