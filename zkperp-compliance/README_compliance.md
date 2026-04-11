# ZKPerp Compliance Server

Private KYC compliance layer for ZKPerp — a privacy-preserving perpetuals DEX on Aleo.

Manages the KYC allowlist, builds Merkle trees, and coordinates the issuance of private `ComplianceRecord`s to approved traders. Built for the Aleo Buildathon.

---

## How It Works

### The Problem

Regulated DeFi needs KYC. Traditional approaches publish user identity on-chain — destroying privacy. ZKPerp solves this with zero-knowledge proofs: prove you are compliant without revealing who you are.

### The Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  REGISTRATION (once per user)                               │
│                                                             │
│  1. User completes KYC / connects wallet                    │
│  2. Backend adds address to allowlist (JSON)                │
│  3. Merkle tree rebuilt — only new leaves computed          │
│  4. Admin calls update_root on-chain (delegated proving)    │
│  5. User fetches Merkle proof from backend                  │
│  6. User calls issue_compliance(proof)                      │
│     → ZK proof: "I am in the allowlist"                     │
│     → Receives private ComplianceRecord in their wallet     │
│     → Never needs to register again                         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  TRADING (every action)                                     │
│                                                             │
│  7. User calls deposit / trade / withdraw on zkperp_core    │
│     passing their ComplianceRecord                          │
│  8. Core asserts ComplianceRecord is valid:                 │
│     → issued_under == current active root                   │
│     → address not revoked                                   │
│  9. Record returned unchanged to user's wallet              │
│     → one-time issuance, permanent validity until revoked   │
│     → if revoked: next trade rejected instantly             │
└─────────────────────────────────────────────────────────────┘
```

### The ComplianceRecord

A private Aleo record issued **once** after KYC approval:

```leo
record ComplianceRecord {
    owner:        address,   // private — only holder can spend
    issued_under: field,     // Merkle root active at issuance
}
```

The record lives in the user's wallet permanently. On every trade, core reads it and asserts validity — no re-issuance needed. Revocation is instant: admin calls `revoke_user(address)` and the next trade fails, without touching the Merkle tree or the record itself.

### The Merkle Tree

The allowlist is stored as a depth-10 Merkle tree (supports 1,024 users). Only the root is published on-chain — a single field element. Individual addresses are never revealed.

- **Leaf hash**: `BHP256::hash_to_field(address)`
- **Node hash**: `BHP256::hash_to_field(FieldPair { left, right })`
- **Empty slots**: precomputed zero hashes (hardcoded, never recomputed)
- **Tree cache**: full tree layers persisted to `tree-cache.json` — restarts are instant

Hashes are computed via `leo run` subprocess to guarantee byte-identical output to the on-chain Leo circuit. This bypasses the Provable SDK's BHP256 implementation which does not match Leo 4.0's snarkVM output.

### Delegated Proving

Admin transactions (`update_root`, `revoke_user`) use Provable's TEE-encrypted delegated proving service. This replaces local proof generation (~60s) with server-side proving (~10s):

```
1. Build proving request locally (authorization only)
2. Fetch ephemeral X25519 pubkey from Provable
3. Encrypt proving request (TEE-safe)
4. Submit to /prove/encrypted
5. Provable proves + broadcasts → returns tx ID
```

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
| `COMPLIANCE_PROGRAM_ID` | ✓ | `zkperp_compliance_v2.aleo` |
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

**`zkperp_compliance_v2.aleo`** — deployed on Aleo testnet.

| Transition | Caller | Description |
|---|---|---|
| `update_root(field)` | Admin | Publish new Merkle root after batch approval |
| `revoke_user(address)` | Admin | Instantly blacklist a user |
| `unrevoke_user(address)` | Admin | Remove blacklist |
| `issue_compliance(proof)` | User | Prove allowlist membership → receive `ComplianceRecord` |
| `verify_compliance(record)` | Core | Assert record valid — called inline by `zkperp_core` |

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
- **MiCA/FATF positioning**: "We know who our traders are. The blockchain doesn't — and it doesn't need to."

In production, the allowlist would come from a regulated KYC provider. In the demo, judges self-enroll. After that, the cryptographic path is identical.
