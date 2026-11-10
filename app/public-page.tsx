import type { ReactNode } from 'react';
import { env } from 'cloudflare:workers';
import { notFound } from 'next/navigation';
import { chatGPTSignInPath } from './chatgpt-auth';
import { readPublicShare } from '../lib/public-shares';

export function PublicShell({ children, signedIn = false }: { children: ReactNode; signedIn?: boolean }) {
  return <div className="prism-public-shell">
    <header><a className="prism-public-brand" href={signedIn ? '/chat' : '/'}>Prism</a>
      <a className="prism-public-signin" href={signedIn ? '/chat' : chatGPTSignInPath('/chat')} target={signedIn ? undefined : '_top'}>{signedIn ? '워크스페이스' : '로그인'}</a>
    </header>
    <main>{children}</main>
    <footer><a href="/">홈</a><a href="/privacy">개인정보</a><a href="/terms">이용 안내</a><a href="/faq">도움말</a></footer>
  </div>;
}

const information = {
  about: {
    title: 'OpenPrism',
    intro: '질문에서 작업까지, 하나의 AI 워크스페이스에서.',
    sections: [
      ['바로 시작하는 대화', '로그인하기 전에 텍스트 질문으로 OpenPrism을 체험할 수 있습니다. 현재 연결된 모델과 이용 한도는 입력창에서 확인할 수 있습니다.'],
      ['나만의 워크스페이스', '로그인하면 대화 기록, 파일, 모델과 작업 설정을 한곳에서 관리할 수 있습니다. 제공되는 모델과 도구는 실제 연결 상태에 따라 달라집니다.'],
      ['내가 선택하는 저장', '게스트 대화는 이 탭에 임시로 보관됩니다. 로그인한 뒤 저장을 선택하면 완성된 대화를 계정의 기록으로 옮겨 이어갈 수 있습니다.'],
      ['독립적인 서비스', 'OpenPrism은 연결된 AI 제공사의 API를 사용하는 독립적인 서비스입니다. 로그인에는 이 사이트에 연결된 ChatGPT 인증을 사용하며, 다른 AI 서비스의 소비자 구독은 이전되지 않습니다.'],
    ],
  },
  privacy: {
    title: 'Prism에서의 데이터',
    intro: '로그인 전 체험과 로그인 후 저장되는 정보에 대해 안내합니다.',
    sections: [
      ['로그인 전 대화', '게스트 대화 내용은 이 브라우저 탭의 임시 저장소에 보관되며, 최대 1시간 동안 복원할 수 있습니다. 새 채팅으로 지우거나 로그인 후 저장 여부를 선택할 수 있습니다. 게스트 대화 내용은 Prism의 대화 데이터베이스에 자동 저장되지 않습니다.'],
      ['AI 제공사로 전송되는 내용', '질문을 보내면 해당 질문과 제한된 이전 대화가 OpenAI API로 전송됩니다. 로그인 후에는 선택한 모델의 제공사로 대화와 선택한 첨부 자료가 전송됩니다. 각 제공사의 데이터 처리 조건이 적용됩니다.'],
      ['게스트 이용 한도', '서버는 보안 쿠키와 네트워크 식별자의 해시, 요청 시각·상태·사용량을 이용해 체험 한도와 동시 요청 수를 관리합니다. 원본 네트워크 주소와 게스트 대화 내용은 이 이용 기록에 저장하지 않습니다. 쿠키는 AI 제공사의 API 키를 포함하지 않습니다.'],
      ['로그인 후 저장되는 정보', '인증된 계정의 식별자, 저장한 대화, 업로드한 파일, 설정, 제공사가 보고한 사용량이 보관됩니다. 로그인 전 대화는 별도로 저장을 선택한 경우에만 계정의 기록으로 옮겨집니다. API 키는 서버에서만 사용됩니다.'],
      ['대화 공개 링크', '대화는 직접 공유하기 전까지 내 계정에서만 볼 수 있습니다. 공개 미리보기를 확인하고 동의하면 링크를 가진 누구나 로그인 없이 해당 시점의 대화 사본을 읽을 수 있습니다. 첨부 파일 원문은 제외되지만 메시지에 작성하거나 AI가 인용한 내용은 포함됩니다. 새 링크는 기본 7일 후 만료되며 1일, 30일 또는 만료 없음을 직접 선택할 수 있습니다. 기존 링크의 만료 설정은 유지됩니다. 내 공개 링크에서 만료를 지정하거나 공유를 취소할 수 있으며 이미 복사하거나 저장한 내용은 회수할 수 없습니다.'],
      ['결제와 동의 기록', '크레딧 충전 시 주문, 결제 상태, 동의한 정책 버전과 당시 정책 내용, 환불 및 잔액 변동 내역이 계정에 연결되어 저장됩니다. 결제 인증은 토스페이먼츠와 결제수단 제공사가 처리하며, Prism은 카드번호와 카드 비밀번호를 직접 수집하지 않습니다.'],
      ['기록 삭제', '로그인 후 채팅 기록과 파일에서 개별 항목을 삭제할 수 있습니다. 설정의 전체 삭제는 대화·파일·관련 설정을 지우며, 운영 및 이용 한도에 필요한 사용량 기록은 남습니다. 이는 ChatGPT 계정을 삭제하는 기능이 아닙니다.'],
    ],
  },
  terms: {
    title: 'Prism 이용 안내',
    intro: 'Prism은 여러 AI API를 이용하는 독립적인 워크스페이스입니다.',
    sections: [
      ['독립적인 서비스', 'Prism은 ChatGPT, Claude 또는 Gemini 소비자 앱 자체가 아닙니다. 다른 서비스의 구독이나 전용 기능이 Prism으로 이전되지 않습니다. 로그인은 이 사이트에 연결된 ChatGPT 인증 절차를 사용합니다.'],
      ['로그인 전 체험', '게스트는 제한된 모델로 텍스트 대화를 체험할 수 있습니다. 브라우저별 하루 요청 한도, 네트워크 한도, 사이트 전체 한도가 함께 적용됩니다. 중지되거나 실패한 요청도 제공사 사용량이 발생할 수 있어 체험 한도에 포함될 수 있습니다.'],
      ['로그인 후 기능', '로그인하면 기존 워크스페이스에서 대화 기록과 파일, 설정을 관리할 수 있습니다. 각 모델과 도구는 실제 연결 상태와 제공사 계정의 사용 권한에 따라 제공됩니다.'],
      ['크레딧 충전', '업그레이드 화면에서 일회성 선불 크레딧 상품을 선택하고 구매 조건을 확인할 수 있습니다. 자동 구독은 없습니다. 판매가 활성화된 경우에만 결제를 진행하며, 테스트 잔액은 실제 AI 사용에 쓸 수 없습니다. 환불 기준, 유효기간, 적용 단가와 판매자 정보는 구매 시 표시되는 조건을 확인하세요.'],
      ['결과 확인', 'AI 응답에는 오류가 있을 수 있습니다. 중요한 결정에 이용하기 전에 내용을 확인하세요. 제공사 이용 조건과 관련 규정을 준수해야 합니다.'],
      ['운영 상태', '무료 체험에는 서버에서 적용하는 이용 한도가 있습니다. 연결되지 않은 기능은 이용할 수 없으며, 실제 AI 응답 대신 미리 만든 답변을 보여주지 않습니다.'],
    ],
  },
  faq: {
    title: '무엇이 궁금하신가요?',
    intro: '로그인 전 체험부터 저장한 대화까지.',
    sections: [
      ['로그인 없이 질문할 수 있나요?', '네. 홈에서 텍스트 질문을 보내면 실제 연결된 AI 모델이 답합니다. 입력창의 모델 이름과 이용 한도 안내를 확인하세요. 파일, 계정 설정과 저장된 대화에는 로그인이 필요합니다.'],
      ['새 채팅을 누르면 어떻게 되나요?', '대화가 없거나 응답을 생성하는 중에는 새 채팅이 비활성화됩니다. 대화가 끝난 후에는 확인 창에서 새 채팅을 선택하면 현재 게스트 대화가 지워집니다. 취소를 선택하면 그대로 유지됩니다.'],
      ['로그인 후 현재 대화를 이어갈 수 있나요?', '로그인 전에 입력하던 초안은 복원됩니다. 완성된 게스트 대화가 있으면 로그인한 워크스페이스에서 저장 여부를 선택할 수 있습니다. 저장을 선택하기 전에는 계정의 대화 기록에 추가되지 않습니다.'],
      ['어떤 계정으로 로그인하나요?', '로그인 버튼은 실제 ChatGPT 인증 화면으로 연결됩니다. 계정 선택, 비밀번호와 추가 인증은 해당 제공사의 화면에서 진행합니다. 로그인 후 Prism의 기존 워크스페이스로 돌아옵니다.'],
      ['모바일에서는 무엇이 다른가요?', '모델 선택은 화면 위쪽에 있고, 왼쪽 메뉴는 서랍 형태로 열립니다. 입력창은 화면 아래에 유지됩니다. Enter로 전송하고 Shift+Enter로 줄바꿈할 수 있으며, 한국어 입력 조합 중의 Enter는 전송하지 않습니다.'],
      ['충전은 어떻게 하나요?', '로그인한 워크스페이스의 설정에서 업그레이드를 선택하면 별도 탭이 열립니다. 상품과 약관을 확인한 뒤 결제가 활성화된 경우 토스페이먼츠로 진행합니다. 충전 및 이용 내역에서 완료 상태와 잔액을 확인할 수 있습니다.'],
      ['앱을 어떻게 설치하나요?', '지원되는 브라우저에서는 설치 안내에서 앱 추가를 선택할 수 있습니다. 설치 버튼이 제공되지 않으면 브라우저 메뉴의 앱 설치 또는 홈 화면에 추가 기능을 이용하세요. 별도의 네이티브 앱 다운로드는 제공하지 않습니다.'],
      ['공유한 대화를 다시 비공개로 바꿀 수 있나요?', '내 공개 링크에서 공유를 취소하면 해당 링크는 즉시 더 이상 열리지 않습니다. 새 링크는 기본 7일 후 만료되며, 기존에 자동 만료가 없던 링크에도 만료 기간을 지정할 수 있습니다. 만료된 링크는 다시 활성화하지 않고 대화 내용을 다시 확인한 후 새 링크를 만듭니다. 상대방이 이미 복사하거나 저장한 내용까지 지울 수는 없습니다.'],
      ['왜 한도 또는 연결 오류가 표시되나요?', '게스트 요청은 브라우저, 네트워크와 사이트 전체 이용 한도에 따라 제한됩니다. 제공사 연결이나 사용량 문제도 오류로 안내합니다. 임의의 응답을 만들지 않으며, 로그인해도 제공사 연결 자체의 문제가 자동으로 해결되지는 않습니다.'],
    ],
  },
} as const;

export default function PublicPage({ page }: { page: keyof typeof information }) {
  const content = information[page];
  return <PublicShell><h1>{content.title}</h1><p className="prism-public-intro">{content.intro}</p>
    {content.sections.map(([heading, text]) => <section key={heading}><h2>{heading}</h2><p>{text}</p></section>)}
  </PublicShell>;
}

export async function PublicSharePage({ token, signedIn }: { token: string; signedIn: boolean }) {
  if (!/^[a-f0-9]{64}$/.test(token)) notFound();
  let shared: Awaited<ReturnType<typeof readPublicShare>> = null;
  try {
    shared = env.DB ? await readPublicShare(env.DB, token) : null;
  } catch {
    return <PublicShell signedIn={signedIn}><h1>대화를 불러오지 못했습니다.</h1><p>잠시 후 페이지를 새로고침해 주세요.</p></PublicShell>;
  }
  if (!shared) notFound();
  return <PublicShell signedIn={signedIn}><p className="prism-public-intro">공유된 대화 · 공유 시점의 사본입니다.</p><h1>{shared.title}</h1>
    {shared.expires_at !== null && <p>이 링크는 <time dateTime={new Date(shared.expires_at).toISOString()}>{new Date(shared.expires_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (한국 시간)</time>에 만료됩니다.</p>}
    {shared.messages.map((message, index) => <section className={'prism-public-message ' + (message.role === 'user' ? 'is-user' : '')} key={index}>
      <h2>{message.role === 'user' ? '질문' : 'Prism'}</h2><div>{message.content}</div>
    </section>)}
  </PublicShell>;
}
