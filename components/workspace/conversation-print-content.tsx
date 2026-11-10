'use client';

import GuestMarkdown from '../guest/guest-markdown';
import type { ConversationPrintMessage } from '../../lib/print-conversation';

/** Same content elements and Markdown renderer as the on-screen transcript. */
export function ConversationPrintContent({ messages }: { messages: readonly ConversationPrintMessage[] }) {
  return <div className="messages">{messages.map((message, index) => (
    <div key={message.id ?? index} className={`message ${message.role === 'user' ? 'user' : 'assistant'}`} data-message-id={message.id}>
      <div className="message-body">
        {message.role === 'user'
          ? <p className="prism-query-text">{message.content}</p>
          : <GuestMarkdown text={message.content}/>}
      </div>
    </div>
  ))}</div>;
}
