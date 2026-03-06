# AI Scheduling Orchestrator

An enterprise SaaS scheduling system where employees interact via **WhatsApp voice messages**. AI processes intent, applies business rules, and auto-assigns shifts.

---

## Architecture

```
Employee (WhatsApp Audio)
    → Twilio Webhook
    → NestJS (Interface Layer)
    → Whisper API (Speech-to-Text)
    → Gemini 1.5 Pro (Intent Recognition)
    → CQRS Command Bus
    → Domain Layer (DDD + Policies)
    → pgvector RAG (Semantic Rules)
    → Scheduling Engine
    → PostgreSQL → Redis Queue → WhatsApp Response
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | NestJS + TypeScript |
| Database | PostgreSQL + pgvector |
| Cache / Queues | Redis + BullMQ |
| AI | Gemini 1.5 Pro + Whisper |
| Messaging | Twilio (WhatsApp) |
| Auth / DB | Supabase |
| Infra | Docker + Kubernetes + AWS |
| Frontend | Next.js + Recharts |

---

## Project Structure

```
src/
├── domain/          # Pure business logic (aggregates, value objects, policies)
├── application/     # Use cases (commands, queries, handlers)
├── infrastructure/  # Supabase, Redis, repositories
└── interfaces/      # HTTP controllers, DTOs, webhooks
```

---

## Key Design Decisions

- **No TypeORM / No Prisma** — manual repositories, full RLS control
- **Multi-tenant from day one** — Row-Level Security on PostgreSQL
- **CQRS everywhere** — no direct queries from controllers
- **Service role only** — never expose anon key on server side
- **12-Factor config** — all credentials via environment variables

---

## Build Scenarios

| # | Scenario | Status |
|---|---|---|
| 1 | Foundation — DDD, CQRS, Multi-tenant | ✅ Done |
| 2 | Scheduling Engine + Fairness Algorithm | ⬜ |
| 3 | Semantic Rule Engine (RAG + pgvector) | ⬜ |
| 4 | WhatsApp + Voice + Observer Pattern | ⬜ |
| 5 | Incident Management + OCR | ⬜ |
| 6 | Admin Frontend + Demand Heatmap | ⬜ |

---

## Getting Started

```bash
yarn install
npx supabase start   # PostgreSQL + Auth + Storage
docker-compose up    # API + Redis

yarn test:unit        # Domain layer (no network)
yarn test:integration # Requires supabase running
```

---

## License

UNLICENSED — Private project.
