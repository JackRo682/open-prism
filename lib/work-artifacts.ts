import { BillingError } from './billing';
import { safeDownloadName, attachmentDisposition, isOwnedObjectKey, PRIVATE_FILE_HEADERS } from './upload-security';

type Artifact = {containerId:string;fileId:string;filename:string};
export type StoredArtifact = {id:string;name:string;url:string};
const MAX_FILE_BYTES=5*1024*1024;

export async function deleteWorkArtifacts(env:Cloudflare.Env,sql:D1Database,owner:string,ids:string[]){
 for(const id of ids){
  const file=await sql.prepare('SELECT object_key FROM work_artifacts WHERE id=? AND user_id=?').bind(id,owner).first<{object_key:string}>();
  if(!file)continue;
  if(!isOwnedObjectKey(file.object_key,owner,'artifacts'))throw new BillingError('파일을 찾을 수 없습니다.',404);
  if(!env.BUCKET)throw new Error('생성 파일 저장 서비스를 사용할 수 없습니다.');
  await env.BUCKET.delete(file.object_key);
  await sql.prepare('DELETE FROM work_artifacts WHERE id=? AND user_id=?').bind(id,owner).run();
 }
}

async function boundedBytes(response:Response){
 if(!response.body)throw new Error('생성 파일이 비어 있습니다.');
 const length=response.headers.get('content-length');
 if(length!==null&&(!/^\d+$/.test(length)||!Number.isSafeInteger(Number(length))||Number(length)>MAX_FILE_BYTES)){await response.body.cancel().catch(()=>{});throw new Error('생성 파일이 5 MB 저장 한도를 넘었습니다.');}
 const reader=response.body.getReader(),buffer=new Uint8Array(MAX_FILE_BYTES);let total=0;
 try{
  for(;;){const {done,value}=await reader.read();if(done)break;
   if(total+value.byteLength>MAX_FILE_BYTES){await reader.cancel();throw new Error('생성 파일이 5 MB 저장 한도를 넘었습니다.');}buffer.set(value,total);total+=value.byteLength;}
 }finally{reader.releaseLock();}
 if(length!==null&&Number(length)!==total)throw new Error('생성 파일 다운로드가 완료되지 않았습니다.');
 return buffer.slice(0,total);
}

export async function storeWorkArtifacts(env:Cloudflare.Env,sql:D1Database,owner:string,conversationId:string,artifacts:Artifact[],signal:AbortSignal):Promise<StoredArtifact[]> {
 if(!env.BUCKET||!env.OPENAI_API_KEY)throw new Error('생성 파일 저장 서비스를 사용할 수 없습니다.');
 const saved:StoredArtifact[]=[];
 const unique=[...new Map(artifacts.map(file=>[file.containerId+':'+file.fileId,file])).values()];
 if(unique.length>3)throw new Error('한 번에 파일 3개까지 저장할 수 있습니다. 파일 수를 줄여 다시 요청해주세요.');
 try{for(const file of unique){
  if(!/^cntr_[a-zA-Z0-9_-]{1,200}$/.test(file.containerId)||!/^cfile_[a-zA-Z0-9_-]{1,200}$/.test(file.fileId))throw new Error('생성 파일 정보를 확인하지 못했습니다.');
  const response=await fetch(`https://api.openai.com/v1/containers/${encodeURIComponent(file.containerId)}/files/${encodeURIComponent(file.fileId)}/content`,{
   headers:{Authorization:'Bearer '+env.OPENAI_API_KEY},redirect:'manual',signal});
  // Manual redirects are non-2xx: do not forward the provider credential.
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw new Error('생성 파일을 저장하지 못했습니다. 내용을 대화에 표시하도록 다시 요청해주세요.');}
  const bytes=await boundedBytes(response),id=crypto.randomUUID(),key=`${owner}/artifacts/${id}`;
  const name=safeDownloadName(file.filename,'result.bin');
  const mimeType='application/octet-stream';
  await env.BUCKET.put(key,bytes,{httpMetadata:{contentType:mimeType,contentDisposition:attachmentDisposition(name)}});
  try{
   const stored=await sql.prepare('INSERT INTO work_artifacts (id,user_id,conversation_id,name,object_key,mime_type,size,created_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT id FROM conversations WHERE id=? AND user_id=?) RETURNING id')
    .bind(id,owner,conversationId,name,key,mimeType,bytes.byteLength,Date.now(),conversationId,owner).first();
   if(!stored)throw new Error('대화를 찾을 수 없어 파일을 저장하지 않았습니다.');
  }catch(error){await env.BUCKET.delete(key);throw error;}
  saved.push({id,name,url:'/api/artifacts/'+id});
 }}catch(error){await deleteWorkArtifacts(env,sql,owner,saved.map(file=>file.id));throw error;}
 return saved;
}

export async function handleWorkArtifact(req:Request,path:string[],sql:D1Database,owner:string,env:Cloudflare.Env):Promise<Response|null>{
 if(path[0]!=='artifacts')return null;
 if(req.method!=='GET'||path.length!==2)return Response.json({error:'파일 경로를 찾을 수 없습니다.'},{status:404});
 const file=await sql.prepare('SELECT * FROM work_artifacts WHERE id=? AND user_id=?').bind(path[1],owner).first<{object_key:string;name:string;size:number}>();
 if(!file||!isOwnedObjectKey(file.object_key,owner,'artifacts'))throw new BillingError('파일을 찾을 수 없습니다.',404);
 const object=await env.BUCKET?.get(file.object_key);if(!object)throw new BillingError('파일 내용을 찾을 수 없습니다.',404);
 return new Response(object.body,{headers:{...PRIVATE_FILE_HEADERS,'Content-Type':'application/octet-stream','Content-Length':String(file.size),
  'Content-Disposition':attachmentDisposition(file.name)}});
}
