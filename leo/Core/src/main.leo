// ZKPerp Core v28 — oracle reads from zkperp_oracle_v3.aleo
//
// Price reads are cross-program calls to zkperp_oracle_v3.aleo::oracle_prices.
// Prices are only committed there after 2-of-3 independent oracle nodes agree.
// A staleness guard (150 blocks ≈ 5 min) is enforced on every price read.
//
// All trader functions require a valid ZKPerpComplianceRecord:
//   - expires_at must be >= block.height
//   - address must not be revoked
// The record is unforgeable (only zkperp_compliance_v8bb::issue_compliance can
// mint it), so possession already proves KYC-set membership. The Merkle root
// is checked ONCE at issuance, NOT here — re-checking it would lock out every
// existing trader whenever a new user registers and rotates the root.
// issued_under remains on the record purely as audit provenance.
//
// LIQUIDATION (v29 change):
//   liquidate() no longer trusts a caller-supplied reward or a single
//   orchestrator. It now (a) recomputes the position commit from the
//   supplied preimage and asserts it matches position_commits, (b) reads the
//   quorum-agreed oracle price and recomputes PnL, (c) asserts the position is
//   genuinely below maintenance margin, and (d) derives the reward
//   deterministically from collateral. Wrongful liquidation is therefore
//   impossible on-chain. Liveness/omission is handled by a 1-of-N keeper set:
//   open_position mints one LiquidationAuth (the preimage) per keeper, and ANY
//   keeper in liquidator_set may liquidate. The reward goes to whoever submits,
//   making the keepers race rather than collude. liquidator_set is admin-managed
//   (roles[0u8]) so a trader cannot substitute colluding keeper addresses.

import test_usdcx_stablecoin.aleo;
import zkperp_compliance_v8bb.aleo;
import zkperp_oracle_v3.aleo;

struct PoolState {
    total_liquidity: u64,
    total_lp_tokens: u64,
    long_open_interest: u64,
    short_open_interest: u64,
    accumulated_fees: u64,
}

struct PositionIdInput {
    recipient: address,
    nonce: field,
    size: u64,
}

struct OrderIdInput {
    trader: address,
    nonce: field,
    trigger_price: u64,
}

struct PositionCommit {
    entry_price: u64,
    size_usdc: u64,
    collateral_usdc: u64,
    is_long: bool,
    position_id: field,
}

program zkperp_core_v29c.aleo {

    @custom
    constructor() {
        Mapping::set(roles, 0u8, self.program_owner);
        Mapping::set(roles, 1u8, self.program_owner);
    }

    const OPENING_FEE_BPS: u64        = 1_000u64;
    const WITHDRAWAL_BUFFER_BPS: u64  = 100_000u64;
    const PRICE_PRECISION: u64        = 100_000_000_000u64;
    const MAX_PRICE_AGE_BLOCKS: u32   = 150u32;     // ≈ 5 min staleness limit

    // Per-million units (same convention as OPENING_FEE_BPS: value / 1_000_000).
    const MAINTENANCE_MARGIN_BPS: u64 = 50_000u64;  // 5% of notional size
    const LIQ_PENALTY_BPS: u64        = 100_000u64; // 10% of collateral → liquidator reward

    mapping roles: u8 => address;
    mapping slots_initialized: address => bool;
    mapping pool_state: field => PoolState;
    mapping position_open_blocks: field => u32;
    mapping active_position_ids: field => field;
    mapping used_nonces: field => bool;
    mapping net_unrealized_pnl: field => i64;
    mapping pending_orders: field => bool;
    mapping order_traders: field => address;
    mapping order_nonces: field => bool;
    mapping position_commits: field => field;

    // 0u8,1u8,2u8 → the three liquidator keepers. Admin-managed (roles[0u8]).
    // Read in open_position's finalize to verify the trader cannot substitute
    // colluding addresses, and in liquidate's finalize for membership.
    mapping liquidator_set: u8 => address;

    record PositionSlot {
        owner: address,
        slot_id: u8,
        is_open: bool,
        position_id: field,
        is_long: bool,
        size_usdc: u64,
        collateral_usdc: u64,
        entry_price: u64,
    }

    record LiquidationAuth {
        owner: address,
        trader: address,
        slot_id: u8,
        position_id: field,
        is_long: bool,
        size_usdc: u64,
        collateral_usdc: u64,
        entry_price: u64,
    }

    record LPSlot {
        owner: address,
        slot_id: u8,
        is_open: bool,
        lp_amount: u64,
    }

    record ExecTPSLAuth {
        owner: address,
        order_id: field,
        order_type: u8,
        trader: address,
        slot_id: u8,
        position_id: field,
        is_long: bool,
        trigger_price: u64,
        size_usdc: u64,
        collateral_usdc: u64,
        entry_price: u64,
        nonce: field,
    }

    record OrderReceipt {
        owner: address,
        order_id: field,
        order_type: u8,
        is_long: bool,
        trigger_price: u64,
        size_usdc: u64,
        collateral_usdc: u64,
        entry_price: u64,
        position_id: field,
        slot_id: u8,
        nonce: field,
    }

    // ══════════════════════════════════════════════════════════════
    // LIQUIDATOR SET MANAGEMENT — admin only (roles[0u8])
    // ══════════════════════════════════════════════════════════════
    //
    // Call this three times after deploy (idx 0,1,2) to populate the keeper
    // set BEFORE any position is opened. The trader cannot influence it.

    fn set_liquidator(public idx: u8, public keeper: address) -> Final {
        let caller: address = self.caller;
        return final {
            let admin: address = Mapping::get(roles, 0u8);
            assert_eq(caller, admin);
            assert(idx < 3u8);
            Mapping::set(liquidator_set, idx, keeper);
        };
    }

    // ══════════════════════════════════════════════════════════════
    // SLOT INITIALIZATION
    // ══════════════════════════════════════════════════════════════

    fn initialize_slots(recipient: address) -> (PositionSlot, PositionSlot, LPSlot, Final) {
        let long_slot: PositionSlot = PositionSlot {
            owner: recipient, slot_id: 0u8, is_open: false,
            position_id: 0field, is_long: false,
            size_usdc: 0u64, collateral_usdc: 0u64, entry_price: 0u64,
        };
        let short_slot: PositionSlot = PositionSlot {
            owner: recipient, slot_id: 1u8, is_open: false,
            position_id: 0field, is_long: false,
            size_usdc: 0u64, collateral_usdc: 0u64, entry_price: 0u64,
        };
        let lp_slot: LPSlot = LPSlot {
            owner: recipient, slot_id: 0u8, is_open: false, lp_amount: 0u64,
        };
        return (long_slot, short_slot, lp_slot, final {
            let already_init: bool = Mapping::get_or_use(slots_initialized, recipient, false);
            assert(!already_init);
            Mapping::set(slots_initialized, recipient, true);
        });
    }

    // ══════════════════════════════════════════════════════════════
    // LP FUNCTIONS
    // ══════════════════════════════════════════════════════════════

    fn add_liquidity(
        cr: zkperp_compliance_v8bb.aleo::ZKPerpComplianceRecord,
        lp_slot: LPSlot,
        token: test_usdcx_stablecoin.aleo::Token,
        deposit_amount: u64,
        merkle_proof: [test_usdcx_stablecoin.aleo::MerkleProof; 2],
        recipient: address,
    ) -> (zkperp_compliance_v8bb.aleo::ZKPerpComplianceRecord, LPSlot, test_usdcx_stablecoin.aleo::ComplianceRecord, test_usdcx_stablecoin.aleo::Token, Final) {
        assert(deposit_amount >= 100u64);
        assert_eq(lp_slot.owner, self.signer);

        let cr_expires_at: u32 = cr.expires_at;
        let caller: address = self.signer;

        let (usdcx_compliance, change_token, transfer_final):
            (test_usdcx_stablecoin.aleo::ComplianceRecord,
             test_usdcx_stablecoin.aleo::Token, Final) =
            test_usdcx_stablecoin.aleo::transfer_private_to_public(
                self.address, deposit_amount as u128, token, merkle_proof,
            );

        let updated_slot: LPSlot = LPSlot {
            owner: recipient, slot_id: 0u8, is_open: true,
            lp_amount: lp_slot.lp_amount + deposit_amount,
        };

        return (cr, updated_slot, usdcx_compliance, change_token, final {
            // ── Compliance check ──
            let is_revoked: bool = Mapping::get_or_use(zkperp_compliance_v8bb.aleo::revoked, caller, false);
            assert(!is_revoked);
            assert(block.height <= cr_expires_at);
            // ── End compliance ──
            transfer_final.run();
            let state: PoolState = Mapping::get_or_use(pool_state, 0field, PoolState {
                total_liquidity: 0u64, total_lp_tokens: 0u64,
                long_open_interest: 0u64, short_open_interest: 0u64, accumulated_fees: 0u64,
            });
            let lp_to_mint: u64 = (deposit_amount * (state.total_lp_tokens + 1u64))
                                 / (state.total_liquidity + 1u64);
            Mapping::set(pool_state, 0field, PoolState {
                total_liquidity:     state.total_liquidity + deposit_amount,
                total_lp_tokens:     state.total_lp_tokens + lp_to_mint,
                long_open_interest:  state.long_open_interest,
                short_open_interest: state.short_open_interest,
                accumulated_fees:    state.accumulated_fees,
            });
        });
    }

    fn remove_liquidity(
        cr: zkperp_compliance_v8bb.aleo::ZKPerpComplianceRecord,
        lp_slot: LPSlot,
        public amount_to_burn: u64,
        public expected_usdc: u128,
    ) -> (zkperp_compliance_v8bb.aleo::ZKPerpComplianceRecord, LPSlot, test_usdcx_stablecoin.aleo::ComplianceRecord, test_usdcx_stablecoin.aleo::Token, Final) {
        assert_eq(lp_slot.owner, self.signer);
        assert(lp_slot.is_open);
        assert(lp_slot.lp_amount >= amount_to_burn);

        let cr_expires_at: u32 = cr.expires_at;
        let caller: address = self.signer;

        let (usdcx_compliance, payout_token, transfer_final):
            (test_usdcx_stablecoin.aleo::ComplianceRecord,
             test_usdcx_stablecoin.aleo::Token, Final) =
            test_usdcx_stablecoin.aleo::transfer_public_to_private(lp_slot.owner, expected_usdc);

        let remaining: u64 = lp_slot.lp_amount - amount_to_burn;
        let updated_slot: LPSlot = LPSlot {
            owner: lp_slot.owner, slot_id: 0u8,
            is_open: remaining > 0u64, lp_amount: remaining,
        };

        return (cr, updated_slot, usdcx_compliance, payout_token, final {
            // ── Compliance check ──
            let is_revoked: bool = Mapping::get_or_use(zkperp_compliance_v8bb.aleo::revoked, caller, false);
            assert(!is_revoked);
            assert(block.height <= cr_expires_at);
            // ── End compliance ──
            transfer_final.run();
            let state: PoolState = Mapping::get(pool_state, 0field);
            let max_usdc: u64 = (amount_to_burn * state.total_liquidity)
                              / (state.total_lp_tokens + 1u64);
            assert(expected_usdc <= max_usdc as u128);
            let net_pnl: i64 = Mapping::get_or_use(net_unrealized_pnl, 0field, 0i64);
            let pnl_liability: u64 = net_pnl > 0i64 ? net_pnl as u64 : 0u64;
            let safety_buffer: u64 = (state.total_liquidity * WITHDRAWAL_BUFFER_BPS) / 1_000_000u64;
            let min_remaining: u64 = state.long_open_interest + state.short_open_interest
                                    + pnl_liability + safety_buffer;
            assert(state.total_liquidity - expected_usdc as u64 >= min_remaining);
            Mapping::set(pool_state, 0field, PoolState {
                total_liquidity:     state.total_liquidity - expected_usdc as u64,
                total_lp_tokens:     state.total_lp_tokens - amount_to_burn,
                long_open_interest:  state.long_open_interest,
                short_open_interest: state.short_open_interest,
                accumulated_fees:    state.accumulated_fees,
            });
        });
    }

    // ══════════════════════════════════════════════════════════════
    // TRADING
    // ══════════════════════════════════════════════════════════════
    //
    // v28: orchestrator input removed. Three LiquidationAuth records are minted
    // (one per keeper in liquidator_set). The keeper addresses are passed in and
    // verified against the on-chain liquidator_set in finalize so the trader
    // cannot supply colluding addresses.

    fn open_position(
        cr: zkperp_compliance_v8bb.aleo::ZKPerpComplianceRecord,
        slot: PositionSlot,
        token: test_usdcx_stablecoin.aleo::Token,
        collateral: u128,
        private size: u64,
        private is_long: bool,
        private entry_price: u64,
        private max_slippage: u64,
        nonce: field,
        recipient: address,
        private keeper_0: address,
        private keeper_1: address,
        private keeper_2: address,
        merkle_proof: [test_usdcx_stablecoin.aleo::MerkleProof; 2],
        public asset_id: field,
    ) -> (zkperp_compliance_v8bb.aleo::ZKPerpComplianceRecord, PositionSlot, LiquidationAuth, LiquidationAuth, LiquidationAuth, test_usdcx_stablecoin.aleo::ComplianceRecord, test_usdcx_stablecoin.aleo::Token, Final) {
        assert(!slot.is_open);
        assert_eq(slot.owner, self.signer);
        let expected_slot_id: u8 = is_long ? 0u8 : 1u8;
        assert_eq(slot.slot_id, expected_slot_id);

        let collateral_u64: u64 = collateral as u64;
        let leverage_scaled: u64 = (size * 100u64) / collateral_u64;
        assert(leverage_scaled <= 2000u64);
        assert(size >= 100u64);

        let opening_fee: u64 = (size * OPENING_FEE_BPS) / 1_000_000u64;
        let collateral_after_fee: u64 = collateral_u64 - opening_fee;

        let cr_expires_at: u32 = cr.expires_at;
        let caller: address = self.signer;

        let (usdcx_compliance, change_token, transfer_final):
            (test_usdcx_stablecoin.aleo::ComplianceRecord,
             test_usdcx_stablecoin.aleo::Token, Final) =
            test_usdcx_stablecoin.aleo::transfer_private_to_public(
                self.address, collateral, token, merkle_proof,
            );

        let id_input: PositionIdInput = PositionIdInput {
            recipient: recipient, nonce: nonce, size: size,
        };
        let position_id: field = BHP256::hash_to_field(id_input);

        let filled_slot: PositionSlot = PositionSlot {
            owner: recipient, slot_id: slot.slot_id, is_open: true,
            position_id: position_id, is_long: is_long,
            size_usdc: size, collateral_usdc: collateral_after_fee, entry_price: entry_price,
        };

        // One auth per keeper — each record carries the full position preimage,
        // so any single keeper can later recompute the commit and liquidate.
        let liq_auth_0: LiquidationAuth = LiquidationAuth {
            owner: keeper_0, trader: recipient, slot_id: slot.slot_id,
            position_id: position_id, is_long: is_long,
            size_usdc: size, collateral_usdc: collateral_after_fee, entry_price: entry_price,
        };
        let liq_auth_1: LiquidationAuth = LiquidationAuth {
            owner: keeper_1, trader: recipient, slot_id: slot.slot_id,
            position_id: position_id, is_long: is_long,
            size_usdc: size, collateral_usdc: collateral_after_fee, entry_price: entry_price,
        };
        let liq_auth_2: LiquidationAuth = LiquidationAuth {
            owner: keeper_2, trader: recipient, slot_id: slot.slot_id,
            position_id: position_id, is_long: is_long,
            size_usdc: size, collateral_usdc: collateral_after_fee, entry_price: entry_price,
        };

        let commit: field = BHP256::hash_to_field(PositionCommit {
            entry_price:     entry_price,
            size_usdc:       size,
            collateral_usdc: collateral_after_fee,
            is_long:         is_long,
            position_id:     position_id,
        });

        return (cr, filled_slot, liq_auth_0, liq_auth_1, liq_auth_2, usdcx_compliance, change_token, final {
            // ── Compliance check ──
            let is_revoked: bool = Mapping::get_or_use(zkperp_compliance_v8bb.aleo::revoked, caller, false);
            assert(!is_revoked);
            assert(block.height <= cr_expires_at);
            // ── End compliance ──
            // ── Oracle price check (entry) ──
            let price_data: zkperp_oracle_v3.aleo::PriceData =
                Mapping::get(zkperp_oracle_v3.aleo::oracle_prices, asset_id);
            let price_age: u32 = block.height - price_data.timestamp;
            assert(price_age <= MAX_PRICE_AGE_BLOCKS);
            let slippage: u64 = entry_price > price_data.price
                ? entry_price - price_data.price
                : price_data.price - entry_price;
            assert(slippage <= max_slippage);
            // ── End oracle check ──
            transfer_final.run();
            // ── Keepers must match the on-chain liquidator set ──
            // (trader cannot substitute their own colluding addresses)
            let set_0: address = Mapping::get(liquidator_set, 0u8);
            let set_1: address = Mapping::get(liquidator_set, 1u8);
            let set_2: address = Mapping::get(liquidator_set, 2u8);
            assert_eq(keeper_0, set_0);
            assert_eq(keeper_1, set_1);
            assert_eq(keeper_2, set_2);
            // ── End keeper check ──
            let nonce_used: bool = Mapping::get_or_use(used_nonces, nonce, false);
            assert(!nonce_used);
            Mapping::set(used_nonces, nonce, true);
            Mapping::set(position_open_blocks, position_id, block.height);
            Mapping::set(active_position_ids, position_id, position_id);
            Mapping::set(position_commits, position_id, commit);
        });
    }

    fn close_position(
        cr: zkperp_compliance_v8bb.aleo::ZKPerpComplianceRecord,
        slot: PositionSlot,
        public asset_id: field,
        public exit_price: u64,
        private entry_price: u64,
        private size_usdc: u64,
        private collateral_usdc: u64,
        private is_long: bool,
    ) -> (zkperp_compliance_v8bb.aleo::ZKPerpComplianceRecord, PositionSlot, test_usdcx_stablecoin.aleo::ComplianceRecord, test_usdcx_stablecoin.aleo::Token, Final) {
        assert(slot.is_open);
        assert_eq(slot.owner, self.signer);

        let cr_expires_at: u32 = cr.expires_at;
        let caller: address = self.signer;

        let recomputed_commit: field = BHP256::hash_to_field(PositionCommit {
            entry_price:     entry_price,
            size_usdc:       size_usdc,
            collateral_usdc: collateral_usdc,
            is_long:         is_long,
            position_id:     slot.position_id,
        });

        let raw_pnl: i64 = is_long
            ? (exit_price as i64 - entry_price as i64) * size_usdc as i64 / PRICE_PRECISION as i64
            : (entry_price as i64 - exit_price as i64) * size_usdc as i64 / PRICE_PRECISION as i64;

        let collateral_i64: i64 = collateral_usdc as i64;
        let payout_i64: i64 = collateral_i64 + raw_pnl;
        let clamped_payout: i64 = payout_i64 > 0i64 ? payout_i64 : 0i64;
        let payout: u64 = clamped_payout as u64;

        let position_id: field = slot.position_id;

        let (usdcx_compliance, payout_token, transfer_final):
            (test_usdcx_stablecoin.aleo::ComplianceRecord,
             test_usdcx_stablecoin.aleo::Token, Final) =
            test_usdcx_stablecoin.aleo::transfer_public_to_private(slot.owner, payout as u128);

        let empty_slot: PositionSlot = PositionSlot {
            owner: slot.owner, slot_id: slot.slot_id, is_open: false,
            position_id: 0field, is_long: false,
            size_usdc: 0u64, collateral_usdc: 0u64, entry_price: 0u64,
        };

        return (cr, empty_slot, usdcx_compliance, payout_token, final {
            // ── Compliance check ──
            let is_revoked: bool = Mapping::get_or_use(zkperp_compliance_v8bb.aleo::revoked, caller, false);
            assert(!is_revoked);
            assert(block.height <= cr_expires_at);
            // ── End compliance ──
            transfer_final.run();
            let stored_commit: field = Mapping::get(position_commits, position_id);
            assert_eq(recomputed_commit, stored_commit);
            // ── Oracle price check ──
            let price_data: zkperp_oracle_v3.aleo::PriceData =
                Mapping::get(zkperp_oracle_v3.aleo::oracle_prices, asset_id);
            assert_eq(exit_price, price_data.price);
            assert(block.height - price_data.timestamp <= MAX_PRICE_AGE_BLOCKS);
            // ── End oracle check ──
            let pool: PoolState = Mapping::get(pool_state, 0field);
            assert(pool.total_liquidity >= payout);
            Mapping::remove(position_commits, position_id);
            Mapping::remove(position_open_blocks, position_id);
            Mapping::remove(active_position_ids, position_id);
        });
    }

    // ══════════════════════════════════════════════════════════════
    // LIQUIDATION — 1-of-N keepers, insolvency enforced on-chain
    // ══════════════════════════════════════════════════════════════
    //
    // No compliance check (the liquidator, not the trader, calls this), but the
    // finalize now PROVES the liquidation is justified:
    //   1. position is open (active_position_ids)
    //   2. supplied params match the on-chain commit (no lying about size/collateral)
    //   3. exit_price is the fresh, quorum-agreed oracle price
    //   4. equity < maintenance margin (position genuinely underwater)
    //   5. caller is a current member of liquidator_set
    //   6. pool can cover the (deterministic) reward
    // Reward is collateral * LIQ_PENALTY_BPS, NOT a caller-supplied amount.

    fn liquidate(
        auth: LiquidationAuth,
        public asset_id: field,
        public exit_price: u64,
        private entry_price: u64,
        private size_usdc: u64,
        private collateral_usdc: u64,
        private is_long: bool,
    ) -> (PositionSlot, test_usdcx_stablecoin.aleo::ComplianceRecord, test_usdcx_stablecoin.aleo::Token, Final) {
        // Record ownership already guarantees the caller holds this auth.
        assert_eq(auth.owner, self.caller);
        // The supplied direction must match the auth (commit check covers the rest).
        assert_eq(is_long, auth.is_long);

        let caller: address = self.caller;
        let position_id: field = auth.position_id;

        // Recompute the commit so the caller cannot lie about position params.
        let recomputed_commit: field = BHP256::hash_to_field(PositionCommit {
            entry_price:     entry_price,
            size_usdc:       size_usdc,
            collateral_usdc: collateral_usdc,
            is_long:         is_long,
            position_id:     position_id,
        });

        // PnL — identical formula to close_position.
        let raw_pnl: i64 = is_long
            ? (exit_price as i64 - entry_price as i64) * size_usdc as i64 / PRICE_PRECISION as i64
            : (entry_price as i64 - exit_price as i64) * size_usdc as i64 / PRICE_PRECISION as i64;

        let equity_i64: i64 = collateral_usdc as i64 + raw_pnl;

        // Deterministic reward off collateral (not caller-chosen). Because
        // collateral_usdc is verified against the commit in finalize, the reward
        // cannot be inflated by lying — the whole tx reverts if it doesn't match.
        let liquidator_reward: u64 = (collateral_usdc * LIQ_PENALTY_BPS) / 1_000_000u64;

        let (usdcx_compliance, reward_token, transfer_final):
            (test_usdcx_stablecoin.aleo::ComplianceRecord,
             test_usdcx_stablecoin.aleo::Token, Final) =
            test_usdcx_stablecoin.aleo::transfer_public_to_private(self.caller, liquidator_reward as u128);

        let empty_slot: PositionSlot = PositionSlot {
            owner: auth.trader, slot_id: auth.slot_id, is_open: false,
            position_id: 0field, is_long: false,
            size_usdc: 0u64, collateral_usdc: 0u64, entry_price: 0u64,
        };

        return (empty_slot, usdcx_compliance, reward_token, final {
            transfer_final.run();

            // 1. Position must be open.
            let stored_id: field = Mapping::get(active_position_ids, position_id);
            assert_eq(stored_id, position_id);

            // 2. Params must match the on-chain commit.
            let stored_commit: field = Mapping::get(position_commits, position_id);
            assert_eq(recomputed_commit, stored_commit);

            // 3. Exit price must be the fresh, quorum-agreed oracle price.
            let price_data: zkperp_oracle_v3.aleo::PriceData =
                Mapping::get(zkperp_oracle_v3.aleo::oracle_prices, asset_id);
            assert_eq(exit_price, price_data.price);
            assert(block.height - price_data.timestamp <= MAX_PRICE_AGE_BLOCKS);

            // 4. Position must actually be underwater.
            let maint_margin: i64 = (size_usdc * MAINTENANCE_MARGIN_BPS / 1_000_000u64) as i64;
            assert(equity_i64 < maint_margin);

            // 5. Caller must be a current keeper (defends against rotated-out keys).
            let s0: address = Mapping::get(liquidator_set, 0u8);
            let s1: address = Mapping::get(liquidator_set, 1u8);
            let s2: address = Mapping::get(liquidator_set, 2u8);
            let is_keeper: bool = (caller == s0) || (caller == s1) || (caller == s2);
            assert(is_keeper);

            // 6. Pool can cover the reward.
            let pool: PoolState = Mapping::get(pool_state, 0field);
            assert(pool.total_liquidity >= liquidator_reward);

            Mapping::remove(position_commits, position_id);
            Mapping::remove(position_open_blocks, position_id);
            Mapping::remove(active_position_ids, position_id);
        });
    }

    // ══════════════════════════════════════════════════════════════
    // TAKE PROFIT
    // ══════════════════════════════════════════════════════════════

    fn place_take_profit(
        cr: zkperp_compliance_v8bb.aleo::ZKPerpComplianceRecord,
        slot: PositionSlot,
        private trigger_price: u64,
        private orchestrator: address,
        nonce: field,
    ) -> (zkperp_compliance_v8bb.aleo::ZKPerpComplianceRecord, OrderReceipt, ExecTPSLAuth, PositionSlot, Final) {
        assert(slot.is_open);
        assert_eq(slot.owner, self.signer);

        let cr_expires_at: u32 = cr.expires_at;
        let caller: address = self.signer;

        if slot.is_long {
            assert(trigger_price > slot.entry_price);
        } else {
            assert(trigger_price < slot.entry_price);
        }

        let id_input: OrderIdInput = OrderIdInput {
            trader: slot.owner, nonce: nonce, trigger_price: trigger_price,
        };
        let order_id: field = BHP256::hash_to_field(id_input);

        let auth: ExecTPSLAuth = ExecTPSLAuth {
            owner: orchestrator, order_id: order_id, order_type: 1u8,
            trader: slot.owner, slot_id: slot.slot_id, position_id: slot.position_id,
            is_long: slot.is_long, trigger_price: trigger_price,
            size_usdc: slot.size_usdc, collateral_usdc: slot.collateral_usdc,
            entry_price: slot.entry_price, nonce: nonce,
        };

        let receipt: OrderReceipt = OrderReceipt {
            owner: slot.owner, order_id: order_id, order_type: 1u8,
            is_long: slot.is_long, trigger_price: trigger_price,
            size_usdc: slot.size_usdc, collateral_usdc: slot.collateral_usdc,
            entry_price: slot.entry_price, position_id: slot.position_id,
            slot_id: slot.slot_id, nonce: nonce,
        };

        let trader: address = slot.owner;
        let trader_slot: PositionSlot = slot;

        return (cr, receipt, auth, trader_slot, final {
            // ── Compliance check ──
            let is_revoked: bool = Mapping::get_or_use(zkperp_compliance_v8bb.aleo::revoked, caller, false);
            assert(!is_revoked);
            assert(block.height <= cr_expires_at);
            // ── End compliance ──
            Mapping::set(pending_orders, order_id, true);
            Mapping::set(order_traders, order_id, trader);
        });
    }

    fn execute_take_profit(
        auth: ExecTPSLAuth,
        public asset_id: field,
        public exit_price: u64,
        private entry_price: u64,
        private size_usdc: u64,
        private collateral_usdc: u64,
        private execution_nonce: field,
    ) -> (PositionSlot, test_usdcx_stablecoin.aleo::ComplianceRecord, test_usdcx_stablecoin.aleo::Token, Final) {
        assert_eq(self.caller, auth.owner);
        assert_eq(auth.order_type, 1u8);

        let recomputed_commit: field = BHP256::hash_to_field(PositionCommit {
            entry_price:     entry_price,
            size_usdc:       size_usdc,
            collateral_usdc: collateral_usdc,
            is_long:         auth.is_long,
            position_id:     auth.position_id,
        });

        let raw_pnl: i64 = auth.is_long
            ? (exit_price as i64 - entry_price as i64) * size_usdc as i64 / PRICE_PRECISION as i64
            : (entry_price as i64 - exit_price as i64) * size_usdc as i64 / PRICE_PRECISION as i64;

        let collateral_i64: i64 = collateral_usdc as i64;
        let payout_i64: i64 = collateral_i64 + raw_pnl;
        let clamped_payout: i64 = payout_i64 > 0i64 ? payout_i64 : 0i64;
        let payout: u64 = clamped_payout as u64;

        let order_id: field    = auth.order_id;
        let position_id: field = auth.position_id;

        let (usdcx_compliance, payout_token, transfer_final):
            (test_usdcx_stablecoin.aleo::ComplianceRecord,
             test_usdcx_stablecoin.aleo::Token, Final) =
            test_usdcx_stablecoin.aleo::transfer_public_to_private(auth.trader, payout as u128);

        let empty_slot: PositionSlot = PositionSlot {
            owner: auth.trader, slot_id: auth.slot_id, is_open: false,
            position_id: 0field, is_long: false,
            size_usdc: 0u64, collateral_usdc: 0u64, entry_price: 0u64,
        };

        return (empty_slot, usdcx_compliance, payout_token, final {
            transfer_final.run();
            let stored_commit: field = Mapping::get(position_commits, position_id);
            assert_eq(recomputed_commit, stored_commit);
            // ── Oracle price check ──
            let price_data: zkperp_oracle_v3.aleo::PriceData =
                Mapping::get(zkperp_oracle_v3.aleo::oracle_prices, asset_id);
            assert_eq(exit_price, price_data.price);
            assert(block.height - price_data.timestamp <= MAX_PRICE_AGE_BLOCKS);
            // ── End oracle check ──
            let is_pending: bool = Mapping::get(pending_orders, order_id);
            assert(is_pending);
            let nonce_used: bool = Mapping::get_or_use(used_nonces, execution_nonce, false);
            assert(!nonce_used);
            Mapping::set(used_nonces, execution_nonce, true);
            let pool: PoolState = Mapping::get(pool_state, 0field);
            assert(pool.total_liquidity >= payout);
            Mapping::remove(pending_orders, order_id);
            Mapping::remove(order_traders, order_id);
            Mapping::remove(position_commits, position_id);
            Mapping::remove(position_open_blocks, position_id);
            Mapping::remove(active_position_ids, position_id);
        });
    }

    // ══════════════════════════════════════════════════════════════
    // STOP LOSS
    // ══════════════════════════════════════════════════════════════

    fn place_stop_loss(
        cr: zkperp_compliance_v8bb.aleo::ZKPerpComplianceRecord,
        slot: PositionSlot,
        private trigger_price: u64,
        private orchestrator: address,
        nonce: field,
    ) -> (zkperp_compliance_v8bb.aleo::ZKPerpComplianceRecord, OrderReceipt, ExecTPSLAuth, PositionSlot, Final) {
        assert(slot.is_open);
        assert_eq(slot.owner, self.signer);

        let cr_expires_at: u32 = cr.expires_at;
        let caller: address = self.signer;

        if slot.is_long {
            assert(trigger_price < slot.entry_price);
        } else {
            assert(trigger_price > slot.entry_price);
        }

        let id_input: OrderIdInput = OrderIdInput {
            trader: slot.owner, nonce: nonce, trigger_price: trigger_price,
        };
        let order_id: field = BHP256::hash_to_field(id_input);

        let auth: ExecTPSLAuth = ExecTPSLAuth {
            owner: orchestrator, order_id: order_id, order_type: 2u8,
            trader: slot.owner, slot_id: slot.slot_id, position_id: slot.position_id,
            is_long: slot.is_long, trigger_price: trigger_price,
            size_usdc: slot.size_usdc, collateral_usdc: slot.collateral_usdc,
            entry_price: slot.entry_price, nonce: nonce,
        };

        let receipt: OrderReceipt = OrderReceipt {
            owner: slot.owner, order_id: order_id, order_type: 2u8,
            is_long: slot.is_long, trigger_price: trigger_price,
            size_usdc: slot.size_usdc, collateral_usdc: slot.collateral_usdc,
            entry_price: slot.entry_price, position_id: slot.position_id,
            slot_id: slot.slot_id, nonce: nonce,
        };

        let position_id: field = slot.position_id;
        let trader: address = slot.owner;
        let trader_slot: PositionSlot = slot;

        return (cr, receipt, auth, trader_slot, final {
            // ── Compliance check ──
            let is_revoked: bool = Mapping::get_or_use(zkperp_compliance_v8bb.aleo::revoked, caller, false);
            assert(!is_revoked);
            assert(block.height <= cr_expires_at);
            // ── End compliance ──
            let is_active: field = Mapping::get(active_position_ids, position_id);
            assert_eq(is_active, position_id);
            let expected_orch: address = Mapping::get(roles, 1u8);
            assert_eq(orchestrator, expected_orch);
            let nonce_used: bool = Mapping::get_or_use(order_nonces, nonce, false);
            assert(!nonce_used);
            Mapping::set(order_nonces, nonce, true);
            Mapping::set(pending_orders, order_id, true);
            Mapping::set(order_traders, order_id, trader);
        });
    }

    fn execute_stop_loss(
        auth: ExecTPSLAuth,
        public asset_id: field,
        public exit_price: u64,
        private entry_price: u64,
        private size_usdc: u64,
        private collateral_usdc: u64,
        private execution_nonce: field,
    ) -> (PositionSlot, test_usdcx_stablecoin.aleo::ComplianceRecord, test_usdcx_stablecoin.aleo::Token, Final) {
        assert_eq(self.caller, auth.owner);
        assert_eq(auth.order_type, 2u8);

        let recomputed_commit: field = BHP256::hash_to_field(PositionCommit {
            entry_price:     entry_price,
            size_usdc:       size_usdc,
            collateral_usdc: collateral_usdc,
            is_long:         auth.is_long,
            position_id:     auth.position_id,
        });

        let raw_pnl: i64 = auth.is_long
            ? (exit_price as i64 - entry_price as i64) * size_usdc as i64 / PRICE_PRECISION as i64
            : (entry_price as i64 - exit_price as i64) * size_usdc as i64 / PRICE_PRECISION as i64;

        let collateral_i64: i64 = collateral_usdc as i64;
        let payout_i64: i64 = collateral_i64 + raw_pnl;
        let clamped_payout: i64 = payout_i64 > 0i64 ? payout_i64 : 0i64;
        let payout: u64 = clamped_payout as u64;

        let order_id: field    = auth.order_id;
        let position_id: field = auth.position_id;

        let (usdcx_compliance, payout_token, transfer_final):
            (test_usdcx_stablecoin.aleo::ComplianceRecord,
             test_usdcx_stablecoin.aleo::Token, Final) =
            test_usdcx_stablecoin.aleo::transfer_public_to_private(auth.trader, payout as u128);

        let empty_slot: PositionSlot = PositionSlot {
            owner: auth.trader, slot_id: auth.slot_id, is_open: false,
            position_id: 0field, is_long: false,
            size_usdc: 0u64, collateral_usdc: 0u64, entry_price: 0u64,
        };

        return (empty_slot, usdcx_compliance, payout_token, final {
            transfer_final.run();
            let stored_commit: field = Mapping::get(position_commits, position_id);
            assert_eq(recomputed_commit, stored_commit);
            // ── Oracle price check ──
            let price_data: zkperp_oracle_v3.aleo::PriceData =
                Mapping::get(zkperp_oracle_v3.aleo::oracle_prices, asset_id);
            assert_eq(exit_price, price_data.price);
            assert(block.height - price_data.timestamp <= MAX_PRICE_AGE_BLOCKS);
            // ── End oracle check ──
            let is_pending: bool = Mapping::get(pending_orders, order_id);
            assert(is_pending);
            let nonce_used: bool = Mapping::get_or_use(used_nonces, execution_nonce, false);
            assert(!nonce_used);
            Mapping::set(used_nonces, execution_nonce, true);
            let pool: PoolState = Mapping::get(pool_state, 0field);
            assert(pool.total_liquidity >= payout);
            Mapping::remove(pending_orders, order_id);
            Mapping::remove(order_traders, order_id);
            Mapping::remove(position_commits, position_id);
            Mapping::remove(position_open_blocks, position_id);
            Mapping::remove(active_position_ids, position_id);
        });
    }

    fn cancel_tp_sl(
        cr: zkperp_compliance_v8bb.aleo::ZKPerpComplianceRecord,
        slot: PositionSlot,
        receipt: OrderReceipt,
    ) -> (zkperp_compliance_v8bb.aleo::ZKPerpComplianceRecord, PositionSlot, Final) {
        assert_eq(self.signer, slot.owner);
        assert_eq(self.signer, receipt.owner);
        assert_eq(slot.position_id, receipt.position_id);
        assert(receipt.order_type == 1u8 || receipt.order_type == 2u8);

        let cr_expires_at: u32 = cr.expires_at;
        let caller: address = self.signer;
        let order_id: field = receipt.order_id;
        let trader: address = slot.owner;
        let returned_slot: PositionSlot = slot;

        return (cr, returned_slot, final {
            // ── Compliance check ──
            let is_revoked: bool = Mapping::get_or_use(zkperp_compliance_v8bb.aleo::revoked, caller, false);
            assert(!is_revoked);
            assert(block.height <= cr_expires_at);
            // ── End compliance ──
            let stored_trader: address = Mapping::get(order_traders, order_id);
            assert_eq(trader, stored_trader);
            let is_active: bool = Mapping::get(pending_orders, order_id);
            assert(is_active);
            Mapping::remove(pending_orders, order_id);
            Mapping::remove(order_traders, order_id);
        });
    }

    // ══════════════════════════════════════════════════════════════
    // BURN STALE ORDER RECORDS — no compliance needed
    // ══════════════════════════════════════════════════════════════

    fn burn_order_receipt(receipt: OrderReceipt) -> Final {
        assert_eq(receipt.owner, self.signer);
        assert(receipt.order_type == 1u8 || receipt.order_type == 2u8);
        let order_id: field = receipt.order_id;
        return final {
            let still_pending: bool = Mapping::contains(pending_orders, order_id);
            assert(!still_pending);
        };
    }

    // ══════════════════════════════════════════════════════════════
    // BURN STALE LIQUIDATION AUTH — losing keepers discard their auth for a
    // position that's already closed/liquidated. No compliance needed.
    // ══════════════════════════════════════════════════════════════

    fn burn_liquidation_auth(auth: LiquidationAuth) -> Final {
        assert_eq(auth.owner, self.signer);
        let position_id: field = auth.position_id;
        return final {
            // Only burnable once the position is no longer active —
            // prevents discarding an auth for a still-open position.
            let still_active: bool = Mapping::contains(active_position_ids, position_id);
            assert(!still_active);
        };
    }

    // ══════════════════════════════════════════════════════════════
    // POOL STATE + NET PNL — orchestrator only, no compliance needed
    // ══════════════════════════════════════════════════════════════

    fn update_net_pnl(public net_pnl: i64) -> Final {
        let caller: address = self.caller;
        return final {
            let orchestrator: address = Mapping::get(roles, 1u8);
            assert_eq(caller, orchestrator);
            Mapping::set(net_unrealized_pnl, 0field, net_pnl);
        };
    }

    fn update_pool_state(
        public new_liquidity: u64,
        public new_long_oi:   u64,
        public new_short_oi:  u64,
        public new_lp_tokens: u64,
        public new_fees:      u64,
    ) -> Final {
        let caller: address = self.caller;
        return final {
            let orchestrator: address = Mapping::get(roles, 1u8);
            assert_eq(caller, orchestrator);
            Mapping::set(pool_state, 0field, PoolState {
                total_liquidity:     new_liquidity,
                total_lp_tokens:     new_lp_tokens,
                long_open_interest:  new_long_oi,
                short_open_interest: new_short_oi,
                accumulated_fees:    new_fees,
            });
        };
    }

}
