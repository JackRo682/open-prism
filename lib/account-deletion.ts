/**
 * Resumable workspace deletion. Accounting and sign-in records are deliberately
 * retained; this endpoint resets a workspace, rather than closing an identity.
 *
 * Operation and worker tokens have no time-based expiry. A delayed writer must
 * not outlive a deletion and recreate personal data. Recovery of a crashed
 * request requires an operator to establish that it cannot resume first.
 */
export class AccountDeletionError extends Error {
 constructor(message:string,readonly status=423,readonly code='ACCOUNT_DELETION_PENDING') { super(message); }
}

type DeletionJob = {
 id:string;user_id:string;status:'pending'|'complete';phase:'waiting'|'objects'|'records'|'complete';
 requested_at:number;updated_at:number;completed_at:number|null;deleted_objects:number;attempts:number;
 last_error_code:string|null;worker_token:string|null;worker_started_at:number|null;
};
export type AccountDeletionStatus = {
 ok:boolean;status:'pending'|'complete';jobId:string;phase:DeletionJob['phase'];
 deletedObjects:number;pendingObjects:number;activeOperations:number;retryable:boolean;
 workerRunning:boolean;lastErrorCode:string|null;requestedAt:number;updatedAt:number;completedAt:number|null;
 message:string;
};
type DeletionOptions={maxObjects?:number;now?:number};
const MAX_OBJECTS=50;
const MAX_ROWS_PER_TABLE=500;
export const DELETION_AUDIT_RETENTION_MS=30*24*60*60*1000;
const RECONCILIATION_ERROR='Workspace data deleted; provider usage requires reconciliation.';
const RETAINED_MESSAGE='로그인 정보와 결제·사용량 원장은 유지되며 로그인 계정은 삭제되지 않습니다.';

function ownerPrefix(owner:string) {
 if(!owner||owner.length>512||/[\\/\u0000-\u001f\u007f]/.test(owner)) {
  throw new AccountDeletionError('계정 저장 경로를 확인할 수 없습니다.',503,'ACCOUNT_STORAGE_NAMESPACE_INVALID');
 }
 return owner+'/';
}
function boundedObjectLimit(value:number|undefined) {
 return Number.isSafeInteger(value)&&Number(value)>0?Math.min(Number(value),MAX_OBJECTS):MAX_OBJECTS;
}

export async function assertAccountAvailable(sql:D1Database,owner:string):Promise<void> {
 if(await sql.prepare("SELECT id FROM account_deletion_jobs WHERE user_id=? AND status='pending'").bind(owner).first()) {
  throw new AccountDeletionError('대화·파일 삭제가 진행 중입니다. 삭제 상태를 확인한 뒤 다시 시도해주세요.');
 }
}

export async function beginAccountOperation(sql:D1Database,owner:string):Promise<string> {
 const token=crypto.randomUUID();
 const inserted=await sql.prepare(`INSERT INTO account_data_operations (token,user_id,started_at)
  SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM account_deletion_jobs WHERE user_id=? AND status='pending') RETURNING token`)
  .bind(token,owner,Date.now(),owner).first();
 if(!inserted)throw new AccountDeletionError('대화·파일 삭제가 진행 중입니다. 삭제 상태를 확인한 뒤 다시 시도해주세요.');
 return token;
}

export async function endAccountOperation(sql:D1Database,token:string):Promise<void> {
 await sql.prepare('DELETE FROM account_data_operations WHERE token=?').bind(token).run();
}

async function jobStatus(sql:D1Database,job:DeletionJob):Promise<AccountDeletionStatus> {
 const [objects,operations]=await Promise.all([
  sql.prepare("SELECT COUNT(*) AS n FROM account_deletion_objects WHERE job_id=? AND state='pending'").bind(job.id).first<{n:number}>(),
  sql.prepare('SELECT COUNT(*) AS n FROM account_data_operations WHERE user_id=?').bind(job.user_id).first<{n:number}>(),
 ]);
 const complete=job.status==='complete',activeOperations=operations?.n||0;
 return {
  ok:complete,status:job.status,jobId:job.id,phase:job.phase,deletedObjects:job.deleted_objects,
  pendingObjects:objects?.n||0,activeOperations,workerRunning:!!job.worker_token,
  retryable:!complete&&job.last_error_code!=='OBJECT_OWNERSHIP_MISMATCH',lastErrorCode:job.last_error_code,
  requestedAt:job.requested_at,updatedAt:job.updated_at,completedAt:job.completed_at,
  message:complete?'대화·파일과 저장된 작업 데이터를 삭제했습니다. '+RETAINED_MESSAGE
   :activeOperations?'삭제 요청을 접수했습니다. 진행 중인 요청이 정리된 후 삭제를 계속합니다. '+RETAINED_MESSAGE
   :'삭제 요청을 접수했습니다. 정리가 완료될 때까지 저장된 데이터 접근이 제한됩니다. 삭제 상태에서 다시 시도할 수 있습니다. '+RETAINED_MESSAGE,
 };
}

export async function getAccountDeletionStatus(sql:D1Database,owner:string):Promise<AccountDeletionStatus|null> {
 const job=await sql.prepare("SELECT * FROM account_deletion_jobs WHERE user_id=? ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END,requested_at DESC,rowid DESC LIMIT 1")
  .bind(owner).first<DeletionJob>();
 return job?jobStatus(sql,job):null;
}

async function currentJobStatus(sql:D1Database,id:string):Promise<AccountDeletionStatus> {
 const job=await sql.prepare('SELECT * FROM account_deletion_jobs WHERE id=?').bind(id).first<DeletionJob>();
 if(!job)throw new AccountDeletionError('삭제 상태를 확인할 수 없습니다. 다시 시도해주세요.',503,'DELETION_STATUS_UNAVAILABLE');
 return jobStatus(sql,job);
}

// Keep deleted manifest entries until database cleanup commits. Retrying a
// request must not re-enqueue a key that is still referenced by a database row.
const TRACKED_OBJECTS=`SELECT key FROM files WHERE user_id=?
 UNION SELECT object_key AS key FROM media_assets WHERE user_id=? AND object_key IS NOT NULL
 UNION SELECT object_key AS key FROM work_artifacts WHERE user_id=?`;

async function queueTrackedObjects(sql:D1Database,job:DeletionJob,limit:number,now:number) {
 const rows=(await sql.prepare(`SELECT key FROM (${TRACKED_OBJECTS}) owned
  WHERE NOT EXISTS (SELECT 1 FROM account_deletion_objects d WHERE d.job_id=? AND d.object_key=owned.key)
  LIMIT ?`).bind(job.user_id,job.user_id,job.user_id,job.id,limit).all<{key:string}>()).results;
 const prefix=ownerPrefix(job.user_id);
 if(rows.some(row=>!row.key.startsWith(prefix)))throw new AccountDeletionError('저장된 파일 소유권 확인이 필요합니다.',503,'OBJECT_OWNERSHIP_MISMATCH');
 if(rows.length)await sql.batch(rows.map(row=>sql.prepare("INSERT OR IGNORE INTO account_deletion_objects (job_id,object_key,state,attempts,updated_at) VALUES (?,?,'pending',0,?)").bind(job.id,row.key,now)));
}

async function deleteQueuedObjects(sql:D1Database,bucket:R2Bucket,job:DeletionJob,limit:number,now:number) {
 if(limit<1)return 0;
 const objects=(await sql.prepare("SELECT object_key FROM account_deletion_objects WHERE job_id=? AND state='pending' ORDER BY object_key LIMIT ?")
  .bind(job.id,limit).all<{object_key:string}>()).results;
 if(!objects.length)return 0;
 const prefix=ownerPrefix(job.user_id);
 if(objects.some(row=>!row.object_key.startsWith(prefix)))throw new AccountDeletionError('저장된 파일 소유권 확인이 필요합니다.',503,'OBJECT_OWNERSHIP_MISMATCH');
 await sql.batch(objects.map(row=>sql.prepare('UPDATE account_deletion_objects SET attempts=attempts+1,updated_at=? WHERE job_id=? AND object_key=?').bind(now,job.id,row.object_key)));
 // R2 acknowledges absent keys too. A failed batch remains fully retryable;
 // no manifest entry is removed merely because a deletion was attempted.
 await bucket.delete(objects.map(row=>row.object_key));
 await sql.batch([
  ...objects.map(row=>sql.prepare("UPDATE account_deletion_objects SET state='done',updated_at=? WHERE job_id=? AND object_key=? AND state='pending'").bind(now,job.id,row.object_key)),
  sql.prepare('UPDATE account_deletion_jobs SET deleted_objects=deleted_objects+?,updated_at=? WHERE id=?').bind(objects.length,now,job.id),
 ]);
 return objects.length;
}

type ContentTable={table:string;where:string;args?:number};
// Explicit coverage is intentional: the schema inventory test fails when a new
// user-owned table is introduced without a deletion or retention decision.
export const WORKSPACE_CONTENT_TABLES:ReadonlyArray<ContentTable>=[
 {table:'conversation_reports',where:'user_id=?'},
 {table:'chat_operations',where:'user_id=?'},
 {table:'message_feedback',where:'user_id=? OR message_id IN (SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=?)',args:2},
 {table:'conversation_revision_messages',where:'revision_id IN (SELECT id FROM conversation_revisions WHERE user_id=?)'},
 {table:'conversation_revisions',where:'user_id=? AND NOT EXISTS (SELECT 1 FROM conversation_revision_messages m WHERE m.revision_id=conversation_revisions.id)'},
 {table:'work_artifacts',where:'user_id=?'},
 {table:'scheduled_tasks',where:'user_id=?'},
 {table:'browser_sessions',where:'user_id=?'},
 {table:'media_assets',where:'user_id=?'},
 {table:'public_shares',where:'user_id=?'},
 {table:'workspace_settings',where:'user_id=?'},
 {table:'files',where:'user_id=?'},
 {table:'messages',where:'conversation_id IN (SELECT id FROM conversations WHERE user_id=?) AND NOT EXISTS (SELECT 1 FROM message_feedback f WHERE f.message_id=messages.id)'},
 {table:'conversations',where:'user_id=? AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=conversations.id) AND NOT EXISTS (SELECT 1 FROM conversation_revisions r WHERE r.conversation_id=conversations.id)'},
];

async function contentRemains(sql:D1Database,owner:string) {
 // Parent rows remain while their children are removed, so checking the direct
 // owner tables also covers the two tables whose owner is a foreign key.
 const tables=WORKSPACE_CONTENT_TABLES.filter(row=>!['messages','conversation_revision_messages'].includes(row.table));
 return !!await sql.prepare(tables.map(row=>`SELECT 1 AS present FROM ${row.table} WHERE user_id=?`).join(' UNION ALL ')+' LIMIT 1')
  .bind(...tables.map(()=>owner)).first();
}

async function deleteContentBatch(sql:D1Database,job:DeletionJob,now:number) {
 await sql.batch([
  ...WORKSPACE_CONTENT_TABLES.map(row=>sql.prepare(`DELETE FROM ${row.table} WHERE rowid IN (SELECT rowid FROM ${row.table} WHERE (${row.where}) LIMIT ${MAX_ROWS_PER_TABLE})`)
   .bind(...Array.from({length:row.args||1},()=>job.user_id))),
  // These records still enforce quotas and preserve unconfirmed reservations.
  // They no longer need arbitrary provider diagnostics that may contain text.
  sql.prepare(`UPDATE usage SET status=CASE WHEN status='pending' THEN 'error' ELSE status END,
   error=CASE WHEN status='pending' THEN ? ELSE NULL END
   WHERE id IN (SELECT id FROM usage WHERE user_id=? AND (status='pending' OR (error IS NOT NULL AND error!=?)) LIMIT ${MAX_ROWS_PER_TABLE})`)
   .bind(RECONCILIATION_ERROR,job.user_id,RECONCILIATION_ERROR),
  sql.prepare("UPDATE account_deletion_jobs SET phase='records',updated_at=?,last_error_code=NULL WHERE id=?").bind(now,job.id),
 ]);
}

async function processDeletion(sql:D1Database,bucket:R2Bucket|undefined,job:DeletionJob,options:DeletionOptions):Promise<AccountDeletionStatus> {
 if(job.status==='complete')return jobStatus(sql,job);
 const now=options.now??Date.now(),limit=boundedObjectLimit(options.maxObjects),token=crypto.randomUUID();
 const claimed=await sql.prepare("UPDATE account_deletion_jobs SET worker_token=?,worker_started_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='pending' AND worker_token IS NULL RETURNING id")
  .bind(token,now,now,job.id).first();
 if(!claimed)return currentJobStatus(sql,job.id);
 try {
  // New shares are blocked by the database barrier. Revocation does not wait
  // for storage or external provider calls to become available.
  await sql.prepare('DELETE FROM public_shares WHERE user_id=?').bind(job.user_id).run();
  const active=await sql.prepare('SELECT token FROM account_data_operations WHERE user_id=? LIMIT 1').bind(job.user_id).first();
  if(active){
   await sql.prepare("UPDATE account_deletion_jobs SET phase='waiting',last_error_code='WAITING_FOR_OPERATIONS',updated_at=? WHERE id=?").bind(now,job.id).run();
  }else if(!bucket||typeof bucket.list!=='function'){
   await sql.prepare("UPDATE account_deletion_jobs SET last_error_code='STORAGE_NOT_CONFIGURED',updated_at=? WHERE id=?").bind(now,job.id).run();
  }else{
   const prefix=ownerPrefix(job.user_id);
   await sql.prepare("UPDATE account_deletion_jobs SET phase='objects',last_error_code=NULL,updated_at=? WHERE id=?").bind(now,job.id).run();
   await queueTrackedObjects(sql,job,limit,now);
   let deleted=await deleteQueuedObjects(sql,bucket,job,limit,now);
   const untracked=await sql.prepare(`SELECT key FROM (${TRACKED_OBJECTS}) owned
    WHERE NOT EXISTS (SELECT 1 FROM account_deletion_objects d WHERE d.job_id=? AND d.object_key=owned.key) LIMIT 1`)
    .bind(job.user_id,job.user_id,job.user_id,job.id).first();
   if(!untracked){
    // Listing the exact authenticated owner prefix also finds upload remnants
    // left between an R2 write and its database insert. No cross-owner sweep.
    const listing=await bucket.list({prefix,limit:Math.max(1,limit-deleted)});
    if(listing.objects.some(object=>!object.key.startsWith(prefix)))throw new AccountDeletionError('저장된 파일 소유권 확인이 필요합니다.',503,'OBJECT_OWNERSHIP_MISMATCH');
    if(listing.objects.length&&deleted<limit){
     await sql.batch(listing.objects.slice(0,limit-deleted).map(object=>sql.prepare(`INSERT INTO account_deletion_objects (job_id,object_key,state,attempts,updated_at)
      VALUES (?,?,'pending',0,?) ON CONFLICT(job_id,object_key) DO UPDATE SET state='pending',updated_at=excluded.updated_at`)
      .bind(job.id,object.key,now)));
     deleted+=await deleteQueuedObjects(sql,bucket,job,limit-deleted,now);
    }
    const remaining=await bucket.list({prefix,limit:1});
    if(!remaining.objects.length&&!remaining.truncated){
     await deleteContentBatch(sql,job,now);
     const unsafeUsage=await sql.prepare('SELECT id FROM usage WHERE user_id=? AND (status=\'pending\' OR (error IS NOT NULL AND error!=?)) LIMIT 1')
      .bind(job.user_id,RECONCILIATION_ERROR).first();
     if(!unsafeUsage&&!await contentRemains(sql,job.user_id)){
      await sql.batch([
       sql.prepare(`DELETE FROM account_deletion_objects WHERE rowid IN (SELECT rowid FROM account_deletion_objects WHERE job_id=? LIMIT ${MAX_ROWS_PER_TABLE})`).bind(job.id),
       sql.prepare("UPDATE account_deletion_jobs SET status='complete',phase='complete',completed_at=?,updated_at=?,last_error_code=NULL WHERE id=? AND worker_token=? AND NOT EXISTS (SELECT 1 FROM account_data_operations WHERE user_id=?) AND NOT EXISTS (SELECT 1 FROM account_deletion_objects WHERE job_id=?)")
        .bind(now,now,job.id,token,job.user_id,job.id),
      ]);
     }
    }
   }
  }
 }catch(error){
  // Do not persist object keys, provider bodies, or exception messages.
  const code=error instanceof AccountDeletionError?error.code:'DELETION_RETRY_REQUIRED';
  await sql.prepare('UPDATE account_deletion_jobs SET last_error_code=?,updated_at=? WHERE id=? AND worker_token=?').bind(code,now,job.id,token).run();
 }finally{
  await sql.prepare('UPDATE account_deletion_jobs SET worker_token=NULL,worker_started_at=NULL WHERE id=? AND worker_token=?').bind(job.id,token).run();
 }
 return currentJobStatus(sql,job.id);
}

export async function requestAccountDeletion(sql:D1Database,bucket:R2Bucket|undefined,owner:string,options:DeletionOptions={}):Promise<AccountDeletionStatus> {
 ownerPrefix(owner);
 const now=options.now??Date.now();
 await sql.prepare("DELETE FROM account_deletion_jobs WHERE id IN (SELECT id FROM account_deletion_jobs WHERE status='complete' AND completed_at<? ORDER BY completed_at LIMIT 100)").bind(now-DELETION_AUDIT_RETENTION_MS).run();
 await sql.prepare(`INSERT OR IGNORE INTO account_deletion_jobs
  (id,user_id,status,phase,requested_at,updated_at,deleted_objects,attempts)
  SELECT ?,?,'pending','waiting',?,?,0,0
  WHERE NOT EXISTS (SELECT 1 FROM account_deletion_jobs WHERE user_id=? AND status='pending')`)
  .bind(crypto.randomUUID(),owner,now,now,owner).run();
 const job=await sql.prepare("SELECT * FROM account_deletion_jobs WHERE user_id=? AND status='pending'").bind(owner).first<DeletionJob>();
 if(!job)return (await getAccountDeletionStatus(sql,owner))!;
 return processDeletion(sql,bucket,job,options);
}

export async function resumePendingAccountDeletions(sql:D1Database,bucket:R2Bucket|undefined,options:{limit?:number;maxObjects?:number;now?:number}={}) {
 const limit=Number.isSafeInteger(options.limit)&&Number(options.limit)>0?Math.min(Number(options.limit),3):2;
 const jobs=(await sql.prepare("SELECT * FROM account_deletion_jobs WHERE status='pending' AND worker_token IS NULL ORDER BY updated_at,id LIMIT ?")
  .bind(limit).all<DeletionJob>()).results;
 const results:AccountDeletionStatus[]=[];
 for(const job of jobs)results.push(await processDeletion(sql,bucket,job,options));
 // Minimal completion audits expire after 30 days; live/pending barriers and
 // operation tokens are never purged by an age-only rule.
 await sql.prepare("DELETE FROM account_deletion_jobs WHERE id IN (SELECT id FROM account_deletion_jobs WHERE status='complete' AND worker_token IS NULL AND completed_at<? ORDER BY completed_at LIMIT 100)")
  .bind((options.now??Date.now())-DELETION_AUDIT_RETENTION_MS).run();
 return results;
}
