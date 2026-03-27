# ZKPerp — Privacy-First Perpetual Futures on Aleo

<p align="center">
  <img src="./assets/zkperp_mask_icon.png" alt="ZKPerp Logo" width="200"/>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Aleo-Testnet-blue" alt="Aleo Testnet">
  <img src="https://img.shields.io/badge/Leo-v2.0-green" alt="Leo v2.0">
  <img src="https://img.shields.io/badge/License-MIT-yellow" alt="License">
</p>

ZKPerp is a decentralized perpetual futures exchange built natively on the Aleo blockchain. Position sizes, entry prices, leverage, and PnL are cryptographically private by default — hidden from all other market participants, including the protocol itself. Below is the link to the latest version of the whitepaper.

**Live:** [zk-perp.vercel.app](https://zk-perp.vercel.app)  
**Whitepaper:** [zkperp-whitepaper-v4.html](https://hwdeboer1977.github.io/ZKPerp/zkperp-whitepaper-v4.html)  
**Explorer:** [testnet.explorer.provable.com](https://testnet.explorer.provable.com)

---

## Deployed Contracts

| Program               | Market   | Network      |
| --------------------- | -------- | ------------ |
| `zkperp_btc_v21.aleo` | BTC/USDC | Aleo Testnet |
| `zkperp_eth_v21.aleo` | ETH/USDC | Aleo Testnet |
| `zkperp_sol_v21.aleo` | SOL/USDC | Aleo Testnet |

---

## Repository Structure

```
ZKPerp/
├── contracts/                     # Leo smart contracts
│   ├── zkperp_btc_v21/
│   │   └── src/main.leo           # BTC/USDC perpetuals contract
│   ├── zkperp_eth_v21/
│   │   └── src/main.leo           # ETH/USDC perpetuals contract
│   ├── zkperp_sol_v21/
│   │   └── src/main.leo           # SOL/USDC perpetuals contract
│   └── zkdarkpool_v2/
│       └── src/main.leo           # ZK dark pool batch auction contract (coming soon)
│
├── frontend/                      # React + Vite + TypeScript frontend
│   ├── src/
│   │   ├── components/            # PositionDisplay, TradingWidget, PendingOrdersDisplay, etc.
│   │   ├── hooks/                 # useSlots, useOrderReceipts, useUSDCx, useOnChainData, useLPTokens
│   │   ├── pages/                 # TradePage, LiquidityPage, DarkpoolPage, PortfolioPage, CompliancePage
│   │   ├── contexts/              # PrivateDataContext (shared record state across components)
│   │   ├── config/                # pairs.ts — BTC/ETH/SOL market config + programIds
│   │   └── utils/                 # aleo.ts, merkleProof.ts
│   ├── .env.example
│   └── package.json
│
├── zkperp-bot/                    # Orchestrator + liquidation + oracle bot
│   ├── zkperp-bot.mjs             # Main bot: oracle, liquidation, TP/SL, limit orders, pool state
│   ├── zkperp-bot-manager.mjs     # Process manager (restarts bot on crash)
│   └── render.yaml                # Render deployment config
│
├── aleo-oracle/                   # 2-of-3 Chainlink oracle relay
│   ├── shared/                    # Shared types and secp256k1 signing utils
│   ├── relayer/                   # Relayer-A / B / C — reads Chainlink, signs payload
│   └── coordinator/
│       └── coordinator.js         # Collects 2-of-3 quorum signatures, fires price update
│
├── zkperp-whitepaper-v4.html      # Technical whitepaper — single source of truth
└── README.md                      # This file
```

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                    Frontend (Vercel)                              │
│   React + Vite · Shield Wallet Adapter · Provable SDK            │
│   Trade · Liquidity · ZK Darkpool · Portfolio · Compliance        │
└──────────────────────────┬───────────────────────────────────────┘
                           │ requestRecords / execute / decrypt
                           ▼
                   ┌───────────────┐
                   │ Shield Wallet │  Signs txs · Decrypts private records
                   └───────┬───────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Aleo Testnet                                   │
│  zkperp_btc_v21.aleo · zkperp_eth_v21.aleo · zkperp_sol_v21.aleo │
│  Private records: PositionSlot · LiquidationAuth · OrderReceipt  │
│  Public mappings: pool_state · oracle_prices · pending_orders    │
│  test_usdcx_stablecoin.aleo  (USDCx collateral)                  │
└──────────────────────────┬───────────────────────────────────────┘
                           ▲
       update_price · liquidate · execute_tp_sl · update_pool_state
                           │
┌──────────────────────────┴───────────────────────────────────────┐
│                 zkperp-bot (Render)                               │
│  Oracle updates · Liquidation · TP/SL execution · Pool state sync │
└──────────────────────────┬───────────────────────────────────────┘
                           ▲
              2-of-3 quorum price via POST /oracle/update
                           │
┌──────────────────────────┴───────────────────────────────────────┐
│           aleo-oracle coordinator (Render)                        │
│  Relayer-A + B + C  →  Chainlink ETH Mainnet / Arbitrum feeds    │
└──────────────────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

**Maximum privacy (v21):** `finalize` functions receive only BHP256 hashes and nonces — zero position data on-chain. All business logic (leverage limits, slippage, margin checks) is proven inside the ZK transition. An observer watching the chain cannot determine trade direction, size, or price.

**Slot model:** Each trader holds exactly 3 records forever — 2 `PositionSlot` (long/short) + 1 `LPSlot`. Records are mutated in place on every trade. After 1000 trades the wallet still holds 3 records.

**Dual-record liquidation:** `open_position` creates a `PositionSlot` (owned by trader) and a `LiquidationAuth` (owned by orchestrator). The orchestrator can liquidate without the trader being online; the trader can close without orchestrator involvement.

**2-of-3 Chainlink oracle:** Three independent relayers read Chainlink feeds. The coordinator fires `update_price` only when 2-of-3 agree on the same round. A single compromised relayer cannot post a false price.

**Trusted PnL aggregation:** The orchestrator holds `LiquidationAuth` records for all open positions, computes net PnL off-chain, and submits via `update_net_pnl`. If the bot is offline the pool defaults to zero — the conservative safe baseline.

---

## Protocol Parameters

| Parameter             | Value                  |
| --------------------- | ---------------------- |
| Max leverage          | 20×                    |
| Opening fee           | 0.1% of position size  |
| Liquidation threshold | 1% margin ratio        |
| Liquidation reward    | 0.5% of position size  |
| Max OI per side       | 50% of pool liquidity  |
| LP withdrawal buffer  | 10% of total liquidity |

---

## Privacy Model

| Data                                      | Visibility                                      |
| ----------------------------------------- | ----------------------------------------------- |
| Position size, entry price, leverage, PnL | 🔒 Private — encrypted Aleo record, trader only |
| Order trigger prices (TP/SL/limit)        | 🔒 Private — BHP256 hash until execution        |
| LP balance                                | 🔒 Private — encrypted LPSlot record            |
| Total pool liquidity                      | 🌐 Public mapping                               |
| Aggregate long/short open interest        | 🌐 Public mapping                               |
| Oracle prices                             | 🌐 Public mapping                               |
| Position active/closed status             | 🌐 Public mapping (hash only)                   |

---

## Running Locally

### Prerequisites

- Node.js 18+
- [Shield Wallet](https://www.shieldwallet.xyz/) browser extension
- Aleo testnet USDCx — bridge from Sepolia at [zk-perp.vercel.app](https://zk-perp.vercel.app)

### Frontend

```bash
cd frontend
npm install
cp .env.example .env.local
# Set VITE_BOT_API=https://zkperp-bot.onrender.com
npm run dev
# Runs at http://localhost:5173
```

### Bot

```bash
cd zkperp-bot
npm install

export PRIVATE_KEY=APrivateKey1...
export PROVABLE_API_KEY=...
export PROVABLE_CONSUMER_ID=...
export PROGRAM_ID_BTC=zkperp_btc_v21.aleo
export PROGRAM_ID_ETH=zkperp_eth_v21.aleo
export PROGRAM_ID_SOL=zkperp_sol_v21.aleo
export ORACLE_TOKEN=<shared secret>
export ZKPERP_ORCHESTRATOR_URL=http://localhost:3001
export SCANNER_START_BLOCK=15356000

node zkperp-bot.mjs
```

### Oracle relay

```bash
cd aleo-oracle
npm install
# Set relayer keys + coordinator URL in .env
node relayer/relayer.mjs        # Repeat for Relayer-B and Relayer-C
node coordinator/coordinator.js
```

### Deploy a contract

```bash
cd contracts/zkperp_btc_v21
leo build
leo deploy --private-key $PRIVATE_KEY --endpoint https://api.explorer.provable.com/v1
```

---

## Deployment

| Service      | Platform         | URL                                                        |
| ------------ | ---------------- | ---------------------------------------------------------- |
| Frontend     | Vercel           | [zk-perp.vercel.app](https://zk-perp.vercel.app)           |
| Bot          | Render (Starter) | [zkperp-bot.onrender.com](https://zkperp-bot.onrender.com) |
| Oracle relay | Render (Worker)  | Internal — posts to bot                                    |

**Required Vercel env vars:**

```
VITE_BOT_API=https://zkperp-bot.onrender.com
```

**Required Render env vars (zkperp-bot):**

```
PRIVATE_KEY
PROVABLE_API_KEY
PROVABLE_CONSUMER_ID
PROGRAM_ID_BTC=zkperp_btc_v21.aleo
PROGRAM_ID_ETH=zkperp_eth_v21.aleo
PROGRAM_ID_SOL=zkperp_sol_v21.aleo
ORACLE_TOKEN=<shared secret>
ZKPERP_ORCHESTRATOR_URL=https://zkperp-bot.onrender.com
SCANNER_START_BLOCK=15356000
```

**Required Render env vars (aleo-oracle):**

```
RELAYER_A_PRIVATE_KEY / RELAYER_B_PRIVATE_KEY / RELAYER_C_PRIVATE_KEY
RELAYER_A_ADDR / RELAYER_B_ADDR / RELAYER_C_ADDR
ZKPERP_ORCHESTRATOR_URL=https://zkperp-bot.onrender.com
ZKPERP_ORCHESTRATOR_TOKEN=<same as ORACLE_TOKEN>
```

---

## Documentation

| File                                                     | Purpose                                            |
| -------------------------------------------------------- | -------------------------------------------------- |
| [zkperp-whitepaper-v4.html](https://hwdeboer1977.github.io/ZKPerp/zkperp-whitepaper-v4.html) | Full technical whitepaper — single source of truth |
| [frontend/README.md](./frontend/README.md)               | Frontend component overview, wallet integration    |
| [zkperp-bot/README.md](./zkperp-bot/README.md)           | Bot architecture, endpoints, env vars              |
| [aleo-oracle/README.md](./aleo-oracle/README.md)         | 2-of-3 Chainlink oracle relay setup and config     |

---

## Links

- **Frontend:** [zk-perp.vercel.app](https://zk-perp.vercel.app)
- **GitHub:** [github.com/hwdeboer1977/ZKPerp](https://github.com/hwdeboer1977/ZKPerp)
- **Explorer:** [testnet.explorer.provable.com/program/zkperp_btc_v21.aleo](https://testnet.explorer.provable.com/program/zkperp_btc_v21.aleo)
- **Shield Wallet:** [shieldwallet.xyz](https://www.shieldwallet.xyz/)

---

## Team

| Name             | Role           | Discord   |
| ---------------- | -------------- | --------- |
| Henk-Wim de Boer | Lead Developer | @lupo1977 |

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

<p align="center"><b>Privacy-First Perpetuals on Aleo</b></p>
