import { acquireRequestLease, releaseRequestLease } from './request-lease';
import { BillingError } from './billing';
import { reserveMedia } from './beta';
import { getWorkspaceCapabilities, WorkspaceToolError, betaDailyLimit, MEDIA_RESERVATION_MICROS } from './workspace-tools';
import { generateImage, generateMusic, createVideo, pollVideo, downloadVideo, mediaModel, validateMediaInput, MAX_REFERENCE_BYTES, type MediaAsset, type MediaInput, type VideoJob } from './media-provider';
import { isOwnedObjectKey, safeDownloadName, attachmentDisposition, validReferenceName, PRIVATE_FILE_HEADERS } from './upload-security';
import { readSingleFileUpload } from './upload-validation';
import { trackProviderAttempt } from './security-monitoring';

type MediaRow = {
 id:string; user_id:string; kind:'image'|'video'|'music'|'reference'; prompt:string; model:string;
 status:'processing'|'complete'|'error'; object_key:string|null; mime_type:string|null; size:number;
 job:string|null; usage_id:string|null; error:string|null; created_at:number; updated_at:number;
};
const json = (data:unknown,status=200) => Response.json(data,{status});
const publicAsset = (row:MediaRow) => ({id:row.id,kind:row.kind,prompt:row.prompt,model:row.model,status:row.status,
 // Older rows may contain an unexpected transport exception. Never replay those diagnostics.
 mimeType:row.mime_type,url:row.status==='complete'?'/api/media/'+row.id+'/content':undefined,
 error:row.error?'미디어 작업을 완료하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해주세요.':null,createdAt:row.created_at});
function publicMediaError(error:unknown):BillingError|WorkspaceToolError {
 if(error instanceof BillingError||error instanceof WorkspaceToolError)return error;
 if(error instanceof Error&&['AbortError','TimeoutError'].includes(error.name))return new WorkspaceToolError('미디어 요청이 취소되었거나 시간이 초과되었습니다.',504,'MEDIA_TIMEOUT');
 return new WorkspaceToolError('미디어 요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.',502,'MEDIA_UNAVAILABLE');
}
function byteRange(value:string,size:number):{offset:number;length:number}|null {
 const match=/^bytes=(\d*)-(\d*)$/.exec(value.trim());
 if(!match||(!match[1]&&!match[2])||!Number.isSafeInteger(size)||size<1)return null;
 const first=match[1]?Number(match[1]):undefined,last=match[2]?Number(match[2]):undefined;
 if((first!==undefined&&!Number.isSafeInteger(first))||(last!==undefined&&!Number.isSafeInteger(last)))return null;
 if(first===undefined){if(last===undefined||last<1)return null;const length=Math.min(last,size);return {offset:size-length,length};}
 if(first>=size||(last!==undefined&&last<first))return null;
 return {offset:first,length:Math.min(last??size-1,size-1)-first+1};
}

async function finalize(env:Cloudflare.Env,sql:D1Database,owner:string,row:MediaRow,asset:MediaAsset) {
 if(!env.BUCKET)throw new BillingError('파일 저장소를 사용할 수 없습니다.',503);
 // A unique object key prevents a losing finalizer from overwriting or deleting a winner's file.
 const key=`${owner}/media/${row.id}/${crypto.randomUUID()}`;
 await env.BUCKET.put(key,asset.bytes,{httpMetadata:{contentType:asset.mimeType}});
 try {
  const statements=[sql.prepare("UPDATE media_assets SET status='complete',object_key=?,mime_type=?,size=?,model=?,job=NULL,error=NULL,updated_at=? WHERE id=? AND user_id=? AND status='processing'")
   .bind(key,asset.mimeType,asset.bytes.byteLength,asset.model,Date.now(),row.id,owner)];
  if(row.usage_id)statements.push(sql.prepare("UPDATE usage SET status='complete',input_tokens=?,output_tokens=?,duration=? WHERE id=? AND user_id=? AND EXISTS (SELECT 1 FROM media_assets WHERE id=? AND user_id=? AND status='complete' AND object_key=?)")
   .bind(asset.usage?.input||0,asset.usage?.output||0,Math.max(0,Date.now()-row.created_at),row.usage_id,owner,row.id,owner,key));
  // Keep the conservative media reservation until provider reconciliation; no fabricated token counts or prices.
  const results=await sql.batch(statements);
  if(results[0]?.meta?.changes!==1)throw new BillingError('작업 상태가 변경되었습니다. 목록을 새로고침해주세요.',409);
 } catch(error) {await env.BUCKET.delete(key);throw error;}
 return {...row,model:asset.model,status:'complete' as const,object_key:key,mime_type:asset.mimeType,size:asset.bytes.byteLength};
}

export async function handleMedia(req:Request,path:string[],sql:D1Database,owner:string,env:Cloudflare.Env):Promise<Response|null> {
 if(path[0]!=='media')return null;
 if(req.method!=='GET'&&req.signal.aborted)throw new BillingError('요청이 취소되었습니다.',408);
 if(req.method==='GET'&&path.length===1){
  const kind=new URL(req.url).searchParams.get('kind');
  const rows=(await sql.prepare("SELECT * FROM media_assets WHERE user_id=? AND kind!='reference' ORDER BY created_at DESC LIMIT 100").bind(owner).all<MediaRow>()).results;
  return json({assets:rows.filter(row=>!kind||row.kind===kind).map(publicAsset)});
 }
 if(req.method==='POST'&&path.length===2&&path[1]==='reference'){
  if(!env.BUCKET)throw new BillingError('파일 저장소를 사용할 수 없습니다.',503);
  const file=await readSingleFileUpload(req,MAX_REFERENCE_BYTES);
  if(file.size<1||!validReferenceName(file.name,file.type))throw new BillingError('4 MB 이하의 PNG, JPEG, WebP 이미지를 선택해주세요. 파일 확장자와 실제 형식이 일치해야 합니다.',400);
  const bytes=new Uint8Array(await file.arrayBuffer());
  await validateMediaInput({prompt:'참고 이미지',reference:{bytes,mimeType:file.type as 'image/png'|'image/jpeg'|'image/webp'}});
  if(req.signal.aborted)throw new BillingError('요청이 취소되었습니다.',408);
  const id=crypto.randomUUID(),key=`${owner}/references/${id}`,now=Date.now(),name=safeDownloadName(file.name);
  await env.BUCKET.put(key,bytes,{httpMetadata:{contentType:file.type}});
  try {
   const inserted=await sql.prepare("INSERT INTO media_assets (id,user_id,kind,prompt,model,status,object_key,mime_type,size,created_at,updated_at) SELECT ?,?,'reference',?,'','complete',?,?,?,?,? WHERE (SELECT COUNT(*) FROM media_assets WHERE user_id=? AND kind='reference')<20 RETURNING id")
    .bind(id,owner,name,key,file.type,file.size,now,now,owner).first();
   if(!inserted)throw new BillingError('이전 참고 이미지를 제거한 뒤 다시 업로드해주세요.',400);
  }
  catch(error){await env.BUCKET.delete(key);throw error;}
  return json({id,name,url:`/api/media/${id}/content`},201);
 }
 if(req.method==='POST'&&path.length===1){
  const body=await req.json() as Record<string,unknown>;
  if(!body||!['image','video','music'].includes(String(body.kind))||typeof body.prompt!=='string'||!body.prompt.trim()||body.prompt.length>2000)
   throw new BillingError('미디어 종류와 2,000자 이하의 설명을 입력해주세요.',400);
  const kind=body.kind as 'image'|'video'|'music',capabilities=getWorkspaceCapabilities(env);
  // Commercial media tariffs require their own approved rate; text tariffs cannot cover media.
  if(env.BETA_MODE!=='true')throw new WorkspaceToolError('미디어 요금 정책을 설정한 뒤 사용할 수 있습니다.',503,'MEDIA_PRICING_NOT_CONFIGURED');
  if(kind==='video'&&env.GEMINI_API_KEY&&MEDIA_RESERVATION_MICROS.video>betaDailyLimit(env))throw new WorkspaceToolError('동영상 생성에는 현재 무료 체험 한도보다 큰 별도 미디어 예산이 필요합니다. 운영자의 이용 정책 승인이 필요합니다.',503,'VIDEO_BUDGET_NOT_CONFIGURED');
  if(!capabilities[kind])throw new WorkspaceToolError(kind==='image'?'이미지 API 연결과 이용 정책 설정이 필요합니다.':kind==='video'?'동영상 생성에는 Google 생성 서비스 연결과 승인된 별도 미디어 예산이 필요합니다.':'음악 생성에는 Google 생성 서비스 연결과 이용 정책 설정이 필요합니다.',503,`${kind.toUpperCase()}_GENERATION_NOT_CONFIGURED`);
  if(body.aspect!==undefined&&body.aspect!=='16:9'&&body.aspect!=='9:16')throw new BillingError('지원하는 화면 비율을 선택해주세요.',400);
  if(!env.BUCKET)throw new BillingError('파일 저장소를 사용할 수 없습니다.',503);
  if(await sql.prepare('SELECT user_id FROM account_flags WHERE user_id=?').bind(owner).first())throw new BillingError('계정 이용 상태를 확인해주세요.',403);
  const input:MediaInput={prompt:body.prompt.trim(),aspect:body.aspect as '16:9'|'9:16'|undefined};
  if(body.referenceId!==undefined){
   if(typeof body.referenceId!=='string')throw new BillingError('참고 이미지를 확인해주세요.',400);
   const reference=await sql.prepare("SELECT * FROM media_assets WHERE id=? AND user_id=? AND kind='reference'").bind(body.referenceId,owner).first<MediaRow>();
   const object=isOwnedObjectKey(reference?.object_key,owner,'references')?await env.BUCKET.get(reference!.object_key!):null;
   if(!reference||!object)throw new BillingError('참고 이미지를 찾을 수 없습니다. 다시 업로드해주세요.',404);
   if(!Number.isSafeInteger(reference.size)||reference.size<1||reference.size>MAX_REFERENCE_BYTES||!Number.isSafeInteger(object.size)||object.size<1||object.size>MAX_REFERENCE_BYTES||reference.size!==object.size)throw new BillingError('참고 이미지를 다시 업로드해주세요.',400);
   input.reference={bytes:new Uint8Array(await object.arrayBuffer()),mimeType:reference.mime_type as 'image/png'|'image/jpeg'|'image/webp',name:reference.prompt};
  }
  // Reject invalid references and model configuration before reserving money or creating a job.
  await validateMediaInput(input);
  const model=mediaModel(env,kind),now=Date.now(),id=crypto.randomUUID(),usageId=crypto.randomUUID();
  const reserve=MEDIA_RESERVATION_MICROS[kind];
  if(req.signal.aborted)throw new BillingError('요청이 취소되었습니다.',408);
  await reserveMedia(sql,owner,usageId,model,kind==='image'?'openai':'google',reserve,now,betaDailyLimit(env));
  const row:MediaRow={id,user_id:owner,kind,prompt:input.prompt,model,status:'processing',object_key:null,mime_type:null,size:0,job:null,usage_id:usageId,error:null,created_at:now,updated_at:now};
  let providerStarted=false;
  try {
   await sql.prepare("INSERT INTO media_assets (id,user_id,kind,prompt,model,status,usage_id,created_at,updated_at) VALUES (?,?,?,?,?,'processing',?,?,?)").bind(id,owner,kind,input.prompt,model,usageId,now,now).run();
   const signal=AbortSignal.any([req.signal,AbortSignal.timeout(180000)]);
   if(signal.aborted)throw new BillingError('요청이 취소되었습니다. 생성 요청을 보내지 않았습니다.',408);
   providerStarted=true;
   if(kind==='video'){
    const result=await trackProviderAttempt(sql,usageId,()=>createVideo(env,input,signal));
    if(result.status==='processing'){
     await sql.prepare('UPDATE media_assets SET job=? WHERE id=? AND user_id=?').bind(JSON.stringify(result.job),id,owner).run();
     return json(publicAsset(row),202);
    }
    return json(publicAsset(await finalize(env,sql,owner,row,result.asset)),201);
   }
   const asset=await trackProviderAttempt(sql,usageId,()=>kind==='image'?generateImage(env,input,signal):generateMusic(env,input,signal));
   return json(publicAsset(await finalize(env,sql,owner,row,asset)),201);
  }catch(error){
   const safeError=publicMediaError(error),message=safeError.message;
   await sql.batch([sql.prepare("UPDATE media_assets SET status='error',error=?,updated_at=? WHERE id=? AND user_id=?").bind(message,Date.now(),id,owner),
    sql.prepare("UPDATE usage SET status='error',error=?,duration=?,reserved_amount=CASE WHEN ? THEN reserved_amount ELSE 0 END WHERE id=? AND user_id=?").bind(message,Date.now()-now,Number(providerStarted),usageId,owner)]);
   throw safeError;
  }
 }
 if(path.length>=2){
  const row=await sql.prepare('SELECT * FROM media_assets WHERE id=? AND user_id=?').bind(path[1],owner).first<MediaRow>();
  if(!row)return json({error:'미디어를 찾을 수 없습니다.'},404);
  if(req.method==='GET'&&path.length===3&&path[2]==='content'){
   if(!isOwnedObjectKey(row.object_key,owner,row.kind==='reference'?'references':'media')||row.status!=='complete')return json({error:'파일이 아직 준비되지 않았습니다.'},404);
   const allowedTypes=row.kind==='reference'?['image/png','image/jpeg','image/webp']:row.kind==='image'?['image/png']:row.kind==='video'?['video/mp4']:row.kind==='music'?['audio/mpeg']:[];
   if(!row.mime_type||!allowedTypes.includes(row.mime_type)||!Number.isSafeInteger(row.size)||row.size<1||row.size>16*1024*1024)return json({error:'파일 형식을 확인할 수 없습니다.'},415);
   const requested=req.headers.get('range'),range=requested===null?undefined:byteRange(requested,row.size);
   if(range===null)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${row.size}`,'Accept-Ranges':'bytes','Cache-Control':'private, no-store'}});
   const object=await env.BUCKET?.get(row.object_key,range?{range}:undefined);
   if(!object)return json({error:'파일을 찾을 수 없습니다.'},404);
   const headers:Record<string,string>={...PRIVATE_FILE_HEADERS,'Content-Type':row.mime_type,'Accept-Ranges':'bytes'};
   if(new URL(req.url).searchParams.get('download')==='1')headers['Content-Disposition']=attachmentDisposition(row.kind==='reference'?row.prompt:`${row.kind}-${row.id}.${row.mime_type==='image/png'?'png':row.mime_type==='video/mp4'?'mp4':'mp3'}`);
   if(range){headers['Content-Range']=`bytes ${range.offset}-${range.offset+range.length-1}/${row.size}`;headers['Content-Length']=String(range.length);}
   else headers['Content-Length']=String(row.size);
   return new Response(object.body,{status:headers['Content-Range']?206:200,headers});
  }
  if(req.method==='GET'&&path.length===2)return json(publicAsset(row));
  if(req.method==='POST'&&path.length===3&&path[2]==='refresh'){
   if(row.status!=='processing'||!row.job)return json(publicAsset(row));
   const lock=await acquireRequestLease(sql,`media-poll:${row.id}`,60000);
   if(!lock)return json(publicAsset(row),202);
   try{
    const job=JSON.parse(row.job) as VideoJob,signal=AbortSignal.any([req.signal,AbortSignal.timeout(45000)]);
    if(await pollVideo(env,job,signal)==='processing')return json(publicAsset(row),202);
    return json(publicAsset(await finalize(env,sql,owner,row,await downloadVideo(env,job,signal))));
   }catch(error){
    const message=publicMediaError(error).message;
    if(error instanceof WorkspaceToolError&&error.code==='VIDEO_PROCESSING_FAILED'){
     await sql.batch([sql.prepare("UPDATE media_assets SET status='error',error=?,job=NULL,updated_at=? WHERE id=? AND user_id=? AND status='processing'").bind(message,Date.now(),row.id,owner),
      sql.prepare("UPDATE usage SET status='error',error=?,duration=? WHERE id=? AND user_id=? AND status='pending'").bind(message,Date.now()-row.created_at,row.usage_id,owner)]);
     return json({error:message,id:row.id,status:'error'},502);
    }
    // Transport failures are retryable; do not discard a paid provider job.
    return json({error:message,id:row.id,status:'processing'},502);
   }finally{await releaseRequestLease(sql,lock);}
  }
  if(req.method==='DELETE'&&path.length===2){
   if(row.status==='processing')return json({error:'진행 중인 작업은 완료된 후 삭제해주세요.'},409);
   if(row.object_key&&!isOwnedObjectKey(row.object_key,owner,row.kind==='reference'?'references':'media'))return json({error:'파일을 찾을 수 없습니다.'},404);
   if(row.object_key)await env.BUCKET?.delete(row.object_key);
   await sql.prepare('DELETE FROM media_assets WHERE id=? AND user_id=?').bind(row.id,owner).run();
   return json({ok:true});
  }
 }
 return json({error:'미디어 경로를 찾을 수 없습니다.'},404);
}
