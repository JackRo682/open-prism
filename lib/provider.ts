import { Model } from './models';
export type Turn = { role: 'user'|'assistant'; content: string };
export type Usage = {input:number;output:number};
export async function invokeProvider(model: Model, key: string, turns: Turn[], effort:string, pro:boolean, signal:AbortSignal, emit:(text:string)=>void, maxOutput=8192): Promise<Usage> {
 let url='', headers:Record<string,string>={'Content-Type':'application/json'}, body:Record<string,unknown>={};
 if(model.provider==='openai'){
  url='https://api.openai.com/v1/responses'; headers.Authorization='Bearer '+key;
  body={model:model.id,input:turns,stream:true,store:false,max_output_tokens:maxOutput,reasoning:{effort,...(pro?{mode:'pro'}:{})}};
 }else if(model.provider==='anthropic'){
  url='https://api.anthropic.com/v1/messages';headers['x-api-key']=key;headers['anthropic-version']='2023-06-01';
  body={model:model.id,messages:turns,stream:true,max_tokens:maxOutput,thinking:{type:'adaptive'},output_config:{effort}};
 }else{
  url='https://generativelanguage.googleapis.com/v1beta/interactions';headers['x-goog-api-key']=key;
  body={model:model.id,input:turns.map(t=>({type:t.role==='assistant'?'model_output':'user_input',content:[{type:'text',text:t.content}]})),store:false,generation_config:{max_output_tokens:maxOutput}};
 }
 const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(body),signal});
 if(!response.ok){
  const codes:Record<number,string>={400:'The provider rejected these model settings. Check model availability and access.',401:'The provider API key is invalid or expired.',403:'Your API account does not have access to this model.',404:'This model is not available on your API account.',429:'The provider rate limit or billing quota was reached.'};
  throw new Error(codes[response.status]||'The AI provider is temporarily unavailable. Please try again.');
 }
 if(model.provider==='google'){
  const d:any=await response.json();
  if(d.status && !['completed','complete'].includes(d.status))throw new Error('The provider did not complete the response.');
  const text=d.output_text||(d.steps ? d.steps.filter((s:any)=>s.type==='model_output').flatMap((s:any)=>s.content||[]) : d.outputs||d.output||[]).filter((x:any)=>x.type==='text').map((x:any)=>x.text||'').join('');
  if(!text)throw new Error('The provider returned no text. Try a different prompt.');
  const measured={input:d.usage?.total_input_tokens??d.usage?.input_tokens??0,output:(d.usage?.total_output_tokens??d.usage?.output_tokens??0)+(d.usage?.total_thought_tokens??0)};
  if(![measured.input,measured.output].every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('The provider did not report valid billable usage.');
  emit(text); return measured;
 }
 if(!response.body)throw new Error('The provider returned an empty response.');
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',input=0,output=0,complete=false;
 function event(raw:string){
  let data:any; try{data=JSON.parse(raw);}catch{return;}
  if(data.type==='error')throw new Error('The provider interrupted the response. Please retry.');
  if(model.provider==='openai'){
   if(data.type==='response.output_text.delta')emit(data.delta);
   if(data.type==='response.completed'){input=data.response?.usage?.input_tokens||0;output=data.response?.usage?.output_tokens||0;complete=true;}
   if(['response.failed','response.incomplete'].includes(data.type))throw new Error('The response was incomplete. Try a lower reasoning level or a shorter prompt.');
  }else{
   if(data.type==='message_start')input=(data.message?.usage?.input_tokens||0)+(data.message?.usage?.cache_creation_input_tokens||0)+(data.message?.usage?.cache_read_input_tokens||0);
   if(data.type==='content_block_delta'&&data.delta?.type==='text_delta')emit(data.delta.text);
   if(data.type==='message_delta'){output=data.usage?.output_tokens||0;if(data.delta?.stop_reason==='max_tokens')throw new Error('The response reached its output limit. Try a shorter prompt.');}
   if(data.type==='message_stop')complete=true;
  }
 }
 try{while(true){const {done,value}=await reader.read();buffer+=decoder.decode(value,{stream:!done});let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).replace(/\r$/,'');buffer=buffer.slice(i+1);if(line.startsWith('data: '))event(line.slice(6));}if(done)break;}if(buffer.startsWith('data: '))event(buffer.slice(6));}finally{reader.releaseLock();}
 if(!complete)throw new Error('The provider connection ended before completing.');
 if(![input,output].every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('The provider did not report valid billable usage.');
 return {input,output};
}
