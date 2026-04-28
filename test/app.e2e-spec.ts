import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

/**
 * 🧪 E2E TEST: App Controller
 *
 * Levanta la aplicación NestJS completa y ejecuta llamadas HTTP reales.
 *
 * ✅ Buenas prácticas aplicadas:
 * - beforeAll / afterAll en lugar de beforeEach (la app levanta UNA sola vez)
 * - afterAll cierra la app correctamente para evitar warnings de handles abiertos
 * - Las variables de entorno vienen de .env.test vía Jest setupFiles
 */
describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  // ✅ beforeAll → levanta la app UNA sola vez para toda la suite
  // ❌ beforeEach → levantaría y mataría la app en cada test (muy lento)
  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  // ✅ Siempre cerrar la app para liberar el puerto y conexiones
  afterAll(async () => {
    await app.close();
  });

  it('GET / → should return 200 and Hello World!', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });
});
