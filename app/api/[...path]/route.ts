import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../chatgpt-auth';
import { MODELS, PROVIDERS, findModel, Provider } from '../../../lib/models';
import { invokeProvider, Turn } from '../../../lib/provider';
import { BillingError, billingOverview, getBillingConfig, validateConfig, launchBlockers, paymentRequest, paymentWebhook, reserve, settle, cost } from '../../../lib/billing';
import { reserveBeta, betaCost, BETA_OUTPUT, BETA_INPUT_BYTES } from '../../../lib/beta';
export const dynamic='force-dynamic';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const uid=()=>crypto.randomUUID();
function mutationAllowed(req:Request){const origin=req.headers.get('origin');return !origin||origin===new URL(req.url).origin;}
function db(){if(!env.DB)throw new Error('Database is not configured.');return env.DB;}
async function handle(req:Request){
 const path=new URL(req.url).pathname.replace(/^\/api\//,'').split('/');
 if(path.join('/')==='payments/webhook'&&req.method==='POST')return json(await paymentWebhook(req,db()));
 const user=await getChatGPTUser();
 if(path[0]==='bootstrap'&&req.method==='GET')return json({user:user?{name:user.fullName||user.email.split('@')[0],email:user.email}:null,beta:env.BETA_MODE==='true',models:env.BETA_MODE==='true'?MODELS.filter(m=>m.id==='gpt-6.1-sol'):MODELS,providers:Object.fromEntries(Object.entries(PROVIDERS).map(([p,v])=>[p,{configured:!!env[v.secret as keyof typeof env]}])),isAdmin:!!user&&!!env.ADMIN_USER_ID&&user.userId===env.ADMIN_USER_ID});
 if(!user)return json({error:'Sign in with ChatGPT to save your work and use AI models.'},401);
 if(req.method!=='GET'&&!mutationAllowed(req))return json({error:'Invalid request origin.'},403);
 const owner=user.userId,sql=db();
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
  const owned=(await sql.prepare('SELECT key FROM files WHERE user_id=?').bind(owner).all<{key:string}>()).results;
  for(const file of owned)await env.BUCKET?.delete(file.key);
  await sql.batch([sql.prepare('DELETE FROM files WHERE user_id=?').bind(owner),sql.prepare('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id=?)').bind(owner),sql.prepare('DELETE FROM conversations WHERE user_id=?').bind(owner)]);
  return json({ok:true,message:'대화와 파일을 삭제했습니다. 결제·사용량 원장은 정산을 위해 보존됩니다. ChatGPT 계정은 삭제되지 않습니다.'});
 }
 if(path[0]==='conversations'){
  if(req.method==='GET'&&!path[1])return json((await sql.prepare('SELECT id,title,model,created_at,updated_at FROM conversations WHERE user_id=? ORDER BY updated_at DESC LIMIT 200').bind(owner).all()).results);
  const id=path[1];if(!id)return json({error:'Conversation ID required.'},400);
  const chat=await sql.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').bind(id,owner).first();if(!chat)return json({error:'Conversation not found.'},404);
  if(req.method==='GET')return json({conversation:chat,messages:(await sql.prepare('SELECT id,role,content,model,created_at FROM messages WHERE conversation_id=? ORDER BY created_at,id').bind(id).all()).results});
  if(req.method==='DELETE'){await sql.batch([sql.prepare('DELETE FROM messages WHERE conversation_id=?').bind(id),sql.prepare('DELETE FROM conversations WHERE id=? AND user_id=?').bind(id,owner)]);return json({ok:true});}
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
  if(Number(req.headers.get('content-length')||0)>100000)return json({error:'Request is too large.'},413);
  const body:any=await req.json(),model=findModel(body.model);
  if(!model||typeof body.prompt!=='string'||!body.prompt.trim()||body.prompt.length>32000)return json({error:'Choose a valid model and enter a prompt under 32,000 characters.'},400);
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
   const history=(await sql.prepare('SELECT role,content FROM messages WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 40').bind(conversationId).all<Turn>()).results.reverse();
   if(history.reduce((n,t)=>n+t.content.length,0)+prompt.length>240000)throw new Error('This conversation is too long. Start a new chat or use smaller documents.');
   // UTF-8 byte count bounds text tokens conservatively. Pro mode has no
   // separately approved rate, so it cannot borrow the standard tariff.
   if(body.pro)throw new BillingError('Pro 모드 단가는 별도 확정 전까지 사용할 수 없습니다.',503);
   const inputBound=new TextEncoder().encode([...history,{role:'user',content:prompt}].map(t=>t.content).join('')).length+4096;
   if(beta&&inputBound>BETA_INPUT_BYTES+4096)throw new BillingError('Beta conversations support up to 16 KB of total text. Start a new conversation or use a smaller document.',400);
   reservation=beta?await reserveBeta(sql,owner,requestId,inputBound,now):cost(rate,inputBound,8192);
   if(!beta)await reserve(sql,owner,requestId,reservation);
   await sql.batch([
    ...(!body.conversationId?[sql.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(conversationId,owner,body.prompt.slice(0,80),model.id,now,now)]:[]),
    sql.prepare('INSERT INTO messages (id,conversation_id,role,content,model,created_at) VALUES (?,?,?,?,?,?)').bind(uid(),conversationId,'user',prompt,null,now),
    ...(!beta?[sql.prepare('INSERT INTO usage (id,user_id,model,provider,status,created_at,rate_snapshot,reserved_amount) VALUES (?,?,?,?,?,?,?,?)').bind(requestId,owner,model.id,model.provider,'pending',now,JSON.stringify(rate),reservation)]:[])
   ]);
   const encoder=new TextEncoder(),aborter=new AbortController();const timer=setTimeout(()=>aborter.abort(),240000);req.signal.addEventListener('abort',()=>aborter.abort(),{once:true});
   const stream=new ReadableStream({
    async start(controller){
     let text='';const emit=(value:unknown)=>controller.enqueue(encoder.encode('data: '+JSON.stringify(value)+'\n\n'));
     try{
      emit({type:'start',conversationId,model:model.id});
      providerStarted=true;
      const measured=await invokeProvider(model,key,[...history,{role:'user',content:prompt}],effort,false,aborter.signal,delta=>{text+=delta;emit({type:'delta',text:delta});},beta?BETA_OUTPUT:8192);
      if(beta){const charge=betaCost(measured.input,measured.output);if(charge>reservation)throw new Error('Provider usage exceeded the reserved beta allowance.');await sql.prepare('UPDATE usage SET reserved_amount=? WHERE id=? AND user_id=?').bind(charge,requestId,owner).run();}else await settle(sql,owner,requestId,reservation,cost(rate,measured.input,measured.output));
      if(!text.trim())throw new Error('The provider returned no text.');
      const ended=Date.now();
      await sql.batch([sql.prepare('INSERT INTO messages (id,conversation_id,role,content,model,created_at) VALUES (?,?,?,?,?,?)').bind(uid(),conversationId,'assistant',text,model.id,ended),sql.prepare('UPDATE usage SET input_tokens=?,output_tokens=?,status=?,duration=? WHERE id=? AND user_id=?').bind(measured.input,measured.output,'complete',ended-now,requestId,owner),sql.prepare('UPDATE conversations SET updated_at=?,model=? WHERE id=? AND user_id=?').bind(ended,model.id,conversationId,owner)]);
      emit({type:'done',usage:measured,conversationId});
     }catch(e){const error=(e instanceof Error&&e.name==='AbortError'?'The response timed out or was stopped.':e instanceof Error?e.message:'The response could not be completed.')+(beta?' The request remains counted toward the beta allowance.':' 사용량이 확정되지 않은 요청의 예약금은 정산 확인까지 보류됩니다.');await sql.prepare('UPDATE usage SET status=?,error=?,duration=? WHERE id=?').bind('error',error,Date.now()-now,requestId).run();try{emit({type:'error',error});}catch{} }
     finally{clearTimeout(timer);await sql.prepare('DELETE FROM rate_limits WHERE key=?').bind(lockKey).run();try{controller.close();}catch{}}
    },cancel(){aborter.abort();}
   });
   return new Response(stream,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','X-Content-Type-Options':'nosniff'}});
  }catch(e){if(reservation&&!providerStarted){if(beta)await sql.prepare("UPDATE usage SET status='error',error='Request preparation failed' WHERE id=? AND user_id=?").bind(requestId,owner).run();else await settle(sql,owner,requestId,reservation,0);}await sql.prepare('DELETE FROM rate_limits WHERE key=?').bind(lockKey).run();return json({error:e instanceof Error?e.message:'Request failed.'},e instanceof BillingError?e.status:400);}
 }
 return json({error:'Endpoint not found.'},404);
}
async function safe(req:Request){try{
 if(req.method!=='GET'&&req.body){
  const reader=req.clone().body!.getReader();let bytes=0;
  while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>200000){void reader.cancel();return json({error:'Request is too large.'},413);}}
 }
 return await handle(req);
}catch(e){if(e instanceof BillingError)return json({error:e.message},e.status);if(e instanceof SyntaxError)return json({error:'Invalid JSON request.'},400);return json({error:'The request could not be completed. Please retry.'},500);}}
export const GET=safe;export const POST=safe;export const PATCH=safe;export const DELETE=safe;
