# zkperp_amm — Frontend (`zkperp-amm-ui`)

React + Vite + TypeScript frontend for the **zkperp_amm** concentrated-liquidity AMM on Aleo (USDCx / ALEO, 0.30% fee, testnet). It lets a user swap, provide concentrated liquidity, and burn LP positions against the on-chain `zkperp_amm_v4.aleo` program, signing every transaction with the **Shield** wallet.

> **Scope:** this README documents the frontend only. The Leo contract (`zkperp_amm_v4.aleo`) — its transitions, mappings, finalize logic and math — is documented separately in the contract repo. This document describes how the UI talks to that contract, not how the contract works internally.

---

## Stack

- **React 18** + **Vite 7** + **TypeScript 5.9**
- **Tailwind CSS 3.4** (+ PostCSS / autoprefixer) for styling
- **Provable Aleo wallet adaptor** `0.3.0-alpha.3` — `@provablehq/aleo-wallet-adaptor-{core,react,react-ui,shield,standard}`, `@provablehq/aleo-types`
- No backend of its own and **no environment variables** — all configuration is hardcoded as constants (see Configuration)

The wallet provider is set up in `src/main.tsx`: a single `ShieldWalletAdapter`, `network={Network.TESTNET}`, `autoConnect={false}`, `decryptPermission={UponRequest}`, and `programs={['zkperp_amm_v4.aleo', 'test_usdcx_stablecoin.aleo', 'credits.aleo']}` so the wallet can decrypt records from all three programs.

---

## What it does

A single-page app with a live pool header (Price, Tick, Liquidity = Active/Empty, Fee tier 0.30%, Pair USDCx/ALEO) and three tabs, all in `src/App.tsx`:

| Tab | Action | Contract transition |
|---|---|---|
| **Swap** | USDCx → ALEO (`buy`) or ALEO → USDCx (`sell`) at the current pool price | `swap_buy` / `swap_sell` |
| **Liquidity** | Mint a concentrated-liquidity position over a `[price_lower, price_upper]` range | `mint_position` |
| **Burn** | Close an LP position and withdraw both tokens + owed fees | `burn_position` |

Both legs of every trade are **private records**: USDCx moves as `test_usdcx_stablecoin.aleo::Token` records and ALEO moves as native `credits.aleo::credits` records. The UI loads the connected wallet's records and presents selectors so the user picks which USDCx token and which ALEO credits record to spend; change/payout records land back in their wallet.

There is no `initialize_pool` action in the UI — pool initialization is a one-time deploy-side step (covered in the contract docs). Until it has run, `fetchPoolState` returns `null` and the tabs render with no actionable pool state.

---

## Source layout

```
public/
└── zkperp-banner.png        # banner asset
src/
├── main.tsx                 # React entry; AleoWalletProvider + Shield adapter + WalletModalProvider
├── App.tsx                  # All UI: Header, Navigation, TxPanel, Swap/Liquidity/Burn tabs, record hooks
├── amm.ts                   # Constants, pool read, quote/liquidity math, Leo input builders, formatters
├── merkleProof.ts           # Builds the USDCx [MerkleProof; 2] compliance argument
├── useTransaction.ts        # Wallet executeTransaction wrapper with status polling
└── index.css                # Tailwind entry + global styles
index.html · vite.config.ts · tailwind.config.js · postcss.config.js · tsconfig.json · package.json
```

### `amm.ts`
Holds the configuration constants and all client-side math. Exports include:

- **Constants:** `PROGRAM_ID`, `USDCX_ID`, `API`, `Q64`, `FEE_BPS` (3000), `FEE_DENOM` (1_000_000), `TICK_SENTINEL` (887221), `TICK_SPACING` (60), and `ZERO_PROOF` (the empty-freeze-list Merkle proof).
- **`fetchPoolState()`** — reads `{API}/program/zkperp_amm_v4.aleo/mapping/pool_state/0u8` and returns a typed `PoolState` (or `null` if the mapping is empty).
- **Price/tick conversions:** `sqrtToPrice`, `sqrtToTick`, `tickToSqrtX64`, `tickToPrice`, `priceToTick`, `alignTick` (snaps to `TICK_SPACING`).
- **Quotes:** `computeQuote` (swap), `computeMintQuote` / `getLiquidityAmounts` (liquidity).
- **Record parsing/building:** `parseCreditsRecordMicrocredits`, `parseLPPosition`, and the Leo input-string builders `buildSwapBuyInputs`, `buildSwapSellInputs`, `buildMintInputs`, `buildBurnInputs`, plus `stepToLeo` for tick-step encoding.
- **Formatters:** `formatUsdc`, `formatAleo`.

### `merkleProof.ts`
`getMerkleProof(programId, userAddress)` fetches the program's freeze list from `https://api.provable.com/v2/testnet/programs/{programId}/compliance/freeze-list`. On a `404` or an empty list it returns the empty-tree proof (two nodes, sixteen `0field` siblings each, `leaf_index: 1u32`) — the exclusion proof that USDCx's `transfer_private` / `get_credentials` accept on testnet. Pure browser implementation, no SDK dependency.

### `useTransaction.ts`
Wraps the wallet's `executeTransaction` and polls `transactionStatus`. State machine: `idle → submitting → pending → accepted | rejected | failed | error`. It surfaces both the wallet's temporary id (`tempTxId`) and the resolved on-chain id (`onChainTxId`), stops polling on any terminal status, and times out with a "check explorer manually" error if the wallet never reports a terminal state. `App.tsx`'s `TxPanel` renders this status and links to `https://explorer.provable.com/transaction/{id}`.

---

## Records the app reads (via the wallet)

`App.tsx` uses the wallet's `requestRecords` to populate its selectors:

| Hook | Program queried | Used for |
|---|---|---|
| `useUSDCxRecords` | `test_usdcx_stablecoin.aleo` | USDCx `Token` to spend on buy / mint |
| `useAleoRecords` | `credits.aleo` | native ALEO `credits` to spend on sell / mint |
| `useLPPositions` | `zkperp_amm_v4.aleo` | LP position records to burn |

## Transactions the app submits

Each handler builds the Leo inputs in `amm.ts`, attaches the Merkle proof where USDCx is spent, and calls `tx.execute({ program: PROGRAM_ID, function, inputs, fee: 5_000_000, privateFee: false })` — i.e. a **5 credits public fee**.

| Transition | Tab | Private inputs of note |
|---|---|---|
| `swap_buy` | Swap (buy) | USDCx `Token` + Merkle proof; receives ALEO |
| `swap_sell` | Swap (sell) | ALEO `credits` record; receives USDCx |
| `mint_position` | Liquidity | both a USDCx `Token` and an ALEO `credits` record (+ Merkle proof) |
| `burn_position` | Burn | the LP position record; returns USDCx + ALEO payouts |

> The UI quotes and builds **single-range swaps** entirely client-side. Multi-tick-crossing swaps would need per-step amounts computed off-chain; that off-chain step-builder does not exist in this project yet, so multi-tick swaps aren't supported by the app.

---

## Configuration

There is **no `.env`**. The few settings live as constants at the top of `src/amm.ts`:

```ts
export const PROGRAM_ID = 'zkperp_amm_v4.aleo'
export const USDCX_ID   = 'test_usdcx_stablecoin.aleo'
export const API        = 'https://api.explorer.provable.com/v1/testnet'
```

The wallet network/programs are set in `src/main.tsx`, and the freeze-list host is in `src/merkleProof.ts`. To point the app at a different deployment, edit those constants directly.

---

## Running

```bash
npm install
npm run dev       # Vite dev server on http://0.0.0.0:5173
npm run build     # tsc -b && vite build  → dist/
npm run preview   # serve the production build
```

Connect the Shield wallet when the app loads; make sure it holds USDCx and ALEO (with usable `credits` records). The Swap/Liquidity/Burn actions become meaningful once the pool is initialized on-chain.

---

## Notes

- The app never holds keys — all signing and record decryption happen in the Shield wallet (`UponRequest` permission).
- USDCx and ALEO are handled symmetrically as private record inputs/outputs; expect change/payout records to appear in the wallet after each action.
- Quotes shown in the UI are computed locally from `pool_state`; the actual fill is whatever the contract verifies on-chain at execution.
- The header `Navigation` links out to the wider ZKPerp suite (Trade, Liquidity, ZK Darkpool, System Status, Portfolio, Compliance) and to the GitHub repo, whitepaper, and contract README.

For the contract itself — transitions, mappings, fee/price math, and deployment/initialization — see the `zkperp_amm_v4.aleo` contract documentation.
