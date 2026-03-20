export default () => ({
    app: {
        env: process.env.APP_ENV,
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
})