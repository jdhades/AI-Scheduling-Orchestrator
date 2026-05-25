# Deploy en el VPS

Compose y env template para correr el stack en un VPS detrás de
Nginx Proxy Manager (NPM).

## Layout

```
/opt/docker/ai-scheduling/
├── docker-compose.yml   ← copia de deploy/docker-compose.prod.yml
└── .env                 ← copia de deploy/.env.example, con secretos reales (chmod 600)
```

`/opt/docker/nginxproxymanager/` es de NPM y vive separado. Ambos comparten una red docker externa.

## Primer deploy

Pre-requisitos en el VPS:
- Docker + compose plugin (`docker compose version` debe responder)
- Usuario en el grupo `docker`
- `docker login ghcr.io -u <usuario-gh> -p <PAT-classic-read-packages>`
- NPM corriendo en otra carpeta de `/opt/docker/`

```bash
sudo mkdir -p /opt/docker/ai-scheduling
sudo chown $USER:$USER /opt/docker/ai-scheduling
cd /opt/docker/ai-scheduling

# 1. Copiar compose + env template
#    (desde tu máquina local, con scp)
scp deploy/docker-compose.prod.yml vps:/opt/docker/ai-scheduling/docker-compose.yml
scp deploy/.env.example vps:/opt/docker/ai-scheduling/.env

# 2. En el VPS, rellenar .env con secretos reales
cd /opt/docker/ai-scheduling
nano .env
chmod 600 .env

# 3. Verificar nombre real de la red NPM (este VPS: proxy-network)
docker network ls | grep -i proxy
# Ajustar NPM_NETWORK en .env si difiere

# 4. Pull + up
docker compose pull
docker compose up -d

# 5. Verificar healthchecks
docker compose ps
docker compose logs -f backend
curl -sS http://localhost:4000/health   # solo si exponés puerto temporal
```

## Operación

```bash
# Logs
docker compose logs -f backend
docker compose logs -f frontend

# Restart 1 servicio
docker compose restart backend

# Update a una imagen nueva
# Opción A — pin a SHA en .env:
sed -i 's/^BACKEND_TAG=.*/BACKEND_TAG=abc1234/' .env
docker compose pull backend
docker compose up -d backend

# Opción B — quedarse en latest:
docker compose pull && docker compose up -d

# Rollback rápido
sed -i 's/^BACKEND_TAG=.*/BACKEND_TAG=<sha-anterior>/' .env
docker compose up -d backend
```

## Conexión con NPM

Una vez levantado, en NPM crear los proxy hosts (Fase 5):

| Domain                       | Forward host | Port | Scheme |
|------------------------------|--------------|------|--------|
| `app.islabroadcast.com`      | `as-frontend`| 80   | http   |
| `api.islabroadcast.com`      | `as-backend` | 4000 | http   |

NPM resuelve los hostnames vía la red docker compartida `proxy-network`.

### Bake-time vs runtime

El frontend (Vite) bakea `VITE_API_URL` en build time — está incrustado
en el bundle JS. Cambiar el dominio del API requiere:

1. Actualizar el GitHub Actions Secret `STAGING_VITE_API_URL` del repo
   del frontend.
2. Disparar un re-run del workflow (push o `workflow_dispatch`).
3. En el VPS: bumpear `FRONTEND_TAG` en `.env` al nuevo SHA + pull + up.

El backend lee todo en runtime → cambiar `.env` + restart, no rebuild.

