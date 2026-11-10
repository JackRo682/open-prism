export type ExportMessage = { role: string; content: string; prompt_text?: string };

export function conversationMarkdown(title: string, messages: ExportMessage[]): string {
  return '# ' + title.replace(/[\r\n]+/g, ' ') + '\n\n' + messages
    .filter(message => message.content.trim())
    .map(message => '## ' + (message.role === 'user' ? '나' : 'Prism') + '\n\n' + (message.role === 'user' ? message.prompt_text ?? message.content : message.content))
    .join('\n\n---\n\n');
}

/** Only the explicit Gmail action sends this text to Gmail's draft composer. */
export function gmailComposeUrl(title: string, content: string): string {
  const url = new URL('https://mail.google.com/mail/');
  url.searchParams.set('view', 'cm');
  url.searchParams.set('fs', '1');
  url.searchParams.set('su', title.slice(0, 200));
  url.searchParams.set('body', content);
  return url.href;
}
