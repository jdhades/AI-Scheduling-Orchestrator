process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (
    warning.name === 'DeprecationWarning' &&
    (warning as any).code === 'DEP0169'
  )
    return;
  console.warn(warning);
});

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as express from 'express';
import helmet from 'helmet';
import { ValidationPipe } from '@nestjs/common';
import { PostgresExceptionFilter } from './infrastructure/filters/postgres-exception.filter';

async function bootstrap() {
  // `rawBody: true` retiene el Buffer original del body para que el
  // StripeWebhookController pueda verificar la firma. Stripe firma
  // bytes exactos; si Nest parsea a JSON antes, la firma falla.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // ─── Hardening transversal (PR 9 sprint Auth) ─────────────────────────
  // Helmet: CSP + HSTS + frame-ancestors=none. Whitelist específico para
  // permitir Turnstile (Cloudflare CAPTCHA — usado en /login en PR 11)
  // y comunicación con Supabase Auth.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://challenges.cloudflare.com'],
          frameSrc: ["'self'", 'https://challenges.cloudflare.com'],
          connectSrc: [
            "'self'",
            process.env.SUPABASE_URL ?? '',
            'https://challenges.cloudflare.com',
          ],
          frameAncestors: ["'none'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
        },
      },
      hsts: {
        maxAge: 31536000, // 1 año
        includeSubDomains: true,
        preload: true,
      },
    }),
  );

  // Cache-Control: no-store por default en TODAS las respuestas API.
  // Defensa contra CDNs / proxies / browsers que cacheen respuestas
  // tenant-specific (ej. /auth/me, /employees) y se sirvan al user
  // equivocado. Endpoints que SÍ quieran ser cacheables (estáticos,
  // assets) pueden override-ear con `res.setHeader('Cache-Control', ...)`
  // antes de responder.
  app.use(
    (
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    },
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // descarta props no declaradas
      forbidNonWhitelisted: true, // 400 si vienen props extra
      transform: true, // auto-convierte primitives (string → number, etc)
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const isProdLike =
    process.env.APP_ENV !== 'development' &&
    process.env.APP_ENV !== 'test' &&
    process.env.NODE_ENV !== 'development' &&
    process.env.NODE_ENV !== 'test';

  // DEV_AUTH_BYPASS — saltea JWT validation cuando hay X-Company-Id.
  // Solo permitido fuera de prod. Si el flag llega activo a prod, el
  // boot falla en vez de quedarse con un warning silencioso: una env
  // mal seteada implicaría que cualquier request con X-Company-Id
  // accede como owner.
  const devBypass = process.env.DEV_AUTH_BYPASS === 'true';
  if (devBypass && isProdLike) {
    console.error(
      '🚨 DEV_AUTH_BYPASS=true detected in non-dev/test environment ' +
        `(APP_ENV=${process.env.APP_ENV}, NODE_ENV=${process.env.NODE_ENV}). ` +
        'Refusing to boot — this would allow unauthenticated requests to ' +
        'impersonate any tenant via X-Company-Id.',
    );
    process.exit(1);
  }
  if (devBypass) {
    console.warn(
      '⚠️  DEV_AUTH_BYPASS=true — JWT validation skipped when X-Company-Id ' +
        'header is present. Dev/test only.',
    );
  }

  // WebSocket CORS: el @WebSocketGateway decorator evalúa la config al
  // cargar el module, así que el origin se setea desde FRONTEND_URL al
  // arranque. Sin FRONTEND_URL en prod, el gateway cae a wildcard ('*')
  // y cualquier origin podría conectar. Hard-fail acá replica el guard
  // de HTTP CORS más abajo.
  if (isProdLike && !process.env.FRONTEND_URL) {
    console.error(
      '🚨 FRONTEND_URL not set in production environment. ' +
        'The WebSocket gateway would fall back to a wildcard CORS origin, ' +
        'allowing any origin to open a WS connection. Set FRONTEND_URL ' +
        '(e.g. https://app.example.com) before booting.',
    );
    process.exit(1);
  }

  // Traduce errores de Postgres / no-HTTP a respuestas con `errorCode`
  // estable que el frontend resuelve via i18n.
  app.useGlobalFilters(new PostgresExceptionFilter());

  // Twilio sends webhooks as application/x-www-form-urlencoded
  app.use(express.urlencoded({ extended: true }));

  // CORS:
  //  - Si ALLOWED_ORIGIN está seteado → se usa tal cual (string o lista
  //    separada por coma).
  //  - Si no está, en development/test caemos a '*' (dev abierto).
  //  - En producción sin ALLOWED_ORIGIN, fallamos cerrado (false) para
  //    no exponer la API a cualquier origin por accidente de config.
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  let corsOrigin: string | string[] | boolean;
  if (allowedOrigin) {
    corsOrigin = allowedOrigin.includes(',')
      ? allowedOrigin.split(',').map((o) => o.trim())
      : allowedOrigin;
  } else {
    corsOrigin = isProdLike ? false : '*';
  }
  app.enableCors({
    origin: corsOrigin,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
    allowedHeaders: 'Content-Type, Accept, Authorization, X-Company-Id',
  });
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
