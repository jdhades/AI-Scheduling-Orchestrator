import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

/**
 * RedisIoAdapter — adapter de socket.io respaldado por Redis pub/sub.
 *
 * SOLO se enchufa cuando `WS_REDIS_ADAPTER=true` (ver main.ts). Su única razón
 * de existir es correr **2+ instancias** de la API: con el adapter por defecto
 * (en memoria) cada proceso solo conoce sus propios sockets, así que un evento
 * emitido por la instancia A nunca llega a un cliente conectado a la B. Con
 * este adapter, Redis publica el evento y todas las instancias lo entregan a
 * sus clientes.
 *
 * En instancia única NO hace falta — el adapter en memoria alcanza y es más
 * simple. Reusa el mismo Redis (REDIS_HOST/REDIS_PORT) ya configurado para el
 * resto de la app.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  /** Conecta los clientes pub/sub. Hace ping para fallar al arranque si Redis
   *  no está disponible (en vez de degradar silenciosamente). */
  async connectToRedis(): Promise<void> {
    const host = process.env.REDIS_HOST ?? '127.0.0.1';
    const port = parseInt(process.env.REDIS_PORT ?? '6379', 10);
    const pubClient = new Redis({ host, port });
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.ping(), subClient.ping()]);
    this.adapterConstructor = createAdapter(pubClient, subClient);
    this.logger.log(`Socket.IO Redis adapter conectado (${host}:${port})`);
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
