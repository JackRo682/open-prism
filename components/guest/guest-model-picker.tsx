'use client';

import { DropdownMenu } from 'radix-ui';
import { Check, ChevronDown, LockKeyhole, UserRound } from 'lucide-react';
import './guest-model-picker.css';

type GuestModelPickerProps = {
  modelName: string;
  triggerLabel?: string;
  freeDescription?: string;
  lockedModels: readonly { id: string; name: string; description: string }[];
  open: boolean;
  onOpenChange(open: boolean): void;
  signInHref: string;
  onSignIn(): void;
  container: HTMLElement | null;
  mobile: boolean;
  empty: boolean;
};

/** Keep positioning outside the animated surface so the first visible frame is settled. */
export function GuestModelPicker({
  modelName,
  triggerLabel = modelName,
  freeDescription = '로그인 없이 체험',
  lockedModels,
  open,
  onOpenChange,
  signInHref,
  onSignIn,
  container,
  mobile,
  empty,
}: GuestModelPickerProps) {
  return <DropdownMenu.Root open={open} onOpenChange={onOpenChange} modal={false}>
    <DropdownMenu.Trigger asChild>
      <button
        type="button"
        className="pg-model-trigger pg-model-picker-trigger"
        aria-label={`모델 선택: ${modelName}`}
        data-popup-trigger
      >
        <span>{triggerLabel}</span>
        <ChevronDown size={14} aria-hidden="true"/>
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal container={container}>
      <DropdownMenu.Content
        className="pg-model-picker"
        aria-label="모델 선택"
        side={mobile || empty ? 'bottom' : 'top'}
        align={mobile ? 'start' : 'end'}
        sideOffset={8}
        collisionPadding={12}
        updatePositionStrategy="always"
        loop
      >
        <DropdownMenu.RadioGroup className="pg-model-picker-options" value={modelName}>
          <DropdownMenu.RadioItem className="pg-model-picker-item" value={modelName} textValue={modelName}>
            <Check size={20} aria-hidden="true"/>
            <span className="pg-model-picker-label"><strong>{modelName}</strong><small>{freeDescription}</small></span>
          </DropdownMenu.RadioItem>
          {lockedModels.map(model => <DropdownMenu.RadioItem
            key={model.id}
            className="pg-model-picker-item"
            value={model.id}
            textValue={model.name}
            disabled
          >
            <LockKeyhole size={18} className="pg-model-picker-lock" aria-hidden="true"/>
            <span className="pg-model-picker-label"><strong>{model.name}</strong><small>{model.description}</small></span>
          </DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
        <DropdownMenu.Item className="pg-model-picker-item pg-model-picker-signin" textValue="로그인" onSelect={onSignIn} asChild>
          <a href={signInHref} target="_top" data-prism-auth-link>
            <UserRound size={20} aria-hidden="true"/>
            <span className="pg-model-picker-label"><strong>로그인</strong><small>더 많은 이용 권한을 얻으세요</small></span>
          </a>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
