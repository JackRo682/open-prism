import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import ts from 'typescript';

const directory = new URL('../.sites-runtime/provider-feature-tests/', import.meta.url);
await mkdir(directory, { recursive: true });
for (const name of ['models', 'provider', 'workspace-tools', 'media-provider', 'upload-security']) {
  const source = (await readFile(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8'))
    .replaceAll("'./models'", "'./models.mjs'")
    .replaceAll("'./workspace-tools'", "'./workspace-tools.mjs'")
    .replaceAll("'./upload-security'", "'./upload-security.mjs'");
  await writeFile(new URL(name + '.mjs', directory), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
}
const { MODELS } = await import(new URL('models.mjs', directory).href);
const { invokeProvider, formatWebResponse } = await import(new URL('provider.mjs', directory).href);
const { getWorkspaceCapabilities, validateToolRequest, withToolContext, betaDailyLimit } = await import(new URL('workspace-tools.mjs', directory).href);
const { generateImage, generateMusic, createVideo, pollVideo, downloadVideo, referenceDimensions, mediaModel } = await import(new URL('media-provider.mjs', directory).href);
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });
const signal = () => new AbortController().signal;
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'));
const mp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
const mp3 = new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]);
const encode = bytes => Buffer.from(bytes).toString('base64');
const sse = events => new Response(events.map(event => 'data:' + JSON.stringify(event) + '\r\n\r\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });

test('capabilities are configuration-driven; missing Google key never advertises video or music', () => {
  assert.deepEqual(getWorkspaceCapabilities({}), { webResearch: false, image: false, video: false, music: false, remoteBrowser: false });
  const capabilities = getWorkspaceCapabilities({ BETA_MODE:'true', OPENAI_API_KEY: 'test-key' });
  assert.equal(capabilities.webResearch, true);
  assert.equal(capabilities.image, true);
  assert.equal(capabilities.video, false);
  assert.equal(capabilities.music, false);
  assert.equal(getWorkspaceCapabilities({ BETA_MODE:'true',OPENAI_API_KEY: 'test-key', IMAGE_GENERATION_ENABLED: 'false' }).image, false);
  assert.equal(getWorkspaceCapabilities({ BETA_MODE:'true',GEMINI_API_KEY: 'test-key' }).music, true);
  assert.equal(getWorkspaceCapabilities({ BETA_MODE:'true',GEMINI_API_KEY: 'test-key' }).video, false,'video cannot be advertised while its reservation exceeds the unchanged daily cap');
  assert.equal(getWorkspaceCapabilities({BETA_MODE:'true',GEMINI_API_KEY:'test-key',BETA_USER_DAILY_LIMIT_MICROS:'1500000'}).video,true);
  assert.deepEqual(getWorkspaceCapabilities({OPENAI_API_KEY:'test-key',GEMINI_API_KEY:'test-key'}),getWorkspaceCapabilities({}),'keys alone do not supply approved commercial tariffs');
  assert.deepEqual(validateToolRequest({ tool: 'research' }, capabilities), { tool: 'research', researchSources: { web: true } });
  assert.equal(validateToolRequest({ tool: 'image' }, capabilities).tool, 'image');
  assert.throws(() => validateToolRequest({ tool: 'video' }, capabilities), error => error.code === 'VIDEO_GENERATION_NOT_CONFIGURED');
  assert.match(withToolContext('Question', 'research', { web: true }), /live web_search/);
  assert.match(withToolContext('Question', 'research', { web: false }), /NO web search/);
});

test('approved daily budget settings use strict bounded integers and preserve the existing default',()=>{
  assert.equal(betaDailyLimit({}),200000);
  for(const raw of ['-1','+1','1.5','1e6',' 1500000 ','Infinity','NaN','01','9007199254740992'])assert.equal(betaDailyLimit({BETA_USER_DAILY_LIMIT_MICROS:raw}),200000);
  assert.equal(betaDailyLimit({BETA_USER_DAILY_LIMIT_MICROS:'0'}),0);
  assert.equal(betaDailyLimit({BETA_USER_DAILY_LIMIT_MICROS:'1500000'}),1500000);
  assert.equal(betaDailyLimit({BETA_USER_DAILY_LIMIT_MICROS:'999999999'}),20000000);
  assert.equal(getWorkspaceCapabilities({BETA_MODE:'true',OPENAI_API_KEY:'test-key',GEMINI_API_KEY:'test-key',BETA_USER_DAILY_LIMIT_MICROS:'0'}).image,false);
});

test('real web-search configuration counts only searches and saves inline citation links', async () => {
  const text = 'The result is verified.\uE200cite\uE202turn0search0\uE201';
  const citation = { type: 'url_citation', url: 'https://example.org/research(a)', title: 'Research [source]', start_index: 23, end_index: text.length };
  const output = [
    { type: 'web_search_call', id: 'ws1', action: { type: 'search', sources: [{ url: citation.url, title: citation.title }] } },
    { type: 'web_search_call', id: 'ws2', action: { type: 'open_page', url: citation.url } },
    { type: 'message', content: [{ type: 'output_text', text, annotations: [citation] }] },
  ];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.tools, [{ type: 'web_search', external_web_access: true, search_context_size: 'low' }]);
    assert.equal(body.tool_choice, 'required');
    assert.equal(body.max_tool_calls, 2);
    assert.equal(body.store, false);
    assert.deepEqual(body.include, ['web_search_call.action.sources']);
    return sse([{ type: 'response.output_text.delta', delta: text }, { type: 'response.completed', response: { output, usage: { input_tokens: 90, output_tokens: 20 } } }]);
  };
  let streamed = '', sources;
  const usage = await invokeProvider(MODELS[0], 'test-key', [{ role: 'user', content: 'Verify this' }], 'low', false, signal(), delta => { streamed += delta; }, 1024, {
    webSearch: true, maxToolCalls: 2, onTextReplace: text => { streamed = text; }, onSources: value => { sources = value; },
  });
  assert.match(streamed, /The result is verified\./);
  assert.match(streamed, /\[Research source\]\(https:\/\/example\.org\/research%28a%29\)/);
  assert.doesNotMatch(streamed, /\uE200cite/);
  assert.equal(usage.webSearchCalls, 1);
  assert.equal(usage.input, 90);
  assert.equal(sources.length, 1);
  assert.deepEqual(usage.sources, sources);
});

test('citation parser rejects unsafe URLs without discarding the answer', () => {
  const result = formatWebResponse([{ type: 'message', content: [{ type: 'output_text', text: 'A claim.', annotations: [
    { type: 'url_citation', url: 'javascript:alert(1)', title: 'Bad', start_index: 0, end_index: 8 },
    { type: 'url_citation', url: 'https://user:secret@example.org', title: 'Bad', start_index: 0, end_index: 8 },
  ] }] }]);
  assert.equal(result.text, 'A claim.');
  assert.deepEqual(result.sources, []);
});

test('web request cannot silently become ungrounded chat or run on unsupported adapters', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return sse([{ type: 'response.output_text.delta', delta: 'No search happened' }, { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 }, output: [] } }]); };
  await assert.rejects(invokeProvider(MODELS[0], 'test-key', [{ role: 'user', content: 'Research' }], 'low', false, signal(), () => {}, 1024, { webSearch: true }), /검색 결과/);
  await assert.rejects(invokeProvider(MODELS[1], 'test-key', [{ role: 'user', content: 'Research' }], 'low', false, signal(), () => {}, 1024, { webSearch: true }), /OpenAI/);
  assert.equal(calls, 1);
});

test('image generation calls the current Images API and returns actual bytes and measured usage', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/images/generations');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-image-2.5-flare');
    assert.equal(body.n, 1);
    assert.equal(body.quality, 'low');
    assert.equal(body.size, '1024x1024');
    assert.equal(body.response_format, undefined);
    assert.equal(body.safety_identifier, 'hashed-user');
    return Response.json({ data: [{ b64_json: encode(png) }], usage: { input_tokens: 20, output_tokens: 196, input_tokens_details: { text_tokens: 20, image_tokens: 0 } } });
  };
  const result = await generateImage({ OPENAI_API_KEY: 'test-key' }, { prompt: 'A real test image', safetyIdentifier: 'hashed-user' }, signal());
  assert.deepEqual(result.bytes, png);
  assert.equal(result.mimeType, 'image/png');
  assert.deepEqual(result.usage, { input: 20, output: 196, textInput: 20, imageInput: 0 });
});

test('Code Interpreter uses an isolated optional sandbox, meters actual containers, and extracts real artifact metadata', async () => {
  const text='The total is 12. [Download CSV](sandbox:/mnt/data/result.csv)';
  const output=[
    {type:'code_interpreter_call',id:'ci_1',container_id:'cntr_actual',status:'completed'},
    {type:'code_interpreter_call',id:'ci_2',container_id:'cntr_actual',status:'completed'},
    {type:'message',content:[{type:'output_text',text,annotations:[
      {type:'container_file_citation',container_id:'cntr_actual',file_id:'cfile_csv',filename:'../../result.csv',start_index:16,end_index:text.length},
      {type:'container_file_citation',container_id:'cntr_actual',file_id:'cfile_csv',filename:'result.csv',start_index:16,end_index:text.length},
      {type:'container_file_citation',container_id:'cntr_unrelated',file_id:'cfile_secret',filename:'secret.csv'},
      {type:'container_file_citation',container_id:'cntr_actual',file_id:'../../evil',filename:'evil.csv'},
    ]}]},
  ];
  globalThis.fetch=async(url,options)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(options.body);
    assert.deepEqual(body.tools,[{type:'code_interpreter',container:{type:'auto',memory_limit:'1g',network_policy:{type:'disabled'}}}]);
    assert.equal(body.tool_choice,'auto');assert.equal(body.max_tool_calls,2);assert.equal(body.include,undefined);assert.equal(body.store,false);
    return sse([{type:'response.output_text.delta',delta:text},...output.map(item=>({type:'response.output_item.done',item})),{type:'response.completed',response:{output:[],usage:{input_tokens:90,output_tokens:20}}}]);
  };
  let visible='';const measured=await invokeProvider(MODELS[0],'test-key',[{role:'user',content:'Use Python to calculate and make a CSV.'}],'low',false,signal(),delta=>{visible+=delta;},1024,{codeInterpreter:true,onTextReplace:text=>{visible=text;}});
  assert.equal(measured.codeInterpreterContainers,1);assert.deepEqual(measured.artifacts,[{containerId:'cntr_actual',fileId:'cfile_csv',filename:'result.csv',startIndex:16,endIndex:text.length}]);
  assert.equal(visible,'The total is 12. Download CSV');assert.doesNotMatch(visible,/sandbox:|unrelated|secret/);
});

test('optional Work code execution can return an ordinary answer with zero container charges', async()=>{
  let calls=0;
  globalThis.fetch=async()=>{calls++;return sse([{type:'response.output_text.delta',delta:'An ordinary answer.'},{type:'response.completed',response:{output:[],usage:{input_tokens:10,output_tokens:5}}}]);};
  const measured=await invokeProvider(MODELS[0],'test-key',[{role:'user',content:'Hello'}],'low',false,signal(),()=>{},1024,{codeInterpreter:true});
  assert.deepEqual(measured,{input:10,output:5,codeInterpreterContainers:0,artifacts:[]});
  await assert.rejects(invokeProvider(MODELS[1],'test-key',[{role:'user',content:'Hello'}],'low',false,signal(),()=>{},1024,{codeInterpreter:true}),/OpenAI/);
  await assert.rejects(invokeProvider(MODELS[0],'test-key',[{role:'user',content:'Hello'}],'low',false,signal(),()=>{},1024,{codeInterpreter:true,maxToolCalls:0}),/횟수/);assert.equal(calls,1);
});

test('reported code execution cannot be silently unmetered or exceed its call allowance', async()=>{
  for(const output of [[{type:'code_interpreter_call',id:'ci_missing'}],Array.from({length:3},(_,i)=>({type:'code_interpreter_call',id:'ci_'+i,container_id:'cntr_'+i}))]){
    globalThis.fetch=async()=>sse([{type:'response.output_text.delta',delta:'I ran it.'},{type:'response.completed',response:{output,usage:{input_tokens:10,output_tokens:5}}}]);
    await assert.rejects(invokeProvider(MODELS[0],'test-key',[{role:'user',content:'Calculate'}],'low',false,signal(),()=>{},1024,{codeInterpreter:true}),/실행/);
  }
});

test('reference-image edit passes real validated image bytes; dimension bombs are rejected first', async () => {
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/images/edits');
    const body = JSON.parse(options.body);
    assert.equal(body.images[0].image_url, 'data:image/png;base64,' + encode(png));
    return Response.json({ data: [{ b64_json: encode(png) }] });
  };
  const result = await generateImage({ OPENAI_API_KEY: 'test-key' }, { prompt: 'Make blue', reference: { bytes: png, mimeType: 'image/png' } }, signal());
  assert.equal(result.usage, undefined, 'missing provider usage must not be fabricated');
  const huge = png.slice();
  new DataView(huge.buffer).setUint32(16, 100000);
  await assert.rejects(generateImage({ OPENAI_API_KEY: 'test-key' }, { prompt: 'Edit', reference: { bytes: huge, mimeType: 'image/png' } }, signal()), error => error.code === 'INVALID_REFERENCE_IMAGE');
  assert.equal(calls, 1);
  assert.deepEqual(referenceDimensions(png, 'image/png'), { width: 1, height: 1 });
});

test('unconfigured media makes no provider calls, and unsafe/retired model settings are rejected', async () => {
  globalThis.fetch = async () => { throw new Error('must not call a provider'); };
  for (const [run, code] of [[generateImage, 'IMAGE'], [createVideo, 'VIDEO'], [generateMusic, 'MUSIC']]) {
    await assert.rejects(run({}, { prompt: 'Generate' }, signal()), error => error.code === `${code}_GENERATION_NOT_CONFIGURED`);
  }
  assert.throws(() => mediaModel({ OPENAI_IMAGE_MODEL: 'gpt-image-1' }, 'image'), error => error.code === 'MEDIA_MODEL_NOT_SUPPORTED');
  assert.throws(() => mediaModel({ GEMINI_VIDEO_MODEL: 'veo-3.1-fast-generate-preview' }, 'video'), error => error.code === 'MEDIA_MODEL_NOT_SUPPORTED');
});

test('provider denial and malformed output never return synthetic media or echoed secrets', async () => {
  globalThis.fetch = async () => Response.json({ error: { message: 'echoed-test-key-user-private-prompt' } }, { status: 403 });
  await assert.rejects(generateImage({ OPENAI_API_KEY: 'test-key' }, { prompt: 'Generate' }, signal()), error => error.code === 'MEDIA_PROVIDER_403' && !error.message.includes('echoed'));
  globalThis.fetch = async () => Response.json({ data: [{ b64_json: encode(new TextEncoder().encode('<html>not an image</html>')) }] });
  await assert.rejects(generateImage({ OPENAI_API_KEY: 'test-key' }, { prompt: 'Generate' }, signal()), error => error.code === 'INVALID_MEDIA_OUTPUT');
});

test('video uses current Gemini Omni URI jobs with real aspect and reference-image parameters', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(options.headers['x-goog-api-key'], 'google-test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gemini-omni-1.1-flash');
    assert.equal(body.store, false);
    assert.equal(body.input[0].type, 'image');
    assert.deepEqual(body.response_format, { type: 'video', aspect_ratio: '9:16', resolution: '720p', delivery: 'uri' });
    return Response.json({ status: 'completed', id: 'interaction1', steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', uri: 'https://generativelanguage.googleapis.com/v1beta/files/video-123:download?alt=media' }] }] });
  };
  const result = await createVideo({ GEMINI_API_KEY: 'google-test-key' }, { prompt: 'Move the camera', aspect: '9:16', reference: { bytes: png, mimeType: 'image/png' } }, signal());
  assert.equal(result.status, 'processing');
  assert.equal(result.job.fileName, 'files/video-123');
  globalThis.fetch = async url => { assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/files/video-123'); return Response.json({ state: 'ACTIVE' }); };
  assert.equal(await pollVideo({ GEMINI_API_KEY: 'google-test-key' }, result.job, signal()), 'completed');
  globalThis.fetch = async url => { assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/files/video-123:download?alt=media'); return new Response(mp4, { headers: { 'Content-Type': 'video/mp4' } }); };
  assert.deepEqual((await downloadVideo({ GEMINI_API_KEY: 'google-test-key' }, result.job, signal())).bytes, mp4);
});

test('Google file URLs cannot redirect API credentials to arbitrary or storage hosts', async () => {
  const job = { provider: 'google', model: 'gemini-omni-1.1-flash', fileName: 'files/video-123' };
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    if (calls === 1) return new Response(null, { status: 302, headers: { location: 'https://storage.googleapis.com/signed-video' } });
    assert.equal(options.headers['x-goog-api-key'], undefined);
    return new Response(mp4);
  };
  await downloadVideo({ GEMINI_API_KEY: 'google-test-key' }, job, signal());
  assert.equal(calls, 2);
  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://evil.example/stolen' } }); };
  await assert.rejects(downloadVideo({ GEMINI_API_KEY: 'google-test-key' }, job, signal()), error => error.code === 'INVALID_VIDEO_FILE');
  assert.equal(calls, 1);
  await assert.rejects(downloadVideo({ GEMINI_API_KEY: 'google-test-key' }, { ...job, fileName: 'https://127.0.0.1/private' }, signal()), error => error.code === 'INVALID_VIDEO_FILE');
  assert.equal(calls, 1);
});

test('music parses actual model_output audio; user input and thought blocks cannot become the result', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'lyria-3-clip-preview');
    assert.equal(body.response_format.type, 'audio');
    return Response.json({ status: 'completed', steps: [
      { type: 'user_input', content: [{ type: 'audio', data: 'fake' }] },
      { type: 'thought', content: [{ type: 'text', text: 'private reasoning' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'Instrumental clip' }, { type: 'audio', mime_type: 'audio/mp3', data: encode(mp3) }] },
    ] });
  };
  const asset = await generateMusic({ GEMINI_API_KEY: 'google-test-key' }, { prompt: 'Gentle piano instrumental' }, signal());
  assert.deepEqual(asset.bytes, mp3);
  assert.equal(asset.text, 'Instrumental clip');
  assert.equal(asset.mimeType, 'audio/mpeg');
  assert.equal(asset.usage, undefined);
});
