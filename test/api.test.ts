import { afterEach, beforeEach, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/api.js';
import { openDatabase, seedOrigins } from '../src/db.js';
import { AttributionService } from '../src/service.js';
import type { Hono } from 'hono';
import type { Decision } from '../src/types.js';

let db: DatabaseSync;
let app: Hono;
const FIRST = '2026-10-01T12:00:00.000Z';
beforeEach(() => {
  db = openDatabase(); seedOrigins(db);
  let sequence = 0;
  app = createApp(new AttributionService(db, { now: () => new Date('2026-10-11T12:00:00.000Z'), newClickId: () => `clk_${++sequence}` }));
});
afterEach(() => db.close());
function post(route: string, payload: unknown) {
  return app.request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
}

it('executes the entire HTTP contract without referrer and returns explicit decision and audit responses', async () => {
  const resolved = await post('/origins/tok_cmp_summer/resolve', { idempotency_key: 'tap:1' });
  expect(resolved.status).toBe(201);
  const click = await resolved.json() as { click_id: string };
  expect((await post('/origins/tok_cmp_summer/resolve', { idempotency_key: 'tap:1' })).status).toBe(200);
  const opened = await post('/installations/inst/opens', { opened_at: FIRST, origin_token: 'tok_cmp_summer', click_id: click.click_id });
  expect(opened.status).toBe(201);
  expect((await post('/installations/inst/opens', { opened_at: FIRST, origin_token: 'tok_cmp_summer', click_id: click.click_id })).status).toBe(200);
  const registered = await post('/installations/inst/signup', { signup_id: 'signup', signed_up_at: FIRST });
  expect(registered.status).toBe(200);
  const decision = await registered.json() as Decision;
  expect(decision.origin).toMatchObject({ type: 'campaign', winning_click_id: click.click_id });
  const audit = await app.request('/signups/signup/attribution');
  expect(audit.status).toBe(200);
  expect(await audit.json()).toEqual({ decision, subsequent_receipts: [] });
});

it.each([
  { opened_at: '2026-02-30T00:00:00.000Z' },
  { opened_at: '2026-10-01T12:00:00Z' },
  { opened_at: '2026-10-01T09:00:00.000-03:00' },
  { opened_at: FIRST, origin_token: 'tok_cmp_summer' },
  { opened_at: FIRST, click_id: 'clk_1' },
  { opened_at: FIRST, origin_token: null, click_id: 'clk_1' },
  { opened_at: FIRST, origin_id: 'spoofed' },
  [], null, {},
])('rejects invalid open payload %j without creating an installation', async payload => {
  expect((await post('/installations/inst/opens', payload)).status).toBe(400);
  expect(db.prepare('SELECT COUNT(*) AS count FROM installations').get()?.count).toBe(0);
});

it('returns JSON errors for malformed JSON, unknown routes, unknown origins and inactive origins', async () => {
  const invalid = await app.request('/installations/inst/opens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ error: { code: 'invalid_json' } });
  const wrongType = await app.request('/installations/inst/opens', { method: 'POST', body: '{}' });
  expect(wrongType.status).toBe(400);
  expect((await app.request('/missing')).status).toBe(404);
  expect((await app.request('/signups/missing/attribution')).status).toBe(404);
  expect((await post('/origins/tok_unknown/resolve', { idempotency_key: 'key' })).status).toBe(404);
  expect((await post('/origins/tok_cmp_inactive/resolve', { idempotency_key: 'key' })).status).toBe(410);
});

it('audits invalid token touches, requiring a valid installation and both link fields', async () => {
  expect((await post('/installations/missing/touches', { origin_token: 'tok_unknown', click_id: 'unknown', touched_at: FIRST })).status).toBe(404);
  await post('/installations/inst/opens', { opened_at: FIRST });
  expect((await post('/installations/inst/touches', { touched_at: FIRST })).status).toBe(400);
  expect((await post('/installations/inst/touches', { origin_token: 'tok_unknown', click_id: 'unknown', touched_at: FIRST })).status).toBe(201);
  const result = await post('/installations/inst/signup', { signup_id: 'signup', signed_up_at: FIRST });
  expect(await result.json()).toMatchObject({ origin: { type: 'organic' }, reason: 'all_invalid_origins', touches: [{ reason: 'invalid_token' }] });
  expect((await post('/installations/inst/signup', { signup_id: 'other', signed_up_at: FIRST })).status).toBe(409);
});
