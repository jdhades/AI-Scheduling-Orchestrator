import * as Joi from "joi";

export const envValidationSchema = Joi.object({
    APP_ENV: Joi.string()
        .valid("development", "production", "test")
        .default("development"),

    SUPABASE_URL: Joi.string().required(),
    SUPABASE_SERVICE_ROLE_KEY: Joi.string().required()
        .min(20)
        .required(),

    REDIS_HOST: Joi.string().required(),
    REDIS_PORT: Joi.number().required(),

    // Twilio — opcional en entorno test (mockeado), requerido en producción
    TWILIO_ACCOUNT_SID: Joi.string().optional().allow(''),
    TWILIO_AUTH_TOKEN: Joi.string().optional().allow(''),
    TWILIO_FROM_NUMBER: Joi.string().optional().allow(''),
    TWILIO_WEBHOOK_URL: Joi.string().optional().allow(''),

    // Gemini — opcional en test (mockeado), requerido para EmbeddingService en producción
    GEMINI_API_KEY: Joi.string().optional().allow(''),
})