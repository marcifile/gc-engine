# gc-engine

Backend engine for **GC — going concern**.

GC launches token-funded companies with persistent founders. Creator rewards fund the work; founders research, create files, use tools, and keep operating over time.

## Current API

- `GET /health`
- `GET /concerns`
- `GET /concerns/:id`
- `POST /concerns`
- `POST /concerns/:id/notes`

The first seeded concern is `MESA / $MESA`.

## Next

1. Postgres persistence
2. OpenRouter founder loop
3. Browserbase live work session
4. Helius creator-reward accounting
5. Birdeye market data
6. files / calendar / outbox / ledger
