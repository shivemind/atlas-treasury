# AtlasPayments — Treasury Service

Treasury domain service for AtlasPayments. Handles fund movement, reserves, holds, and reconciliation.

**Port:** `3004`

## Domains

### Transfers

Create, list, retrieve, and reverse fund transfers between accounts.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/transfers` | Create a transfer |
| GET | `/api/v1/transfers` | List transfers |
| GET | `/api/v1/transfers/:id` | Get transfer by ID |
| PATCH | `/api/v1/transfers/:id` | Update transfer |
| POST | `/api/v1/transfers/:id/reverse` | Reverse a transfer |

### Reserves

Place, list, retrieve, and release reserves on merchant funds.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/reserves` | Create a reserve |
| GET | `/api/v1/reserves` | List reserves |
| GET | `/api/v1/reserves/:id` | Get reserve by ID |
| PATCH | `/api/v1/reserves/:id` | Update reserve |
| POST | `/api/v1/reserves/:id/release` | Release a reserve |

### Holds

Create, list, retrieve, release, and capture temporary fund holds.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/holds` | Create a hold |
| GET | `/api/v1/holds` | List holds |
| GET | `/api/v1/holds/:id` | Get hold by ID |
| PATCH | `/api/v1/holds/:id` | Update hold |
| POST | `/api/v1/holds/:id/release` | Release a hold |
| POST | `/api/v1/holds/:id/capture` | Capture a hold |

### Reconciliation (Internal)

Manage reconciliation sources, imports, periods, diffs, and explanations.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/internal/recon/sources` | Create recon source |
| GET | `/api/internal/recon/sources` | List recon sources |
| GET | `/api/internal/recon/sources/:id` | Get recon source |
| PATCH | `/api/internal/recon/sources/:id` | Update recon source |
| DELETE | `/api/internal/recon/sources/:id` | Delete recon source |
| POST | `/api/internal/recon/sources/:id/imports` | Create import |
| GET | `/api/internal/recon/sources/:id/imports` | List imports |
| GET | `/api/internal/recon/sources/:id/imports/:importId` | Get import |
| PATCH | `/api/internal/recon/sources/:id/imports/:importId` | Update import |
| POST | `/api/internal/recon/periods` | Create recon period |
| GET | `/api/internal/recon/periods` | List recon periods |
| GET | `/api/internal/recon/periods/:id` | Get recon period |
| PATCH | `/api/internal/recon/periods/:id` | Update recon period |
| POST | `/api/internal/recon/periods/:id/close` | Close recon period |
| POST | `/api/internal/recon/periods/:id/diffs` | Create diff |
| GET | `/api/internal/recon/periods/:id/diffs` | List diffs |
| GET | `/api/internal/recon/periods/:id/diffs/:diffId` | Get diff |
| PATCH | `/api/internal/recon/periods/:id/diffs/:diffId` | Update diff |
| POST | `/api/internal/recon/periods/:id/diffs/:diffId/explanations` | Create explanation |
| GET | `/api/internal/recon/periods/:id/diffs/:diffId/explanations` | List explanations |

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |

## Development

```bash
pnpm install
pnpm prisma:generate
pnpm dev
```

## Testing

```bash
pnpm test
```

## Stack

- TypeScript, Next.js App Router
- Prisma (PostgreSQL)
- Zod (request validation)
- Upstash Redis (rate limits, idempotency cache)
