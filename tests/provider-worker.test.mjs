import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(await realpath(new URL('../node_modules/wrangler/package.json', import.meta.url)));
const { Miniflare } = await import(pathToFileURL(require.resolve('miniflare')).href);
const { build } = await import(pathToFileURL(require.resolve('esbuild')).href);
const bundle = await build({
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022',
  stdin: {
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts',
    contents: `
      import { MODELS } from './lib/models.ts';
      import { invokeProvider } from './lib/provider.ts';
      import { generateImage, createVideo, pollVideo, generateMusic } from './lib/media-provider.ts';
      export default { async fetch(request) {
        const { provider, media } = await request.json();
        const signal = new AbortController().signal;
        const env = { OPENAI_API_KEY: 'fixture-provider-key', GEMINI_API_KEY: 'fixture-provider-key' };
        try {
          if (media) {
            const input = { prompt: 'Fixture request' };
            const result = media === 'image' ? await generateImage(env, input, signal)
              : media === 'video' ? await createVideo(env, input, signal)
              : media === 'poll' ? await pollVideo(env, { provider: 'google', model: 'gemini-omni-1.1-flash', fileName: 'files/fixture-video' }, signal)
              : await generateMusic(env, input, signal);
            return Response.json({ result });
          }
          let text = '';
          const usage = await invokeProvider(MODELS.find(model => model.provider === provider),
            'fixture-provider-key', [{ role: 'user', content: 'Fixture request' }], 'medium', false,
            signal, chunk => { text += chunk; }, 1024);
          return Response.json({ text, usage });
        } catch (error) {
          return Response.json({ error: error.message, code: error.code }, { status: 502 });
        }
      } };
    `,
  },
});
let redirect = false;
const calls = [];
const frame = events => events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('');
const worker = new Miniflare({
  modules: true, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'],
  script: bundle.outputFiles[0].text,
  // Every upstream call stays in the fixture; no external provider is contacted.
  outboundService: async request => {
    const hostname = new URL(request.url).hostname;
    calls.push(hostname);
    if (redirect) return new Response('private-provider-error fixture-provider-key', {
      status: 307, headers: { Location: 'https://credential-leak.test/collect' },
    });
    const events = hostname === 'api.openai.com' ? [
      { type: 'response.output_text.delta', delta: 'Fixture answer' },
      { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 20 } } },
    ] : hostname === 'api.anthropic.com' ? [
      { type: 'message_start', message: { usage: { input_tokens: 12 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Fixture answer' } },
      { type: 'message_delta', usage: { output_tokens: 20 }, delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ] : [
      { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'Fixture answer' } },
      { event_type: 'interaction.completed', interaction: { status: 'completed', usage: { total_input_tokens: 12, total_output_tokens: 20 } } },
    ];
    return new Response(frame(events), { headers: { 'Content-Type': 'text/event-stream' } });
  },
});
after(() => worker.dispose());
const invoke = body => worker.dispatchFetch('https://prism.test/fixture', {
  method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
});

test('all text adapters complete through native Workerd fetch', async () => {
  redirect = false;
  for (const provider of ['openai', 'anthropic', 'google']) {
    calls.length = 0;
    const response = await invoke({ provider });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.text, 'Fixture answer');
    assert.equal(result.usage.input, 12);
    assert.equal(result.usage.output, 20);
    assert.equal(calls.length, 1);
  }
});

test('native Workerd rejects text and media redirects without forwarding credentials or exposing upstream bodies', async () => {
  redirect = true;
  for (const input of [
    ...['openai', 'anthropic', 'google'].map(provider => ({ provider })),
    ...['image', 'video', 'poll', 'music'].map(media => ({ media })),
  ]) {
    calls.length = 0;
    const response = await invoke(input);
    assert.equal(response.status, 502);
    assert.equal(calls.length, 1, JSON.stringify(input));
    assert.ok(['api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com'].includes(calls[0]));
    assert.doesNotMatch(await response.text(), /private-provider-error|fixture-provider-key|credential-leak/);
  }
});
