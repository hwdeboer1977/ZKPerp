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
│  zkperp_core_v26.aleo (BTC) · zkperp_eth_v21.aleo · zkperp_sol_v21  │
│  zkperp_compliance_v7.aleo · zkperp_oracle_v2.aleo                   │
│  zkdarkpool_v5.aleo · zkperp_amm_v1.aleo                             │
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
├── contracts/                        # Leo smart contracts
│   ├── zkperp_core_v26/
│   │   └── src/main.leo              # BTC/USDC perpetuals (v26, oracle-integrated)
│   ├── zkperp_eth_v21/
│   │   └── src/main.leo              # ETH/USDC perpetuals contract
│   ├── zkperp_sol_v21/
│   │   └── src/main.leo              # SOL/USDC perpetuals contract
│   ├── zkperp_oracle_v2/
│   │   └── src/main.leo              # 2-of-3 on-chain quorum oracle
│   ├── zkperp_compliance_v7/
│   │   └── src/main.leo              # KYC compliance gating
│   ├── zkperp_amm_v1/
│   │   └── src/main.leo              # Uniswap v3-style CL AMM (USDCx/ALEO)
│   └── zkdarkpool_v5/
│       └── src/main.leo              # ZK dark pool batch auction
│
├── frontend/                         # React + Vite + TypeScript frontend
│   ├── src/
│   │   ├── components/               # TradingWidget, PositionDisplay, LiquidityPanel, etc.
│   │   ├── hooks/                    # useSlots, useUSDCx, useCompliance, useOnChainData
│   │   ├── pages/                    # TradePage, LiquidityPage, DarkpoolPage, CompliancePage
│   │   ├── config/                   # pairs.ts — BTC/ETH/SOL market config + programIds
│   │   └── utils/                    # aleo.ts, merkleProof.ts
│   ├── .env.example
│   └── README.md                     # → docs/README_frontend.md
│
├── zkperp-bot/                       # Orchestrator + liquidation + TP/SL bot
│   ├── zkperp-bot.mjs                # Main bot: oracle, liquidation, TP/SL, limit, pool sync
│   ├── zkperp-bot-manager.mjs        # Process manager (auto-restart on crash)
│   └── README.md                     # → docs/README_bot.md
│
├── aleo-oracle/                      # 2-of-3 Chainlink oracle relay
│   ├── backend/
│   │   ├── manager.js                # Spawns 3 independent relayer processes
│   │   ├── relayer.js                # Per-relayer: reads Chainlink, submits on-chain
│   │   ├── shared/
│   │   │   ├── chainlink.js          # Chainlink feed reader (ethers v6)
│   │   │   └── aleoClient.js         # Provable SDK wrapper for submit_price
│   │   └── config/
│   │       └── markets.json          # BTC/ETH/SOL feed addresses + asset keys
│   └── README.md                     # → docs/README_oracle.md
│
├── zkperp-compliance/                # KYC compliance layer
│   ├── backend/
│   │   ├── index.js                  # Express API server
│   │   ├── compliance-tree.js        # Depth-10 BHP256 Merkle tree builder
│   │   ├── aleo-admin.js             # Delegated proving for update_root / revoke
│   │   ├── allowlist.json            # Approved addresses (off-chain)
│   │   └── hasher/                   # Leo hasher program for BHP256 hashing
│   │       └── src/main.leo
│   └── README.md                     # → docs/README_compliance.md
│
├── zkdarkpool/                       # ZK Dark Pool (batch auction DEX)
│   ├── contracts/
│   │   └── zkdarkpool_v5/
│   │       └── src/main.leo
│   ├── bot/                          # Operator bot: scans orders, runs clearing auction
│   ├── frontend/                     # React dark pool UI
│   └── README.md                     # → docs/README_darkpool.md
│
├── zkperp-amm/                       # Concentrated Liquidity AMM
│   ├── src/main.leo                  # Uniswap v3-style AMM (USDCx/ALEO, 0.3% fee)
│   ├── frontend/                     # Swap + liquidity UI
│   └── README.md                     # → docs/README_AMM.md
│
├── docs/
│   ├── README_bot.md
│   ├── README_oracle.md
│   ├── README_compliance.md
│   ├── README_darkpool.md
│   └── README_AMM.md
│
└── README.md                         # This file
```

---

## Deployed Contracts

| Program | Market / Purpose | Network | Explorer |
|---|---|---|---|
| `zkperp_core_v26.aleo` | BTC/USDC perpetuals | Aleo Testnet | [view](https://testnet.explorer.provable.com/program/zkperp_core_v26.aleo) |
| `zkperp_eth_v21.aleo` | ETH/USDC perpetuals | Aleo Testnet | [view](https://testnet.explorer.provable.com/program/zkperp_eth_v21.aleo) |
| `zkperp_sol_v21.aleo` | SOL/USDC perpetuals | Aleo Testnet | [view](https://testnet.explorer.provable.com/program/zkperp_sol_v21.aleo) |
| `zkperp_oracle_v2.aleo` | 2-of-3 price oracle | Aleo Testnet | [view](https://testnet.explorer.provable.com/program/zkperp_oracle_v2.aleo) |
| `zkperp_compliance_v7.aleo` | KYC compliance gating | Aleo Testnet | [view](https://testnet.explorer.provable.com/program/zkperp_compliance_v7.aleo) |
| `zkdarkpool_v5.aleo` | ZK dark pool batch auction | Aleo Testnet | [view](https://testnet.explorer.provable.com/program/zkdarkpool_v5.aleo) |
| `zkperp_amm_v1.aleo` | CL AMM (USDCx/ALEO) | Aleo Testnet | [view](https://testnet.explorer.provable.com/program/zkperp_amm_v1.aleo) |

---

## Components

### 🖥 Frontend

**Location:** [`frontend/`](./frontend)  
**Docs:** [`docs/README_frontend.md`](./docs/README_frontend.md)  
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
| `VITE_PROGRAM_ID_BTC` | `zkperp_core_v26.aleo` |
| `VITE_PROGRAM_ID_ETH` | `zkperp_eth_v21.aleo` |
| `VITE_PROGRAM_ID_SOL` | `zkperp_sol_v21.aleo` |
| `VITE_ORACLE_PROGRAM_ID` | `zkperp_oracle_v2.aleo` |
| `VITE_COMPLIANCE_API` | URL of the compliance server |

---

### 🤖 ZKPerp Bot

**Location:** [`zkperp-bot/`](./zkperp-bot)  
**Docs:** [`docs/README_bot.md`](./docs/README_bot.md)

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
| `PROGRAM_ID_BTC` | ✅ | `zkperp_core_v26.aleo` |
| `PROGRAM_ID_ETH` | ✅ | `zkperp_eth_v21.aleo` |
| `PROGRAM_ID_SOL` | ✅ | `zkperp_sol_v21.aleo` |
| `ORACLE_TOKEN` | ✅ | Shared secret matching oracle coordinator |
| `SCANNER_START_BLOCK` | ✅ | Block height of v26 deployment |

---

### 🔮 Aleo Oracle

**Location:** [`aleo-oracle/`](./aleo-oracle)  
**Docs:** [`docs/README_oracle.md`](./docs/README_oracle.md)

Three independent relayer processes each read Chainlink feeds and submit prices directly to `zkperp_oracle_v2.aleo`. The Leo contract enforces 2-of-3 quorum on-chain — no coordinator, no single point of failure. A single compromised key cannot commit a false price.

```
Chainlink ETH Mainnet (BTC/USD, ETH/USD)
Chainlink Arbitrum   (SOL/USD)
        │
        ├── Relayer-A (own Aleo key)
        ├── Relayer-B (own Aleo key)  ──▶ zkperp_oracle_v2.aleo/submit_price
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
| `ORACLE_PROGRAM` | `zkperp_oracle_v2.aleo` |
| `POLL_INTERVAL_MS` | Price polling interval (default 15000ms) |

> **Critical:** The oracle's `timestamp` field must be an Aleo **block height**, not a Unix timestamp. The contract computes `price_age = block.height - timestamp` and asserts it is below `MAX_PRICE_AGE_BLOCKS` (150 blocks ≈ 5 min). If the oracle goes offline, all `open_position` calls will fail after 150 blocks.

---

### 🛡 Compliance Server

**Location:** [`zkperp-compliance/`](./zkperp-compliance)  
**Docs:** [`docs/README_compliance.md`](./docs/README_compliance.md)

Privacy-preserving KYC layer. Manages the trader allowlist as a depth-10 BHP256 Merkle tree. Only the root is published on-chain — individual addresses are never revealed. Issues private `ZKPerpComplianceRecord`s that gate all trading functions.

**Flow:**
1. Trader completes KYC — address added to `allowlist.json`
2. Backend rebuilds Merkle tree, calls `update_root` on-chain (delegated proving)
3. Trader fetches their Merkle proof from the API
4. Trader calls `issue_compliance(proof)` — ZK proves allowlist membership
5. `ZKPerpComplianceRecord` issued to trader's wallet (valid ~90 days)
6. Every trade, the record is passed as input — contract asserts `issued_under == active_root` and `!is_revoked`

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
| `COMPLIANCE_PROGRAM_ID` | ✅ | `zkperp_compliance_v7.aleo` |
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
**Docs:** [`docs/README_darkpool.md`](./docs/README_darkpool.md)

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
| `PROGRAM_ID` | `zkdarkpool_v5.aleo` |
| `OPERATOR_PRIVATE_KEY` | Operator Aleo private key |
| `OPERATOR_VIEW_KEY` | Operator view key for record Unshieldion |
| `BATCH_BLOCKS` | Auction interval (default 500 blocks) |
| `START_BLOCK` | Block height of contract deployment |

---

### 📈 AMM

**Location:** [`zkperp-amm/`](./zkperp-amm)  
**Docs:** [`docs/README_AMM.md`](./docs/README_AMM.md)

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
| Liquidation threshold | 1% margin ratio |
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

**Dual-record liquidation:** `open_position` creates a `PositionSlot` (owned by trader) and a `LiquidationAuth` (owned by orchestrator). The orchestrator can liquidate without the trader being online; the trader can close without orchestrator involvement.

**Position commitment scheme:** Entry price, size, and collateral are hashed via BHP256 into a `PositionCommit` stored on-chain. Private witnesses are passed in `close_position` and verified against the stored hash — zero position data ever touches a public mapping.

**Cross-program oracle reads:** `zkperp_core_v26` reads prices via `Mapping::get(zkperp_oracle_v2.aleo::oracle_prices, asset_id)` — a cross-program mapping read. This avoids redundant price storage and ensures the core contract always reads the latest quorum-committed price.

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
cd contracts/zkperp_core_v26
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
VITE_PROGRAM_ID_BTC=zkperp_core_v26.aleo
VITE_PROGRAM_ID_ETH=zkperp_eth_v21.aleo
VITE_PROGRAM_ID_SOL=zkperp_sol_v21.aleo
VITE_ORACLE_PROGRAM_ID=zkperp_oracle_v2.aleo
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
- **Explorer (BTC):** [testnet.explorer.provable.com/program/zkperp_core_v26.aleo](https://testnet.explorer.provable.com/program/zkperp_core_v26.aleo)
- **Explorer (Oracle):** [testnet.explorer.provable.com/program/zkperp_oracle_v2.aleo](https://testnet.explorer.provable.com/program/zkperp_oracle_v2.aleo)
- **Explorer (Darkpool):** [testnet.explorer.provable.com/program/zkdarkpool_v5.aleo](https://testnet.explorer.provable.com/program/zkdarkpool_v5.aleo)
- **Shield Wallet:** [shieldwallet.xyz](https://www.shieldwallet.xyz/)
- **Aleo Explorer:** [testnet.explorer.provable.com](https://testnet.explorer.provable.com)

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

<p align="center"><b>Privacy-First Perpetuals on Aleo</b></p>
