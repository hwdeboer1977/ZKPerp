// ZKPerp Core v26 — oracle reads from zkperp_oracle_v2.aleo
//
// Price reads are now cross-program calls to zkperp_oracle_v2.aleo::oracle_prices.
// Prices are only committed there after 2-of-3 independent oracle nodes agree.
// update_price and core's own oracle_prices mapping have been removed.
// A staleness guard (150 blocks ≈ 5 min) is enforced on every price read.
//
// All trader functions require a valid ZKPerpComplianceRecord:
//   - issued_under must match active compliance root
//   - expires_at must be > block.height
//   - address must not be revoked
// Admin/oracle functions (update_pool_state, update_net_pnl, liquidate) are exempt.

import test_usdcx_stablecoin.aleo;
import zkperp_compliance_v7.aleo;
import zkperp_oracle_v2.aleo;

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

program zkperp_core_v26.aleo {

    @custom
    constructor() {
        Mapping::set(roles, 0u8, self.program_owner);
        Mapping::set(roles, 1u8, self.program_owner);
    }

    const OPENING_FEE_BPS: u64       = 1_000u64;
    const WITHDRAWAL_BUFFER_BPS: u64 = 100_000u64;
    const PRICE_PRECISION: u64       = 100_000_000_000u64;
    const MAX_PRICE_AGE_BLOCKS: u32  = 150u32; // ≈ 5 min staleness limit

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
    // COMPLIANCE CHECK HELPER (inline into every trader function)
    // ══════════════════════════════════════════════════════════════
    //
    // Usage in each trader fn:
    //   1. Accept: cr: zkperp_compliance_v7.aleo::ZKPerpComplianceRecord
    //   2. Extract before final{}: let cr_issued_under = cr.issued_under; let cr_expires_at = cr.expires_at;
    //   3. Return cr as first output
    //   4. In final{}: assert compliance (see pattern below)
    //
    // final{} compliance block:
    //   let active_root: field = Mapping::get(zkperp_compliance_v7.aleo::compliance_root, 0u8);
    //   assert_eq(cr_issued_under, active_root);
    //   let is_revoked: bool = Mapping::get_or_use(zkperp_compliance_v7.aleo::revoked, caller, false);
    //   assert(!is_revoked);
    //   assert(block.height <= cr_expires_at);

    // ══════════════════════════════════════════════════════════════
    // ORACLE PRICE READ HELPER
    // ══════════════════════════════════════════════════════════════
    //
    // All price reads go through zkperp_oracle_v2.aleo::oracle_prices.
    // Prices are committed there only after 2-of-3 oracle nodes agree.
    // Pattern used in every finalize that needs a price:
    //
    //   let price_data: zkperp_oracle_v2.aleo::PriceData =
    //       Mapping::get(zkperp_oracle_v2.aleo::oracle_prices, asset_id);
    //   assert_eq(exit_price, price_data.price);
    //   assert(block.height - price_data.timestamp <= MAX_PRICE_AGE_BLOCKS);

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
        cr: zkperp_compliance_v7.aleo::ZKPerpComplianceRecord,
        lp_slot: LPSlot,
        token: test_usdcx_stablecoin.aleo::Token,
        deposit_amount: u64,
        merkle_proof: [test_usdcx_stablecoin.aleo::MerkleProof; 2],
        recipient: address,
    ) -> (zkperp_compliance_v7.aleo::ZKPerpComplianceRecord, LPSlot, test_usdcx_stablecoin.aleo::ComplianceRecord, test_usdcx_stablecoin.aleo::Token, Final) {
        assert(deposit_amount >= 100u64);
        assert_eq(lp_slot.owner, self.signer);

        let cr_issued_under: field = cr.issued_under;
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
            let active_root: field = Mapping::get(zkperp_compliance_v7.aleo::compliance_root, 0u8);
            assert_eq(cr_issued_under, active_root);
            let is_revoked: bool = Mapping::get_or_use(zkperp_compliance_v7.aleo::revoked, caller, false);
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
        cr: zkperp_compliance_v7.aleo::ZKPerpComplianceRecord,
        lp_slot: LPSlot,
        public amount_to_burn: u64,
        public expected_usdc: u128,
    ) -> (zkperp_compliance_v7.aleo::ZKPerpComplianceRecord, LPSlot, test_usdcx_stablecoin.aleo::ComplianceRecord, test_usdcx_stablecoin.aleo::Token, Final) {
        assert_eq(lp_slot.owner, self.signer);
        assert(lp_slot.is_open);
        assert(lp_slot.lp_amount >= amount_to_burn);

        let cr_issued_under: field = cr.issued_under;
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
            let active_root: field = Mapping::get(zkperp_compliance_v7.aleo::compliance_root, 0u8);
            assert_eq(cr_issued_under, active_root);
            let is_revoked: bool = Mapping::get_or_use(zkperp_compliance_v7.aleo::revoked, caller, false);
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

    fn open_position(
        cr: zkperp_compliance_v7.aleo::ZKPerpComplianceRecord,
        slot: PositionSlot,
        token: test_usdcx_stablecoin.aleo::Token,
        collateral: u128,
        private size: u64,
        private is_long: bool,
        private entry_price: u64,
        private max_slippage: u64,
        nonce: field,
        recipient: address,
        private orchestrator: address,
        merkle_proof: [test_usdcx_stablecoin.aleo::MerkleProof; 2],
        public asset_id: field,
    ) -> (zkperp_compliance_v7.aleo::ZKPerpComplianceRecord, PositionSlot, LiquidationAuth, test_usdcx_stablecoin.aleo::ComplianceRecord, test_usdcx_stablecoin.aleo::Token, Final) {
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

        let cr_issued_under: field = cr.issued_under;
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

        let liq_auth: LiquidationAuth = LiquidationAuth {
            owner: orchestrator, trader: recipient, slot_id: slot.slot_id,
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

        return (cr, filled_slot, liq_auth, usdcx_compliance, change_token, final {
            // ── Compliance check ──
            let active_root: field = Mapping::get(zkperp_compliance_v7.aleo::compliance_root, 0u8);
            assert_eq(cr_issued_under, active_root);
            let is_revoked: bool = Mapping::get_or_use(zkperp_compliance_v7.aleo::revoked, caller, false);
            assert(!is_revoked);
            assert(block.height <= cr_expires_at);
            // ── End compliance ──
            // ── Oracle price check (entry) ──
            let price_data: zkperp_oracle_v2.aleo::PriceData =
                Mapping::get(zkperp_oracle_v2.aleo::oracle_prices, asset_id);
            let price_age: u32 = block.height - price_data.timestamp;
            assert(price_age <= MAX_PRICE_AGE_BLOCKS);
            let slippage: u64 = entry_price > price_data.price
                ? entry_price - price_data.price
                : price_data.price - entry_price;
            assert(slippage <= max_slippage);
            // ── End oracle check ──
            transfer_final.run();
            let expected_orchestrator: address = Mapping::get(roles, 1u8);
            assert_eq(orchestrator, expected_orchestrator);
            let nonce_used: bool = Mapping::get_or_use(used_nonces, nonce, false);
            assert(!nonce_used);
            Mapping::set(used_nonces, nonce, true);
            Mapping::set(position_open_blocks, position_id, block.height);
            Mapping::set(active_position_ids, position_id, position_id);
            Mapping::set(position_commits, position_id, commit);
        });
    }

    fn close_position(
        cr: zkperp_compliance_v7.aleo::ZKPerpComplianceRecord,
        slot: PositionSlot,
        public asset_id: field,
        public exit_price: u64,
        private entry_price: u64,
        private size_usdc: u64,
        private collateral_usdc: u64,
        private is_long: bool,
    ) -> (zkperp_compliance_v7.aleo::ZKPerpComplianceRecord, PositionSlot, test_usdcx_stablecoin.aleo::ComplianceRecord, test_usdcx_stablecoin.aleo::Token, Final) {
        assert(slot.is_open);
        assert_eq(slot.owner, self.signer);

        let cr_issued_under: field = cr.issued_under;
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
            let active_root: field = Mapping::get(zkperp_compliance_v7.aleo::compliance_root, 0u8);
            assert_eq(cr_issued_under, active_root);
            let is_revoked: bool = Mapping::get_or_use(zkperp_compliance_v7.aleo::revoked, caller, false);
            assert(!is_revoked);
            assert(block.height <= cr_expires_at);
            // ── End compliance ──
            transfer_final.run();
            let stored_commit: field = Mapping::get(position_commits, position_id);
            assert_eq(recomputed_commit, stored_commit);
            // ── Oracle price check ──
            let price_data: zkperp_oracle_v2.aleo::PriceData =
                Mapping::get(zkperp_oracle_v2.aleo::oracle_prices, asset_id);
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
    // LIQUIDATION — no compliance check (orchestrator calls this)
    // ══════════════════════════════════════════════════════════════

    fn liquidate(
        auth: LiquidationAuth,
        public liquidator_reward: u128,
    ) -> (PositionSlot, test_usdcx_stablecoin.aleo::ComplianceRecord, test_usdcx_stablecoin.aleo::Token, Final) {
        assert_eq(auth.owner, self.caller);

        let position_id: field = auth.position_id;

        let (usdcx_compliance, reward_token, transfer_final):
            (test_usdcx_stablecoin.aleo::ComplianceRecord,
             test_usdcx_stablecoin.aleo::Token, Final) =
            test_usdcx_stablecoin.aleo::transfer_public_to_private(self.caller, liquidator_reward);

        let empty_slot: PositionSlot = PositionSlot {
            owner: auth.trader, slot_id: auth.slot_id, is_open: false,
            position_id: 0field, is_long: false,
            size_usdc: 0u64, collateral_usdc: 0u64, entry_price: 0u64,
        };

        return (empty_slot, usdcx_compliance, reward_token, final {
            transfer_final.run();
            let stored_id: field = Mapping::get(active_position_ids, position_id);
            assert_eq(stored_id, position_id);
            let pool: PoolState = Mapping::get(pool_state, 0field);
            assert(pool.total_liquidity >= liquidator_reward as u64);
            Mapping::remove(position_commits, position_id);
            Mapping::remove(position_open_blocks, position_id);
            Mapping::remove(active_position_ids, position_id);
        });
    }

    // ══════════════════════════════════════════════════════════════
    // TAKE PROFIT
    // ══════════════════════════════════════════════════════════════

    fn place_take_profit(
        cr: zkperp_compliance_v7.aleo::ZKPerpComplianceRecord,
        slot: PositionSlot,
        private trigger_price: u64,
        private orchestrator: address,
        nonce: field,
    ) -> (zkperp_compliance_v7.aleo::ZKPerpComplianceRecord, OrderReceipt, ExecTPSLAuth, PositionSlot, Final) {
        assert(slot.is_open);
        assert_eq(slot.owner, self.signer);

        let cr_issued_under: field = cr.issued_under;
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
            let active_root: field = Mapping::get(zkperp_compliance_v7.aleo::compliance_root, 0u8);
            assert_eq(cr_issued_under, active_root);
            let is_revoked: bool = Mapping::get_or_use(zkperp_compliance_v7.aleo::revoked, caller, false);
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
            let price_data: zkperp_oracle_v2.aleo::PriceData =
                Mapping::get(zkperp_oracle_v2.aleo::oracle_prices, asset_id);
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
        cr: zkperp_compliance_v7.aleo::ZKPerpComplianceRecord,
        slot: PositionSlot,
        private trigger_price: u64,
        private orchestrator: address,
        nonce: field,
    ) -> (zkperp_compliance_v7.aleo::ZKPerpComplianceRecord, OrderReceipt, ExecTPSLAuth, PositionSlot, Final) {
        assert(slot.is_open);
        assert_eq(slot.owner, self.signer);

        let cr_issued_under: field = cr.issued_under;
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
            let active_root: field = Mapping::get(zkperp_compliance_v7.aleo::compliance_root, 0u8);
            assert_eq(cr_issued_under, active_root);
            let is_revoked: bool = Mapping::get_or_use(zkperp_compliance_v7.aleo::revoked, caller, false);
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
            let price_data: zkperp_oracle_v2.aleo::PriceData =
                Mapping::get(zkperp_oracle_v2.aleo::oracle_prices, asset_id);
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
        cr: zkperp_compliance_v7.aleo::ZKPerpComplianceRecord,
        slot: PositionSlot,
        receipt: OrderReceipt,
    ) -> (zkperp_compliance_v7.aleo::ZKPerpComplianceRecord, PositionSlot, Final) {
        assert_eq(self.signer, slot.owner);
        assert_eq(self.signer, receipt.owner);
        assert_eq(slot.position_id, receipt.position_id);
        assert(receipt.order_type == 1u8 || receipt.order_type == 2u8);

        let cr_issued_under: field = cr.issued_under;
        let cr_expires_at: u32 = cr.expires_at;
        let caller: address = self.signer;
        let order_id: field = receipt.order_id;
        let trader: address = slot.owner;
        let returned_slot: PositionSlot = slot;

        return (cr, returned_slot, final {
            // ── Compliance check ──
            let active_root: field = Mapping::get(zkperp_compliance_v7.aleo::compliance_root, 0u8);
            assert_eq(cr_issued_under, active_root);
            let is_revoked: bool = Mapping::get_or_use(zkperp_compliance_v7.aleo::revoked, caller, false);
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
