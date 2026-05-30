# zkperp_oracle_v3.aleo

On-chain 2-of-3 price quorum oracle for ZKPerp. Three independent oracle nodes each hold their own Aleo private key and submit prices independently. Quorum is enforced by the Leo program — no coordinator process, no single point of failure.

---

## Architecture

```
Chainlink Feed (BTC/ETH/SOL)
        │
        ├── Relayer A (own Aleo key) ──┐
        ├── Relayer B (own Aleo key) ──┤──▶ zkperp_oracle_v3.aleo/submit_price
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

Each `submit_price` call is an Aleo transaction — signature verification happens at the protocol level before the Leo program executes. `self.caller` inside the program is a cryptographically verified identity, not a trust assertion.

**What a single compromised key can do:** delay a round by submitting a divergent price, causing the proposal to reset. It cannot commit a bad price alone.

**What requires 2 compromised keys:** write an arbitrary price to `oracle_prices`.

This is the closest design to Chainlink OCR that Leo currently allows. The ideal architecture — a single transaction carrying a co-signed report with both signatures verified on-chain — requires a `verify_schnorr(pk, msg, sig)` opcode that Leo does not yet expose. That upgrade path (FROST threshold Schnorr) is documented as future work.

---

## On-Chain Program (`main.leo`)

### Structs

```leo
struct PriceData {
    price:     u64,        // price scaled to 8 decimals (e.g. $69,000 = 6,900,000,000,000)
    timestamp: u32,        // Aleo block height at quorum (NOT Unix time)
}

struct PriceProposal {
    price:     u64,        // candidate price under consideration
    timestamp: u32,        // candidate timestamp
    votes:     u8,         // number of distinct oracle votes so far (0, 1, or 2)
    voter_a:   address,    // first voter (zero address if no vote yet)
    voter_b:   address,    // second voter
    voter_c:   address,    // third voter
}
```

### Mappings

| Mapping | Key | Value | Purpose |
|---|---|---|---|
| `roles` | `u8` (0–3) | `address` | Oracle node addresses (0=A, 1=B, 2=C, 3=admin) |
| `oracle_prices` | `field` (asset_id) | `PriceData` | Committed prices read by core contracts |
| `price_proposals` | `field` (asset_id) | `PriceProposal` | Pending votes accumulating toward quorum |

### Initialization

The program uses an `@custom constructor()` block that runs once at deploy time. It writes `self.program_owner` (the deployer address) into all four `roles` slots. After deploy, the deployer rotates in the real oracle node addresses via `set_oracle` for slots 0/1/2 — slot 3 (admin) remains the deployer unless explicitly transferred with `set_admin`.

### Transitions

**`submit_price(asset_id: field, price: u64, timestamp: u32)`**
Called independently by each oracle node. Finalize logic:

1. **Authorization** — caller must be in `roles[0u8 | 1u8 | 2u8]`. Admin slot does not authorize price submissions.
2. **Load proposal** — fetch existing `PriceProposal` for `asset_id`, or initialize an empty one keyed at the submitted price.
3. **Round continuity** — three branches:
   - If `proposal.votes == 0` (fresh slot, or proposal was cleared after a previous quorum) → start a new round at the submitted price
   - Else if `proposal.price == submitted price` → continue accumulating votes in the current round
   - Else (`votes > 0` AND price differs) → reset proposal, start a new round at the submitted price
4. **No double-voting** — reject if the caller is already recorded as `voter_a`, `voter_b`, or `voter_c` in the current round.
5. **Record vote** — caller is written into the next empty voter slot (`votes == 0` → `voter_a`, `votes == 1` → `voter_b`, `votes == 2` → `voter_c`). `votes` is incremented.
6. **Quorum check** — `new_votes >= 2`.
7. **Commit** — the proposal is stored with the incremented vote count and recorded voters in **both** cases (the `Mapping::set(price_proposals, ...)` is unconditional). If quorum (`new_votes >= 2`) is reached, `oracle_prices[asset_id]` is updated to the new price/timestamp; if not, the existing `oracle_prices` value is preserved unchanged (the commit is gated by a ternary). The proposal slot is **not** reset on quorum — it retains `votes` and the voter addresses. A subsequent round only starts fresh when a **divergent** price is submitted, which triggers the reset branch in step 3. See Known Limitations regarding same-price rounds.

Note: `Mapping::set(oracle_prices, ...)` is called on every `submit_price` execution; the new-vs-existing value is gated by a ternary inside the finalize block. This is the Leo idiom for conditional writes.

**`set_oracle(slot: u8, new_addr: address)`**
Admin-only. Rotates oracle node address at the given slot. `slot` is validated against `<= 2u8` — admins cannot accidentally overwrite their own admin slot via this function; use `set_admin` for that.

**`set_admin(new_admin: address)`**
Admin-only. Transfers the admin role (slot 3).

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
5. Fetches current Aleo block height (used as `timestamp`)
6. Calls `aleoClient.js/submitPriceOnChain`

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
ORACLE_PROGRAM=zkperp_oracle_v3.aleo

# Polling interval (ms, default 15000)
POLL_INTERVAL_MS=15000
```

### `config/markets.json` (expected shape)

```json
{
  "BTC": {
    "assetKey": "1field",
    "feedAddress": "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c",
    "rpcEnvVar": "EVM_RPC_URL",
    "heartbeatSec": 3600
  },
  "ETH": {
    "assetKey": "2field",
    "feedAddress": "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
    "rpcEnvVar": "EVM_RPC_URL",
    "heartbeatSec": 3600
  },
  "SOL": {
    "assetKey": "3field",
    "feedAddress": "0x24ceA4b8ce57cdA5058b924B9B9987992450590c",
    "rpcEnvVar": "EVM_RPC_URL_ARB",
    "heartbeatSec": 3600
  }
}
```

---

## Deployment

The constructor runs automatically at deploy and seeds all four `roles` slots with the deployer address.

```bash
# Deploy oracle program
leo deploy --network testnet

# Rotate in the real oracle node addresses (admin = deployer at this point)
leo execute set_oracle 0u8 aleo1..._node_a --network testnet
leo execute set_oracle 1u8 aleo1..._node_b --network testnet
leo execute set_oracle 2u8 aleo1..._node_c --network testnet

# (Optional) transfer admin to a multisig or cold wallet
leo execute set_admin aleo1..._admin --network testnet

# Start all three relayers
npm start
```

After rotation, each relayer's address must match its corresponding slot — Relayer A signs with the key whose address is in `roles[0u8]`, and so on. The `submit_price` finalize will reject submissions from any address not in slots 0/1/2.

---

## Known Limitations & Future Work

**Caller-supplied timestamp** — the `timestamp` argument is provided by the relayer, not derived from `block.height` inside the program. A malicious relayer could supply a stale or future block height. Downstream contracts mitigate this by computing `block.height - timestamp <= MAX_PRICE_AGE_BLOCKS` themselves at read time, but the oracle itself does not validate the submitted timestamp. Future work: derive `timestamp` from `block.height` inside `submit_price` finalize, removing the relayer's influence over this field.

**Proposal not reset on quorum (same-price stall)** — `submit_price` stores the proposal unconditionally with the incremented vote count and voters; it does **not** clear the proposal slot after a successful quorum. Because a round only resets when a *divergent* price is submitted (step 3), two consecutive rounds at a byte-identical price cannot re-reach quorum from the same two nodes: the recorded voters are blocked by the no-double-voting check, and the proposal never resets. The third (non-voting) node can push the count to 3 and re-commit once, after which the slot is stuck until a different price arrives. In practice 8-decimal prices almost always differ round to round, so this rarely surfaces, but a flat price stalls the feed. Future fix: reset the proposal to all-zero in the quorum branch so the next round starts fresh regardless of price.

**No price tolerance band** — if relayers submit divergent prices (e.g. due to feed latency), the proposal resets silently and the round produces no quorum. Staleness checks in consuming contracts catch this as a downstream effect. A future version could accept prices within ±N basis points as "agreeing" and commit the median.

**Threshold Schnorr (FROST)** — the cryptographically ideal design is a single transaction carrying a co-signed report verified on-chain against two public keys. This requires a `verify_schnorr(pk, msg, sig)` opcode. Leo does not expose this yet. When Aleo ships lower-level signature verification primitives, the oracle can be upgraded to single-transaction quorum with no change to the consuming contracts.

**Admin is a single hot key** — `roles[3u8]` is a single address with full power to rotate oracle nodes. For production, transfer admin to a multisig or governance contract via `set_admin`.
