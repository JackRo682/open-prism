declare namespace Cloudflare {
 interface Env { BETA_MODE?:string; DB?: D1Database; BUCKET?: R2Bucket; OPENAI_API_KEY?:string; ANTHROPIC_API_KEY?:string; GEMINI_API_KEY?:string; ADMIN_USER_ID?:string; PAYMENTS_MODE?:string; TOSS_SECRET_KEY?:string; TOSS_CLIENT_KEY?:string; LAUNCH_APPROVED?:string; }
}
