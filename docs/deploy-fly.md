# Deploying Dejavu on Fly.io (minimum resources)

One shared-cpu-1x 256MB machine in Singapore, scales to zero when idle,
1GB encrypted volume for `data/recall.json` so the projection survives
restarts and redeploys. Typical cost: a few cents/month (volume ~$0.15).

## First time

```bash
fly apps create dejavu-memory
fly volumes create recall_data --region sin --size 1 -a dejavu-memory -y
```

## Secrets (from `.env.local`, never committed)

```bash
set -a; source .env.local; set +a
fly secrets set -a dejavu-memory \
  AUTH_SECRET="$AUTH_SECRET" \
  BEDROCK_API_KEY="$BEDROCK_API_KEY" \
  BEDROCK_TEXT_MODEL_ID="$BEDROCK_TEXT_MODEL_ID" \
  AI_PROVIDER="$AI_PROVIDER" \
  MEMWAL_PRIVATE_KEY="$MEMWAL_PRIVATE_KEY" \
  MEMWAL_ACCOUNT_ID="$MEMWAL_ACCOUNT_ID" \
  MEMWAL_SERVER_URL="$MEMWAL_SERVER_URL" \
  TYPESAFE_API_KEY="$TYPESAFE_API_KEY" \
  TYPESAFE_MODEL_ID="jev-latest" \
  APP_URL="https://dejavu-memory.fly.dev" \
  NODE_ENV="production"
```

## Deploy

```bash
fly deploy --ha=false
```

`fly.toml` pins everything: 256MB, `min_machines_running = 0`,
`suspend` on idle (wakes on next request), volume mount at `/app/data`,
health check on `/api/health`.

## Post-deploy

1. `GET https://dejavu-memory.fly.dev/api/health` → expect
   `status: ok`, `walrus.reachable: true`.
2. Seed production: sign in on the live URL as `demo@dejavu.app` and
   capture the demo stories (same texts as `pnpm seed`) — production
   namespaces are per-user, so local blobs don't transfer. Confirm
   `counts.walrus_blobs ≥ 10` via `/api/health`.
3. Watch logs: `fly logs -a dejavu-memory`. OOM on 256MB would show
   here — bump to 512MB in `fly.toml` if it ever happens.
