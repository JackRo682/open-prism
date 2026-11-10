import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../chatgpt-auth';
import { BillingError, billingOverview, upgradeOverview, paymentStatus, adminCancelPayment, getBillingConfig, validateConfig, launchBlockers, paymentRequest, paymentWebhook, settle, cost } from '../../../lib/billing';
import { getWorkspaceSettings, patchWorkspaceSettings, publicMessageContent } from '../../../lib/workspace-settings';
import { WorkspaceToolError } from '../../../lib/workspace-tools';
import { handleMedia } from '../../../lib/media-workspace';
import { handleBrowser } from '../../../lib/browser-workspace';
import { handleScheduledTasks, runDueScheduledTasks, type ScheduledTaskExecutor } from '../../../lib/scheduled-tasks';
import { deleteWorkArtifacts, handleWorkArtifact } from '../../../lib/work-artifacts';
import { handleGuest } from '../../../lib/guest-chat';
import { GuestImportError, importGuestConversation } from '../../../lib/guest-import';
import { buildWorkspaceBootstrap } from '../../../lib/workspace-bootstrap';
import { listWorkspaceConversations } from '../../../lib/workspace-startup';
import { allowAccountMutation, boundedApiRequest, RequestSecurityError, sameOriginMutation } from '../../../lib/request-security';
import { allowAccountRead, allowPublicRead, checkReadiness } from '../../../lib/api-resource-guards';
import { handleConversationActions, listConversationMessages, patchConversation } from '../../../lib/conversation-actions';
import { handleChatGeneration, hasChatBackgroundWork } from '../../../lib/chat-generation';
import { acquireRequestLease, releaseRequestLease, requestLeaseFence } from '../../../lib/request-lease';
import { runnerReady as isRunnerReady, authenticateRunner, allowRunnerInvocation } from '../../../lib/schedule-runner';
import { classifySecurityResponse, recordSecurityEvent, securityOverview, acknowledgeSecurityAlert } from '../../../lib/security-monitoring';
import { AccountDeletionError, assertAccountAvailable, beginAccountOperation, endAccountOperation, requestAccountDeletion, getAccountDeletionStatus, resumePendingAccountDeletions } from '../../../lib/account-deletion';
import { MAX_TEXT_UPLOAD_BYTES, readSingleFileUpload, validateTextUpload } from '../../../lib/upload-validation';
import { handlePublicShares, publicShareResponse } from '../../../lib/public-shares';
import { attachmentDisposition, isOwnedObjectKey, MAX_TEXT_FILE_BYTES, PRIVATE_FILE_HEADERS } from '../../../lib/upload-security';
export const dynamic='force-dynamic';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const uid=()=>crypto.randomUUID();
const mutationAllowed=sameOriginMutation;
const isMutation=(req:Request)=>!['GET','HEAD','OPTIONS'].includes(req.method);
const isRecord=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const safeId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
function db(){if(!env.DB)throw new Error('Database is not configured.');return env.DB;}
const runnerReady=()=>isRunnerReady(env);
const executeScheduled:ScheduledTaskExecutor=async(task,request,owner)=>{
 const internal=new Request(new URL('/api/chat',request.url),{method:'POST',headers:{'Content-Type':'application/json'},signal:request.signal,
  body:JSON.stringify({model:task.model,prompt:task.prompt,workspaceMode:'work',effort:'medium',tool:'chat'})});
 const response=await handle(internal,owner);
 if(!response.ok){const data=await response.json() as {error?:string};throw new Error(data.error||'예약 작업을 실행하지 못했습니다.');}
 const events=(await response.text()).split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
 const error=events.find(event=>event.type==='error');if(error)throw new Error(error.error);
 const done=events.find(event=>event.type==='done');if(!done?.conversationId)throw new Error('완료된 작업 결과를 확인하지 못했습니다.');
 return {conversationId:done.conversationId};
};
async function handle(req:Request,scheduledOwner?:string){
 const path=new URL(req.url).pathname.replace(/^\/api\//,'').split('/');
 if(scheduledOwner&&!(path[0]==='chat'&&req.method==='POST'))return json({error:'허용하지 않는 작업입니다.'},403);
 if(path.join('/')==='tasks/run-due'&&req.method==='POST'){
  if(!runnerReady())return json({error:'자동 실행 서비스 연결이 필요합니다.',code:'SCHEDULE_RUNNER_NOT_CONFIGURED'},503);
  const credentialVersion=await authenticateRunner(req,env);
  if(!credentialVersion)return json({error:'실행 권한이 없습니다.',code:'SCHEDULE_RUNNER_UNAUTHORIZED'},401);
  if(new URL(req.url).search)return json({error:'실행 매개변수는 허용하지 않습니다.',code:'RUNNER_ARGUMENTS_REJECTED'},400);
  if(req.body){const body=await req.json();if(!isRecord(body)||Object.keys(body).length)return json({error:'실행 매개변수는 허용하지 않습니다.',code:'RUNNER_ARGUMENTS_REJECTED'},400);}
  if(!await allowRunnerInvocation(db()))return json({error:'실행 요청이 너무 잦습니다.',code:'RUNNER_RATE_LIMIT'},429);
  const lease=await acquireRequestLease(db(),'schedule-runner:active',900000);
  if(!lease)return json({error:'이전 자동 실행이 진행 중입니다.',code:'RUNNER_BUSY'},409);
  const runId=uid(),started=Date.now();
  try{
   const result=await runDueScheduledTasks(db(),req,executeScheduled,{limit:3,withOperation:async(owner,run)=>{
    const token=await beginAccountOperation(db(),owner);try{return await run();}finally{await endAccountOperation(db(),token);}
   }});
   console.info(JSON.stringify({event:'scheduled_runner_execution',runId,credentialVersion,attempted:result.attempted,completed:result.completed,failed:result.failed,durationMs:Date.now()-started}));
   if(result.failed)await recordSecurityEvent(env.DB,{category:'runner_failure',route:'/api/tasks/run-due',requestId:runId,status:502});
   return json(result);
  }catch(error){await recordSecurityEvent(env.DB,{category:'runner_failure',route:'/api/tasks/run-due',requestId:runId,status:500});throw error;}
  finally{await releaseRequestLease(db(),lease);}
 }
 if(path.join('/')==='health/live'&&req.method==='GET')return json({status:'ok',service:'open-prism'});
 if(path.join('/')==='health/ready'&&req.method==='GET'){
  const ready=await checkReadiness(env);return json(ready,ready.status==='ready'?200:503);
 }
 if(env.DB&&!await allowPublicRead(env.DB,req))return json({error:'Too many requests. Try again shortly.',code:'PUBLIC_READ_RATE_LIMIT'},429);
 if(path.join('/')==='payments/webhook'&&req.method==='POST')return json(await paymentWebhook(req,db()));
 if(path[0]==='public-shares'&&path.length===2&&req.method==='GET'){
  return publicShareResponse(db(),path[1]);
 }
 if(path[0]==='guest'){
  if(!env.DB)return json({error:'체험 서비스를 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.',code:'DATABASE_NOT_READY'},503);
  return await handleGuest(req,path,env.DB,env) ?? json({error:'Endpoint not found.'},404);
 }
 const user=await getChatGPTUser();
 const expectedAccount=req.headers.get('x-prism-rendered-account');
 if(!scheduledOwner&&expectedAccount&&expectedAccount!==user?.userId)return json({error:'로그인 계정이 변경되었습니다. 페이지를 새로고침한 후 다시 시도해 주세요.',code:'ACCOUNT_CHANGED'},409);
 if(path.join('/')==='upgrade'&&req.method==='GET')return json(await upgradeOverview(db(),user?.userId));
 if(path[0]==='bootstrap'&&req.method==='GET')return json(buildWorkspaceBootstrap(user,env));
 if(!user&&!scheduledOwner)return json({error:'메시지를 보내고 작업을 저장하려면 ChatGPT로 로그인해주세요.',code:'SIGN_IN_REQUIRED'},401);
 if(isMutation(req)&&!scheduledOwner&&!mutationAllowed(req))return json({error:'Invalid request origin.'},403);
 const owner=scheduledOwner||user!.userId,sql=db();
 if(!scheduledOwner&&!await allowAccountRead(sql,owner,req))return json({error:'Too many requests. Wait a minute and try again.',code:'ACCOUNT_READ_RATE_LIMIT'},429);
 if(isMutation(req)&&!scheduledOwner&&!await allowAccountMutation(sql,owner))return json({error:'Too many requests. Wait a minute and try again.',code:'ACCOUNT_RATE_LIMIT'},429);
 if(path.join('/')==='account/data'){
  if(req.method==='GET')return json({deletion:await getAccountDeletionStatus(sql,owner)});
  if(req.method==='DELETE'){
   const result=await requestAccountDeletion(sql,env.BUCKET,owner);
   if(result.lastErrorCode&&result.lastErrorCode!=='WAITING_FOR_OPERATIONS')await recordSecurityEvent(sql,{category:'deletion_retry',route:'/api/account/data',requestId:uid(),status:503});
   return json(result,result.status==='complete'?200:202);
  }
 }
 await assertAccountAvailable(sql,owner);
 const operation=isMutation(req)?await beginAccountOperation(sql,owner):undefined;
 let background=false;
 const complete=async()=>{if(operation)await endAccountOperation(sql,operation);};
 try{
  const response=await handleOwner(req,path,sql,owner,!!scheduledOwner,complete);
  background=hasChatBackgroundWork(response);
  return response;
 }finally{if(!background)await complete();}
}
async function handleOwner(req:Request,path:string[],sql:D1Database,owner:string,scheduledOwner:boolean,onWorkComplete:()=>Promise<void>){
 if(path.join('/')==='integrations/google-export'&&req.method==='GET')return json(env.GOOGLE_DRIVE_CLIENT_ID?{configured:true,clientId:env.GOOGLE_DRIVE_CLIENT_ID}:{configured:false});
 if(path.join('/')==='integrations/drive'&&req.method==='GET'){
  const configured=!!(env.GOOGLE_DRIVE_CLIENT_ID&&env.GOOGLE_DRIVE_PICKER_KEY&&env.GOOGLE_DRIVE_APP_ID);
  return json(configured?{configured,clientId:env.GOOGLE_DRIVE_CLIENT_ID,developerKey:env.GOOGLE_DRIVE_PICKER_KEY,appId:env.GOOGLE_DRIVE_APP_ID}:{configured:false});
 }
 const mediaResponse=await handleMedia(req,path,sql,owner,env);if(mediaResponse)return mediaResponse;
 const artifactResponse=await handleWorkArtifact(req,path,sql,owner,env);if(artifactResponse)return artifactResponse;
 const browserResponse=await handleBrowser(req,path,sql,owner,env);if(browserResponse)return browserResponse;
 const taskResponse=await handleScheduledTasks(req,path,sql,owner,executeScheduled,{runnerReady:runnerReady()});if(taskResponse)return taskResponse;
 const conversationActionResponse=await handleConversationActions(req,path,sql,owner,env.ADMIN_USER_ID);if(conversationActionResponse)return conversationActionResponse;
 if(path[0]==='settings'&&path.length===1){
  if(req.method==='GET')return json(await getWorkspaceSettings(sql,owner));
  if(req.method==='PATCH')return json(await patchWorkspaceSettings(sql,owner,await req.json()));
 }
 if(path[0]==='search'&&path.length===1&&req.method==='GET'){
  const query=(new URL(req.url).searchParams.get('q')||'').trim();
  if(query.length>200)return json({error:'Search queries must be 200 characters or fewer.'},400);
  if(!query)return json({results:[]});
  const literal='%'+query.replace(/[\\%_]/g,'\\$&')+'%';
  const rows=(await sql.prepare("SELECT c.id,c.title,c.model,c.updated_at,(SELECT m.content FROM messages m WHERE m.conversation_id=c.id AND m.content LIKE ? ESCAPE '\\' ORDER BY m.created_at DESC LIMIT 1) AS matching_content FROM conversations c WHERE c.user_id=? AND (c.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.content LIKE ? ESCAPE '\\')) ORDER BY c.updated_at DESC LIMIT 50").bind(literal,owner,literal,literal).all<{id:string;title:string;model:string;updated_at:number;matching_content:string|null}>()).results;
  return json({results:rows.map(({matching_content,...row})=>{
   const content=publicMessageContent(matching_content||row.title).replace(/\s+/g,' '),position=content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()),start=Math.max(0,position-60);
   return {...row,snippet:(start?'…':'')+content.slice(start,start+220)+(content.length>start+220?'…':'')};
  })});
 }
 const shareResponse=await handlePublicShares(req,path,sql,owner);if(shareResponse)return shareResponse;
 if(path.length===1&&path[0]==='billing'&&req.method==='GET')return json(await billingOverview(sql,owner));
 if(path.length===3&&path[0]==='payments'&&path[1]==='orders'&&req.method==='GET')return json(await paymentStatus(sql,owner,path[2]));
 if(path[0]==='payments'&&req.method==='POST')return json(await paymentRequest(req,sql,owner,path));
 if(path.join('/')==='admin/payments'&&req.method==='GET'){
  if(!env.ADMIN_USER_ID||owner!==env.ADMIN_USER_ID)return json({error:'Administrator access required.'},403);
  const [payments,refunds]=await Promise.all([
   sql.prepare('SELECT id,user_id,product_id,order_name,amount,refunded_amount,mode,status,created_at,paid_at FROM payments ORDER BY created_at DESC LIMIT 100').all(),
   sql.prepare('SELECT r.id,r.payment_id,r.request_id,r.amount,r.reason,r.status,r.last_error,r.created_at,r.updated_at,p.mode FROM payment_refunds r JOIN payments p ON p.id=r.payment_id ORDER BY r.created_at DESC LIMIT 100').all(),
  ]);
  return json({payments:payments.results,refunds:refunds.results});
 }
 if(path.join('/')==='admin/payments/cancel'&&req.method==='POST'){
  if(!env.ADMIN_USER_ID||owner!==env.ADMIN_USER_ID)return json({error:'Administrator access required.'},403);
  return json(await adminCancelPayment(req,sql));
 }
 if(path.join('/')==='admin/billing'){
  if(!env.ADMIN_USER_ID||owner!==env.ADMIN_USER_ID)return json({error:'Administrator access required.'},403);
  if(req.method==='GET'){const config=await getBillingConfig(sql);return json({config,blockers:launchBlockers(config)});}
  if(req.method==='POST'){
   const config=validateConfig(await req.json());
   await sql.prepare("INSERT INTO billing_config (key,value,updated_at) VALUES ('launch',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(JSON.stringify(config),Date.now()).run();
   return json({ok:true,blockers:launchBlockers(config)});
  }
 }
 if(path.join('/')==='admin/reconcile'&&req.method==='POST'){
  if(!env.ADMIN_USER_ID||owner!==env.ADMIN_USER_ID)return json({error:'Administrator access required.'},403);
  const b:any=await req.json();
  if(!isRecord(b)||b.confirmed!==true||!safeId(b.requestId)||typeof b.input!=='number'||!Number.isSafeInteger(b.input)||b.input<0||typeof b.output!=='number'||!Number.isSafeInteger(b.output)||b.output<0)return json({error:'제공사 사용량을 확인한 뒤 정산을 승인해주세요.'},400);
  const record=await sql.prepare("SELECT * FROM usage WHERE id=? AND status IN ('error','reconciled')").bind(b.requestId).first<any>();
  if(!record?.rate_snapshot)return json({error:'정산 가능한 보류 요청을 찾을 수 없습니다.'},404);
  const charge=cost(JSON.parse(record.rate_snapshot),b.input,b.output);
  await settle(sql,record.user_id,record.id,record.reserved_amount,charge);
  await sql.prepare("UPDATE usage SET input_tokens=?,output_tokens=?,status='reconciled',error=NULL WHERE id=?").bind(b.input,b.output,record.id).run();
  await recordSecurityEvent(sql,{category:'admin_adjustment',route:'/api/admin',requestId:b.requestId,status:200});
  return json({ok:true,charge});
 }
 if(path.join('/')==='conversations/import-guest'&&req.method==='POST'){
  const imported=await importGuestConversation(sql,owner,await req.json());
  return json(imported,imported.reused?200:201);
 }
 if(path[0]==='conversations'){
  if(req.method==='GET'&&!path[1])return json(await listWorkspaceConversations(sql,owner));
  const id=path[1];if(!id)return json({error:'Conversation ID required.'},400);
  const chat=await sql.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').bind(id,owner).first();if(!chat)return json({error:'Conversation not found.'},404);
  if(req.method==='GET')return json({conversation:chat,messages:await listConversationMessages(sql,owner,id)});
  if(req.method==='DELETE'){
   // Serialize deletion with response generation so a streaming answer cannot
   // recreate files or attempt to save messages after its conversation is gone.
   const lock=await acquireRequestLease(sql,'chat:'+id,250000);
   if(!lock)return json({error:'응답 생성 또는 삭제가 진행 중입니다. 작업이 끝난 뒤 다시 삭제해주세요.',code:'CONVERSATION_BUSY'},409);
   try{
    if(!await sql.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').bind(id,owner).first())return json({error:'Conversation not found.'},404);
    const artifacts=(await sql.prepare('SELECT id FROM work_artifacts WHERE conversation_id=? AND user_id=?').bind(id,owner).all<{id:string}>()).results;
    await deleteWorkArtifacts(env,sql,owner,artifacts.map(file=>file.id));
    await sql.batch([
     requestLeaseFence(sql,lock),
     sql.prepare('UPDATE scheduled_tasks SET last_conversation_id=NULL WHERE last_conversation_id=? AND user_id=?').bind(id,owner),
     sql.prepare('DELETE FROM public_shares WHERE conversation_id=? AND user_id=?').bind(id,owner),
     sql.prepare('DELETE FROM messages WHERE conversation_id=?').bind(id),
     sql.prepare('DELETE FROM conversations WHERE id=? AND user_id=?').bind(id,owner)
    ]);
    return json({ok:true});
   }finally{await releaseRequestLease(sql,lock);}
  }
  if(req.method==='PATCH')return json(await patchConversation(sql,owner,id,await req.json()));
 }
 if(path[0]==='usage'&&req.method==='GET'){
  const totals=await sql.prepare("SELECT COUNT(*) AS requests, COALESCE(SUM(CASE WHEN status='complete' THEN 1 ELSE 0 END),0) AS completed,COALESCE(SUM(input_tokens),0) AS input_tokens,COALESCE(SUM(output_tokens),0) AS output_tokens FROM usage WHERE user_id=?").bind(owner).first();
  const recent=(await sql.prepare('SELECT id,model,provider,input_tokens,output_tokens,status,error,duration,created_at FROM usage WHERE user_id=? ORDER BY created_at DESC LIMIT 50').bind(owner).all<Record<string,unknown>>()).results;
  // Older ledger records may contain diagnostics produced before error
  // redaction. Keep the audit record while preventing replay in the user API.
  return json({totals,byProvider:(await sql.prepare('SELECT provider,SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,COUNT(*) AS requests FROM usage WHERE user_id=? GROUP BY provider').bind(owner).all()).results,recent:recent.map(row=>({...row,error:row.error?'요청을 완료하지 못했습니다. 잠시 후 다시 시도해주세요.':null}))});
 }
 if(path[0]==='files'){
  if(req.method==='GET'&&!path[1])return json((await sql.prepare('SELECT id,name,size,type,created_at FROM files WHERE user_id=? ORDER BY created_at DESC').bind(owner).all()).results);
  if(req.method==='POST'&&path.length===1){
   const file=await readSingleFileUpload(req,MAX_TEXT_UPLOAD_BYTES);
   const {name,text,size}=await validateTextUpload(file);
   if(!env.BUCKET)return json({error:'File storage is not configured.'},503);
   if(req.signal.aborted)return json({error:'The upload was cancelled.'},408);
   const id=uid(),key=owner+'/'+id;await env.BUCKET.put(key,text,{httpMetadata:{contentType:'text/plain; charset=utf-8'}});
   try{
    const created=await sql.prepare('INSERT INTO files (id,user_id,name,key,size,type,created_at) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM files WHERE user_id=?)<100 RETURNING id').bind(id,owner,name,key,size,'text/plain',Date.now(),owner).first();
    if(!created){await env.BUCKET.delete(key);return json({error:'Your workspace supports up to 100 files. Remove a file first.'},400);}
   }catch(e){await env.BUCKET.delete(key);throw e;}
   return json({id,name,size});
  }
  if(path.length===2){const file:any=await sql.prepare('SELECT * FROM files WHERE id=? AND user_id=?').bind(path[1],owner).first();if(!file||!isOwnedObjectKey(file.key,owner))return json({error:'File not found.'},404);
   if(req.method==='DELETE'){if(env.BUCKET)await env.BUCKET.delete(file.key);await sql.prepare('DELETE FROM files WHERE id=? AND user_id=?').bind(path[1],owner).run();return json({ok:true});}
   if(req.method==='GET'){const object=await env.BUCKET?.get(file.key);if(!object)return json({error:'File content not found.'},404);if(object.size>MAX_TEXT_FILE_BYTES)return json({error:'Stored file exceeds the supported size.'},413);return new Response(await object.text(),{headers:{...PRIVATE_FILE_HEADERS,'Content-Type':'text/plain; charset=utf-8','Content-Disposition':attachmentDisposition(file.name)}});}
  }
 }
 if(path.join('/')==='admin/security'){
  if(!env.ADMIN_USER_ID||owner!==env.ADMIN_USER_ID)return json({error:'Administrator access required.'},403);
  if(req.method==='GET')return json(await securityOverview(sql));
  if(req.method==='PATCH'){const body=await req.json();return isRecord(body)&&await acknowledgeSecurityAlert(sql,body.id)?json({ok:true}):json({error:'Alert not found.'},404);}
 }
 if(path.join('/')==='admin/deletions/resume'&&req.method==='POST'){
  if(!env.ADMIN_USER_ID||owner!==env.ADMIN_USER_ID)return json({error:'Administrator access required.'},403);
  return json({deletions:await resumePendingAccountDeletions(sql,env.BUCKET,{limit:2,maxObjects:50})});
 }
 if(path[0]==='admin'&&req.method==='GET'){
  if(!env.ADMIN_USER_ID||owner!==env.ADMIN_USER_ID)return json({error:'Administrator access has not been granted to this account.'},403);
  return json({security:await securityOverview(sql),totals:await sql.prepare('SELECT COUNT(*) AS requests,COUNT(DISTINCT user_id) AS users,SUM(input_tokens+output_tokens) AS tokens FROM usage').first(),logs:(await sql.prepare('SELECT id,model,provider,status,error,duration,created_at FROM usage ORDER BY created_at DESC LIMIT 100').all()).results});
 }
 if(path.length===1&&path[0]==='chat'&&req.method==='POST')return handleChatGeneration(req,sql,owner,env,scheduledOwner,onWorkComplete);

 return json({error:'Endpoint not found.'},404);
}
async function dispatch(req:Request){try{
 const serviceRequest=['/api/payments/webhook','/api/tasks/run-due'].includes(new URL(req.url).pathname);
 if(isMutation(req)&&!serviceRequest&&!mutationAllowed(req)){void req.body?.cancel().catch(()=>{});return json({error:'Invalid request origin.',code:'INVALID_ORIGIN'},403);}
 return await handle(await boundedApiRequest(req));
}catch(e){if(e instanceof AccountDeletionError)return json({error:e.message,code:e.code},e.status);if(e instanceof RequestSecurityError)return json({error:e.message,code:e.code},e.status);if(e instanceof GuestImportError)return json({error:e.message,code:'INVALID_GUEST_IMPORT'},e.status);if(e instanceof WorkspaceToolError)return json({error:e.message,code:e.code},e.status);if(e instanceof BillingError)return json({error:e.message,code:e.code},e.status);if(e instanceof SyntaxError)return json({error:'Invalid JSON request.'},400);return json({error:'The request could not be completed. Please retry.'},500);}}
async function safe(req:Request){
 const requestId=uid(),started=Date.now();
 const response=await dispatch(req);
 response.headers.set('X-Request-ID',requestId);
 response.headers.set('X-Content-Type-Options','nosniff');
 response.headers.set('Cache-Control',response.headers.get('Cache-Control')?.includes('no-transform')?'no-store, no-transform':'no-store');
 if(response.status===429&&!response.headers.has('Retry-After'))response.headers.set('Retry-After','60');
 // SignalBrief's request-context pattern: never log prompts, emails or keys.
 const durationMs=Date.now()-started;
 console.info(JSON.stringify({event:'api_request',requestId,method:req.method,status:response.status,durationMs}));
 const securityEvent=classifySecurityResponse(req,response,requestId,durationMs);
 if(securityEvent)await recordSecurityEvent(env.DB,securityEvent);
 return response;
}
export const GET=safe;export const POST=safe;export const PATCH=safe;export const DELETE=safe;
