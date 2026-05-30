# ZKPerp Bot

Orchestrator / keeper bot for ZKPerp. Each instance watches **one market**, reads the quorum price from `zkperp_oracle_v3.aleo`, scans the orchestrator's private auth records, and executes liquidations, TP/SL orders, and limit orders on the corresponding `zkperp_core` program — then keeps pool open-interest and net PnL in sync on-chain. Aligned to `zkperp_core_v29c.aleo` (1-of-3 keeper race) and `zkperp_oracle_v3.aleo` (2-of-3 Chainlink quorum).

**Deployed at:** [zkperp-bot.onrender.com](https://zkperp-bot.onrender.com)

> **Oracle note:** this bot does **not** submit prices and does **not** receive `POST /oracle/update`. Price submission lives in the separate oracle relayer stack (`zkperp_oracle_v3.aleo`); this bot only *reads* `oracle_prices` on each scan.

---

## What It Does

Everything runs off a single scan loop (`SCAN_INTERVAL`, default 60s):

| Step | Description |
|---|---|
| Oracle read | Reads the committed price from `zkperp_oracle_v3.aleo::oracle_prices/{assetKey}` (BTC=`1field`, ETH=`2field`, SOL=`3field`) |
| Liquidation scan | Scans `LiquidationAuth` records; liquidates positions whose equity is below the **5%** maintenance margin (`MAINTENANCE_MARGIN_BPS = 50_000`). The threshold and the 10%-of-collateral reward are enforced/derived **on-chain** — the bot only mirrors the math to decide *when* to fire `liquidate` |
| TP/SL execution | Scans `ExecTPSLAuth` records; calls `execute_take_profit` / `execute_stop_loss` when the price trigger is met |
| Limit execution | Scans `ExecLimitAuth` records; calls `execute_limit_order` when price crosses the trigger |
| Pending orders | Scans `PendingOrder` records to keep the in-memory order store current |
| Pool state sync | Calls `update_pool_state` with current long/short OI from the scanned positions |
| Net PnL | Calls `update_net_pnl` with the aggregated net unrealised PnL across open positions |

All transactions are proven via **Provable DPS** (delegated proving, `@provablehq/sdk` + `provable-client.mjs`). No local snarkOS or WASM proving.

### Keeper race (1-of-3)

`zkperp_core_v29c.aleo` mints one `LiquidationAuth` per keeper, and any single keeper may liquidate. Run **three independent instances**, each with its own `PRIVATE_KEY` and its own `KEEPER_ADDRESS`:

- `KEEPER_ADDRESS` — this keeper's address; checked against the on-chain `liquidator_set` at startup. If unset, the membership check is skipped and `liquidate` will simply revert on-chain if this key isn't a current keeper.
- `KEEPER_INDEX` (`0`/`1`/`2`) + `RACE_STAGGER_MS` — optional; adds `index × stagger` delay before firing so the three keepers don't all prove the same liquidation simultaneously. Leave unset for an even race.

---

## One bot per market

A single instance serves one market, selected by `PROGRAM_ID` + `ASSET_ID`:

```bash
# BTC
PROGRAM_ID=zkperp_core_v29c.aleo ASSET_ID=BTC_USD node zkperp-bot.mjs
# ETH
PROGRAM_ID=<eth core program>   ASSET_ID=ETH_USD node zkperp-bot.mjs
# SOL
PROGRAM_ID=<sol core program>   ASSET_ID=SOL_USD node zkperp-bot.mjs
```

Set `PROGRAM_ID`/`ASSET_ID` to the deployed core program and market each instance should serve. (The in-source example comment listing `v27`/`v26` program names is stale; the bot's constants and startup banner track `zkperp_core_v29c.aleo`.)

---

## Setup

```bash
npm install
cp .env.example .env      # fill in — see variables below
node zkperp-bot.mjs        # run the bot directly
```

For production, run the process manager (auto-restarts the bot on crash):

```bash
node zkperp-bot-manager.mjs   # = npm start
```

`package.json` scripts: `start` → manager, `start:bot` → bot directly, `dev` → manager. Node ≥ 18.

---

## Environment Variables

### Required

| Variable | Description |
|---|---|
| `PRIVATE_KEY` | Orchestrator/keeper Aleo private key (`APrivateKey1...`) |
| `VIEW_KEY` | Orchestrator view key — required for record scanning |
| `PROVABLE_API_KEY` | Provable API key (DPS proving + record scanning) |
| `PROVABLE_CONSUMER_ID` | Provable consumer ID |
| `PROGRAM_ID` | Core program this instance serves, e.g. `zkperp_core_v29c.aleo` |
| `ASSET_ID` | `BTC_USD` \| `ETH_USD` \| `SOL_USD` |

> The scanner is disabled if any of `PROVABLE_CONSUMER_ID`, `PROVABLE_API_KEY`, or `VIEW_KEY` is missing.

### Recommended

| Variable | Description |
|---|---|
| `KEEPER_ADDRESS` | This keeper's address; enables the startup `liquidator_set` membership check |
| `SCANNER_START_BLOCK` | Block height to begin scanning from (default `14864000`) — set to ≤ the block of the earliest open position you need to see |

### Optional (with defaults)

| Variable | Default | Description |
|---|---|---|
| `ORACLE_PROGRAM_ID` | `zkperp_oracle_v3.aleo` | Oracle program to read prices from |
| `NETWORK` / `NETWORK_ID` | `testnet` / `1` | Aleo network |
| `API_ENDPOINT` | `https://api.explorer.provable.com/v1/testnet` | Mapping/record reads |
| `QUERY_ENDPOINT` | `https://api.explorer.provable.com/v1` | Chain queries |
| `BROADCAST_ENDPOINT` | `…/v1/testnet/transaction/broadcast` | Tx broadcast |
| `SCAN_INTERVAL` | `60000` | Scan loop interval (ms) |
| `API_PORT` | `3001` | Bot HTTP port |
| `FRONTEND_ORIGIN` | `http://localhost:5173` | CORS origin |
| `KEEPER_INDEX` | — | `0`/`1`/`2`, for staggered racing |
| `RACE_STAGGER_MS` | `0` | Per-index liquidation delay (ms) |
| `EXEC_USE_FEE_MASTER` | `false` | Use fee master for proving |
| `MAX_RECORDS_PER_SCAN` | `50` | Cap on records processed per scan |
| `MAX_POSITION_STORE_SIZE` | `2000` | In-memory position cap |
| `POSITION_TTL_MS` | `1800000` | Position eviction age (30 min) |
| `POSITION_CLEANUP_INTERVAL_MS` | `300000` | Cleanup sweep interval (5 min) |

Manager-only: `MANAGER_PORT` (default `PORT` then `3000`), `BOT_PORT` (`3001`), `BOT_SCRIPT` (`./zkperp-bot.mjs`).

---

## API Endpoints

### Bot (`zkperp-bot.mjs`, port `API_PORT`)

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Status: programId, oracleProgramId, assetId, current price, net PnL, store sizes, last scan, paused, upSince |
| `/api/liq-auths` | GET | All known open `LiquidationAuth` positions |
| `/api/liq-auths/:posId` | GET | Single position by ID |
| `/api/pending-orders` | GET | Known pending limit/TP/SL orders |
| `/api/liquidator-set` | GET | On-chain `liquidator_set` (the three keeper addresses) |
| `/api/order-by-nonce/:nonce` | GET | Resolve an order id/type from a nonce |
| `/api/register-slot` | POST | Frontend registers a position slot plaintext for a limit order |
| `/api/bot/pause` · `/api/bot/resume` | POST | Pause / resume the scan loop |

### Manager (`zkperp-bot-manager.mjs`, port `MANAGER_PORT`)

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Manager liveness (always 200 while the manager is up) |
| `/status` | GET | Bot process status + restart count |
| `/start` · `/stop` · `/restart` | POST | Control the child bot process |
| `/api/*`, `/bot-health` | proxy | Forwarded to the bot (`/bot-health` → bot `/health`) |

---

## Architecture

```
zkperp_oracle_v3.aleo  (2-of-3 Chainlink quorum, separate relayer stack)
        │  oracle_prices mapping
        ▼  (read each scan)
zkperp-bot.mjs  ── scan loop every SCAN_INTERVAL ──
        │
        ├── read oracle price (oracle_prices/{assetKey})
        ├── scan LiquidationAuth → liquidate()            if equity < 5% maint margin
        ├── scan ExecTPSLAuth    → execute_take_profit / execute_stop_loss  on trigger
        ├── scan ExecLimitAuth   → execute_limit_order    on trigger
        ├── scan PendingOrder    → refresh pendingOrderStore
        ├── update_pool_state    → sync long/short OI
        └── update_net_pnl       → aggregated net unrealised PnL
        │
        └── HTTP server (API_PORT) — /health, /api/*

zkperp-bot-manager.mjs (MANAGER_PORT) — spawns the bot, auto-restarts on crash,
                                        proxies /api/* + /bot-health, exposes /start /stop /restart
```

### Provable Scanner

Uses the Provable Record Scanner (`@provablehq/sdk`) to find the orchestrator's private records, registered from `SCANNER_START_BLOCK` so it skips pre-deployment history:

- `LiquidationAuth` — minted on every `open_position` (entry price + size + direction per keeper)
- `ExecTPSLAuth` — minted on `place_take_profit` / `place_stop_loss`
- `ExecLimitAuth` — minted on `place_limit_order`
- `PendingOrder` — pending order bookkeeping

If Provable credentials are missing or the scanner is unavailable, the bot logs that scanning is disabled / using fallbacks.

### Pool state & PnL sync

Because core `finalize` blocks don't recompute pool aggregates on every trade, the bot calls:

- `update_pool_state` — `long_open_interest` / `short_open_interest` computed from the in-memory position store; `total_liquidity` / `total_lp_tokens` / `accumulated_fees` read from the on-chain `pool_state` mapping.
- `update_net_pnl` — net unrealised PnL aggregated across open positions at the current oracle price.

---

## Deployment on Render

Runs as a **Starter** web service (always-on, Frankfurt), started via the manager:

```
startCommand: node zkperp-bot-manager.mjs
healthCheckPath: /health
```

The manager spawns `zkperp-bot.mjs` and restarts it on crash. Set the required secrets (`PRIVATE_KEY`, `VIEW_KEY`, `PROVABLE_API_KEY`, `PROVABLE_CONSUMER_ID`) in the Render dashboard, plus `PROGRAM_ID` and `ASSET_ID` for the market.

> **render.yaml cleanup:** the committed `render.yaml` still carries legacy keys from the old multi-market design (`PROGRAM_ID_BTC/ETH/SOL`, `PRICE_INTERVAL`, `DISABLE_ORACLE`, `ORACLE_TOKEN`) that the current `zkperp-bot.mjs` does **not** read, and a stale `PROGRAM_ID=zkperp_core_v27.aleo`. Update `PROGRAM_ID` to the deployed core program and prune the unused keys.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `[SCAN] No open positions` after `open_position` | `SCANNER_START_BLOCK` must be ≤ the block of the `open_position` tx |
| `[SCAN] Provable Scanner failed: 401` | Two instances sharing scanner credentials — wait for the old one to die or restart |
| Scanner disabled at startup | Missing one of `PROVABLE_CONSUMER_ID` / `PROVABLE_API_KEY` / `VIEW_KEY` |
| `liquidate` reverts | This key isn't in the on-chain `liquidator_set`; set `KEEPER_ADDRESS` and register the keeper via the core admin |
| Price reads as 0 / stale | Oracle relayer stack not running, or `oracle_prices` not yet committed for this `ASSET_ID`; check `ORACLE_PROGRAM_ID` |
| `Could not parse pool_state` | `pool_state` not initialized — initialize the pool/slots first |
| Wrong market | `PROGRAM_ID` / `ASSET_ID` mismatch — one instance per market |
