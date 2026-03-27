# ZKPerp Bot

Orchestrator bot for ZKPerp — handles oracle price updates, liquidations, TP/SL execution, limit order execution, and pool state sync across all three markets (BTC/ETH/SOL).

**Deployed at:** [zkperp-bot.onrender.com](https://zkperp-bot.onrender.com)

---

## What It Does

| Function | Interval | Description |
|---|---|---|
| Oracle update | 30s | Receives 2-of-3 Chainlink quorum price from aleo-oracle coordinator, submits `update_price` on-chain |
| Liquidation scan | 60s | Scans `LiquidationAuth` records via Provable Scanner, liquidates positions below 1% margin |
| TP/SL execution | 60s | Scans `ExecTPSLAuth` records, executes take profit / stop loss when price trigger is met |
| Limit order execution | 60s | Scans `ExecLimitAuth` records, executes limit orders when price crosses trigger |
| Pool state sync | after each scan | Calls `update_pool_state` with current long/short OI from scanned positions |
| PnL aggregation | after oracle update | Computes net unrealised PnL across all open positions, submits `update_net_pnl` |

All transactions are proven via **Provable DPS** (delegated proving). No local snarkOS or WASM proving required.

---

## Setup

```bash
cd zkperp-bot
npm install
cp .env.example .env
# Fill in .env — see variables below
node zkperp-bot.mjs
```

For production, use the process manager which auto-restarts on crash:

```bash
node zkperp-bot-manager.mjs
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PRIVATE_KEY` | ✅ | Orchestrator Aleo private key (`APrivateKey1...`) |
| `PROVABLE_API_KEY` | ✅ | Provable API key for DPS proving and record scanning |
| `PROVABLE_CONSUMER_ID` | ✅ | Provable consumer ID |
| `PROGRAM_ID_BTC` | ✅ | `zkperp_btc_v21.aleo` |
| `PROGRAM_ID_ETH` | ✅ | `zkperp_eth_v21.aleo` |
| `PROGRAM_ID_SOL` | ✅ | `zkperp_sol_v21.aleo` |
| `ORACLE_TOKEN` | ✅ | Shared secret — must match `ZKPERP_ORCHESTRATOR_TOKEN` in aleo-oracle |
| `ZKPERP_ORCHESTRATOR_URL` | ✅ | Bot's own public URL (e.g. `https://zkperp-bot.onrender.com`) — used by oracle coordinator to POST prices |
| `SCANNER_START_BLOCK` | ✅ | Block height when v21 contracts were deployed (`15356000`) |
| `PROGRAM_ID` | optional | Legacy fallback (set to `zkperp_btc_v21.aleo`) |
| `API_PORT` | optional | HTTP server port (default: `3001`) |
| `EXEC_USE_FEE_MASTER` | optional | Use fee master for proving (default: `false`) |
| `DISABLE_ORACLE` | optional | Set `true` to skip oracle updates (useful for testing) |
| `ORACLE_INTERVAL` | optional | Oracle tick interval in ms (default: `30000`) |
| `SCAN_INTERVAL` | optional | Liquidation scan interval in ms (default: `60000`) |

---

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Liveness check — returns `{ ok: true }` |
| `/status` | GET | Bot status, current oracle price, last scan time, position store size |
| `/api/liq-auths` | GET | All active LiquidationAuth records in memory |
| `/oracle/update` | POST | Receive quorum price from aleo-oracle coordinator |

### POST /oracle/update

Called by the aleo-oracle coordinator when 2-of-3 relayers agree on a price.

```bash
curl -X POST https://zkperp-bot.onrender.com/oracle/update \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ORACLE_TOKEN" \
  -d '{"assetId":"BTC_USD","price":"6876167000000","updatedAt":"1234567890","roundId":"129127208515966880224"}'
# Expected: {"ok":true}
```

---

## Architecture

```
aleo-oracle coordinator
        │  POST /oracle/update (2-of-3 Chainlink quorum)
        ▼
zkperp-bot.mjs
        │
        ├── oracleTick()          → update_price (BTC/ETH/SOL) + update_net_pnl
        │
        ├── liquidationTick()     → scanViaProvableScanner()
        │   ├── LiquidationAuth   → liquidate() if margin < 1%
        │   ├── ExecTPSLAuth      → execute_take_profit / execute_stop_loss if trigger met
        │   ├── ExecLimitAuth     → execute_limit_order if price crosses trigger
        │   ├── PendingOrder      → update pendingOrderStore
        │   └── update_pool_state → sync long/short OI on-chain
        │
        └── HTTP server (port 3001)
                ├── GET  /health
                ├── GET  /status
                ├── GET  /api/liq-auths
                └── POST /oracle/update
```

### Provable Scanner

The bot uses the Provable Record Scanner (`@provablehq/sdk`) to find private records owned by the orchestrator wallet:

- `LiquidationAuth` — created on every `open_position`, contains entry price + size + direction
- `ExecTPSLAuth` — created on every `place_take_profit` / `place_stop_loss`
- `ExecLimitAuth` — created on every `place_limit_order`
- `PendingOrder` — created on every limit order placement

The scanner is registered from `SCANNER_START_BLOCK` so it only scans blocks after v21 deployment, not the full chain history.

### Pool State Sync

Because v21 `finalize` functions no longer update `pool_state` directly, the bot calls `update_pool_state` after each scan with:
- `total_liquidity` — read from on-chain `pool_state` mapping
- `long_open_interest` / `short_open_interest` — computed from in-memory `positionStore`
- `total_lp_tokens` / `accumulated_fees` — read from on-chain `pool_state` mapping

### Fallback Oracle

If no fresh Chainlink quorum price is available (aleo-oracle not running), the bot falls back to Binance → CoinGecko for BTC only. ETH and SOL have no fallback — they require the oracle relay to be running.

---

## Deployment on Render

The bot runs as a **Starter plan** web service on Render (always-on, Frankfurt region).

Start command:
```
node zkperp-bot-manager.mjs
```

The manager process spawns `zkperp-bot.mjs` as a child and restarts it automatically on crash. Render's health check hits `GET /health`.

Required env vars in Render dashboard — see Environment Variables table above.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `[SCAN] No open positions` after open_position | Check `SCANNER_START_BLOCK` — must be ≤ the block of the open_position tx |
| `[SCAN] Provable Scanner failed: 401` | Two bot instances running simultaneously — old instance still holding scanner credentials. Wait for old instance to die or restart service. |
| `[ORACLE] All price sources failed: HTTP 403` | Binance geo-blocks Frankfurt. Deploy aleo-oracle relay so Chainlink quorum is used instead of Binance fallback. |
| `[POOL] Could not parse pool_state` | `pool_state` mapping not initialized — call `initialize_slots` first via the frontend. |
| `update_net_pnl failed` | Check `PROGRAM_ID` env var — must be `zkperp_btc_v21.aleo`, not `zkperp_v21.aleo` (nonexistent). |
| Bot not receiving oracle prices | Check `ZKPERP_ORCHESTRATOR_URL` in aleo-oracle matches bot's public URL. Check `ORACLE_TOKEN` matches `ZKPERP_ORCHESTRATOR_TOKEN`. |
