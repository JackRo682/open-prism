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
for(const [source,dest] of [['lib/models.ts','models.mjs'],['lib/provider.ts','provider.mjs'],['lib/billing.ts','billing.mjs'],['lib/beta.ts','beta.mjs'],['lib/workspace-settings.ts','workspace-settings.mjs'],['lib/workspace-tools.ts','workspace-tools.mjs'],['app/api/[...path]/route.ts','route.mjs']]){
 let code=await readFile(new URL('../'+source,import.meta.url),'utf8');
 code=code.replaceAll("'cloudflare:workers'","'./context.mjs'").replaceAll("'../../chatgpt-auth'","'./context.mjs'").replaceAll("'../../../lib/models'","'./models.mjs'").replaceAll("'../../../lib/provider'","'./provider.mjs'");
 code=code.replaceAll("'../../../lib/workspace-tools'","'./workspace-tools.mjs'").replaceAll("'../../../lib/workspace-settings'","'./workspace-settings.mjs'").replaceAll("'../../../lib/billing'","'./billing.mjs'").replaceAll("'./models'","'./models.mjs'").replaceAll("'../../../lib/beta'","'./beta.mjs'").replaceAll("'./billing'","'./billing.mjs'");
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
test('anonymous requests cannot access private data',async()=>{user=null;for(const p of ['conversations','usage','files','admin','settings','search?q=test','shares'])assert.equal((await call(p)).status,401);const b=await(await call('bootstrap')).json();assert.equal(b.user,null);user={userId:'alice',email:'alice@example.test',fullName:'Alice'};});
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

test('workspace settings validate bounded input and remain isolated across owners',async()=>{
 sqlite.exec(await readFile(new URL('../drizzle/0003_workspace_settings_and_shares.sql',import.meta.url),'utf8'));
 const defaults={personalizationEnabled:false,customInstructions:'',memory:'',workResponseStyle:'plan-first',browserTarget:'current',browserPermission:'ask',skills:[]};
 assert.deepEqual(await(await call('settings')).json(),defaults);
 for(const invalid of [{personalizationEnabled:'yes'},{memory:'x'.repeat(8001)},{customInstructions:'x'.repeat(4001)},{workResponseStyle:'autonomous'},{unknown:true},{skills:[{id:'a',name:'A',instructions:'One'},{id:'a',name:'B',instructions:'Two'}]},{skills:Array.from({length:21},(_,i)=>({id:String(i),name:'Name',instructions:'Text'}))}])assert.equal((await call('settings','PATCH',invalid)).status,400);
 const prefs={...defaults,personalizationEnabled:true,customInstructions:'Answer in clear Korean.',memory:'I work on solar research.',workResponseStyle:'direct',skills:[{id:'review',name:'Review',instructions:'Check assumptions and give a critique.'}]};
 assert.deepEqual(await(await call('settings','PATCH',prefs)).json(),prefs);
 assert.equal((await call('settings','PATCH',{memory:'wrong'},{origin:'https://other.test'})).status,403);
 user={userId:'bob',email:'bob@example.test'};
 assert.deepEqual(await(await call('settings')).json(),defaults);
 await call('settings','PATCH',{memory:'Bob private memory'});
 user={userId:'alice',email:'alice@example.test'};
 assert.equal((await(await call('settings')).json()).memory,prefs.memory);
 await call('settings','PATCH',{workResponseStyle:'plan-first'});
 assert.equal((await(await call('settings')).json()).customInstructions,prefs.customInstructions);
});
test('browser preferences are separate owner-scoped fields and cannot enable remote execution',async()=>{
 const before=await(await call('settings')).json();
 for(const patch of [{browserTarget:'system'},{browserTarget:true},{browserPermission:'always'},{browserPermission:null}])assert.equal((await call('settings','PATCH',patch)).status,400);
 const remote=await(await call('settings','PATCH',{browserTarget:'remote'})).json();
 assert.equal(remote.browserTarget,'remote');assert.equal(remote.browserPermission,'ask');
 const approved=await(await call('settings','PATCH',{browserPermission:'approve'})).json();
 assert.equal(approved.browserTarget,'remote');assert.equal(approved.browserPermission,'approve');assert.equal(approved.memory,before.memory);
 assert.equal((await(await call('bootstrap')).json()).capabilities.remoteBrowser,false);
 user={userId:'bob',email:'bob@example.test'};
 const other=await(await call('settings')).json();assert.equal(other.browserTarget,'current');assert.equal(other.browserPermission,'ask');
 user={userId:'alice',email:'alice@example.test'};
 assert.equal((await(await call('settings')).json()).browserPermission,'approve');
 await call('settings','PATCH',{browserTarget:'current',browserPermission:'ask'});
});
test('fresh owner settings and selected skills affect provider input without polluting stored messages',async()=>{
 let providerInput='';
 globalThis.fetch=async(url,options)=>{providerInput=JSON.parse(options.body).input.at(-1).content;return mockSSE([{type:'response.output_text.delta',delta:'Personalized answer.'},{type:'response.completed',response:{usage:{input_tokens:12,output_tokens:7}}}]);};
 const response=await call('chat','POST',{model:'gpt-6-astra',prompt:'Review my project.',workspaceMode:'work',skillId:'review'});
 assert.equal(response.status,200);const streamed=await response.text();assert.match(streamed,/"type":"done"/);
 assert.match(providerInput,/clear Korean/);assert.match(providerInput,/solar research/);assert.match(providerInput,/brief actionable plan/);assert.match(providerInput,/Check assumptions/);
 const start=streamed.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6))).find(event=>event.type==='start');
 const messages=(await(await call('conversations/'+start.conversationId)).json()).messages;
 assert.equal(messages[0].content,'Review my project.');
 await call('settings','PATCH',{personalizationEnabled:false,workResponseStyle:'direct'});
 const disabled=await call('chat','POST',{model:'gpt-6-astra',prompt:'Second request.',workspaceMode:'work'});await disabled.text();
 assert.match(providerInput,/Lead with the requested result or answer/);assert.match(providerInput,/Second request\./);
 assert.doesNotMatch(providerInput,/clear Korean|solar research|brief actionable plan|Check assumptions/);
 const explicitSkill=await call('chat','POST',{model:'gpt-6-astra',prompt:'Use my skill.',skillId:'review'});await explicitSkill.text();
 assert.match(providerInput,/Check assumptions/);assert.doesNotMatch(providerInput,/solar research|responseStyle/);
 assert.equal((await call('chat','POST',{model:'gpt-6-astra',prompt:'Invalid',workspaceMode:'runner'})).status,400);
 assert.equal((await call('chat','POST',{model:'gpt-6-astra',prompt:'Invalid',skillId:'missing'})).status,400);
 await call('settings','PATCH',{personalizationEnabled:false,customInstructions:'',memory:'',workResponseStyle:'plan-first',skills:[]});
 globalThis.fetch=originalFetch;
});
test('conversation search matches message text, escapes wildcards and scopes results to owner',async()=>{
 const now=Date.now();
 for(const [id,owner,title,content] of [['search-alice','alice','Research notes','The identifier is 100%_literal and the keyword is nebula.'],['search-bob','bob','Other account','This private nebula document belongs to Bob.']]){
  sqlite.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?)').run(id,owner,title,'gpt-6-astra',now,now);
  sqlite.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(id+'-msg',id,'user',content,null,now);
 }
 const results=(await(await call('search?q=nebula')).json()).results;
 assert.equal(results.length,1);assert.equal(results[0].id,'search-alice');assert.match(results[0].snippet,/nebula/);
 assert.equal((await(await call('search?q='+encodeURIComponent('100%_literal'))).json()).results.length,1);
 assert.equal((await(await call('search?q='+encodeURIComponent('%not-a-wildcard%'))).json()).results.length,0);
 assert.deepEqual((await(await call('search?q=')).json()).results,[]);
 assert.equal((await call('search?q='+'a'.repeat(201))).status,400);
 user={userId:'bob',email:'bob@example.test'};
 assert.equal((await(await call('search?q=nebula')).json()).results[0].id,'search-bob');
 user={userId:'alice',email:'alice@example.test'};
});
test('public shares use immutable snapshots, exclude attached files and enforce ownership and revocation',async()=>{
 const now=Date.now();
 sqlite.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run('share-private-doc','search-alice','user','Read this\n\n<attached_document name="secret.txt">\nPRIVATE DOCUMENT\n</attached_document>\nADDITIONAL PRIVATE DOCUMENT\n</attached_document>',null,now+1);
 const created=await call('shares','POST',{conversationId:'search-alice'});assert.equal(created.status,201);
 const share=await created.json();assert.match(share.token,/^[a-f0-9]{64}$/);assert.equal(share.url,'https://prism.test/share/'+share.token);
 assert.equal((await(await call('shares')).json()).shares.length,1);
 user={userId:'bob',email:'bob@example.test'};
 assert.equal((await call('shares','POST',{conversationId:'search-alice'})).status,404);
 assert.equal((await call('shares/'+share.id,'DELETE')).status,404);
 assert.equal((await(await call('shares')).json()).shares.length,0);
 sqlite.prepare('UPDATE messages SET content=? WHERE id=?').run('Changed after sharing','search-alice-msg');
 user=null;
 const published=await call('public-shares/'+share.token);assert.equal(published.status,200);assert.equal(published.headers.get('Cache-Control'),'no-store');
 const data=await published.json();assert.equal(data.title,'Research notes');assert.match(data.messages[0].content,/nebula/);assert.doesNotMatch(JSON.stringify(data),/PRIVATE DOCUMENT/);assert.match(data.messages[1].content,/omitted/);
 assert.equal((await call('public-shares/invalid')).status,404);
 user={userId:'alice',email:'alice@example.test'};
 assert.equal((await call('shares/'+share.id,'DELETE')).status,200);
 user=null;assert.equal((await call('public-shares/'+share.token)).status,404);
 user={userId:'alice',email:'alice@example.test'};
 const second=await(await call('shares','POST',{conversationId:'search-alice'})).json();
 await call('conversations/search-alice','DELETE');
 assert.equal((await call('public-shares/'+second.token)).status,404);
});

test('settings accept maximum valid escaped text while retaining scoped request size limits',async()=>{
 user={userId:'large-settings',email:'large-settings@example.test'};
 try{
  const escaped='\u0001';
  const settings={personalizationEnabled:true,customInstructions:escaped.repeat(4000),memory:escaped.repeat(8000),workResponseStyle:'plan-first',browserTarget:'current',browserPermission:'ask',skills:Array.from({length:20},(_,i)=>({id:'skill-'+i,name:escaped.repeat(60),instructions:escaped.repeat(4000)}))};
  const bytes=Buffer.byteLength(JSON.stringify(settings));assert.ok(bytes>500000&&bytes<600000);
  const saved=await call('settings','PATCH',settings);assert.equal(saved.status,200);assert.deepEqual(await saved.json(),settings);
  const oversized=new Request('https://prism.test/api/settings',{method:'PATCH',body:' '.repeat(600001)});
  assert.equal((await route.PATCH(oversized)).status,413);
  const otherMethod=new Request('https://prism.test/api/settings',{method:'POST',body:' '.repeat(200001)});
  assert.equal((await route.POST(otherMethod)).status,413);
  const otherEndpoint=new Request('https://prism.test/api/conversations/missing',{method:'PATCH',body:' '.repeat(200001)});
  assert.equal((await route.PATCH(otherEndpoint)).status,413);
 }finally{
  sqlite.prepare('DELETE FROM workspace_settings WHERE user_id=?').run('large-settings');
  user={userId:'alice',email:'alice@example.test'};
 }
});
test('concurrent public share creation cannot exceed the owner limit',async()=>{
 user={userId:'share-cap',email:'share-cap@example.test'};
 const now=Date.now();
 try{
  sqlite.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?)').run('share-cap-chat','share-cap','Limit test','gpt-6-astra',now,now);
  sqlite.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run('share-cap-message','share-cap-chat','user','A sharable message.',null,now);
  const insert=sqlite.prepare('INSERT INTO public_shares (id,user_id,conversation_id,token,title,snapshot,created_at) VALUES (?,?,?,?,?,?,?)');
  for(let i=0;i<99;i++)insert.run('share-cap-'+i,'share-cap','share-cap-chat',i.toString(16).padStart(64,'0'),'Limit test','[]',now);
  const responses=await Promise.all(Array.from({length:4},()=>call('shares','POST',{conversationId:'share-cap-chat'})));
  assert.equal(responses.filter(response=>response.status===201).length,1);
  assert.equal(responses.filter(response=>response.status===400).length,3);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM public_shares WHERE user_id=?').get('share-cap').n,100);
 }finally{
  sqlite.prepare('DELETE FROM conversations WHERE id=?').run('share-cap-chat');
  user={userId:'alice',email:'alice@example.test'};
 }
});
test('invalid and unavailable tool requests cannot call providers, reserve allowances, or create conversations',async()=>{
 const priorUser=user,priorBeta=env.BETA_MODE,priorKey=env.OPENAI_API_KEY;
 let providerCalls=0;
 try{
  user={userId:'tool-validation',email:'tool-validation@example.test'};env.BETA_MODE='true';env.OPENAI_API_KEY='test-only-key';
  globalThis.fetch=async()=>{providerCalls++;throw new Error('The provider must not be called.');};
  const base={model:'gpt-6.1-sol',prompt:'A request'};
  for(const [fields,status,code] of [
   [{tool:'shell'},400,'INVALID_TOOL'],[{tool:null},400,'INVALID_TOOL'],
   [{tool:'research',researchSources:{web:'yes'}},400,'INVALID_RESEARCH_SOURCES'],
   [{tool:'research',researchSources:{web:false,privateSource:'unexpected'}},400,'INVALID_RESEARCH_SOURCES'],
   [{tool:'research',researchSources:null},400,'INVALID_RESEARCH_SOURCES'],
   [{tool:'research',researchSources:{web:true}},503,'WEB_RESEARCH_NOT_CONFIGURED'],
   [{tool:'image'},503,'IMAGE_GENERATION_NOT_CONFIGURED'],[{tool:'video'},503,'VIDEO_GENERATION_NOT_CONFIGURED'],
  ]){
   const response=await call('chat','POST',{...base,...fields});assert.equal(response.status,status);assert.equal((await response.json()).code,code);
  }
  for(const body of ['null','[]','true'])assert.equal((await route.POST(new Request('https://prism.test/api/chat',{method:'POST',body}))).status,400);
  assert.equal(providerCalls,0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM usage WHERE user_id=?').get(user.userId).n,0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM conversations WHERE user_id=?').get(user.userId).n,0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE ?').get(user.userId+':%').n,0);
  assert.equal(await billing.balance(env.DB,user.userId),0);
  const boot=await(await call('bootstrap')).json();assert.deepEqual(boot.capabilities,{webResearch:false,image:false,video:false,remoteBrowser:false});
  user=null;assert.equal((await call('chat','POST',{...base,tool:'canvas'})).status,401);
 }finally{
  user=priorUser;if(priorBeta===undefined)delete env.BETA_MODE;else env.BETA_MODE=priorBeta;if(priorKey===undefined)delete env.OPENAI_API_KEY;else env.OPENAI_API_KEY=priorKey;globalThis.fetch=originalFetch;
 }
});
test('Canvas, learning, and source research use actual provider output with normal persistence and beta metering',async()=>{
 const priorUser=user,priorBeta=env.BETA_MODE,priorKey=env.OPENAI_API_KEY;
 let providerInput='',providerCalls=0;
 try{
  user={userId:'tool-inference',email:'tool-inference@example.test'};env.BETA_MODE='true';env.OPENAI_API_KEY='test-only-key';
  globalThis.fetch=async(url,options)=>{
   providerCalls++;assert.equal(url,'https://api.openai.com/v1/responses');
   const body=JSON.parse(options.body);providerInput=body.input.at(-1).content;assert.equal(body.max_output_tokens,1024);assert.equal(body.store,false);assert.equal(body.tools,undefined);
   return mockSSE([{type:'response.output_text.delta',delta:'A provider-generated result.'},{type:'response.completed',response:{usage:{input_tokens:30,output_tokens:10}}}]);
  };
  const form=new FormData();form.set('file',new File(['Confirmed finding: the study involved 12 participants.'],'study-notes.txt'));
  const uploaded=await call('files','POST',form);assert.equal(uploaded.status,200);const file=await uploaded.json();
  for(const [tool,instruction] of [['canvas',/complete, editable draft/],['learning',/check-for-understanding/],['research',/NO web search/]]){
   const prompt='Work with my supplied evidence.';
   const response=await call('chat','POST',{model:'gpt-6.1-sol',prompt,tool,researchSources:{web:false},...(tool==='research'?{fileIds:[file.id]}:{})});
   assert.equal(response.status,200);
   const events=(await response.text()).split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
   const start=events.find(event=>event.type==='start'),done=events.find(event=>event.type==='done');
   assert.equal(start.tool,tool);assert.equal(done?.tool,tool);assert.match(providerInput,instruction);
   const detail=await(await call('conversations/'+start.conversationId)).json();
   assert.deepEqual(detail.messages.map(message=>message.role),['user','assistant']);
   assert.ok(detail.messages[1].created_at>detail.messages[0].created_at,'assistant output must follow its user message');
   assert.equal(detail.messages[1].content,'A provider-generated result.');assert.doesNotMatch(detail.messages[0].content,/The user selected/);
   if(tool==='research'){assert.match(providerInput,/study-notes\.txt/);assert.match(providerInput,/12 participants/);assert.match(providerInput,/never invent source URLs/);}else assert.equal(detail.messages[0].content,prompt);
  }
  assert.equal(providerCalls,3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM usage WHERE user_id=? AND status='complete' AND rate_snapshot='beta:v1'").get(user.userId).n,3);
  assert.equal(await billing.balance(env.DB,user.userId),0);
  assert.equal((await call('files/'+file.id,'DELETE')).status,200);
 }finally{
  user=priorUser;if(priorBeta===undefined)delete env.BETA_MODE;else env.BETA_MODE=priorBeta;if(priorKey===undefined)delete env.OPENAI_API_KEY;else env.OPENAI_API_KEY=priorKey;globalThis.fetch=originalFetch;
 }
});
test('conversation chronology survives same-millisecond responses, clock rollback, and legacy timestamp ties',async()=>{
 const priorUser=user,priorBeta=env.BETA_MODE,priorKey=env.OPENAI_API_KEY,originalNow=Date.now;
 let clock=originalNow(),providerInputs=[];
 try{
  Date.now=()=>clock;
  user={userId:'chronology-user',email:'chronology@example.test'};env.BETA_MODE='true';env.OPENAI_API_KEY='test-only-key';
  globalThis.fetch=async(url,options)=>{
   const turns=JSON.parse(options.body).input;providerInputs.push(turns);
   for(const turn of turns)assert.deepEqual(Object.keys(turn).sort(),['content','role']);
   return mockSSE([{type:'response.output_text.delta',delta:'Answer '+providerInputs.length},{type:'response.completed',response:{usage:{input_tokens:20,output_tokens:5}}}]);
  };
  const readEvents=async response=>{
   assert.equal(response.status,200);
   const events=(await response.text()).split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
   assert.ok(events.some(event=>event.type==='done'));return events;
  };
  const first=await readEvents(await call('chat','POST',{model:'gpt-6.1-sol',prompt:'Question 1'}));
  const id=first.find(event=>event.type==='start').conversationId;
  clock-=100;
  await readEvents(await call('chat','POST',{model:'gpt-6.1-sol',prompt:'Question 2',conversationId:id}));
  const detail=await(await call('conversations/'+id)).json();
  assert.deepEqual(detail.messages.map(message=>message.role),['user','assistant','user','assistant']);
  assert.deepEqual(detail.messages.map(message=>message.content),['Question 1','Answer 1','Question 2','Answer 2']);
  for(let i=1;i<detail.messages.length;i++)assert.ok(detail.messages[i].created_at>detail.messages[i-1].created_at);
  assert.equal(detail.conversation.updated_at,detail.messages.at(-1).created_at);
  assert.deepEqual(providerInputs[1].map(turn=>turn.content),['Question 1','Answer 1','Question 2']);
  const published=await(await call('shares','POST',{conversationId:id})).json();
  const shared=await(await call('public-shares/'+published.token)).json();
  assert.deepEqual(shared.messages.map(message=>message.content),detail.messages.map(message=>message.content));

  // Earlier releases stored random IDs with equal times; their insert order is
  // authoritative. Deliberately make lexical ID order contradict chronology.
  sqlite.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?)').run('legacy-time-tie',user.userId,'Legacy','gpt-6.1-sol',clock,clock);
  sqlite.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run('z-legacy-question','legacy-time-tie','user','Legacy question',null,clock);
  sqlite.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run('a-legacy-answer','legacy-time-tie','assistant','Legacy answer','gpt-6.1-sol',clock);
  assert.deepEqual((await(await call('conversations/legacy-time-tie')).json()).messages.map(message=>message.role),['user','assistant']);
  await readEvents(await call('chat','POST',{model:'gpt-6.1-sol',prompt:'Continue legacy',conversationId:'legacy-time-tie'}));
  assert.deepEqual(providerInputs[2].map(turn=>turn.content),['Legacy question','Legacy answer','Continue legacy']);
  const legacy=await(await call('conversations/legacy-time-tie')).json();
  assert.deepEqual(legacy.messages.map(message=>message.role),['user','assistant','user','assistant']);
  assert.ok(legacy.messages[2].created_at>legacy.messages[1].created_at);assert.ok(legacy.messages[3].created_at>legacy.messages[2].created_at);
 }finally{
  Date.now=originalNow;user=priorUser;if(priorBeta===undefined)delete env.BETA_MODE;else env.BETA_MODE=priorBeta;if(priorKey===undefined)delete env.OPENAI_API_KEY;else env.OPENAI_API_KEY=priorKey;globalThis.fetch=originalFetch;
 }
});
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
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_settings WHERE user_id=?').get('alice').n,0);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_settings WHERE user_id=?').get('bob').n,1);
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
