# zkperp_amm_v6 — Concentrated Liquidity AMM on Aleo

A Uniswap v3-style Concentrated Liquidity AMM built in Leo 4.0 for the Aleo blockchain.  
Trading pair: **USDCx / ALEO** · Fee tier: **0.3%** · Network: **Testnet**

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    zkperp_amm_v6.aleo                    │
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

### Admin & Upgradeability
- **Non-upgradeable.** The `@custom` constructor asserts `self.edition == 0u16`, so any upgrade (edition > 0) is rejected on-chain. Iterating means deploying a fresh program (`v6`, …), not upgrading this one.
- **Admin = deployer.** The constructor sets `admin_address = self.program_owner` — atomic at deploy, no front-run window. Admin-gated entry points (`initialize_pool`) check `assert_eq(self.caller, admin_address.unwrap())`.
- The admin lives in a **`storage` variable**, not a mapping. (An earlier draft kept admin in a `roles` mapping while the constructor wrote a storage variable — the two never matched, so the admin check reverted on an unset key. Both now read/write the same `admin_address` slot.)

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
step0: { tick_next: 887221, amount_in_step: X, amount_out_step: Y, fee_step: Z }
step1: { tick_next: 887221, amount_in_step: 0, amount_out_step: 0, fee_step: 0 }  // empty
step2: { tick_next: 887221, ...0... }
step3: { tick_next: 887221, ...0... }
```

The contract verifies `sum(step.amount_in_step) <= total_amount_in` (and likewise for the out and fee fields); the leftover is covered by the terminal segment after `step3`.

> `TickStep` also carries `sqrt_price_next`, `liquidity_net`, and `liquidity_net_is_negative` (populated per crossing when building a multi-tick swap); only the amount fields are shown above for brevity.

### Multi-tick swaps (not implemented)
A swap that crosses initialized ticks needs its per-step amounts (`step0..step3`) computed off-chain: read `tick_info` from chain, simulate the crossings, fill the steps, and submit the verified inputs. That off-chain step-builder isn't built yet, so the app only supports single-range swaps (everything in `step0`). This is the standard ZK pattern: **prover computes off-chain, verifier checks on-chain**.

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
    public initial_sqrt_price_x64: u128,  // initial sqrt(price) * 2^64
    public initial_tick:           i32,   // initial tick
) -> Final
```
Sets up pool state. Admin-only — checks `self.caller` against the `admin_address` storage variable (set to the deployer in the constructor); can only be called once (`is_init` guard).

### `mint_position`
```leo
fn mint_position(
    lp_token:     test_usdcx_stablecoin.aleo::Token,        // private: USDCx record to deposit
    merkle_proof: [test_usdcx_stablecoin.aleo::MerkleProof; 2], // private: USDCx compliance proof
    aleo_in:      credits.aleo::credits,                    // private: ALEO record to deposit
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
) -> (
    LPPosition,
    test_usdcx_stablecoin.aleo::ComplianceRecord,  // from USDCx transfer
    test_usdcx_stablecoin.aleo::Token,             // USDCx change
    credits.aleo::credits,                         // ALEO change
    Final
)
```
Deposits USDCx (token0) and ALEO (token1) and returns an `LPPosition` record plus the change/compliance records emitted by the two `transfer_private_to_public` calls.

### `burn_position`
```leo
fn burn_position(
    position: LPPosition,         // private: LP record to burn
    public amount_0_out: u64,     // USDCx to withdraw
    public amount_1_out: u64,     // ALEO to withdraw
    public sqrt_price_x64: u128,
    public current_tick: i32,
) -> (
    test_usdcx_stablecoin.aleo::ComplianceRecord,  // from USDCx payout
    test_usdcx_stablecoin.aleo::Token,             // USDCx returned to LP
    credits.aleo::credits,                         // ALEO returned to LP
    Final
)
```
Burns the `LPPosition` and pays out via `transfer_public_to_private` on both USDCx and ALEO.

### `swap_buy` (USDCx → ALEO)
```leo
fn swap_buy(
    usdcx_in:     test_usdcx_stablecoin.aleo::Token,        // private: USDCx record spent
    merkle_proof: [test_usdcx_stablecoin.aleo::MerkleProof; 2], // private: USDCx compliance proof
    public total_amount_in:  u64,   // USDCx in (gross, includes fee)
    public total_amount_out: u64,   // ALEO out
    public total_fee:        u64,   // fee paid (0.3%)
    public min_amount_out:   u64,   // slippage floor (revert if out < this)
    public deadline:         u32,   // max block height for execution
    public sqrt_price_final: u128,  // price after swap
    public tick_final:       i32,
    public step0: TickStep,         // tick crossing steps (SENTINEL if unused)
    public step1: TickStep,
    public step2: TickStep,
    public step3: TickStep,
) -> (
    SwapReceipt,
    test_usdcx_stablecoin.aleo::ComplianceRecord,
    test_usdcx_stablecoin.aleo::Token,             // USDCx change
    credits.aleo::credits,                         // ALEO paid out
    Final
)
```

### `swap_sell` (ALEO → USDCx)
```leo
fn swap_sell(
    merkle_proof: [test_usdcx_stablecoin.aleo::MerkleProof; 2], // private: USDCx compliance proof
    aleo_in:      credits.aleo::credits,                    // private: ALEO record spent
    public total_amount_in:  u64,   // ALEO in (gross, includes fee)
    public total_amount_out: u64,   // USDCx out
    public total_fee:        u64,
    public min_amount_out:   u64,
    public deadline:         u32,
    public sqrt_price_final: u128,
    public tick_final:       i32,
    public step0: TickStep,
    public step1: TickStep,
    public step2: TickStep,
    public step3: TickStep,
) -> (
    SwapReceipt,
    test_usdcx_stablecoin.aleo::ComplianceRecord,
    test_usdcx_stablecoin.aleo::Token,             // USDCx paid out
    credits.aleo::credits,                         // ALEO change
    Final
)
```
The public params match `swap_buy`, but the private token inputs are mirrored: `swap_buy` takes a USDCx `Token` in, `swap_sell` takes a `credits` record in. Direction is recorded as the `zero_for_one` flag in `SwapReceipt` (`true` for buy).

---

## On-Chain State (Public)

### Mappings (per-key / singleton-at-`0u8`)
| Mapping | Key | Value | Description |
|---------|-----|-------|-------------|
| `pool_state` | `0u8` | `PoolState` | Current price, liquidity, fee accumulators |
| `tick_info` | `field` | `TickInfo` | Per-tick liquidity net and fee growth |
| `aleo_reserve` | `0u8` | `u64` | ALEO held by the pool |
| `is_init` | `u8` | `bool` | Pool initialization flag |

### Storage variables (singletons)
| Variable | Type | Description |
|----------|------|-------------|
| `admin_address` | `address` | Admin. Set to `self.program_owner` in the constructor at deploy; read via `admin_address.unwrap()`. Replaces the former `roles` mapping. |

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
     '9999999u64' '1621323u64' \
     'CURRENT_SQRT_PRICE' 'CURRENT_TICK'
```

---

## Known Issues & Limitations

### 1. Debug mappings in devnet contract
`main_devnet.leo` contains `dbg_u128`, `dbg_u64`, `dbg_bool` mappings used during debugging. Remove before production deployment.

### 2. Multi-tick swaps not implemented
Swaps crossing tick boundaries need off-chain computation of the per-step amounts; that step-builder doesn't exist yet, so only single-range swaps (everything in `step0`) work today.

### 3. Max 4 tick crossings per swap
The 4-step unrolling limits crossings to 4 per transaction. Large swaps through many liquidity ranges must be split.

---

## Files

```
zkperp_amm/
├── src/
│   ├── main.leo              # Testnet contract (with USDCx integration)
│   └── main_devnet.leo       # Devnet contract (mock USDCx, debug mappings)
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
8. **Singleton state belongs in `storage` variables** (read via `.unwrap()` / `.unwrap_or()`), not a mapping keyed at `0u8`. If you mix the two, make sure every gate reads the *same* slot the constructor writes — a constructor that sets a `storage` admin while a function checks a `roles` mapping reverts on the unset key.
