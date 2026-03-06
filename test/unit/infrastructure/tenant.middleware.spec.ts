import { UnauthorizedException } from '@nestjs/common';
import { TenantMiddleware } from '../../../src/infrastructure/tenant/tenant.middleware';
import { TenantContext } from '../../../src/infrastructure/tenant/tenant.context';

/**
 * 🧪 UNIT TEST: TenantMiddleware
 *
 * Verifica que el middleware extrae correctamente el company_id
 * del header o del JWT, y que rechaza requests sin tenant.
 */
describe('TenantMiddleware', () => {
    let middleware: TenantMiddleware;
    let tenantContext: TenantContext;

    const mockRes = {} as any;
    const mockNext = jest.fn();

    beforeEach(() => {
        tenantContext = new TenantContext();
        middleware = new TenantMiddleware(tenantContext);
        mockNext.mockClear();
    });

    describe('X-Company-Id header', () => {
        it('should set tenantId from X-Company-Id header', () => {
            const req = {
                headers: { 'x-company-id': 'company-123' },
            } as any;

            middleware.use(req, mockRes, mockNext);

            expect(tenantContext.get()).toBe('company-123');
            expect(mockNext).toHaveBeenCalledTimes(1);
        });
    });

    describe('JWT claims fallback', () => {
        it('should set tenantId from JWT user.company_id when header is absent', () => {
            const req = {
                headers: {},
                user: { company_id: 'company-jwt-456' },
            } as any;

            middleware.use(req, mockRes, mockNext);

            expect(tenantContext.get()).toBe('company-jwt-456');
            expect(mockNext).toHaveBeenCalledTimes(1);
        });

        it('should prefer X-Company-Id header over JWT when both present', () => {
            const req = {
                headers: { 'x-company-id': 'company-header' },
                user: { company_id: 'company-jwt' },
            } as any;

            middleware.use(req, mockRes, mockNext);

            expect(tenantContext.get()).toBe('company-header');
        });
    });

    describe('missing tenant', () => {
        it('should throw UnauthorizedException when no tenant identifier found', () => {
            const req = { headers: {} } as any;

            expect(() => middleware.use(req, mockRes, mockNext)).toThrow(
                UnauthorizedException,
            );
            expect(mockNext).not.toHaveBeenCalled();
        });

        it('should throw when header is empty string', () => {
            const req = {
                headers: { 'x-company-id': '' },
            } as any;

            // Empty string is falsy → treated as missing → should throw
            expect(() => middleware.use(req, mockRes, mockNext)).toThrow(
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
