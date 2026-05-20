# @payradar/mcp

Model Context Protocol server for PayRadar. Lets any MCP-aware agent
(Claude Desktop, Cline, custom runtimes) discover ranked pay.sh endpoints
and cryptographically verify the scores it gets back — without trusting
the PayRadar server.

## Tools

### `discover`

Rank pay.sh endpoints by reliability, latency, and freshness. Returns up
to N signed scores. Filters:

- `capability` (string) — free-text capability tag (e.g. `Inbox`, `Domains`)
- `category` (string) — provider category (e.g. `messaging`, `finance`)
- `sort_by` — `score` (default) | `price` | `latency` | `confidence`
- `max_price_usd` (number) — reject endpoints over this per-call price
- `min_score` (0–100) — reject endpoints below this score
- `limit` (1–20, default 5)

### `verify_score`

Pass the `score_payload` field of any `discover` result. Fetches the
oracle's public key from `/.well-known/payradar-keys.json` and ed25519-
verifies the signature. Returns `{ok: true}` on success, `{ok: false, reason}` on failure.

## Install

```bash
npm install -g @payradar/mcp
```

Or run on-demand via `npx`:

```bash
npx -y @payradar/mcp
```

## Claude Desktop config

```json
{
  "mcpServers": {
    "payradar": {
      "command": "npx",
      "args": ["-y", "@payradar/mcp"]
    }
  }
}
```

## Pointing at a different deployment

Set `PAYRADAR_BASE_URL` if you've forked or self-hosted PayRadar.
Defaults to `https://pay-radar-web.vercel.app`.

```bash
PAYRADAR_BASE_URL=https://payradar.example.com npx -y @payradar/mcp
```

## License

MIT.
