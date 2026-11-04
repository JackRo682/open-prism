'use client';

import { useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import {
  Check, ChevronRight, CircleHelp, Clock3, Diamond, Globe2, History,
  Info, Link2, MapPin, MessageSquareWarning, Monitor, Moon, ScrollText,
  Settings, Sparkles, Sun, Upload, UserRoundCog, WandSparkles,
} from 'lucide-react';
import { useWorkspaceTheme, type ThemePreference } from './theme';

export interface SettingsMenuProps {
  onNavigate: (path: string) => void;
  onHelp?: () => void;
  signedIn: boolean;
  beta?: boolean;
  triggerClassName?: string;
}

/** The reference's sidebar-anchored, viewport-aware settings menu. */
export function SettingsMenu({ onNavigate, onHelp, signedIn, beta, triggerClassName = '' }: SettingsMenuProps) {
  const { theme, setTheme } = useWorkspaceTheme();
  const [location, setLocation] = useState('기기 시간대를 사용합니다.');
  const [locating, setLocating] = useState(false);

  const detectLocation = () => {
    if (!navigator.geolocation) {
      setLocation('이 브라우저에서는 위치를 확인할 수 없습니다.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocation(`위도 ${position.coords.latitude.toFixed(2)}, 경도 ${position.coords.longitude.toFixed(2)}`);
        setLocating(false);
      },
      () => {
        setLocation('위치 권한이 없거나 위치를 확인할 수 없습니다.');
        setLocating(false);
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  };

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button className={`icon-button prism-settings-trigger ${triggerClassName}`} aria-label="설정" title="설정">
          <Settings size={18} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="prism-settings-menu"
          side="right"
          align="end"
          sideOffset={-34}
          alignOffset={27}
          collisionPadding={0}
          loop
          aria-label="설정 메뉴"
        >
          <DropdownMenu.Label className="prism-settings-label">계정</DropdownMenu.Label>
          <DropdownMenu.Item className="prism-settings-item" onSelect={() => onNavigate('/usage')}>
            <Clock3 aria-hidden="true" /><span>사용량 한도</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="prism-settings-item" onSelect={() => onNavigate('/billing')}>
            <Info aria-hidden="true" /><span>{beta ? '무료 베타 이용 안내' : '계정 및 이용 관리'}</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="prism-settings-item" onSelect={() => onNavigate('/models')}>
            <Sparkles aria-hidden="true" /><span>고급 AI 모델 살펴보기</span>
          </DropdownMenu.Item>

          <DropdownMenu.Label className="prism-settings-label">환경설정</DropdownMenu.Label>
          <DropdownMenu.Item className="prism-settings-item" onSelect={() => onNavigate('/personalization-settings')}>
            <UserRoundCog aria-hidden="true" /><span>개인 인텔리전스</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="prism-settings-item" onSelect={() => onNavigate('/customize/skills')}>
            <ScrollText aria-hidden="true" /><span>스킬</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="prism-settings-item" onSelect={() => onNavigate('/gems/view')}>
            <Diamond aria-hidden="true" /><span>Gems</span>
          </DropdownMenu.Item>
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className="prism-settings-item">
              <Sun aria-hidden="true" /><span>테마</span><ChevronRight className="prism-menu-chevron" aria-hidden="true" />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent className="prism-settings-menu prism-settings-submenu" sideOffset={-8} alignOffset={-42} collisionPadding={8} loop>
                <DropdownMenu.RadioGroup value={theme} onValueChange={(value) => setTheme(value as ThemePreference)} aria-label="테마 선택">
                  {([
                    ['system', '시스템', Monitor],
                    ['light', '밝게', Sun],
                    ['dark', '어둡게', Moon],
                  ] as const).map(([value, label, Icon]) => (
                    <DropdownMenu.RadioItem key={value} value={value} className="prism-settings-item">
                      <Icon aria-hidden="true" /><span>{label}</span>
                      <DropdownMenu.ItemIndicator className="prism-menu-check"><Check size={17} /></DropdownMenu.ItemIndicator>
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
          <DropdownMenu.Item className="prism-settings-item" onSelect={() => onNavigate('/gemini-spark')}>
            <WandSparkles aria-hidden="true" /><span>작업 설정</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="prism-settings-item" onSelect={() => onNavigate('/browser-settings')}>
            <Globe2 aria-hidden="true" /><span>브라우저</span>
          </DropdownMenu.Item>

          <DropdownMenu.Label className="prism-settings-label">데이터 및 개인 정보 보호</DropdownMenu.Label>
          <DropdownMenu.Item className="prism-settings-item" onSelect={() => onNavigate('/import')}>
            <Upload aria-hidden="true" /><span>Prism으로 메모리 가져오기</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="prism-settings-item" onSelect={() => onNavigate('/sharing')}>
            <Link2 aria-hidden="true" /><span>내 공개 링크</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="prism-settings-item" onSelect={() => onNavigate('/feedback')}>
            <MessageSquareWarning aria-hidden="true" /><span>의견 보내기</span>
          </DropdownMenu.Item>
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className="prism-settings-item">
              <CircleHelp aria-hidden="true" /><span>도움말</span><ChevronRight className="prism-menu-chevron" aria-hidden="true" />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent className="prism-settings-menu prism-settings-submenu" sideOffset={-8} collisionPadding={8} loop>
                <DropdownMenu.Item className="prism-settings-item" onSelect={() => onHelp ? onHelp() : onNavigate('/faq')}>
                  <CircleHelp aria-hidden="true" /><span>도움말 센터</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item className="prism-settings-item" onSelect={() => onNavigate('/privacy')}>
                  <Info aria-hidden="true" /><span>개인정보처리방침</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item className="prism-settings-item" onSelect={() => onNavigate('/terms')}>
                  <ScrollText aria-hidden="true" /><span>서비스 약관</span>
                </DropdownMenu.Item>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className="prism-settings-item">
              <MapPin aria-hidden="true" /><span>위치</span><ChevronRight className="prism-menu-chevron" aria-hidden="true" />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent className="prism-settings-menu prism-settings-submenu" sideOffset={-8} collisionPadding={8}>
                <div className="prism-location-note" aria-live="polite">
                  <strong>{typeof window === 'undefined' ? '기기 위치' : Intl.DateTimeFormat().resolvedOptions().timeZone}</strong>
                  <span>{location}</span>
                  <small>위치는 이 화면에서만 표시되며 AI에 전달되지 않습니다.</small>
                </div>
                <DropdownMenu.Item className="prism-settings-item" disabled={locating} onSelect={(event) => { event.preventDefault(); detectLocation(); }}>
                  <MapPin aria-hidden="true" /><span>{locating ? '위치 확인 중…' : '기기 위치 확인'}</span>
                </DropdownMenu.Item>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
          <DropdownMenu.Item className="prism-settings-item" onSelect={() => onNavigate(signedIn ? '/history' : '/settings')}>
            <History aria-hidden="true" /><span>활동</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
