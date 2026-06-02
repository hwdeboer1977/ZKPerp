# ZKPerp Core (`zkperp_core_v30.aleo`)

The core settlement contract for **ZKPerp**, a privacy-first perpetuals DEX on Aleo. It custodies trader collateral, opens and closes leveraged positions against an LP pool, runs take-profit / stop-loss orders, and liquidates underwater positions. Position parameters (size, entry price, collateral, direction) are never written to public state — only a **commitment hash** is stored on-chain, so the network can verify a position's lifecycle without learning its contents.

This program depends on three companion programs:

| Import | Role |
| --- | --- |
| `test_usdcx_stablecoin.aleo` | The USDCx collateral token (private/public transfers, compliance records). |
| `zkperp_compliance_v9.aleo` | KYC/compliance gate — every trader action checks a `ZKPerpComplianceRecord`. |
| `zkperp_oracle_v4.aleo` | Price feed. Prices are committed only after a **2-of-3 oracle quorum** agrees, and reads enforce a staleness guard. |

---

## Core design ideas

**Position privacy via commitments.** When a position opens, the contract stores `position_commits[position_id] = BHP256::hash(entry_price, size, collateral, is_long, position_id)`. The raw values live only in records held by the trader (and the liquidator keepers). Any function that settles a position — `close_position`, `execute_take_profit`, `execute_stop_loss`, `liquidate` — must re-supply those values as private inputs, recompute the hash, and assert it matches the stored commitment. Lying about the numbers makes the hash mismatch and reverts the whole transaction.

**Slot-based accounting.** Each trader holds two `PositionSlot` records (slot `0u8` for longs, `1u8` for shorts) created once via `initialize_slots`. A slot is either empty or holds one open position. LPs hold an `LPSlot`.

**Oracle-gated prices.** Every price-sensitive `finalize` reads `zkperp_oracle_v4.aleo::oracle_prices`, asserts the supplied price equals the committed oracle price, and asserts the price is no older than `MAX_PRICE_AGE_BLOCKS` (150 blocks ≈ 5 min). The oracle itself only publishes a price after a 2-of-3 node quorum.

**Compliance on every trader action.** Trader-facing functions take a `ZKPerpComplianceRecord` and assert in `finalize` that the caller isn't revoked and that the record hasn't expired. The record is unforgeable — only `zkperp_compliance_v9.aleo::issue_compliance` can mint it, and that function already verified the trader's Merkle-set membership against the active root at issuance time — so requiring the record as a typed input *is* the membership check. The core deliberately does **not** re-assert the record's `issued_under` against the live compliance root: doing so would invalidate every existing trader whenever a new user registers and rotates the root. Keeper/orchestrator functions (`liquidate`, `update_pool_state`, `update_net_pnl`) are exempt, since they aren't trader actions.

---

## Roles

| Role | Source | Responsibilities |
| --- | --- | --- |
| **Admin** | `roles[0u8]` (set to `program_owner` in constructor) | Manages the liquidator set via `set_liquidator`. |
| **Orchestrator** | `roles[1u8]` | Owns TP/SL execution auths, updates pool state and net PnL. |
| **Liquidator keepers** | `liquidator_set[0u8..2u8]` | A 1-of-N set; any single keeper may liquidate an underwater position. |
| **Trader** | record owner | Opens/closes positions, places TP/SL. |
| **LP** | record owner | Provides/withdraws pool liquidity. |

---

## Liquidation model (the v28/v29 redesign)

Liquidation is the most security-sensitive path, because it seizes another party's collateral. The contract separates **correctness** (is this liquidation justified?) from **liveness** (will someone actually do it?), and solves each independently.

### Correctness — enforced on-chain, no trust in the keeper

`liquidate` does **not** accept a caller-chosen reward and does **not** rely on a single trusted orchestrator. Its `finalize` proves the liquidation is justified by asserting all of:

1. The position is still open (`active_position_ids`).
2. The supplied parameters match the stored commitment (no lying about size/collateral).
3. `exit_price` equals the fresh, quorum-agreed oracle price.
4. **Equity is below maintenance margin** — `collateral + PnL < size × MAINTENANCE_MARGIN_BPS`. This is the assertion that makes it a liquidation rather than a "close anyone's position" button.
5. The caller is a current member of `liquidator_set`.
6. The pool can cover the reward.

The reward is derived deterministically as `collateral × LIQ_PENALTY_BPS`, not supplied by the caller. Because the collateral figure is itself verified against the commitment, the reward can't be inflated. **A keeper therefore cannot liquidate a healthy position or over-pay itself — the math rejects it.**

### Liveness — 1-of-N keepers, racing for the reward

Because positions are private, only a holder of the position **preimage** can construct a valid `liquidate` call. To avoid a single point of failure, `open_position` mints **three `LiquidationAuth` records — one per keeper** in `liquidator_set`. Each record carries the full preimage.

- **Any one** keeper can liquidate (1-of-N), so up to two can be offline.
- The reward goes to whichever keeper submits first, so keepers **race** rather than collude — a keeper colluding with a trader to omit a liquidation simply loses the fee to another keeper.
- Keeper addresses are pinned to the admin-managed `liquidator_set` and verified in `open_position`'s finalize, so a trader **cannot** substitute their own colluding addresses.

> **Note:** keepers are still required. The contract is passive — it can reject an unjustified liquidation but cannot initiate one. Some off-chain keeper must watch positions and submit the transaction. The design removes the need to *trust* keepers (correctness is on-chain), not the need to *have* them (liveness).

---

## Constants

| Constant | Value | Meaning |
| --- | --- | --- |
| `OPENING_FEE_BPS` | `1_000` | Opening fee = 0.1% of size (per-million units: value / 1e6). |
| `WITHDRAWAL_BUFFER_BPS` | `100_000` | 10% liquidity safety buffer on LP withdrawals. |
| `PRICE_PRECISION` | `100_000_000_000` | Fixed-point scale for prices in PnL math. |
| `MAX_PRICE_AGE_BLOCKS` | `150` | Oracle staleness limit (~5 min). |
| `MAINTENANCE_MARGIN_BPS` | `50_000` | Maintenance margin = 5% of notional size. |
| `LIQ_PENALTY_BPS` | `100_000` | Liquidator reward = 10% of collateral. |

> The `_BPS` names follow the existing convention but use a **per-million** divisor (`/ 1_000_000`), so the values are not literal basis points. Tune `MAINTENANCE_MARGIN_BPS` and `LIQ_PENALTY_BPS` to your risk model before mainnet.

---

## State (mappings)

| Mapping | Type | Purpose |
| --- | --- | --- |
| `roles` | `u8 => address` | `0u8` admin, `1u8` orchestrator. |
| `slots_initialized` | `address => bool` | Guards one-time slot creation per trader. |
| `pool_state` | `field => PoolState` | LP pool liquidity, LP tokens, open interest, fees. |
| `position_open_blocks` | `field => u32` | Block height a position opened. |
| `active_position_ids` | `field => field` | Marks a position as open. |
| `position_commits` | `field => field` | Commitment hash binding a position's hidden parameters. |
| `used_nonces` / `order_nonces` | `field => bool` | Replay protection. |
| `net_unrealized_pnl` | `field => i64` | Pool's net PnL liability (orchestrator-maintained). |
| `pending_orders` | `field => bool` | Open TP/SL orders. |
| `order_traders` | `field => address` | Order → owning trader. |
| `liquidator_set` | `u8 => address` | The three keeper addresses (admin-managed). |

### Records

`PositionSlot`, `LiquidationAuth`, `LPSlot`, `ExecTPSLAuth`, `OrderReceipt` — all private, owned by the relevant party. `LiquidationAuth` is the keeper-held preimage; `ExecTPSLAuth` is the orchestrator-held execution authority for a TP/SL order; `OrderReceipt` is the trader's claim ticket for a placed order.

---

## Functions

### Setup
- **`constructor()`** — sets admin and orchestrator to the program owner.
- **`set_liquidator(idx, keeper)`** — admin-only; populates `liquidator_set[idx]` (`idx < 3`). Call three times after deploy, **before** any position opens.
- **`initialize_slots(recipient)`** — one-time creation of the trader's long slot, short slot, and LP slot.

### Liquidity (LP pool)
- **`add_liquidity(...)`** — deposits USDCx, mints LP share proportional to the pool, updates `pool_state`.
- **`remove_liquidity(...)`** — burns LP share for USDCx; enforces a minimum-remaining-liquidity check (open interest + PnL liability + 10% buffer) so withdrawals can't drain solvency.

### Trading
- **`open_position(...)`** — pulls collateral into the vault, takes the opening fee, checks leverage (≤ 20×) and minimum size, verifies entry price against the oracle within `max_slippage`, stores the commitment, and **mints three `LiquidationAuth` records** to the keeper set. *(15 inputs / 8 outputs — both within snarkVM's 16 limits, but the input count is near the ceiling.)*
- **`close_position(...)`** — trader-initiated close; recomputes the commitment, computes PnL at the oracle exit price, pays out `collateral + PnL` (clamped at 0), clears position state.

### Liquidation
- **`liquidate(...)`** — keeper-initiated; the trustless path described above. Pays the keeper a deterministic reward and zeroes the trader's slot only if the position is provably underwater at the oracle price.

### Conditional orders (TP / SL)
- **`place_take_profit(...)` / `place_stop_loss(...)`** — trader registers a trigger; mints an `OrderReceipt` (trader) and an `ExecTPSLAuth` (orchestrator). Stop-loss additionally pins the orchestrator and uses a separate nonce space.
- **`execute_take_profit(...)` / `execute_stop_loss(...)`** — orchestrator-initiated; same commitment + oracle checks as `close_position`, pays the trader, clears order and position state.
- **`cancel_tp_sl(...)`** — trader cancels a pending order.

### Housekeeping
- **`burn_order_receipt(receipt)`** — trader discards a receipt for an order that's no longer pending.
- **`burn_liquidation_auth(auth)`** — a keeper discards a stale `LiquidationAuth` once its position is no longer active (e.g. the other two keepers' leftover auths after one keeper wins the liquidation race).

### Pool bookkeeping (orchestrator-only)
- **`update_net_pnl(net_pnl)`** — sets the pool's net unrealized PnL liability.
- **`update_pool_state(...)`** — sets pool liquidity, open interest, LP tokens, and fees.

---

## Deployment & test sequence

1. Deploy `zkperp_core_v30.aleo` (companion programs must already be deployed).
2. `set_liquidator` × 3 to register keepers `0`, `1`, `2`.
3. Fund the LP pool via `add_liquidity`.
4. A trader runs `initialize_slots`, then `open_position` — this mints three `LiquidationAuth` records, one to each keeper.
5. Move the oracle price until the position falls below maintenance margin.
6. One keeper calls `liquidate` → succeeds and collects the reward. A second keeper retrying **reverts** on the `active_position_ids` check — that revert is the proof double-liquidation is prevented.
7. The losing keepers call `burn_liquidation_auth` to clean up their stale records.

---

## Security notes & open items

- **Boundary timing.** A keeper can liquidate the instant a position crosses maintenance margin. This is valid (the position really is underwater) but aggressive. Consider a buffer band (`equity < maint_margin − buffer`) and/or keeper bonding/slashing to discourage premature liquidation.
- **All-keepers-offline tail.** 1-of-N tolerates N−1 offline keepers but not all N. A production deployment should add an insurance fund / backstop vault to absorb the cost of a late liquidation, as other perp DEXs do.
- **Privacy vs. liquidator-set size.** Every keeper holds each position's preimage, so widening the keeper set for liveness widens the privacy surface linearly. A future threshold-secret-sharing scheme (reconstruct the preimage only on a justified liquidation) would break this trade-off but depends on on-chain threshold-signature support (`verify_schnorr`).
- **Versioning.** Aleo programs are immutable once deployed; each revision needs a new program name (hence `v29c`). Existing positions from a prior version are not portable to a new deployment.
- **Tunable risk params.** `MAINTENANCE_MARGIN_BPS` and `LIQ_PENALTY_BPS` are placeholders; confirm the maintenance-margin basis (notional vs. entry-notional) against your risk model before mainnet.

---

*This README documents the contract as written; it is not financial or legal advice and makes no audit claim.*
