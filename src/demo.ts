import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { createApp } from './api.js';
import { openDatabase, seedOrigins } from './db.js';
import { AttributionService } from './service.js';
import type { ClickPayload, Decision, ReceiptEvaluation } from './types.js';

// A small mock app: it keeps the resolved payload while retrying the same open.
const dataRoot = resolve('data');
mkdirSync(dataRoot, { recursive: true });
const directory = mkdtempSync(join(dataRoot, 'demo-'));
const path = join(directory, 'demo.sqlite');
let db = openDatabase(path);
seedOrigins(db);
let server = serve({ fetch: createApp(new AttributionService(db)).fetch, port: 0, hostname: '127.0.0.1' });
await once(server, 'listening');
let base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function request<T>(route: string, payload?: unknown): Promise<T> {
  const response = await fetch(`${base}${route}`, payload === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const value: unknown = await response.json();
  assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(value)}`);
  console.log(`${payload === undefined ? 'GET' : 'POST'} ${route} -> ${response.status}`);
  return value as T;
}

try {
  // The shared link has only the token; the resolver issues the logical click ID.
  const sharedCampaign = new URL('https://go.example.test/o/tok_cmp_summer');
  const token = sharedCampaign.pathname.split('/').at(-1)!;
  const campaign = await request<{ click_id: string; deep_link: string }>(`/origins/${token}/resolve`, {
    idempotency_key: 'demo:campaign:1', original_click_at: '2026-09-20T11:00:00.000Z',
  });
  const repeated = await request<{ click_id: string }>(`/origins/${token}/resolve`, { idempotency_key: 'demo:campaign:1' });
  assert.equal(repeated.click_id, campaign.click_id);
  const deepLink = new URL(campaign.deep_link);
  const saved: ClickPayload = { origin_token: deepLink.searchParams.get('origin_token')!, click_id: deepLink.searchParams.get('click_id')! };
  const first = { ...saved, opened_at: '2026-10-01T12:00:00.000Z' };
  await request('/installations/demo_install/opens', first);
  const retry = await request<{ duplicate: boolean }>('/installations/demo_install/opens', first);
  assert.equal(retry.duplicate, true);
  const referral = await request<{ click_id: string }>('/origins/tok_ref_crt123/resolve', { idempotency_key: 'demo:referral:1' });
  await request('/installations/demo_install/touches', {
    click_id: referral.click_id, origin_token: 'tok_ref_crt123', touched_at: '2026-10-03T09:00:00.000Z',
  });
  const signup = { signup_id: 'demo_signup', signed_up_at: '2026-10-04T10:00:00.000Z' };
  const decision = await request<Decision>('/installations/demo_install/signup', signup);
  assert.equal(decision.origin.type, 'referral');
  assert.equal(decision.touches.length, 2);
  assert.equal(decision.receipts.length, 3);
  const later = await request<{ click_id: string }>('/origins/tok_cmp_summer/resolve', { idempotency_key: 'demo:campaign:2' });
  await request('/installations/demo_install/opens', {
    origin_token: 'tok_cmp_summer', click_id: later.click_id, opened_at: '2026-10-02T00:00:00.000Z',
  });
  const same = await request<Decision>('/installations/demo_install/signup', signup);
  assert.deepEqual(same, decision);
  const audit = await request<{ decision: Decision; subsequent_receipts: ReceiptEvaluation[] }>('/signups/demo_signup/attribution');
  assert.equal(audit.subsequent_receipts[0]?.reason, 'after_signup');
  assert.equal(audit.subsequent_receipts[0]?.recorded_after_signup, true);
  console.log(JSON.stringify(audit, null, 2));
  await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
  db.close();
  db = openDatabase(path);
  seedOrigins(db);
  server = serve({ fetch: createApp(new AttributionService(db)).fetch, port: 0, hostname: '127.0.0.1' });
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.deepEqual(await request('/signups/demo_signup/attribution'), audit);
  console.log('DEMO OK: HTTP real sem referrer, retry, dois links, cadastro imutável, recebimento retroativo e persistência após reabertura.');
} finally {
  await new Promise<void>(done => server.close(() => done()));
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
