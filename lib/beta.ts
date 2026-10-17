import { BillingError } from './billing';

// Micro-USD, reserved before provider access in one atomic SQLite statement.
// Failed/uncertain requests retain their reservation; deleting chats cannot reset it.
export const BETA_OUTPUT = 1024;
export const BETA_INPUT_BYTES = 16000;
export function betaCost(input: number, output: number) {
  return input * 2 + output * 10;
}
export async function reserveBeta(sql: D1Database, owner: string, id: string, input: number, now: number) {
  const amount = betaCost(input, BETA_OUTPUT);
  const day = Math.floor(now / 86400000) * 86400000;
  const row = await sql.prepare(`INSERT INTO usage
    (id,user_id,model,provider,status,created_at,rate_snapshot,reserved_amount)
    SELECT ?,?,'gpt-6.1-sol','openai','pending',?,'beta:v1',?
    WHERE (SELECT COUNT(*) FROM usage WHERE user_id=? AND rate_snapshot='beta:v1' AND created_at>=?) < 20
    AND (SELECT COALESCE(SUM(reserved_amount),0) FROM usage WHERE user_id=? AND rate_snapshot='beta:v1' AND created_at>=?) + ? <= 200000
    AND (SELECT COALESCE(SUM(reserved_amount),0) FROM usage WHERE rate_snapshot='beta:v1') + ? <= 8000000
    AND (SELECT COUNT(*) FROM usage WHERE user_id=? AND rate_snapshot='beta:v1' AND status='pending') < 2
    RETURNING id`).bind(id, owner, now, amount, owner, day, owner, day, amount, amount, owner).first();
  if (!row) throw new BillingError('Beta allowance reached or two responses are already running. Try again later. No payment is required.', 429);
  return amount;
}
