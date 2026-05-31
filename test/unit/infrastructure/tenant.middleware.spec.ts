import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantMiddleware } from '../../../src/infrastructure/tenant/tenant.middleware';
import { TenantContext } from '../../../src/infrastructure/tenant/tenant.context';

/**
 * 🧪 UNIT TEST: TenantMiddleware
 *
 * El middleware ya no acepta X-Company-Id como autoridad — solo JWT en
 * prod. En dev/test deja pasar con warning para no romper tests legacy.
 */
describe('TenantMiddleware', () => {
  const mockRes = {} as any;
  const mockNext = jest.fn();

  const makeMiddleware = (env: string): TenantMiddleware => {
    const config = {
      get: (k: string) => (k === 'APP_ENV' ? env : undefined),
    } as unknown as ConfigService;
    return new TenantMiddleware(config);
  };

  beforeEach(() => {
    mockNext.mockClear();
  });

  describe('JWT Bearer present', () => {
    it('passes through — guard se encarga del JWT y de @CurrentCompany', () => {
      const mw = makeMiddleware('production');
      const req = {
        headers: { authorization: 'Bearer abc.def.ghi' },
      } as any;

      mw.use(req, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalledTimes(1);
    });
  });

  describe('production', () => {
    it('rechaza request sin JWT aunque traiga X-Company-Id', () => {
      const mw = makeMiddleware('production');
      const req = {
        headers: { 'x-company-id': 'company-123' },
      } as any;

      expect(() => mw.use(req, mockRes, mockNext)).toThrow(
        UnauthorizedException,
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('rechaza request sin JWT y sin header', () => {
      const mw = makeMiddleware('staging');
      const req = { headers: {} } as any;

      expect(() => mw.use(req, mockRes, mockNext)).toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('development fallback', () => {
    it('deja pasar request con X-Company-Id (sin JWT) con warning', () => {
      const mw = makeMiddleware('development');
      const req = {
        headers: { 'x-company-id': 'company-dev' },
      } as any;

      mw.use(req, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalledTimes(1);
    });

    it('rechaza request sin JWT y sin header incluso en dev', () => {
      const mw = makeMiddleware('development');
      const req = { headers: {} } as any;

      expect(() => mw.use(req, mockRes, mockNext)).toThrow(
        UnauthorizedException,
      );
    });
  });
});

/**
 * 🧪 UNIT TEST: TenantContext
 */
describe('TenantContext', () => {
  let ctx: TenantContext;

  beforeEach(() => {
    ctx = new TenantContext();
  });

  it('should return the tenant id after set()', () => {
    ctx.set('company-abc');
    expect(ctx.get()).toBe('company-abc');
    expect(ctx.isSet()).toBe(true);
  });

  it('should throw when get() called before set()', () => {
    expect(() => ctx.get()).toThrow('TenantContext not initialized');
  });

  it('should report isSet() as false before set()', () => {
    expect(ctx.isSet()).toBe(false);
  });
});
