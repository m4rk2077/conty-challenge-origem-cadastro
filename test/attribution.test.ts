import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, seedOrigins } from '../src/db.js';
import { AttributionService } from '../src/service.js';
import { decide } from '../src/policy.js';
import type { ClickPayload } from '../src/types.js';

const FIRST = '2026-10-01T12:00:00.000Z';
const SIGNUP = '2026-10-04T10:00:00.000Z';
const END = '2026-10-08T12:00:00.000Z';
const CAMPAIGN = 'tok_cmp_summer';
const REFERRAL = 'tok_ref_crt123';
const databases = new Set<DatabaseSync>();
const directories: string[] = [];

function setup(path?: string, ids?: string[]) {
  const db = openDatabase(path);
  databases.add(db);
  seedOrigins(db);
  let now = '2026-10-11T12:00:00.000Z';
  let sequence = 0;
  const service = new AttributionService(db, {
    now: () => new Date(now), newClickId: () => ids?.[sequence++] ?? `clk_${String(++sequence).padStart(3, '0')}`,
  });
  function click(token = CAMPAIGN, original = FIRST): ClickPayload {
    const result = service.resolve(token, `key-${sequence}`, original);
    return { origin_token: token, click_id: result.click_id };
  }
  return { db, service, click, setNow: (value: string) => { now = value; } };
}

afterEach(() => {
  for (const db of databases) db.close();
  databases.clear();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.length = 0;
});

describe('resolved links and first app open', () => {
  it('preserves a logical click on retry, including its original metadata', () => {
    const { service } = setup();
    const a = service.resolve(CAMPAIGN, 'browser:tap-1', FIRST);
    const b = service.resolve(CAMPAIGN, 'browser:tap-1', END);
    expect(b).toEqual({ ...a, duplicate: true });
    expect(new URL(a.deep_link).searchParams.get('origin_token')).toBe(CAMPAIGN);
    expect(new URL(a.deep_link).searchParams.get('click_id')).toBe(a.click_id);
    expect(service.resolve(CAMPAIGN, 'browser:tap-2').click_id).not.toBe(a.click_id);
    expect(service.resolve(REFERRAL, 'browser:tap-1').click_id).not.toBe(a.click_id);
  });

  it('uses opened_at for the first touch, keeping original click time only for audit', () => {
    const { service, click } = setup();
    const payload = click(CAMPAIGN, '2026-09-01T00:00:00.000Z');
    const opened = service.open('inst', FIRST, payload);
    expect(opened.touch?.touched_at).toBe(FIRST);
    expect(opened.touch?.original_click_at).toBe('2026-09-01T00:00:00.000Z');
    const signup = service.signup('inst', 'signup', SIGNUP);
    expect(signup.origin.type).toBe('campaign');
    expect(signup.policy.first_open_at).toBe(FIRST);
  });

  it('does not reset first_open_at on earlier or later opens and keeps distinct clicks from one token', () => {
    const { db, service, click } = setup();
    const a = click();
    service.open('inst', FIRST, a);
    const retry = service.open('inst', END, a);
    expect(retry.duplicate).toBe(true);
    expect(retry.touch?.touched_at).toBe(FIRST);
    expect(retry.first_open_at).toBe(FIRST);
    const b = click();
    expect(service.open('inst', SIGNUP, b).first_open_at).toBe(FIRST);
    expect(service.open('inst', '2026-09-01T00:00:00.000Z').first_open_at).toBe(FIRST);
    expect(db.prepare('SELECT COUNT(*) AS count FROM touches').get()?.count).toBe(2);
    const decision = service.signup('inst', 'signup', SIGNUP);
    expect(decision.origin.winning_click_id).toBe(b.click_id);
    expect(decision.receipts.map(r => r.reason)).toEqual(['superseded_by_later_touch', 'duplicate_click', 'last_eligible_touch']);
  });

  it.each(['touches', 'touch_receipts'])('rolls back installation and touch if %s insertion fails', table => {
    const { db, service, click } = setup();
    const payload = click();
    db.exec(`CREATE TRIGGER force_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'forced failure'); END;`);
    expect(() => service.open('inst', FIRST, payload)).toThrow('forced failure');
    expect(db.prepare('SELECT COUNT(*) AS count FROM installations').get()?.count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM touches').get()?.count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM touch_receipts').get()?.count).toBe(0);
    db.exec('DROP TRIGGER force_failure');
    expect(service.open('inst', FIRST, payload).first_open).toBe(true);
  });

  it('isolates touches by installation even with the same resolved click', () => {
    const { service, click } = setup();
    const payload = click();
    service.open('inst_a', FIRST, payload);
    service.open('inst_b', SIGNUP, payload);
    service.touch('inst_b', click(REFERRAL), SIGNUP);
    expect(service.signup('inst_a', 'signup_a', SIGNUP).touches).toHaveLength(1);
    expect(service.signup('inst_b', 'signup_b', SIGNUP).touches).toHaveLength(2);
  });
});

describe('central deterministic attribution policy', () => {
  it('chooses the later eligible link and explains the losing campaign', () => {
    const { service, click } = setup();
    const a = click();
    const b = click(REFERRAL);
    service.open('inst', FIRST, a);
    service.touch('inst', b, '2026-10-03T09:00:00.000Z');
    const result = service.signup('inst', 'signup', SIGNUP);
    expect(result.origin).toEqual({ type: 'referral', id: 'crt_123', winning_click_id: b.click_id });
    expect(result.touches.find(t => t.click_id === a.click_id)).toMatchObject({ eligible: true, won: false, reason: 'superseded_by_later_touch' });
  });

  it.each([['clk_z', 'clk_A'], ['clk_A', 'clk_z']])('breaks ties by ASCII click ID regardless of arrival order (%s, %s)', (first, second) => {
    const { service, click } = setup(undefined, [first, second]);
    service.open('inst', FIRST, click());
    service.touch('inst', click(REFERRAL), FIRST);
    const result = service.signup('inst', 'signup', SIGNUP);
    expect(result.origin.winning_click_id).toBe('clk_A');
    expect(result.touches.find(t => t.click_id === 'clk_A')).toMatchObject({ won: true, reason: 'tie_break_click_id' });
    expect(result.touches.find(t => t.click_id === 'clk_z')).toMatchObject({ eligible: true, won: false, reason: 'lost_tie_break' });
    const reversed = decide({ installation_id: 'inst', first_open_at: FIRST, created_at: FIRST }, 'signup', SIGNUP,
      result.decided_at, [...result.touches].reverse(), result.receipts);
    expect(reversed.origin).toEqual(result.origin);
  });

  it.each([
    [FIRST, SIGNUP, true, 'last_eligible_touch'],
    ['2026-10-01T11:59:59.999Z', SIGNUP, false, 'before_first_open'],
    [END, '2026-10-09T00:00:00.000Z', true, 'last_eligible_touch'],
    ['2026-10-08T12:00:00.001Z', '2026-10-09T00:00:00.000Z', false, 'outside_window'],
    [SIGNUP, SIGNUP, true, 'last_eligible_touch'],
    ['2026-10-04T10:00:00.001Z', SIGNUP, false, 'after_signup'],
  ])('handles boundary touched=%s signup=%s', (touchAt, signupAt, eligible, reason) => {
    const { service, click } = setup();
    service.open('inst', FIRST);
    service.touch('inst', click(), touchAt);
    const result = service.signup('inst', 'signup', signupAt);
    expect(result.touches[0]).toMatchObject({ eligible, won: eligible, reason });
    expect(result.policy.window_ends_at).toBe(END);
    expect(result.policy.boundaries).toBe('inclusive');
  });

  it('excludes a newer touch outside the window instead of losing an earlier eligible origin', () => {
    const { service, click } = setup();
    const first = click();
    service.open('inst', FIRST, first);
    service.touch('inst', click(REFERRAL), '2026-10-10T00:00:00.000Z');
    const result = service.signup('inst', 'signup', '2026-10-11T00:00:00.000Z');
    expect(result.origin.winning_click_id).toBe(first.click_id);
    expect(result.touches[1]?.reason).toBe('outside_window');
  });
});

describe('organic attribution and invalid origin audit', () => {
  it('persists explicit no_touches organic attribution', () => {
    const { db, service } = setup();
    service.open('inst', FIRST);
    expect(service.signup('inst', 'signup', SIGNUP)).toMatchObject({ origin: { type: 'organic', id: null }, reason: 'no_touches', touches: [], receipts: [] });
    expect(db.prepare('SELECT origin_type, decision_reason FROM signups').get()).toMatchObject({ origin_type: 'organic', decision_reason: 'no_touches' });
  });

  it.each([
    ['2026-10-01T11:59:59.999Z', SIGNUP, 'all_before_first_open'],
    ['2026-10-08T12:00:00.001Z', '2026-10-10T00:00:00.000Z', 'all_outside_window'],
    ['2026-10-04T10:00:00.001Z', SIGNUP, 'all_after_signup'],
  ])('persists organic reason %s / %s -> %s for all touches', (touchAt, signupAt, reason) => {
    const { service, click } = setup();
    service.open('inst', FIRST);
    service.touch('inst', click(), touchAt);
    service.touch('inst', click(REFERRAL), touchAt);
    const result = service.signup('inst', 'signup', signupAt);
    expect(result.origin.type).toBe('organic');
    expect(result.reason).toBe(reason);
    expect(result.touches).toHaveLength(2);
    expect(result.touches.every(t => !t.won && !t.eligible)).toBe(true);
  });

  it('keeps unknown, inactive, mismatched and invented click IDs auditable', () => {
    const { service, click } = setup();
    const legitimate = click();
    service.open('inst', FIRST);
    service.touch('inst', { click_id: 'invalid', origin_token: 'tok_invalid' }, FIRST);
    service.touch('inst', { click_id: 'inactive', origin_token: 'tok_cmp_inactive' }, FIRST);
    service.touch('inst', { click_id: 'invented', origin_token: REFERRAL }, FIRST);
    service.touch('inst', { ...legitimate, origin_token: REFERRAL }, FIRST);
    const result = service.signup('inst', 'signup', SIGNUP);
    expect(result.reason).toBe('all_invalid_origins');
    expect(result.origin.type).toBe('organic');
    expect(result.touches.map(t => t.reason).sort()).toEqual(['click_token_mismatch', 'inactive_token', 'invalid_token', 'unknown_click']);
  });

  it('uses no_eligible_touches when organic reasons are mixed', () => {
    const { service, click } = setup();
    service.open('inst', FIRST);
    service.touch('inst', click(), '2026-09-01T00:00:00.000Z');
    service.touch('inst', click(), '2026-10-08T12:00:00.001Z');
    expect(service.signup('inst', 'signup', '2026-10-09T00:00:00.000Z').reason).toBe('no_eligible_touches');
  });

  it('audits conflicting replays but never changes the first touch', () => {
    const { service, click } = setup();
    const payload = click();
    service.open('inst', FIRST, payload);
    const replay = service.touch('inst', { ...payload, origin_token: REFERRAL }, SIGNUP);
    expect(replay).toMatchObject({ duplicate: true, touch: { origin_token: CAMPAIGN, touched_at: FIRST }, receipt: { origin_token: REFERRAL, touched_at: SIGNUP } });
    const result = service.signup('inst', 'signup', SIGNUP);
    expect(result.touches).toHaveLength(1);
    expect(result.origin.type).toBe('campaign');
    expect(result.receipts[1]).toMatchObject({ reason: 'duplicate_click', eligible: false, won: false });
  });
});

describe('frozen signup and durable audit', () => {
  it('excludes every post-signup receipt, including retroactive dates, opens and replays', () => {
    const { service, click, setNow } = setup();
    const first = click();
    service.open('inst', FIRST, first);
    const decision = service.signup('inst', 'signup', SIGNUP);
    setNow('2026-10-11T12:01:00.000Z');
    service.touch('inst', click(REFERRAL), '2026-10-03T00:00:00.000Z');
    service.open('inst', '2026-10-04T11:00:00.000Z', click(REFERRAL));
    service.touch('inst', first, FIRST);
    expect(service.signup('inst', 'signup', END)).toEqual(decision);
    const audit = service.attribution('signup');
    expect(audit.decision).toEqual(decision);
    expect(audit.subsequent_receipts).toHaveLength(3);
    expect(audit.subsequent_receipts.every(t => !t.eligible && !t.won && t.reason === 'after_signup' && t.recorded_after_signup)).toBe(true);
    expect(audit.subsequent_receipts[0]?.received_at).toBe('2026-10-11T12:01:00.000Z');
    expect(audit.subsequent_receipts[2]?.duplicate).toBe(true);
    expect(audit.decision.policy.first_open_at).toBe(FIRST);
  });

  it('uses durable signup order even when received_at clocks are equal or move backwards', () => {
    const { service, click, setNow } = setup();
    service.open('inst', FIRST);
    const original = service.signup('inst', 'signup', SIGNUP);
    setNow('2026-09-01T00:00:00.000Z');
    const touch = service.touch('inst', click(), FIRST);
    expect(touch.touch.recorded_after_signup).toBe(true);
    expect(service.attribution('signup').subsequent_receipts[0]?.reason).toBe('after_signup');
    expect(service.signup('inst', 'signup', SIGNUP)).toEqual(original);
  });

  it('does not replace organic signup with later origins', () => {
    const { service, click } = setup();
    service.open('inst', FIRST);
    const original = service.signup('inst', 'signup', SIGNUP);
    service.touch('inst', click(), FIRST);
    expect(service.signup('inst', 'signup', SIGNUP)).toEqual(original);
    expect(service.attribution('signup').decision.reason).toBe('no_touches');
  });

  it('survives file database reopening with resolver identity, first open, decision and late audit intact', () => {
    mkdirSync(resolve('data'), { recursive: true });
    const directory = mkdtempSync(join(resolve('data'), 'test-'));
    directories.push(directory);
    const path = join(directory, 'attribution.sqlite');
    const { db, service, click } = setup(path);
    const payload = click();
    service.open('inst', FIRST, payload);
    const decision = service.signup('inst', 'signup', SIGNUP);
    service.touch('inst', click(REFERRAL), FIRST);
    const audit = service.attribution('signup');
    db.close();
    databases.delete(db);
    const reopened = setup(path);
    expect(reopened.service.resolve(CAMPAIGN, 'key-0', END).click_id).toBe(payload.click_id);
    expect(reopened.service.attribution('signup')).toEqual(audit);
    expect(reopened.service.open('inst', END, payload)).toMatchObject({ first_open_at: FIRST, duplicate: true });
    expect(reopened.service.signup('inst', 'signup', END)).toEqual(decision);
  });

  it('rejects missing installations, signup before first open and conflicting signup identities', () => {
    const { service } = setup();
    expect(() => service.signup('missing', 'signup', SIGNUP)).toThrow('primeira abertura');
    expect(() => service.touch('missing', { origin_token: CAMPAIGN, click_id: 'clk' }, FIRST)).toThrow('primeira abertura');
    service.open('inst_a', FIRST);
    expect(() => service.signup('inst_a', 'signup', '2026-09-01T00:00:00.000Z')).toThrow('antes');
    service.signup('inst_a', 'signup', SIGNUP);
    expect(() => service.signup('inst_a', 'other', SIGNUP)).toThrow('outro cadastro');
    service.open('inst_b', FIRST);
    expect(() => service.signup('inst_b', 'signup', SIGNUP)).toThrow('outra instalação');
  });
});
