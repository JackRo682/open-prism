import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../chatgpt-auth';
import { MODELS, PROVIDERS, findModel, Provider } from '../../../lib/models';
import { invokeProvider, Turn } from '../../../lib/provider';
import { BillingError, billingOverview, getBillingConfig, validateConfig, launchBlockers, paymentRequest, paymentWebhook, reserve, settle, cost } from '../../../lib/billing';
import { reserveBeta, betaCost, BETA_OUTPUT, BETA_INPUT_BYTES } from '../../../lib/beta';
import { getWorkspaceSettings, patchWorkspaceSettings, withWorkspaceContext, publicMessageContent } from '../../../lib/workspace-settings';
import { betaDailyLimit, getWorkspaceCapabilities, validateToolRequest, withToolContext, WorkspaceToolError } from '../../../lib/workspace-tools';
import { handleMedia } from '../../../lib/media-workspace';
import { handleBrowser } from '../../../lib/browser-workspace';
import { handleScheduledTasks, runDueScheduledTasks, type ScheduledTaskExecutor } from '../../../lib/scheduled-tasks';
import { deleteWorkArtifacts, handleWorkArtifact, storeWorkArtifacts } from '../../../lib/work-artifacts';
export const dynamic='force-dynamic';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const uid=()=>crypto.randomUUID();
function mutationAllowed(req:Request){const origin=req.headers.get('origin');return !origin||origin===new URL(req.url).origin;}
function db(){if(!env.DB)throw new Error('Database is not configured.');return env.DB;}
const runnerReady=()=>env.SCHEDULE_RUNNER_ENABLED==='true'&&!!env.SCHEDULE_RUNNER_SECRET&&env.SCHEDULE_RUNNER_SECRET.length>=32;
async function secretMatches(provided:string,expected:string){
 const encode=new TextEncoder();
 const [a,b]=await Promise.all([crypto.subtle.digest('SHA-256',encode.encode(provided)),crypto.subtle.digest('SHA-256',encode.encode(expected))]);
 const left=new Uint8Array(a),right=new Uint8Array(b);let diff=0;
 for(let i=0;i<left.length;i++)diff|=left[i]^right[i];return diff===0;
}
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
  const auth=req.headers.get('authorization')||'';
  if(!auth.startsWith('Bearer ')||!await secretMatches(auth.slice(7),env.SCHEDULE_RUNNER_SECRET!))return json({error:'실행 권한이 없습니다.'},401);
  return json(await runDueScheduledTasks(db(),req,executeScheduled,{limit:3}));
 }
 if(path.join('/')==='health/live'&&req.method==='GET')return json({status:'ok',service:'open-prism'});
 if(path.join('/')==='health/ready'&&req.method==='GET'){
  try{await db().batch(['usage','scheduled_tasks','media_assets','browser_sessions','work_artifacts'].map(table=>db().prepare(`SELECT id FROM ${table} LIMIT 1`)));}catch{return json({status:'unavailable',code:'DATABASE_NOT_READY'},503);}
  if(!env.BUCKET)return json({status:'unavailable',code:'STORAGE_NOT_READY'},503);
  if(!env.OPENAI_API_KEY)return json({status:'unavailable',code:'PROVIDER_NOT_READY'},503);
  return json({status:'ready',service:'open-prism'});
 }
 if(path.join('/')==='payments/webhook'&&req.method==='POST')return json(await paymentWebhook(req,db()));
 if(path[0]==='public-shares'&&path.length===2&&req.method==='GET'){
  if(!/^[a-f0-9]{64}$/.test(path[1]))return json({error:'Shared conversation not found.'},404);
  const share=await db().prepare('SELECT title,snapshot,created_at FROM public_shares WHERE token=?').bind(path[1]).first<{title:string;snapshot:string;created_at:number}>();
  if(!share)return json({error:'This shared conversation is unavailable or has been revoked.'},404);
  return json({title:share.title,created_at:share.created_at,messages:JSON.parse(share.snapshot)});
 }
 const user=await getChatGPTUser();
 if(path[0]==='bootstrap'&&req.method==='GET')return json({user:user?{name:user.fullName||user.email.split('@')[0],email:user.email}:null,beta:env.BETA_MODE==='true',models:env.BETA_MODE==='true'?MODELS.filter(m=>m.id==='gpt-6.1-sol'):MODELS,providers:Object.fromEntries(Object.entries(PROVIDERS).map(([p,v])=>[p,{configured:!!env[v.secret as keyof typeof env]}])),mediaModels:{image:env.OPENAI_IMAGE_MODEL||'gpt-image-2.5-flare',video:env.GEMINI_VIDEO_MODEL||'gemini-omni-1.1-flash',music:env.GEMINI_MUSIC_MODEL||'lyria-3-clip-preview'},capabilities:{...getWorkspaceCapabilities(env),drive:!!(env.GOOGLE_DRIVE_CLIENT_ID&&env.GOOGLE_DRIVE_PICKER_KEY&&env.GOOGLE_DRIVE_APP_ID),remoteBrowser:!!env.BROWSERLESS_API_TOKEN,scheduled:runnerReady(),codeExecution:env.BETA_MODE==='true'&&!!env.OPENAI_API_KEY&&env.WORK_CODE_EXECUTION_ENABLED!=='false'},isAdmin:!!user&&!!env.ADMIN_USER_ID&&user.userId===env.ADMIN_USER_ID});
 if(!user&&!scheduledOwner)return json({error:'메시지를 보내고 작업을 저장하려면 ChatGPT로 로그인해주세요.',code:'SIGN_IN_REQUIRED'},401);
 if(req.method!=='GET'&&!mutationAllowed(req))return json({error:'Invalid request origin.'},403);
 const owner=scheduledOwner||user!.userId,sql=db();
 if(path.join('/')==='integrations/drive'&&req.method==='GET'){
  const configured=!!(env.GOOGLE_DRIVE_CLIENT_ID&&env.GOOGLE_DRIVE_PICKER_KEY&&env.GOOGLE_DRIVE_APP_ID);
  return json(configured?{configured,clientId:env.GOOGLE_DRIVE_CLIENT_ID,developerKey:env.GOOGLE_DRIVE_PICKER_KEY,appId:env.GOOGLE_DRIVE_APP_ID}:{configured:false});
 }
 const mediaResponse=await handleMedia(req,path,sql,owner,env);if(mediaResponse)return mediaResponse;
 const artifactResponse=await handleWorkArtifact(req,path,sql,owner,env);if(artifactResponse)return artifactResponse;
 const browserResponse=await handleBrowser(req,path,sql,owner,env);if(browserResponse)return browserResponse;
 const taskResponse=await handleScheduledTasks(req,path,sql,owner,executeScheduled,{runnerReady:runnerReady()});if(taskResponse)return taskResponse;
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
 if(path[0]==='shares'){
  if(path.length===1&&req.method==='GET')return json({shares:(await sql.prepare('SELECT id,token,title,conversation_id,created_at FROM public_shares WHERE user_id=? ORDER BY created_at DESC').bind(owner).all()).results});
  if(path.length===1&&req.method==='POST'){
   const body=await req.json() as {conversationId?:unknown}|null;
   if(!body||typeof body.conversationId!=='string'||body.conversationId.length>100)return json({error:'A valid conversation is required.'},400);
   const chat=await sql.prepare('SELECT id,title FROM conversations WHERE id=? AND user_id=?').bind(body.conversationId,owner).first<{id:string;title:string}>();
   if(!chat)return json({error:'Conversation not found.'},404);
   const messages=(await sql.prepare('SELECT role,content,model,created_at FROM messages WHERE conversation_id=? ORDER BY created_at,rowid').bind(chat.id).all<{role:string;content:string;model:string|null;created_at:number}>()).results;
   if(!messages.length)return json({error:'Send a message before sharing this conversation.'},400);
   const snapshot=JSON.stringify(messages.map(message=>({...message,content:publicMessageContent(message.content)})));
   if(new TextEncoder().encode(snapshot).length>1000000)return json({error:'This conversation is too large to share. Create a shorter conversation.'},400);
   const id=uid(),token=Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('');
   const created=await sql.prepare('INSERT INTO public_shares (id,user_id,conversation_id,token,title,snapshot,created_at) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM public_shares WHERE user_id=?)<100 RETURNING id').bind(id,owner,chat.id,token,chat.title,snapshot,Date.now(),owner).first<{id:string}>();
   if(!created)return json({error:'Revoke an existing link before creating more than 100 public links.'},400);
   return json({id,token,url:new URL('/share/'+token,req.url).href},201);
  }
  if(path.length===2&&req.method==='DELETE'){
   const share=await sql.prepare('SELECT id FROM public_shares WHERE id=? AND user_id=?').bind(path[1],owner).first();
   if(!share)return json({error:'Shared conversation not found.'},404);
   await sql.prepare('DELETE FROM public_shares WHERE id=? AND user_id=?').bind(path[1],owner).run();
   return json({ok:true});
  }
 }
 if(path[0]==='billing'&&req.method==='GET')return json(await billingOverview(sql,owner));
 if(path[0]==='payments'&&req.method==='POST')return json(await paymentRequest(req,sql,owner,path));
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
  if(b.confirmed!==true||typeof b.requestId!=='string')return json({error:'제공사 사용량을 확인한 뒤 정산을 승인해주세요.'},400);
  const record=await sql.prepare("SELECT * FROM usage WHERE id=? AND status IN ('error','reconciled')").bind(b.requestId).first<any>();
  if(!record?.rate_snapshot)return json({error:'정산 가능한 보류 요청을 찾을 수 없습니다.'},404);
  const charge=cost(JSON.parse(record.rate_snapshot),b.input,b.output);
  await settle(sql,record.user_id,record.id,record.reserved_amount,charge);
  await sql.prepare("UPDATE usage SET input_tokens=?,output_tokens=?,status='reconciled',error=NULL WHERE id=?").bind(b.input,b.output,record.id).run();
  return json({ok:true,charge});
 }
 if(path.join('/')==='account/data'&&req.method==='DELETE'){
  if(await sql.prepare("SELECT id FROM usage WHERE user_id=? AND status='pending'").bind(owner).first())return json({error:'진행 중인 응답이 끝난 뒤 삭제해주세요.'},409);
  if(await sql.prepare('SELECT id FROM scheduled_tasks WHERE user_id=? AND run_token IS NOT NULL AND locked_until>?').bind(owner,Date.now()).first())return json({error:'진행 중인 예약 작업이 끝난 뒤 삭제해주세요.'},409);
  const owned=(await sql.prepare("SELECT key FROM files WHERE user_id=? UNION ALL SELECT object_key AS key FROM media_assets WHERE user_id=? AND object_key IS NOT NULL UNION ALL SELECT object_key AS key FROM work_artifacts WHERE user_id=?").bind(owner,owner,owner).all<{key:string}>()).results;
  for(const file of owned)await env.BUCKET?.delete(file.key);
  await sql.batch([sql.prepare('DELETE FROM work_artifacts WHERE user_id=?').bind(owner),sql.prepare('DELETE FROM scheduled_tasks WHERE user_id=?').bind(owner),sql.prepare('DELETE FROM browser_sessions WHERE user_id=?').bind(owner),sql.prepare('DELETE FROM media_assets WHERE user_id=?').bind(owner),sql.prepare('DELETE FROM public_shares WHERE user_id=?').bind(owner),sql.prepare('DELETE FROM workspace_settings WHERE user_id=?').bind(owner),sql.prepare('DELETE FROM files WHERE user_id=?').bind(owner),sql.prepare('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id=?)').bind(owner),sql.prepare('DELETE FROM conversations WHERE user_id=?').bind(owner)]);
  return json({ok:true,message:'대화와 파일을 삭제했습니다. 결제·사용량 원장은 정산을 위해 보존됩니다. ChatGPT 계정은 삭제되지 않습니다.'});
 }
 if(path[0]==='conversations'){
  if(req.method==='GET'&&!path[1])return json((await sql.prepare('SELECT id,title,model,created_at,updated_at FROM conversations WHERE user_id=? ORDER BY updated_at DESC LIMIT 200').bind(owner).all()).results);
  const id=path[1];if(!id)return json({error:'Conversation ID required.'},400);
  const chat=await sql.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').bind(id,owner).first();if(!chat)return json({error:'Conversation not found.'},404);
  if(req.method==='GET')return json({conversation:chat,messages:(await sql.prepare('SELECT id,role,content,model,created_at FROM messages WHERE conversation_id=? ORDER BY created_at,rowid').bind(id).all()).results});
  if(req.method==='DELETE'){
   const artifacts=(await sql.prepare('SELECT id FROM work_artifacts WHERE conversation_id=? AND user_id=?').bind(id,owner).all<{id:string}>()).results;
   await deleteWorkArtifacts(env,sql,owner,artifacts.map(file=>file.id));
   await sql.batch([sql.prepare('UPDATE scheduled_tasks SET last_conversation_id=NULL WHERE last_conversation_id=? AND user_id=?').bind(id,owner),sql.prepare('DELETE FROM messages WHERE conversation_id=?').bind(id),sql.prepare('DELETE FROM conversations WHERE id=? AND user_id=?').bind(id,owner)]);return json({ok:true});
  }
  if(req.method==='PATCH'){const b:any=await req.json();if(typeof b.title!=='string'||!b.title.trim()||b.title.length>100)return json({error:'Use a title between 1 and 100 characters.'},400);await sql.prepare('UPDATE conversations SET title=?,updated_at=? WHERE id=? AND user_id=?').bind(b.title.trim(),Date.now(),id,owner).run();return json({ok:true});}
 }
 if(path[0]==='usage'&&req.method==='GET'){
  const totals=await sql.prepare("SELECT COUNT(*) AS requests, COALESCE(SUM(CASE WHEN status='complete' THEN 1 ELSE 0 END),0) AS completed,COALESCE(SUM(input_tokens),0) AS input_tokens,COALESCE(SUM(output_tokens),0) AS output_tokens FROM usage WHERE user_id=?").bind(owner).first();
  return json({totals,byProvider:(await sql.prepare('SELECT provider,SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,COUNT(*) AS requests FROM usage WHERE user_id=? GROUP BY provider').bind(owner).all()).results,recent:(await sql.prepare('SELECT id,model,provider,input_tokens,output_tokens,status,error,duration,created_at FROM usage WHERE user_id=? ORDER BY created_at DESC LIMIT 50').bind(owner).all()).results});
 }
 if(path[0]==='files'){
  if(req.method==='GET'&&!path[1])return json((await sql.prepare('SELECT id,name,size,type,created_at FROM files WHERE user_id=? ORDER BY created_at DESC').bind(owner).all()).results);
  if(req.method==='POST'){
   if(Number(req.headers.get('content-length')||0)>150000)return json({error:'File must be smaller than 128 KB.'},413);
   const form=await req.formData(),file=form.get('file');if(!(file instanceof File))return json({error:'Choose a text file.'},400);
   if(file.size>131072||! /\.(txt|md|csv|json|ts|tsx|js|jsx|py|html|css|xml|yaml|yml|sql)$/i.test(file.name))return json({error:'Upload text, Markdown, CSV, JSON, or source code up to 128 KB.'},400);
   if(!env.BUCKET)return json({error:'File storage is not configured.'},503);
   const count:any=await sql.prepare('SELECT COUNT(*) AS n FROM files WHERE user_id=?').bind(owner).first();if(count.n>=100)return json({error:'Your workspace supports up to 100 files. Remove a file first.'},400);
   const text=await file.text();if(text.includes('\u0000'))return json({error:'Only plain text files are supported.'},400);
   const id=uid(),key=owner+'/'+id;await env.BUCKET.put(key,text,{httpMetadata:{contentType:'text/plain; charset=utf-8'}});
   try{await sql.prepare('INSERT INTO files (id,user_id,name,key,size,type,created_at) VALUES (?,?,?,?,?,?,?)').bind(id,owner,file.name.slice(0,150),key,file.size,'text/plain',Date.now()).run();}catch(e){await env.BUCKET.delete(key);throw e;}
   return json({id,name:file.name,size:file.size});
  }
  if(path[1]){const file:any=await sql.prepare('SELECT * FROM files WHERE id=? AND user_id=?').bind(path[1],owner).first();if(!file)return json({error:'File not found.'},404);
   if(req.method==='DELETE'){if(env.BUCKET)await env.BUCKET.delete(file.key);await sql.prepare('DELETE FROM files WHERE id=? AND user_id=?').bind(path[1],owner).run();return json({ok:true});}
   if(req.method==='GET'){const object=await env.BUCKET?.get(file.key);if(!object)return json({error:'File content not found.'},404);return new Response(await object.text(),{headers:{'Content-Type':'text/plain; charset=utf-8','X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'}});}
  }
 }
 if(path[0]==='admin'&&req.method==='GET'){
  if(!env.ADMIN_USER_ID||owner!==env.ADMIN_USER_ID)return json({error:'Administrator access has not been granted to this account.'},403);
  return json({totals:await sql.prepare('SELECT COUNT(*) AS requests,COUNT(DISTINCT user_id) AS users,SUM(input_tokens+output_tokens) AS tokens FROM usage').first(),logs:(await sql.prepare('SELECT id,model,provider,status,error,duration,created_at FROM usage ORDER BY created_at DESC LIMIT 100').all()).results});
 }
 if(path[0]==='chat'&&req.method==='POST'){
  if(req.signal.aborted)return json({error:'요청이 취소되었습니다.'},408);
  if(Number(req.headers.get('content-length')||0)>100000)return json({error:'Request is too large.'},413);
  const body:any=await req.json();
  if(!body||typeof body!=='object'||Array.isArray(body))return json({error:'Provide a valid chat request.'},400);
  const model=findModel(body.model);
  if(!model||typeof body.prompt!=='string'||!body.prompt.trim()||body.prompt.length>32000)return json({error:'Choose a valid model and enter a prompt under 32,000 characters.'},400);
  const {tool,researchSources}=validateToolRequest(body,getWorkspaceCapabilities(env));
  if(tool==='image'||tool==='video'||tool==='music')return json({error:'미디어 생성 화면에서 요청해주세요.',code:'USE_MEDIA_ENDPOINT'},400);
  const webResearch=tool==='research'&&researchSources.web;
  const codeExecution=body.workspaceMode==='work'&&tool==='chat'&&model.provider==='openai'&&env.BETA_MODE==='true'&&env.WORK_CODE_EXECUTION_ENABLED!=='false';
  if(webResearch&&model.provider!=='openai')return json({error:'웹 리서치를 사용할 때는 연결된 OpenAI 모델을 선택해주세요.'},400);
  if(body.workspaceMode!==undefined&&body.workspaceMode!=='chat'&&body.workspaceMode!=='work')return json({error:'Choose chat or work mode.'},400);
  if(body.skillId!==undefined&&(typeof body.skillId!=='string'||!body.skillId||body.skillId.length>100))return json({error:'Select a valid saved skill.'},400);
  const effort=body.effort||'medium';if(model.efforts.length&&!model.efforts.includes(effort))return json({error:'This reasoning level is not supported by the selected model.'},400);
  const secret=PROVIDERS[model.provider].secret;const key=env[secret as keyof typeof env] as string|undefined;
  if(!key)return json({error:PROVIDERS[model.provider].name+' is not connected yet. Configure '+secret+' as a server secret to enable real responses.',code:'PROVIDER_NOT_CONFIGURED',provider:model.provider},503);
  if(await sql.prepare('SELECT user_id FROM account_flags WHERE user_id=?').bind(owner).first())return json({error:'결제 정산 확인이 필요한 계정입니다.'},403);
  const beta=env.BETA_MODE==='true';
  if(beta&&(model.id!=='gpt-6.1-sol'||body.pro))return json({error:'The free beta currently supports GPT-6.1 Sol standard mode only.'},403);
  const billing=await getBillingConfig(sql),rate=billing.rates[model.id];
  if(!beta&&!rate)return json({error:'이 모델의 사용량 차감 단가가 아직 확정되지 않았습니다.',code:'PRICING_NOT_CONFIGURED'},503);
  if(body.fileIds&&(!Array.isArray(body.fileIds)||body.fileIds.length>3||body.fileIds.some((v:any)=>typeof v!=='string')))return json({error:'Attach at most three valid files.'},400);
  const now=Date.now(),bucket=owner+':'+Math.floor(now/60000);
  await sql.prepare('DELETE FROM rate_limits WHERE expires_at<?').bind(now).run();
  const limit:any=await sql.prepare('INSERT INTO rate_limits (key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(bucket,now+120000).first();if(limit.count>20)return json({error:'Too many requests. Wait a minute and try again.'},429);
  let conversationId=body.conversationId||uid();if(typeof conversationId!=='string'||conversationId.length>100)return json({error:'Invalid conversation.'},400);
  if(body.conversationId&&!await sql.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').bind(conversationId,owner).first())return json({error:'Conversation not found.'},404);
  const lockKey='chat:'+conversationId;
  const lock=await sql.prepare('INSERT INTO rate_limits (key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=1,expires_at=excluded.expires_at WHERE expires_at<? RETURNING key').bind(lockKey,now+250000,now).first();if(!lock)return json({error:'This conversation already has a response in progress.'},409);
  let prompt=body.prompt.trim(),reservation=0,requestId=uid(),providerStarted=false;
  try{
   for(const id of body.fileIds||[]){const file:any=await sql.prepare('SELECT * FROM files WHERE id=? AND user_id=?').bind(id,owner).first();if(!file)throw new Error('An attached file is no longer available.');const object=await env.BUCKET?.get(file.key);if(!object)throw new Error('An attached file could not be read.');prompt+='\n\n<attached_document name='+JSON.stringify(file.name)+'>\n'+await object.text()+'\n</attached_document>';}
   const historyRows=(await sql.prepare('SELECT role,content,created_at FROM messages WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 40').bind(conversationId).all<Turn & {created_at:number}>()).results.reverse();
   const history:Turn[]=historyRows.map(({role,content})=>({role,content}));
   // The conversation lock serializes turns. Keep timestamps strictly increasing
   // even when a provider finishes within one millisecond or the clock moves back.
   // rowid above also preserves insertion order for legacy equal-time messages.
   const userCreatedAt=Math.max(now,(historyRows.at(-1)?.created_at??(now-1))+1);
   const settings=await getWorkspaceSettings(sql,owner);
   const providerPrompt=withToolContext(withWorkspaceContext(prompt,settings,body.workspaceMode||'chat',body.skillId),tool,researchSources)
    +(codeExecution?'\n\nYou may use the supplied code_interpreter tool for Python calculations, analysis, and generating files in an isolated sandbox with network access disabled. Use it only when useful. Report actual execution results only after the tool succeeds. You cannot operate external apps, deploy sites, install software on the user device, or continue running after this response. Keep generated files below 5 MB each and at most three files; the application will preserve them for download.':'');
   const providerTurns:Turn[]=[...history,{role:'user',content:providerPrompt}];
   if(providerTurns.reduce((n,t)=>n+t.content.length,0)>240000)throw new Error('This conversation is too long. Start a new chat or use smaller documents.');
   // UTF-8 byte count bounds text tokens conservatively. Pro mode has no
   // separately approved rate, so it cannot borrow the standard tariff.
   if(body.pro)throw new BillingError('Pro 모드 단가는 별도 확정 전까지 사용할 수 없습니다.',503);
   const inputBound=new TextEncoder().encode(providerTurns.map(t=>t.content).join('')).length+4096;
   if(beta&&inputBound>BETA_INPUT_BYTES+4096)throw new BillingError('Beta conversations support up to 16 KB of total text. Start a new conversation or use a smaller document.',400);
   if(webResearch&&!beta)throw new BillingError('웹 검색이 포함된 요금 설정이 필요합니다.',503);
   if(req.signal.aborted)throw new BillingError('요청이 취소되었습니다.',408);
   reservation=beta?await reserveBeta(sql,owner,requestId,inputBound+(webResearch?32000:0),now,(webResearch?20000:0)+(codeExecution?60000:0),betaDailyLimit(env)):cost(rate,inputBound,8192);
   if(!beta)await reserve(sql,owner,requestId,reservation);
   await sql.batch([
    ...(!body.conversationId?[sql.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(conversationId,owner,body.prompt.slice(0,80),model.id,now,now)]:[]),
    sql.prepare('INSERT INTO messages (id,conversation_id,role,content,model,created_at) VALUES (?,?,?,?,?,?)').bind(uid(),conversationId,'user',prompt,null,userCreatedAt),
    ...(!beta?[sql.prepare('INSERT INTO usage (id,user_id,model,provider,status,created_at,rate_snapshot,reserved_amount) VALUES (?,?,?,?,?,?,?,?)').bind(requestId,owner,model.id,model.provider,'pending',now,JSON.stringify(rate),reservation)]:[])
   ]);
   const encoder=new TextEncoder(),aborter=new AbortController();const timer=setTimeout(()=>aborter.abort(),240000);req.signal.addEventListener('abort',()=>aborter.abort(),{once:true});if(req.signal.aborted)aborter.abort();
   const stream=new ReadableStream({
    async start(controller){
     let text='';let artifactIds:string[]=[];let persisted=false;const emit=(value:unknown)=>controller.enqueue(encoder.encode('data: '+JSON.stringify(value)+'\n\n'));
     try{
      emit({type:'start',conversationId,model:model.id,tool});
      if(aborter.signal.aborted)throw new DOMException('요청이 취소되었습니다.','AbortError');
      providerStarted=true;
      const measured=await invokeProvider(model,key,providerTurns,effort,false,aborter.signal,delta=>{text+=delta;emit({type:'delta',text:delta});},beta?BETA_OUTPUT:8192,{webSearch:webResearch,codeInterpreter:codeExecution,maxToolCalls:2,onTextReplace:value=>{text=value;emit({type:'replace',text:value});},onSources:sources=>emit({type:'sources',sources})});
      if(beta){const charge=betaCost(measured.input,measured.output)+(measured.webSearchCalls||0)*10000+(measured.codeInterpreterContainers||0)*30000;if(charge>reservation)throw new Error('Provider usage exceeded the reserved beta allowance.');await sql.prepare('UPDATE usage SET reserved_amount=? WHERE id=? AND user_id=?').bind(charge,requestId,owner).run();}else await settle(sql,owner,requestId,reservation,cost(rate,measured.input,measured.output));
      if(measured.artifacts?.length){
       try{const artifacts=await storeWorkArtifacts(env,sql,owner,conversationId,measured.artifacts,aborter.signal);artifactIds=artifacts.map(file=>file.id);text+='\n\n생성한 파일\n'+artifacts.map(file=>`- [${file.name.replace(/[\[\]\\]/g,' ')}](${file.url})`).join('\n');}
       catch{ text+='\n\n생성 파일을 저장하지 못했습니다. 필요한 내용을 대화에 직접 표시하도록 다시 요청해주세요.';}
       emit({type:'replace',text});
      }
      if(!text.trim())throw new Error('The provider returned no text.');
      const ended=Date.now(),assistantCreatedAt=Math.max(ended,userCreatedAt+1);
      await sql.batch([sql.prepare('INSERT INTO messages (id,conversation_id,role,content,model,created_at) VALUES (?,?,?,?,?,?)').bind(uid(),conversationId,'assistant',text,model.id,assistantCreatedAt),sql.prepare('UPDATE usage SET input_tokens=?,output_tokens=?,status=?,duration=? WHERE id=? AND user_id=?').bind(measured.input,measured.output,'complete',Math.max(0,ended-now),requestId,owner),sql.prepare('UPDATE conversations SET updated_at=?,model=? WHERE id=? AND user_id=?').bind(assistantCreatedAt,model.id,conversationId,owner)]);
      persisted=true;
      emit({type:'done',usage:{input:measured.input,output:measured.output,webSearchCalls:measured.webSearchCalls,codeInterpreterContainers:measured.codeInterpreterContainers},conversationId,tool});
     }catch(e){
      if(persisted)return;
      if(artifactIds.length)try{await deleteWorkArtifacts(env,sql,owner,artifactIds);}catch{console.error(JSON.stringify({event:'artifact_cleanup_failed',requestId}));}
      const error=(e instanceof Error&&e.name==='AbortError'?'응답 시간이 초과되었거나 중지되었습니다.':e instanceof Error?e.message:'응답을 완료하지 못했습니다.')+(providerStarted?(beta?' 접수된 요청은 무료 이용 한도에 포함됩니다.':' 사용량이 확정되지 않은 요청의 예약금은 정산 확인까지 보류됩니다.'):' AI 요청을 보내지 않았습니다.');await sql.prepare('UPDATE usage SET status=?,error=?,duration=? WHERE id=?').bind('error',error,Date.now()-now,requestId).run();if(!providerStarted&&beta)await sql.prepare('UPDATE usage SET reserved_amount=0 WHERE id=? AND user_id=?').bind(requestId,owner).run();try{emit({type:'error',error});}catch{} }
     finally{clearTimeout(timer);await sql.prepare('DELETE FROM rate_limits WHERE key=?').bind(lockKey).run();try{controller.close();}catch{}}
    },cancel(){aborter.abort();}
   });
   return new Response(stream,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','X-Content-Type-Options':'nosniff'}});
  }catch(e){if(reservation&&!providerStarted){if(beta)await sql.prepare("UPDATE usage SET status='error',error='Request preparation failed',reserved_amount=0 WHERE id=? AND user_id=?").bind(requestId,owner).run();else await settle(sql,owner,requestId,reservation,0);}await sql.prepare('DELETE FROM rate_limits WHERE key=?').bind(lockKey).run();return json({error:e instanceof Error?e.message:'요청을 처리하지 못했습니다.',...(e instanceof WorkspaceToolError?{code:e.code}:{})},e instanceof BillingError||e instanceof WorkspaceToolError?e.status:400);}
 }
 return json({error:'Endpoint not found.'},404);
}
async function dispatch(req:Request){try{
 if(req.method!=='GET'&&req.body){
  const requestPath=new URL(req.url).pathname;
  const maxBytes=requestPath==='/api/media/reference'?4*1024*1024+16384:req.method==='PATCH'&&requestPath==='/api/settings'?600000:200000;
  const reader=req.clone().body!.getReader();let bytes=0;
  while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>maxBytes){void reader.cancel();return json({error:'Request is too large.'},413);}}
 }
 return await handle(req);
}catch(e){if(e instanceof WorkspaceToolError)return json({error:e.message,code:e.code},e.status);if(e instanceof BillingError)return json({error:e.message},e.status);if(e instanceof SyntaxError)return json({error:'Invalid JSON request.'},400);return json({error:'The request could not be completed. Please retry.'},500);}}
async function safe(req:Request){
 const requestId=uid(),started=Date.now();
 const response=await dispatch(req);
 response.headers.set('X-Request-ID',requestId);
 response.headers.set('X-Content-Type-Options','nosniff');
 response.headers.set('Cache-Control','no-store');
 if(response.status===429)response.headers.set('Retry-After','60');
 // SignalBrief's request-context pattern: never log prompts, emails or keys.
 console.info(JSON.stringify({event:'api_request',requestId,method:req.method,status:response.status,durationMs:Date.now()-started}));
 return response;
}
export const GET=safe;export const POST=safe;export const PATCH=safe;export const DELETE=safe;
