# ZKPerp Liquidation Architecture Options

This document analyzes different approaches to implement liquidations while preserving trader privacy on Aleo.

## The Core Problem

Positions are **private records** - only the owner can see them. But liquidators need to:
1. **See** positions to monitor health
2. **Access** the Position record to call `liquidate()`

This creates a fundamental tension between **privacy** and **liquidation functionality**.

---

## Key Insight: View Keys vs Private Keys

| Key Type | What it can do | What it CANNOT do |
|----------|----------------|-------------------|
| **View Key** | Decrypt and READ records | Sign transactions, spend funds |
| **Private Key** | Everything - read, sign, spend | - |

**Critical Discovery:** Even with a view key, an orchestrator can SEE a position but cannot USE it in a transaction. To pass a Position record into `liquidate()`, you need to CONSUME that record, which requires the owner's private key.

**This means Option 1 (View Key only) doesn't fully work!**

---

## Why Current Design Fails for Liquidation

**Current close_position flow (works):**
```
Trader → [owns Position record] → signs tx → close_position(Position) ✅
```

**Liquidation problem:**
```
Orchestrator → [doesn't own record] → cannot pass Position → liquidate(???) ❌
```

| Action | Who calls | Has the record? | Has private key? |
|--------|-----------|-----------------|------------------|
| `close_position` | Trader | ✅ Yes (owns it) | ✅ Yes (their own) |
| `liquidate` | Orchestrator | ❌ No (trader owns it) | ❌ No |

---

## Solution: Option D - Dual Record System (RECOMMENDED)

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  DUAL RECORD ARCHITECTURE                    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   open_position() creates TWO records:                       │
│                                                              │
│   ┌─────────────────────┐    ┌─────────────────────┐        │
│   │   Position Record   │    │  LiquidationAuth    │        │
│   │   owner: TRADER     │    │  owner: ORCHESTRATOR│        │
│   ├─────────────────────┤    ├─────────────────────┤        │
│   │ position_id         │    │ position_id         │        │
│   │ is_long             │    │ is_long             │        │
│   │ size_usdc           │    │ size_usdc           │        │
│   │ collateral_usdc     │    │ collateral_usdc     │        │
│   │ entry_price         │    │ entry_price         │        │
│   │ open_block          │    │ open_block          │        │
│   └─────────────────────┘    └─────────────────────┘        │
│            │                           │                     │
│            │                           │                     │
│            ▼                           ▼                     │
│   ┌─────────────────┐        ┌─────────────────┐            │
│   │ close_position()│        │   liquidate()   │            │
│   │ Called by TRADER│        │ Called by ORCH  │            │
│   └─────────────────┘        └─────────────────┘            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Flow

```
1. Trader calls open_position()
       ↓
2. Contract creates TWO records:
   - Position → owned by Trader (for closing)
   - LiquidationAuth → owned by Orchestrator (for liquidating)
       ↓
3. Trader keeps Position record (private to them)
   Orchestrator receives LiquidationAuth record (private to them)
       ↓
4. Orchestrator monitors their LiquidationAuth records
   Checks: current_price vs liquidation_price
       ↓
5. If position unhealthy:
   Orchestrator calls liquidate(LiquidationAuth)
       ↓
6. Contract executes liquidation, orchestrator gets reward
```

### Record Definitions

```leo
// Owned by TRADER - for closing positions
record Position {
    owner: address,           // Trader's address
    position_id: field,
    is_long: bool,
    size_usdc: u64,
    collateral_usdc: u64,
    entry_price: u64,
    open_block: u32,
}

// Owned by ORCHESTRATOR - for liquidations only
record LiquidationAuth {
    owner: address,           // Orchestrator's address
    trader: address,          // Original trader (for payout calculation)
    position_id: field,
    is_long: bool,
    size_usdc: u64,
    collateral_usdc: u64,
    entry_price: u64,
    open_block: u32,
}
```

### Modified open_position

```leo
async transition open_position(
    // ... existing params ...
    public orchestrator: address,  // NEW: who receives LiquidationAuth
) -> (Position, LiquidationAuth, Future) {
    
    // Create Position for trader
    let position: Position = Position {
        owner: recipient,
        position_id: position_id,
        // ... other fields
    };
    
    // Create LiquidationAuth for orchestrator
    let liq_auth: LiquidationAuth = LiquidationAuth {
        owner: orchestrator,
        trader: recipient,
        position_id: position_id,
        // ... same fields as position
    };
    
    return (position, liq_auth, finalize_open_position(...));
}
```

### Modified liquidate

```leo
async transition liquidate(
    liq_auth: LiquidationAuth,  // Orchestrator passes their record
) -> Future {
    // Orchestrator owns liq_auth, so they can pass it
    
    return finalize_liquidate(
        liq_auth.position_id,
        liq_auth.is_long,
        liq_auth.size_usdc,
        liq_auth.collateral_usdc,
        liq_auth.entry_price,
        liq_auth.open_block,
        self.caller,  // liquidator receives reward
    );
}
```

### Pros
- ✅ **Full privacy** - positions hidden from public
- ✅ **Works with Aleo's record model** - no hacks needed
- ✅ **Orchestrator can liquidate** - they own the LiquidationAuth record
- ✅ **Trader can close** - they own the Position record
- ✅ **Simple implementation** - just two records instead of one
- ✅ **No view key sharing needed** - orchestrator has their own record

### Cons
- ❌ Requires trusted orchestrator address at position open time
- ❌ Two records per position (more data)
- ❌ If orchestrator goes offline, positions can't be liquidated
- ❌ Orchestrator must be known upfront

### Privacy Score: ⭐⭐⭐⭐⭐ (Full)
### Decentralization Score: ⭐⭐⭐ (Medium - trusted orchestrator)
### Implementation Complexity: ⭐⭐ (Low - straightforward)

---

## Handling Edge Cases

### What if trader closes before liquidation?

```
1. Trader calls close_position(Position)
2. Position record is consumed ✅
3. LiquidationAuth still exists but position_id no longer valid
4. Need to track "closed" positions in a mapping

Solution: Add mapping to track closed positions
mapping closed_positions: field => bool;

In close_position finalize:
    Mapping::set(closed_positions, position_id, true);

In liquidate finalize:
    let is_closed: bool = Mapping::get_or_use(closed_positions, position_id, false);
    assert(!is_closed);  // Can't liquidate closed position
```

### What if orchestrator tries to liquidate healthy position?

```
In finalize_liquidate:
    // Verify position is actually liquidatable
    let margin_ratio: i64 = calculate_margin_ratio(...);
    assert(margin_ratio < LIQUIDATION_THRESHOLD_BPS);
```
The on-chain verification prevents abuse.

### Multiple orchestrators?

```
// Could create multiple LiquidationAuth records
async transition open_position(
    ...
    public orchestrator1: address,
    public orchestrator2: address,
) -> (Position, LiquidationAuth, LiquidationAuth, Future)
```
Or have a single orchestrator that's actually a multi-sig or DAO.

---

## Other Options (For Reference)

### Option 1: View Key Registration (Off-chain Orchestrator)

**Architecture:**
```
Trader shares view key with orchestrator
Orchestrator can SEE positions
But CANNOT execute liquidations (doesn't own the record)
```

**Status: ❌ DOESN'T WORK** - View key allows reading but not consuming records.

### Option 3: Hybrid - Public Health Indicator

**Architecture:**
```
Store position data in PUBLIC mapping
Anyone can monitor and call liquidate(position_id)
```

**Status: ⚠️ WORKS BUT LOW PRIVACY** - Position data visible to everyone.

### Option 5: Encrypted Position Storage

**Architecture:**
```
Encrypt position data on-chain
Designated liquidators can decrypt
Complex key management required
```

**Status: ⚠️ COMPLEX** - Leo has limited encryption primitives.

---

## Comparison: All Options

| Aspect | Option 1 (View Key) | Option 3 (Hybrid) | Option 5 (Encrypted) | Option D (Dual Record) |
|--------|---------------------|-------------------|----------------------|------------------------|
| **Privacy** | ⭐⭐⭐⭐ High* | ⭐⭐ Low | ⭐⭐⭐⭐ High | ⭐⭐⭐⭐⭐ Full |
| **Decentralization** | ⭐⭐ Low | ⭐⭐⭐⭐⭐ Full | ⭐⭐⭐ Medium | ⭐⭐⭐ Medium |
| **Implementation** | ❌ Doesn't work** | ⭐⭐ Easy | ⭐⭐⭐⭐⭐ Hard | ⭐⭐ Easy |
| **Works in Leo** | ❌ No** | ✅ Yes | ⚠️ Difficult | ✅ Yes |
| **Off-chain required** | Yes | No | Partial | No |
| **Trust assumptions** | Orchestrator | None | Committee | Orchestrator |

*Option 1 can see positions but cannot execute liquidations without private key
**View key alone insufficient - cannot consume records

---

## Recommended Approach: Option D (Dual Record)

### Why Option D?

1. **It actually works** - Unlike Option 1, orchestrator CAN execute liquidations
2. **Full privacy** - No public mappings, no data leakage
3. **Simple to implement** - Just add one more record output
4. **No complex cryptography needed**
5. **Native to Aleo** - Uses records as intended

### Implementation Roadmap

#### Phase 1: Basic Dual Record
- Add `LiquidationAuth` record
- Modify `open_position` to output both records
- Modify `liquidate` to accept `LiquidationAuth`
- Add `closed_positions` mapping for safety

#### Phase 2: Multiple Orchestrators
- Support multiple `LiquidationAuth` records
- Allow orchestrator rotation/updates

#### Phase 3: Decentralized Orchestrator
- Orchestrator becomes a DAO or multi-sig
- Multiple parties can trigger liquidations
- Reduces single point of failure

---

## Orchestrator Requirements

The orchestrator service needs to:

1. **Hold a private key** - To own and use LiquidationAuth records
2. **Monitor positions** - Track all LiquidationAuth records it owns
3. **Watch oracle prices** - Compare current price to liquidation prices
4. **Execute liquidations** - Call `liquidate()` when needed
5. **Stay online** - Positions can't be liquidated if orchestrator is down

### Simple Orchestrator Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR SERVICE                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐  │
│   │   Record    │     │   Price     │     │ Liquidation │  │
│   │   Scanner   │────▶│   Checker   │────▶│   Executor  │  │
│   └─────────────┘     └─────────────┘     └─────────────┘  │
│         │                   │                    │          │
│         │ Scan Aleo for     │ Compare to        │ Call      │
│         │ LiquidationAuth   │ oracle price      │ liquidate │
│         │ records           │                   │           │
│         ▼                   ▼                    ▼          │
│   ┌─────────────────────────────────────────────────────┐  │
│   │                   Aleo Blockchain                    │  │
│   └─────────────────────────────────────────────────────┘  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Orchestrator Pseudocode

```javascript
// Simple orchestrator loop
async function runOrchestrator() {
    const privateKey = "APrivateKey1...";  // Orchestrator's key
    
    while (true) {
        // 1. Get all LiquidationAuth records owned by orchestrator
        const positions = await scanRecords(privateKey, "LiquidationAuth");
        
        // 2. Get current oracle price
        const btcPrice = await getOraclePrice();
        
        // 3. Check each position
        for (const pos of positions) {
            const liquidationPrice = calculateLiquidationPrice(pos);
            
            if (pos.is_long && btcPrice <= liquidationPrice) {
                // Long position underwater - liquidate!
                await executeLiquidation(pos);
            } else if (!pos.is_long && btcPrice >= liquidationPrice) {
                // Short position underwater - liquidate!
                await executeLiquidation(pos);
            }
        }
        
        // 4. Wait before next check
        await sleep(10000);  // 10 seconds
    }
}
```

---

## Conclusion

**Option D (Dual Record)** is the recommended approach because:

1. ✅ It actually works within Aleo's constraints
2. ✅ Maintains full position privacy
3. ✅ Simple to implement
4. ✅ No complex cryptography needed
5. ✅ Orchestrator has proper authorization to liquidate

The tradeoff is trusting an orchestrator, but this can be mitigated by:
- Running your own orchestrator
- Using a DAO-controlled orchestrator
- Having multiple backup orchestrators

This is the best balance of **privacy**, **functionality**, and **implementation simplicity** for ZKPerp.
