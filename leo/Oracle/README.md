# zkperp_oracle_v2.aleo

On-chain 2-of-3 price quorum oracle for ZKPerp. Three independent oracle nodes each hold their own Aleo private key and submit prices independently. Quorum is enforced by the Leo program — no coordinator process, no single point of failure.

---

## Architecture

```
Chainlink Feed (BTC/ETH/SOL)
        │
        ├── Relayer A (own Aleo key) ──┐
        ├── Relayer B (own Aleo key) ──┤──▶ zkperp_oracle_v2.aleo/submit_price
        └── Relayer C (own Aleo key) ──┘
                                            │
                                    2-of-3 agree on price
                                            │
                                    oracle_prices mapping updated
                                            │
                                    zkperp_core reads committed price
```

Each relayer runs independently. When ≥2 submit the same price for the same asset, the Leo program commits it to `oracle_prices`. No single key can write a price unilaterally.

---

## Security Model

Each `submit_price` call is an Aleo transaction — Ed25519 signature verification happens at the protocol level before the Leo program executes. `self.caller` inside the program is a cryptographically verified identity, not a trust assertion.

**What a single compromised key can do:** delay a round by submitting a divergent price, causing the proposal to reset. It cannot commit a bad price alone.

**What requires 2 compromised keys:** write an arbitrary price to `oracle_prices`.

This is the closest design to Chainlink OCR that Leo currently allows. The ideal architecture — a single transaction carrying a co-signed report with both signatures verified on-chain — requires a `verify_schnorr(pk, msg, sig)` opcode that Leo does not yet expose. That upgrade path (FROST threshold Schnorr) is documented as future work.

---

## On-Chain Program (`main.leo`)

### Mappings

| Mapping | Key | Value | Purpose |
|---|---|---|---|
| `roles` | `u8` (0–3) | `address` | Oracle node addresses (0=A, 1=B, 2=C, 3=admin) |
| `oracle_prices` | `field` (asset_id) | `PriceData` | Committed prices read by core contracts |
| `price_proposals` | `field` (asset_id) | `PriceProposal` | Pending votes accumulating toward quorum |

### Transitions

**`submit_price(asset_id: field, price: u64, timestamp: u32)`**
Called independently by each oracle node. Finalize logic:
1. Assert caller is a registered oracle node (roles 0–2)
2. Load existing proposal or create empty one
3. If proposal price differs from submitted price → reset proposal (new round)
4. Assert caller has not already voted in current round
5. Record vote in next empty slot
6. If `votes >= 2` → write to `oracle_prices`, mark quorum reached

**`set_oracle(slot: u8, new_addr: address)`**
Admin-only. Rotates oracle node address without redeployment.

**`set_admin(new_admin: address)`**
Admin-only. Transfers admin role.

---

## Off-Chain Stack

### `manager.js`
Spawns relayers A, B, C as child processes with staggered 1s startup. Each receives its own `ALEO_PRIVATE_KEY_A/B/C` from the environment. Auto-restarts on exit with 3s delay.

### `relayer.js`
Each relayer independently:
1. Reads Chainlink feed via EVM RPC
2. Checks freshness against `heartbeatSec` per market
3. Deduplicates by `roundId` — skips if same Chainlink round already submitted
4. Normalizes price to 8 decimals → `u64`
5. Calls `aleoClient.js/submitPriceOnChain`

### `aleoClient.js`
Wraps the Provable SDK. Builds and broadcasts the `submit_price` transaction with the relayer's private key. Fee: 0.01 credits, public fee.

---

## Configuration

### Environment Variables

```env
# One per relayer process (set in manager env)
ALEO_PRIVATE_KEY_A=APrivateKey1...
ALEO_PRIVATE_KEY_B=APrivateKey1...
ALEO_PRIVATE_KEY_C=APrivateKey1...

# Aleo network
ALEO_ENDPOINT=https://api.explorer.provable.com/v1
ALEO_NETWORK=testnet

# EVM RPC for Chainlink feeds
EVM_RPC_URL=https://mainnet.infura.io/v3/...
EVM_RPC_URL_ARB=https://arb-mainnet.infura.io/v3/...

# Oracle program name
ORACLE_PROGRAM=zkperp_oracle_v2.aleo

# Polling interval (ms, default 15000)
POLL_INTERVAL_MS=15000
```

### `config/markets.json` (expected shape)

```json
{
  "BTC": {
    "assetKey": "1field",
    "feedAddress": "0x...",
    "rpcEnvVar": "EVM_RPC_URL",
    "heartbeatSec": 3600
  },
  "ETH": {
    "assetKey": "2field",
    "feedAddress": "0x...",
    "rpcEnvVar": "EVM_RPC_URL",
    "heartbeatSec": 3600
  }
}
```

---

## Deployment

```bash
# Deploy oracle program
leo deploy --network testnet

# Initialize roles (call once after deploy)
# Set oracle A, B, C addresses via set_oracle transitions
leo execute set_oracle 0u8 aleo1..._node_a --network testnet
leo execute set_oracle 1u8 aleo1..._node_b --network testnet
leo execute set_oracle 2u8 aleo1..._node_c --network testnet

# Start all three relayers
npm start
```

---

## Known Limitations & Future Work

**Caller-supplied timestamp** — `timestamp` is provided by the relayer, not derived from `block.height`. A malicious relayer could supply a stale or future timestamp. Mitigation: replace with `block.height` in finalize and use block-based staleness checks in core contracts.

**No price tolerance band** — if relayers submit divergent prices (e.g. due to feed latency), the proposal resets silently and the round produces no quorum. Staleness checks in consuming contracts catch this as a downstream effect.

**Proposal not cleared after quorum** — a third relayer submitting after quorum increments `votes` to 3 and re-writes the same price harmlessly. A post-quorum reset would avoid the redundant write.

**`@custom constructor` / `self.program_owner`** — these are not valid Leo syntax. Role initialization is handled via a post-deploy `set_oracle` sequence called by the deployer address. The constructor block in the current file is non-functional and will be removed in v3.

**Threshold Schnorr (FROST)** — the cryptographically ideal design is a single transaction carrying a co-signed report verified on-chain against two public keys. This requires a `verify_schnorr(pk, msg, sig)` opcode. Leo does not expose this yet. When Aleo ships lower-level signature verification primitives, the oracle can be upgraded to single-transaction quorum with no change to the consuming contracts.
