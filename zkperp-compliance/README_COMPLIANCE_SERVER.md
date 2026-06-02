# ZKPerp Compliance Server

Private KYC compliance layer for ZKPerp — a privacy-preserving perpetuals DEX on Aleo.

Manages the KYC allowlist, builds Merkle trees, and coordinates the issuance of private `ZKPerpComplianceRecord`s to approved traders. Built for the Aleo Buildathon.

---

## How It Works

### The Problem

Regulated DeFi needs KYC. Traditional approaches publish user identity on-chain — destroying privacy. ZKPerp solves this with zero-knowledge proofs: prove you are compliant without revealing who you are.

### Where the Merkle root is (and isn't) checked

This is the central design decision, and it changed in `v8b`. The Merkle root proves **allowlist membership**. That proof is meaningful exactly once — at issuance. After a trader holds a record, the record itself is the unforgeable credential, so re-checking the root on every trade adds no security and creates a serious bug:

> **Earlier versions (v8 and before) checked `issued_under == compliance_root` at trade time.** Because adding any new user rotates the root, every previously-issued trader's record became stale the instant someone else registered — locking out valid, KYC'd traders through no fault of their own. `v8b` removes the trade-time root check. The root is now verified **only inside `issue_compliance`**, where the inclusion proof belongs.

So:

- **Root is checked at issuance** — the proof must hash to the current on-chain `compliance_root`, proving the caller is a leaf in the active allowlist tree.
- **Root is NOT checked at trade time** — `zkperp_core` validates the record on **revocation + expiry** only. A new user registering (and rotating the root) no longer affects anyone else's records.

### The Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  REGISTRATION (per user; repeats on expiry, NOT on rotation)│
│                                                             │
│  1. User completes KYC / connects wallet                    │
│  2. Backend adds address to allowlist (JSON)                │
│  3. Merkle tree rebuilt — only new leaves computed          │
│  4. Admin calls update_root on-chain (delegated proving)    │
│  5. User fetches Merkle proof from backend                  │
│  6. User calls issue_compliance(proof, expires_at)          │
│     → ZK proof: "I am a leaf in the tree at the active root"│
│       (THIS is where the root is checked)                   │
│     → Leaf-scoped nullifier → one live record per user      │
│     → Receives private ZKPerpComplianceRecord (valid ~90d)  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  TRADING (every action)                                     │
│                                                             │
│  7. User passes ZKPerpComplianceRecord into zkperp_core     │
│     transitions (open_position / add_liquidity / etc.)      │
│  8. Core asserts TWO properties in its own finalize:        │
│     → address NOT in revoked mapping                        │
│     → block.height <= expires_at                            │
│     (no root check — possession of the record already       │
│      proves membership was verified at issuance)            │
│  9. Record returned unchanged to user's wallet              │
│     → re-used on every trade until expiry or revocation     │
│     → a new user registering does NOT invalidate it         │
│     → expired/revoked: next trade rejected instantly        │
└─────────────────────────────────────────────────────────────┘
```

The mandatory **register → update_root → issue** ordering still holds: a trader's proof only hashes to the new root once their leaf is in the tree, so the root must be published on-chain before they can issue against it. What changed is that this rotation no longer ripples out to existing holders.

### The ZKPerpComplianceRecord

A private Aleo record issued after KYC approval, valid for up to ~90 days:

```leo
record ZKPerpComplianceRecord {
    owner:        address,   // private — only holder can spend
    issued_under: field,     // Merkle root active at issuance (audit provenance only)
    expires_at:   u32,       // Aleo block height of expiry
}
```

The record lives in the user's wallet and is re-used on every trade — `zkperp_core` reads `expires_at` from the record itself and checks the `revoked` mapping, with no separate cross-program transition call. The record is returned unchanged from every transition, so trading never consumes it. `issued_under` is retained purely as audit provenance (which allowlist epoch the record was minted under); it is **not** asserted against the live root at trade time.

**Re-issuance is required when:**
- The record expires (`block.height > expires_at`, at most ~90 days after issuance)

**Re-issuance is NOT required when:**
- The admin rotates the Merkle root (adding/removing allowlist members) — existing records stay valid
- A user is revoked and later reinstated — the original unexpired record works again once `revoked` is cleared

### Two-way validity gate (at trade time)

On every trade, `zkperp_core` enforces both conditions in its own finalize block (cross-program mapping reads — no inter-program transition call):

| Check | Failure means | Fix |
|---|---|---|
| `revoked[caller] == false` | User blacklisted | Admin must `unrevoke_user` |
| `block.height <= cr.expires_at` | Record expired | Re-call `issue_compliance` |

Membership itself is not re-checked here — it cannot be faked, because only `issue_compliance` (which enforced the Merkle proof) can mint a `ZKPerpComplianceRecord`. Requiring the record as a typed input *is* the membership check.

### Double-issuance protection (nullifiers)

To prevent a user from minting multiple live records (which would let them launder records to non-KYC'd addresses), `issue_compliance` computes a per-user nullifier and rejects repeats:

```
nullifier = Poseidon2::hash_to_field(leaf)
assert(!issued_nullifiers[nullifier])
issued_nullifiers[nullifier] = true
```

The nullifier is scoped to the user's **leaf alone** (not leaf + root). This is what makes one-record-per-user hold across root rotations: a leaf+root nullifier would let a user mint a brand-new record every time the root rotated, defeating the purpose. With a leaf-only nullifier, a user gets exactly one live record regardless of how many times the tree changes. Poseidon2 is used (faster than BHP256, sufficient for nullifier uniqueness — collision resistance only, no in-circuit verification).

> **Trade-off:** because the nullifier persists and is leaf-only, a user whose record **expires** cannot currently re-issue (their nullifier is already set). See *Known Limitations → Re-issuance after expiry* for the planned fix (epoch-scoped nullifier or admin `clear_nullifier`).

### The Merkle Tree

The allowlist is stored as a depth-10 Merkle tree (supports 1,024 users). Only the root is published on-chain — a single field element. Individual addresses are never revealed.

- **Leaf hash**: `BHP256::hash_to_field(address)`
- **Node hash**: `BHP256::hash_to_field(FieldPair { left, right })`
- **Empty slots**: precomputed zero hashes (hardcoded, never recomputed)
- **Tree cache**: full tree layers persisted to `tree-cache.json` — restarts are instant
- **Proof shape**: `MerkleProof { path: [MerkleNode; 10] }` where each node has `{ sibling: field, is_left: bool }`

Hashes are computed via `leo run` subprocess to guarantee byte-identical output to the on-chain Leo circuit. The Provable SDK's JavaScript BHP256 implementation does not match Leo 4.0's snarkVM output, so server-side hash computation must go through the Leo binary.

### Delegated Proving

Admin transactions (`update_root`, `revoke_user`, `unrevoke_user`) use Provable's TEE-encrypted delegated proving service. This replaces local proof generation (~60s) with server-side proving (~10s):

```
1. Build proving request locally (authorization only)
2. Fetch ephemeral X25519 pubkey from Provable
3. Encrypt proving request (TEE-safe)
4. Submit to /prove/encrypted
5. Provable proves + broadcasts → returns tx ID
```

User-side `issue_compliance` calls use whatever proving the user's wallet provides (Shield Wallet currently proves locally).

---

## Setup

### Prerequisites

- Node.js 18+
- Leo CLI 4.0+ (`curl -L https://install.leo-lang.org | bash`)
- Aleo admin wallet with testnet credits
- Provable API key (for delegated proving)

### Install

```bash
npm install
cp .env.example .env
# fill in your credentials
```

### Leo Hasher Program

The server shells out to `leo run` to compute BHP256 hashes. Set this up once:

```bash
mkdir -p /tmp/test_hashes/src

cat > /tmp/test_hashes/src/main.leo << 'LEO'
struct FieldPair {
    left: field,
    right: field,
}
program test_hashes_v1.aleo {
    fn get_leaf(addr: address) -> field {
        return BHP256::hash_to_field(addr);
    }
    fn get_node(left: field, right: field) -> field {
        return BHP256::hash_to_field(FieldPair { left, right });
    }
}
LEO

echo '{"program":"test_hashes_v1.aleo","version":"0.0.1","description":"","license":"MIT"}' \
  > /tmp/test_hashes/program.json
```

### Start

```bash
npm start
```

On first start: builds the Merkle tree (slow — one `leo run` per address). Every restart after: loads from `tree-cache.json` (instant). If the on-chain root doesn't match, it auto-syncs via `update_root` — and, as of `v8b`, this sync no longer marks existing holders stale.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ADMIN_PRIVATE_KEY` | ✓ | Aleo private key of the program deployer |
| `ALEO_NETWORK_URL` | ✓ | `https://api.explorer.provable.com/v2` |
| `COMPLIANCE_PROGRAM_ID` | ✓ | `zkperp_compliance_v9.aleo` |
| `ADMIN_API_KEY` | ✓ | Secret for admin endpoints |
| `PROVABLE_API_KEY` | ✓ | Provable API key for delegated proving |
| `PROVABLE_CONSUMER_ID` | ✓ | Provable consumer ID |
| `PROVABLE_PROVING_URL` | ✓ | `https://api.provable.com/prove/testnet/prove` |
| `LEO_HASHER_DIR` | ✓ | Path to Leo hasher program (`/tmp/test_hashes`) |
| `LEO_BIN` | ✓ | Full path to Leo binary (`~/.cargo/bin/leo`) |
| `PORT` | — | Server port (default: `3001`) |
| `CORS_ORIGIN` | — | Allowed CORS origin (use `*` for demo) |

---

## API Reference

### Public

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Server status, allowlist count, current root |
| `POST` | `/api/compliance/register` | Register a wallet — adds to allowlist, updates on-chain root |
| `GET` | `/api/compliance/proof/:address` | Get Merkle proof (JSON + Leo format) |
| `GET` | `/api/compliance/status/:address` | Compliance status check |
| `GET` | `/api/compliance/reissue-check/:address` | Whether the address still needs (re-)issuance |
| `POST` | `/api/compliance/confirm-issuance` | Mark an address issued after its on-chain `issue_compliance` tx confirms |
| `GET` | `/api/compliance/audit/:address` | Auditor view — proof validity without private data |
| `GET` | `/api/compliance/allowlist` | Full allowlist (count, root, addresses) — **unauthenticated**, no `admin_key` required |

### Register body

```json
{ "address": "aleo1...", "signature": "any-string-for-demo" }
```

### Confirm-issuance body

```json
{ "address": "aleo1...", "tx_id": "at1..." }
```

> The frontend must POST `/api/compliance/confirm-issuance` after each on-chain `issue_compliance` confirms, so the server flips `needs_reissuance` to `false`. Without this, the server's epoch state lags the chain.

### Admin (requires `admin_key` in body)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/compliance/revoke` | Immediately revoke a user |
| `POST` | `/api/compliance/unrevoke` | Reinstate a revoked user |

---

## On-chain Program

**`zkperp_compliance_v9.aleo`** — deployed on Aleo testnet. (`v8b` is the fixed redeploy of `v8`; Aleo programs are immutable, so the fix shipped under a new program ID.)

### Mappings

| Mapping | Key | Value | Purpose |
|---|---|---|---|
| `compliance_root` | `u8` (always `0u8`) | `field` | Current active Merkle root — the issuance target |
| `revoked` | `address` | `bool` | Per-user blacklist flag |
| `admin` | `u8` (always `0u8`) | `address` | Admin address (seeded by constructor) |
| `issued_nullifiers` | `field` | `bool` | Per-user (leaf-scoped) issuance tracker — prevents double-mint |

### Initialization

An `@custom constructor()` runs once at deploy time and writes `self.program_owner` (the deployer) into `admin[0u8]`. There is no `set_admin` or admin rotation function — the admin role is **non-transferable for the lifetime of the deployment**.

### Transitions

| Transition | Caller | Description |
|---|---|---|
| `update_root(new_root: field)` | Admin | Publish new Merkle root after batch approval |
| `revoke_user(user: address)` | Admin | Instantly blacklist a user |
| `unrevoke_user(user: address)` | Admin | Remove blacklist |
| `issue_compliance(proof: MerkleProof, expires_at: u32)` | User | Prove allowlist membership (root checked here) → receive `ZKPerpComplianceRecord` |
| `verify_compliance(cr: ZKPerpComplianceRecord)` | External callers | Assert record valid (revoked + expiry) and return it unchanged |

### How `zkperp_core` consumes compliance

`verify_compliance` is exposed for external programs that want a single-call gate. `zkperp_core_v30` itself does **not** call it — to avoid an extra transition per trade, core imports `zkperp_compliance_v9.aleo` and reads its mappings directly inside its own finalize blocks:

```leo
let is_revoked: bool = Mapping::get_or_use(zkperp_compliance_v9.aleo::revoked, caller, false);
assert(!is_revoked);
assert(block.height <= cr.expires_at);
```

This is the same two-check gate that `verify_compliance` performs, inlined into each gated core transition's finalize (`add_liquidity`, `remove_liquidity`, `open_position`, `close_position`, `place_take_profit`, `place_stop_loss`, `cancel_tp_sl`). Keeper/admin actions (`liquidate`, the `burn_*` functions, pool/orchestrator updates) intentionally take no compliance record. The `verify_compliance` function remains available for other Aleo programs (e.g. zkdarkpool) that prefer the single-call pattern.

### `issue_compliance` finalize gates

The finalize block recomputes the Merkle root from the supplied proof, asserts it matches `compliance_root[0u8]` (the membership proof), and additionally enforces:

| Gate | Assertion |
|---|---|
| Inclusion proof matches active root | `computed_root == compliance_root[0u8]` |
| Caller not revoked | `!revoked[self.caller]` |
| Not already issued (one record per user) | `!issued_nullifiers[Poseidon2(leaf)]` |
| Expiry must be in the future | `expires_at > block.height` |
| Expiry within 90-day cap | `expires_at <= block.height + 7_776_000u32` |

After successful issuance, the leaf-scoped nullifier is recorded in `issued_nullifiers`.

---

## Frontend Demo

Open `zkperp_compliance_frontend.html` in a browser while the server runs on port 3001.

**Judge flow:**
1. Connect wallet (or paste Aleo address in demo mode)
2. Click "Get Demo Compliance Record"
3. Watch 3 steps animate: Register → Merkle proof → ZK proof
4. Badge turns green: **Verified Trader**
5. Auditor panel shows proof validity + root epoch, with trade details hidden

```bash
python3 -m http.server 8080
# open http://localhost:8080/zkperp_compliance_frontend.html
```

> **Dev note (Vite frontend):** the frontend calls the backend via relative `/api/...` paths, so `vite.config.ts` must proxy `/api` to `http://localhost:3001`. If a stale `vite.config.js` exists alongside the `.ts`, Vite loads the `.js` first and ignores the proxy — remove it.

---

## Regulatory Context

ZKPerp's compliance architecture addresses real regulatory requirements:

- **KYC enforcement**: only approved wallets can trade — enforced at the circuit level, not the application layer
- **Sanctions screening**: instant revocation via `revoke_user`, checked on every trade — no Merkle tree rotation needed
- **Audit trail**: on-chain root epoch + `/audit` endpoint proves enforcement without exposing user data
- **Legal disclosure**: the off-chain allowlist maps wallet → identity under legal order, never published on-chain
- **Expiry**: records auto-expire within ~90 days, forcing periodic re-attestation
- **MiCA/FATF positioning**: "We know who our traders are. The blockchain doesn't — and it doesn't need to."

In production, the allowlist would come from a regulated KYC provider. In the demo, judges self-enroll. After that, the cryptographic path is identical.

---

## Known Limitations & Future Work

**Re-issuance after expiry** — because the nullifier is leaf-scoped and persistent, a user whose record expires cannot currently re-issue (their nullifier is already set in `issued_nullifiers`). Options for production: (a) an admin `clear_nullifier(user)` transition to release a user after expiry, or (b) fold an epoch counter into the nullifier (`Poseidon2(leaf, epoch)`) so each epoch admits one fresh record. Until then, expiry effectively requires admin intervention to re-onboard a user.

**Non-transferable admin** — `admin[0u8]` is seeded by the deploy-time `@custom constructor()` and there is no `set_admin` transition. Once deployed, the admin role cannot be rotated without redeploying the contract. For production, admin should be a 2-of-N multisig or governance contract, not a single hot key.

**Tree depth fixed at 10** — 1,024-user ceiling. Beyond that, the contract requires a redeployment with a deeper proof array (e.g. depth 16 = 65k users, depth 20 = 1M users). The depth is fixed in the Leo program because the proof verification loop is unrolled.

**Nullifier cleanup** — `issued_nullifiers` grows unboundedly. Old entries are dead but still consume on-chain state. A cleanup/compaction transition is planned.

**Server epoch sync** — the off-chain `compliance_epochs` state in `allowlist.json` reflects issuance only if the frontend calls `/api/compliance/confirm-issuance` after each on-chain `issue_compliance`. If that call is skipped, `needs_reissuance` will lag the chain even though the user is validly issued on-chain.
