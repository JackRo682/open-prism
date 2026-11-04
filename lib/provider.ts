import type { Model } from './models';
export type Turn = { role: 'user'|'assistant'; content: string };
export type ProviderSource = { url: string; title: string; startIndex?: number; endIndex?: number };
export type ProviderArtifact = {containerId:string;fileId:string;filename:string;startIndex?:number;endIndex?:number};
export type Usage = {input:number;output:number;webSearchCalls?:number;sources?:ProviderSource[];codeInterpreterContainers?:number;artifacts?:ProviderArtifact[]};
export type ProviderOptions = {
 webSearch?: boolean;
 codeInterpreter?: boolean;
 maxToolCalls?: number;
 onSources?(sources:ProviderSource[]):void;
 /** Replace streamed citation markers with the provider's actual clickable citations. */
 onTextReplace?(text:string):void;
};

function sourceFrom(value:unknown):ProviderSource|null {
 if(!value||typeof value!=='object')return null;
 const row=value as Record<string,unknown>;
 if(typeof row.url!=='string'||row.url.length>4096)return null;
 try{
  const url=new URL(row.url);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;
  return {url:url.href,title:typeof row.title==='string'&&row.title.trim()?row.title.trim().slice(0,500):url.hostname,
   ...(Number.isSafeInteger(row.start_index)&&Number.isSafeInteger(row.end_index)?{startIndex:Number(row.start_index),endIndex:Number(row.end_index)}:{})};
 }catch{return null;}
}
const markdownUrl=(url:string)=>url.replace(/[()\[\]<>\\\s]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase().padStart(2,'0'));
const markdownLabel=(title:string)=>title.replace(/[\[\]\\<>\r\n]/g,' ').replace(/\s+/g,' ').trim()||'출처';

/** Annotations, not model-invented URLs, supply citations saved in conversations. */
export function formatWebResponse(items:unknown[],fallbackText=''):{text:string;sources:ProviderSource[];webSearchCalls:number}{
 const sources=new Map<string,ProviderSource>(),searchIds=new Set<string>(),messages:string[]=[];
 const add=(source:ProviderSource|null)=>{if(!source||sources.size>=100)return;const previous=sources.get(source.url);sources.set(source.url,previous?{...previous,...source}:source);};
 for(const [index,raw] of items.entries()){
  if(!raw||typeof raw!=='object')continue;
  const item=raw as Record<string,any>;
  if(item.type==='web_search_call'){
   // Opening and finding in a page are not separately billed search actions.
   if(!item.action?.type||item.action.type==='search')searchIds.add(typeof item.id==='string'?item.id:`call-${index}`);
   if(Array.isArray(item.action?.sources))item.action.sources.forEach((source:unknown)=>add(sourceFrom(source)));
  }
  if(item.type!=='message'||!Array.isArray(item.content))continue;
  for(const content of item.content){
   if(content?.type!=='output_text'||typeof content.text!=='string')continue;
   const original=content.text;
   const insertions=new Map<number,Map<string,ProviderSource>>();
   for(const annotation of Array.isArray(content.annotations)?content.annotations:[]){
    if(annotation?.type!=='url_citation')continue;
    const source=sourceFrom(annotation);if(!source)continue;add(source);
    const position=source.endIndex!==undefined&&source.startIndex!==undefined&&source.startIndex>=0&&source.endIndex>=source.startIndex&&source.endIndex<=original.length?source.endIndex:original.length;
    if(!insertions.has(position))insertions.set(position,new Map());
    insertions.get(position)!.set(source.url,source);
   }
   let formatted=original;
   // Descending offsets preserve the provider's original annotation positions.
   for(const [position,group] of [...insertions].sort(([a],[b])=>b-a)){
    const links=[...group.values()].map(source=>`[${markdownLabel(source.title)}](${markdownUrl(source.url)})`).join(' ');
    formatted=formatted.slice(0,position)+' '+links+formatted.slice(position);
   }
   messages.push(formatted.replace(/\uE200cite\uE202[^\uE201]*\uE201/g,''));
  }
 }
 let text=messages.length?messages.join('\n\n'):fallbackText;
 // Sources without annotation positions remain accessible without attributing a specific claim.
 if(sources.size&&!messages.some(message=>/\]\(https?:\/\//.test(message)))text+='\n\n검색에 사용한 출처\n'+[...sources.values()].map(source=>`- [${markdownLabel(source.title)}](${markdownUrl(source.url)})`).join('\n');
 return {text,sources:[...sources.values()],webSearchCalls:searchIds.size};
}

function codeResults(items:unknown[],maxCalls:number):{codeInterpreterContainers:number;artifacts:ProviderArtifact[]}{
 const containers=new Set<string>(),calls=new Set<string>(),artifacts=new Map<string,ProviderArtifact>();
 for(const [index,raw] of items.entries()){
  if(!raw||typeof raw!=='object')continue;
  const item=raw as Record<string,unknown>;
  if(item.type!=='code_interpreter_call')continue;
  if(typeof item.container_id!=='string'||!/^cntr_[a-zA-Z0-9_-]{1,200}$/.test(item.container_id))throw new Error('코드 실행 서비스가 사용량 확인에 필요한 실행 환경 정보를 반환하지 않았습니다.');
  containers.add(item.container_id);calls.add(typeof item.id==='string'?item.id:`code-${index}`);
 }
 if(calls.size>maxCalls||containers.size>maxCalls)throw new Error('코드 실행이 허용된 요청 횟수를 초과했습니다.');
 for(const raw of items){
  if(!raw||typeof raw!=='object')continue;
  const item=raw as Record<string,any>;
  if(item.type!=='message'||!Array.isArray(item.content))continue;
  for(const content of item.content){
   if(content?.type!=='output_text'||!Array.isArray(content.annotations))continue;
   for(const annotation of content.annotations){
    if(annotation?.type!=='container_file_citation'||!containers.has(annotation.container_id)||typeof annotation.file_id!=='string'||!/^cfile_[a-zA-Z0-9_-]{1,200}$/.test(annotation.file_id)||typeof annotation.filename!=='string')continue;
    const filename=annotation.filename.replaceAll('\\','/').split('/').at(-1)?.replace(/[\x00-\x1F\x7F]/g,'').trim().slice(0,240);
    if(!filename||artifacts.size>=20)continue;
    artifacts.set(annotation.container_id+':'+annotation.file_id,{containerId:annotation.container_id,fileId:annotation.file_id,filename,
     ...(Number.isSafeInteger(annotation.start_index)&&annotation.start_index>=0&&Number.isSafeInteger(annotation.end_index)&&annotation.end_index>=annotation.start_index?{startIndex:annotation.start_index,endIndex:annotation.end_index}:{})});
   }
  }
 }
 return {codeInterpreterContainers:containers.size,artifacts:[...artifacts.values()]};
}

// Container paths are not browser downloads. Only the application's authenticated artifact route can supply a working link.
const withoutSandboxLinks=(text:string)=>text.replace(/!?\[([^\]\r\n]*)\]\(<?(?:sandbox:|attachment:|\/mnt\/data\/)[^\r\n)]*\)/gi,'$1').replace(/\uE200filecite\uE202[^\uE201]*\uE201/g,'');

export async function invokeProvider(model: Model, key: string, turns: Turn[], effort:string, pro:boolean, signal:AbortSignal, emit:(text:string)=>void, maxOutput=8192, options:ProviderOptions={}): Promise<Usage> {
 if(options.webSearch&&model.provider!=='openai')throw new Error('웹 리서치는 현재 연결된 OpenAI 모델에서 사용할 수 있습니다. OpenAI 모델을 선택해주세요.');
 if(options.codeInterpreter&&model.provider!=='openai')throw new Error('코드 실행은 현재 연결된 OpenAI 모델에서 사용할 수 있습니다. OpenAI 모델을 선택해주세요.');
 const maxToolCalls=options.maxToolCalls??2;
 if((options.webSearch||options.codeInterpreter)&&(!Number.isSafeInteger(maxToolCalls)||maxToolCalls<1||maxToolCalls>8))throw new Error('도구 요청 횟수가 올바르지 않습니다.');
 let url='', headers:Record<string,string>={'Content-Type':'application/json'}, body:Record<string,unknown>={};
 if(model.provider==='openai'){
  url='https://api.openai.com/v1/responses'; headers.Authorization='Bearer '+key;
  body={model:model.id,input:turns,stream:true,store:false,max_output_tokens:maxOutput,reasoning:{effort,...(pro?{mode:'pro'}:{})}};
  if(options.webSearch||options.codeInterpreter)Object.assign(body,{tools:[
   ...(options.webSearch?[{type:'web_search',external_web_access:true,search_context_size:'low'}]:[]),
   ...(options.codeInterpreter?[{type:'code_interpreter',container:{type:'auto',memory_limit:'1g',network_policy:{type:'disabled'}}}]:[]),
  ],tool_choice:options.webSearch?'required':'auto',max_tool_calls:maxToolCalls,...(options.webSearch?{include:['web_search_call.action.sources']}:{})});
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
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',input=0,output=0,complete=false,streamedText='';
 const outputItems=new Map<string,unknown>();let completedItems:unknown[]|undefined;
 function event(raw:string){
  let data:any; try{data=JSON.parse(raw);}catch{return;}
  if(data.type==='error')throw new Error('The provider interrupted the response. Please retry.');
  if(model.provider==='openai'){
   if(data.type==='response.output_text.delta'&&typeof data.delta==='string'){streamedText+=data.delta;emit(data.delta);}
   if((options.webSearch||options.codeInterpreter)&&data.type==='response.output_item.done'&&data.item)outputItems.set(String(data.item.id??data.output_index),data.item);
   if(data.type==='response.completed'){input=data.response?.usage?.input_tokens||0;output=data.response?.usage?.output_tokens||0;if(Array.isArray(data.response?.output))completedItems=data.response.output;complete=true;}
   if(['response.failed','response.incomplete'].includes(data.type))throw new Error('The response was incomplete. Try a lower reasoning level or a shorter prompt.');
  }else{
   if(data.type==='message_start')input=(data.message?.usage?.input_tokens||0)+(data.message?.usage?.cache_creation_input_tokens||0)+(data.message?.usage?.cache_read_input_tokens||0);
   if(data.type==='content_block_delta'&&data.delta?.type==='text_delta')emit(data.delta.text);
   if(data.type==='message_delta'){output=data.usage?.output_tokens||0;if(data.delta?.stop_reason==='max_tokens')throw new Error('The response reached its output limit. Try a shorter prompt.');}
   if(data.type==='message_stop')complete=true;
  }
 }
 try{while(true){const {done,value}=await reader.read();buffer+=decoder.decode(value,{stream:!done});if(buffer.length>2_000_000)throw new Error('The provider sent an oversized streaming event.');let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).replace(/\r$/,'');buffer=buffer.slice(i+1);if(line.startsWith('data:'))event(line.slice(5).trimStart());}if(done)break;}if(buffer.startsWith('data:'))event(buffer.slice(5).trimStart());}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 if(!complete)throw new Error('The provider connection ended before completing.');
 if(![input,output].every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('The provider did not report valid billable usage.');
 const measured:Usage={input,output},items=completedItems?.length?completedItems:[...outputItems.values()];let finalText=streamedText;
 if(options.webSearch){
  if(!items.some(item=>!!item&&typeof item==='object'&&(item as Record<string,unknown>).type==='web_search_call'))throw new Error('검색 서비스가 웹 검색 결과를 반환하지 않았습니다. 다시 시도하거나 문서 분석을 선택해주세요.');
  const result=formatWebResponse(items,streamedText);
  if(result.webSearchCalls>maxToolCalls)throw new Error('웹 검색이 허용된 요청 횟수를 초과했습니다.');
  finalText=result.text;Object.assign(measured,{webSearchCalls:result.webSearchCalls,sources:result.sources});
  options.onSources?.(result.sources);
 }
 if(options.codeInterpreter){
  Object.assign(measured,codeResults(items,maxToolCalls));
  if(!finalText)finalText=formatWebResponse(items).text;
  finalText=withoutSandboxLinks(finalText);
 }
 if(finalText&&finalText!==streamedText){
  if(options.onTextReplace)options.onTextReplace(finalText);
  else if(!streamedText)emit(finalText);
  else if(measured.sources?.length)emit('\n\n검색에 사용한 출처\n'+measured.sources.map(source=>`- [${markdownLabel(source.title)}](${markdownUrl(source.url)})`).join('\n'));
 }
 return measured;
}
