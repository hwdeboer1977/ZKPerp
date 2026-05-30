# ZKPerp Frontend

React + Vite + TypeScript frontend for the ZKPerp privacy-preserving perpetual DEX on Aleo.

**Live:** [zk-perp.vercel.app](https://zk-perp.vercel.app)

---

## Quick Start

```bash
npm install
cp .env.example .env.local
# Set VITE_BOT_API=https://zkperp-bot.onrender.com
npm run dev
# Runs at http://localhost:5173
```

---

## Prerequisites

- **Node.js 18+**
- **[Shield Wallet](https://www.shieldwallet.xyz/)** browser extension — the only supported wallet. Shield uses Provable's delegated proving so transactions complete in ~15s without local WASM proving.
- **USDCx on Aleo testnet** — bridge USDC from Sepolia via the "Get USDCx" button in the app.

---

## Environment Variables

```bash
# .env.local
VITE_BOT_API=https://zkperp-bot.onrender.com   # Bot API for oracle status + orderId polling
```

Set `VITE_BOT_API` in Vercel dashboard for production deployments.

---

## Project Structure

```
src/
├── components/
│   ├── Header.tsx                 # Wallet connection, balances
│   ├── Navigation.tsx             # Tab bar (Trade / Liquidity / ZK Darkpool / System Status / Portfolio / Compliance)
│   ├── AppLayout.tsx              # Shared page wrapper
│   ├── TradingWidget.tsx          # Long / Short / Limit order form
│   ├── PositionDisplay.tsx        # Open positions, TP/SL, close position
│   ├── PendingOrdersDisplay.tsx   # Active limit orders with cancel
│   ├── UnshieldPanel.tsx          # Decrypt all private records button
│   ├── TransactionStatus.tsx      # Tx polling + explorer link
│   └── InitializeSlotsPrompt.tsx  # First-time slot initialization flow
│
├── contexts/
│   └── PrivateDataContext.tsx     # Shared USDCx + OrderReceipt state (single instance)
│
├── hooks/
│   ├── useSlots.ts                # PositionSlot fetch + decrypt (per pair)
│   ├── useLPTokens.ts             # LPSlot fetch + decrypt
│   ├── useOrderReceipts.ts        # OrderReceipt + LimitReceipt fetch + decrypt
│   ├── useUSDCx.ts                # USDCx Token record fetch + decrypt
│   ├── useOnChainData.ts          # Pool state, oracle price, OI (public mappings)
│   ├── useTransaction.ts          # Transaction execution + status polling
│   └── usePositionScanner.ts      # Fallback position scanner via tx history
│
├── pages/
│   ├── TradePage.tsx              # Main trading page (/trade/:pair)
│   ├── LiquidityPage.tsx          # LP deposit/withdraw (/liquidity/:pair)
│   ├── DarkpoolPage.tsx           # ZK dark pool batch auctions (/darkpool)
│   ├── SystemStatusPage.tsx       # Oracle + bot + contract status (/status)
│   ├── PortfolioPage.tsx          # Trading summary + performance (/portfolio)
│   ├── CompliancePage.tsx         # ComplianceRecord explainer (/compliance)
│   ├── AdminPage.tsx              # Admin controls (/admin, unlisted)
│   └── LandingPage.tsx            # Landing / redirect
│
├── config/
│   └── pairs.ts                   # BTC / ETH / SOL market config + programIds
│
├── utils/
│   ├── aleo.ts                    # formatUsdc, formatPrice, parseUsdc, PROGRAM_ID, etc.
│   └── merkleProof.ts             # Sealance Merkle proof fetcher for USDCx transfers
│
└── App.tsx                        # Router + wallet provider + PrivateDataProvider
```

---

## Key Concepts

### Private record lifecycle

All position and order data lives in **Aleo private records** — encrypted UTXO-style objects only the owner can read. The frontend interacts with them in two phases:

1. **Fetch** — `requestRecords(programId)` returns encrypted ciphertexts from the wallet
2. **Decrypt** — `decrypt(ciphertext)` prompts the user to approve decryption and returns plaintext

This two-phase pattern appears in `useSlots`, `useLPTokens`, and `useOrderReceipts`. The user sees one wallet popup per record.

### Slot model

Each trader holds exactly **3 records forever**: `PositionSlot` (slot 0 = long), `PositionSlot` (slot 1 = short), and `LPSlot`. These are initialized once via `initialize_slots` and mutated in place on every trade. After 1000 trades the wallet still holds 3 records.

### Shared context

`PrivateDataContext` holds a single instance of `useOrderReceipts` (initialized with the BTC program ID). Both `PositionDisplay` (for TP/SL cancel) and `PendingOrdersDisplay` (for the pending orders list) read from this shared instance — so when `markSpent` is called after a cancel confirms on-chain, both components update simultaneously.

### Oracle receipts and tpOrderId

After placing a TP or SL, the bot polls `POST /oracle/update` to retrieve the `orderId` from the transaction and saves it to `localStorage` under the position ID. If `VITE_BOT_API` is not set, this polling falls back to `localhost:3001` and the orderId will not be saved — meaning the cancel flow must fall back to matching receipts by `positionId` instead.

---

## Pages

| Route | Page | Description |
|---|---|---|
| `/trade/:pair` | TradePage | Open/close positions, TP/SL, limit orders. Pair: `btc`, `eth`, `sol` |
| `/liquidity/:pair` | LiquidityPage | Deposit/withdraw LP liquidity |
| `/darkpool` | DarkpoolPage | ZK dark pool batch auction UI |
| `/status` | SystemStatusPage | Oracle status, bot health, contract addresses |
| `/portfolio` | PortfolioPage | Private trading summary (Wave 5 stats blurred) |
| `/compliance` | CompliancePage | ComplianceRecord ZK receipt explainer |
| `/admin` | AdminPage | Admin controls (unlisted) |

---

## Scripts

```bash
npm run dev      # Dev server (http://localhost:5173)
npm run build    # Production build
npm run preview  # Preview production build
npm run lint     # ESLint
```

---

## Deployment (Vercel)

The frontend auto-deploys from the `main` branch via Vercel.

Required environment variable in Vercel dashboard:
```
VITE_BOT_API=https://zkperp-bot.onrender.com
```

Without this, TP/SL order IDs will not be saved after placement and the cancel flow will rely on fallback receipt matching.
