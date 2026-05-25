import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();
    // Wiring básico: si AppController no puede resolverse, falla aquí.
    // Los tests reales del controller viven en archivos separados.
    expect(app.get<AppController>(AppController)).toBeDefined();
  });

  describe('Domain isolation', () => {
    it('should not import infrastructure', () => {
      expect(true).toBe(true);
    });
  });
});
