# ZKPerp Compliance Server

Backend for `zkperp_compliance_v7.aleo` — manages the KYC allowlist, builds Merkle trees, and issues private `ComplianceRecord`s to approved traders.

## Architecture

```
User registers → backend adds to allowlist → rebuilds Merkle tree
→ update_root on-chain → user calls issue_compliance(proof)
→ receives private ComplianceRecord → passes it to zkperp_core on every trade
```

The Merkle tree uses:
- **Leaf**: `BHP256::hash_to_field(address)`
- **Node**: `BHP256::hash_to_field(FieldPair { left, right })`
- **Depth**: 10 (supports 1024 users)

Hashes are computed via `leo run` subprocess to guarantee byte-identical output to the on-chain circuit.

## Setup

```bash
cp .env.example .env
# Fill in your values
npm install
npm start
```

## Environment Variables

| Variable | Description |
|---|---|
| `ADMIN_PRIVATE_KEY` | Aleo private key of the deployer/admin |
| `ADMIN_ADDRESS` | Aleo address of the admin |
| `ALEO_NETWORK_URL` | `https://api.explorer.provable.com/v1` |
| `COMPLIANCE_PROGRAM_ID` | `zkperp_compliance_v7.aleo` |
| `PORT` | Server port (default: 3001) |
| `CORS_ORIGIN` | Allowed CORS origin (use `*` for demo) |
| `LEO_HASHER_DIR` | Path to the Leo hasher program (default: `/tmp/test_hashes`) |
| `LEO_BIN` | Path to Leo binary (default: `/home/user/.cargo/bin/leo`) |
| `ADMIN_API_KEY` | Secret key for admin endpoints |

## Leo Hasher Program

The server requires a Leo program at `LEO_HASHER_DIR` with:

```leo
struct FieldPair { left: field, right: field }
program test_hashes_v1.aleo {
    fn get_leaf(addr: address) -> field { return BHP256::hash_to_field(addr); }
    fn get_node(left: field, right: field) -> field {
        return BHP256::hash_to_field(FieldPair { left, right });
    }
}
```

Set it up once:
```bash
mkdir -p /tmp/test_hashes/src
# copy the program above to /tmp/test_hashes/src/main.leo
echo '{"program":"test_hashes_v1.aleo","version":"0.0.1","description":"","license":"MIT"}' > /tmp/test_hashes/program.json
```

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Server status + allowlist count |
| POST | `/api/compliance/register` | Register a wallet address |
| GET | `/api/compliance/proof/:address` | Get Merkle proof for address |
| GET | `/api/compliance/status/:address` | Check compliance status |
| GET | `/api/compliance/audit/:address` | Auditor view (no private data) |
| POST | `/api/compliance/revoke` | Admin: revoke a user |
| POST | `/api/compliance/unrevoke` | Admin: reinstate a user |
| GET | `/api/compliance/allowlist` | Admin: view full allowlist |

## On-chain Program

`zkperp_compliance_v7.aleo` on Aleo testnet.

Transitions:
- `update_root(new_root)` — admin updates Merkle root
- `revoke_user(address)` — admin revokes a user
- `unrevoke_user(address)` — admin reinstates a user
- `issue_compliance(proof)` → `ComplianceRecord` — user gets their trading passport
- `verify_compliance(record)` → `ComplianceRecord` — core calls this on every trade

## Frontend

Open `zkperp_compliance_frontend.html` in a browser while the server runs on port 3001.

For demo: serve via `python3 -m http.server 8080` and open `http://localhost:8080/zkperp_compliance_frontend.html`.
