import { withExponentialBackoff } from '../../../src/infrastructure/utils/with-exponential-backoff';
import { Logger } from '@nestjs/common';

describe('withExponentialBackoff', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should return result immediately if no error occurs', async () => {
    const operation = jest.fn().mockResolvedValue('success');
    const result = await withExponentialBackoff(operation, 'TestCtx');
    
    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('should retry on HTTP 429 error and eventually succeed', async () => {
    const operation = jest.fn()
      .mockRejectedValueOnce(new Error('HTTP 429 Too Many Requests'))
      .mockRejectedValueOnce(new Error('HTTP 429 Too Many Requests'))
      .mockResolvedValueOnce('success');

    // Usamos delay real muy pequeño para que el test sea instantáneo sin pelear con FakeTimers + Async
    const promise = await withExponentialBackoff(operation, 'TestCtx', { maxRetries: 3, initialDelayMs: 10 });

    expect(promise).toBe('success');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('should throw immediately if error is not rate limit or server error', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('Invalid input format (HTTP 400)'));

    await expect(withExponentialBackoff(operation, 'TestCtx')).rejects.toThrow('Invalid input format');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('should throw after reaching max retries on rate limit', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('HTTP 429 Too Many Requests'));

    await expect(withExponentialBackoff(operation, 'TestCtx', { maxRetries: 2, initialDelayMs: 10 })).rejects.toThrow('HTTP 429 Too Many Requests');
    
    expect(operation).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });
});
