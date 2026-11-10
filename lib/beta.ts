import { BillingError } from './billing';
import type { Model } from './models';

// Micro-USD, reserved before provider access in one atomic SQLite statement.
// Failed/uncertain requests retain their reservation; deleting chats cannot reset it.
export const BETA_OUTPUT = 1024;
export const BETA_INPUT_BYTES = 16000;
export function betaCost(input: number, output: number) {
  return input * 2 + output * 10;
}
export async function reserveBeta(sql: D1Database, owner: string, id: string, input: number, now: number, toolReserve = 0, dailyLimit = 200000, text?: {model:Model;maxOutput:number}) {
  if(!Number.isSafeInteger(dailyLimit)||dailyLimit<0||dailyLimit>20000000)throw new BillingError('이용 한도 설정이 올바르지 않습니다.',503);
  const rate=text?.model.betaRate;
  if(text&&(!rate||!Number.isSafeInteger(text.maxOutput)||text.maxOutput<1))throw new BillingError('This model does not have a configured trial allowance.',503);
  const amount = (rate?Math.ceil(input*rate.input+text!.maxOutput*rate.output):betaCost(input,BETA_OUTPUT)) + toolReserve;
  if(!Number.isSafeInteger(amount)||amount<1)throw new BillingError('Invalid trial reservation.',503);
  const snapshot=text&&text.model.id!=='gpt-6.1-sol'?'beta:text:v2:'+JSON.stringify({rate,proTokenAccounting:'provider-aggregated'}):'beta:v1';
  const day = Math.floor(now / 86400000) * 86400000;
  const row = await sql.prepare(`INSERT INTO usage
    (id,user_id,model,provider,status,created_at,rate_snapshot,reserved_amount)
    SELECT ?,?,?,?,'pending',?,?,?
    WHERE (SELECT COUNT(*) FROM usage WHERE user_id=? AND rate_snapshot LIKE 'beta:%' AND created_at>=?) < 20
    AND (SELECT COALESCE(SUM(reserved_amount),0) FROM usage WHERE user_id=? AND rate_snapshot LIKE 'beta:%' AND created_at>=?) + ? <= ?
    AND (SELECT COALESCE(SUM(reserved_amount),0) FROM usage WHERE rate_snapshot LIKE 'beta:%') + ? <= 8000000
    AND (SELECT COUNT(*) FROM usage WHERE user_id=? AND rate_snapshot LIKE 'beta:%' AND status='pending') < 2
    RETURNING id`).bind(id, owner, text?.model.id||'gpt-6.1-sol', text?.model.provider||'openai', now, snapshot, amount, owner, day, owner, day, amount, dailyLimit, amount, owner).first();
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

/** Premium text shares the existing daily and lifetime caps; no extra budget is created. */
export async function betaTextOutput(sql:D1Database,owner:string,model:Model,input:number,toolReserve:number,dailyLimit:number,advanced:boolean){
 if(!model.betaRate)throw new BillingError('This model does not have a configured trial allowance.',503);
 if(!advanced)return BETA_OUTPUT;
 const day=Math.floor(Date.now()/86400000)*86400000;
 const spent=await sql.prepare("SELECT COALESCE(SUM(reserved_amount),0) AS amount FROM usage WHERE user_id=? AND rate_snapshot LIKE 'beta:%' AND created_at>=?").bind(owner,day).first<{amount:number}>();
 const available=dailyLimit-(spent?.amount||0)-input*model.betaRate.input-toolReserve;
 const output=Math.min(8192,Math.floor(available/model.betaRate.output));
 if(output<BETA_OUTPUT)throw new BillingError('This model needs more than the remaining trial allowance. Try a shorter conversation or return after the daily reset.',429);
 return output;
}
