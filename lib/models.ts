export type Provider = 'openai' | 'anthropic' | 'google';
export type Model = { id: string; name: string; provider: Provider; family: string; description: string; category: string; tier: 'Advanced' | 'Everyday'; context: string; efforts: string[]; pro?: boolean; requiresPayment?: boolean; betaRate?: {input:number;output:number}; source: string };
export const DEFAULT_MODEL_ID = 'gemini-3.5-flash-lite';
export const isFreeModel = (id: string) => id === DEFAULT_MODEL_ID;
const O='https://developers.openai.com/api/docs/models', A='https://platform.claude.com/docs/en/models/overview', G='https://ai.google.dev/gemini-api/docs/models';
export const MODELS: Model[] = [
 {id:'gpt-6-astra',name:'GPT-6 Astra',provider:'openai',family:'GPT',description:'Bring your most demanding questions. Go deeper with advanced reasoning.',category:'Deep reasoning',tier:'Advanced',betaRate:{input:10,output:50},context:'1.05M',efforts:['low','medium','high','xhigh','max'],pro:true,source:O},
 {id:'claude-fable-5-1',name:'Claude Fable 5.1',provider:'anthropic',family:'Claude',description:'A thoughtful partner for complex writing, code, and long-horizon work.',category:'Writing & coding',tier:'Advanced',betaRate:{input:10,output:50},context:'1M',efforts:['low','medium','high','xhigh','max'],source:A},
 {id:'gemini-4-argon',name:'Gemini 4 Argon',provider:'google',family:'Gemini',description:'Connect the dots across large documents and complex ideas.',category:'Long context',tier:'Advanced',betaRate:{input:4,output:20},context:'1M',efforts:['low','medium','high'],source:G},
 {id:'gpt-6.1-sol',name:'GPT-6.1 Sol',provider:'openai',family:'GPT',description:'A versatile balance of reasoning, speed, and everyday usefulness.',category:'All-rounder',tier:'Everyday',betaRate:{input:2,output:10},context:'1.05M',efforts:['low','medium','high','xhigh','max'],pro:true,source:O},
 {id:'gpt-6-luna',name:'GPT-6 Luna',provider:'openai',family:'GPT',description:'Efficient help for focused questions and high-volume work.',category:'Fast & efficient',tier:'Everyday',context:'1.05M',efforts:['none','low','medium','high','xhigh','max'],pro:true,source:O},
 {id:'claude-opus-5-5',name:'Claude Opus 5.5',provider:'anthropic',family:'Claude',description:'Detailed knowledge work and complex software projects.',category:'Coding & analysis',tier:'Advanced',betaRate:{input:4,output:20},context:'1M',efforts:['low','medium','high','xhigh','max'],source:A},
 {id:'claude-sonnet-5-5',name:'Claude Sonnet 5.5',provider:'anthropic',family:'Claude',description:'Fast, capable support for your daily creative and technical work.',category:'Everyday work',tier:'Everyday',context:'1M',efforts:['low','medium','high','xhigh','max'],source:A},
 {id:'claude-haiku-5-5',name:'Claude Haiku 5.5',provider:'anthropic',family:'Claude',description:'Quick answers, clear summaries, and efficient text tasks.',category:'Quick answers',tier:'Everyday',context:'1M',efforts:['low','medium','high','xhigh','max'],source:A},
 {id:'gemini-3.1-pro-preview',name:'Gemini 3.1 Pro',provider:'google',family:'Gemini',description:'An earlier Pro model available through the Gemini preview API.',category:'General reasoning',tier:'Everyday',betaRate:{input:4,output:20},context:'Preview',efforts:['low','medium','high'],source:G},
 {id:'gpt-6-sol',name:'GPT-6 Sol',provider:'openai',family:'GPT',description:'The original GPT-6 Sol model for complex coding and professional work.',category:'Coding & reasoning',tier:'Advanced',betaRate:{input:2,output:10},context:'1.05M',efforts:['none','low','medium','high','xhigh','max'],pro:true,source:O+'/gpt-6-sol'},
 {id:'gpt-5.6-sol',name:'GPT-5.6 Sol',provider:'openai',family:'GPT',description:'A GPT-5.6 model for professional work, with standard and Pro reasoning.',category:'Professional work',tier:'Advanced',betaRate:{input:4,output:20},context:'See provider',efforts:['low','medium','high','xhigh','max'],pro:true,source:O+'/gpt-5.6-sol'},
 {id:'claude-fable-5',name:'Claude Fable 5',provider:'anthropic',family:'Claude',description:'The earlier Fable model, available alongside Fable 5.1.',category:'Complex reasoning',tier:'Advanced',context:'See provider',efforts:['low','medium','high','xhigh','max'],source:'https://platform.claude.com/docs/en/models/fable-5/overview'},

 {id:'gemini-3.8-flash',name:'Gemini 3.8 Flash',provider:'google',family:'Gemini',description:'Fast Gemini reasoning with selectable Low, Medium, and High thinking.',category:'Fast reasoning',tier:'Everyday',context:'1M',efforts:['low','medium','high'],betaRate:{input:2,output:8},source:G},
 {id:DEFAULT_MODEL_ID,name:'Gemini 3.5 Flash-Lite',provider:'google',family:'Gemini',description:'빠르고 가벼운 일상 대화. 로그인 전후 무료로 사용할 수 있습니다.',category:'무료 대화',tier:'Everyday',context:'1M',efforts:['minimal','low','medium','high'],requiresPayment:false,betaRate:{input:0.3,output:2.5},source:G+'/gemini-3.5-flash-lite'},
];
// Keep retired model records for saved conversations, while exposing only the
// five supported choices for new requests. Server checks use this same list.
export const AVAILABLE_CHAT_MODELS: Model[] = [DEFAULT_MODEL_ID,'gpt-6.1-sol','gpt-6-astra','claude-fable-5-1','gemini-4-argon'].map(id => {
 const model = MODELS.find(candidate => candidate.id === id)!;
 return { ...model, requiresPayment: !isFreeModel(id) };
});
export const PROVIDERS: Record<Provider,{name:string;secret:string;url:string;description:string}> = {
 openai:{name:'OpenAI',secret:'OPENAI_API_KEY',url:'https://platform.openai.com/api-keys',description:'GPT models, including Pro mode and Extra High reasoning.'},
 anthropic:{name:'Anthropic',secret:'ANTHROPIC_API_KEY',url:'https://platform.claude.com/settings/keys',description:'Claude Fable, Opus, Sonnet, and Haiku.'},
 google:{name:'Google',secret:'GEMINI_API_KEY',url:'https://aistudio.google.com/apikey',description:'Gemini Argon and Pro API models.'}
};
export const findModel = (id:string) => MODELS.find(m=>m.id===id);
