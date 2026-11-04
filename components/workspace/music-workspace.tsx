'use client';
import {useState} from 'react';
import {Music2,LoaderCircle,Download} from 'lucide-react';

export function MusicWorkspace({configured,signedIn,busy,assets,onGenerate,onNavigate}:{
 configured:boolean;signedIn:boolean;busy:boolean;assets:Array<{id:string;url:string;prompt:string}>;
 onGenerate(prompt:string):Promise<void>;onNavigate(path:string):void;
}){
 const [prompt,setPrompt]=useState('');
 return <section className="prism-settings-page prism-music-page"><header className="prism-settings-page-head"><h1>음악</h1><p>장르, 분위기, 악기와 원하는 가사를 설명하세요.</p></header>
  <form className="prism-setting-card" onSubmit={event=>{event.preventDefault();void onGenerate(prompt);}}>
   <Music2 size={30}/><label className="prism-settings-field" htmlFor="music-prompt">어떤 음악을 만들까요?<textarea id="music-prompt" value={prompt} maxLength={2000} onChange={event=>setPrompt(event.target.value)} disabled={busy} placeholder="부드러운 피아노와 빗소리, 차분한 분위기의 짧은 연주곡"/></label>
   {configured?<button className="prism-action-button primary" disabled={busy||!prompt.trim()||!signedIn}>{busy?<><LoaderCircle className="spin" size={17}/>음악 생성 중…</>:'음악 만들기'}</button>:<p>음악 생성 서비스를 연결하면 이곳에서 실제 음악을 생성하고 저장할 수 있습니다. <button type="button" className="text-button" onClick={()=>onNavigate('/settings')}>연결 상태 확인</button></p>}
   {!signedIn&&<p><a href="/signin-with-chatgpt?return_to=%2Fmusic" target="_top" data-prism-auth-link>로그인</a>하고 음악을 저장하세요.</p>}
  </form>
  {assets.map(asset=><section key={asset.id} className="prism-setting-card"><h2>{asset.prompt}</h2><audio controls preload="metadata" src={asset.url} aria-label={asset.prompt}/><a href={asset.url} download className="prism-action-button"><Download size={16}/>음악 다운로드</a></section>)}
 </section>;
}
