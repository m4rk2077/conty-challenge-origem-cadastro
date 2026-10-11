import { Hono } from 'hono';
import type { Context } from 'hono';
import { AttributionService } from './service.js';
import { AppError, type ClickPayload } from './types.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(400, 'invalid_body', 'O corpo deve ser um objeto JSON');
  }
  return value as Record<string, unknown>;
}

async function body(c: Context, allowed: string[]): Promise<Record<string, unknown>> {
  const mediaType = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') throw new AppError(400, 'invalid_content_type', 'Use Content-Type: application/json');
  let parsed: unknown;
  try { parsed = await c.req.json(); }
  catch { throw new AppError(400, 'invalid_json', 'JSON malformado'); }
  const result = object(parsed);
  if (Object.keys(result).some(k => !allowed.includes(k))) throw new AppError(400, 'unknown_field', 'Campo não previsto no contrato');
  return result;
}

function text(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.trim() !== value) {
    throw new AppError(400, 'invalid_field', `${field} deve ser uma string não vazia, sem espaços nas extremidades (até ${max} caracteres)`);
  }
  return value;
}

function id(value: unknown, field: string): string {
  const result = text(value, field, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) throw new AppError(400, 'invalid_id', `${field} permite letras ASCII, números, _ e -`);
  return result;
}

function timestamp(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) ||
    !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) {
    throw new AppError(400, 'invalid_timestamp', `${field} deve ser um instante UTC válido no formato YYYY-MM-DDTHH:mm:ss.SSSZ`);
  }
  return result;
}

function optionalClick(b: Record<string, unknown>): ClickPayload | undefined {
  if (b.origin_token === undefined && b.click_id === undefined) return undefined;
  return { origin_token: id(b.origin_token, 'origin_token'), click_id: id(b.click_id, 'click_id') };
}

export function createApp(service: AttributionService): Hono {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof AppError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
    console.error(error);
    return c.json({ error: { code: 'internal_error', message: 'Falha interna; a transação foi revertida' } }, 500);
  });
  app.notFound(c => c.json({ error: { code: 'not_found', message: 'Rota não encontrada' } }, 404));
  app.get('/health', c => c.json({ status: 'ok' }));
  app.post('/origins/:originToken/resolve', async c => {
    const b = await body(c, ['idempotency_key', 'original_click_at']);
    const original = b.original_click_at === undefined ? undefined : timestamp(b.original_click_at, 'original_click_at');
    const resolved = service.resolve(id(c.req.param('originToken'), 'originToken'), text(b.idempotency_key, 'idempotency_key'), original);
    return c.json(resolved, resolved.duplicate ? 200 : 201);
  });
  app.post('/installations/:installationId/opens', async c => {
    const b = await body(c, ['opened_at', 'origin_token', 'click_id']);
    const opened = service.open(id(c.req.param('installationId'), 'installationId'), timestamp(b.opened_at, 'opened_at'), optionalClick(b));
    return c.json(opened, opened.first_open ? 201 : 200);
  });
  app.post('/installations/:installationId/touches', async c => {
    const b = await body(c, ['touched_at', 'origin_token', 'click_id']);
    const click = optionalClick(b);
    if (!click) throw new AppError(400, 'missing_click', 'origin_token e click_id são obrigatórios');
    const recorded = service.touch(id(c.req.param('installationId'), 'installationId'), click, timestamp(b.touched_at, 'touched_at'));
    return c.json(recorded, recorded.duplicate ? 200 : 201);
  });
  app.post('/installations/:installationId/signup', async c => {
    const b = await body(c, ['signup_id', 'signed_up_at']);
    return c.json(service.signup(id(c.req.param('installationId'), 'installationId'), id(b.signup_id, 'signup_id'), timestamp(b.signed_up_at, 'signed_up_at')));
  });
  app.get('/signups/:signupId/attribution', c => c.json(service.attribution(id(c.req.param('signupId'), 'signupId'))));
  return app;
}
