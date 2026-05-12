# Blueprint — Auth + Multi-tenant + Vista Empleado

> **Status**: planned. Sprint en arranque al 2026-05-09.
> **Goal**: introducir identity + authorization + isolación multi-tenant + vista del empleado, cerrando la deuda de seguridad HIGH (sin auth, cross-tenant lookup).

---

## Índice

1. [Esquema de DB + migraciones](#1-esquema-de-db--migraciones)
2. [Backend (NestJS)](#2-backend-nestjs)
3. [Frontend](#3-frontend)
4. [Hardening transversal](#4-hardening-transversal-nestjs)
5. [Cloudflare (free-tier only)](#5-cloudflare-free-tier-only)
6. [Order de rollout (PR-by-PR)](#6-order-de-rollout-pr-by-pr)
7. [Testing](#7-testing)
8. [Riesgos del rollout](#8-riesgos-del-rollout)

---

## 1. Esquema de DB + migraciones

### 1.1 Migration: `20260510000000_auth_integration.sql`

```sql
-- Supabase ya provee `auth.users`. Linkeamos employees a esa tabla.
ALTER TABLE employees
  ADD COLUMN auth_user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX employees_auth_user_id_idx ON employees(auth_user_id);

-- Audit log de eventos auth. Login, logout, 403s, role changes,
-- session invalidations. Separado de shift_assignment_edits porque
-- el shape es distinto y la cadencia de escritura es alta.
CREATE TABLE auth_audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NULL,                    -- NULL si pre-auth (login attempt)
  auth_user_id    UUID NULL,                    -- NULL si pre-auth fail
  employee_id     UUID NULL,                    -- NULL si no resuelto
  event           TEXT NOT NULL,                -- 'login_success','login_fail','logout',
                                                -- 'permission_denied','role_changed',
                                                -- 'mfa_enrolled','password_reset'
  ip_address      INET NULL,
  user_agent      TEXT NULL,
  metadata        JSONB NULL,                   -- detalles event-specific
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX auth_audit_log_company_time_idx
  ON auth_audit_log (company_id, created_at DESC);
CREATE INDEX auth_audit_log_user_time_idx
  ON auth_audit_log (auth_user_id, created_at DESC);
CREATE INDEX auth_audit_log_event_time_idx
  ON auth_audit_log (event, created_at DESC) WHERE event IN ('login_fail','permission_denied');

-- Invitations table. El manager invita por phone (OTP WhatsApp) o
-- email (link mágico). La fila se borra al consumirse el token.
CREATE TABLE auth_invitations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL,
  invited_by      UUID NOT NULL,                -- employee_id del manager
  email           TEXT NULL,
  phone_number    TEXT NULL,
  role            TEXT NOT NULL CHECK (role IN ('manager','employee')),
  department_id   UUID NULL,
  token           TEXT NOT NULL UNIQUE,         -- nonce random 32 chars
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at     TIMESTAMPTZ NULL,
  CHECK (email IS NOT NULL OR phone_number IS NOT NULL)
);

CREATE INDEX auth_invitations_company_idx ON auth_invitations(company_id);
CREATE UNIQUE INDEX auth_invitations_token_uidx ON auth_invitations(token);
```

### 1.2 Migration: `20260510000001_enable_rls.sql`

```sql
-- Habilitar RLS en TODAS las tablas tenant-scoped. Backend con
-- service_role bypassa esto; clients con anon_key/JWT user deben
-- cumplir las policies.
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE absence_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_swap_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE day_off_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE fairness_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE semantic_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_generation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_usage_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_model_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_assignment_edits ENABLE ROW LEVEL SECURITY;

-- Helper function: resuelve company_id del JWT con custom claim.
-- El claim lo seteamos via Supabase Hook (ver §1.3).
CREATE OR REPLACE FUNCTION auth.user_company_id()
RETURNS UUID
LANGUAGE SQL STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'company_id', '')::UUID;
$$;

CREATE OR REPLACE FUNCTION auth.user_role()
RETURNS TEXT
LANGUAGE SQL STABLE
AS $$
  SELECT current_setting('request.jwt.claims', true)::jsonb ->> 'employee_role';
$$;

-- Policy genérica: SELECT/INSERT/UPDATE/DELETE solo dentro del tenant.
-- Aplicada a TODAS las tablas con company_id mediante CREATE POLICY
-- repetido (script generador adjunto al PR).
CREATE POLICY tenant_isolation ON employees
  FOR ALL TO authenticated
  USING (company_id = auth.user_company_id())
  WITH CHECK (company_id = auth.user_company_id());

-- Excepción: shift_assignments — el employee solo ve los SUYOS; el
-- manager ve los de su company.
CREATE POLICY shift_assignments_employee_self ON shift_assignments
  FOR SELECT TO authenticated
  USING (
    company_id = auth.user_company_id()
    AND (
      auth.user_role() = 'manager'
      OR employee_id = (
        SELECT id FROM employees WHERE auth_user_id = auth.uid()
      )
    )
  );

CREATE POLICY shift_assignments_manager_write ON shift_assignments
  FOR ALL TO authenticated
  USING (
    company_id = auth.user_company_id()
    AND auth.user_role() = 'manager'
  )
  WITH CHECK (company_id = auth.user_company_id());
```

### 1.3 Custom claim hook (Supabase)

El JWT default de Supabase no incluye `company_id` ni `employee_role`. Hook de Postgres registrado en Supabase Dashboard → Auth → Hooks → Customize Access Token:

```sql
CREATE OR REPLACE FUNCTION auth.custom_access_token_hook(event JSONB)
RETURNS JSONB
LANGUAGE PLPGSQL STABLE
AS $$
DECLARE
  claims JSONB;
  emp RECORD;
BEGIN
  claims := event->'claims';
  SELECT id, company_id, role, department_id
    INTO emp
  FROM public.employees
  WHERE auth_user_id = (event->>'user_id')::UUID;
  IF FOUND THEN
    claims := claims || jsonb_build_object(
      'company_id', emp.company_id::text,
      'employee_id', emp.id::text,
      'employee_role', emp.role,
      'department_id', emp.department_id::text
    );
  END IF;
  RETURN jsonb_build_object('claims', claims);
END;
$$;
```

---

## 2. Backend (NestJS)

### 2.1 Estructura nueva

```
src/infrastructure/auth/
  auth.module.ts
  guards/
    jwt-auth.guard.ts          # global
    roles.guard.ts             # @Roles('manager')
  decorators/
    public.decorator.ts        # @Public() bypass JWT
    roles.decorator.ts         # @Roles('manager')
    current-user.decorator.ts
    current-company.decorator.ts
  services/
    jwt-validator.service.ts   # valida JWT contra Supabase JWKS
    auth-audit.service.ts      # write a auth_audit_log
src/interfaces/controllers/
  auth.controller.ts           # /auth/me, /auth/invitations (manager-only)
```

### 2.2 `JwtAuthGuard` (global) + `@Public()`

```ts
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtValidator: JwtValidatorService,
    private readonly audit: AuthAuditService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) throw new UnauthorizedException('Missing token');

    const claims = await this.jwtValidator.verify(token);
    req.auth = {
      userId: claims.sub,
      companyId: claims.company_id,
      employeeId: claims.employee_id,
      role: claims.employee_role,
      departmentId: claims.department_id,
    };
    if (!req.auth.companyId) {
      throw new ForbiddenException('User not linked to a company');
    }
    return true;
  }
}

// main.ts:
app.useGlobalGuards(new JwtAuthGuard(reflector, validator, audit));
```

### 2.3 Decorators

```ts
export const Public = () => SetMetadata('isPublic', true);

export const CurrentUser = createParamDecorator(
  (_data, ctx) => ctx.switchToHttp().getRequest().auth as AuthContext,
);

export const CurrentCompany = createParamDecorator(
  (_data, ctx) => ctx.switchToHttp().getRequest().auth.companyId as string,
);

export const Roles = (...roles: Array<'manager' | 'employee'>) =>
  SetMetadata('roles', roles);
```

### 2.4 Migración de endpoints existentes

| Antes | Después |
|-------|---------|
| `@Query('companyId') companyId: string` | `@CurrentCompany() companyId: string` |
| (sin role check) | `@Roles('manager')` cuando aplica |
| (sin user context) | `@CurrentUser() user: AuthContext` para employee_id |

El `@Query('companyId')` se elimina de TODOS los controllers — el companyId viene del JWT, no del query string. Garantiza que un user no pueda pedir datos de otro tenant.

### 2.5 Auth endpoints nuevos

```
POST   /auth/login              # delegado a Supabase desde frontend
POST   /auth/logout             # invalida session + audit log
GET    /auth/me                 # { user, employee, company, permissions }
POST   /auth/invitations        # manager invita (email o phone)
GET    /auth/invitations        # manager lista pending
DELETE /auth/invitations/:id    # revocar
POST   /auth/accept-invitation  # consumir token, crear auth.users, link a employee
```

### 2.6 Trigger user.created → crear employee

```sql
CREATE OR REPLACE FUNCTION auth.handle_new_user()
RETURNS TRIGGER
LANGUAGE PLPGSQL SECURITY DEFINER
AS $$
DECLARE
  inv RECORD;
BEGIN
  SELECT * INTO inv FROM auth_invitations
    WHERE consumed_at IS NULL
      AND expires_at > now()
      AND (email = NEW.email OR phone_number = NEW.phone)
    LIMIT 1;
  IF inv.id IS NULL THEN
    RAISE EXCEPTION 'No pending invitation for this user';
  END IF;
  INSERT INTO employees (id, company_id, name, role, department_id, auth_user_id, ...)
    VALUES (gen_random_uuid(), inv.company_id, NEW.email,
            inv.role, inv.department_id, NEW.id, ...);
  UPDATE auth_invitations SET consumed_at = now() WHERE id = inv.id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION auth.handle_new_user();
```

### 2.7 WebSocket auth

```ts
@WebSocketGateway({ cors: { origin: process.env.FRONTEND_URL } })
export class NotificationsGateway implements OnGatewayConnection {
  async handleConnection(client: Socket) {
    const token = client.handshake.auth.token;
    try {
      const claims = await this.jwtValidator.verify(token);
      client.join(`company:${claims.company_id}`);
      client.data.auth = claims;
    } catch {
      client.disconnect(true);
    }
  }

  notifyScheduleGenerated(companyId: string, weekStart: string) {
    this.server.to(`company:${companyId}`).emit('ScheduleGenerated', { weekStart });
  }
}
```

---

## 3. Frontend

### 3.1 Estructura

```
src/lib/
  authClient.ts              # supabase client + helpers
  AuthContext.tsx            # provider + useAuth() hook
src/pages/auth/
  LoginPage.tsx
  AcceptInvitationPage.tsx
  ForgotPasswordPage.tsx
src/pages/manager/
  TeamPage.tsx               # listar empleados + invitar
src/pages/employee/          # NUEVO — vista del empleado
  EmployeeHomePage.tsx
src/components/auth/
  ProtectedRoute.tsx
  LogoutButton.tsx
```

### 3.2 `AuthContext`

```tsx
interface AuthState {
  status: 'loading' | 'authenticated' | 'unauthenticated';
  user: { id: string; email: string } | null;
  employee: { id: string; name: string; role: 'manager' | 'employee'; departmentId: string | null } | null;
  company: { id: string; name: string } | null;
  permissions: string[];
}

export const AuthProvider = ({ children }) => {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    const sub = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!session) {
        setState({ status: 'unauthenticated' });
        return;
      }
      const { data } = await api.get('/auth/me', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      setState({ status: 'authenticated', ...data });
    });

    // Cross-tab logout sync.
    const ch = new BroadcastChannel('auth');
    ch.onmessage = (e) => {
      if (e.data === 'logout') supabase.auth.signOut();
    };

    return () => { sub.data.subscription.unsubscribe(); ch.close(); };
  }, []);

  const logout = useCallback(async () => {
    await supabase.auth.signOut();
    new BroadcastChannel('auth').postMessage('logout');
  }, []);

  return <AuthContext.Provider value={{ ...state, logout }}>{children}</AuthContext.Provider>;
};
```

### 3.3 `api.ts` revisado

```ts
api.interceptors.request.use(async (cfg) => {
  const { data } = await supabase.auth.getSession();
  if (data.session) {
    cfg.headers.Authorization = `Bearer ${data.session.access_token}`;
  }
  // QUITAR: cfg.params.companyId — el backend lo deriva del JWT.
  cfg.headers['Accept-Language'] = i18n.language;
  return cfg;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      supabase.auth.signOut();
      window.location.href = '/login';
    }
    return Promise.reject(err);
  },
);
```

### 3.4 `ProtectedRoute`

```tsx
export const ProtectedRoute = ({ children, roles }) => {
  const auth = useAuth();
  if (auth.status === 'loading') return <Splash />;
  if (auth.status === 'unauthenticated') return <Navigate to="/login" replace />;
  if (roles && !roles.includes(auth.employee!.role)) {
    return <Navigate to="/forbidden" replace />;
  }
  return <>{children}</>;
};
```

### 3.5 Vista del empleado (`EmployeeHomePage`)

Secciones, todas con filtros server-side por `employee_id` (RLS + backend lo enforce):

1. **Mi semana** — su horario actual (read-only). Reusa `ScheduleViewResource`.
2. **Mis solicitudes** — list con status (pending/approved/rejected) de absence reports + day-off requests + swap requests.
3. **Crear solicitud** — report absence, request day off, propose swap.
4. **Mi historial de fairness** — sparkline hours/week.

### 3.6 Login page (con Turnstile)

```tsx
<form onSubmit={handleSubmit}>
  <Input type="email" required />
  <Input type="password" required minLength={12} />
  <TurnstileWidget
    sitekey={import.meta.env.VITE_TURNSTILE_KEY}
    onSuccess={(token) => setCaptcha(token)}
  />
  <Button type="submit" disabled={!captcha}>Login</Button>
</form>

// Submit:
const { error } = await supabase.auth.signInWithPassword({
  email, password,
  options: { captchaToken: captcha },
});
```

Para empleados con phone-based OTP (alinea con WhatsApp handshake):
```ts
await supabase.auth.signInWithOtp({ phone, options: { channel: 'whatsapp' } });
```

---

## 4. Hardening transversal (NestJS)

`src/main.ts`:

```ts
import helmet from 'helmet';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'challenges.cloudflare.com'],
        frameSrc: ["'self'", 'challenges.cloudflare.com'],
        connectSrc: ["'self'", process.env.SUPABASE_URL!],
        frameAncestors: ["'none'"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  }));

  app.enableCors({
    origin: process.env.FRONTEND_URL,
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  }));

  await app.listen(3000);
}
```

`@nestjs/throttler` tiers:

| Route | Limit |
|-------|-------|
| `/auth/login`, `/auth/accept-invitation` | 5/min por IP |
| `/schedules/generate` | 3/min por user |
| LLM-touching endpoints | 10/min por user |
| Default | 60/min |

---

## 5. Cloudflare (free-tier only)

> **Solo features del plan gratuito.** Paid features (WAF avanzado, >1 rate limit rule, Pro Bot Management) quedan fuera del scope inicial.

### 5.1 DNS + Proxy

1. Sumar dominio a Cloudflare → cambiar nameservers.
2. Records:
   - `api.tudominio.com` → A record al origin con **proxied ON** (naranja).
   - `app.tudominio.com` → CNAME al hosting estático **proxied ON**.

### 5.2 SSL/TLS

- Mode: **Full (strict)** — TLS edge↔client + edge↔origin.
- Origin cert: **Cloudflare Origin Certificate** (gratis, 15 años).
- **Always Use HTTPS**: ON.
- **HSTS**: enable `max-age=31536000`, `includeSubDomains`, preload (después de confirmar 100% HTTPS).
- **Minimum TLS version**: 1.2.
- **Automatic HTTPS Rewrites**: ON.

### 5.3 Bot management (free)

- **Bot Fight Mode**: ON (`Security → Bots`). Filtra scrapers y bots conocidos.
- **Verified Bots**: allow.

### 5.4 Turnstile (free, separado del plan)

- En `Turnstile → Add site`, generar sitekey + secret.
- Frontend: widget en `/login` y `/accept-invitation`.
- Backend (o Supabase Auth si lo soporta): validar token contra `https://challenges.cloudflare.com/turnstile/v0/siteverify`.

### 5.5 WAF — Managed Ruleset (free)

- En `Security → WAF → Managed rules`:
  - **Cloudflare Managed Ruleset**: ON. Cubre OWASP Top 10.
  - **Cloudflare OWASP Core Ruleset**: ON con paranoia level **PL1**.
- **Custom rules** (free tier permite 5):
  1. `(http.request.uri.path eq "/auth/login" or http.request.uri.path eq "/auth/accept-invitation") and http.request.method eq "POST"` → **Managed Challenge**.
  2. `http.request.uri.path matches "^/webhooks/.*"` → restringir por `ip.src in {Twilio_ranges}`.
  3. Geo-bloqueo si aplica.

### 5.6 Rate limiting (free tier — 1 regla)

- Path: `/auth/login`
- Threshold: 10 req/min por IP
- Action: Block 15 minutes

El resto del rate limiting lo cubre `@nestjs/throttler` server-side.

### 5.7 Cloudflare Tunnel (cloudflared, free)

Cierra superficie de ataque al origin:

1. Instalar `cloudflared` en el server.
2. `cloudflared tunnel create scheduling-api`.
3. Config (`~/.cloudflared/config.yml`):
   ```yaml
   tunnel: <tunnel-id>
   credentials-file: /etc/cloudflared/cert.json
   ingress:
     - hostname: api.tudominio.com
       service: http://localhost:3000
     - service: http_status:404
   ```
4. `cloudflared tunnel route dns scheduling-api api.tudominio.com`.
5. Systemd para autostart.
6. **Cerrar el puerto 3000 al público en el firewall del server**.

Resultado: IP del origin nunca expuesta. Atacantes no pueden bypassear Cloudflare ni DDoS L4 directo.

### 5.8 Cloudflare Access (free hasta 50 users)

Para endpoints admin/internos:
- `Access → Applications → Self-hosted` → path `/admin/*` o `/metrics`.
- Policy: require email ending in `@tuempresa.com` o Google Workspace SSO.

### 5.9 Caching / performance (free)

- **Auto Minify**: HTML/JS/CSS ON.
- **Brotli**: ON.
- **Browser cache TTL**: 4 hours.
- Page Rules (free tier 3):
  1. `*.tudominio.com/assets/*` → Cache Level: Cache Everything, Edge Cache TTL: 1 month.
  2. `api.tudominio.com/*` → Cache Level: Bypass.
  3. `*.tudominio.com/*` → Always Use HTTPS.

### 5.10 Tabla resumen Cloudflare (free-only)

| Feature | Coverage | Tier |
|---|---|---|
| DDoS L3/L4/L7 | Floods bloqueados antes del origin | Free |
| Bot Fight Mode | Scrapers + bots conocidos | Free |
| WAF Managed Ruleset | OWASP Top 10 básico | Free |
| Custom WAF rules | Hasta 5 reglas | Free |
| Rate limiting | 1 regla activa | Free |
| Turnstile | CAPTCHA invisible | Free |
| Cloudflare Tunnel | IP origin oculta | Free |
| Cloudflare Access | SSO para admin endpoints | Free hasta 50 users |
| Origin Certificate | TLS edge↔origin | Free |
| Page Rules | 3 reglas | Free |
| Auto Minify + Brotli | Asset optimization | Free |

---

## 6. Order de rollout (PR-by-PR)

| PR | Scope | Notes |
|----|-------|-------|
| 1 | Migration: `auth_user_id` + `auth_audit_log` + `auth_invitations` | Sin breaking. |
| 2 | Backend: `JwtAuthGuard` + `@Public` + `CurrentUser` + `CurrentCompany`. Aplicar `@Public()` a TODOS los controllers existentes (sin romper nada todavía). | Doble path: old + new conviven. |
| 3 | Supabase Auth setup en frontend. `AuthContext`. `LoginPage`. Mantener `TENANT_ID` hardcoded como fallback. | Login funciona, no se usa todavía. |
| 4 | Custom claim hook (`company_id` en JWT) + endpoint `/auth/me`. | Verificar JWT lleva company_id. |
| 5 | Migrar endpoints uno a uno: quitar `@Public()`, quitar `@Query('companyId')`, agregar `@CurrentCompany()`. Frontend quita `companyId` del query. | El más largo — 1 PR por dominio. |
| 6 | RLS policies. Probar con anon key que el cross-tenant da 0 filas. | DB defense. |
| 7 | Trigger user.created + flow de invitaciones (manager invita, employee acepta). | UI: TeamPage para invitar. |
| 8 | Employee view (`/my`). | Nueva sección entera. |
| 9 | Hardening: Helmet + ValidationPipe + Throttler + CORS estricto. | Cleanup transversal. |
| 10 | WebSocket auth + room scoping. | Cierra la WS no-auth. |
| 11 | Cloudflare proxy + Turnstile + Tunnel. | Infra. |
| 12 | MFA opcional para managers + audit log de logins. | Hardening. |

---

## 7. Testing

### 7.1 Cross-tenant tests (críticos)

```ts
it('rejects access to other tenant resources', async () => {
  const tokenA = await loginAs('userA', 'companyA');
  const recordOfB = await seedRecord('companyB');
  const res = await request(app)
    .get(`/employees/${recordOfB.id}`)
    .set('Authorization', `Bearer ${tokenA}`);
  expect(res.status).toBe(404);  // NO 403 (no revelar existencia)
});
```

### 7.2 Role tests

```ts
it('rejects manager-only endpoint for employee role', async () => {
  const empToken = await loginAs('emp1', 'companyA', 'employee');
  const res = await request(app)
    .post('/schedules/generate')
    .set('Authorization', `Bearer ${empToken}`)
    .send({ weekStart: '2026-05-11' });
  expect(res.status).toBe(403);
});
```

### 7.3 RLS tests (al motor SQL)

Conectar con anon JWT al Postgres directo y verificar que `SELECT * FROM employees` devuelve solo del tenant del JWT.

### 7.4 Rate limit tests

```ts
it('blocks 6th login attempt within 1 min', async () => {
  for (let i = 0; i < 5; i++) await loginAttempt();
  const res = await loginAttempt();
  expect(res.status).toBe(429);
});
```

---

## 8. Riesgos del rollout

| Riesgo | Mitigación |
|--------|------------|
| **RLS rompe queries existentes** | PR 6 atrás de PR 5: cuando RLS entra, todos los endpoints ya usan JWT auth con company_id correcto. Test exhaustivo. |
| **Supabase Auth + employee link race condition** | Trigger SQL en `auth.users` insert es transaccional. Sin race. |
| **Pérdida de acceso si auth falla en prod** | Mantener un `MASTER_BYPASS_TOKEN` env var (rotable, scoped a IP allowlist) para emergencias. Audit log SIEMPRE. |
| **Cloudflare bloquea legítimos** | WAF en Log mode primero, después Block. Turnstile en `/login` antes de extender. |
| **Cookies / httpOnly + Supabase** | Supabase v2 storage adapters; cookies httpOnly samesite=strict en lugar de localStorage. |

---

## 9. Estado de implementación

| PR | Status | Commit |
|----|--------|--------|
| 1 — Migrations | _en progreso_ | — |
| 2 — JwtAuthGuard scaffold | TODO | — |
| 3 — Frontend Supabase setup | TODO | — |
| 4 — Custom claim hook + `/auth/me` | TODO | — |
| 5 — Migrar endpoints | TODO | — |
| 6 — RLS policies | TODO | — |
| 7 — Invitations flow | TODO | — |
| 8 — Employee view | TODO | — |
| 9 — Hardening transversal | TODO | — |
| 10 — WS auth | TODO | — |
| 11 — Cloudflare | TODO | — |
| 12 — MFA + audit log UI | TODO | — |
