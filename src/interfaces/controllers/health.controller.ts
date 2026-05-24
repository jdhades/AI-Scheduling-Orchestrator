import {
  Controller,
  Get,
  Inject,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthCheckResult,
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { Public } from '../../infrastructure/auth/decorators/public.decorator';
import type Redis from 'ioredis';
import { Pool } from 'pg';

/**
 * HealthController — endpoint /health para Traefik/NPM/Uptime checks.
 *
 * Verifica dependencias críticas en cascada. Devuelve 200 cuando TODO
 * está OK, 503 cuando algún check falla. Eso permite al reverse proxy
 * sacar el container del routing si la DB cae, en vez de seguir
 * mandando tráfico a un backend roto que retorna 500s.
 *
 * Checks:
 *   - redis: PING al cliente ioredis del RedisModule.
 *   - database: SELECT 1 a través de un pool pg propio (no compartimos
 *     con pg-boss porque su `.db` no es API pública en v12; un pool
 *     dedicado de 1 conexión es barato y aislado).
 *
 * NO chequeamos Supabase HTTP — sería un check externo lento. Si
 * Supabase está down, el container sigue "healthy" pero los requests
 * fallan y eso se observa por error rates. DB es directa: connection
 * pool + 1 query, sub-50ms en el path feliz.
 *
 * Endpoint público (sin auth) — el reverse proxy no manda JWT.
 */
@Controller('health')
export class HealthController implements OnApplicationShutdown {
  private readonly logger = new Logger(HealthController.name);
  private readonly pgPool: Pool | null;

  constructor(
    private readonly health: HealthCheckService,
    private readonly indicator: HealthIndicatorService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {
    // Pool dedicado para el health check. 1 conexión es suficiente —
    // el endpoint se llama cada 30s y la query es trivial. Si DATABASE_URL
    // no está seteado, el pool se queda en null y el check reporta
    // "skipped" (mismo trato que pg-boss disabled).
    const connectionString = process.env.DATABASE_URL;
    this.pgPool = connectionString
      ? new Pool({
          connectionString,
          max: 1,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 3_000,
          // Health checks NO deben mantener la conexión viva indefinidamente
          // — si la conexión muere (reinicio de Supabase), queremos que el
          // próximo check abra una nueva, no se quede colgado.
          allowExitOnIdle: true,
        })
      : null;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.pgPool) {
      await this.pgPool.end().catch((err) => {
        this.logger.warn(
          `Failed to close pg pool on shutdown: ${(err as Error).message}`,
        );
      });
    }
  }

  @Get()
  @Public()
  @HealthCheck()
  async check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this._redisCheck(),
      () => this._databaseCheck(),
    ]);
  }

  private async _redisCheck(): Promise<HealthIndicatorResult> {
    const session = this.indicator.check('redis');
    try {
      const pong = await this.redis.ping();
      if (pong !== 'PONG') {
        return session.down({ reason: `unexpected ping response: ${pong}` });
      }
      return session.up();
    } catch (err) {
      return session.down({
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async _databaseCheck(): Promise<HealthIndicatorResult> {
    const session = this.indicator.check('database');
    // Sin DATABASE_URL no podemos chequear DB. Reportamos "up" con
    // mensaje — el resto del sistema YA está roto y eso se observa por
    // otros canales. Marcar down dejaría el container unhealthy en
    // local dev donde a veces pg-boss se apaga a propósito.
    if (!this.pgPool) {
      return session.up({ message: 'DATABASE_URL not set — skipped' });
    }
    try {
      await this.pgPool.query('SELECT 1');
      return session.up();
    } catch (err) {
      return session.down({
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
