import { Logger } from '@nestjs/common';

export interface BackoffOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  factor?: number;
}

export async function withExponentialBackoff<T>(
  operation: () => Promise<T>,
  contextName: string,
  options: BackoffOptions = {},
): Promise<T> {
  const logger = new Logger('ExponentialBackoff');
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 1000;
  const factor = options.factor ?? 2;

  let retriesLeft = maxRetries;
  let currentDelay = initialDelayMs;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      const err = error as Error;
      
      // Intentamos identificar si es un error recuperable por Rate Limits (429) o fallas de red/servidor (500, 503)
      const isRateLimitOrServer = err.message.includes('429') || 
                                  err.message.includes('500') || 
                                  err.message.includes('503') || 
                                  err.message.includes('network') ||
                                  err.message.toLocaleLowerCase().includes('fetch failed');

      if (retriesLeft > 0 && isRateLimitOrServer) {
        // Añadimos jitter aleatorio entre 0 y 20% para evitar sincronización de ráfagas
        const jitter = Math.random() * (currentDelay * 0.2);
        const sleepTime = currentDelay + jitter;

        logger.warn(
          `[${contextName}] Operation failed with "${err.message}". Retrying in ${Math.round(sleepTime)}ms... (${retriesLeft} retries left)`
        );

        await new Promise((resolve) => setTimeout(resolve, sleepTime));

        retriesLeft--;
        currentDelay *= factor;
      } else {
        // Lanzar inmediatamente si el error no es recuperable o nos quedamos sin reintentos
        throw error;
      }
    }
  }
}
