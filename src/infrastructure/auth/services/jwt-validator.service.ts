import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

/**
 * Custom claims que esperamos en el JWT, agregados por el Supabase
 * Access Token Hook (ver AUTH-BLUEPRINT §1.3). Si el hook no está
 * configurado todavía, vienen undefined y el guard cae al modo legacy
 * (resolver employee por user_id desde DB).
 */
export interface SupabaseJwtClaims extends JWTPayload {
  /** `auth.users.id` — SIEMPRE presente en tokens válidos. */
  sub: string;
  /** Custom claim injected by Postgres hook. */
  company_id?: string;
  employee_id?: string;
  employee_role?: 'owner' | 'manager' | 'employee';
  department_id?: string | null;
  /** Supabase default. */
  email?: string;
  phone?: string;
  aud?: string;
}

/**
 * JwtValidatorService
 *
 * Verifica JWTs emitidos por Supabase Auth localmente — sin tocar la
 * red. Usa la endpoint JWKS pública del proyecto (`/auth/v1/.well-known/
 * jwks.json`) con auto-rotación. La cache de claves la maneja jose.
 *
 * Comparación con el path legacy (`supabase.auth.getUser(token)`):
 *   - Legacy: 1 round-trip a `${SUPABASE_URL}/auth/v1/user` por request.
 *     Bloquea ~50-200ms y agrega punto de falla si Auth está down.
 *   - Acá: verify local en ~1ms. JWKS se fetchea on-demand y se cachea
 *     en memory durante minutos (jose default).
 */
@Injectable()
export class JwtValidatorService implements OnModuleInit {
  private readonly logger = new Logger(JwtValidatorService.name);
  private jwks!: ReturnType<typeof createRemoteJWKSet>;
  private issuer!: string;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const supabaseUrl = this.config.getOrThrow<string>('SUPABASE_URL');
    // Default Supabase issuer = `${SUPABASE_URL}/auth/v1`.
    this.issuer = `${supabaseUrl}/auth/v1`;
    this.jwks = createRemoteJWKSet(
      new URL(`${this.issuer}/.well-known/jwks.json`),
      {
        // Cache de las claves durante 10min — Supabase rota rara vez,
        // pero queremos picking up rotaciones sin restart del server.
        cacheMaxAge: 10 * 60 * 1000,
        cooldownDuration: 30 * 1000,
      },
    );
    this.logger.log(`JwtValidatorService ready — issuer=${this.issuer}`);
  }

  /**
   * Verifica firma + claims estándar (iss, exp, aud=authenticated).
   * Throws si el token es inválido — el guard lo cataloga como 401.
   */
  async verify(token: string): Promise<SupabaseJwtClaims> {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.issuer,
      audience: 'authenticated',
    });
    return payload as SupabaseJwtClaims;
  }
}
