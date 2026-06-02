# ZK Darkpool

**Privacy-preserving batch auction DEX on Aleo**

A dark pool is a private exchange where large orders can be matched without revealing trade details to the market before execution. ZK Darkpool implements this using Aleo's zero-knowledge proof system — order contents are encrypted on-chain, settlement is provably fair, and counterparty identity is never revealed.

Live on Aleo testnet: [`zkdarkpool_v9.aleo`](https://testnet.explorer.provable.com/program/zkdarkpool_v9.aleo)

---

## How It Works

### The Problem with Public DEXes

On a typical DEX every order is visible on-chain: price, size, direction, wallet address. This enables front-running (bots see your order and trade ahead of it), price impact (large orders move the market before execution), and identity correlation (your trading history is fully public).

### The ZK Darkpool Solution

Orders are submitted as encrypted records on Aleo. The operator matches orders using only the metadata needed (asset, direction, expiry) and settles at a uniform clearing price. Individual order contents — size, exact price, trader identity — remain private.

```
Trader A (buyer)  →  encrypted OrderAuth  →  Operator Bot
Trader B (seller) →  encrypted OrderAuth  →  Operator Bot
                                               ↓
                                         Batch Auction
                                         (every ~500 blocks)
                                               ↓
                                    Uniform clearing price P
                                    where: sell_limit ≤ P ≤ buy_limit
                                               ↓
                                    settle_match (ZK proof on-chain)
                                               ↓
                            FillReceipt → Trader A  (buy confirmed)
                            FillReceipt → Trader B  (sell confirmed)
                            AssetRecord → Trader A  (asset delivered)
                            USDCx       → Trader B  (payment received)
```

---

## Architecture

### Smart Contract: `zkdarkpool_v9.aleo`

The Leo contract enforces all settlement rules as zero-knowledge proofs. The operator cannot cheat — every `settle_match` execution is verified on-chain.

**All transitions:**

| Transition | Who calls | What it does |
|---|---|---|
| `deposit_asset` | Seller | Escrows the asset being sold; issues `DepositAuth` to operator |
| `submit_order` | Buyer or Seller | Places an order; issues `OrderAuth` to operator |
| `cancel_order` | User | Burns a generic OrderCommitment, marks nonce consumed |
| `cancel_buy_order` | Buyer | Cancels a buy order specifically (no escrow refund needed — USDCx never escrows) |
| `cancel_and_refund_asset` | Seller | Cancels a sell-side deposit; refunds the escrowed asset back to the seller |
| `settle_match` | Operator | Settles a matched pair using `OrderAuth` + `DepositAuth` |
| `partial_fill` | Operator | Settles part of an order, leaving residual liquidity for future matches |
| `set_operator` | Admin | Rotates the operator address (admin-only) |
| `withdraw_fees` | Operator | Claims accumulated protocol fees |
| `claim_test_asset` | Anyone | Claims 10 test units of BTC/ETH/SOL (testnet only) |
| `mint_test_asset` | Admin | Mints test asset to a specific recipient (testnet only) |

**Two-role system:**

| Role | Slot | Capability |
|---|---|---|
| Admin | `roles[0u8]` | Can call `set_operator`, `mint_test_asset` |
| Operator | `roles[1u8]` | Can call `settle_match`, `partial_fill`, `withdraw_fees`. Receives `OrderAuth` and `DepositAuth` records. |

The `@custom constructor()` runs at deploy time and seeds both roles to `self.program_owner`. They can later diverge via `set_operator` — useful for operating the matching bot from a different key than admin. The admin role has no settlement powers.

**Constants:**

| Constant | Value | Meaning |
|---|---|---|
| `MIN_FILL_SIZE` | `1_000_000u64` | Minimum fill size (1.0 unit at 6 decimals) |
| `MAX_PRICE` | `1_000_000_000u64` | Maximum limit price |
| `FEE_BPS` | `10u64` | Protocol fee = 0.10% |
| `BPS_DENOM` | `10_000u64` | Basis-point denominator |
| `CLAIM_AMOUNT` | `10_000_000u64` | Test asset claim size (10 units) |

**On-chain ZK constraints enforced in `settle_match`:**

- `buy_auth.owner == self.caller`, `sell_auth.owner == self.caller`, `deposit_auth.owner == self.caller` — operator must own all three records
- `buy_auth.asset_id == sell_auth.asset_id == deposit_auth.asset_id` — cross-asset trades rejected
- `buy_auth.direction == true`, `sell_auth.direction == false` — direction enforced per side
- `deposit_auth.user == sell_auth.user` — deposit must belong to the seller (matched by user address, see note below)
- `clearing_price <= buy_auth.limit_price` — buyer pays at most their maximum
- `clearing_price >= sell_auth.limit_price` — seller gets at least their minimum
- `0 < clearing_price <= MAX_PRICE`
- `MIN_FILL_SIZE <= fill_size <= buy_auth.size`, `<= sell_auth.size`, `<= deposit_auth.amount`
- `buyer_token.owner == buy_auth.user` — buyer's USDCx token must belong to buyer
- `buyer_token.amount >= gross_cost` — buyer can afford the trade
- In finalize: `block.height <= buy_auth.expiry` and `<= sell_auth.expiry` — neither side expired
- In finalize: `!order_consumed[buy_nonce]` and `!order_consumed[sell_nonce]` — no double-fill, both nonces atomically set true

**What leaks on-chain (finalize arguments are always public on Aleo):**

- That a settlement occurred
- Order nonces (as consumed flags)
- Fee accrued to vault

**What stays private:**

- Order size
- Exact limit prices
- Clearing price (passed as private transition input, not a finalize argument)
- Fill size
- Trader addresses
- Counterparty identity
- Expiry blocks (held in OrderAuth, asserted but never published)

### Deposit binding: by user, not by order nonce

The `DepositAuth` record has no `order_nonce` field — it carries `{ owner, user, asset_id, amount }`. The contract enforces `deposit_auth.user == sell_auth.user` at settle time, binding the deposit to the seller by **address**. A seller can therefore have multiple deposits and multiple sell orders open in the same asset; the operator chooses which deposit settles which order.

This is a deliberate simplification: requiring pre-binding would force traders to know their order nonce before deposit, which complicates UX. The trust impact is bounded — the operator can pair deposits to orders, but cannot create or modify either record, cannot settle below the seller's limit, and cannot send the asset anywhere except to the matched buyer.

### Cancellation paths

Three user-initiated escapes exist before order expiry:

| Transition | Used by | Effect |
|---|---|---|
| `cancel_order` | Either side | Burns the OrderCommitment, marks order nonce consumed. No asset refund. |
| `cancel_buy_order` | Buyer | Specifically asserts `direction == true`. Otherwise same as `cancel_order`. |
| `cancel_and_refund_asset` | Seller | Burns the `AssetEscrowReceipt`, refunds the escrowed `AssetRecord`, marks the **deposit salt** consumed (so the same deposit can't be refunded twice). |

The `AssetEscrowReceipt.order_nonce` field is misleadingly named — it's actually the **deposit salt** passed to `deposit_asset`, not an order nonce. It serves as a nullifier for the deposit (preventing double-refund), not as a link to any specific order. A trader can deposit with one salt and then submit orders with completely independent nonces.

### The Operator-Auth Record Pattern (v5+ innovation)

Earlier versions required off-chain record transfer: the operator received the user's `OrderCommitment` via an encrypted API call. This was complex (ECIES encryption, key management) and fragile.

v5 onward eliminates this entirely using the **operator-auth pattern** borrowed from ZKPerp's LiquidationAuth:

```
submit_order() returns:
  → OrderCommitment  (to user's wallet — their proof of order)
  → OperatorOrderRef (to operator — lightweight: nonce + direction + asset)
  → OrderAuth        (to operator — ALL fields needed to settle)

deposit_asset() returns:
  → AssetRecord[escrowed]  (to user — their asset locked)
  → AssetRecord[change]    (to user — remainder)
  → AssetEscrowReceipt     (to user — cancellation receipt with deposit salt)
  → DepositAuth            (to operator — amount + user + asset_id, NO nonce)
```

The operator receives everything on-chain at order placement time. No JSON files, no ECIES, no API calls between frontend and bot.

### Operator Bot (`darkpool-bot`)

A Node.js service that:

1. **Scans** new blocks for `OrderAuth` and `DepositAuth` records (Unshielded using the operator view key)
2. **Maintains** an in-memory order book, indexed by asset and direction
3. **Matches** orders every batch window using a uniform clearing price auction
4. **Settles** matched pairs automatically via delegated proving (Provable DPS) with local `leo execute` fallback

**Batch auction algorithm:**

The uniform clearing price maximises matched volume:

```
For each candidate price P:
  eligible_buys  = orders where buy.limit_price  >= P
  eligible_sells = orders where sell.limit_price <= P
  volume = min(sum(eligible_buys), sum(eligible_sells))

Clearing price = P that maximises volume
```

All matched buyers pay the same clearing price, all matched sellers receive the same clearing price. This is identical to how traditional dark pools and call auctions work.

**Safety checks before matching:**
- Sell orders without a live `DepositAuth` from the same seller in the same asset are skipped
- Expired orders are pruned before each batch
- On confirmed settlement: `OrderAuth`, `DepositAuth` removed from memory; `START_BLOCK` updated in `.env`

### Frontend (`darkpool-ui`)

React + Vite + TypeScript, using the Shield wallet adapter for Aleo.

**Tabs:**
- **Order** — Place buy or sell orders. Sell deposits auto-populate from the bot's `/deposits` endpoint
- **Receipts** — Load `FillReceipt` records from Shield wallet to view settled trades
- **Tools** — Claim test assets, deposit asset for escrow, refresh USDCx credentials
- **Operator** — Live order book status, fee vault balance, Force Settle (manual trigger)

**Transaction flow uses `useTransaction` hook:**
```
executeTransaction() → Shield wallet approves → tempTxId returned
→ transactionStatus(tempTxId) polled every 2s
→ status: submitting → pending → accepted/rejected
```

---

## Settlement Flow (End-to-End)

### Sell Side
```
1. Trader claims test asset (Tools → Claim Test Asset)
2. Trader deposits asset with a generated salt (Tools → Deposit Asset)
   → Contract issues DepositAuth to operator on-chain (bound to seller by user+asset_id)
   → User receives escrowed AssetRecord, change AssetRecord, AssetEscrowReceipt
   → Bot scans and stores DepositAuth in memory
3. Trader goes to Order → Sell
   → Bot /deposits endpoint returns the seller's available deposits
   → Trader selects deposit, enters size + min price
   → submit_order issues OrderAuth to operator on-chain
   → Bot scans and adds sell order to order book
```

### Buy Side
```
1. Trader loads their USDCx Token + Credentials from Shield wallet
2. Trader goes to Order → Buy, enters size + max price
   → submit_order issues OrderAuth to operator on-chain
   → Bot scans and adds buy order to order book
```

### Settlement (Automatic)
```
Every BATCH_BLOCKS blocks:
1. Bot runs clearing price algorithm
2. If match found:
   a. USDCx scanner refreshes Token + Credentials from Provable API
   b. Delegated proving: pm.provingRequest() → Provable DPS → tx broadcast
   c. On confirmation:
      - FillReceipt issued to buyer (with fee_paid)
      - FillReceipt issued to seller (with fee_paid = 0)
      - USDCx payment transferred buyer → seller (gross_cost = fill_size × clearing_price / 1_000_000)
      - Asset record (fill_size) returned to buyer
      - Asset record (deposit.amount - fill_size) returned to seller as remainder
      - Protocol fee (0.10% of gross_cost) accrued to fee_vault
      - Both order nonces marked consumed
      - OrderAuth + DepositAuth removed from operator memory
      - START_BLOCK updated in .env
```

### Fee Model

**Buyer-side, by design — but not yet collected on-chain.** The 0.10% protocol fee is computed as `(gross_cost × 10) / 10_000` and is *intended* to be borne by the buyer, with the seller receiving the full clearing-price-multiplied amount without deduction. Both `FillReceipt` records carry a `fee_paid` field: the buyer's shows the computed fee, the seller's is always `0u64`.

⚠️ **Current contract behavior:** as of `zkdarkpool_v9.aleo`, `settle_match` does **not** actually collect the fee. The buyer is charged exactly `gross_cost` (the check is `buyer_token.amount >= gross_cost`, not `gross_cost + fee`) and the seller receives exactly `gross_cost`; the `fee` value is only written to the buyer's `FillReceipt.fee_paid` and added to the `fee_vault[0u8]` counter via `accrue_fee`. No USDCx is moved to the program, so `fee_vault` is an unbacked accounting counter and `withdraw_fees` decrements it without a corresponding on-chain balance. Collecting the fee for real (charging the buyer `gross_cost + fee` and routing `fee` to the program) is a pending contract change — see Known Limitations.

---

## Privacy Model

| What | Visible to | Notes |
|---|---|---|
| Order direction (buy/sell) | Operator only | From OperatorOrderRef |
| Asset ID | Operator only | From OperatorOrderRef |
| Order size | Nobody | Encrypted in OrderAuth record |
| Limit price | Nobody | Encrypted in OrderAuth record |
| Trader address | Nobody | Owner field on records is private |
| Clearing price | Nobody | Private transition input, not in finalize |
| Fill size | Nobody | Private transition input, not in finalize |
| Order nonces (consumed) | Everyone | Finalize — double-fill prevention |
| Fee accrued (vault total) | Everyone | `fee_vault` mapping |
| That a settlement occurred | Everyone | On-chain transaction |

The operator sees direction and asset from `OperatorOrderRef` but **not** size or price. The full `OrderAuth` is encrypted to the operator's address and only Unshieldable with the operator view key.

---

## Trust Model

| Action | Can Operator Do It? | Why Not |
|---|---|---|
| Settle outside limit prices | ❌ No | ZK constraint: `sell.limit ≤ clearing ≤ buy.limit` |
| Steal escrowed assets | ❌ No | DepositAuth only spendable in `settle_match`; asset goes to buyer or remainder back to seller |
| Forge order fields | ❌ No | OrderAuth contents come from `submit_order` and are signed by user |
| Double-fill an order | ❌ No | `order_consumed` mapping checked + set atomically in finalize |
| Pair deposit to wrong seller | ❌ No | `deposit_auth.user == sell_auth.user` enforced |
| Settle expired orders | ❌ No | `block.height <= expiry` for both buy and sell |
| Choose which of seller's deposits backs a fill | ⚠️ Yes | Deposits matched to seller by address, not by order nonce — operator picks |
| Censor orders | ⚠️ Yes | Mitigated by `cancel_order` / `cancel_buy_order` / `cancel_and_refund_asset` and the expiry mechanism |
| See order sizes/prices | ⚠️ Yes | Operator holds OrderAuth records (necessary for matching) |
| Front-run orders | ⚠️ Limited | Batch auction with uniform clearing price reduces front-running surface |

Users can recover funds before expiry without operator cooperation: sellers call `cancel_and_refund_asset` to reclaim their escrow, buyers call `cancel_buy_order` to invalidate their order (USDCx is never escrowed buyer-side, so no refund needed).

---

## Deployment

### Contract
- **Program ID:** `zkdarkpool_v9.aleo`
- **Network:** Aleo Testnet
- **Deploy block:** `15,681,876`
- **Deployed:** April 10, 2026

### Bot
Runs as a Node.js process. Requires:
```env
PROGRAM_ID=zkdarkpool_v9.aleo
OPERATOR_PRIVATE_KEY=APrivateKey1...
OPERATOR_VIEW_KEY=AViewKey1...
OPERATOR_ADDRESS=aleo1...
PROVABLE_CONSUMER_ID=...
PROVABLE_API_KEY=...
START_BLOCK=15681876
BATCH_BLOCKS=500
BOT_PORT=3001
```

Start:
```bash
cd darkpool/bot
npm install
npm start
```

### Frontend
```bash
cd darkpool/frontend
npm install
cp .env.example .env  # set VITE_OPERATOR_ADDRESS, VITE_BOT_API
npm run dev           # development
npm run build         # production build
```

---

## Technical Constraints

**Aleo platform constraints:**
- `finalize` arguments are always public — fee, consumed nonces visible on-chain
- 32 call limit per transaction — limits batch size
- ~6s block time, ~30–60s proving time — throughput ~1–2 settlements/minute
- One settlement per transaction — no batch settlement at the contract level

**Design decisions:**
- Single operator (centralised matching, decentralised settlement verification)
- In-memory order book — state lost on restart, `START_BLOCK` determines recovery window
- USDCx (`test_usdcx_stablecoin.aleo`) as the quote currency for testnet
- Uniform clearing price (not FIFO) — fairer for privacy-preserving batch auctions
- Buyer-side fee only (by design) — reduces transaction complexity; seller receives clean payout. Note: fee collection is computed/tracked but not yet enforced in `settle_match` (see Fee Model and Known Limitations)
- Deposit matched to seller by user address, not bound to specific order nonce — improves UX at the cost of weaker cryptographic pairing

---

## Comparison with Existing Solutions

| Feature | Hyperliquid | AutoPerp | ZK Darkpool |
|---|---|---|---|
| Order privacy | ❌ Public | ❌ Public | ✅ Private |
| Trader identity | ❌ Public | ❌ Public | ✅ Private |
| Settlement verification | Off-chain | Off-chain | ✅ On-chain ZK proof |
| Front-running resistance | ❌ No | ❌ No | ✅ Batch auction |
| Censorship resistance | ❌ Centralised | ❌ Centralised | ⚠️ Cancel + expiry fallback |

---

## Roadmap

- [ ] Multi-operator support (threshold settlement)
- [ ] Asset bridge (replace `claim_test_asset` with real bridge)
- [x] Partial fill support — `partial_fill` transition deployed in v8
- [ ] ETH/SOL markets (separate program per market — required by Aleo privacy model)
- [ ] Record consolidation (`join` multiple AssetRecords)
- [ ] On-chain price oracle integration for clearing price validation
- [ ] Mainnet deployment
- [ ] Deposit-to-order nonce binding (stronger cryptographic pairing than current address-only binding)

---

## Known Limitations & Future Work

**Stale file header** — line 3 of `main.leo` reads `zkdarkpool_v9.aleo` but the program declaration at line 64 is `zkdarkpool_v9.aleo`. Cosmetic stale comment from v5→v8 iterations, no functional impact.

**Fee computed but not collected** — `settle_match` computes the 0.10% fee and increments the `fee_vault[0u8]` counter, but it does not charge the buyer for it or move any USDCx to the program. The buyer pays `gross_cost`, the seller receives `gross_cost`, and `fee_vault` is therefore an unbacked counter; `withdraw_fees` decrements it without a real balance behind it. A future contract revision should assert `buyer_token.amount >= gross_cost + fee` and route `fee` to the program (or deduct it from the seller's payout) so the vault is backed by actual USDCx. The README's Fee Model section documents both the intent and the current behavior.

**Address-based deposit binding** — see "Deposit binding" section above. The operator selects which of a seller's deposits backs each sell-order settlement. Future versions could bind `DepositAuth.order_nonce` at deposit time for stronger pairing, at the cost of pre-knowing the order nonce.

**Single operator** — censorship mitigated by user-initiated cancel transitions and order expiry, but a stalled operator forces traders to wait for expiry or proactively cancel. Multi-operator threshold settlement is on the roadmap.

**In-memory order book** — bot state is reconstructed from on-chain records on restart, using `START_BLOCK` as the recovery anchor. Operator can fall behind during prolonged downtime; users with orders placed during the gap may need to cancel and resubmit.

---

## Related Projects

- [ZKPerp](https://zkperp.io) — Private perpetuals DEX on Aleo (same operator-auth record pattern, same compliance layer)
- [HumanityLink](https://humanitylink.org) — ZK-based humanitarian aid distribution on Aleo

---

*Built on [Aleo](https://aleo.org) · Leo 4.0 · Testnet Beta*
