'use client';
import { useEffect, useState } from 'react';
import { MODELS } from '../lib/models';

const won=(n:number)=>new Intl.NumberFormat('ko-KR',{maximumFractionDigits:6}).format(n)+'원';
async function call(path:string,body?:unknown,method='POST') {
 const r=await fetch('/api/'+path,body?{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);
 const data:any=await r.json();if(!r.ok)throw new Error(data.error||'요청을 완료하지 못했습니다.');return data;
}
declare global { interface Window { TossPayments?: (key:string)=>{payment:(v:{customerKey:string})=>{requestPayment:(v:unknown)=>Promise<void>}} } }
let sdk:Promise<void>|undefined;
function loadToss(){return sdk||=new Promise<void>((resolve,reject)=>{
 if(window.TossPayments){resolve();return;}
 const s=document.createElement('script');s.src='https://js.tosspayments.com/v2/standard';s.onload=()=>resolve();s.onerror=()=>{sdk=undefined;s.remove();reject(new Error('결제창을 불러오지 못했습니다.'));};document.head.appendChild(s);
});}

export default function BillingPanel({admin=false}:{admin?:boolean}) {
 const [data,setData]=useState<any>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[config,setConfig]=useState<any>(null);
 async function refresh(){setData(await call('billing'));if(admin){const r=await call('admin/billing');setConfig(r.config);}}
 useEffect(()=>{let active=true;(async()=>{
  try{
   const q=new URLSearchParams(window.location.search);
   if(window.location.pathname==='/billing/success'){
    setBusy(true);
    await call('payments/confirm',{paymentKey:q.get('paymentKey'),orderId:q.get('orderId'),amount:Number(q.get('amount'))});
    if(active){setNotice('결제 확인이 완료되었습니다. 중복 확인으로 잔액이 두 번 늘어나지 않습니다.');window.history.replaceState(null,'','/billing');}
   }else if(window.location.pathname==='/billing/fail')setError('결제가 완료되지 않았습니다. 충전 내역을 확인하고 다시 시도하세요.');
   if(active)await refresh();
  }catch(e){if(active)setError((e as Error).message);}finally{if(active)setBusy(false);}
 })();return()=>{active=false;};},[admin]);
 async function checkout(amount:number){setBusy(true);setError('');try{
  const order=await call('payments/orders',{amount});await loadToss();
  if(!window.TossPayments)throw new Error('결제창을 불러오지 못했습니다.');
  await window.TossPayments(order.clientKey).payment({customerKey:order.customerKey}).requestPayment({method:'CARD',amount:{currency:'KRW',value:order.amount},orderId:order.orderId,orderName:'Open Prism '+won(amount)+' 충전',successUrl:location.origin+'/billing/success',failUrl:location.origin+'/billing/fail'});
 }catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <div className="page-inner billing-panel">
  <div className="page-heading"><span className="eyebrow">PREPAID AI WORKSPACE</span><h1>필요한 만큼 충전하고 사용하세요.</h1><p>월 구독 없이 1만·3만·5만원을 충전하고, 모델별 실제 사용량에 따라 잔액을 차감합니다.</p></div>
  {error&&<div className="error-banner" role="alert">{error}</div>}{notice&&<p role="status">{notice}</p>}
  {!data?(error?<p><a className="primary-button" href="/signin-with-chatgpt?return_to=%2Fbilling" target="_top">로그인하고 충전 내역 보기</a></p>:<p role="status">충전 정보를 확인하고 있습니다.</p>):<>
   <div className="stats-grid"><div className="stat-card"><div>사용 가능 잔액</div><strong>{won(data.balance/1e6)}</strong><small>진행 중인 요청의 예약금 제외</small></div><div className="stat-card"><div>충전 단위</div><strong>1만 · 3만 · 5만원</strong><small>자동 갱신·월 구독 없음</small></div><div className="stat-card"><div>결제 상태</div><strong>{data.mode==='disabled'?'준비 중':data.mode==='test'?'테스트':'실결제'}</strong><small>{data.mode==='test'?'테스트 잔액 '+won(data.testBalance/1e6)+' · 실제 AI 사용 불가':'차감 단가·출시 정책 확정 후 결제 활성화'}</small></div></div>
   <div className="model-grid">{data.topUps.map((amount:number)=><article className="model-card" key={amount}><h3>{won(amount)}</h3><p>{data.mode==='test'?'실제 금액이 청구되지 않는 테스트 결제입니다.':'선택한 금액만 충전합니다. 자동 결제는 없습니다.'}</p><button className="primary-button" disabled={busy||data.mode==='disabled'} onClick={()=>checkout(amount)}>{data.mode==='disabled'?'충전 준비 중':data.mode==='test'?'테스트 충전':'충전하기'}</button></article>)}</div>
   {data.blockers.length>0&&<section className="data-panel"><h2>출시 준비 현황</h2><ul>{data.blockers.map((b:string)=><li key={b}>{b}</li>)}</ul><p>위 항목과 결제 연결이 완료되기 전에는 실결제가 열리지 않습니다.</p></section>}
   <section className="data-panel"><h2>모델별 차감 단가</h2><p>단위: 100만 토큰당 원. 비교 응답은 선택한 모델마다 각각 차감합니다.</p>{Object.keys(data.rates).length?<div className="table-scroll"><table><thead><tr><th>모델</th><th>입력</th><th>출력·추론</th></tr></thead><tbody>{Object.entries(data.rates).map(([id,r]:any)=><tr key={id}><td>{MODELS.find(m=>m.id===id)?.name||id}</td><td>{won(r.input)}</td><td>{won(r.output)}</td></tr>)}</tbody></table></div>:<p>차감 단가가 미정입니다. 단가가 없는 모델의 유료 요청은 차단됩니다.</p>}<p>각 요청 전 최대 사용 비용을 예약하고, 확인된 사용량으로 정산한 차액을 돌려드립니다. 중단·오류로 사용량이 불확실하면 확인 전까지 예약금을 보류합니다. Pro 모드는 별도 단가 확정 전까지 비활성화됩니다.</p></section>
   <section className="data-panel"><h2>충전 내역</h2><div className="table-scroll"><table><thead><tr><th>날짜</th><th>금액</th><th>구분</th><th>상태</th></tr></thead><tbody>{data.payments.map((p:any)=><tr key={p.id}><td>{new Date(p.created_at).toLocaleString('ko-KR')}</td><td>{won(p.amount)}</td><td>{p.mode==='test'?'테스트':'실결제'}</td><td>{p.status==='paid'?'충전 완료':p.status==='review'?'정산 확인 필요':'결제 대기'}</td></tr>)}</tbody></table>{!data.payments.length&&<p>충전 내역이 없습니다.</p>}</div></section>
   <section className="data-panel"><h2>잔액 변동 내역</h2><div className="table-scroll"><table><thead><tr><th>날짜</th><th>내용</th><th>구분</th><th>변동 금액</th></tr></thead><tbody>{data.events.map((e:any)=><tr key={e.reference}><td>{new Date(e.created_at).toLocaleString('ko-KR')}</td><td>{({topup:'충전',reserve:'요청 비용 예약',settle:'예약 차액 정산'} as Record<string,string>)[e.kind]||e.kind}</td><td>{e.mode==='test'?'테스트':'실결제'}</td><td>{won(e.amount/1e6)}</td></tr>)}</tbody></table>{!data.events.length&&<p>잔액 변동이 없습니다.</p>}</div></section>
   <section className="data-panel"><h2>환불 및 유효기간</h2><p>{data.refundPolicy||'환불 기준 미정 — 충전 판매가 시작되지 않았습니다.'}</p><p>{data.validityPolicy||'유효기간 미정 — 확정 전 충전 판매가 시작되지 않습니다.'}</p></section>
   <section className="data-panel"><h2>판매자 정보</h2><p>{data.business.name} · 대표자 {data.business.representative}</p><p>사업자등록번호: {data.business.registrationNumber||'미등록'}</p><p>사업장 주소: {data.business.address||'미등록'}</p><p>고객지원: {data.business.supportEmail||'미등록'}</p></section>
  </>}
  {admin&&config&&<section className="data-panel"><h2>출시 설정</h2><p>저장만으로 실결제가 켜지지 않습니다. 운영 환경의 별도 출시 설정과 결제키가 필요합니다.</p><form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await call('admin/billing',config);await refresh();setNotice('설정을 저장했습니다.');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>
   {(['registrationNumber','address','supportEmail','refundPolicy','validityPolicy'] as const).map((key,i)=><label className="billing-field" key={key}>{['사업자등록번호','사업장 주소','고객지원 이메일','환불 기준','충전금 유효기간'][i]}<input value={config[key]} maxLength={4000} onChange={e=>setConfig({...config,[key]:e.target.value})}/></label>)}
   <h3>모델별 단가 (100만 토큰당 원)</h3>{MODELS.map(m=><div className="billing-rate" key={m.id}><span>{m.name}</span>{(['input','output'] as const).map((k,i)=><label key={k}>{i?'출력':'입력'}<input type="number" min="1" max="1000000" step="1" value={config.rates[m.id]?.[k]??''} onChange={e=>{const rates={...config.rates};const value=Number(e.target.value);if(e.target.value===''){delete rates[m.id];}else rates[m.id]={input:rates[m.id]?.input||value,output:rates[m.id]?.output||value,[k]:value};setConfig({...config,rates});}}/></label>)}</div>)}
   <button className="primary-button" disabled={busy}>설정 저장</button>
  </form></section>}
 </div>;
}
