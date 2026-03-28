# ZKPerp — Privacy-First Perpetuals on Aleo

> Trade BTC, ETH, and SOL with up to 20x leverage. Position size, entry price, and PnL are never visible on-chain.

**Live on Aleo Testnet** · [zk-perp.vercel.app](https://zk-perp.vercel.app) · [Whitepaper](https://zk-perp.vercel.app/whitepaper) · [GitHub](https://github.com/hwdeboer1977/ZKPerp)

---

## Wave 4 — Release Notes · March 2026

Wave 4 is the largest single upgrade to ZKPerp since launch. It replaces the v12 contract architecture with the new v21 privacy model, adds a fully decentralised 2-of-3 Chainlink oracle, introduces advanced order types, and ships a completely redesigned frontend with compliance infrastructure.

All changes are live on Aleo testnet at:
- `zkperp_btc_v21.aleo`
- `zkperp_eth_v21.aleo`
- `zkperp_sol_v21.aleo`

> These programs will be integrated in Wave 5 (maximum variables/size reached).

---

## 1. Maximum Privacy Contract (v21)

The headline change in Wave 4 is a fundamental redesign of positions and full integration of private transfers with USDCx.

### v19 vs v21 — What Changed

| Property | v19 | v21 |
|---|---|---|
| finalize args (open_position) | collateral, size, direction, price, slippage, fees (12 args) | position_id hash, nonce, orchestrator only (4 args) |
| On-chain position data | Size, collateral, direction, price visible in finalize | Nothing — zero position data on-chain |
| Oracle / slippage check | Enforced in finalize (on-chain) | Proven in ZK transition only |
| Pool state updates | In finalize (open, close, liquidate) | Via separate update_pool_state call (orchestrator) |
| PnL updates | Not present | Via update_net_pnl (orchestrator) |
| Observer sees | Hashes + OI deltas per trade | Only hashes and nonces — nothing readable |

### How It Works

- **ZK transition proves everything.** Leverage limits, slippage bounds, margin requirements, and trigger conditions are all verified inside the zero-knowledge proof. Nothing leaks to the finalize layer.
- **Finalize only checks hashes.** The on-chain finalize function receives only `position_id` (a BHP256 hash), a nonce for replay protection, and the orchestrator address. An observer watching the chain sees nothing about trade direction, size, or price.
- **Pool state by orchestrator.** Since finalize no longer updates pool state directly, the orchestrator bot calls `update_pool_state` and `update_net_pnl` after each trade event to keep on-chain mappings accurate.

---

## 2. 2-of-3 Chainlink Quorum Oracle

Wave 4 replaces the single-bot Binance/CoinGecko price feed with a production 2-of-3 threshold Chainlink relay. This is live on testnet now — not a roadmap item.

### Architecture

| Component | Description |
|---|---|
| Relayer-A / B / C | Three independent Node.js processes, each with a separate secp256k1 signing key. Each reads Chainlink price feeds on Ethereum mainnet (BTC/ETH) and Arbitrum (SOL) every 15 seconds. |
| Coordinator | Express server that receives signed submissions, verifies secp256k1 signatures against an allowlist, groups by (assetId, roundId), and fires update_price only when 2-of-3 relayers agree on the same Chainlink round. |
| Bot | The zkperp-bot receives the quorum price via POST /oracle/update and submits update_price on-chain via Provable DPS. Falls back to Binance/CoinGecko only if no fresh quorum is available. |
| Dedup | The coordinator tracks the last submitted (assetId, roundId, updatedAt) key. Re-submits after 5 minutes even on the same round to keep the bot warm across restarts. |

### Security Properties

- **Single-relayer attack impossible.** One compromised relayer cannot post a false price. Two relayers must collude and sign the same payload.
- **Allowlist enforced.** The coordinator rejects any submission from an address not in `RELAYER_A/B/C_ADDR`. Signature recovery is verified against the recovered Ethereum address before acceptance.
- **Chainlink as source of truth.** Prices come from Chainlink on-chain aggregators (BTC/ETH on Ethereum mainnet, SOL on Arbitrum) — the same feeds used by major DeFi protocols.

---

## 3. Advanced Order Types

Wave 4 adds limit orders, take profit, and stop loss — all with the same privacy guarantees as market orders. Order details are never visible on-chain before execution.

### Order Architecture

All three order types follow the dual-record pattern established by `LiquidationAuth`:

- **`OrderReceipt`** — Private record owned by the trader. Contains trigger price, size, position ID, and nonce. Used for cancellation and displayed in the frontend.
- **`ExecTPSLAuth`** — Private record owned by the orchestrator. Contains all data needed to execute the order when price triggers. The orchestrator monitors prices and executes autonomously — the trader does not need to be online.
- **`ExecLimitAuth`** — Same pattern for limit orders. The trader's slot is consumed at placement; execution mints a new filled `PositionSlot` and `LiquidationAuth` to the trader.

### Privacy Properties

- Trigger price is committed as a BHP256 hash in `pending_orders` — never visible on-chain before execution.
- Order details (size, direction, entry price) remain in private records. An observer can see that an order was placed but cannot see at what price.
- Cancellation is trader-sovereign: `cancel_tp_sl` requires the trader's `PositionSlot` and `OrderReceipt`. No orchestrator involvement needed.

### Slot Locking

Placing a limit order immediately locks the trader's long or short slot. A trader cannot open another position in the same direction until the limit order is executed or cancelled. This is enforced by the slot model — the empty `PositionSlot` is consumed at placement and only returned on execution or cancellation.

---

## 4. Liquidity Pool Upgrades

### Aggregate PnL Mapping

Because positions are private records, the Leo contract cannot compute unrealised PnL on-chain by itself. Wave 4 adds trusted orchestrator aggregation:

- **`update_net_pnl(net_pnl: i64)`** — The orchestrator computes net PnL across all open positions using their `LiquidationAuth` records and submits the signed aggregate on-chain.
- **Asymmetric treatment** — Positive PnL (traders winning) is reserved as a pool liability — LPs can withdraw less. Negative PnL (traders losing) is floored at zero — LPs do not get extra headroom on paper gains.
- **Default safety** — If the bot is offline and no PnL is submitted, `Mapping::get_or_use` defaults to `0i64` — the conservative baseline. The pool cannot be over-withdrawn even without orchestrator input.

### Withdrawal Guard Formula

The full on-chain formula enforced in `finalize_remove_liquidity`:

```
available = total_liquidity − long_OI − short_OI − max(net_pnl, 0) − 10% buffer
```

Both long and short OI are locked independently — they do not net off against each other. This mirrors the conservative GMX V2 design.

### update_pool_state

A new orchestrator-only transition updates `total_liquidity`, `long_open_interest`, `short_open_interest`, `total_lp_tokens`, and `accumulated_fees` after every trade event. This is required because v21 finalize functions no longer update pool state directly.

---

## 5. Bot Infrastructure

### Provable DPS — No snarkOS

Wave 4 removes all snarkOS dependencies. Every transaction (oracle updates, liquidations, TP/SL execution, limit order execution) is now proven via Provable's TEE-backed Delegated Proving Service (DPS). The bot no longer needs a local Aleo node or local WASM proving.

### Multi-Asset Scanner

The Provable scanner now watches all three market programs (`zkperp_btc_v21`, `zkperp_eth_v21`, `zkperp_sol_v21`) for `LiquidationAuth`, `ExecTPSLAuth`, `ExecLimitAuth`, and `PendingOrder` records. A single orchestrator manages positions across all three markets.

### Deployed on Render

| Service | Description |
|---|---|
| zkperp-bot | Orchestrator + liquidation + oracle bot. Starter plan ($7/mo), always-on, Frankfurt region. |
| aleo-oracle | Coordinator + 3 relayers managed by a process manager. Worker service, auto-restarts on crash. |

---

## 6. Frontend Redesign

### New Pages

| Page | Description |
|---|---|
| Portfolio | Private trading summary reconstructed client-side from decrypted records. Stats (PnL, volume, win rate) blurred until Wave 5. Includes Performance Proof generator placeholder. |
| Compliance | Explains the ComplianceRecord ZK receipt issued by `test_usdcx_stablecoin.aleo` on every deposit. Includes Merkle allowlist flow, selective disclosure explainer, and Wave 5 audit proof generator placeholder. |
| System Status — Oracle tab | Updated to accurately describe the live 2-of-3 Chainlink quorum setup with Relayer-A/B/C flow diagram. |

### Trade Page Improvements

- **Privacy subtitle** — 🔒 Your positions stay completely private — size, entry price, and PnL are never visible on-chain.
- **TP/SL UX** — Take Profit and Stop Loss inputs now have labelled headers (🎯 Take Profit / 🛡️ Stop Loss) with action descriptions. Buttons are more prominent with stronger colour.
- **Limit order slot warning** — A dynamic warning explains that placing a limit order locks the directional slot immediately and prevents concurrent positions in the same direction.
- **Compliance Ready info card** — Added to the bottom info card row explaining ComplianceRecord generation on every deposit.
- **Unshield panel** — Multi-line button copy now renders correctly. Added TP/SL & limit orders hint to the unshield button.
- **Liquidity page** — Available to Withdraw now correctly subtracts OI + 10% safety buffer. Locked breakdown shows OI and buffer separately.

### Unshield Architecture

The `OrderReceipt` decryption is now part of `PrivateDataContext` — the same shared instance is used by both `PositionDisplay` (for TP/SL cancellation) and `PendingOrdersDisplay` (for the pending orders list). This eliminates the dual-instance bug where cancelling a TP would not remove it from the Pending Orders panel.

---

## 7. Compliance Infrastructure

ZKPerp is built on `test_usdcx_stablecoin.aleo` which implements Sealance's Merkle-proof allowlist. Every deposit and withdrawal automatically generates a `ComplianceRecord` — a private ZK receipt that proves the transaction passed a Merkle-verified allowlist check.

### ComplianceRecord

Issued on every `transfer_private_to_public` and `transfer_public_to_private` call. Contains:

- `owner: address` (private) — only the transacting wallet can read it
- `amount: u128` (private) — transaction amount, hidden
- `merkle proof fields` (private) — position in the Sealance allowlist tree
- `merkle_root: field` (public) — verifiable against the on-chain root at the deposit block

The public `merkle_root` lets any auditor verify that a transaction was linked to a valid allowlist entry at that block height — without seeing the wallet address, amount, or any position detail.

### Privacy vs Compliance

ZKPerp demonstrates that privacy and compliance are not opposites. Traders hold their `ComplianceRecord`s privately in their wallet. They can selectively disclose a record to an auditor on request. The disclosure is cryptographically verifiable — not a screenshot or CSV export. Wave 5 will add an audit proof generator that covers a date range without revealing individual trades.

---

## 8. Known Limitations & Wave 5 Roadmap

| Item | Status / Plan |
|---|---|
| Trusted PnL aggregation | Orchestrator submits `net_unrealized_pnl` without ZK proof of correctness. Wave 5: ZK aggregation proof over `LiquidationAuth` records. |
| Pool TVL visible | `total_liquidity` mapping is public. Individual deposit amounts are private but TVL is observable. Wave 5: orchestrator-held pool token pattern. |
| Trade history | No on-chain history — positions are private records that disappear when spent. Wave 5: client-side history reconstructed from decrypted records. |
| Leaderboard / stats | No per-trader stats. Wave 5: opt-in leaderboard using public pool mappings only. |
| Performance proofs | Placeholder UI only. Wave 5: ZK proof of trading returns without revealing positions. |
| OI netting | Long and short OI locked independently (100% reserve factor each). Wave 5: may relax to max(long, short) + spread buffer. |
| Compliance dashboard | Wave 5: decrypt and display ComplianceRecords from wallet, exportable audit proofs. |

### Wave 5 Priority Items

**1. ZK Dark Pool**

A separate batch auction venue running alongside the perpetuals market. Orders accumulate over a fixed window and clear at a single uniform price — individual orders are never distinguishable on-chain, eliminating front-running entirely. `zkdarkpool_v2.aleo` already achieved a confirmed live settlement on Aleo testnet. Wave 5 integrates it fully into the ZKPerp frontend and bot infrastructure.

**2. v22 Contract Split**

A hard compiler constraint: Aleo enforces a 2 million variable limit per program and v21 is at the ceiling. The fix splits it into two programs — `v22_core.aleo` (positions, pool, oracle, liquidity) and `v22_orders.aleo` (limit orders, TP/SL, receipts).

The deeper issue is that ZKPerp is hitting the boundaries of the Leo language itself. For liquidations, the contract follows a clean pattern where all private slot records are consumed in a single transition — nothing accumulates in the wallet. This was not possible to replicate for the advanced order types. Limit orders, take profit, and stop loss each leave `OrderReceipt` and auth records in the wallet after execution rather than consuming them cleanly. Over time, a trader who places many orders accumulates a growing pile of stale records. Every wallet scan has to wade through all of them, making the UI progressively slower the more actively someone trades. The v22 split fixes this by redesigning the order lifecycle in `v22_orders.aleo` with proper record consumption.

**3. Compliance Dashboard**

`ComplianceRecord`s have been generated silently on every deposit since the USDCx integration. Wave 5 makes them actionable: the dashboard decrypts them from the connected wallet and lets traders generate a cryptographically verifiable audit proof covering a selected date range — without revealing individual trade details. Selective disclosure: the trader controls exactly what is shown and to whom.

**4. Portfolio Analytics**

The Portfolio page currently exists as a placeholder. Wave 5 completes it: full PnL history reconstructed client-side from decrypted records across all three markets, plus a performance proof — a ZK proof of trading returns verifiable by a third party without revealing which positions were held or at what prices.

---

## 9. Whitepaper v1

ZKPerp Technical Whitepaper v1 is publicly available. It covers the full protocol design: the privacy architecture, slot model, liquidity pool mechanics, 2-of-3 oracle design, advanced order types, and the compliance record system.

Available at [zk-perp.vercel.app](https://zk-perp.vercel.app) via the Whitepaper link in the navigation bar, and from this repository.

---

## Running Locally

```bash
git clone https://github.com/hwdeboer1977/ZKPerp
cd ZKPerp
npm install
npm run dev
```

Requires [Shield Wallet](https://www.shield.app/) browser extension and Aleo testnet USDCx. Bridge at [usdcx.aleo.dev](https://usdcx.aleo.dev).

---

*ZKPerp · Privacy-First Perpetuals on Aleo · github.com/hwdeboer1977/ZKPerp*
