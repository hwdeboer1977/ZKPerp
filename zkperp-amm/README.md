# zkperp_amm_v4 — Concentrated Liquidity AMM on Aleo

A Uniswap v3-style Concentrated Liquidity AMM built in Leo 4.0 for the Aleo blockchain.
Trading pair: **USDCx / ALEO** · Fee tier: **0.3%** · Network: **Testnet**

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    zkperp_amm_v4.aleo                    │
│                                                          │
│  External imports                                        │
│    • test_usdcx_stablecoin.aleo  (USDCx token)           │
│    • credits.aleo                (native ALEO)           │
│                                                          │
│  Transitions (ZK-proven, private inputs)                 │
│  ┌─────────────────┐  ┌──────────────────┐               │
│  │ mint_position   │  │  burn_position   │               │
│  │ swap_buy        │  │  swap_sell       │               │
│  │ initialize_pool │  │                  │               │
│  └─────────────────┘  └──────────────────┘               │
│                                                          │
│  Finalize (on-chain state, public)                       │
│  ┌──────────┐ ┌───────────┐ ┌──────────────┐             │
│  │pool_state│ │ tick_info │ │ aleo_reserve │             │
│  └──────────┘ └───────────┘ └──────────────┘             │
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

> **v4 vs v3**: v4 wires the ALEO leg through `credits.aleo` so native ALEO actually moves on every transition. In v3 the `aleo_reserve` mapping was incremented/decremented without any matching `credits.aleo` call, which meant ALEO accounting existed only on paper — minting and swapping ALEO did not debit or credit the trader's wallet. v4 closes that asymmetry: USDCx and ALEO are now handled symmetrically as private record inputs / private record outputs.

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
| Native ALEO transfers | ✅ Private input/output records (amounts public) |
| `pool_state` mapping | ❌ Public (price, liquidity, tick) |
| `tick_info` mapping | ❌ Public (initialized ticks) |
| Swap amounts | ❌ Public (visible on-chain) |

> **Note**: Full AMM privacy is architecturally impossible — price discovery requires public state. The trader's address is hidden on both legs (USDCx record + credits record) but the amounts traded are public. For large private trades, use `zkdarkpool_v2.aleo` (batch auctions).

---

## Contract Functions

### `initialize_pool`
```leo
fn initialize_pool(
    public sqrt_price_x64: u128,  // initial sqrt(price) * 2^64
    public initial_tick:   i32,   // initial tick
) -> Final
```
Sets up pool state. **Must be called once after deploy** before any mint/swap — otherwise `pool_state[0u8]` is empty and all subsequent transitions reject in finalize at `Mapping::get(pool_state, POOL_KEY)`.

### `mint_position`
```leo
fn mint_position(
    lp_token: Token,                  // private: USDCx token record to deposit
    merkle_proof: [MerkleProof; 2],   // private: USDCx freeze-list proof
    aleo_in: credits.aleo::credits,   // private: ALEO credits record to deposit
    tick_lower: i32,                  // private: position range lower tick
    tick_upper: i32,                  // private: position range upper tick
    liquidity_desired: u128,          // private: liquidity units to add
    public amount_0_max: u64,         // max USDCx to deposit (slippage guard)
    public amount_1_max: u64,         // max ALEO to deposit (slippage guard)
    public amount_0_actual: u64,      // actual USDCx deposit
    public amount_1_actual: u64,      // actual ALEO deposit
    public sqrt_price_x64: u128,      // current pool price (verified on-chain)
    public current_tick: i32,         // current pool tick (verified on-chain)
    public fee_growth_inside_0: u128,
    public fee_growth_inside_1: u128,
) -> (LPPosition, ComplianceRecord, Token, credits.aleo::credits, Final)
```
The trailing `credits.aleo::credits` is the change record from `transfer_private_to_public(aleo_in, …)` — the unspent ALEO from `aleo_in` is returned to the caller as a new private record. One-sided positions (price entirely below or above the range) call the ALEO transfer with `amount = 0u64`, which is a valid no-op on credits.aleo and produces a change record equal to the input.

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
) -> (ComplianceRecord, Token, credits.aleo::credits, Final)
```
The trailing `credits.aleo::credits` is the ALEO payout: `transfer_public_to_private` mints a private credits record to the position owner from the AMM's public balance.

### `swap_buy` (USDCx → ALEO)
```leo
fn swap_buy(
    usdcx_in: Token,                  // private: USDCx token record
    merkle_proof: [MerkleProof; 2],   // private: USDCx freeze-list proof
    public total_amount_in:  u64,     // USDCx in (gross, includes fee)
    public total_amount_out: u64,     // ALEO out
    public total_fee:        u64,     // fee paid (0.3%)
    public sqrt_price_final: u128,    // price after swap
    public tick_final:       i32,
    public step0: TickStep,           // tick crossing steps (SENTINEL if unused)
    public step1: TickStep,
    public step2: TickStep,
    public step3: TickStep,
) -> (SwapReceipt, ComplianceRecord, Token, credits.aleo::credits, Final)
```
The trailing `credits.aleo::credits` is the ALEO output of the swap, minted as a private record to the swapper.

### `swap_sell` (ALEO → USDCx)
```leo
fn swap_sell(
    merkle_proof: [MerkleProof; 2],   // private: USDCx freeze-list proof
    aleo_in: credits.aleo::credits,   // private: ALEO credits record to sell
    public total_amount_in:  u64,     // ALEO in (gross, includes fee)
    public total_amount_out: u64,     // USDCx out
    public total_fee:        u64,     // fee paid (0.3%)
    public sqrt_price_final: u128,
    public tick_final:       i32,
    public step0: TickStep,
    public step1: TickStep,
    public step2: TickStep,
    public step3: TickStep,
) -> (SwapReceipt, ComplianceRecord, Token, credits.aleo::credits, Final)
```
The trailing `credits.aleo::credits` is the change record from the inbound ALEO transfer.

---

## Mappings (Public State)

| Mapping | Key | Value | Description |
|---------|-----|-------|-------------|
| `pool_state` | `0u8` | `PoolState` | Current price, liquidity, fee accumulators |
| `tick_info` | `field` | `TickInfo` | Per-tick liquidity net and fee growth |
| `aleo_reserve` | `0u8` | `u64` | ALEO held by the pool (sanity-check counter; should equal `credits.aleo/account.get(self.address)` at all times) |
| `roles` | `u8` | `address` | Admin role (slot 0) |
| `is_init` | `u8` | `bool` | Pool initialization flag |

**Tick key formula**: `(tick as i64 + 2_147_483_647i64) as u64 as field`
Example: tick `-30000` → key `2147453647field`

> **Note on `aleo_reserve`**: In v4 this mapping is redundant with the AMM's public balance in `credits.aleo::account`. It is kept as an independent counter so that divergence between the two indicates a bug. A future version may drop it entirely.

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

## Deployment & Initialization

After deploying `zkperp_amm_v4.aleo`, the pool **must** be initialized before any other entry point can be called. `mint_position`, `swap_buy`, `swap_sell`, and `burn_position` all start their finalize block with `Mapping::get(pool_state, POOL_KEY)`, which fails if the mapping has no entry — silently rejecting the transaction.

The frontend's `fetchPoolState` returns `null` when the mapping is empty (rather than fabricating a zero-state PoolState), so the UI buttons stay disabled until initialization. Run once:

```bash
leo execute zkperp_amm_v4.aleo/initialize_pool \
  18446744073709551616u128 \
  0i32 \
  --network testnet \
  --endpoint https://api.explorer.provable.com/v1
```

| Initial price (ALEO/USDCx) | `sqrt_price_x64` | `initial_tick` (tick-spacing aligned) |
|---|---|---|
| 0.1 | `5833372668713516032u128` | `-23040i32` |
| 1.0 | `18446744073709551616u128` | `0i32` |
| 3.33 | `33662149097268359168u128` | `12000i32` |
| 10.0 | `58333726687135162368u128` | `22980i32` |

The tick must be a multiple of `TICK_SPACING = 60`. The values above are pre-aligned.

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
chmod +x tests/test_amm_devnet.sh
./tests/test_amm_devnet.sh
```

### Test Breakdown
| Test | Function | What it verifies |
|------|----------|-----------------|
| 1 | `initialize_pool` | Pool created at price 0.1 ALEO/USDCx (tick -23040) |
| 2 | `mint_mock_usdc` | Trader receives 1000 mock USDCx |
| 3 | `mint_position` | LP position minted in [-30000, -19020], liquidity = 17418444. Consumes a private USDCx record **and** a private `credits.aleo::credits` record. Returns LP record + USDCx change + ALEO change. |
| 4 | `swap_buy` | 0.05 USDCx → 4980 ALEO, price moves to tick -23046. Mints a private credits record as the ALEO payout. |
| 5 | `swap_sell` | 5000 ALEO → 49895 USDCx, price moves to tick -23027. Consumes a private credits record as input. |
| 6 | `burn_position` | Manual (requires LP record from test 3). Returns USDCx + ALEO payout as private records. |

> **Note**: The devnet test script `test_amm_devnet.sh` was written against the v3 signatures and needs updating for v4. The `mint_position` and `swap_sell` invocations both need an extra `credits.aleo::credits` plaintext input passed in via `leo execute`. Until the script is refreshed, use the frontend to exercise the full flow.

### Burn Position (Manual)
After test 3, use the LPPosition record from output. Burn signature did not change in v4 — only the output tuple grew (an extra `credits.aleo::credits` ALEO payout record is returned):
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

### 5. `aleo_reserve` redundant with `credits.aleo::account`
Kept as a sanity-check counter in v4. Eligible for removal in a future version once the cross-program accounting is fully trusted.

### 6. Devnet test script not yet updated for v4
`tests/test_amm_devnet.sh` still uses v3 input signatures. `mint_position` and `swap_sell` need an extra `credits.aleo::credits` plaintext argument before the script will work against a v4 deployment.

---

## Files

```
zkperp_amm/
├── src/
│   ├── main.leo              # Testnet contract zkperp_amm_v4.aleo (with real USDCx and credits.aleo)
│   └── main_devnet.leo       # Devnet contract (mock USDCx, debug mappings — needs v4 update)
├── frontend/                 # React frontend
│   └── src/
│       ├── App.tsx           # 3-tab UI (Swap / Liquidity / Burn) with credits-record selectors
│       ├── amm.ts            # Math: swap quotes, liquidity amounts, credits-record helpers
│       └── merkleProof.ts    # USDCx merkle proof helpers
├── tests/
│   └── test_amm_devnet.sh    # Devnet integration test suite (needs v4 update for credits.aleo args)
├── build/                    # Leo compiled output
├── program.json              # Program name and version
├── .env                      # Endpoint, keys, network config
└── README.md                 # This file
```

---
