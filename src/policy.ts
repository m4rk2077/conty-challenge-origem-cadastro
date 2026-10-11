import type { Decision, DecisionReason, Installation, Receipt, ReceiptEvaluation, Touch, TouchEvaluation, TouchReason } from './types.js';

export const WINDOW_DAYS = 7;
export const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

// Receipt order is authoritative for a link received after the signup commit.
function rejection(touch: Touch, firstOpen: number, end: number, signup: number): TouchReason | null {
  if (touch.recorded_after_signup || Date.parse(touch.touched_at) > signup) return 'after_signup';
  if (touch.token_state !== 'valid') {
    if (touch.token_state === 'invalid') return 'invalid_token';
    if (touch.token_state === 'inactive') return 'inactive_token';
    return touch.token_state;
  }
  if (Date.parse(touch.touched_at) < firstOpen) return 'before_first_open';
  if (Date.parse(touch.touched_at) > end) return 'outside_window';
  return null;
}

function organicReason(touches: TouchEvaluation[]): DecisionReason {
  if (touches.length === 0) return 'no_touches';
  if (touches.every(t => t.reason === 'before_first_open')) return 'all_before_first_open';
  if (touches.every(t => t.reason === 'outside_window')) return 'all_outside_window';
  if (touches.every(t => t.reason === 'after_signup')) return 'all_after_signup';
  const invalid: TouchReason[] = ['invalid_token', 'inactive_token', 'unknown_click', 'click_token_mismatch'];
  if (touches.every(t => invalid.includes(t.reason))) return 'all_invalid_origins';
  return 'no_eligible_touches';
}

export function decide(installation: Installation, signupId: string, signedUpAt: string, decidedAt: string,
  touches: Touch[], receipts: Receipt[]): Decision {
  const first = Date.parse(installation.first_open_at);
  const end = first + WINDOW_MS;
  const signup = Date.parse(signedUpAt);
  const eligible = touches.filter(t => rejection(t, first, end, signup) === null)
    .sort((a, b) => Date.parse(b.touched_at) - Date.parse(a.touched_at) ||
      (a.click_id < b.click_id ? -1 : a.click_id > b.click_id ? 1 : 0));
  const winner = eligible[0];
  const tied = winner !== undefined && eligible.some(t => t.click_id !== winner.click_id && t.touched_at === winner.touched_at);
  const evaluations: TouchEvaluation[] = touches.map(t => {
    const rejected = rejection(t, first, end, signup);
    const won = winner?.click_id === t.click_id;
    const reason = rejected ?? (won ? (tied ? 'tie_break_click_id' : 'last_eligible_touch') :
      t.touched_at === winner?.touched_at ? 'lost_tie_break' : 'superseded_by_later_touch');
    return { ...t, eligible: rejected === null, won, reason };
  });
  const byClick = new Map(evaluations.map(t => [t.click_id, t]));
  const evaluatedReceipts: ReceiptEvaluation[] = receipts.map(r => {
    const t = byClick.get(r.click_id);
    if (!t) throw new Error('Receipt has no canonical touch');
    return { ...r, eligible: !r.duplicate && t.eligible, won: !r.duplicate && t.won,
      reason: r.duplicate ? 'duplicate_click' : t.reason };
  });
  return {
    signup_id: signupId, installation_id: installation.installation_id, signed_up_at: signedUpAt, decided_at: decidedAt,
    origin: { type: winner?.origin_type ?? 'organic', id: winner?.origin_id ?? null, winning_click_id: winner?.click_id ?? null },
    reason: winner ? 'last_eligible_touch' : organicReason(evaluations),
    policy: { first_open_at: installation.first_open_at, window_ends_at: new Date(end).toISOString(),
      window_days: WINDOW_DAYS, boundaries: 'inclusive', winner: 'last_eligible_touch', tie_break: 'smallest_click_id_ascii' },
    touches: evaluations, receipts: evaluatedReceipts, receipt_cutoff: receipts.at(-1)?.receipt_id ?? 0,
  };
}
