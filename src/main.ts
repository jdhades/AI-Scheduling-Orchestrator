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

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Seguridad Baseline
  app.use(helmet());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );

  // Twilio sends webhooks as application/x-www-form-urlencoded
  app.use(express.urlencoded({ extended: true }));

  app.enableCors({
    origin: process.env.ALLOWED_ORIGIN || '*', // For local development, allow all origins
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
    allowedHeaders: 'Content-Type, Accept, Authorization, X-Company-Id',
  });
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
