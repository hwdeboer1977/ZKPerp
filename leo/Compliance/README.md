# ZKPerp Compliance Server

Private KYC compliance layer for ZKPerp — a privacy-preserving perpetuals DEX on Aleo.

Manages the KYC allowlist, builds Merkle trees, and coordinates the issuance of private `ZKPerpComplianceRecord`s to approved traders. Built for the Aleo Buildathon.

---

## How It Works

### The Problem

Regulated DeFi needs KYC. Traditional approaches publish user identity on-chain — destroying privacy. ZKPerp solves this with zero-knowledge proofs: prove you are compliant without revealing who you are.

### The Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  REGISTRATION (per user, repeats on expiry or root rotation)│
│                                                             │
│  1. User completes KYC / connects wallet                    │
│  2. Backend adds address to allowlist (JSON)                │
│  3. Merkle tree rebuilt — only new leaves computed          │
│  4. Admin calls update_root on-chain (delegated proving)    │
│  5. User fetches Merkle proof from backend                  │
│  6. User calls issue_compliance(proof, expires_at)          │
│     → ZK proof: "I am a leaf in the tree at active root"    │
│     → Nullifier check prevents double-issuance              │
│     → Receives private ZKPerpComplianceRecord (valid ~90d)  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  TRADING (every action)                                     │
│                                                             │
│  7. User passes ZKPerpComplianceRecord into zkperp_core     │
│     transitions (open_position / add_liquidity / etc.)      │
│  8. Core asserts three properties in its own finalize:      │
│     → issued_under == current active root                   │
│     → address not in revoked mapping                        │
│     → block.height <= expires_at                            │
│  9. Record returned unchanged to user's wallet              │
│     → re-used on every trade until expiry, revocation,      │
│       or root rotation                                      │
│     → expired/revoked: next trade rejected instantly        │
└─────────────────────────────────────────────────────────────┘
```

### The ZKPerpComplianceRecord

A private Aleo record issued after KYC approval, valid for up to ~90 days:

```leo
record ZKPerpComplianceRecord {
    owner:        address,   // private — only holder can spend
    issued_under: field,     // Merkle root active at issuance
    expires_at:   u32,       // Aleo block height of expiry
}
```

The record lives in the user's wallet and is re-used on every trade — `zkperp_core` reads `issued_under` and `expires_at` from the record itself, with no separate cross-program call. The record is returned unchanged from every transition, so trading never consumes it.

**Re-issuance is required when:**
- The record expires (`block.height > expires_at`, at most ~90 days after issuance)
- The user is revoked and later reinstated
- The admin rotates the Merkle root (e.g. after adding/removing allowlist members) — old records carry stale `issued_under` and no longer match `compliance_root`

### Three-way validity gate

On every trade, `zkperp_core` enforces all three conditions in its own finalize block (cross-program mapping reads — no inter-program transition call):

| Check | Failure means | Fix |
|---|---|---|
| `cr.issued_under == compliance_root[0u8]` | Root rotated since issuance | Re-call `issue_compliance` |
| `revoked[caller] == false` | User blacklisted | Admin must `unrevoke_user` |
| `block.height <= cr.expires_at` | Record expired | Re-call `issue_compliance` |

### Double-issuance protection (nullifiers)

To prevent a user from minting multiple records under the same root (which would let them launder records to non-KYC'd addresses), `issue_compliance` computes a per-issuance nullifier and rejects repeats:

```
nullifier = Poseidon2::hash_to_field(leaf || computed_root)
assert(!issued_nullifiers[nullifier])
issued_nullifiers[nullifier] = true
```

The nullifier binds the user's leaf hash to the active root. A user can issue **one** record per root epoch. When the admin rotates the root (via `update_root`), nullifiers from the old root are no longer matched on new issuances, so the same user can issue a fresh record. The mapping uses Poseidon2 (faster than BHP256, sufficient for nullifier uniqueness — collision resistance only, no in-circuit verification).

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

On first start: builds the Merkle tree (slow — one `leo run` per address). Every restart after: loads from `tree-cache.json` (instant). If the on-chain root doesn't match, it auto-syncs via `update_root`.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ADMIN_PRIVATE_KEY` | ✓ | Aleo private key of the program deployer |
| `ADMIN_ADDRESS` | ✓ | Aleo address of the admin |
| `ALEO_NETWORK_URL` | ✓ | `https://api.explorer.provable.com/v1` |
| `COMPLIANCE_PROGRAM_ID` | ✓ | `zkperp_compliance_v7.aleo` |
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
| `GET` | `/api/compliance/audit/:address` | Auditor view — proof validity without private data |

### Register body

```json
{ "address": "aleo1...", "signature": "any-string-for-demo" }
```

### Admin (requires `admin_key` in body)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/compliance/revoke` | Immediately revoke a user |
| `POST` | `/api/compliance/unrevoke` | Reinstate a revoked user |
| `GET` | `/api/compliance/allowlist` | Full allowlist |

---

## On-chain Program

**`zkperp_compliance_v7.aleo`** — deployed on Aleo testnet.

### Mappings

| Mapping | Key | Value | Purpose |
|---|---|---|---|
| `compliance_root` | `u8` (always `0u8`) | `field` | Current active Merkle root |
| `revoked` | `address` | `bool` | Per-user blacklist flag |
| `admin` | `u8` (always `0u8`) | `address` | Admin address (seeded by constructor) |
| `issued_nullifiers` | `field` | `bool` | Per-(user, root) issuance tracker — prevents double-mint |

### Initialization

An `@custom constructor()` runs once at deploy time and writes `self.program_owner` (the deployer) into `admin[0u8]`. There is no `set_admin` or admin rotation function in v7 — the admin role is **non-transferable for the lifetime of the deployment**. Admin rotation is planned for v8.

### Transitions

| Transition | Caller | Description |
|---|---|---|
| `update_root(new_root: field)` | Admin | Publish new Merkle root after batch approval |
| `revoke_user(user: address)` | Admin | Instantly blacklist a user |
| `unrevoke_user(user: address)` | Admin | Remove blacklist |
| `issue_compliance(proof: MerkleProof, expires_at: u32)` | User | Prove allowlist membership → receive `ZKPerpComplianceRecord` |
| `verify_compliance(cr: ZKPerpComplianceRecord)` | External callers | Assert record valid (returns record unchanged) |

### How `zkperp_core` consumes compliance

The `verify_compliance` transition is exposed for external programs that want a single-call gate. However, `zkperp_core_v28` itself does **not** call `verify_compliance` — to avoid an extra transition call per trade, core imports `zkperp_compliance_v7.aleo` and reads its mappings directly inside its own finalize blocks:

```leo
let active_root: field = Mapping::get(zkperp_compliance_v7.aleo::compliance_root, 0u8);
assert_eq(cr.issued_under, active_root);
let is_revoked: bool = Mapping::get_or_use(zkperp_compliance_v7.aleo::revoked, caller, false);
assert(!is_revoked);
assert(block.height <= cr.expires_at);
```

This is the same three-check gate that `verify_compliance` performs, just inlined into each core transition's finalize block. The `verify_compliance` function remains available for other Aleo programs (e.g. zkdarkpool) that prefer the single-call pattern over cross-program mapping reads.

### `issue_compliance` finalize gates

In addition to recomputing the Merkle root from the supplied proof and asserting it matches `compliance_root[0u8]`, the finalize block enforces:

| Gate | Assertion |
|---|---|
| Caller not revoked | `!revoked[self.caller]` |
| Not already issued under this root | `!issued_nullifiers[nullifier]` |
| Expiry must be in the future | `expires_at > block.height` |
| Expiry within 90-day cap | `expires_at <= block.height + 7_776_000u32` |

After successful issuance, the nullifier is recorded in `issued_nullifiers`.

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

---

## Regulatory Context

ZKPerp's compliance architecture addresses real regulatory requirements:

- **KYC enforcement**: only approved wallets can trade — enforced at the circuit level, not the application layer
- **Sanctions screening**: instant revocation via `revoke_user` — no Merkle tree rotation needed
- **Audit trail**: on-chain root epoch + `/audit` endpoint proves enforcement without exposing user data
- **Legal disclosure**: the off-chain allowlist maps wallet → identity under legal order, never published on-chain
- **Expiry**: records auto-expire within ~90 days, forcing periodic re-attestation
- **MiCA/FATF positioning**: "We know who our traders are. The blockchain doesn't — and it doesn't need to."

In production, the allowlist would come from a regulated KYC provider. In the demo, judges self-enroll. After that, the cryptographic path is identical.

---

## Known Limitations & Future Work

**Non-transferable admin** — `admin[0u8]` is seeded by the deploy-time `@custom constructor()` and there is no `set_admin` transition. Once deployed, the admin role cannot be rotated without redeploying the contract. v8 will add admin rotation gated on a multisig or governance contract.

**Header comment** — line 1 of `main.leo` reads `zkperp_compliance_v2.aleo` but the program declaration is `zkperp_compliance_v7.aleo`. Cosmetic stale comment, no functional impact.

**Tree depth fixed at 10** — 1,024-user ceiling. Beyond that, the contract requires a redeployment with a deeper proof array (e.g. depth 16 = 65k users, depth 20 = 1M users). The depth is fixed in the Leo program because the proof verification loop is unrolled.

**Nullifier cleanup** — `issued_nullifiers` grows unboundedly across root rotations. Old nullifiers are functionally dead (they can never be hit again because their root no longer matches) but they still consume on-chain state. Future cleanup transition planned.

**No `set_admin` / multisig** — see "Non-transferable admin" above. For production, admin should be a 2-of-N multisig or governance contract, not a single hot key.
