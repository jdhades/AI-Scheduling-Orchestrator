import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  APP_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),

  SUPABASE_URL: Joi.string().required(),
  SUPABASE_SERVICE_ROLE_KEY: Joi.string().required().min(20).required(),

  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().required(),

  // Twilio — opcional en entorno test (mockeado), requerido en producción
  TWILIO_ACCOUNT_SID: Joi.string().optional().allow(''),
  TWILIO_AUTH_TOKEN: Joi.string().optional().allow(''),
  TWILIO_FROM_NUMBER: Joi.string().optional().allow(''),
  TWILIO_WEBHOOK_URL: Joi.string().optional().allow(''),

  ACTIVE_AI_PROVIDER: Joi.string()
    .valid('gemini', 'qwen', 'local')
    .default('qwen')
    .optional(),

  // LLM Providers — Ambos opcionales para test, requeridos según ACTIVE_AI_PROVIDER en producción
  QWEN_API_KEY: Joi.string().optional().allow(''),
  GEMINI_API_KEY: Joi.string().optional().allow(''),

  // LLM local (LM Studio / Ollama / llama.cpp)
  LLM_LOCAL_BASE_URL: Joi.string().optional().allow(''),
  LLM_LOCAL_MODEL: Joi.string().optional().allow(''),
});
