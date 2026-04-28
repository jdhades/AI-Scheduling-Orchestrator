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
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Seguridad Baseline
  app.use(helmet());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );

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
  const isProdLike =
    process.env.APP_ENV !== 'development' &&
    process.env.APP_ENV !== 'test' &&
    process.env.NODE_ENV !== 'development' &&
    process.env.NODE_ENV !== 'test';
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
