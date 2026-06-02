# ZKPerp Limit Orders (`zkperp_limit_v26.aleo`)

Limit-order placement and execution for **ZKPerp**, a privacy-first perpetuals DEX on Aleo. Traders place limit orders here with their collateral locked in escrow; an orchestrator bot watches the oracle and triggers execution when price crosses the order's trigger. Order parameters (size, trigger price, direction) are never written to public state — they live in private records held by the trader and the orchestrator.

This is a **separate program from `zkperp_core`** by design: splitting limit orders out keeps each transaction comfortably under Aleo's 32-call-per-transaction limit. The limit contract escrows collateral and authorizes execution; the actual leveraged position is opened in the target core program by the orchestrator as a follow-on step.

This program depends on three companion programs:

| Import | Role |
| --- | --- |
| `test_usdcx_stablecoin.aleo` | The USDCx collateral token (private/public transfers, compliance records). |
| `zkperp_compliance_v9.aleo` | KYC/compliance gate — `place` and `cancel` check a `ZKPerpComplianceRecord`. |
| `zkperp_oracle_v4.aleo` | Price feed. Reads enforce a staleness guard and supply the trigger comparison. |

---

## How It Works

1. **Place.** The trader calls `place_limit_order`, locking USDCx collateral into the program vault. The contract issues a `LimitOrderReceipt` (to the trader, as proof) and an `ExecLimitAuth` (to the orchestrator, carrying everything needed to execute).
2. **Monitor.** The orchestrator bot watches `zkperp_oracle_v4.aleo` prices. When the price crosses the order's `trigger_price`, it calls `execute_limit_order`.
3. **Execute.** `execute_limit_order` verifies the trigger against the fresh oracle price, refunds the escrowed collateral back to the trader as a private USDCx token, and clears the order's on-chain state. The orchestrator then opens the actual position in the target core program (`zkperp_core` / `zkperp_eth` / `zkperp_sol`) using the refunded collateral.
4. **Cancel.** Before execution, the trader can call `cancel_limit_order` to reclaim their collateral and invalidate the order.

```
Trader ── place_limit_order ──▶ collateral escrowed in vault
              │                         │
              ├── LimitOrderReceipt ─▶ trader (proof / cancel ticket)
              └── ExecLimitAuth ─────▶ orchestrator
                                          │
                          oracle price crosses trigger
                                          │
              orchestrator ── execute_limit_order ──▶ collateral refunded to trader
                                          │                + order state cleared
                                          ▼
                          orchestrator opens position in core
```

---

## Architecture

### Transitions

| Transition | Who calls | What it does |
|---|---|---|
| `place_limit_order` | Trader | Locks collateral, issues `LimitOrderReceipt` (trader) + `ExecLimitAuth` (orchestrator), marks the order pending. Compliance-gated. |
| `execute_limit_order` | Orchestrator | Verifies the oracle trigger, refunds collateral to the trader, clears order state. Orchestrator-only. |
| `cancel_limit_order` | Trader | Refunds collateral and removes the pending order. Compliance-gated. |
| `burn_limit_receipt` | Trader | Discards a stale `LimitOrderReceipt` once its order is no longer pending (e.g. after execution). |

### Roles

| Role | Slot | Capability |
|---|---|---|
| Admin | `roles[0u8]` | Reserved (no admin-only transitions in this program). |
| Orchestrator | `roles[1u8]` | The only address allowed to call `execute_limit_order`; receives every `ExecLimitAuth`. |

The `@custom constructor()` seeds both `roles[0u8]` (admin) and `roles[1u8]` (orchestrator) to `self.program_owner` at deploy time. `place_limit_order` asserts in finalize that the supplied orchestrator address equals `roles[1u8]`, so a trader cannot route their order's execution authority to an arbitrary address.

### Constants

| Constant | Value | Meaning |
|---|---|---|
| `MAX_PRICE_AGE_BLOCKS` | `150` | Oracle staleness limit (~5 min). Enforced on place and execute. |
| `OPENING_FEE_BPS` | `1_000` | Opening fee = 0.1% of size (per-million divisor: `value / 1_000_000`). |

> The `_BPS` name follows the ZKPerp convention but uses a **per-million** divisor, so the value is not a literal basis point.

### Mappings

| Mapping | Type | Purpose |
|---|---|---|
| `roles` | `u8 => address` | `0u8` admin, `1u8` orchestrator. |
| `pending_limit_orders` | `field => bool` | Marks an order active; removed on execution or cancellation. |
| `limit_order_traders` | `field => address` | `order_id → trader`, used to authorize cancellation. |
| `used_nonces` | `field => bool` | Replay protection for both placement nonces and execution nonces. |

### Records

- **`LimitOrderReceipt`** (trader-owned) — `{ owner, order_id, asset_id, is_long, trigger_price, size_usdc, collateral_usdc, nonce }`. The trader's private proof of a pending order and their cancellation ticket.
- **`ExecLimitAuth`** (orchestrator-owned) — `{ owner, order_id, trader, slot_id, asset_id, is_long, trigger_price, size_usdc, collateral_usdc, nonce }`. Carries every field the orchestrator needs to execute, mirroring the operator-auth pattern used elsewhere in ZKPerp (e.g. `LiquidationAuth`). No off-chain record handoff is required — the orchestrator receives this on-chain at placement time.

`collateral_usdc` in both records is the collateral **after** the opening fee is deducted.

**Asset IDs:** `1field` = BTC, `2field` = ETH, `3field` = SOL.

---

## Order identity & trigger semantics

The `order_id` is `BHP256::hash_to_field(LimitOrderIdInput { trader, nonce, trigger_price, asset_id })`, so it binds the order to its trader, nonce, trigger, and market.

Trigger direction is evaluated in `execute_limit_order`'s finalize against the fresh oracle price:

- **Long limit** — executes when `oracle_price <= trigger_price` (buy the dip).
- **Short limit** — executes when `oracle_price >= trigger_price` (sell the top).

---

## Validation

### `place_limit_order`
- `size_usdc >= 100` (minimum size).
- Leverage `<= 20×` — checked as `(size_usdc * 100) / collateral <= 2000`.
- Opening fee `= size_usdc * 0.1%` is deducted; `collateral_after_fee` is what gets recorded and later refunded.
- **Compliance (finalize):** `cr.issued_under == compliance_root[0u8]`, `!revoked[caller]`, `block.height <= cr.expires_at`.
- Nonce not previously used (`used_nonces`), then marked used.
- Supplied `orchestrator == roles[1u8]`.
- Oracle price for `asset_id` is fresh (`block.height - timestamp <= MAX_PRICE_AGE_BLOCKS`).

### `execute_limit_order`
- Caller owns the `ExecLimitAuth` (`self.caller == auth.owner`, i.e. the orchestrator).
- **Trigger (finalize):** oracle price fresh, and the long/short trigger condition above holds.
- Order is still active (`pending_limit_orders[order_id]`).
- A distinct `execution_nonce` is unused, then marked used (prevents replaying an execution).
- Clears `pending_limit_orders` and `limit_order_traders` for the order.

### `cancel_limit_order`
- `self.signer == receipt.owner`.
- **Compliance (finalize):** same three checks as placement.
- Caller matches the stored trader (`limit_order_traders[order_id]`) and the order is still active.
- Refunds `collateral_usdc` and clears order state.

### `burn_limit_receipt`
- `self.signer == receipt.owner` and the order is no longer pending — lets a trader clean up a receipt for an order the orchestrator already executed.

---

## Compliance model

Unlike `zkperp_core` — which deliberately omits the Merkle-root match to avoid locking out traders on root rotation — this limit contract enforces the **full three-check gate** (including `issued_under == compliance_root[0u8]`) on `place_limit_order` and `cancel_limit_order`. `execute_limit_order` is exempt because it is an orchestrator action, not a trader action (the same exemption pattern core applies to its keeper/orchestrator functions).

One consequence worth noting: because placement and cancellation require the root match, if the admin rotates the compliance root while an order is pending, the trader must re-issue their `ZKPerpComplianceRecord` before they can cancel. The order can still be executed by the orchestrator (execution is exempt) or left to expire from the order book off-chain.

---

## Collateral & fee flow

- **Place** locks the full supplied `collateral` into the program vault (`transfer_private_to_public` to `self.address`).
- **Execute** and **Cancel** each refund `collateral_after_fee` to the trader (`transfer_public_to_private`).

The `opening_fee` (the difference between the deposited collateral and `collateral_after_fee`) therefore remains in the program vault in both the executed and cancelled paths. See Known Limitations regarding fee retention and the absence of a withdrawal path in this program.

---

## Trust model

| Action | Can the orchestrator do it? | Why / why not |
|---|---|---|
| Execute outside the trigger | ❌ No | Finalize asserts the oracle-price trigger condition for the order's direction. |
| Execute on a stale price | ❌ No | `block.height - timestamp <= MAX_PRICE_AGE_BLOCKS`. |
| Forge or alter an order | ❌ No | `ExecLimitAuth` is minted only by `place_limit_order`; its fields are fixed at placement. |
| Replay an execution | ❌ No | `execution_nonce` is checked and set in `used_nonces`; the order is also removed from `pending_limit_orders`. |
| Steal collateral | ❌ No | Execute/cancel only `transfer_public_to_private` to `auth.trader` / `receipt.owner`. |
| Be a substituted/colluding executor | ❌ No | `place_limit_order` pins `orchestrator == roles[1u8]`. |
| Refuse to execute / censor | ⚠️ Yes | A stalled orchestrator can ignore an order; the trader's recourse is `cancel_limit_order`. |

---

## Privacy model

| Data | Visibility |
|---|---|
| `is_long`, `trigger_price`, `size_usdc` | Private (transition inputs / record fields). |
| Trader address | Private (record `owner`). |
| `asset_id` | Public (transition input — the market is visible). |
| `order_id` (as a pending/consumed flag) | Public (finalize mapping). |
| Nonces (as consumed flags) | Public (finalize mapping). |

---

## Deployment

- **Program ID:** `zkperp_limit_v26.aleo`
- **Network:** Aleo Testnet
- Companion programs (`test_usdcx_stablecoin.aleo`, `zkperp_compliance_v9.aleo`, `zkperp_oracle_v4.aleo`) must already be deployed.

The orchestrator address (`roles[1u8]`) can be operated from a different key than admin if `set_operator`-style rotation is later added; as written, both roles are seeded to the deployer and there is no rotation transition in this program.

---

## Known Limitations & Future Work

**Opening fee is retained but not withdrawable here.** Both `execute_limit_order` and `cancel_limit_order` refund only `collateral_after_fee`, so the `opening_fee` portion stays in the program vault. This program has no `fee_vault` mapping and no `withdraw_fees` transition, so the retained fee is not claimable from within `zkperp_limit_v26.aleo` as written. Decide whether the fee should be (a) waived on cancellation (refund the full collateral), (b) swept to a withdrawable vault, or (c) forwarded to core at execution time.

**Cancellation still charges the opening fee.** A trader who cancels an unexecuted order is refunded `collateral_after_fee`, not the full deposit. If the intent is "no fee unless the order actually opens a position," cancellation should refund the full `collateral`.

**Execution does not open the position on-chain in this program.** `execute_limit_order` refunds collateral and clears state; opening the leveraged position in the target core program is a separate orchestrator step. The two steps are not atomic — between the refund and the core `open_position`, the trader holds the collateral as a normal USDCx token. This is a deliberate split for the 32-call limit, but it means execution liveness/atomicity depends on the orchestrator's follow-through.

**Target core version drift.** The source header references opening positions in `zkperp_core_v27` / `zkperp_eth_v26` / `zkperp_sol_v26`. Because this contract does not import or call core directly, those identifiers are orchestrator configuration, not on-chain bindings — keep the bot's target program IDs aligned with the actually-deployed core versions.

**Single orchestrator.** Execution is `roles[1u8]`-only; a stalled orchestrator forces traders to cancel. Multi-executor / threshold execution would remove this liveness dependency.

---

*This README documents the contract as written; it is not financial or legal advice and makes no audit claim.*
