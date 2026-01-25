# ZKPerp - Current Limitations

This document outlines the current limitations of ZKPerp and what would be needed for a production-ready deployment.

---

## 1. No Actual Token Transfers

**Current State:** Pool accounting only (numbers in mappings)

**What's Missing:**
- Integration with `mock_usdc.aleo` for real transfers
- Traders don't actually receive USDC on close
- LPs don't actually deposit/withdraw USDC
- Liquidators don't receive rewards

**Solution:** Integrate token transfers using the `transfer_from` pattern:
```leo
// In close_position transition:
let transfer_future: Future = mock_usdc.aleo/transfer_public(
    position.owner,
    payout_amount,
);
```

---

## 2. Centralized Oracle

**Current State:** Anyone can call `update_price()`

**Risk:** Malicious price manipulation = instant liquidations or theft

**Solutions:**
- Admin-only oracle updates with access control
- Decentralized oracle integration (Pyth, Chainlink equivalent on Aleo)
- Multi-sig oracle updates
- Price deviation checks (reject prices >X% different from last)

```leo
// Example: Admin-only oracle
const ORACLE_ADMIN: address = aleo1...;

async transition update_price(...) {
    assert_eq(self.caller, ORACLE_ADMIN);
    // ...
}
```

---

## 3. No Position Tracking On-Chain

**Current State:** Position exists only as private record held by trader

**Problems:**
- If user loses record, position is lost forever
- Orchestrator can't find positions to liquidate
- No way to enumerate all open positions
- No position history or analytics

**Solutions:**
- Optional view key registration with orchestrator
- Store encrypted position data on-chain
- Position ID mapping (privacy tradeoff)
- Client-side record backup/recovery

---

## 4. Liquidation Mechanism is Incomplete

**Current State:** `liquidate()` requires passing the Position record

**Problem:** How does a liquidator get someone else's private record?

**Solutions:**
1. **View Key Registration:** Traders register view keys with trusted orchestrator
2. **Encrypted Position Storage:** Store encrypted position data on-chain, orchestrator decrypts
3. **Keeper Network:** Designated keepers with special access
4. **Self-Liquidation Incentive:** Users can liquidate their own positions for partial reward

```
Trader opens position
    ↓
Registers view key with orchestrator
    ↓
Orchestrator monitors position health
    ↓
If margin < 1%, orchestrator calls liquidate()
```

---

## 5. Single Asset Only

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

## 6. No Funding Rate

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

## 7. No Admin Controls

**Missing Functions:**
- `pause_trading()` - Emergency stop
- `unpause_trading()` - Resume trading
- `update_fees()` - Adjust fee parameters
- `withdraw_fees()` - Protocol revenue extraction
- `set_oracle()` - Whitelist oracle addresses
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

## 8. LP Withdrawal Risk

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

## 9. No Partial Close

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

## 10. Price Precision Mismatch

**Current State:**
- Prices: 8 decimals ($100,000 = 10,000,000,000)
- Amounts: 6 decimals ($100 = 100,000,000)

**Risk:** Rounding errors in PnL calculation, especially for small positions

**Solution:** Standardize on single decimal precision or use higher precision for intermediate calculations (already using u128).

---

## Priority Matrix

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| 🔴 Critical | Token integration | Medium | Can't actually trade |
| 🔴 Critical | Oracle access control | Low | Security vulnerability |
| 🔴 Critical | Liquidation mechanism | High | Protocol insolvency risk |
| 🟡 High | Admin controls | Low | Operational necessity |
| 🟡 High | Funding rate | Medium | LP protection |
| 🟡 Medium | LP withdrawal limits | Low | Bank run protection |
| 🟢 Low | Multi-asset | Low | Feature expansion |
| 🟢 Low | Partial close | Low | UX improvement |
| 🟢 Low | Price precision | Low | Edge case handling |

---

## Summary

**For Hackathon/MVP:** ✅ Current implementation demonstrates core perpetual DEX mechanics with privacy.

**For Testnet:** Need token integration + oracle security + basic admin controls.

**For Mainnet:** All of the above + liquidation mechanism + funding rates + audits.

---

## Contributing

If you'd like to help address any of these limitations, please open an issue or PR on the repository.
