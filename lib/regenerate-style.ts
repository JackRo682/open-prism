export type RegenerateStyle = 'longer' | 'shorter' | 'no_personalization' | 'retry';

export function isRegenerateStyle(value: unknown): value is RegenerateStyle {
  return value === 'longer' || value === 'shorter' || value === 'no_personalization' || value === 'retry';
}

/** These instructions affect only the provider request, never the saved prompt. */
export function withRegenerateStyle(prompt: string, style: RegenerateStyle = 'retry'): string {
  if (style === 'longer') return prompt + '\n\nResponse revision instruction: Give a longer, more detailed answer to the same request. Expand useful explanations, concrete examples, and relevant steps. Preserve accuracy, necessary qualifications, the requested language, and the user\'s constraints. Avoid filler and repetition.';
  if (style === 'shorter') return prompt + '\n\nResponse revision instruction: Give a shorter, more concise answer to the same request. Keep the key conclusions, necessary qualifications, and actionable steps. Remove repetition and nonessential detail while preserving the requested language and the user\'s constraints.';
  return prompt;
}
