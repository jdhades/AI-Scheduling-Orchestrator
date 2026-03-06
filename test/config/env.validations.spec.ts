import { envValidationSchema } from '../../src/infrastructure/config/env.validation';

describe('Environment Validation', () => {
  it('should fail if SUPABASE_URL missing', () => {
    const { error } = envValidationSchema.validate({
      REDIS_HOST: 'localhost',
      REDIS_PORT: 6379,
    });

    expect(error).toBeDefined();
  });

  it('should pass with correct variables', () => {
    const { error } = envValidationSchema.validate({
      SUPABASE_URL: 'https://xyz.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'supersecretkey123456',
      REDIS_HOST: 'localhost',
      REDIS_PORT: 6379,
    });

    expect(error).toBeUndefined();
  });
});