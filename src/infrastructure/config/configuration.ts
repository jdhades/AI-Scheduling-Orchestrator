export default () => ({
  app: {
    env: process.env.APP_ENV,
  },
  ai: {
    activeProvider: process.env.ACTIVE_AI_PROVIDER || 'qwen', // default 'qwen'
  },
  qwen: {
    apiKey: process.env.QWEN_API_KEY,
  },
  llmLocal: {
    baseUrl: process.env.LLM_LOCAL_BASE_URL,
    model: process.env.LLM_LOCAL_MODEL,
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
  redis: {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT!, 10),
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    fromNumber: process.env.TWILIO_FROM_NUMBER,
    webhookUrl: process.env.TWILIO_WEBHOOK_URL,
  },
});
