import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,mkdir,writeFile,readdir} from 'node:fs/promises';
import ts from 'typescript';
const dir=new URL('../.sites-runtime/tests/',import.meta.url);await mkdir(dir,{recursive:true});
let user={userId:'alice',email:'alice@example.test',fullName:'Alice'};
const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys = ON;');
for(const name of (await readdir(new URL('../drizzle/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8'));
const bucket=new Map();
function prepare(query){let params=[];return {bind(...values){params=values;return this},async first(){return sqlite.prepare(query).get(...params)||null},async all(){return {results:sqlite.prepare(query).all(...params)}},async run(){sqlite.prepare(query).run(...params);return {success:true}}};}
const env={DB:{prepare,async batch(items){sqlite.exec('BEGIN');try{const out=[];for(const item of items)out.push(await item.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}},BUCKET:{async put(key,value){bucket.set(key,value)},async get(key){return bucket.has(key)?{text:async()=>bucket.get(key)}:null},async delete(key){bucket.delete(key)}}};
globalThis.__prismTest={env,getUser:async()=>user};
await writeFile(new URL('context.mjs',dir),'export const env=globalThis.__prismTest.env; export const getChatGPTUser=globalThis.__prismTest.getUser;');
for(const [source,dest] of [['lib/models.ts','models.mjs'],['lib/provider.ts','provider.mjs'],['lib/billing.ts','billing.mjs'],['lib/beta.ts','beta.mjs'],['app/api/[...path]/route.ts','route.mjs']]){
 let code=await readFile(new URL('../'+source,import.meta.url),'utf8');
 code=code.replaceAll("'cloudflare:workers'","'./context.mjs'").replaceAll("'../../chatgpt-auth'","'./context.mjs'").replaceAll("'../../../lib/models'","'./models.mjs'").replaceAll("'../../../lib/provider'","'./provider.mjs'");
 code=code.replaceAll("'../../../lib/billing'","'./billing.mjs'").replaceAll("'./models'","'./models.mjs'").replaceAll("'../../../lib/beta'","'./beta.mjs'").replaceAll("'./billing'","'./billing.mjs'");
 const js=ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 await writeFile(new URL(dest,dir),js);
}
const route=await import(new URL('route.mjs',dir).href);const {MODELS}=await import(new URL('models.mjs',dir).href);const {invokeProvider}=await import(new URL('provider.mjs',dir).href);
const originalFetch=globalThis.fetch;
function req(path,method='GET',body,headers={}){return new Request('https://prism.test/api/'+path,{method,headers:{...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{})});}
async function call(path,method='GET',body,headers){return route[method](req(path,method,body,headers));}
function mockSSE(events){return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});}
let conversationId;
const billing=await import(new URL('billing.mjs',dir).href);
test('anonymous requests cannot access private data',async()=>{user=null;for(const p of ['conversations','usage','files','admin'])assert.equal((await call(p)).status,401);const b=await(await call('bootstrap')).json();assert.equal(b.user,null);user={userId:'alice',email:'alice@example.test',fullName:'Alice'};});
test('server secrets never appear in connection status',async()=>{env.OPENAI_API_KEY='test-only-key';const b=await(await call('bootstrap')).json();assert.equal(b.providers.openai.configured,true);assert.equal(JSON.stringify(b).includes('test-only-key'),false);delete env.OPENAI_API_KEY;});
test('rejects invalid origins and invalid model IDs',async()=>{assert.equal((await call('chat','POST',{prompt:'Hi',model:'gpt-6-astra'},{origin:'https://other.test'})).status,403);assert.equal((await call('chat','POST',{prompt:'Hi',model:'made-up-model'})).status,400);});
test('missing API credentials produce an explicit error with no artificial response',async()=>{const r=await call('chat','POST',{prompt:'Hi',model:'gpt-6-astra'});assert.equal(r.status,503);assert.equal((await r.json()).code,'PROVIDER_NOT_CONFIGURED');assert.equal(sqlite.prepare('SELECT COUNT(*) as n FROM conversations').get().n,0);});
test('unconfigured pricing blocks paid inference even with provider credentials',async()=>{env.OPENAI_API_KEY='test-only-key';const r=await call('chat','POST',{model:'gpt-6-astra',prompt:'Hi'});assert.equal(r.status,503);assert.equal((await r.json()).code,'PRICING_NOT_CONFIGURED');});
test('configure approved test tariffs and seed isolated live test ledger',async()=>{sqlite.prepare("INSERT INTO billing_config VALUES ('launch',?,?)").run(JSON.stringify({rates:Object.fromEntries(MODELS.map(m=>[m.id,{input:1000,output:2000}])),refundPolicy:'',validityPolicy:'',registrationNumber:'',address:'',supportEmail:''}),Date.now());sqlite.prepare("INSERT INTO wallet_events VALUES ('test-seed','alice','live','topup',100000000000,'seed',?)").run(Date.now());});
test('real handler streams provider output and persists chat and measured token usage',async()=>{env.OPENAI_API_KEY='test-only-key';globalThis.fetch=async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(options.body);assert.equal(body.reasoning.effort,'xhigh');assert.equal(body.reasoning.mode,undefined);assert.equal(body.store,false);assert.equal(body.input.at(-1).content,'Explain recursion.');return mockSSE([{type:'response.output_text.delta',delta:'A function '},{type:'response.output_text.delta',delta:'that calls itself.'},{type:'response.completed',response:{usage:{input_tokens:12,output_tokens:7}}}]);};const r=await call('chat','POST',{prompt:'Explain recursion.',model:'gpt-6-astra',effort:'xhigh',pro:false});assert.equal(r.status,200);const text=await r.text();assert.match(text,/that calls itself/);assert.match(text,/'?done'?/);const chats=await(await call('conversations')).json();assert.equal(chats.length,1);conversationId=chats[0].id;const detail=await(await call('conversations/'+conversationId)).json();assert.equal(detail.messages.length,2);assert.equal(detail.messages[1].content,'A function that calls itself.');const u=await(await call('usage')).json();assert.equal(u.totals.input_tokens,12);assert.equal(u.totals.output_tokens,7);assert.equal(u.totals.completed,1);});
test('every conversation action enforces account ownership',async()=>{user={userId:'bob',email:'bob@example.test'};for(const method of ['GET','PATCH','DELETE'])assert.equal((await call('conversations/'+conversationId,method,method==='PATCH'?{title:'stolen'}:undefined)).status,404);assert.equal((await(await call('conversations')).json()).length,0);assert.equal((await call('chat','POST',{model:'gpt-6-astra',prompt:'Continue',conversationId})).status,404);user={userId:'alice',email:'alice@example.test'};});
test('file uploads, downloads, attachment ownership, and deletion work',async()=>{const form=new FormData();form.set('file',new File(['A small test document.'],'notes.txt'));const r=await call('files','POST',form);assert.equal(r.status,200);const f=await r.json();assert.equal((await(await call('files/'+f.id)).text()),'A small test document.');assert.equal((await(await call('files')).json()).length,1);user={userId:'bob',email:'bob@example.test'};assert.equal((await call('files/'+f.id)).status,404);assert.equal((await call('files/'+f.id,'DELETE')).status,404);assert.equal((await call('chat','POST',{prompt:'Read',model:'gpt-6-astra',fileIds:[f.id]})).status,400);user={userId:'alice',email:'alice@example.test'};assert.equal((await call('files/'+f.id,'DELETE')).status,200);assert.equal(bucket.size,0);const bad=new FormData();bad.set('file',new File(['not a PDF'],'notes.pdf'));assert.equal((await call('files','POST',bad)).status,400);});
test('provider failure is recorded without saving a synthetic assistant message',async()=>{globalThis.fetch=async()=>new Response('{}',{status:429});const r=await call('chat','POST',{model:'gpt-6-astra',prompt:'Retry',conversationId});const body=await r.text();assert.match(body,/rate limit/);const detail=await(await call('conversations/'+conversationId)).json();assert.equal(detail.messages.filter(m=>m.role==='assistant').length,1);assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM usage WHERE status='error'").get().n,1);});
test('active chat locks reject overlapping requests',async()=>{sqlite.prepare('INSERT INTO rate_limits VALUES (?,1,?)').run('chat:'+conversationId,Date.now()+20000);assert.equal((await call('chat','POST',{model:'gpt-6-astra',prompt:'Overlap',conversationId})).status,409);sqlite.prepare('DELETE FROM rate_limits WHERE key=?').run('chat:'+conversationId);});
test('admin route is closed unless the exact administrator ID is configured',async()=>{assert.equal((await call('admin')).status,403);env.ADMIN_USER_ID='bob';assert.equal((await call('admin')).status,403);env.ADMIN_USER_ID='alice';assert.equal((await call('admin')).status,200);delete env.ADMIN_USER_ID;});
test('renaming is validated and deleting a conversation also removes messages',async()=>{assert.equal((await call('conversations/'+conversationId,'PATCH',{title:''})).status,400);assert.equal((await call('conversations/'+conversationId,'PATCH',{title:'Recursion notes'})).status,200);assert.equal((await(await call('conversations/'+conversationId)).json()).conversation.title,'Recursion notes');assert.equal((await call('conversations/'+conversationId,'DELETE')).status,200);assert.equal(sqlite.prepare('SELECT COUNT(*) as n FROM messages WHERE conversation_id=?').get(conversationId).n,0);});
test('Anthropic adapter uses correct endpoint, streaming protocol, and measured usage',async()=>{globalThis.fetch=async(url,opts)=>{assert.equal(url,'https://api.anthropic.com/v1/messages');assert.equal(opts.headers['anthropic-version'],'2023-06-01');assert.equal(JSON.parse(opts.body).thinking.type,'adaptive');return mockSSE([{type:'message_start',message:{usage:{input_tokens:10}}},{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'private'}},{type:'content_block_delta',delta:{type:'text_delta',text:'A clear answer.'}},{type:'message_delta',usage:{output_tokens:20},delta:{stop_reason:'end_turn'}},{type:'message_stop'}]);};let text='';const u=await invokeProvider(MODELS[1],'test-only-key',[{role:'user',content:'Hi'}],'high',false,new AbortController().signal,t=>text+=t);assert.equal(text,'A clear answer.');assert.deepEqual(u,{input:10,output:20});});
test('Gemini adapter uses Interactions API and normalized responses',async()=>{globalThis.fetch=async(url,opts)=>{assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/interactions');assert.equal(JSON.parse(opts.body).store,false);assert.equal(JSON.parse(opts.body).input[0].type,'user_input');return Response.json({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:'A Gemini answer.'}]}],usage:{total_input_tokens:4,total_output_tokens:5,total_thought_tokens:3}});};let text='';const u=await invokeProvider(MODELS[2],'test-only-key',[{role:'user',content:'Hi'}],'medium',false,new AbortController().signal,t=>text+=t);assert.equal(text,'A Gemini answer.');assert.deepEqual(u,{input:4,output:8});});
test('truncated streams fail instead of being marked complete',async()=>{globalThis.fetch=async()=>mockSSE([{type:'response.output_text.delta',delta:'partial'}]);await assert.rejects(()=>invokeProvider(MODELS[0],'test-only-key',[{role:'user',content:'Hi'}],'medium',false,new AbortController().signal,()=>{}),/before completing/);});
test('rate limiting is enforced per authenticated user',async()=>{sqlite.prepare('INSERT INTO rate_limits (key,count,expires_at) VALUES (?,20,?) ON CONFLICT(key) DO UPDATE SET count=20').run('alice:'+Math.floor(Date.now()/60000),Date.now()+120000);assert.equal((await call('chat','POST',{model:'gpt-6-astra',prompt:'Excess'})).status,429);globalThis.fetch=originalFetch;delete env.OPENAI_API_KEY;});

test('new wallets cannot spend, including against test-only balances',async()=>{
 sqlite.prepare("INSERT INTO wallet_events VALUES ('sandbox-money','no-live','test','topup',50000000000,'sandbox-seed',?)").run(Date.now());
 await assert.rejects(()=>billing.reserve(env.DB,'no-live','must-not-spend',1),/잔액/);
 assert.equal(await billing.balance(env.DB,'no-live'),0);
});
test('atomic reservations across different chats cannot overdraw one wallet',async()=>{
 sqlite.prepare("INSERT INTO wallet_events VALUES ('small-wallet','limited','live','topup',1000,'small-seed',?)").run(Date.now());
 const attempts=await Promise.allSettled([billing.reserve(env.DB,'limited','parallel-one',700),billing.reserve(env.DB,'limited','parallel-two',700)]);
 assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(await billing.balance(env.DB,'limited'),300);
 await billing.settle(env.DB,'limited','parallel-one',700,200);
 await billing.settle(env.DB,'limited','parallel-one',700,200);
 assert.equal(await billing.balance(env.DB,'limited'),800);
});
test('settlement cannot fabricate refunds or silently release uncertain usage',async()=>{
 await billing.settle(env.DB,'limited','does-not-exist',500,0);
 assert.equal(await billing.balance(env.DB,'limited'),800);
 await billing.reserve(env.DB,'limited','uncertain',100);
 await assert.rejects(()=>billing.settle(env.DB,'limited','uncertain',100,101),/보류/);
 assert.equal(await billing.balance(env.DB,'limited'),700);
});
test('production checkout is disabled until launch details and live keys are complete',async()=>{
 assert.equal((await call('payments/orders','POST',{amount:10000})).status,503);
 env.PAYMENTS_MODE='live';env.TOSS_SECRET_KEY='live_sk_test';env.TOSS_CLIENT_KEY='live_ck_test';env.LAUNCH_APPROVED='true';
 assert.equal(billing.paymentMode(await billing.getBillingConfig(env.DB)),'disabled');
 delete env.LAUNCH_APPROVED;
});
test('test checkout validates packs, owner and amount before calling Toss',async()=>{
 env.PAYMENTS_MODE='test';env.TOSS_SECRET_KEY='test_sk_test';env.TOSS_CLIENT_KEY='test_ck_test';
 assert.equal((await call('payments/orders','POST',{amount:1})).status,400);
 const order=await(await call('payments/orders','POST',{amount:10000})).json();
 assert.equal(order.amount,10000);assert.equal(order.mode,'test');
 assert.equal((await call('payments/confirm','POST',{orderId:order.orderId,amount:1,paymentKey:'pk-test'})).status,409);
 user={userId:'bob',email:'bob@example.test'};
 assert.equal((await call('payments/confirm','POST',{orderId:order.orderId,amount:10000,paymentKey:'pk-test'})).status,404);
 user={userId:'alice',email:'alice@example.test'};
 const verified={orderId:order.orderId,paymentKey:'pk-test',currency:'KRW',totalAmount:10000,balanceAmount:10000,status:'DONE',cancels:[]};
 globalThis.fetch=async(url,opts)=>{assert.match(url,/^https:\/\/api.tosspayments.com\/v1\/payments\//);assert.ok(opts.headers.Authorization.startsWith('Basic '));return Response.json(verified);};
 for(let i=0;i<2;i++)assert.equal((await call('payments/confirm','POST',{orderId:order.orderId,amount:10000,paymentKey:'pk-test'})).status,200);
 assert.equal(await billing.balance(env.DB,'alice','test'),10000000000);
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM wallet_events WHERE reference=?").get('payment:'+order.orderId).n,1);
 const snapshot=await(await call('billing')).json();assert.equal(snapshot.mode,'test');assert.equal(JSON.stringify(snapshot).includes('test_sk_test'),false);
});
test('webhooks re-query provider state; forged webhook amounts cannot create credit',async()=>{
 const before=await billing.balance(env.DB,'alice','test');
 globalThis.fetch=async()=>Response.json({orderId:'wrong-order',status:'DONE',paymentKey:'pk-test',currency:'KRW',totalAmount:999999,balanceAmount:999999});
 assert.equal((await call('payments/webhook','POST',{data:{paymentKey:'pk-test',amount:999999,status:'DONE'}})).status,409);
 assert.equal(await billing.balance(env.DB,'alice','test'),before);
 assert.equal((await call('payments/webhook','POST',{data:{paymentKey:'unknown'}})).status,404);
 globalThis.fetch=originalFetch;delete env.PAYMENTS_MODE;delete env.TOSS_SECRET_KEY;delete env.TOSS_CLIENT_KEY;
});
test('billing settings reject unauthorized changes, unknown models and non-integer rates',async()=>{
 assert.equal((await call('admin/billing','POST',{})).status,403);
 env.ADMIN_USER_ID='alice';
 const config=await billing.getBillingConfig(env.DB);
 assert.equal((await call('admin/billing','POST',{...config,rates:{invented:{input:1,output:2}}})).status,400);
 assert.equal((await call('admin/billing','POST',{...config,rates:{'gpt-6-astra':{input:0.1,output:2}}})).status,400);
 assert.equal((await call('admin/billing','POST',config)).status,200);
 delete env.ADMIN_USER_ID;
});
test('data deletion rejects cross-origin requests and preserves financial accounting',async()=>{
 assert.equal((await call('account/data','DELETE',undefined,{origin:'https://other.test'})).status,403);
 const before=await billing.balance(env.DB,'alice');
 assert.equal((await call('account/data','DELETE')).status,200);
 assert.equal(await billing.balance(env.DB,'alice'),before);
 assert.equal((await(await call('conversations')).json()).length,0);
});
test('missing billable usage cannot silently become free inference',async()=>{
 globalThis.fetch=async()=>mockSSE([{type:'response.output_text.delta',delta:'answer'},{type:'response.completed',response:{}}]);
 await assert.rejects(()=>invokeProvider(MODELS[0],'test-only-key',[{role:'user',content:'Hi'}],'medium',false,new AbortController().signal,()=>{}),/valid billable usage/);
 globalThis.fetch=originalFetch;
});
test('body size limits apply even without a content-length header',async()=>{
 const request=new Request('https://prism.test/api/chat',{method:'POST',body:'x'.repeat(200001)});
 assert.equal((await route.POST(request)).status,413);
});
test('admin reconciliation uses captured rates and cannot change a settled amount',async()=>{
 const row=sqlite.prepare("SELECT * FROM usage WHERE status='error' AND rate_snapshot IS NOT NULL LIMIT 1").get();
 assert.ok(row);
 assert.equal((await call('admin/reconcile','POST',{requestId:row.id,input:1,output:1,confirmed:true})).status,403);
 env.ADMIN_USER_ID='alice';
 assert.equal((await call('admin/reconcile','POST',{requestId:row.id,input:1,output:1,confirmed:true})).status,200);
 assert.equal((await call('admin/reconcile','POST',{requestId:row.id,input:1,output:1,confirmed:true})).status,200);
 assert.equal((await call('admin/reconcile','POST',{requestId:row.id,input:2,output:1,confirmed:true})).status,409);
 assert.equal(sqlite.prepare('SELECT input_tokens FROM usage WHERE id=?').get(row.id).input_tokens,1);
 delete env.ADMIN_USER_ID;
});


test('free beta streams without a wallet and enforces model, daily and global limits',async()=>{
 env.BETA_MODE='true';env.OPENAI_API_KEY='test-only-key';user={userId:'beta-user',email:'beta@example.test'};
 globalThis.fetch=async(url,options)=>{const body=JSON.parse(options.body);assert.equal(body.max_output_tokens,1024);return mockSSE([{type:'response.output_text.delta',delta:'Live beta answer'},{type:'response.completed',response:{usage:{input_tokens:12,output_tokens:7}}}]);};
 assert.equal((await call('chat','POST',{model:'gpt-6-astra',prompt:'No'})).status,403);
 const r=await call('chat','POST',{model:'gpt-6.1-sol',prompt:'Hello'});assert.equal(r.status,200);assert.match(await r.text(),/Live beta answer/);
 assert.equal(await billing.balance(env.DB,'beta-user'),0);
 const beta=await import(new URL('beta.mjs',dir).href);
 const today=Math.floor(Date.now()/86400000)*86400000;
 for(let i=0;i<19;i++)sqlite.prepare("INSERT INTO usage (id,user_id,model,provider,status,created_at,rate_snapshot,reserved_amount) VALUES (?,?,'gpt-6.1-sol','openai','error',?,'beta:v1',1)").run('limit-'+i,'beta-user',today+1);
 await assert.rejects(()=>beta.reserveBeta(env.DB,'beta-user','blocked',4096,Date.now()),/allowance/);
 sqlite.prepare("INSERT INTO usage (id,user_id,model,provider,status,created_at,rate_snapshot,reserved_amount) VALUES ('global-limit','another','gpt-6.1-sol','openai','error',?,'beta:v1',8000000)").run(today+1);
 await assert.rejects(()=>beta.reserveBeta(env.DB,'new-account','global-blocked',4096,Date.now()),/allowance/);
 delete env.BETA_MODE;delete env.OPENAI_API_KEY;globalThis.fetch=originalFetch;
});

test('health probes check dependencies and every response has a request ID',async()=>{
 user=null;
 assert.equal((await call('health/live')).status,200);
 delete env.OPENAI_API_KEY;
 assert.equal((await call('health/ready')).status,503);
 env.OPENAI_API_KEY='test-only-key';
 assert.equal((await call('health/ready')).status,200);
 const denied=await call('conversations');assert.equal(denied.status,401);assert.ok(denied.headers.get('X-Request-ID'));assert.equal(denied.headers.get('Cache-Control'),'no-store');
 delete env.OPENAI_API_KEY;
});
