# ZKPerp — Privacy-First Perpetual Futures on Aleo

<p align="center">
  <img src="./assets/zkperp_mask_icon.png" alt="ZKPerp Logo" width="200"/>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Aleo-Testnet-blue" alt="Aleo Testnet">
  <img src="https://img.shields.io/badge/Leo-4.0-green" alt="Leo 4.0">
  <img src="https://img.shields.io/badge/License-MIT-yellow" alt="License">
  <img src="https://img.shields.io/badge/Status-Live-brightgreen" alt="Status">
</p>

ZKPerp is a decentralized perpetual futures exchange built natively on the Aleo blockchain. Position sizes, entry prices, leverage, and PnL are cryptographically private by default — hidden from all other market participants, including the protocol itself. Zero-knowledge proofs enforce every business rule on-chain without revealing trade details.

**Live:** [zk-perp.vercel.app](https://zk-perp.vercel.app)  
**Whitepaper:** [zkperp-whitepaper-v5.html](https://hwdeboer1977.github.io/ZKPerp/zkperp-whitepaper-v5.html)  
**Explorer:** [testnet.explorer.provable.com](https://testnet.explorer.provable.com)  
**GitHub:** [github.com/hwdeboer1977/ZKPerp](https://github.com/hwdeboer1977/ZKPerp)

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Repository Structure](#repository-structure)
- [Deployed Contracts](#deployed-contracts)
- [Components](#components)
  - [Frontend](#-frontend)
  - [ZKPerp Bot](#-zkperp-bot)
  - [Aleo Oracle](#-aleo-oracle)
  - [Compliance Server](#-compliance-server)
  - [ZK Darkpool](#-zk-darkpool)
  - [AMM](#-amm)
- [Protocol Parameters](#protocol-parameters)
- [Privacy Model](#privacy-model)
- [Key Design Decisions](#key-design-decisions)
- [Running Locally](#running-locally)
- [Deployment](#deployment)
- [Leo 4.0 Lessons Learned](#leo-40-lessons-learned)
- [Team](#team)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                      Frontend (Vercel)                               │
│   React + Vite + TypeScript · Shield Wallet · Provable SDK           │
│   Trade · Liquidity · ZK Darkpool · Portfolio · Compliance            │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ requestRecords / execute / Unshield
                               ▼
                       ┌───────────────┐
                       │ Shield Wallet │  Signs txs · Unshields private records
                       └───────┬───────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        Aleo Testnet                                  │
│  zkperp_core_v30.aleo (BTC) · zkperp_eth_v21.aleo · zkperp_sol_v21  │
│  zkperp_compliance_v9.aleo · zkperp_oracle_v4.aleo                   │
│  zkdarkpool_v9.aleo · zkperp_amm_v4.aleo                             │
│                                                                      │
│  Private records: PositionSlot · LiquidationAuth · LPSlot            │
│                   OrderReceipt · ExecTPSLAuth · ComplianceRecord      │
│  Public mappings: pool_state · oracle_prices · pending_orders        │
│                   compliance_root · active_position_ids               │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▲
         liquidate · execute_tp_sl · update_pool_state · submit_price
                               │
┌──────────────────────────────┴───────────────────────────────────────┐
│                  Infrastructure (Vultr VPS)                          │
│                                                                      │
│  ┌─────────────────────┐   ┌──────────────────┐   ┌──────────────┐  │
│  │   zkperp-bot        │   │  aleo-oracle     │   │  compliance  │  │
│  │  Orchestrator +     │   │  3-of-3 Chainlink│   │  server      │  │
│  │  liquidation engine │   │  price relay     │   │  KYC + Merkle│  │
│  └─────────────────────┘   └──────────────────┘   └──────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Repository Structure

```
ZKPerp/
├── leo/                              # All Leo smart contracts — one subfolder per program
│   ├── Core/                         # zkperp_core_v30.aleo — BTC/USDC perpetuals (keeper-race liquidation)
│   │   ├── src/main.leo
│   │   └── README_LEO_CORE.md
│   ├── AMM/                          # zkperp_amm_v4.aleo — Uniswap v3-style CL AMM (USDCx/ALEO)
│   │   ├── src/main.leo
│   │   └── README_LEO_AMM.md
│   ├── Compliance/                   # zkperp_compliance_v9.aleo — KYC compliance gating
│   │   ├── src/main.leo
│   │   └── README_LEO_COMPLIANCE.md
│   ├── Darkpool/                     # zkdarkpool_v9.aleo — ZK dark pool batch auction
│   │   ├── src/main.leo
│   │   └── README_LEO_DARKPOOL.md
│   └── Oracle/                       # zkperp_oracle_v4.aleo — 2-of-3 on-chain quorum oracle
│       ├── src/main.leo
│       └── README_LEO_ORACLE.md
│
│   # Frontends (React + Vite + Shield wallet)
├── frontend/                         # Main perps trading UI                    → README_MAIN_FRONTEND.md
├── zkperp-amm/                       # AMM swap / liquidity UI                   → README_AMM_FRONTEND.md
│
│   # Backends (Node.js services)
├── zkperp-bot/                       # Orchestrator: keeper/liquidation, TP/SL, limit, pool sync  → README_BOT_BACKEND.md
├── zkperp-oracle/                    # 2-of-3 Chainlink → Aleo price relay (3 relayers)           → README_ORACLE_BACKEND.md
├── zkperp-compliance/                # KYC compliance server (Merkle tree + delegated proving)    → README_COMPLIANCE_SERVER.md
│
│   # Combined frontend + backend
├── zkperp-darkpool/                  # Dark pool operator bot + React UI         → README_DARKPOOL_FE_BE.md
│
└── README.md                         # This file
```

---

## Deployed Contracts

| Program | Market / Purpose | Network | Explorer |
|---|---|---|---|
| `zkperp_core_v30.aleo` | BTC/USDC perpetuals | Aleo Testnet | [view](https://testnet.explorer.provable.com/program/zkperp_core_v30.aleo) |
| `zkperp_eth_v21.aleo` | ETH/USDC perpetuals | Aleo Testnet | [view](https://testnet.explorer.provable.com/program/zkperp_eth_v21.aleo) |
| `zkperp_sol_v21.aleo` | SOL/USDC perpetuals | Aleo Testnet | [view](https://testnet.explorer.provable.com/program/zkperp_sol_v21.aleo) |
| `zkperp_oracle_v4.aleo` | 2-of-3 price oracle | Aleo Testnet | [view](https://testnet.explorer.provable.com/program/zkperp_oracle_v4.aleo) |
| `zkperp_compliance_v9.aleo` | KYC compliance gating | Aleo Testnet | [view](https://testnet.explorer.provable.com/program/zkperp_compliance_v9.aleo) |
| `zkdarkpool_v9.aleo` | ZK dark pool batch auction | Aleo Testnet | [view](https://testnet.explorer.provable.com/program/zkdarkpool_v9.aleo) |
| `zkperp_amm_v4.aleo` | CL AMM (USDCx/ALEO) | Aleo Testnet | [view](https://testnet.explorer.provable.com/program/zkperp_amm_v4.aleo) |

---

## Components

### 🖥 Frontend

**Location:** [`frontend/`](./frontend)  
**Docs:** [`frontend/README_MAIN_FRONTEND.md`](./frontend/README_MAIN_FRONTEND.md)  
**Live:** [zk-perp.vercel.app](https://zk-perp.vercel.app)

React + Vite + TypeScript frontend deployed on Vercel. Integrates with the Shield wallet for private record management and transaction signing.

**Pages:**
- **Trade** — Open/close long and short positions, place limit orders with slippage control
- **Liquidity** — Add/remove liquidity to the BTC/ETH/SOL pools as a counterparty LP
- **ZK Darkpool** — Place private buy/sell orders in the batch auction dark pool
- **Portfolio** — View encrypted position records, PnL, open orders, LP positions
- **Compliance** — Issue/renew `ZKPerpComplianceRecord`, view Merkle proof status
- **System Status** — Oracle price freshness, pool utilization, bot health

**Key hooks:**
- `useSlots` — Unshields `PositionSlot` and `LPSlot` records from the Shield wallet
- `useUSDCx` — loads private USDCx Token records and computes total balance
- `useCompliance` — fetches compliance record, validates against on-chain root
- `useOnChainData` — reads public mappings (pool state, oracle prices, OI)
- `useTransaction` — submits and polls Aleo transactions with temp ID tracking

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev  # http://localhost:5173
```

| Env var | Description |
|---|---|
| `VITE_PROGRAM_ID_BTC` | `zkperp_core_v30.aleo` |
| `VITE_PROGRAM_ID_ETH` | `zkperp_eth_v21.aleo` |
| `VITE_PROGRAM_ID_SOL` | `zkperp_sol_v21.aleo` |
| `VITE_ORACLE_PROGRAM_ID` | `zkperp_oracle_v4.aleo` |
| `VITE_COMPLIANCE_API` | URL of the compliance server |

---

### 🤖 ZKPerp Bot

**Location:** [`zkperp-bot/`](./zkperp-bot)  
**Docs:** [`zkperp-bot/README_BOT_BACKEND.md`](./zkperp-bot/README_BOT_BACKEND.md)

Node.js orchestrator that keeps the protocol running. Handles oracle price updates, position liquidations, TP/SL execution, limit order execution, and pool state synchronisation.

| Function | Interval | Description |
|---|---|---|
| Oracle update | 30s | Receives 2-of-3 Chainlink quorum, submits `update_price` |
| Liquidation scan | 60s | Scans `LiquidationAuth` records, liquidates undercollateralised positions |
| TP/SL execution | 60s | Executes `ExecTPSLAuth` records when price trigger is met |
| Limit order execution | 60s | Executes `ExecLimitAuth` records when price crosses trigger |
| Pool state sync | post-scan | Calls `update_pool_state` with current long/short OI |
| PnL aggregation | post-oracle | Computes net unrealised PnL, submits `update_net_pnl` |

All transactions are proven via Provable DPS (delegated proving). No local `snarkOS` or WASM required.

```bash
cd zkperp-bot
npm install
cp .env.example .env
node zkperp-bot-manager.mjs  # auto-restart on crash
```

| Env var | Required | Description |
|---|---|---|
| `PRIVATE_KEY` | ✅ | Orchestrator Aleo private key |
| `PROVABLE_API_KEY` | ✅ | Provable API key for DPS proving |
| `PROVABLE_CONSUMER_ID` | ✅ | Provable consumer ID |
| `PROGRAM_ID_BTC` | ✅ | `zkperp_core_v30.aleo` |
| `PROGRAM_ID_ETH` | ✅ | `zkperp_eth_v21.aleo` |
| `PROGRAM_ID_SOL` | ✅ | `zkperp_sol_v21.aleo` |
| `ORACLE_TOKEN` | ✅ | Shared secret matching oracle coordinator |
| `SCANNER_START_BLOCK` | ✅ | Block height of the v29c deployment |

---

### 🔮 Aleo Oracle

**Location:** [`aleo-oracle/`](./aleo-oracle)  
**Docs:** relay → [`zkperp-oracle/README_ORACLE_BACKEND.md`](./zkperp-oracle/README_ORACLE_BACKEND.md) · contract → [`leo/Oracle/README_LEO_ORACLE.md`](./leo/Oracle/README_LEO_ORACLE.md)

Three independent relayer processes each read Chainlink feeds and submit prices directly to `zkperp_oracle_v4.aleo`. The Leo contract enforces 2-of-3 quorum on-chain — no coordinator, no single point of failure. A single compromised key cannot commit a false price.

```
Chainlink ETH Mainnet (BTC/USD, ETH/USD)
Chainlink Arbitrum   (SOL/USD)
        │
        ├── Relayer-A (own Aleo key)
        ├── Relayer-B (own Aleo key)  ──▶ zkperp_oracle_v4.aleo/submit_price
        └── Relayer-C (own Aleo key)
                                          2-of-3 agree → oracle_prices updated
```

**Asset keys:**

| Asset | Oracle key | Chainlink feed |
|---|---|---|
| BTC/USD | `1field` | `0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c` (ETH mainnet) |
| ETH/USD | `2field` | `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419` (ETH mainnet) |
| SOL/USD | `3field` | `0x24ceA4b8ce57cdA5058b924B9B9987992450590c` (Arbitrum) |

```bash
cd aleo-oracle/backend
npm install
cp .env.example .env
npm start  # spawns Relayer-A, B, C via manager.js
```

| Env var | Description |
|---|---|
| `ALEO_PRIVATE_KEY_A/B/C` | Independent Aleo keys for each relayer |
| `EVM_RPC_URL` | Ethereum mainnet RPC (Alchemy/Infura) |
| `EVM_RPC_URL_ARB` | Arbitrum mainnet RPC |
| `ORACLE_PROGRAM` | `zkperp_oracle_v4.aleo` |
| `POLL_INTERVAL_MS` | Price polling interval (default 15000ms) |

> **Critical:** The oracle's `timestamp` field must be an Aleo **block height**, not a Unix timestamp. The contract computes `price_age = block.height - timestamp` and asserts it is below `MAX_PRICE_AGE_BLOCKS` (150 blocks ≈ 5 min). If the oracle goes offline, all `open_position` calls will fail after 150 blocks.

---

### 🛡 Compliance Server

**Location:** [`zkperp-compliance/`](./zkperp-compliance)  
**Docs:** server → [`zkperp-compliance/README_COMPLIANCE_SERVER.md`](./zkperp-compliance/README_COMPLIANCE_SERVER.md) · contract → [`leo/Compliance/README_LEO_COMPLIANCE.md`](./leo/Compliance/README_LEO_COMPLIANCE.md)

Privacy-preserving KYC layer. Manages the trader allowlist as a depth-10 BHP256 Merkle tree. Only the root is published on-chain — individual addresses are never revealed. Issues private `ZKPerpComplianceRecord`s that gate all trading functions.

**Flow:**
1. Trader completes KYC — address added to `allowlist.json`
2. Backend rebuilds Merkle tree, calls `update_root` on-chain (delegated proving)
3. Trader fetches their Merkle proof from the API
4. Trader calls `issue_compliance(proof)` — ZK proves allowlist membership
5. `ZKPerpComplianceRecord` issued to trader's wallet (valid ~90 days)
6. Every trade, the record is passed as input — `zkperp_core` asserts `!is_revoked` and `block.height <= expires_at` (the root is verified at issuance, not re-checked per trade, so existing records survive a root rotation)

**Revocation** is instant via `revoke_user(address)` — no Merkle tree rotation needed.

```bash
cd zkperp-compliance/backend
npm install
cp .env.example .env
npm start
```

| Env var | Required | Description |
|---|---|---|
| `ADMIN_PRIVATE_KEY` | ✅ | Aleo deployer private key |
| `COMPLIANCE_PROGRAM_ID` | ✅ | `zkperp_compliance_v9.aleo` |
| `PROVABLE_API_KEY` | ✅ | For delegated proving of `update_root` |
| `ADMIN_API_KEY` | ✅ | Secret for admin endpoints |
| `LEO_BIN` | ✅ | Path to Leo binary (e.g. `~/.cargo/bin/leo`) |
| `LEO_HASHER_DIR` | ✅ | Path to the Leo BHP256 hasher program |

**API endpoints:**

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Server status, allowlist count, current root |
| `POST` | `/api/compliance/register` | Register address, rebuild tree, update root |
| `GET` | `/api/compliance/proof/:address` | Merkle proof (JSON + Leo format) |
| `GET` | `/api/compliance/status/:address` | Registration + revocation status |
| `POST` | `/api/compliance/revoke` | Admin: instantly blacklist an address |
| `POST` | `/api/compliance/unrevoke` | Admin: reinstate a revoked address |

> **Note:** The compliance server requires the Leo binary to compute BHP256 hashes that are byte-identical to the on-chain Leo circuit. It must run on a machine with Leo installed (`cargo install leo-lang`).

---

### 🌑 ZK Darkpool

**Location:** [`zkdarkpool/`](./zkdarkpool)  
**Docs:** app → [`zkperp-darkpool/README_DARKPOOL_FE_BE.md`](./zkperp-darkpool/README_DARKPOOL_FE_BE.md) · contract → [`leo/Darkpool/README_LEO_DARKPOOL.md`](./leo/Darkpool/README_LEO_DARKPOOL.md)

A privacy-preserving batch auction DEX on Aleo. Large orders can be matched without revealing trade details before execution. Order size, limit price, and trader identity remain private — only that a settlement occurred is visible on-chain.

**How it works:**
- Sellers escrow assets via `deposit_asset` — issues `DepositAuth` to operator
- Buyers and sellers place orders via `submit_order` — issues `OrderAuth` to operator
- Every ~500 blocks the operator bot runs a uniform clearing price auction
- Matched pairs settled via `settle_match` (ZK proof enforces price constraints)
- `FillReceipt` issued to both sides; USDCx payment transferred privately

**What leaks on-chain:** that a settlement occurred, clearing price, fee paid, order nonces consumed.  
**What stays private:** order size, exact limit prices, trader addresses, counterparty identity.

```bash
cd zkdarkpool/bot
npm install
npm start

cd zkdarkpool/frontend
npm install && npm run dev
```

| Env var | Description |
|---|---|
| `PROGRAM_ID` | `zkdarkpool_v9.aleo` |
| `OPERATOR_PRIVATE_KEY` | Operator Aleo private key |
| `OPERATOR_VIEW_KEY` | Operator view key for record Unshieldion |
| `BATCH_BLOCKS` | Auction interval (default 500 blocks) |
| `START_BLOCK` | Block height of contract deployment |

---

### 📈 AMM

**Location:** [`zkperp-amm/`](./zkperp-amm)  
**Docs:** contract → [`leo/AMM/README_LEO_AMM.md`](./leo/AMM/README_LEO_AMM.md) · frontend → [`zkperp-amm/README_AMM_FRONTEND.md`](./zkperp-amm/README_AMM_FRONTEND.md)

A Uniswap v3-style Concentrated Liquidity AMM for USDCx/ALEO with a 0.3% fee tier. LP positions are private records. Pool state (price, tick, liquidity) is public.

**Key parameters:**
- Tick spacing: 60 (matching Uniswap v3 0.3% pools)
- Price stored as Q64 fixed-point: `sqrt(price) × 2^64`
- Up to 4 tick crossings per swap (unrolled in Leo)
- Fee accrual via `fee_growth_global` pattern

```bash
cd zkperp-amm
leo build
leo deploy --network testnet

cd zkperp-amm/frontend
npm install && npm run dev
```

---

## Protocol Parameters

| Parameter | Value |
|---|---|
| Max leverage | 20× |
| Opening fee | 0.1% of position size |
| Maintenance margin | 5% of notional (`MAINTENANCE_MARGIN_BPS = 50_000`) |
| Liquidation reward | 10% of collateral (`LIQ_PENALTY_BPS = 100_000`) |
| LP withdrawal buffer | 10% of total liquidity |
| Oracle staleness limit | 150 blocks (≈ 5 min) |
| Compliance record validity | ~90 days (7,776,000 blocks) |
| Darkpool batch interval | ~500 blocks (≈ 50 min) |
| Darkpool fee | 0.10% |

---

## Privacy Model

| Data | Visibility | Mechanism |
|---|---|---|
| Position size, entry price, leverage | 🔒 Private | Encrypted `PositionSlot` record |
| Unrealised PnL | 🔒 Private | ZK transition, hash on-chain |
| LP balance | 🔒 Private | Encrypted `LPSlot` record |
| Order trigger prices (TP/SL/limit) | 🔒 Private | BHP256 hash until execution |
| Darkpool order size + limit price | 🔒 Private | Encrypted `OrderAuth` record |
| Trader KYC identity | 🔒 Private | Off-chain allowlist, only root on-chain |
| Total pool liquidity | 🌐 Public | `pool_state` mapping |
| Aggregate long/short open interest | 🌐 Public | `pool_state` mapping |
| Oracle prices | 🌐 Public | `oracle_prices` mapping |
| Position active/closed | 🌐 Public | Hash in `active_position_ids` |
| Darkpool clearing price | 🌐 Public | `finalize` argument (Aleo constraint) |

---

## Key Design Decisions

**Slot model — fixed record count:** Each trader holds exactly 3 records forever: 2 `PositionSlot` (long/short) + 1 `LPSlot`. Records are mutated in-place on every trade. After 1,000 trades the wallet still holds 3 records, keeping Shield wallet performance fast.

**Keeper-race liquidation (1-of-N):** `open_position` creates a `PositionSlot` (owned by the trader) and mints **three** `LiquidationAuth` records — one to each keeper in `liquidator_set`. Any single keeper can liquidate an underwater position without the trader being online (they race for a deterministic reward); the trader can always close without keeper involvement. Losing keepers reclaim stale auths via `burn_liquidation_auth`.

**Position commitment scheme:** Entry price, size, and collateral are hashed via BHP256 into a `PositionCommit` stored on-chain. Private witnesses are passed in `close_position` and verified against the stored hash — zero position data ever touches a public mapping.

**Cross-program oracle reads:** `zkperp_core_v30` reads prices via `Mapping::get(zkperp_oracle_v4.aleo::oracle_prices, asset_id)` — a cross-program mapping read. This avoids redundant price storage and ensures the core contract always reads the latest quorum-committed price.

**Per-market programs:** Three separate programs (`zkperp_btc`, `zkperp_eth`, `zkperp_sol`) are required by the privacy model. A shared `market_id` in `finalize` would be public and leak which market a trader is using — eliminating a key privacy property.

**Compliance via Merkle inclusion:** The allowlist is a depth-10 BHP256 Merkle tree. Only the root is on-chain. `issue_compliance` proves inclusion in ZK without revealing which leaf (which trader) is being proved. Revocation is via a separate `revoked` mapping — instant, no tree rebuild.

---

## Running Locally

### Prerequisites

- Node.js 20+
- Leo 4.0+ (`curl -L https://install.leo-lang.org | bash`)
- [Shield Wallet](https://www.shieldwallet.xyz/) browser extension
- Aleo testnet USDCx — bridge at [zk-perp.vercel.app](https://zk-perp.vercel.app)

### Frontend

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev
# http://localhost:5173
```

### Bot

```bash
cd zkperp-bot
npm install
cp .env.example .env
# Fill in PRIVATE_KEY, PROVABLE_API_KEY, PROVABLE_CONSUMER_ID, program IDs
node zkperp-bot-manager.mjs
```

### Oracle relay

```bash
cd aleo-oracle/backend
npm install
cp .env.example .env
# Fill in ALEO_PRIVATE_KEY_A/B/C, EVM_RPC_URL, EVM_RPC_URL_ARB
npm start
```

### Compliance server

```bash
# Requires Leo installed: cargo install leo-lang
cd zkperp-compliance/backend
npm install
cp .env.example .env

# Set up the Leo BHP256 hasher (run once)
mkdir -p /tmp/test_hashes/src
cat > /tmp/test_hashes/src/main.leo << 'LEO'
struct FieldPair { left: field, right: field }
program test_hashes_v1.aleo {
    fn get_leaf(addr: address) -> field { return BHP256::hash_to_field(addr); }
    fn get_node(left: field, right: field) -> field { return BHP256::hash_to_field(FieldPair { left, right }); }
}
LEO
echo '{"program":"test_hashes_v1.aleo","version":"0.0.1","description":"","license":"MIT"}' \
  > /tmp/test_hashes/program.json

npm start
# http://localhost:3001
```

### Deploy a contract

```bash
cd contracts/zkperp_core_v30
leo build
leo deploy \
  --private-key $PRIVATE_KEY \
  --endpoint https://api.explorer.provable.com/v1 \
  --network testnet
```

---

## Deployment

| Service | Platform | URL |
|---|---|---|
| Frontend | Vercel | [zk-perp.vercel.app](https://zk-perp.vercel.app) |
| zkperp-bot | Vultr VPS (PM2) | Internal |
| aleo-oracle | Vultr VPS (PM2) | Internal |
| compliance server | Vultr VPS (PM2) | Internal |

All backend services run on a single Vultr VPS (Ubuntu 24.04, 2GB RAM, Amsterdam) with Leo, Node.js 20, and PM2 installed. The VPS is required because the compliance server shells out to the Leo binary for BHP256 hashing.

**PM2 process list:**

```bash
pm2 list
# compliance      — node index.js            (zkperp-compliance/backend)
# zkperp-oracle   — node manager.js          (aleo-oracle/backend)
# zkperp-bot      — node zkperp-bot-manager  (zkperp-bot)

pm2 save
pm2 startup  # persist across reboots
```

**Required Vercel env vars:**

```
VITE_PROGRAM_ID_BTC=zkperp_core_v30.aleo
VITE_PROGRAM_ID_ETH=zkperp_eth_v21.aleo
VITE_PROGRAM_ID_SOL=zkperp_sol_v21.aleo
VITE_ORACLE_PROGRAM_ID=zkperp_oracle_v4.aleo
VITE_COMPLIANCE_API=http://<vultr-ip>:3001
```

---

## Leo 4.0 Lessons Learned

These constraints were discovered through production deployments and are documented here for future builders:

1. **Both ternary branches always evaluate** — never put a subtraction that could underflow in either branch. Use `a > b ? a - b : 0u64` pattern but be aware both sides are computed — the ternary only selects the result.

2. **`Mapping::get` in a ternary panics if key missing** — always use `Mapping::get_or_use` for any mapping access inside a ternary expression.

3. **`finalize` arguments are always public** — any value passed to a `finalize` function is visible on-chain. This means fill size, clearing price, and asset IDs in finalize are public even if the transition inputs are private.

4. **`final{}` is atomic** — if any assertion fails, no mapping writes occur. Use debug mappings as the only bisection tool.

5. **Q64 values overflow JavaScript `Number`** — always use `BigInt` for `u128` values and divide by `2^32` as bigint before converting to float.

6. **`Mapping::get` in cross-program reads** — reading from another program's mapping via `Mapping::get(other_program.aleo::mapping_name, key)` works in `finalize` but the program must be deployed and the mapping must exist on-chain.

7. **`self.caller` vs `self.signer`** — `self.caller` is the immediate caller (may be a program in a chain), `self.signer` is always the original wallet. Use `self.signer` for trader ownership checks.

8. **Per-market programs required for privacy** — a `market_id` parameter in `finalize` would be public, revealing which market a trader used. Separate programs per market eliminate this leak entirely.

---

## Team

| Name | Role | Contact |
|---|---|---|
| Henk-Wim de Boer | Lead Developer | Discord: @lupo1977 |

---

## Links

- **Frontend:** [zk-perp.vercel.app](https://zk-perp.vercel.app)
- **Whitepaper:** [zkperp-whitepaper-v5.html](https://hwdeboer1977.github.io/ZKPerp/zkperp-whitepaper-v5.html)
- **GitHub:** [github.com/hwdeboer1977/ZKPerp](https://github.com/hwdeboer1977/ZKPerp)
- **Explorer (BTC):** [testnet.explorer.provable.com/program/zkperp_core_v30.aleo](https://testnet.explorer.provable.com/program/zkperp_core_v30.aleo)
- **Explorer (Oracle):** [testnet.explorer.provable.com/program/zkperp_oracle_v4.aleo](https://testnet.explorer.provable.com/program/zkperp_oracle_v4.aleo)
- **Explorer (Darkpool):** [testnet.explorer.provable.com/program/zkdarkpool_v9.aleo](https://testnet.explorer.provable.com/program/zkdarkpool_v9.aleo)
- **Shield Wallet:** [shieldwallet.xyz](https://www.shieldwallet.xyz/)
- **Aleo Explorer:** [testnet.explorer.provable.com](https://testnet.explorer.provable.com)

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

<p align="center"><b>Privacy-First Perpetuals on Aleo</b></p>
