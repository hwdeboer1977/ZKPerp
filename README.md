# ZKPerp - Privacy-First Perpetual Futures on Aleo

<p align="center">
  <img src="./assets/zkperp_mask_icon.png" alt="ZKPerp Logo" width="200"/>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Aleo-Testnet-blue" alt="Aleo Testnet">
  <img src="https://img.shields.io/badge/Leo-v2.0-green" alt="Leo v2.0">
  <img src="https://img.shields.io/badge/License-MIT-yellow" alt="License">
</p>

ZKPerp is a decentralized perpetual futures trading platform built on Aleo that enables private leveraged trading of crypto assets. Unlike traditional DEX perpetuals where all position data is publicly visible on-chain, ZKPerp leverages Aleo's zero-knowledge proofs to keep trader positions completely private while maintaining trustless execution.

## 🎯 Overview

### The Privacy Problem in DeFi Trading

Current perpetual DEXs (GMX, dYdX, Hyperliquid) expose all trading activity publicly:

- 📊 Position sizes and entry prices visible to everyone
- 🎯 Large traders get front-run by MEV bots
- 📈 Competitors can track and copy trading strategies
- ⚡ Liquidation levels are known, enabling targeted attacks

### ZKPerp's Solution

| Problem | Traditional DEX | ZKPerp |
|---|---|---|
| Position visibility | Everyone sees your size/leverage | Encrypted in private records ✅ |
| Entry price exposure | Public on-chain | Only you know ✅ |
| Liquidation hunting | Calculable by anyone | Hidden from other traders ✅ |
| Trading strategy | Fully transparent | Private execution ✅ |
| Position front-running | Vulnerable to MEV | Intent is hidden ✅ |

**Note on Oracle Updates:** Like all DEX perpetuals, oracle price updates are public by nature. However, ZKPerp mitigates oracle-based MEV through opening fees (0.1%), slippage protection parameters, and collateral requirements for trading.

### Key Features

- 🔒 **Privacy**: Position sizes, entry prices, and PnL are private (stored in Aleo records)
- ⚡ **Up to 20x Leverage**: Trade with capital efficiency
- 💧 **Zero Slippage**: Oracle-based pricing, no AMM curve
- 💰 **Single-Sided LP**: Deposit USDC only, no impermanent loss from token pairs
- 🚀 **Instant Liquidity**: Trade against the pool, no counterparty needed
- 🔗 **Real Token Transfers**: Integrated with official Aleo testnet USDCx (`test_usdcx_stablecoin.aleo`)
- 🛡️ **Dual-Record Liquidation**: Privacy-preserving liquidation via Option D architecture
- 🎰 **Slot Record Model**: Fixed-slot position records eliminate record accumulation
- 🤖 **Automated Oracle Bot**: Live Binance price feed with on-chain threshold updates

---

## 🆕 Major Changes in v12

### 1. Slot Record Model

#### The Problem: Record Accumulation in Aleo

In Aleo, every time a user opens a position, new private records are created and stored in their wallet. When the position is closed or liquidated, those records are consumed on-chain — but the wallet still retains the ciphertext history. The wallet has no reliable way to know which records are spent without either decrypting each one or querying the chain.

This creates a compounding UX problem: after N trades, the user has 2N records in their wallet (one `PositionSlot` + one `LiquidationAuth` per trade). Every time they open the positions panel, the app must request decryption of all N records — triggering N wallet approval popups. A trader who has made 10 trades needs to click "approve" 10 times just to see their one open position. At 50 trades it becomes unusable. The same problem applies to liquidity providers: every `add_liquidity` call created a new LP record, accumulating indefinitely.

#### The Solution: Persistent Slot Records

Instead of creating a fresh record on every trade, ZKPerp v12 introduces a **slot model** — one persistent record per trading slot per user, mutated in place rather than accumulated.

Each trader initializes a fixed set of slots once:
- **1 PositionSlot for Long** — `slot_id: 0u8`
- **1 PositionSlot for Short** — `slot_id: 1u8`
- **1 LPSlot** — single LP position, always merged

Each slot carries an `is_open` flag. Under the hood, every trade is a strict swap — you hand in your existing slot, the contract consumes it, and immediately returns it with updated data. The record itself is technically new each time (this is how Aleo's UTXO model works — records cannot be modified in place, only consumed and reissued), but the count never grows because every operation is exactly one slot in, one slot out.

```
open_position():
  Input:  PositionSlot { slot_id: 0u8, is_open: false, ... }              ← consumed
  Output: PositionSlot { slot_id: 0u8, is_open: true, size, entry_price } ← reissued

close_position() / liquidate():
  Input:  PositionSlot { slot_id: 0u8, is_open: true, ... }               ← consumed
  Output: PositionSlot { slot_id: 0u8, is_open: false, data zeroed }      ← reissued
```

Before v12, opening a position simply created a fresh record without consuming anything — so after 10 trades you had 10 records in your wallet, all needing to be decrypted just to find your one open position. Now the wallet always holds exactly **3 records** regardless of trading history. After 100 trades, it's still 3 records and 3 decrypt approvals — the same as day one.

#### Additional UX Improvements

- **Removed localStorage dependency**: `closed_positions` on-chain mapping is now the single source of truth for spent record detection
- **Pre-filtering using spent flag** before calling `decrypt()` — reduces wallet approval popups for the common case
- **Withdrawal UI** now shows how much is available to withdraw, accounting for open positions

#### User Flow After These Changes

1. New trader lands on Trade or Liquidity page → sees **"Initialize Account"** modal
2. Clicks initialize → one wallet approval → 3 slot records minted on-chain
3. Page shows **"Decrypt X slots to trade"** button → one more approval → slots decrypted into state
4. Trading and LP deposit now work, passing the slot plaintext as first input
5. Every subsequent visit: same 3 records, same 3 approvals — forever

---

### 2. Liquidation System

v12 completes the full liquidation lifecycle with the **dual-record (Option D)** architecture. When a position is opened, two records are created simultaneously:

```
open_position() creates TWO records:
├── PositionSlot      → owned by TRADER (for closing)
└── LiquidationAuth   → owned by ORCHESTRATOR (for liquidating)
```

When a trader opens a position, the contract simultaneously creates two records: a `PositionSlot` for the trader and a `LiquidationAuth` for the orchestrator. The orchestrator is a **single registered wallet** whose address is stored on-chain in the `roles` mapping. Because all position data lives in private records, the orchestrator needs its own copy — the `LiquidationAuth` — to know the position size, entry price, and collateral required to determine whether a position is underwater. Without it, liquidations would be impossible in a fully private system.

**Liquidation flow:**

1. The liquidation bot runs continuously on a server and uses the **Provable Record Scanner** to scan for `LiquidationAuth` records owned by the orchestrator wallet
2. When it detects a position whose margin ratio has fallen below 1%, it automatically submits a `liquidate()` transaction
3. The contract verifies the margin ratio on-chain using the live oracle price
4. The transition consumes the `LiquidationAuth` and atomically returns a fresh empty `PositionSlot` to the trader's address — the slot count never changes, no manual reclaim needed
5. The liquidator receives 0.5% of position size as reward; remaining collateral returns to the LP pool

**Key properties:**
- No trusted party can see the trader's `PositionSlot` — only the orchestrator holds `LiquidationAuth`
- The `active_position_ids` mapping prevents replay attacks
- Liquidations happen automatically — the bot handles everything without manual intervention

> 💡 **Testnet tip:** To save test token costs, a manual override switch is available on the Liquidate tab to trigger liquidations without waiting for the bot.

Full architecture details: [LIQUIDATION_ARCHITECTURE.md](LIQUIDATION_ARCHITECTURE.md)

---

### 3. Oracle Bot (Real Price Feed)

v12 ships a production oracle bot (`zkperp-bot-manager.mjs`) deployed on **Render** that pushes live BTC/USD prices on-chain directly from **Binance** (Chainlink and Pyth do not support Aleo yet).

```
Binance API (BTC/USD)
        │
        ▼
zkperp-bot-manager.mjs (Node.js, Render Starter)
        │  Polls every 30 seconds
        │  Fetches last confirmed on-chain price
        │  If Δprice > 1% → submit update_price() tx
        ▼
zkperp_v12.aleo :: update_price()
        │  Stores price in oracle_prices mapping
        ▼
Frontend reads oracle_prices mapping
        └── Displays live mark price to traders
```

**Key design decisions:**

- **Binance price feed**: The only viable option for now — Chainlink and Pyth do not yet support Aleo. Live BTC/USD spot price is fetched every 30 seconds.
- **1% threshold-gated updates**: Inspired by Synthetix — the bot only writes a new price on-chain when it has moved more than 1% from the last confirmed on-chain value. This keeps testnet transaction costs manageable while ensuring the mark price stays reasonably fresh.
- **On-chain comparison**: The threshold check always compares against the last *confirmed on-chain* price, not an in-memory cache. This prevents false negatives after bot restarts where the in-memory price would otherwise be stale.
- **`snarkos` binary via Git LFS**: The bot bundles a pre-built `snarkos` binary tracked via Git LFS, avoiding runtime compilation on Render's ephemeral instances.
- **`VITE_MANAGER_API_URL`**: The frontend at `zk-perp.vercel.app` calls the Render API to surface bot status and the last update timestamp in the UI.

**Bot endpoints (Render):**

| Endpoint | Description |
|---|---|
| `GET /health` | Liveness check |
| `GET /status` | Last price, last update block, next scheduled poll |
| `POST /update` | Manual price push (admin) |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend (React)                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ TradingWidget│  │PositionView │  │  LiquidityPanel    │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Shield Wallet Adapter                     │
│    (Transaction signing, Record decryption, Public fees)    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Aleo Blockchain                            │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                  zkperp_v12.aleo                       │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐  │  │
│  │  │PositionSlots│  │   LPSlots   │  │LiquidationAuth│  │  │
│  │  │  (private)  │  │  (private)  │  │  (private)   │  │  │
│  │  └─────────────┘  └─────────────┘  └──────────────┘  │  │
│  │  ┌─────────────┐  ┌─────────────┐                    │  │
│  │  │ Pool State  │  │Oracle Prices│  (public mappings) │  │
│  │  └─────────────┘  └─────────────┘                    │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │            test_usdcx_stablecoin.aleo                 │  │
│  │      (Official Aleo testnet USDCx stablecoin)         │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │  update_price()
┌─────────────────────────────────────────────────────────────┐
│              zkperp-bot-manager.mjs (Render)                 │
│         Live BTC/USD oracle — threshold-gated updates        │
└─────────────────────────────────────────────────────────────┘
```

A more detailed discussion on limitations and liquidation architecture:

- [LIMITATIONS.md](LIMITATIONS.md)
- [LIQUIDATION_ARCHITECTURE.md](LIQUIDATION_ARCHITECTURE.md)

### GMX-Style Liquidity Model

Unlike orderbook DEXs, ZKPerp uses a liquidity pool model:

1. **LPs deposit USDC** → Receive LP tokens representing pool share
2. **Traders open positions** → Pool takes the opposite side
3. **Oracle provides prices** → No AMM slippage
4. **Trader profits** → Pool pays out
5. **Trader losses** → Pool keeps collateral
6. **Fees accrue to pool** → LP tokens increase in value

---

## 📊 Economic Parameters

| Parameter | Value | Description |
|---|---|---|
| Max Leverage | 20x | Minimum 5% margin required |
| Opening Fee | 0.1% | Fee on position size |
| Liquidation Threshold | 1% | Margin ratio triggering liquidation |
| Liquidation Reward | 0.5% | Reward for liquidators |
| Max OI per Side | 50% | Of total pool liquidity |
| Borrow Fee | ~0.00001%/block | Funding rate for positions |

## 🔐 Privacy Model

| Data | Visibility | Storage |
|---|---|---|
| Position owner | Private | Record (PositionSlot) |
| Position size | Private | Record (PositionSlot) |
| Entry price | Private | Record (PositionSlot) |
| Collateral | Private | Record (PositionSlot) |
| Total pool liquidity | Public | Mapping |
| Open interest (aggregate) | Public | Mapping |
| Oracle prices | Public | Mapping |
| Position closed status | Public | Mapping (position_id only) |

Traders enjoy privacy for their individual positions while the protocol maintains public aggregate data for transparency and risk management.

---

## 🎬 Live Deployment

- **Network**: Aleo Public Testnet
- **Contract**: `zkperp_v12.aleo`
- **USDCx Token**: `test_usdcx_stablecoin.aleo`
- **Frontend**: [zk-perp.vercel.app](https://zk-perp.vercel.app)
- **Oracle Bot**: Render (Starter plan, `zkperp-bot-manager.mjs`)
- **Wallet**: [Shield Wallet](https://www.shieldwallet.xyz/) (Aleo's official testnet wallet with delegated proving)

### Core Features Demonstrated

✅ **Private Position Opening**
- Users deposit USDCx collateral and select long/short direction with leverage up to 20x
- Position details are stored in an encrypted private `PositionSlot` record — only the trader can see them

✅ **Private Position Closing**
- PnL is calculated against the live oracle price
- Collateral + profit (or minus loss) is returned to the trader
- The `PositionSlot` is consumed and an empty one returned — no on-chain trace of the position data

✅ **Liquidity Pool**
- LPs deposit USDCx and receive an `LPSlot` record tracking their share
- Pool pays winning traders and earns from losing traders
- Fees accumulate in the pool, increasing LP value over time

✅ **Automated Liquidation**
- The liquidation bot continuously scans for undercollateralized positions via Provable Record Scanner
- `LiquidationAuth` records enable the orchestrator to liquidate without seeing the trader's `PositionSlot`
- Liquidators earn 0.5% of position size as reward

✅ **Live Oracle Price Feed**
- BTC/USD prices pushed on-chain from Binance every 30 seconds (1% threshold-gated)
- Slippage protection ensures traders execute near the oracle price

### How to Test

1. **Install Shield Wallet** browser extension from [shieldwallet.xyz](https://www.shieldwallet.xyz/)
2. **Connect wallet** to the ZKPerp frontend (public testnet)
3. **Get USDCx** by bridging USDC from Sepolia via the Bridge link in the app
4. **Initialize account** — mints your 3 slot records (one-time setup)
5. **Add Liquidity** or **Open Position**

> **Note:** Shield Wallet uses delegated proving, reducing transaction times from 30+ seconds to ~14 seconds. All fees are paid publicly (no private fee records needed).

---

## 🚀 Getting Started

### Prerequisites

- Leo CLI v2.0+
- Node.js 18+
- [Shield Wallet](https://www.shieldwallet.xyz/) browser extension (recommended) or Leo Wallet

### Installation

```bash
# Clone the repository
git clone https://github.com/hwdeboer1977/ZKPerp.git
cd ZKPerp

# Build the Leo contract
cd leo
leo build

# Install frontend dependencies
cd ../frontend
npm install
npm run dev
```

### Local Development

**Terminal 1: Start local devnet**
```bash
cd ~/ZKPerp/leo
leo devnet --snarkos $(which snarkos) --snarkos-features test_network \
  --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11 --clear-storage
```

**Terminal 2: Run test suite**
```bash
chmod +x test_zkperp.sh
./test_zkperp.sh
```

### Test Scenarios

```bash
# Scenario 1: Price UP → Trader closes with PROFIT
TEST_SCENARIO=1 ./test_zkperp.sh

# Scenario 2: Price DOWN → Orchestrator LIQUIDATES
TEST_SCENARIO=2 ./test_zkperp.sh
```

---

## 📁 Project Structure

```
ZKPerp/
├── assets/
│   └── zkperp_mask_icon.png
├── leo/
│   ├── zkperp/               # Main perpetuals contract (v12)
│   │   └── src/main.leo
│   └── test_zkperp.sh        # Automated test script
├── frontend/                  # React + Vite frontend
│   ├── src/
│   │   ├── components/        # UI components (TradingWidget, PositionDisplay, etc.)
│   │   ├── hooks/             # useTransaction, useBalance
│   │   └── utils/             # Aleo utilities
│   └── package.json
├── zkperp-bot/                # Oracle bot
│   └── zkperp-bot-manager.mjs
├── LIQUIDATION_ARCHITECTURE.md
├── LIMITATIONS.md
└── README.md
```

---

## 🔧 Contract Functions

### LP Functions

| Function | Description | Parameters |
|---|---|---|
| `initialize_slots` | Mint 3 empty slot records (one-time setup) | `recipient` |
| `add_liquidity` | Deposit USDCx, update LPSlot | `lp_slot`, `deposit_amount`, `recipient` |
| `remove_liquidity` | Burn LP share, withdraw USDCx | `lp_slot`, `amount_to_burn`, `expected_usdc` |

### Trading Functions

| Function | Description | Parameters |
|---|---|---|
| `open_position` | Open leveraged long/short (consumes & returns PositionSlot) | `slot`, `collateral`, `size`, `is_long`, `entry_price`, `max_slippage`, `nonce`, `recipient`, `orchestrator` |
| `close_position` | Close position, settle PnL (resets PositionSlot) | `slot`, `min_price`, `max_price`, `expected_payout` |
| `liquidate` | Liquidate underwater position (returns empty slot to trader) | `auth`, `liquidator_reward` |

### Oracle Functions

| Function | Description | Parameters |
|---|---|---|
| `update_price` | Update asset price (oracle bot / admin) | `asset_id`, `price`, `timestamp` |

---

## 📝 Data Structures

### PositionSlot (Private Record) — Owned by Trader

```leo
record PositionSlot {
    owner: address,
    slot_id: u8,              // 0 = long slot, 1 = short slot
    is_open: bool,            // Gate: must be false to open, true to close
    position_id: field,       // 0field when empty
    is_long: bool,
    size_usdc: u64,           // Notional size (6 decimals)
    collateral_usdc: u64,     // Margin deposited (6 decimals)
    entry_price: u64,         // Price at entry (8 decimals)
}
```

### LiquidationAuth (Private Record) — Owned by Orchestrator

```leo
record LiquidationAuth {
    owner: address,           // Orchestrator's address
    trader: address,          // Original trader (receives empty slot on liquidation)
    slot_id: u8,              // 0 = long slot, 1 = short slot
    position_id: field,
    is_long: bool,
    size_usdc: u64,
    collateral_usdc: u64,
    entry_price: u64,
}
```

### LPSlot (Private Record) — Owned by LP

```leo
record LPSlot {
    owner: address,
    slot_id: u8,              // always 0u8
    is_open: bool,
    lp_amount: u64,           // 0 when empty, accumulates across deposits
}
```

### PoolState (Public Mapping)

```leo
struct PoolState {
    total_liquidity: u64,
    total_lp_tokens: u64,
    long_open_interest: u64,
    short_open_interest: u64,
    accumulated_fees: u64,
}
```

---

## 💰 Fee Distribution

All fees accrue to the LP pool, increasing the value of LP tokens:

```
LP Token Value = total_liquidity / total_lp_tokens

Fee Sources:
├── Opening fees (0.1% of position size)
├── Borrow fees (per-block funding rate)
└── Trader losses (pool profit when traders lose)
```

**Example:**
```
Initial: LP deposits $100 → 100 LP tokens (value: $1.00 each)

After trading:
  + $5 in fees collected
  + $10 from trader losses
  = $115 total liquidity

LP withdraws: 100 LP tokens → $115 (15% profit!)
```

---

## ⚠️ Risk Factors

### For Traders
- Liquidation risk at 1% margin ratio
- Borrow fees accumulate over time
- Oracle price determines PnL

### For LPs
- Counterparty to all trades
- Profitable traders reduce pool value
- Smart money risk (informed traders)

---

## 🧪 Testing

### Automated Test Suite

The project includes a comprehensive test script that covers:

✅ Slot initialization (long slot, short slot, LP slot)
✅ LP deposit/withdrawal flows
✅ Position opening with various leverage levels
✅ Position closing with profit/loss scenarios
✅ Liquidation mechanics (bot + manual override)
✅ Oracle price updates
✅ Fee calculations

```bash
cd leo
./test_zkperp.sh
```

### Frontend Integration

The frontend uses the Shield Wallet Adapter (`@provablehq/aleo-wallet-adaptor-react`) to:

- Sign and submit transactions with delegated proving (~14s)
- Decrypt private slot records via wallet approval
- Query on-chain state via Provable Explorer API (v1)
- Display position data with real-time PnL

Key hooks:
- `useTransaction()` — manages transaction lifecycle (submit → poll → confirm/reject)
- `useBalance()` — fetches USDCx and ALEO balances

---

## 📚 Technical Deep Dives

### Leo Safe Subtraction Pattern

Leo evaluates both branches of ternary operators, which can cause underflow errors. Always use the cap-then-subtract pattern:

```leo
// ❌ UNSAFE - Leo evaluates `a - b` even when condition is false
let result: u64 = a > b ? a - b : 0u64;

// ✅ SAFE - Cap first, then subtract (always valid)
let capped_b: u64 = b <= a ? b : a;
let result: u64 = a - capped_b;
```

This pattern is used throughout ZKPerp's contract to prevent arithmetic underflow in PnL and fee calculations.

### Leo CLI Record Format (devnet)

For `leo execute` on devnet, records must be passed as compact single-line strings with no spaces, all fields `.private`, `_nonce` `.public`, and `_version:1u8.public` required. Use `printf` to a temp file to avoid shell escaping issues:

```bash
printf '{owner:%s.private,slot_id:0u8.private,is_open:false.private,...,_nonce:%sgroup.public,_version:1u8.public}' \
  "$ADDR" "$NONCE" > /tmp/slot.txt
leo execute open_position "$(cat /tmp/slot.txt)" ...
```

---

## 🎯 Product Market Fit

**Target Users:**

1. **Professional traders** who need execution privacy
2. **Institutions** requiring confidential trading
3. **Whales** who move markets when their positions are visible
4. **Privacy-conscious retail** traders

**Market Size:**

- Perpetual futures: $150B+ daily volume across CEXs
- DEX perpetuals growing rapidly (GMX $1B+ TVL, dYdX $2B+)
- Privacy is the #1 requested feature among professional traders

**Competitive Advantage:**

- First privacy-preserving perpetual DEX on Aleo
- ZK-native design (not a privacy layer on top)
- No trusted setup or centralized components

---

## 📈 Progress Changelog

### Wave 1 — Core Protocol
- No feedback in Wave 1 (frontend link not found)

### Wave 2 — Shield Wallet & USDCx
- ✅ Complete Leo smart contract with all core functions
- ✅ Privacy-preserving position management
- ✅ GMX-style liquidity pool
- ✅ Liquidation system with LiquidationAuth records
- ✅ React frontend with Shield Wallet integration
- ✅ Deployed to Aleo Testnet Beta (`zkperp_v6.aleo`)
- ✅ Official USDCx integration (`test_usdcx_stablecoin.aleo`)
- ✅ Two-phase batch decrypt for private records
- ✅ On-chain transaction confirmation polling
- ✅ Dust record filtering (MIN_DUST = $0.01)
- ✅ Pure BigInt payout calculation (no floating-point errors)
- ✅ Permissionless liquidation page with TX ID auto-parsing
- ✅ Public fee support (`privateFee: false` for Shield compatibility)

### Wave 3 — Slot Model, Liquidation & Oracle Bot (Current)
- ✅ **Slot Record Model** — 3 fixed slots per user (2 position + 1 LP), wallet record count fixed forever
- ✅ **Full Liquidation Flow** — `LiquidationAuth` dual-record system with Provable Record Scanner bot
- ✅ **Oracle Bot** — Binance BTC/USD feed, 1% threshold-gated on-chain updates, deployed to Render
- ✅ Removed `localStorage` dependency — `closed_positions` on-chain mapping is single source of truth
- ✅ Pre-filtering spent records before `decrypt()` — fewer wallet approval popups
- ✅ Withdrawal UI shows available-to-withdraw amount accounting for open positions
- ✅ Manual liquidation override switch on Liquidate tab (saves testnet token costs)
- ✅ Contract upgraded to `zkperp_v12.aleo`

### Wave 4 Goals
- Improve UX across trading and liquidity flows
- Update position management (multi-position support)
- Private USDCx transfers
- Unrealized PnL accounting — follow GMX V2 approach with separate long/short token pools (GM pools)
- SQL database for position history and analytics
- Analytics dashboard

---

## 🗺️ Roadmap

### Completed ✅
- Core perpetuals logic (open, close, liquidate)
- LP pool mechanics with slot-based records
- Privacy via Aleo slot records (3 records per user, forever)
- Official USDCx token integration
- Dual-record liquidation (Option D) with automated bot
- Oracle bot with live Binance price feeds
- React frontend with Shield Wallet integration
- Public testnet deployment (`zkperp_v12.aleo`)
- Delegated proving (~14s transactions)
- Automated test suite

### In Progress 🚧
- SQL database for trade history
- Analytics dashboard
- Multi-token market support

### Planned 📋

**Phase 1: Testnet**
- Unrealized PnL accounting (GMX V2 GM pool model — separate long/short tokens)
- Private USDCx transfers
- Multi-token markets (ETH, SOL)
- Enhanced UI/UX
- ZK dark pool
- Privacy copy trading

**Phase 2: Security & Audits**
- Formal verification of Leo contracts
- Third-party security audit
- Bug bounty program

**Phase 3: Mainnet Launch**
- Deploy to Aleo Mainnet
- Partner with Aleo ecosystem projects
- Integrate real price oracles (Chainlink/Pyth once Aleo is supported)

**Phase 4: Growth**
- Funding rate mechanism
- Cross-margin and portfolio margin
- Multi-orchestrator support
- Mobile app
- DAO

---

## 👥 Team

| Name | Role | Discord | Wallet |
|---|---|---|---|
| Henk-Wim de Boer | Lead Developer | @lupo1977 | `aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0` |

**Background:**
- Experienced blockchain developer
- Previous work: DeFi protocols, ZK systems
- Deep expertise in Aleo/Leo development

## 🔗 Links

- **GitHub**: https://github.com/hwdeboer1977/ZKPerp
- **Contract**: `zkperp_v12.aleo` on Aleo Public Testnet
- **USDCx Token**: `test_usdcx_stablecoin.aleo`
- **Frontend**: [zk-perp.vercel.app](https://zk-perp.vercel.app)
- **Explorer**: [Provable Explorer](https://testnet.explorer.provable.com)
- **Wallet**: [Shield Wallet](https://www.shieldwallet.xyz/)

## 📖 Resources

- [Aleo Documentation](https://developer.aleo.org/)
- [Leo Language Guide](https://developer.aleo.org/leo/)
- [GMX Documentation](https://gmx-docs.io/) (inspiration)
- [Liquidation Architecture Details](LIQUIDATION_ARCHITECTURE.md)
- [Known Limitations](LIMITATIONS.md)

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

## 🤝 Contributing

Contributions welcome! Please open an issue or PR.

---

<p align="center">
  <b>Building the future of private DeFi on Aleo</b> ❤️
</p>
