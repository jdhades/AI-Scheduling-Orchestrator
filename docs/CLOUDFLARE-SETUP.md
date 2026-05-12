# Cloudflare Setup — Free Tier

> Sprint Auth PR 11. Setup operativo de Cloudflare como edge layer entre internet y el origin (Nest API + Vite frontend).
> **Solo features del plan gratuito.** Anything paid (advanced WAF rules, >1 rate limit rule, Pro Bot Management) queda fuera.

---

## 0. Prereqs

- Dominio propio (ej. `scheduling.tudominio.com`).
- Cuenta Cloudflare free.
- Acceso al registrar DNS para cambiar nameservers.

---

## 1. Onboard del dominio

1. Cloudflare Dashboard → **Add site** → ingresar el dominio.
2. Cloudflare escanea los DNS records actuales — verificar y ajustar:
   - `api.tudominio.com` → A record al IP del origin **Proxy ON (naranja)**.
   - `app.tudominio.com` → CNAME al hosting estático del frontend, **Proxy ON**.
3. Cambiar nameservers en el registrar a los que Cloudflare asigna. Propagación típica: <1h.
4. Esperar al check de Cloudflare ("Pending Nameserver Update" → "Active").

---

## 2. SSL/TLS

`SSL/TLS → Overview`:

| Setting | Valor |
|---|---|
| Encryption mode | **Full (strict)** |
| Always Use HTTPS | ON |
| Automatic HTTPS Rewrites | ON |
| Minimum TLS Version | 1.2 |
| HTTPS Rewrites | ON |

### Origin Certificate

`SSL/TLS → Origin Server → Create Certificate`:

- Hostnames: `api.tudominio.com`, `*.tudominio.com`.
- Validity: 15 años (default).
- Descargar `.pem` + `.key`.
- Instalar en el origin server (NGINX/Caddy delante de Node, o directamente en Node via `https.createServer` con cert + key).
- Cerrar puerto 80 al público (Cloudflare maneja HTTPS y reescribe).

### HSTS

`SSL/TLS → Edge Certificates → HSTS`:

- Activar **DESPUÉS** de confirmar que todo el sitio responde HTTPS.
- Max-Age: 12 months
- Include subdomains: ON
- Preload: ON (después de 1 semana sin issues).

---

## 3. Bot Management (free)

`Security → Bots`:

- **Bot Fight Mode**: ON
- **Verified Bots**: allow (Google, Bing).

---

## 4. WAF — Managed Ruleset (free)

`Security → WAF → Managed rules`:

| Ruleset | State | Notas |
|---|---|---|
| Cloudflare Managed Ruleset | **ON** (Default mode) | OWASP Top 10 básico |
| Cloudflare OWASP Core Ruleset | **ON** | Paranoia Level **PL1** (default) |
| Cloudflare Exposed Credentials Check Ruleset | ON | Detecta credenciales filtradas |

### Custom rules (free tier = 5 reglas)

`Security → WAF → Custom rules → Create rule`:

**Regla 1 — Challenge auth endpoints**
```
Expression:
  (http.request.uri.path eq "/auth/invitations/by-token/" or http.request.uri.path matches "^/auth/.*") and http.request.method eq "POST"
Action:
  Managed Challenge
```

**Regla 2 — Restringir webhooks Twilio por IP**
```
Expression:
  http.request.uri.path matches "^/webhooks/.*" and not ip.src in {54.172.60.0/23 54.244.51.0/24}
Action:
  Block
```
(Rangos de Twilio actualizados — verificar en https://www.twilio.com/docs/voice/ip-addresses)

**Regla 3 — Geo-bloqueo (opcional)**
Si tu negocio solo opera en LATAM, bloquear países con tráfico anómalo (CN, RU, KP):
```
Expression:
  ip.geoip.country in {"CN" "RU" "KP"} and not http.request.uri.path eq "/health"
Action:
  Block
```

---

## 5. Rate Limiting (free tier = 1 regla)

`Security → WAF → Rate limiting rules → Create rule`:

```
Name: Login brute-force
Expression: http.request.uri.path matches "^/auth/(login|invitations/by-token).*"
Requests: 10
Period: 1 minute
Mitigation: Block for 15 minutes
```

El resto del rate limiting va server-side via `@nestjs/throttler` (PR 9).

---

## 6. Turnstile (free, separado del plan)

`Turnstile` (top-level menu):

1. **Add site**.
2. Hostname: `app.tudominio.com`.
3. Widget mode: **Managed** (Cloudflare decide invisible vs visual challenge).
4. Copiar **Site Key** → frontend env `VITE_TURNSTILE_SITEKEY`.
5. Copiar **Secret Key** → backend env `TURNSTILE_SECRET_KEY` (o configurar en Supabase Auth Dashboard si usás validación nativa).

### Validación

Dos paths posibles:

**A) Supabase Auth nativo** (recomendado si querés simpleza):
- Supabase Dashboard → Auth → Settings → CAPTCHA Protection → Turnstile → pegar secret.
- Frontend pasa `options.captchaToken` en `signInWithPassword` / `signUp` — Supabase valida server-side antes de procesar.

**B) Backend custom**:
- Frontend obtiene token del widget.
- Backend `/auth/*` valida con `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` body `{ secret, response: token }`.
- Si fail → 400.

PR 11 frontend prepara el widget para path A.

---

## 7. Cloudflare Tunnel (free)

Oculta el IP del origin completamente.

### Setup

1. Instalar `cloudflared` en el server:
```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
```

2. Autenticar:
```bash
cloudflared tunnel login
```

3. Crear tunnel:
```bash
cloudflared tunnel create scheduling-api
```

4. Config en `~/.cloudflared/config.yml`:
```yaml
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json
ingress:
  - hostname: api.tudominio.com
    service: http://localhost:3000
  - service: http_status:404
```

5. Route DNS:
```bash
cloudflared tunnel route dns scheduling-api api.tudominio.com
```

6. Systemd:
```bash
sudo cloudflared --config ~/.cloudflared/config.yml service install
sudo systemctl start cloudflared
sudo systemctl enable cloudflared
```

7. **Cerrar el puerto 3000 al público** en el firewall (UFW/iptables/security group del cloud provider). Solo `cloudflared` puede tocar el origin.

---

## 8. Cloudflare Access (free hasta 50 users)

`Zero Trust → Access → Applications`:

Para endpoints admin/internos como `/admin/*`, `/metrics`, `/llm-model-budgets` (CRUD):

1. **Add an application → Self-hosted**.
2. Application domain: `api.tudominio.com/admin/*`.
3. Identity provider: Google Workspace (o GitHub para acceso interno).
4. Policy:
   - Action: Allow
   - Include: emails ending in `@tuempresa.com`

Cloudflare interceptaría todo request a `/admin/*` y forzaría SSO ANTES de llegar al origin.

---

## 9. Caching (free)

`Speed → Optimization`:

| Setting | Valor |
|---|---|
| Auto Minify (HTML/CSS/JS) | ON |
| Brotli | ON |
| Rocket Loader | OFF (rompe React) |
| Mirage | ON |
| Polish | Lossy |

### Page Rules (free tier = 3 reglas)

`Rules → Page Rules → Create Page Rule`:

**Regla 1 — Cache agresivo de assets estáticos**
```
URL: *.tudominio.com/assets/*
Settings:
  - Cache Level: Cache Everything
  - Edge Cache TTL: a month
  - Browser Cache TTL: a day
```

**Regla 2 — Bypass cache para API**
```
URL: api.tudominio.com/*
Settings:
  - Cache Level: Bypass
```

**Regla 3 — Forzar HTTPS**
```
URL: *.tudominio.com/*
Settings:
  - Always Use HTTPS
```

---

## 10. Checklist final

- [ ] DNS proxied (naranja) en `api.*` y `app.*`
- [ ] SSL Full (strict) + Origin Cert instalado
- [ ] HSTS habilitado (después de validar HTTPS 100%)
- [ ] Bot Fight Mode ON
- [ ] WAF Managed Ruleset ON
- [ ] 5 custom rules WAF en su lugar
- [ ] 1 rate limit rule activa
- [ ] Turnstile sitekey en frontend + secret en Supabase Auth Dashboard
- [ ] Cloudflare Tunnel corriendo + firewall cerrado
- [ ] (Opcional) Cloudflare Access para `/admin/*`
- [ ] Page Rules de caching + always HTTPS

---

## Costos

**Free tier cubre todo lo de arriba.** Total: $0/mes.

Paid features que NO estamos usando (referencia):
- Cloudflare Pro ($20/mes): WAF rules ilimitadas, image optimization, advanced bot detection.
- Cloudflare Business ($200/mes): WAF custom rules avanzadas, prioritized support.

---

## Operación día a día

- **Monitor**: `Security → Events` muestra requests bloqueados/desafiados.
- **Logs (Free)**: solo últimas 24h via UI. Para retention, exportar a SIEM (paid).
- **Alerts**: `Notifications → Add` — alertas por DDoS detectado, origin offline, etc.
