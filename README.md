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
|---------|-----------------|--------|
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
- 🔗 **Real Token Transfers**: Integrated with mock_usdc.aleo for actual USDC movements
- 🛡️ **Dual-Record Liquidation**: Privacy-preserving liquidation via Option D (see below) architecture

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
│                    Leo Wallet Adapter                        │
│         (Transaction signing, Record decryption)             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Aleo Blockchain                            │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                  zkperp_v4.aleo                        │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐   │  │
│  │  │  Positions  │  │  LP Tokens  │  │ Liquidation  │   │  │
│  │  │  (private)  │  │  (private)  │  │    Auth      │   │  │
│  │  └─────────────┘  └─────────────┘  └──────────────┘   │  │
│  │  ┌─────────────┐  ┌─────────────┐                     │  │
│  │  │ Pool State  │  │Oracle Prices│  (public mappings)  │  │
│  │  └─────────────┘  └─────────────┘                     │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              mock_usdc_0128.aleo                       │  │
│  │         (ERC20-style token for testing)                │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```
A more detailed discussion on the limitations and liquidation architecture can be found here:
 - [LIMITATIONS.md](./LIMITATIONS.md)
 - [LIQUIDATION_ARCHITECTURE.md](./LIQUIDATION_ARCHITECTURE.md)

### GMX-Style Liquidity Model

Unlike orderbook DEXs, ZKPerp uses a liquidity pool model:

1. **LPs deposit USDC** → Receive LP tokens representing pool share
2. **Traders open positions** → Pool takes the opposite side
3. **Oracle provides prices** → No AMM slippage
4. **Trader profits** → Pool pays out
5. **Trader losses** → Pool keeps collateral
6. **Fees accrue to pool** → LP tokens increase in value

### Dual-Record Liquidation (Option D)

ZKPerp solves the privacy vs liquidation dilemma with a dual-record system:

```
open_position() creates TWO records:
├── Position        → owned by TRADER (for closing)
└── LiquidationAuth → owned by ORCHESTRATOR (for liquidating)

closed_positions mapping → prevents double-close/liquidate
```

## 📊 Economic Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| Max Leverage | 20x | Minimum 5% margin required |
| Opening Fee | 0.1% | Fee on position size |
| Liquidation Threshold | 1% | Margin ratio triggering liquidation |
| Liquidation Reward | 0.5% | Reward for liquidators |
| Max OI per Side | 50% | Of total pool liquidity |
| Borrow Fee | ~0.00001%/block | Funding rate for positions |

## 🔐 Privacy Model

| Data | Visibility | Storage |
|------|------------|---------|
| Position owner | Private | Record |
| Position size | Private | Record |
| Entry price | Private | Record |
| Collateral | Private | Record |
| Total pool liquidity | Public | Mapping |
| Open interest (aggregate) | Public | Mapping |
| Oracle prices | Public | Mapping |
| Position closed status | Public | Mapping (position_id only) |

Traders enjoy privacy for their individual positions while the protocol maintains public aggregate data for transparency and risk management.


## 🚀 Getting Started

## 🎬 Working Demo

### Live Deployment

- **Network**: Aleo Testnet Beta
- **Contract**: `zkperp_v4.aleo`
- **Mock USDC**: `mock_usdc_0128.aleo`
- **Frontend**: React + Vite + Leo Wallet Adapter

### Core Features Demonstrated

✅ **Private Position Opening**
- Users deposit USDC collateral
- Select long/short direction and leverage (up to 20x)
- Position details stored in encrypted private record

✅ **Private Position Closing**
- Calculate PnL based on oracle price
- Withdraw collateral + profit (or minus loss)
- Position record consumed, no on-chain trace

✅ **Liquidity Pool**
- LPs deposit USDC, receive LP tokens
- Pool pays winning traders, earns from losing traders
- Fees accumulated for LP rewards

✅ **Liquidation System**
- LiquidationAuth records enable third-party liquidators
- Liquidators earn 0.5% of position size as reward
- Maintains protocol solvency

✅ **Oracle Price Feeds**
- On-chain price updates by authorized oracle
- Slippage protection for traders

### How to Test

1. **Connect Leo Wallet** (set to Testnet Beta)
2. **Get mock USDC** (contact team or mint if you have oracle key)
3. **Approve ZKPerp** to spend your USDC
4. **Add Liquidity** or **Open Position**

## 🚀 Getting Started

### Prerequisites

- Leo CLI v2.0+
- Node.js 18+
- Leo Wallet browser extension

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
leo devnet --snarkos $(which snarkos) --snarkos-features test_network --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11 --clear-storage
```

**Terminal 2: Run test suite**
```bash
chmod +x test_zkperp.sh
./test_zkperp.sh
```

### Test Scenarios

The test script supports two scenarios via `TEST_SCENARIO` variable:

```bash
# Scenario 1: Price UP → Trader closes with PROFIT
TEST_SCENARIO=1 ./test_zkperp.sh

# Scenario 2: Price DOWN → Orchestrator LIQUIDATES
TEST_SCENARIO=2 ./test_zkperp.sh
```

### Frontend Setup

```bash
# Install frontend dependencies
cd frontend
npm install

# Start development server
npm run dev
```

## 📁 Project Structure

```
ZKPerp/
├── assets/
│   └── zkperp_mask_icon.png  # Logo
├── leo/
│   ├── mock_usdc/        # Mock USDC token
│   │   └── src/main.leo
│   ├── zkperp/           # Main perpetuals contract
│   │   └── src/main.leo
│   └── test_zkperp.sh    # Automated test script
├── frontend/              # React frontend
│   ├── src/
│   │   ├── components/    # UI components
│   │   ├── hooks/         # useZKPerp, useBalance
│   │   └── utils/         # Aleo utilities
│   └── package.json
├── LIQUIDATION_ARCHITECTURE.md
├── LIMITATIONS.md
└── README.md
```

## 🔧 Contract Functions

### LP Functions

| Function | Description | Parameters |
|----------|-------------|------------|
| `add_liquidity` | Deposit USDC, receive LP tokens | `deposit_amount`, `recipient` |
| `remove_liquidity` | Burn LP tokens, withdraw USDC | `lp_token`, `amount_to_burn`, `expected_usdc` |

### Trading Functions

| Function | Description | Parameters |
|----------|-------------|------------|
| `open_position` | Open leveraged long/short | `collateral`, `size`, `is_long`, `entry_price`, `max_slippage`, `nonce`, `recipient` |
| `close_position` | Close position, settle PnL | `position`, `min_price`, `max_price`, `expected_payout` |
| `liquidate` | Liquidate underwater position | `liq_auth`, `liquidator_reward` |

### Oracle Functions

| Function | Description | Parameters |
|----------|-------------|------------|
| `update_price` | Update asset price (admin only) | `asset_id`, `price`, `timestamp` |

## 📝 Data Structures

### Position (Private Record) - Owned by Trader
```leo
record Position {
    owner: address,
    position_id: field,
    is_long: bool,
    size_usdc: u64,         // Notional size (6 decimals)
    collateral_usdc: u64,   // Margin deposited (6 decimals)
    entry_price: u64,       // Price at entry (8 decimals)
    open_block: u32,        // For borrow fee calculation
}
```

### LiquidationAuth (Private Record) - Owned by Orchestrator
```leo
record LiquidationAuth {
    owner: address,           // Orchestrator's address
    trader: address,          // Original trader
    position_id: field,
    is_long: bool,
    size_usdc: u64,
    collateral_usdc: u64,
    entry_price: u64,
    open_block: u32,
}
```

### LPToken (Private Record)
```leo
record LPToken {
    owner: address,
    amount: u64,
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

## ⚠️ Risk Factors

### For Traders
- Liquidation risk at 1% margin ratio
- Borrow fees accumulate over time
- Oracle price determines PnL

### For LPs
- Counterparty to all trades
- Profitable traders reduce pool value
- Smart money risk (informed traders)

## 🧪 Testing

### Automated Test Suite

The project includes a comprehensive test script that covers:

✅ LP deposit/withdrawal flows
✅ Position opening with various leverage levels
✅ Position closing with profit/loss scenarios
✅ Liquidation mechanics
✅ Oracle price updates
✅ Fee calculations

Run tests:
```bash
cd leo
./test_zkperp.sh
```

### Frontend Integration

The frontend uses the Leo Wallet Adapter to:
- Sign transactions
- Decrypt private records
- Query on-chain state
- Display position data

Key hook: `useZKPerp()` provides all contract interaction functions.

## 📚 Technical Deep Dives

### Leo Language Notes

**Safe Subtraction Pattern:** Leo evaluates both branches of ternary operators, which can cause underflow errors. Always use the cap-then-subtract pattern:

```leo
// ❌ UNSAFE - Leo evaluates `a - b` even when condition is false
let result: u64 = a > b ? a - b : 0u64;

// ✅ SAFE - Cap first, then subtract (always valid)
let capped_b: u64 = b <= a ? b : a;
let result: u64 = a - capped_b;
```

This pattern is used extensively throughout ZKPerp's contract to prevent arithmetic underflow in PnL and fee calculations.

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
- First privacy-preserving perpetual DEX
- ZK-native design (not a privacy layer on top)
- No trusted setup or centralized components

## 🗺️ Go-To-Market (GTM) Plan

## 📈 Progress Changelog

### Wave 1 (Current Submission)

**Built:**
- ✅ Complete Leo smart contract with all core functions
- ✅ Privacy-preserving position management
- ✅ GMX-style liquidity pool
- ✅ Liquidation system with LiquidationAuth records
- ✅ Mock USDC token for testing
- ✅ React frontend with Leo Wallet integration
- ✅ Real-time on-chain data fetching
- ✅ Deployed to Aleo Testnet Beta

**Technical Achievements:**
- Implemented complex PnL calculations in Leo
- Solved privacy vs. liquidation tradeoff with dual record pattern
- Built full-stack Aleo dApp with wallet integration
- Developed comprehensive automated test suite

### Next Wave Goals

**Planned Features:**
- [ ] Liquidator bot (automated liquidations)
- [ ] Real oracle integration (Chainlink/Pyth bridge)
- [ ] Multiple trading pairs (ETH, SOL)
- [ ] Advanced order types (limit orders, stop-loss)
- [ ] Portfolio margin
- [ ] Mobile-responsive UI improvements
- [ ] Formal security audit

## 🗺️ Go-To-Market (GTM) Plan

### Completed ✅
- [x] Core perpetuals logic
- [x] LP pool mechanics
- [x] Position management
- [x] Liquidation system (Option D)
- [x] Privacy via Aleo records
- [x] Mock USDC token integration
- [x] Oracle admin access control
- [x] Automated test suite
- [x] React frontend with wallet integration
- [x] Testnet deployment

### In Progress 🚧
- [ ] Liquidator bot (automated liquidations)
- [ ] Real oracle integration (Chainlink/Pyth bridge)
- [ ] Security audit
- [ ] Enhanced UI/UX

### Planned 📋
- [ ] Multi-asset support (ETH, SOL, etc.)
- [ ] Funding rate mechanism
- [ ] Multi-orchestrator support
- [ ] Admin controls (pause, fees)
- [ ] Cross-margin and portfolio margin
- [ ] Mobile app
- [ ] Mainnet deployment

**Phase 1: Testnet Launch (Current)**
- Deploy on Aleo Testnet Beta 
- Build community through Aleo ecosystem
- Gather feedback from early users

**Phase 2: Security & Audits**
- Formal verification of Leo contracts
- Third-party security audit
- Bug bounty program

**Phase 3: Mainnet Launch**
- Deploy to Aleo Mainnet
- Partner with Aleo ecosystem projects
- Integrate real price oracles (Chainlink/Pyth via bridge)

**Phase 4: Growth**
- Add more trading pairs
- Cross-margin and portfolio margin
- Mobile app

## 👥 Team

| Name | Role | Discord | Wallet Address |
|------|------|---------|----------------|
| Henk-Wim de Boer | Lead Developer | @lupo1977 | aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0 |

**Background:**
- Experienced blockchain developer
- Previous work: DeFi protocols, ZK systems
- Deep expertise in Aleo/Leo development

## 🔗 Links

- **GitHub**: https://github.com/hwdeboer1977/ZKPerp
- **Contract**: `zkperp_v4.aleo` on Aleo Testnet
- **Mock USDC**: `mock_usdc_0128.aleo`
- **Frontend**: *[Deploy link if hosted]*

## 📖 Resources

- [Aleo Documentation](https://developer.aleo.org/)
- [Leo Language Guide](https://developer.aleo.org/leo/)
- [GMX Documentation](https://gmx-docs.io/) (inspiration)
- [Liquidation Architecture Details](./LIQUIDATION_ARCHITECTURE.md)

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

## 🤝 Contributing

Contributions welcome! Please open an issue or PR.

---

<p align="center">
  <b>Building the future of private DeFi on Aleo</b> ❤️
</p>
</document_content>