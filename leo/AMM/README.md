# zkperp_amm_v3 — Concentrated Liquidity AMM on Aleo

A Uniswap v3-style Concentrated Liquidity AMM built in Leo 4.0 for the Aleo blockchain.  
Trading pair: **USDCx / ALEO** · Fee tier: **0.3%** · Network: **Testnet**

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    zkperp_amm_v3.aleo                    │
│                                                          │
│  Transitions (ZK-proven, private inputs)                 │
│  ┌─────────────────┐  ┌──────────────────┐              │
│  │ mint_position   │  │  burn_position   │              │
│  │ swap_buy        │  │  swap_sell       │              │
│  │ initialize_pool │  │                  │              │
│  └─────────────────┘  └──────────────────┘              │
│                                                          │
│  Finalize (on-chain state, public)                       │
│  ┌──────────┐ ┌───────────┐ ┌──────────────┐           │
│  │pool_state│ │ tick_info │ │ aleo_reserve │           │
│  └──────────┘ └───────────┘ └──────────────┘           │
└─────────────────────────────────────────────────────────┘
         ▲
         │ pre-computes swap steps
┌─────────────────────┐
│   Orchestrator      │  (zkcl-amm-bot.mjs)
│   Node.js / REST    │  POST /quote /swap /mint /burn
└─────────────────────┘
         ▲
┌─────────────────────┐
│   React Frontend    │  (amm-app/)
│   Shield Wallet     │  swap_buy / swap_sell / mint / burn
└─────────────────────┘
```

---

## Key Design Decisions

### Concentrated Liquidity (Uniswap v3 style)
- LP positions are defined by `[tick_lower, tick_upper]` price ranges
- Tick spacing: **60** (matches Uniswap v3 0.3% pools)
- sqrt_price stored as Q64 fixed-point: `sqrt(price) * 2^64`
- In-range positions earn fees; out-of-range positions are 100% in one token

### Leo 4.0 Constraints & Solutions

| Constraint | Solution |
|-----------|----------|
| No loops in `final{}` | 4-step unrolled tick crossing |
| Both ternary branches evaluated | max-min pattern for all subtractions |
| `Mapping::get` in ternary panics if key missing | `Mapping::get_or_use` everywhere |
| Division in ternary evaluates `/0` | Pre-compute numerator before ternary |
| Nested ternaries rejected at runtime | Flatten to intermediate variables |
| Q64 values overflow JS `Number` | Divide by 2^32 via bigint first |

### Swap Architecture (4-step unrolling)
The contract handles up to **4 tick crossings** per swap. For single-range swaps (common case) all 4 steps have `tick_next = TICK_SENTINEL` and amounts in step0:

```
step0: { tick_next: 887221, amount_in: X, amount_out: Y, fee: Z }
step1: { tick_next: 887221, amount_in: 0, amount_out: 0, fee: 0 }  // empty
step2: { tick_next: 887221, ...0... }
step3: { tick_next: 887221, ...0... }
```

The contract verifies: `sum(step.amount_in) == total_amount_in`

### Orchestrator Requirement
For tick-crossing swaps, an orchestrator must:
1. Read `tick_info` mappings from chain
2. Simulate tick crossings off-chain
3. Fill step0-3 with correct amounts per crossing
4. Submit verified inputs to the contract

This is the standard ZK pattern: **prover computes off-chain, verifier checks on-chain**.

---

## Privacy Model

| Data | Privacy |
|------|---------|
| `LPPosition` record | ✅ Private (owner only) |
| `SwapReceipt` record | ✅ Private (swapper only) |
| USDCx Token records | ✅ Private |
| `pool_state` mapping | ❌ Public (price, liquidity, tick) |
| `tick_info` mapping | ❌ Public (initialized ticks) |
| Swap amounts | ❌ Public (visible on-chain) |

> **Note**: Full AMM privacy is architecturally impossible — price discovery requires public state. For large private trades, use `zkdarkpool_v2.aleo` (batch auctions).

---

## Contract Functions

### `initialize_pool`
```leo
fn initialize_pool(
    public sqrt_price_x64: u128,  // initial sqrt(price) * 2^64
    public initial_tick:   i32,   // initial tick
) -> Final
```
Sets up pool state. Can only be called once.

### `mint_position`
```leo
fn mint_position(
    tick_lower: i32,              // private: position range lower tick
    tick_upper: i32,              // private: position range upper tick
    liquidity_desired: u128,      // private: liquidity units to add
    public amount_0_max: u64,     // max USDCx to deposit (slippage)
    public amount_1_max: u64,     // max ALEO to deposit (slippage)
    public amount_0_actual: u64,  // actual USDCx deposit
    public amount_1_actual: u64,  // actual ALEO deposit
    public sqrt_price_x64: u128,  // current pool price (verified on-chain)
    public current_tick: i32,     // current pool tick (verified on-chain)
    public fee_growth_inside_0: u128,
    public fee_growth_inside_1: u128,
) -> (LPPosition, Final)
```

### `burn_position`
```leo
fn burn_position(
    position: LPPosition,         // private: LP record to burn
    public fee_growth_inside_0: u128,
    public fee_growth_inside_1: u128,
    public amount_0_out: u64,     // USDCx to withdraw
    public amount_1_out: u64,     // ALEO to withdraw
    public sqrt_price_x64: u128,
    public current_tick: i32,
) -> Final
```

### `swap_buy` (USDCx → ALEO)
```leo
fn swap_buy(
    public total_amount_in:  u64,   // USDCx in (gross, includes fee)
    public total_amount_out: u64,   // ALEO out
    public total_fee:        u64,   // fee paid (0.3%)
    public sqrt_price_final: u128,  // price after swap
    public tick_final:       i32,
    public step0: TickStep,         // tick crossing steps (SENTINEL if unused)
    public step1: TickStep,
    public step2: TickStep,
    public step3: TickStep,
) -> (SwapReceipt, Final)
```

### `swap_sell` (ALEO → USDCx)
Same signature as `swap_buy`. Direction determined by `zero_for_one` flag in `SwapReceipt`.

---

## Mappings (Public State)

| Mapping | Key | Value | Description |
|---------|-----|-------|-------------|
| `pool_state` | `0u8` | `PoolState` | Current price, liquidity, fee accumulators |
| `tick_info` | `field` | `TickInfo` | Per-tick liquidity net and fee growth |
| `aleo_reserve` | `0u8` | `u64` | ALEO held by the pool |
| `roles` | `u8` | `address` | Admin role (slot 0) |
| `is_init` | `u8` | `bool` | Pool initialization flag |

**Tick key formula**: `(tick as i64 + 2_147_483_647i64) as u64 as field`  
Example: tick `-30000` → key `2147453647field`

---

## Math

### Q64 Fixed-Point
All sqrt prices are stored as `sqrt(price) * 2^64` (u128).

### Token Amount Formulas
**Token0 (USDCx) amount** for liquidity `L` between `sqrtLo` and `sqrtHi`:
```
amount0 = L * (sqrtHiS - sqrtLoS) * S32 / (sqrtHiS * sqrtLoS)
```
where `xS = x / 2^32` (integer division, avoids JS float precision loss)

**Token1 (ALEO) amount**:
```
amount1 = L * (sqrtHi - sqrtLo) / Q64
```

### Swap Price Formula (swap_buy, price decreases)
```
sqrtAfter = L * Q64 * sqrtBefore / (L * Q64 + amountIn_net * sqrtBefore)
amountOut  = L * (sqrtBefore - sqrtAfter) / Q64
```

### Swap Price Formula (swap_sell, price increases)
```
sqrtAfter = sqrtBefore + amountIn_net * Q64 / L
amountOut  = L * (sqrtAfter - sqrtBefore) * Q64 / (sqrtAfter * sqrtBefore)
```

---

## Fee Mechanism
- Fee: `0.3%` = `3000 / 1_000_000`
- Fees accrue to `fee_growth_global_0` (USDCx) or `fee_growth_global_1` (ALEO)
- LP positions track `fee_growth_inside_0/1_last` at mint time
- On burn: `tokens_owed = liquidity * (fee_growth_inside_current - fee_growth_inside_last) / Q64`

---

## Devnet Testing

### Prerequisites
```bash
# Terminal 1: Start devnet
leo devnet \
  --snarkos ~/snarkOS/target/release/snarkos \
  --snarkos-features test_network \
  --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11,12,13 \
  --clear-storage
```

### Run Full Test Suite
```bash
# Terminal 2
cp src/main_devnet.leo src/main.leo
# Edit program.json: "program": "zkperp_amm_devnet.aleo"
chmod +x test_amm_devnet.sh
./test_amm_devnet.sh
```

### Test Breakdown
| Test | Function | What it verifies |
|------|----------|-----------------|
| 1 | `initialize_pool` | Pool created at price 0.1 ALEO/USDCx (tick -23040) |
| 2 | `mint_mock_usdc` | Trader receives 1000 mock USDCx |
| 3 | `mint_position` | LP position minted in [-30000, -19020], liquidity = 17418444 |
| 4 | `swap_buy` | 0.05 USDCx → 4980 ALEO, price moves to tick -23046 |
| 5 | `swap_sell` | 5000 ALEO → 49895 USDCx, price moves to tick -23027 |
| 6 | `burn_position` | Manual (requires LP record from test 3) |

### Burn Position (Manual)
After test 3, use the LPPosition record from output:
```bash
leo execute burn_position \
  --private-key $TRADER_KEY \
  --endpoint http://localhost:3030 \
  --network testnet --broadcast \
  --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11,12,13 --yes \
  -- 'LP_POSITION_RECORD' \
     '0u128' '0u128' \
     '9999999u64' '1621323u64' \
     'CURRENT_SQRT_PRICE' 'CURRENT_TICK'
```

---

## Known Issues & Limitations

### 1. `term_diff` assert commented out
The terminal step verification assert is disabled for single-range swaps. For tick-crossing swaps with a proper orchestrator, this should be re-enabled.

### 2. Debug mappings in devnet contract
`main_devnet.leo` contains `dbg_u128`, `dbg_u64`, `dbg_bool` mappings used during debugging. Remove before production deployment.

### 3. Orchestrator required for tick-crossing swaps
Swaps crossing tick boundaries require off-chain computation of step amounts. The `zkcl-amm-bot.mjs` orchestrator provides `buildSwapSteps()` for this.

### 4. Max 4 tick crossings per swap
The 4-step unrolling limits crossings to 4 per transaction. Large swaps through many liquidity ranges must be split.

---

## Files

```
zkperp_amm/
├── src/
│   ├── main.leo              # Testnet contract (with USDCx integration)
│   └── main_devnet.leo       # Devnet contract (mock USDCx, debug mappings)
├── orchestrator/
│   └── zkcl-amm-bot.mjs     # REST API orchestrator
├── amm-app/                  # React frontend
│   └── src/
│       ├── App.tsx           # 3-tab UI (Swap / Liquidity / Burn)
│       └── amm.ts            # Math: swap quotes, liquidity amounts
├── test_amm_devnet.sh        # Devnet integration test suite
└── README.md                 # This file
```

---

## Leo 4.0 Lessons Learned

1. **Both ternary branches always evaluate** — never put a subtraction that could underflow in either branch. Use `max - min` pattern.
2. **`Mapping::get` in a ternary panics** — always use `Mapping::get_or_use`.
3. **Division by zero evaluates even in the "safe" branch** — pre-compute the dividend separately.
4. **Nested ternaries in `final{}`** cause runtime rejection — flatten all conditionals to intermediate variables.
5. **Q64 values overflow JavaScript `Number`** — divide by `2^32` using bigint before converting to float.
6. **`final{}` is atomic** — if any line fails, no mapping writes occur (use debug mappings to bisect).
7. **Private inputs are available in `final{}`** via capture — but not re-readable from mappings.
