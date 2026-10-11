import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db.js';
import { decide } from './policy.js';
import { AppError, type ClickPayload, type Decision, type Installation, type OriginType,
  type Receipt, type ReceiptEvaluation, type TokenState, type Touch } from './types.js';

interface Origin { token: string; origin_type: OriginType; origin_id: string; active: number }
interface ResolvedClick { click_id: string; token: string; original_click_at: string; created_at: string }
interface Signup { signup_id: string; installation_id: string; decision_json: string }
type TouchRow = Omit<Touch, 'recorded_after_signup'> & { recorded_after_signup: number };
type ReceiptRow = Omit<Receipt, 'recorded_after_signup' | 'duplicate'> & { recorded_after_signup: number; duplicate: number };

export interface ServiceOptions {
  now?: () => Date;
  newClickId?: () => string;
}

export class AttributionService {
  private readonly now: () => Date;
  private readonly newClickId: () => string;

  constructor(private readonly db: DatabaseSync, options: ServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newClickId = options.newClickId ?? (() => `clk_${randomUUID()}`);
  }

  resolve(token: string, key: string, originalClickAt?: string) {
    return transaction(this.db, () => {
      const origin = this.db.prepare('SELECT * FROM origin_tokens WHERE token = ?').get(token) as unknown as Origin | undefined;
      if (!origin) throw new AppError(404, 'origin_not_found', 'Token de origem não encontrado');
      if (!origin.active) throw new AppError(410, 'origin_inactive', 'Token de origem inativo');
      let click = this.db.prepare('SELECT * FROM resolved_clicks WHERE token = ? AND idempotency_key = ?').get(token, key) as unknown as ResolvedClick | undefined;
      const duplicate = click !== undefined;
      if (!click) {
        const created = this.now().toISOString();
        click = { click_id: this.newClickId(), token, original_click_at: originalClickAt ?? created, created_at: created };
        this.db.prepare('INSERT INTO resolved_clicks(click_id, token, idempotency_key, original_click_at, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(click.click_id, token, key, click.original_click_at, created);
      }
      const query = new URLSearchParams({ origin_token: token, click_id: click.click_id });
      return { click_id: click.click_id, origin_token: token, original_click_at: click.original_click_at,
        deep_link: `https://app.example.test/open?${query}`, duplicate };
    });
  }

  open(installationId: string, openedAt: string, payload?: ClickPayload) {
    return transaction(this.db, () => {
      const existing = this.installation(installationId);
      if (!existing) {
        this.db.prepare('INSERT INTO installations(installation_id, first_open_at, created_at) VALUES (?, ?, ?)')
          .run(installationId, openedAt, this.now().toISOString());
      }
      const result = payload ? this.recordTouch(installationId, payload, openedAt) : null;
      return { installation_id: installationId, first_open_at: existing?.first_open_at ?? openedAt,
        first_open: !existing, duplicate: result?.duplicate ?? false, touch: result?.touch ?? null,
        receipt: result?.receipt ?? null };
    });
  }

  touch(installationId: string, payload: ClickPayload, touchedAt: string) {
    return transaction(this.db, () => {
      this.requireInstallation(installationId);
      return this.recordTouch(installationId, payload, touchedAt);
    });
  }

  signup(installationId: string, signupId: string, signedUpAt: string): Decision {
    return transaction(this.db, () => {
      const installation = this.requireInstallation(installationId);
      const previous = this.signupForInstallation(installationId);
      if (previous) {
        if (previous.signup_id !== signupId) throw new AppError(409, 'installation_already_signed_up', 'Instalação já possui outro cadastro');
        return JSON.parse(previous.decision_json) as Decision;
      }
      if (this.db.prepare('SELECT signup_id FROM signups WHERE signup_id = ?').get(signupId)) {
        throw new AppError(409, 'signup_id_conflict', 'signup_id já pertence a outra instalação');
      }
      if (Date.parse(signedUpAt) < Date.parse(installation.first_open_at)) {
        throw new AppError(409, 'signup_before_first_open', 'Cadastro não pode ocorrer antes da primeira abertura');
      }
      const decision = decide(installation, signupId, signedUpAt, this.now().toISOString(),
        this.listTouches(installationId), this.listReceipts(installationId));
      this.db.prepare(`INSERT INTO signups(signup_id, installation_id, signed_up_at, origin_type, origin_id,
        winning_click_id, decision_reason, decision_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(signupId, installationId, signedUpAt, decision.origin.type, decision.origin.id,
          decision.origin.winning_click_id, decision.reason, JSON.stringify(decision), decision.decided_at);
      return decision;
    });
  }

  attribution(signupId: string): { decision: Decision; subsequent_receipts: ReceiptEvaluation[] } {
    // One read transaction also gives a consistent audit view across multiple DB connections.
    return transaction(this.db, () => {
      const signup = this.db.prepare('SELECT * FROM signups WHERE signup_id = ?').get(signupId) as unknown as Signup | undefined;
      if (!signup) throw new AppError(404, 'signup_not_found', 'Cadastro não encontrado');
      const decision = JSON.parse(signup.decision_json) as Decision;
      const subsequent = this.listReceipts(signup.installation_id).filter(r => r.receipt_id > decision.receipt_cutoff);
      return { decision, subsequent_receipts: subsequent.map(r => ({ ...r, eligible: false, won: false, reason: 'after_signup' })) };
    });
  }

  private installation(id: string): Installation | undefined {
    return this.db.prepare('SELECT * FROM installations WHERE installation_id = ?').get(id) as unknown as Installation | undefined;
  }

  private requireInstallation(id: string): Installation {
    const result = this.installation(id);
    if (!result) throw new AppError(404, 'installation_not_found', 'Registre a primeira abertura antes');
    return result;
  }

  private signupForInstallation(id: string): Signup | undefined {
    return this.db.prepare('SELECT * FROM signups WHERE installation_id = ?').get(id) as unknown as Signup | undefined;
  }

  private listTouches(id: string): Touch[] {
    const rows = this.db.prepare('SELECT * FROM touches WHERE installation_id = ? ORDER BY click_id COLLATE BINARY').all(id) as unknown as TouchRow[];
    return rows.map(r => ({ ...r, recorded_after_signup: Boolean(r.recorded_after_signup) }));
  }

  private listReceipts(id: string): Receipt[] {
    const rows = this.db.prepare('SELECT * FROM touch_receipts WHERE installation_id = ? ORDER BY receipt_id').all(id) as unknown as ReceiptRow[];
    return rows.map(r => ({ ...r, duplicate: Boolean(r.duplicate), recorded_after_signup: Boolean(r.recorded_after_signup) }));
  }

  private recordTouch(id: string, payload: ClickPayload, touchedAt: string) {
    const receivedAt = this.now().toISOString();
    const afterSignup = this.signupForInstallation(id) !== undefined;
    const previous = this.db.prepare('SELECT * FROM touches WHERE installation_id = ? AND click_id = ?')
      .get(id, payload.click_id) as unknown as TouchRow | undefined;
    let touch: Touch;
    if (previous) {
      touch = { ...previous, recorded_after_signup: Boolean(previous.recorded_after_signup) };
    } else {
      const origin = this.db.prepare('SELECT * FROM origin_tokens WHERE token = ?').get(payload.origin_token) as unknown as Origin | undefined;
      const click = this.db.prepare('SELECT * FROM resolved_clicks WHERE click_id = ?').get(payload.click_id) as unknown as ResolvedClick | undefined;
      let state: TokenState = 'valid';
      if (!origin) state = 'invalid';
      else if (!origin.active) state = 'inactive';
      else if (!click) state = 'unknown_click';
      else if (click.token !== payload.origin_token) state = 'click_token_mismatch';
      touch = { installation_id: id, ...payload, origin_type: state === 'valid' ? origin!.origin_type : null,
        origin_id: state === 'valid' ? origin!.origin_id : null, token_state: state, touched_at: touchedAt,
        original_click_at: click?.token === payload.origin_token ? click.original_click_at : null,
        received_at: receivedAt, recorded_after_signup: afterSignup };
      this.db.prepare(`INSERT INTO touches(installation_id, click_id, origin_token, origin_type, origin_id, touched_at,
        original_click_at, received_at, token_state, recorded_after_signup) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, touch.click_id, touch.origin_token, touch.origin_type, touch.origin_id, touchedAt,
          touch.original_click_at, receivedAt, state, Number(afterSignup));
    }
    const result = this.db.prepare(`INSERT INTO touch_receipts(installation_id, click_id, origin_token, touched_at,
      received_at, duplicate, recorded_after_signup) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, payload.click_id, payload.origin_token, touchedAt, receivedAt, Number(Boolean(previous)), Number(afterSignup));
    const receipt: Receipt = { receipt_id: Number(result.lastInsertRowid), installation_id: id, ...payload,
      touched_at: touchedAt, received_at: receivedAt, duplicate: Boolean(previous), recorded_after_signup: afterSignup };
    return { duplicate: Boolean(previous), touch, receipt };
  }
}
