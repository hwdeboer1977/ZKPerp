# ZKPerp - Current Limitations

This document outlines the current limitations of ZKPerp and what would be needed for a production-ready deployment.

**Current Version:** zkperp_v6.aleo with test_usdcx_stablecoin.aleo (official Aleo testnet USDCx)

---

## ✅ RESOLVED: Token Transfers

**Status:** ✅ IMPLEMENTED (USDCx on Public Testnet)

ZKPerp integrates with the official Aleo testnet stablecoin `test_usdcx_stablecoin.aleo`:
- LPs deposit/withdraw real USDCx via `transfer_from_public`
- Traders receive USDCx payouts on `close_position`
- Liquidators receive rewards via `transfer_public`
- Pool holds actual USDCx balance
- Users obtain USDCx by bridging USDC from Sepolia testnet

---

## ✅ RESOLVED: Oracle Access Control

**Status:** ✅ IMPLEMENTED

Oracle updates are now admin-only:
```leo
const ORACLE_ADMIN: address = aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px;

async transition update_price(...) {
    assert_eq(self.caller, ORACLE_ADMIN);
    // ...
}
```

**Future improvements:**
- Decentralized oracle integration (Pyth, Chainlink equivalent on Aleo)
- Multi-sig oracle updates
- Price deviation checks (reject prices >X% different from last)

---

## ✅ RESOLVED: Liquidation Mechanism

**Status:** ✅ IMPLEMENTED (Option D - Dual Record System)

ZKPerp uses a dual-record architecture:
- `Position` record → owned by TRADER (for closing)
- `LiquidationAuth` record → owned by ORCHESTRATOR (for liquidating)
- `closed_positions` mapping prevents double-close/liquidate

```
open_position() creates TWO records:
├── Position → Trader can call close_position()
└── LiquidationAuth → Orchestrator can call liquidate()
```

See [LIQUIDATION_ARCHITECTURE.md](./LIQUIDATION_ARCHITECTURE.md) for full details.

---

## 🟡 NEW: Dust Record Accumulation

**Status:** Partially Mitigated (frontend filtering) — Contract-level fix planned for v7

**Problem:** When closing positions or removing liquidity, the contract returns "change" records with ~1% dust amounts (e.g., $0.001 LP tokens). These accumulate in the user's wallet and show up as phantom positions or LP entries.

**Current Mitigation (Frontend):**
```typescript
const MIN_DUST = BigInt(10000); // $0.01 threshold
if (amount < MIN_DUST) continue; // Skip dust records during decrypt
```

**Proposed Solution (v7 Contract):**
- `add_liquidity_merge(existing_lp, amount)` — consumes old LP record + new deposit → returns single merged LP record
- `open_position_merge(existing_dust, ...)` — similar merge for position dust records
- Always 1 LP record and 1 position record per user
- Eliminates need for frontend dust filtering
- Better UX: 1 decrypt = 1 popup (Shield Wallet)

```leo
// Example: LP merge transition
async transition add_liquidity_merge(
    existing_lp: LPToken,           // Consume existing record
    public deposit_amount: u128,     // New deposit
    recipient: address,
) -> (LPToken, Future) {
    // Merge existing + new into single LP record
    let merged_amount: u64 = existing_lp.amount + new_lp_amount;
    let merged_token: LPToken = LPToken {
        owner: recipient,
        amount: merged_amount,
    };
    return (merged_token, finalize_add_liquidity_merge(...));
}
```

---

## 1. Limited Position Tracking On-Chain

**Current State:** Position data exists primarily as private record held by trader

**✅ PARTIALLY RESOLVED:** The `position_open_blocks` mapping now tracks when positions were opened:
```leo
mapping position_open_blocks: field => u32;
// Stores: position_id → open_block_height
```

This enables:
- ✅ Accurate borrow fee calculations
- ✅ Frontend can query actual open block via API
- ✅ No need to estimate blocks open

**Still Missing:**
- Position size/leverage enumeration
- Position history or analytics
- Full position recovery if record is lost

**Note:** The orchestrator CAN track positions via their `LiquidationAuth` records.

**Frontend Implementation:**
```typescript
// Query actual open block from on-chain mapping
const openBlock = await fetchPositionOpenBlock(position.position_id);
const blocksOpen = currentBlock - openBlock;
const borrowFee = calculateBorrowFee(size, blocksOpen); // Accurate!
```

---

## 2. Single Orchestrator

**Current State:** Hardcoded `ORCHESTRATOR` constant

**Risk:** If orchestrator goes offline, positions can't be liquidated

**Solutions:**
- Multiple orchestrator addresses
- DAO-controlled orchestrator
- Orchestrator rotation mechanism
- Self-liquidation option for traders

```leo
// Future: Multiple orchestrators
const ORCHESTRATOR_1: address = aleo1...;
const ORCHESTRATOR_2: address = aleo1...;
const ORCHESTRATOR_3: address = aleo1...;
```

---

## 3. Single Asset Only

**Current State:** Only BTC/USD (asset_id: 0field)

**Missing:** ETH, SOL, ALEO, and other assets

**Solution:** Easy to add - just use different `asset_id` values:
```leo
// BTC: 0field
// ETH: 1field
// SOL: 2field

mapping oracle_prices: field => PriceData;
```

Would also need to track OI per asset.

---

## 4. No Funding Rate

**Current State:** Simple borrow fee (flat rate per block)

**Missing:** Dynamic funding rate that balances long/short exposure

**How Funding Rates Work (GMX/Perp style):**
- When longs > shorts → longs pay shorts
- When shorts > longs → shorts pay longs
- Incentivizes balanced open interest
- Reduces LP risk

```leo
// Example funding calculation
let long_oi: u64 = state.long_open_interest;
let short_oi: u64 = state.short_open_interest;
let imbalance: i64 = long_oi as i64 - short_oi as i64;
let funding_rate: i64 = imbalance * FUNDING_FACTOR / total_oi;
```

---

## 5. Limited Admin Controls

**Current Functions:**
- ✅ `update_price()` - Admin-only oracle updates

**Missing Functions:**
- `pause_trading()` - Emergency stop
- `unpause_trading()` - Resume trading
- `update_fees()` - Adjust fee parameters
- `withdraw_fees()` - Protocol revenue extraction
- `set_max_leverage()` - Adjust risk parameters

```leo
// Example admin control
mapping paused: u8 => bool;

async transition pause_trading() {
    assert_eq(self.caller, ADMIN);
    return finalize_pause();
}

async function finalize_pause() {
    Mapping::set(paused, 0u8, true);
}
```

---

## 6. LP Withdrawal Risk

**Current State:** LPs can withdraw anytime if liquidity is available

**Problem:** Bank run scenario - all LPs exit when traders are winning big

**Solutions:**
- **Withdrawal Cooldown:** 24-48 hour delay on withdrawals
- **Reserved Liquidity:** Minimum pool size based on OI
- **Withdrawal Fee:** Higher fee during high utilization
- **Epoch-based Withdrawals:** Withdrawals processed in batches

```leo
// Example: Check utilization before withdrawal
let utilization: u64 = (long_oi + short_oi) * 100 / total_liquidity;
assert(utilization < 80u64); // Max 80% utilization
```

---

## 7. No Partial Close

**Current State:** Must close entire position

**Missing:** Ability to close 50% of position, keep rest open

**Solution:**
```leo
async transition partial_close(
    position: Position,
    public size_to_close: u64,  // Amount to close
) -> (Position, Future) {
    assert(size_to_close < position.size_usdc);
    
    // Calculate proportional amounts
    let remaining_size: u64 = position.size_usdc - size_to_close;
    let remaining_collateral: u64 = 
        (position.collateral_usdc * remaining_size) / position.size_usdc;
    
    // Return new smaller position
    let new_position: Position = Position {
        owner: position.owner,
        position_id: position.position_id,
        is_long: position.is_long,
        size_usdc: remaining_size,
        collateral_usdc: remaining_collateral,
        entry_price: position.entry_price,
        open_block: position.open_block,
    };
    
    return (new_position, finalize_partial_close(...));
}
```

---

## 8. Leo Language Quirks

**Discovered Issue:** Leo evaluates BOTH branches of ternary operators

This causes underflow errors even in the "false" branch:
```leo
// ❌ UNSAFE - Leo evaluates `a - b` even when a <= b
let result: u64 = a > b ? a - b : 0u64;

// ✅ SAFE - Cap first, then subtract
let capped_b: u64 = b <= a ? b : a;
let result: u64 = a - capped_b;
```

**Implication:** All subtraction operations must use the "safe subtraction" pattern to avoid runtime failures.

---

## Priority Matrix

| Priority | Issue | Status | Effort | Impact |
|----------|-------|--------|--------|--------|
| ✅ Done | Token integration (USDCx) | RESOLVED | - | - |
| ✅ Done | Oracle access control | RESOLVED | - | - |
| ✅ Done | Liquidation mechanism | RESOLVED | - | - |
| ✅ Done | Shield Wallet migration | RESOLVED | - | - |
| 🟡 High | Dust record merge (v7) | Planned | Medium | UX — eliminates phantom records |
| 🟡 High | Multi-orchestrator | Open | Medium | Decentralization |
| 🟡 High | Admin controls | Open | Low | Operational necessity |
| 🟡 High | Funding rate | Open | Medium | LP protection |
| 🟡 Medium | LP withdrawal limits | Open | Low | Bank run protection |
| 🟢 Low | Multi-asset | Open | Low | Feature expansion |
| 🟢 Low | Partial close | Open | Low | UX improvement |

---

## Summary

**Current Status:** ✅ Core perpetual DEX with privacy, USDCx token integration, Shield Wallet, and liquidation system working on Aleo public testnet!

**For Testnet:** Need record merge logic (v7) + multi-orchestrator support + basic admin controls.

**For Mainnet:** All of the above + funding rates + LP protections + audits.

---

## Contributing

If you'd like to help address any of these limitations, please open an issue or PR on the repository.