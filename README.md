# ZKPerp - Privacy-Preserving Perpetual DEX on Aleo

ZKPerp is a decentralized perpetual futures exchange built on Aleo, combining the GMX liquidity pool model with zero-knowledge proofs for trader privacy.

## 🎯 Overview

ZKPerp allows traders to open leveraged long/short positions on BTC/USD while keeping their position details private. Liquidity providers deposit USDC into a shared pool and earn fees from trading activity.

### Key Features

- **Privacy**: Position sizes, entry prices, and PnL are private (stored in Aleo records)
- **Up to 20x Leverage**: Trade with capital efficiency
- **Zero Slippage**: Oracle-based pricing, no AMM curve
- **Single-Sided LP**: Deposit USDC only, no impermanent loss from token pairs
- **Instant Liquidity**: Trade against the pool, no counterparty needed

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         ZKPerp Protocol                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐       │
│  │   Traders   │     │  LP Pool    │     │   Oracle    │       │
│  │  (Private)  │────▶│  (Public)   │◀────│  (Public)   │       │
│  └─────────────┘     └─────────────┘     └─────────────┘       │
│        │                    │                    │              │
│        │                    │                    │              │
│  ┌─────▼─────┐        ┌─────▼─────┐        ┌─────▼─────┐       │
│  │ Position  │        │ PoolState │        │ PriceData │       │
│  │ (Record)  │        │ (Mapping) │        │ (Mapping) │       │
│  │ - Private │        │ - Public  │        │ - Public  │       │
│  └───────────┘        └───────────┘        └───────────┘       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### GMX-Style Liquidity Model

Unlike orderbook DEXs, ZKPerp uses a liquidity pool model:

1. **LPs deposit USDC** → Receive LP tokens representing pool share
2. **Traders open positions** → Pool takes the opposite side
3. **Oracle provides prices** → No AMM slippage
4. **Trader profits** → Pool pays out
5. **Trader losses** → Pool keeps collateral
6. **Fees accrue to pool** → LP tokens increase in value

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

Traders enjoy privacy for their individual positions while the protocol maintains public aggregate data for transparency and risk management.

## 🚀 Quick Start

### Prerequisites

- [Leo](https://developer.aleo.org/leo/) (v3.4.0+)
- [snarkOS](https://github.com/AleoHQ/snarkOS)
- Rust toolchain

### Local Development

**Terminal 1: Start local devnet**
```bash
leo devnet --snarkos $(which snarkos) --snarkos-features test_network --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11 --clear-storage
```

**Terminal 2: Run test suite**
```bash
chmod +x test_zkperp.sh
./test_zkperp.sh
```

### Manual Testing

```bash
# 1. Build
leo build

# 2. Deploy
leo deploy --network testnet --broadcast --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11 --yes

# 3. Set oracle price (BTC = $100,000)
leo execute update_price 0field 10000000000u64 1u32 --network testnet --broadcast --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11 --yes

# 4. Add liquidity ($100)
leo execute add_liquidity 100000000u64 <your_address> --network testnet --broadcast --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11 --yes

# 5. Open long position (5x leverage)
leo execute open_position 10000000u64 50000000u64 true 10000000000u64 100000000u64 1field <your_address> --network testnet --broadcast --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11 --yes

# 6. Close position
leo execute close_position "<position_record>" 9900000000u64 10100000000u64 --network testnet --broadcast --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11 --yes
```

## 📁 Project Structure

```
ZKPerp/
├── src/
│   └── main.leo          # Main contract
├── records/              # Saved position records (local testing)
├── test_zkperp.sh        # Automated test script
├── .env                  # Environment variables
├── program.json          # Leo program config
└── README.md
```

## 🔧 Contract Functions

### LP Functions

| Function | Description | Parameters |
|----------|-------------|------------|
| `add_liquidity` | Deposit USDC, receive LP tokens | `deposit_amount`, `recipient` |
| `remove_liquidity` | Burn LP tokens, withdraw USDC | `lp_token`, `amount_to_burn` |

### Trading Functions

| Function | Description | Parameters |
|----------|-------------|------------|
| `open_position` | Open leveraged long/short | `collateral`, `size`, `is_long`, `entry_price`, `max_slippage`, `nonce`, `recipient` |
| `close_position` | Close position, settle PnL | `position`, `min_price`, `max_price` |
| `liquidate` | Liquidate underwater position | `position`, `liquidator` |

### Oracle Functions

| Function | Description | Parameters |
|----------|-------------|------------|
| `update_price` | Update asset price | `asset_id`, `price`, `timestamp` |

## 📐 Data Structures

### Position (Private Record)
```leo
record Position {
    owner: address,
    position_id: field,
    is_long: bool,
    size_usdc: u64,         // Notional size
    collateral_usdc: u64,   // Margin deposited
    entry_price: u64,       // Price at entry (8 decimals)
    open_block: u32,        // For borrow fee calculation
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

## 🗺️ Roadmap

- [x] Core perpetuals logic
- [x] LP pool mechanics
- [x] Position management
- [x] Liquidation system
- [x] Privacy via Aleo records
- [ ] Mock USDC token integration
- [ ] Multi-asset support (ETH, SOL, etc.)
- [ ] Funding rate mechanism
- [ ] Decentralized oracle integration
- [ ] Frontend UI
- [ ] Mainnet deployment

## 🔗 Resources

- [Aleo Documentation](https://developer.aleo.org/)
- [Leo Language Guide](https://developer.aleo.org/leo/)
- [GMX Documentation](https://gmx-docs.io/) (inspiration)

## 📄 License

MIT License

## 🤝 Contributing

Contributions welcome! Please open an issue or PR.

---

**Built with ❤️ on Aleo**
