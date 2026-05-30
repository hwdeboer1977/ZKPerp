# ZK Darkpool — Setup

Repo for the **ZK Darkpool**, a privacy-preserving batch-auction DEX on Aleo. This README covers the two off-chain components in this workspace — the **frontend** (`frontend/`) and the **operator bot** (`darkpool-bot/`) — and how to run them together.

> **Scope:** the Leo contract (`src/main.leo`, `zkdarkpool_v*.aleo`) is documented separately in its own README. This document is the setup/run guide for the app and bot that sit around it.

```
zkperp-darkpool/
├── frontend/           # React + Vite trader UI  → "frontend" section below
├── darkpool-bot/       # Node operator bot       → "operator bot" section below
├── .env                # workspace-level env (per-component .env files also used)
└── .gitignore
```

The model: traders submit **encrypted orders** and escrow assets on-chain; the operator bot scans its own `OrderAuth` / `DepositAuth` records, runs a **uniform-clearing-price batch auction** every batch window, and settles matched pairs with on-chain ZK proofs. Order size, price, and trader identity stay private.

---

## ⚠️ Set the program ID before anything else

The deployed program ID is configured by env var in **both** components, and the committed defaults/examples are **stale** (they predate the current deployment):

| Source | Value as shipped |
|---|---|
| `frontend/.env.example` | `VITE_PROGRAM_ID=zkdarkpool_v2.aleo` |
| `frontend/src/darkpool.ts` + `main.tsx` default | `zkdarkpool_v4.aleo` |
| `darkpool-bot/config.mjs` default | `zkdarkpool_v5.aleo` |

Set `VITE_PROGRAM_ID` (frontend) and `PROGRAM_ID` (bot) to the **actually deployed** program (per the contract docs, `zkdarkpool_v8.aleo`) and keep them identical. Don't rely on the defaults.

---

## Frontend (`frontend/` — `zkdarkpool-ui`)

React + Vite + TypeScript trader UI; signs with the **Shield** wallet.

**Stack:** React 18, Vite 7, TypeScript 5.9, Tailwind 3.4, Provable Aleo wallet adaptor `0.3.0-alpha.3` (`core`/`react`/`react-ui`/`shield`/`standard` + `aleo-types`), `@provablehq/sdk` `0.10.1`. Wallet provider (`src/main.tsx`): single `ShieldWalletAdapter`, `TESTNET`, `autoConnect=false`, `decryptPermission=UponRequest`, decrypt programs `[VITE_PROGRAM_ID, VITE_USDCX_ID, credits.aleo]`.

**Tabs (`src/App.tsx`):** `Order`, `Receipts`, `Tools`, `Cancel`. The Order tab places buy/sell orders; Tools handles asset deposit/escrow and operator controls (force-match, fee withdrawal); Receipts loads `FillReceipt` records; Cancel invalidates open orders.

**Transitions it submits** (via the `useTransaction` hook + `TransactionStatus`, public fee):

| Transition | Where | Fee |
|---|---|---|
| `submit_order` | Order | 3 credits |
| `deposit_asset` | Tools | 3 credits |
| `cancel_buy_order` / `cancel_order` | Cancel | 3 credits |
| `cancel_and_refund_asset` | Cancel | 3 credits |
| `withdraw_fees` | Operator controls | 2 credits |

It reads the wallet's records via `requestRecords` + `Unshield` (USDCx `Token` and `Credentials`, plus the program's order/receipt/escrow records), builds Leo inputs in `src/darkpool.ts` (`buildSubmitOrderInputs`, `buildDepositAssetInputs`, `buildWithdrawFeesInputs`; `ASSETS = {0:BTC, 1:ETH, 2:SOL}`), and attaches the USDCx Merkle proof from `src/merkleProof.ts`. It calls the bot's HTTP API for `/deposits`, `/status`, and `/force-match`.

**Config (`frontend/.env`):**

```env
VITE_PROGRAM_ID=zkdarkpool_v8.aleo            # the deployed program (not the v2 in .env.example)
VITE_USDCX_ID=test_usdcx_stablecoin.aleo
VITE_NETWORK=testnet
VITE_API=https://api.explorer.provable.com/v1/testnet
VITE_OPERATOR_ADDRESS=aleo1...                # operator wallet address
VITE_BATCH_BLOCKS=30                          # match the bot's BATCH_BLOCKS
VITE_BOT_API=http://localhost:3001            # NOT in .env.example — add it; defaults to localhost:3001
```

> `VITE_BOT_API` is read by the app (`darkpool.ts`, `App.tsx`) but is missing from `.env.example` — add it, pointing at the bot's public URL in production.

**Run:**

```bash
cd frontend
npm install
cp .env.example .env   # then edit (set VITE_PROGRAM_ID, VITE_OPERATOR_ADDRESS, VITE_BOT_API)
npm run dev            # Vite dev server
npm run build          # tsc -b && vite build → dist/
```

---

## Operator bot (`darkpool-bot/` — `darkpool-bot`)

Node service that runs the matching engine and settles trades. It scans the chain for the operator's `OrderAuth` / `DepositAuth` records (no external order relay needed — the operator-auth record pattern delivers everything on-chain), keeps an in-memory order book, and every batch window runs the uniform-clearing-price matcher and submits `settle_match` via **Provable DPS** (delegated proving).

**Stack:** Node ≥ 18, `@provablehq/sdk` `0.10.1`, `better-sqlite3`, `dotenv`.

**Modules:**

```
index.mjs              # entry — poll loop, batch trigger, settlement orchestration, HTTP API
config.mjs             # env + protocol constants
scanner.mjs            # scan new OrderAuth / DepositAuth / OperatorOrderRef records
provable-scanner.mjs   # Provable Record Scanner wrapper
usdcx-scanner.mjs      # refresh operator USDCx Token + Credentials (records.json)
orderbook.mjs          # in-memory book + uniform-clearing-price matcher
settler.mjs            # build + submit settle_match (DPS, with leo-execute fallback)
api.mjs                # chain reads (block height, fee vault) + broadcast
scanner-state.mjs      # persist scan cursor
get-records.mjs · generate-operator-keys.mjs   # utilities
deposit-auths.json · records.json · scan-results.json   # state files
```

**Loop:** poll every `POLL_INTERVAL_MS` (default 15s); when `block ≥ lastBatch + BATCH_BLOCKS`, prune expired orders, match, and settle each pair (10-min per-settlement timeout). On confirmation it consumes the matched `DepositAuth` and refreshes USDCx records.

**HTTP API (port `BOT_PORT`, default 3001):**

| Endpoint | Method | Description |
|---|---|---|
| `/status` | GET | Current block, per-asset book counts, totals |
| `/deposits?address=` | GET | Known `DepositAuth`s, optionally filtered by seller |
| `/force-match` | POST | Manually trigger a match/settle cycle |

**Config (`darkpool-bot/.env` — no `.env.example` shipped; from `config.mjs`):**

Required (the bot throws on startup without these):

```env
OPERATOR_PRIVATE_KEY=APrivateKey1...
OPERATOR_VIEW_KEY=AViewKey1...
OPERATOR_ADDRESS=aleo1...
```

Optional (defaults shown):

```env
PROGRAM_ID=zkdarkpool_v8.aleo                              # set to the deployed program (default is v5)
USDCX_ID=test_usdcx_stablecoin.aleo
NETWORK=testnet
API=https://api.explorer.provable.com/v1/testnet
BATCH_BLOCKS=30                                            # keep in sync with VITE_BATCH_BLOCKS
POLL_INTERVAL_MS=15000
FEE_PER_TX=3000000                                         # 3 credits
START_BLOCK=0                                              # 0 → scan from currentBlock-500
BOT_PORT=3001
```

Plus, for the ECIES operator channel: run `node generate-operator-keys.mjs` once to mint a P-256 keypair, then set `OPERATOR_ECIES_PRIVATE_KEY` (bot) and `VITE_OPERATOR_PUBKEY_HEX` (frontend).

**Run:**

```bash
cd darkpool-bot
npm install
# create .env with the operator keys + PROGRAM_ID (see above)
npm start              # node index.mjs
```

---

## Running the whole thing

1. Deploy / confirm the contract program ID; set `PROGRAM_ID` (bot) and `VITE_PROGRAM_ID` (frontend) to it, identically.
2. Generate operator keys (`generate-operator-keys.mjs`); put the operator address in both `.env`s.
3. Start the **bot** (`darkpool-bot/`, port 3001) so its HTTP API is up.
4. Start the **frontend** (`frontend/`) with `VITE_BOT_API` pointing at the bot.
5. A trader connects Shield, deposits an asset (Tools → on-chain `DepositAuth` to operator), and places orders (Order). The bot scans, matches at the batch window, and settles; `FillReceipt`s appear under Receipts.

Keep `BATCH_BLOCKS` (bot) and `VITE_BATCH_BLOCKS` (frontend) equal so the UI's countdown matches the bot's cadence.

---

## Notes

- **Version drift is the most likely setup snag** — the shipped defaults reference `v2`/`v4`/`v5`; always set both program IDs explicitly to the deployed program.
- Neither component proxies through Vite; both talk directly to `api.explorer.provable.com`, and the frontend talks to the bot at `VITE_BOT_API`.
- The frontend never holds keys (Shield signs); the bot holds the **operator** key and is the only party that can call `settle_match` / `withdraw_fees`.
- For contract internals — transitions, mappings, the fee model, settlement constraints — see the `zkdarkpool` contract README.
