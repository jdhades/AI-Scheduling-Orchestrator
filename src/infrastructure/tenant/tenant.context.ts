import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * TenantContext
 *
 * Almacena el tenantId (company_id) del request actual.
 * Scope REQUEST: cada HTTP request tiene su propia instancia.
 * 
 * Se inyecta en repositorios para:
 *  1. Incluir WHERE company_id = tenantId en queries manuales
 *  2. SET LOCAL app.tenant_id = tenantId antes de queries
 *     (esto activa las RLS policies de PostgreSQL)
 */
@Injectable()
export class TenantContext {
    private _tenantId: string | null = null;

    set(tenantId: string): void {
        this._tenantId = tenantId;
    }

    get(): string {
        if (!this._tenantId) {
            throw new Error('TenantContext not initialized — missing company_id in request');
        }
        return this._tenantId;
    }

    isSet(): boolean {
        return this._tenantId !== null;
    }
}
