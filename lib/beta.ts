import { BillingError } from './billing';

// Micro-USD, reserved before provider access in one atomic SQLite statement.
// Failed/uncertain requests retain their reservation; deleting chats cannot reset it.
export const BETA_OUTPUT = 1024;
export const BETA_INPUT_BYTES = 16000;
export function betaCost(input: number, output: number) {
  return input * 2 + output * 10;
}
export async function reserveBeta(sql: D1Database, owner: string, id: string, input: number, now: number, toolReserve = 0, dailyLimit = 200000) {
  if(!Number.isSafeInteger(dailyLimit)||dailyLimit<0||dailyLimit>20000000)throw new BillingError('이용 한도 설정이 올바르지 않습니다.',503);
  const amount = betaCost(input, BETA_OUTPUT) + toolReserve;
  const day = Math.floor(now / 86400000) * 86400000;
  const row = await sql.prepare(`INSERT INTO usage
    (id,user_id,model,provider,status,created_at,rate_snapshot,reserved_amount)
    SELECT ?,?,'gpt-6.1-sol','openai','pending',?,'beta:v1',?
    WHERE (SELECT COUNT(*) FROM usage WHERE user_id=? AND rate_snapshot LIKE 'beta:%' AND created_at>=?) < 20
    AND (SELECT COALESCE(SUM(reserved_amount),0) FROM usage WHERE user_id=? AND rate_snapshot LIKE 'beta:%' AND created_at>=?) + ? <= ?
    AND (SELECT COALESCE(SUM(reserved_amount),0) FROM usage WHERE rate_snapshot LIKE 'beta:%') + ? <= 8000000
    AND (SELECT COUNT(*) FROM usage WHERE user_id=? AND rate_snapshot LIKE 'beta:%' AND status='pending') < 2
    RETURNING id`).bind(id, owner, now, amount, owner, day, owner, day, amount, dailyLimit, amount, owner).first();
  if (!row) throw new BillingError('Beta allowance reached or two responses are already running. Try again later. No payment is required.', 429);
  return amount;
}

/** Media uses the same atomic daily and site-wide beta budget as text. */
export async function reserveMedia(sql: D1Database, owner: string, id: string, model: string, provider: string, amount: number, now: number, dailyLimit = 200000) {
  if(!Number.isSafeInteger(dailyLimit)||dailyLimit<0||dailyLimit>20000000)throw new BillingError('미디어 이용 한도 설정이 올바르지 않습니다.',503);
  if (!Number.isSafeInteger(amount) || amount < 1) throw new BillingError('미디어 사용량 설정이 올바르지 않습니다.', 503);
  const day = Math.floor(now / 86400000) * 86400000;
  const row = await sql.prepare(`INSERT INTO usage
    (id,user_id,model,provider,status,created_at,rate_snapshot,reserved_amount)
    SELECT ?,?,?,?,'pending',?,'beta:media:v1',?
    WHERE (SELECT COUNT(*) FROM usage WHERE user_id=? AND rate_snapshot LIKE 'beta:%' AND created_at>=?) < 20
    AND (SELECT COALESCE(SUM(reserved_amount),0) FROM usage WHERE user_id=? AND rate_snapshot LIKE 'beta:%' AND created_at>=?) + ? <= ?
    AND (SELECT COALESCE(SUM(reserved_amount),0) FROM usage WHERE rate_snapshot LIKE 'beta:%') + ? <= 8000000
    AND (SELECT COUNT(*) FROM usage WHERE user_id=? AND rate_snapshot LIKE 'beta:%' AND status='pending') < 2
    RETURNING id`).bind(id, owner, model, provider, now, amount, owner, day, owner, day, amount, dailyLimit, amount, owner).first();
  if (!row) throw new BillingError(amount > dailyLimit
    ? '이 미디어 작업은 현재 무료 체험의 하루 한도를 초과합니다. 운영자가 미디어 이용 한도를 설정해야 합니다.'
    : '오늘의 이용 한도에 도달했거나 두 작업이 진행 중입니다. 잠시 후 다시 시도해주세요.', 429);
  return amount;
}
