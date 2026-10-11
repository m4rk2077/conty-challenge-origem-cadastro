export type OriginType = 'campaign' | 'referral';
export type TokenState = 'valid' | 'invalid' | 'inactive' | 'unknown_click' | 'click_token_mismatch';

export interface Installation {
  installation_id: string;
  first_open_at: string;
  created_at: string;
}

export interface Touch {
  installation_id: string;
  click_id: string;
  origin_token: string;
  origin_type: OriginType | null;
  origin_id: string | null;
  token_state: TokenState;
  touched_at: string;
  original_click_at: string | null;
  received_at: string;
  recorded_after_signup: boolean;
}

export interface Receipt {
  receipt_id: number;
  installation_id: string;
  click_id: string;
  origin_token: string;
  touched_at: string;
  received_at: string;
  duplicate: boolean;
  recorded_after_signup: boolean;
}

export type TouchReason = 'last_eligible_touch' | 'tie_break_click_id' |
  'superseded_by_later_touch' | 'lost_tie_break' | 'before_first_open' |
  'outside_window' | 'after_signup' | 'invalid_token' | 'inactive_token' |
  'unknown_click' | 'click_token_mismatch' | 'duplicate_click';

export interface TouchEvaluation extends Touch {
  eligible: boolean;
  won: boolean;
  reason: TouchReason;
}

export interface ReceiptEvaluation extends Receipt {
  eligible: boolean;
  won: boolean;
  reason: TouchReason;
}

export type DecisionReason = 'last_eligible_touch' | 'no_touches' |
  'all_before_first_open' | 'all_outside_window' | 'all_after_signup' |
  'all_invalid_origins' | 'no_eligible_touches';

export interface Decision {
  signup_id: string;
  installation_id: string;
  signed_up_at: string;
  decided_at: string;
  origin: { type: OriginType | 'organic'; id: string | null; winning_click_id: string | null };
  reason: DecisionReason;
  policy: {
    first_open_at: string;
    window_ends_at: string;
    window_days: number;
    boundaries: 'inclusive';
    winner: 'last_eligible_touch';
    tie_break: 'smallest_click_id_ascii';
  };
  touches: TouchEvaluation[];
  receipts: ReceiptEvaluation[];
  receipt_cutoff: number;
}

export interface ClickPayload {
  origin_token: string;
  click_id: string;
}

export class AppError extends Error {
  constructor(public readonly status: 400 | 404 | 409 | 410, public readonly code: string, message: string) {
    super(message);
  }
}
