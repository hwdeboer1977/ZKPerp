# ZKPerp — Wave 5 Judge Response

## Judge Feedback Summary

The judges praised the slot-based record model, dual-record liquidation architecture, and Chainlink oracle pipeline as genuinely novel patterns. Five points were raised:

1. `close_position` accepts `expected_payout` as an unverified private input — a malicious trader could drain the pool
2. `update_pool_state` trusts orchestrator inputs for OI rather than deriving from on-chain data
3. The 2-of-3 oracle quorum collapses to a single trusted address on-chain
4. "Unshield to Trade" is misleading — it is record decryption, not an unshield operation
5. Demo video requested to show oracle in action

---

## Fix 1 — Position Commitment Scheme ✅ Fully Resolved

At `open_position`, the contract computes:

```
BHP256::hash_to_field(PositionCommit { entry_price, size_usdc, collateral_usdc, is_long, position_id })
```

Only this hash is stored in `position_commits` on-chain. No sensitive parameters ever appear in public state.

At `close_position`, the user re-supplies position parameters as private inputs. The ZK circuit recomputes the hash and `finalize` runs three gates:

- **Gate 1:** Recomputed hash matches stored commitment — user cannot lie about any position parameter
- **Gate 2:** `exit_price` equals the live on-chain oracle price — user cannot fake the settlement price
- **Gate 3:** Pool solvency check

Payout is computed entirely from verified inputs inside the circuit. No user-supplied payout figure is trusted. A block explorer sees only the commitment hash and exit price — never entry price, size, or direction.

The same fix was applied to `execute_take_profit` and `execute_stop_loss`, which had the identical vulnerability. The `ExecTPSLAuth` record already carries the position parameters from order placement time, so the commitment recomputation uses those directly.

For `execute_limit_order` (which opens rather than closes a position), the commitment is stored at execution time via `Mapping::set(position_commits, position_id, commit)` so the position can later be closed with full verification.

---

## Fix 2 — OI & Orchestrator Trust ✅ Documented Architectural Tradeoff

### Current status

`update_pool_state` is still present in the contract. It is called by the orchestrator, which scans decrypted `LiquidationAuth` records via view key after each trade confirmation and writes the updated OI figures on-chain. `update_net_pnl` has been removed — the contract no longer accepts aggregated unrealized P&L from the orchestrator.

The orchestrator's on-chain write surface covers `update_price` and `update_pool_state`. To reduce the risk of a single compromised orchestrator key manipulating OI or pool state, a multi-sig orchestrator is used — requiring multiple independent signers to authorize any on-chain write. A fully compromised orchestrator would still be unable to inflate payouts or drain the pool, as fund custody is protected entirely by the commitment scheme in Fix 1.

### Why OI cannot be derived from chain without leaking trade sizes

The chain only stores:

- `active_position_ids` — position ID hashes, no sizes
- `position_commits` — hashes of position params, opaque
- `pool_state` — whatever was last written

There is no way to sum `size_usdc` values from on-chain data because sizes were never stored on-chain — they are encrypted inside `PositionSlot` records. The three options are:

| Option                                 | OI on-chain     | Privacy                       | Trust               |
| -------------------------------------- | --------------- | ----------------------------- | ------------------- |
| Store OI in finalize                   | ✅ atomic       | ❌ size/is_long leak publicly | none needed         |
| Orchestrator calls `update_pool_state` | ✅ visible      | ✅ fully private              | orchestrator honest |
| Compute off-chain via view key         | ❌ not on-chain | ✅ fully private              | none needed         |

There is no fourth option. This is a fundamental constraint of Aleo's execution model.

### The impossibility proof

To update `long_open_interest` atomically inside `open_position`'s `finalize`, the AVM requires `size` and `is_long` as public finalize inputs. This was verified empirically: when OI updates were included in `finalize`, the compiled bytecode showed these values as `u64.public` and `boolean.public`, appearing in plaintext on the explorer. The change was reverted.

### Why every other DEX makes trade sizes public

GMX, Hyperliquid, and dYdX update OI atomically inside the trade transaction because they pass `size` and `is_long` as public inputs — visible to anyone. OI is derived from on-chain position data precisely because that data was never private to begin with. ZKPerp takes the opposite approach by design.

### Residual trust assumption — explicit and bounded

A malicious orchestrator can set incorrect OI values, affecting LP withdrawal limits via the safety buffer check in `remove_liquidity`. It cannot steal trader funds — payouts are fully protected by the commitment scheme in Fix 1. The orchestrator's influence is limited to liquidity management, not fund custody.

### Comparison to existing protocols

| Protocol | Position Privacy | OI Source               | Fund Safety    |
| -------- | ---------------- | ----------------------- | -------------- |
| GMX      | ❌ Fully public  | Atomic, on-chain        | Smart contract |
| dYdX     | ❌ Fully public  | Off-chain engine        | Smart contract |
| ZKPerp   | ✅ Fully private | Orchestrator (view key) | Commit hash    |

ZKPerp's trust model is strictly stronger than GMX on privacy, and equivalent on fund safety. No existing privacy-preserving perpetual DEX on any chain derives OI atomically from private position data — doing so requires making that data public.

---

## Fix 3 — Oracle On-Chain Quorum ✅ Fully Resolved

The judge noted that the 2-of-3 quorum was well-designed off-chain but appeared to collapse to a single trusted address on-chain. This has been fully resolved in `zkperp_oracle_v3.aleo`.

Each of the three relayers holds its own independent Aleo private key. Every `submit_price` call is a separate Aleo transaction — Ed25519 signature verification happens at the protocol level before the Leo program executes, so `self.caller` inside the program is a cryptographically verified identity, not a trust assertion.

The on-chain quorum logic:

```
Relayer A (own Aleo key) ──┐
Relayer B (own Aleo key) ──┤──▶ zkperp_oracle_v3.aleo/submit_price
Relayer C (own Aleo key) ──┘
                                │
                        2-of-3 agree on price
                                │
                        oracle_prices mapping updated
```

`submit_price` finalize logic:

1. Assert caller is a registered oracle node (roles 0–2)
2. Load existing proposal or create empty one
3. If submitted price differs from proposal price → reset round
4. Assert caller has not already voted in this round
5. Record vote; if `votes >= 2` → commit to `oracle_prices`

No single key can write a price unilaterally. Two compromised keys are required to write an arbitrary price — this is the explicit trust assumption of a 2-of-3 scheme.

**What a single compromised key can do:** delay a round by submitting a divergent price, causing the proposal to reset. It cannot commit a bad price alone.

### Future upgrade path

The cryptographically ideal design is a single transaction carrying a co-signed report with both signatures verified on-chain (equivalent to Chainlink OCR). This requires a `verify_schnorr(pk, msg, sig)` opcode that Leo does not yet expose. When Aleo ships lower-level signature verification primitives, the oracle can be upgraded to FROST threshold Schnorr with no change to the consuming contracts.

---

## Fix 4 — "Unshield to Trade" Label ✅ Acknowledged

The button label has been corrected. The operation decrypts private `PositionSlot` records using the trader's view key — it does not perform a shield/unshield token operation. The UI now accurately reflects this as record decryption.

---

## Fix 5 — Oracle Demo Video

A demo video showing the oracle relayers submitting prices and achieving quorum on-chain is included. The oracle infrastructure (`zkperp_oracle_v3.aleo` + three-relayer stack on Render) is live on testnet and observable via the Provable Explorer:

`https://testnet.explorer.provable.com/program/zkperp_oracle_v3.aleo`

---
