# aleo-oracle

2-of-3 threshold oracle relay: Chainlink (ETH Mainnet + Arbitrum) → ZKPerp bot → Aleo testnet.

## Architecture

```
Chainlink ETH Mainnet (BTC/USD, ETH/USD)
Chainlink Arbitrum    (SOL/USD)
        │
        ▼
Relayer A ──┐
Relayer B ──┼──► Coordinator (port 3010) ──► ZKPerp Bot (POST /oracle/update)
Relayer C ──┘                                      │
                                                   ▼
                                     Aleo: zkperp_v19.aleo   (BTC)
                                           zkperp_v19b.aleo  (ETH)
                                           zkperp_v19c.aleo  (SOL)
```

Each relayer independently reads Chainlink feeds via `latestRoundData()`, signs
the canonical payload with its secp256k1 key, and POSTs to the coordinator.
When 2-of-3 relayers agree on the exact same payload, the coordinator forwards
it to the ZKPerp bot's `POST /oracle/update` endpoint. The bot then calls
`update_price` on the relevant Aleo program (one per asset).

### Key design decisions

- **Per-asset program fan-out** — BTC, ETH, SOL each have their own deployed Aleo program. The bot routes each quorum price to the correct program.
- **1% deviation guard** — the bot only submits an on-chain update if price moved ≥1% from the current on-chain value. Saves transaction fees.
- **Sequential Provable submission** — assets are updated one at a time (BTC → ETH → SOL) with a 3s gap to avoid Provable rate limits.
- **Binance fallback** — if no fresh quorum price is available (oracle not running), the bot falls back to Binance/CoinGecko for BTC only.
- **Deduplication** — coordinator will not resubmit the same `(assetId, roundId, updatedAt)` twice.

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Generate relayer signing keys

These are **secp256k1** keys used only for relayer-to-coordinator authentication.
They are NOT your Aleo keys.

```bash
node -e "
import('ethers').then(({ ethers }) => {
  ['A','B','C'].forEach(r => {
    const w = ethers.Wallet.createRandom();
    console.log(\`RELAYER_\${r}_PK=\${w.privateKey}\`);
    console.log(\`RELAYER_\${r}_ADDR=\${w.address}\`);
  });
});
"
```

### 3. Configure .env

```bash
cp .env.example .env
```

Fill in:

| Variable | Description |
|----------|-------------|
| `EVM_RPC_URL` | Ethereum Mainnet RPC (Alchemy/Infura) — used for BTC/USD and ETH/USD |
| `EVM_RPC_URL_ARB` | Arbitrum Mainnet RPC — used for SOL/USD |
| `RELAYER_A/B/C_PK` | Relayer private keys (generated above) |
| `RELAYER_A/B/C_ADDR` | Relayer addresses (generated above, used as coordinator allowlist) |
| `ZKPERP_ORCHESTRATOR_URL` | ZKPerp bot URL, e.g. `http://localhost:3001` |
| `ZKPERP_ORCHESTRATOR_TOKEN` | Shared secret — must match `ORACLE_TOKEN` in zkperp-bot `.env` |
| `POLL_INTERVAL_MS` | How often relayers poll Chainlink (default: `15000`) |

### 4. ZKPerp bot .env additions

Add these to your zkperp-bot `.env`:

```bash
ORACLE_TOKEN=same_value_as_ZKPERP_ORCHESTRATOR_TOKEN
PROGRAM_ID_BTC=zkperp_v19.aleo
PROGRAM_ID_ETH=zkperp_v19b.aleo
PROGRAM_ID_SOL=zkperp_v19c.aleo
```

### 5. Run

**Terminal 1 — ZKPerp bot:**
```bash
cd ~/ZKPerp/zkperp-bot
node zkperp-bot.mjs
```

**Terminal 2 — Oracle (coordinator + all 3 relayers):**
```bash
cd ~/ZKPerp/aleo-oracle
npm start
```

`npm start` runs `manager.js` which spawns the coordinator + relayers A/B/C as
child processes with auto-restart on crash.

### 6. Health checks

```bash
# Coordinator status + last 5 submissions
curl http://localhost:3010/health

# Full coordinator state (all entries in window, dedup keys)
curl http://localhost:3010/state

# ZKPerp bot status + current oracle price
curl http://localhost:3001/health
```

### 7. Test the oracle/update endpoint manually

```bash
curl -X POST http://localhost:3001/oracle/update \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ORACLE_TOKEN" \
  -d '{"assetId":"BTC_USD","price":"6876167000000","updatedAt":"1234567890","roundId":"129127208515966880224"}'
# Expected: {"ok":true}
```

---

## Feeds configured (config/markets.json)

| Market  | Chain            | Feed Address                               | Heartbeat | RPC env var       |
|---------|------------------|--------------------------------------------|-----------|-------------------|
| BTC/USD | ETH Mainnet (1)  | 0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c | 1h        | `EVM_RPC_URL`     |
| ETH/USD | ETH Mainnet (1)  | 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419 | 1h        | `EVM_RPC_URL`     |
| SOL/USD | Arbitrum (42161) | 0x24ceA4b8ce57cdA5058b924B9B9987992450590c | 1h        | `EVM_RPC_URL_ARB` |

Feed addresses are the **proxy** addresses from Chainlink docs. Always use the
proxy, never the underlying aggregator.

> Chainlink heartbeat is 1h but prices update immediately on >0.5% deviation.
> Polling every 15s means you catch price moves within 15s of Chainlink publishing them.

## Adding more markets

Add an entry to `config/markets.json`:

```json
"ASSET_USD": {
  "assetId": "ASSET_USD",
  "assetKey": "4field",
  "sourceChainId": 1,
  "feedAddress": "0x...",
  "priceDecimals": 8,
  "heartbeatSec": 3600,
  "rpcEnvVar": "EVM_RPC_URL"
}
```

Then add `PROGRAM_ID_ASSET=zkperp_vXX.aleo` to the bot `.env` and extend
`CONFIG.programs` in `zkperp-bot.mjs`.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `EADDRINUSE :::3010` | `kill $(lsof -t -i:3010)` then restart |
| `HTTP 405` on `/oracle/update` | Handler is above the `GET`-only guard — ensure you're running the latest `zkperp-bot.mjs` |
| `HTTP 401` on `/oracle/update` | `ORACLE_TOKEN` in bot `.env` doesn't match `ZKPERP_ORCHESTRATOR_TOKEN` in oracle `.env` |
| `ECONNREFUSED` from coordinator | Bot not running or wrong port in `ZKPERP_ORCHESTRATOR_URL` |
| Quorum fires but no Aleo update | Check `PROGRAM_ID_BTC/ETH/SOL` are set correctly in bot `.env` |
| ETH/SOL not updating | Start the oracle alongside the bot — fallback is BTC-only via Binance |

## Deployment on Render

- **aleo-oracle**: one Render service, start command `npm start`
- **zkperp-bot**: existing Render service, add `ORACLE_TOKEN` + `PROGRAM_ID_*` env vars
- Set `ZKPERP_ORCHESTRATOR_URL` in oracle to the Render URL of the bot service
- All 4 oracle processes (coordinator + 3 relayers) managed by `manager.js` with auto-restart
