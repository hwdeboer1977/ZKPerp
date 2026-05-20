# ZK Darkpool

**Privacy-preserving batch auction DEX on Aleo**

A dark pool is a private exchange where large orders can be matched without revealing trade details to the market before execution. ZK Darkpool implements this using Aleo's zero-knowledge proof system — order contents are encrypted on-chain, settlement is provably fair, and counterparty identity is never revealed.

Live on Aleo testnet: [`zkdarkpool_v8.aleo`](https://testnet.explorer.provable.com/program/zkdarkpool_v8.aleo)

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
                            AssetRecord → Trader B  (asset delivered)
                            USDCx       → Trader A  (payment received)
```

---

## Architecture

### Smart Contract: `zkdarkpool_v8.aleo`

The Leo contract enforces all settlement rules as zero-knowledge proofs. The operator cannot cheat — every `settle_match` execution is verified on-chain.

**Key transitions:**

| Transition | Who calls | What it does |
|---|---|---|
| `deposit_asset` | Seller | Escrows the asset being sold, issues `DepositAuth` to operator |
| `submit_order` | Buyer or Seller | Places an order, issues `OrderAuth` to operator |
| `settle_match` | Operator | Settles a matched pair using `OrderAuth` + `DepositAuth` |
| `claim_test_asset` | Anyone | Claims 10 test units of BTC/ETH/SOL (testnet only) |
| `withdraw_fees` | Operator | Claims accumulated protocol fees |

**On-chain enforcement (ZK constraints in `settle_match`):**
- `clearing_price >= sell_order.limit_price` — seller gets at least their minimum
- `clearing_price <= buy_order.limit_price` — buyer pays at most their maximum
- `buy_order.order_nonce` not consumed — no double-fill
- `sell_order.order_nonce` not consumed — no double-fill
- `deposit_auth.order_nonce == sell_order.order_nonce` — escrowed asset matches sell order
- `deposit_auth.amount >= fill_size` — sufficient collateral

**What leaks on-chain (finalize arguments are always public on Aleo):**
- That a settlement occurred
- Order expiry blocks
- Fee paid
- Both order nonces (as consumed flags)

**What stays private:**
- Order size
- Exact limit prices
- Trader addresses
- Counterparty identity

### The `LiquidationAuth` Pattern (v5 Innovation)

Previous versions required off-chain record transfer: the operator needed to receive the user's `OrderCommitment` record via an encrypted API call. This was complex (ECIES encryption, key management) and fragile.

v5 eliminates this entirely using the **operator-auth record pattern** from ZKPerp:

```
submit_order() returns:
  → OrderCommitment  (to user's wallet — their proof of order)
  → OperatorOrderRef (to operator — lightweight: nonce + direction)
  → OrderAuth        (to operator — ALL fields needed to settle)

deposit_asset() returns:
  → AssetRecord[escrowed]  (to user — their asset locked)
  → AssetRecord[change]    (to user — remainder)
  → AssetEscrowReceipt     (to user — receipt)
  → DepositAuth            (to operator — amount + nonce)
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
- Sell orders without a live `DepositAuth` in memory are skipped (their escrow is spent)
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
2. Trader deposits asset with a generated nonce (Tools → Deposit Asset)
   → Contract issues DepositAuth to operator on-chain
   → Bot scans and stores DepositAuth in memory
3. Trader goes to Order → Sell
   → Bot /deposits endpoint returns available deposits
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
      - FillReceipt issued to buyer and seller
      - USDCx payment transferred to buyer's change record
      - Asset record returned to seller (or transferred to buyer)
      - Protocol fee (0.10%) accrued to fee_vault
      - OrderAuth + DepositAuth removed from operator memory
      - START_BLOCK updated in .env
```

---

## Privacy Model

| What | Visible to | Notes |
|---|---|---|
| Order direction (buy/sell) | Operator only | From OperatorOrderRef |
| Asset ID | Operator only | From OperatorOrderRef |
| Order size | Nobody | Encrypted in OrderAuth |
| Limit price | Nobody | Encrypted in OrderAuth |
| Trader address | Nobody | Owner field is private |
| Clearing price | Everyone | Finalize argument (public) |
| That a settlement occurred | Everyone | On-chain transaction |
| Expiry blocks | Everyone | Finalize argument (public) |
| Fee paid | Everyone | Finalize argument (public) |
| Order nonces (consumed) | Everyone | Finalize — double-fill prevention |

The operator sees direction and asset from `OperatorOrderRef` but **not** size or price. The full `OrderAuth` is encrypted to the operator's address and only Unshieldable with the operator view key.

---

## Trust Model

| Action | Can Operator Do It? | Why Not |
|---|---|---|
| Settle outside limit prices | ❌ No | ZK constraint in `settle_match` |
| Steal escrowed assets | ❌ No | DepositAuth only spendable in `settle_match` |
| Double-fill an order | ❌ No | `order_consumed` mapping on-chain |
| Censor orders | ⚠️ Yes | Orders expire after `expiry` blocks |
| See order sizes/prices | ⚠️ Yes | Operator holds OrderAuth records |
| Front-run orders | ⚠️ Limited | Batch auction reduces front-running opportunity |

Censorship is mitigated by the expiry mechanism — if the operator refuses to settle, traders can prove their order was placed (via `OrderCommitment` record) and funds are recoverable after expiry.

---

## Deployment

### Contract
- **Program ID:** `zkdarkpool_v8.aleo`
- **Network:** Aleo Testnet
- **Deploy block:** `15,681,876`
- **Deployed:** April 10, 2026

### Bot
Runs as a Node.js process. Requires:
```env
PROGRAM_ID=zkdarkpool_v8.aleo
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
- `finalize` arguments are always public — clearing price, expiry, fee visible on-chain
- 32 call limit per transaction — limits batch size
- ~6s block time, ~30-60s proving time — throughput ~1-2 settlements/minute
- One settlement per transaction — no batch settlement

**Design decisions:**
- Single operator (centralised matching, decentralised settlement verification)
- In-memory order book — state lost on restart, `START_BLOCK` determines recovery window
- USDCx (`test_usdcx_stablecoin.aleo`) as the quote currency for testnet
- Uniform clearing price (not FIFO) — fairer for privacy-preserving batch auctions

---

## Comparison with Existing Solutions

| Feature | Hyperliquid | AutoPerp | ZK Darkpool |
|---|---|---|---|
| Order privacy | ❌ Public | ❌ Public | ✅ Private |
| Trader identity | ❌ Public | ❌ Public | ✅ Private |
| Settlement verification | Off-chain | Off-chain | ✅ On-chain ZK proof |
| Front-running resistance | ❌ No | ❌ No | ✅ Batch auction |
| Censorship resistance | ❌ Centralised | ❌ Centralised | ⚠️ Expiry fallback |

---

## Roadmap

- [ ] Multi-operator support (threshold settlement)
- [ ] Asset bridge (replace `claim_test_asset` with real bridge)
- [ ] Partial fill support (currently one full fill per settlement)
- [ ] ETH/SOL markets (separate program per market — required by Aleo privacy model)
- [ ] Record consolidation (`join` multiple AssetRecords)
- [ ] On-chain price oracle integration for clearing price validation
- [ ] Mainnet deployment

---

## Related Projects

- [ZKPerp](https://zkperp.io) — Private perpetuals DEX on Aleo (same operator key infrastructure)
- [HumanityLink](https://humanitylink.org) — ZK-based humanitarian aid distribution on Aleo

---

*Built on [Aleo](https://aleo.org) · Leo 4.0 · Testnet Beta*
