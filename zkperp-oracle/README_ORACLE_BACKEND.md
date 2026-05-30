# ZKPerp Oracle Relay (`zkperp-oracle`)

Off-chain price-relay backend for ZKPerp. Three independent relayers (A, B, C) each read Chainlink feeds, normalise the price, and submit it to **`zkperp_oracle_v3.aleo`**. Quorum is enforced **on-chain** — when 2 of the 3 relayers agree on a price for an asset, the contract commits it to `oracle_prices`. There is no coordinator process and no single key that can write a price alone.

> **Scope:** this is the relayer backend only. The on-chain quorum logic lives in `zkperp_oracle_v3.aleo` and is documented in its own README. The ZKPerp core/bot reads `oracle_prices` from that contract; it does not talk to this service directly.

**Stack:** Node ≥ 18, `ethers` 6 (Chainlink reads), `@provablehq/sdk` 0.10.1 (Aleo tx), `dotenv`.

---

## How it works

Each relayer runs the same `relayer.js` loop independently, under its own Aleo key:

1. Read the Chainlink V3 aggregator proxy for each market (`shared/chainlink.js`, `latestRoundData`).
2. **Freshness check** — reject if the feed's `updatedAt` is older than the market's `heartbeatSec`.
3. Fetch the current Aleo block height — used as the on-chain `timestamp`.
4. **Dedup** — skip if the same Chainlink `roundId` was already submitted, *unless* the price is going stale on Aleo (no update in `MAX_BLOCKS_WITHOUT_UPDATE = 120` blocks ≈ 4 min).
5. Normalise the price to 8 decimals (`normalizeTo8`).
6. Submit `zkperp_oracle_v3.aleo/submit_price(assetKey, price, timestamp)` via **Provable DPS** (delegated proving), with a local-proving fallback.
7. **Wait for confirmation** before moving to the next market.

Markets are processed **sequentially** (BTC → ETH → SOL) and the three relayers are **staggered** (A=0s, B=60s, C=120s) so they never land `submit_price` in the same block — which would trip the contract's proposal logic. After A and B confirm, the contract reaches 2-of-3 and commits; C usually skips via dedup.

---

## Source layout

```
manager.js              # spawns 3 relayers (A/B/C), staggered 60s, auto-restart on exit
relayer.js              # the per-relayer loop (read → validate → submit → confirm)
oracle-sequential.js    # alternative: ONE process submitting A,B,C × BTC,ETH,SOL fully in order
crash-price.js          # test utility — submits a fake BTC $50,000 to trigger a liquidation demo
config/markets.json     # per-market feed address, asset key, RPC env var, heartbeat, decimals
shared/
├── chainlink.js        # readChainlinkFeed + normalizeTo8
├── aleoClient.js       # submitPriceOnChain (DPS proving + waitForConfirmation)
└── abi.js              # Chainlink AggregatorV3 ABI
```

### Markets (`config/markets.json`)

| Market | assetKey | Feed (Chainlink proxy) | RPC env var | Heartbeat |
|---|---|---|---|---|
| BTC_USD | `1field` | `0xF403…E88c` | `EVM_RPC_URL` (Ethereum) | 3600s |
| ETH_USD | `2field` | `0x5f4e…8419` | `EVM_RPC_URL` (Ethereum) | 3600s |
| SOL_USD | `3field` | `0x24ce…590c` | `EVM_RPC_URL_ARB` (Arbitrum) | 3600s |

All feeds are read at 8 decimals. The `assetKey` values match `oracle_prices` keys in the contract (and `markets.json` in the core bot).

---

## Configuration (`.env`)

### Required

```env
# One Aleo private key per relayer — each is an authorised oracle node in roles[0/1/2]
ALEO_PRIVATE_KEY_A=APrivateKey1...
ALEO_PRIVATE_KEY_B=APrivateKey1...
ALEO_PRIVATE_KEY_C=APrivateKey1...

# Provable delegated proving (DPS)
PROVABLE_API_KEY=...
PROVABLE_CONSUMER_ID=...

# EVM RPCs for the Chainlink feeds
EVM_RPC_URL=https://...        # Ethereum mainnet (BTC, ETH)
EVM_RPC_URL_ARB=https://...    # Arbitrum (SOL)
```

### Optional (defaults shown)

```env
ORACLE_PROGRAM=zkperp_oracle_v3.aleo
ALEO_NETWORK=testnet
ALEO_EXPLORER_API=https://api.explorer.provable.com/v1
POLL_INTERVAL_MS=120000        # 2-min cycle
ALEO_ENDPOINT=https://api.explorer.provable.com/v1   # Aleo node RPC
```

`manager.js` injects `RELAYER_NAME` and the matching `ALEO_PRIVATE_KEY` into each child, so you don't set those yourself when using the manager.

> The committed `.env` also carries some unused/legacy keys (`PRIVATE_KEY`, `VIEW_KEY`, `RELAYER_A_PK`/`RELAYER_A_ADDR`, `PROVABLE_JWT_TOKEN`, `CONSENSUS_VERSION_HEIGHTS`, …) that the current code does **not** read — the relayer keys it actually uses are `ALEO_PRIVATE_KEY_A/B/C`. Prune them to avoid confusion.

---

## Running

The three relayer keys must be the addresses registered in the contract's `roles[0u8/1u8/2u8]` (via `set_oracle`), or `submit_price` will be rejected on-chain.

```bash
npm install
cp .env.example .env   # (if present) — otherwise create .env from the keys above

# Recommended: manager spawns A/B/C, staggered, with auto-restart
npm start              # = node manager.js
```

Run a single relayer manually (useful for debugging one node):

```bash
npm run relayer:a      # RELAYER_NAME=A, ALEO_PRIVATE_KEY=$ALEO_PRIVATE_KEY_A
npm run relayer:b
npm run relayer:c
```

Alternative single-process mode (no parallel relayers, no JWT race — submits A,B,C for each asset strictly in order):

```bash
node oracle-sequential.js
```

Demo helper (force a price to test downstream liquidation):

```bash
node crash-price.js    # submits BTC = $50,000 to zkperp_oracle_v3.aleo
```

---

## Notes

- **On-chain quorum, off-chain relay** — this service only *submits*; the 2-of-3 agreement and the commit to `oracle_prices` happen inside `zkperp_oracle_v3.aleo`. A single compromised relayer key cannot move the price.
- **Timestamp = Aleo block height** at submission (not Unix time); downstream contracts enforce staleness as `block.height - timestamp <= MAX_PRICE_AGE_BLOCKS`.
- **Staggering matters** — if all three relayers submit in the same block the contract's proposal can reset; keep the 60s manager stagger (or use `oracle-sequential.js`).
- Each relayer waits for tx confirmation before the next market, so a full A/B/C cycle across three markets takes a few minutes — expected, not a hang.
