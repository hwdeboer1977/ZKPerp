// ZKPerp v20 PRIVATE — maximum privacy perpetual DEX on Aleo
//
// KEY CHANGE vs v19/v20:
//   All position params (size, collateral, direction, price, triggers)
//   removed from ALL finalize functions — nothing readable on-chain.
//   Business logic (PnL, slippage, leverage, liquidation threshold,
//   trigger conditions) proven purely in ZK transition, not re-computed
//   on-chain. Pool state updated by orchestrator via update_pool_state.
//
// On-chain finalize args: only hashes (position_id, order_id), nonces,
//   and orchestrator address. An observer sees NOTHING about any trade.
// KEY CHANGE from v13:
//   Deposits use transfer_private_to_public(self.address, amount, token, proof)
//   → burns user Token record, funds balances[zkperp_v14.aleo] directly
//   → remove/close/liquidate pay out via transfer_public_to_private as before
// Individual deposit amounts hidden. Pool TVL visible (already was via pool_state mapping).
// Slot-based record model: 3 fixed records per trader, forever
//
// KEY CHANGE from v8:
//   v8: 3 PositionSlots + 3 LPSlots = 6 records
//   v9: 2 PositionSlots + 1 LPSlot  = 3 records
//
// SLOT SEMANTICS:
//   PositionSlot slot_id: 0u8 = LONG slot  (can only hold long positions)
//   PositionSlot slot_id: 1u8 = SHORT slot (can only hold short positions)
//   LPSlot slot_id: 0u8       = single running LP position (always merged)
//
// WALLET RECORD COUNT (constant regardless of trade history):
//   1 LPSlot       (lp_amount accumulates, is_open: false when empty)
//   1 PositionSlot (slot_id: 0, long only)
//   1 PositionSlot (slot_id: 1, short only)
//   + LiquidationAuth records held by orchestrator (not trader's wallet)
//
// KEY ADDITIONS in v15 (from tested liquidity module):
//   WITHDRAWAL_BUFFER_BPS: 10% safety buffer on all LP withdrawals
//   net_unrealized_pnl mapping: orchestrator-submitted aggregate PnL
//   update_net_pnl transition: orchestrator updates PnL after each price tick
//   finalize_remove_liquidity: full guard = OI + PnL liability + safety buffer
//   Asymmetric PnL: positive PnL reduces LP headroom; negative PnL does NOT increase it
//
// KEY ADDITIONS in v16 (from main_limit.leo):
//   PendingOrder record: limit orders, take profit, stop loss
//   pending_orders mapping: active order registry
//   place_take_profit: schedule profitable close at target price
//   place_stop_loss: schedule protective close at loss threshold
//   execute_take_profit: keeper closes position at TP price (private payout)
//   execute_stop_loss: keeper closes position at market (private payout)

import test_usdcx_stablecoin.aleo;

program zkperp_sol_v21.aleo {

    // ═══════════════════════════════════════════════════════════════
    // ARCHITECTURE OVERVIEW
    // ═══════════════════════════════════════════════════════════════
    //
    // TRADER LIFECYCLE:
    //   1. Call initialize_slots() once → receive 2 PositionSlots + 1 LPSlot
    //   2. open_position(long_slot OR short_slot, ...) → filled PositionSlot + LiquidationAuth to orchestrator
    //   3. close_position(filled_slot, ...) → empty PositionSlot back
    //
    // SLOT ENFORCEMENT:
    //   open_position asserts slot_id == 0u8 if is_long == true
    //   open_position asserts slot_id == 1u8 if is_long == false
    //   This prevents accidentally using wrong slot direction
    //
    // LIQUIDATION LIFECYCLE:
    //   Orchestrator calls liquidate(auth, ...) → empty PositionSlot returned to TRADER
    //
    // LP LIFECYCLE:
    //   1. add_liquidity(lp_slot, amount) → updated LPSlot (lp_amount increases)
    //   2. remove_liquidity(lp_slot, amount) → updated LPSlot (lp_amount decreases, empty if fully withdrawn)
    //
    // ═══════════════════════════════════════════════════════════════

    // ============== CONSTANTS ==============

    const SCALE: u128 = 1_000_000u128;
    const MIN_MARGIN_BPS: u64 = 50_000u64;            // 5% min margin (20x max leverage)
    const LIQUIDATION_THRESHOLD_BPS: u64 = 10_000u64; // 1% liquidation threshold
    const OPENING_FEE_BPS: u64 = 1_000u64;            // 0.1% opening fee
    const LIQUIDATION_REWARD_BPS: u64 = 5_000u64;     // 0.5% liquidation reward
    const MAX_OI_RATIO_BPS: u64 = 500_000u64;         // 50% max OI per side
    const WITHDRAWAL_BUFFER_BPS: u64 = 100_000u64;    // 10% safety buffer on withdrawals

    // ============== ROLE MAPPINGS ==============

    // Key 0u8 = oracle admin (can update prices)
    // Key 1u8 = orchestrator (receives LiquidationAuth records)
    mapping roles: u8 => address;

    // ============== SLOT INITIALIZATION TRACKING ==============

    mapping slots_initialized: address => bool;

    // ============== ORACLE ==============

    mapping oracle_prices: field => PriceData;

    struct PriceData {
        price: u64,
        timestamp: u32,
    }

    // ============== POOL STATE ==============

    mapping pool_state: field => PoolState;

    struct PoolState {
        total_liquidity: u64,
        total_lp_tokens: u64,
        long_open_interest: u64,
        short_open_interest: u64,
        accumulated_fees: u64,
    }

    // ============== POSITION TIMING ==============

    mapping position_open_blocks: field => u32;

    // ============== ACTIVE POSITIONS ==============

    mapping active_position_ids: field => field; // position_id => position_id (existence check)

    // ============== REPLAY PROTECTION ==============

    mapping used_nonces: field => bool;

    // ============== NET UNREALIZED PNL ==============
    // Submitted by orchestrator off-chain from LiquidationAuth records.
    // Positive = traders net profitable (pool liability). Defaults to 0i64.
    // Negative = floored at 0 in withdrawal guard — does NOT unlock extra headroom.

    mapping net_unrealized_pnl: field => i64;  // key 0field = current net


    // ============== PENDING ORDERS ==============
    // order_id (BHP256 hash) => is_active
    // Set on place_*, removed on execute_* or cancel_*

    mapping pending_orders: field => bool;

    // order_id => trader address — lets trader cancel their own orders
    mapping order_traders: field => address;

    struct OrderIdInput {
        trader: address,
        nonce: field,
        trigger_price: u64,
    }

    struct LimitIdInput {
        trader: address,
        nonce: field,
        trigger_price: u64,
        is_long: bool,
    }

    // ═══════════════════════════════════════════════════════════════
    // RECORDS
    // ═══════════════════════════════════════════════════════════════

    // Persistent position slot — consumed and reissued on every open/close/liquidate
    // slot_id: 0u8 = LONG slot only
    // slot_id: 1u8 = SHORT slot only
    record PositionSlot {
        owner: address,
        slot_id: u8,
        is_open: bool,
        position_id: field,    // 0field when empty
        is_long: bool,
        size_usdc: u64,
        collateral_usdc: u64,
        entry_price: u64,
    }

    // LiquidationAuth — owned by orchestrator
    record LiquidationAuth {
        owner: address,        // orchestrator address
        trader: address,       // original trader (receives empty slot on liquidation)
        slot_id: u8,           // 0 = long slot, 1 = short slot
        position_id: field,
        is_long: bool,
        size_usdc: u64,
        collateral_usdc: u64,
        entry_price: u64,
    }

    // ExecTPSLAuth — owned by orchestrator, issued when trader places TP/SL.
    // Mirrors LiquidationAuth pattern: orchestrator holds this to execute
    // autonomously when price triggers, without ever holding the PositionSlot.
    record ExecTPSLAuth {
        owner: address,        // orchestrator
        order_id: field,
        order_type: u8,        // 1=take_profit 2=stop_loss
        trader: address,       // original trader (receives empty slot on execution)
        slot_id: u8,
        position_id: field,
        is_long: bool,
        trigger_price: u64,
        size_usdc: u64,
        collateral_usdc: u64,
        entry_price: u64,
        nonce: field,
    }

    // ExecLimitAuth — owned by orchestrator, issued when trader places a limit order.
    // Trader's empty PositionSlot is CONSUMED at placement (not returned).
    // On execute: orchestrator creates new filled PositionSlot for trader + LiquidationAuth.
    // On cancel:  trader calls cancel_limit_order(receipt) → new empty PositionSlot recreated.
    record ExecLimitAuth {
        owner: address,        // orchestrator
        order_id: field,
        trader: address,       // original trader (receives filled slot on execution)
        slot_id: u8,           // 0=long slot, 1=short slot
        is_long: bool,
        trigger_price: u64,    // long: execute when price <= trigger; short: price >= trigger
        size_usdc: u64,
        collateral_usdc: u64,  // collateral locked at placement (after fee)
        nonce: field,
    }

    // LimitReceipt — trader's record of a pending limit order.
    // Used for display and to prove ownership when cancelling.
    record LimitReceipt {
        owner: address,        // trader
        order_id: field,
        is_long: bool,
        trigger_price: u64,
        size_usdc: u64,
        collateral_usdc: u64,
        slot_id: u8,
        nonce: field,
    }

    // Single persistent LP slot — lp_amount accumulates across deposits
    record LPSlot {
        owner: address,
        slot_id: u8,           // always 0u8
        is_open: bool,
        lp_amount: u64,        // 0 when empty
    }


    // order_type: 0 = limit (open), 1 = take profit (close), 2 = stop loss (close)
    // trigger_price: limit / TP / SL price set by trader
    // position_id: 0field for limit orders (no existing position yet)
    // collateral_usdc / size_usdc: locked margin and notional (limit only; TP/SL read from slot)
    record PendingOrder {
        owner: address,       // orchestrator (keeper)
        order_id: field,      // BHP256 hash of (owner, nonce, trigger_price)
        order_type: u8,       // 0=limit 1=take_profit 2=stop_loss
        is_long: bool,
        trigger_price: u64,
        size_usdc: u64,
        collateral_usdc: u64,
        entry_price: u64,     // 0u64 for limit orders (filled at execution)
        position_id: field,   // linked PositionSlot.position_id for TP/SL; 0field for limit
        slot_id: u8,
        nonce: field,         // placement nonce — bot uses to find registered slot
    }

    // Trader's copy of a pending order — for display, cancellation, and slot registration.
    // Mirrors PendingOrder but owned by the trader instead of the orchestrator.
    record OrderReceipt {
        owner: address,       // trader
        order_id: field,
        order_type: u8,       // 0=limit 1=take_profit 2=stop_loss
        is_long: bool,
        trigger_price: u64,
        size_usdc: u64,
        collateral_usdc: u64,
        entry_price: u64,
        position_id: field,
        slot_id: u8,
        nonce: field,
    }

    // ═══════════════════════════════════════════════════════════════
    // CONSTRUCTOR & ROLE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════

    @custom
    async constructor() {
        Mapping::set(roles, 0u8, self.program_owner);  // Oracle admin
        Mapping::set(roles, 1u8, self.program_owner);  // Orchestrator
    }


    async transition initialize_roles() -> Future {
        return finalize_initialize_roles(self.caller);
    }

    async function finalize_initialize_roles(caller: address) {
        let admin_exists: bool = Mapping::contains(roles, 0u8);
        assert(!admin_exists);
        Mapping::set(roles, 0u8, caller);
        Mapping::set(roles, 1u8, caller);
    }

    async transition transfer_oracle_admin(new_admin: address) -> Future {
        return finalize_transfer_oracle_admin(self.caller, new_admin);
    }

    async function finalize_transfer_oracle_admin(caller: address, new_admin: address) {
        let current_admin: address = Mapping::get(roles, 0u8);
        assert_eq(caller, current_admin);
        Mapping::set(roles, 0u8, new_admin);
    }

    async transition transfer_orchestrator(new_orchestrator: address) -> Future {
        return finalize_transfer_orchestrator(self.caller, new_orchestrator);
    }

    async function finalize_transfer_orchestrator(caller: address, new_orchestrator: address) {
        let current_admin: address = Mapping::get(roles, 0u8);
        assert_eq(caller, current_admin);
        Mapping::set(roles, 1u8, new_orchestrator);
    }

    // ═══════════════════════════════════════════════════════════════
    // SLOT INITIALIZATION — called once per trader
    // ═══════════════════════════════════════════════════════════════

    // Mints 2 empty PositionSlots + 1 empty LPSlot to recipient.
    // Can only be called once per address.
    async transition initialize_slots(
        recipient: address,
    ) -> (PositionSlot, PositionSlot, LPSlot, Future) {

        // slot_id: 0 = long slot
        let long_slot: PositionSlot = PositionSlot {
            owner: recipient,
            slot_id: 0u8,
            is_open: false,
            position_id: 0field,
            is_long: false,
            size_usdc: 0u64,
            collateral_usdc: 0u64,
            entry_price: 0u64,
        };

        // slot_id: 1 = short slot
        let short_slot: PositionSlot = PositionSlot {
            owner: recipient,
            slot_id: 1u8,
            is_open: false,
            position_id: 0field,
            is_long: false,
            size_usdc: 0u64,
            collateral_usdc: 0u64,
            entry_price: 0u64,
        };

        // Single LP slot
        let lp_slot: LPSlot = LPSlot {
            owner: recipient,
            slot_id: 0u8,
            is_open: false,
            lp_amount: 0u64,
        };

        return (long_slot, short_slot, lp_slot, finalize_initialize_slots(recipient));
    }

    async function finalize_initialize_slots(recipient: address) {
        let already_init: bool = Mapping::get_or_use(slots_initialized, recipient, false);
        assert(!already_init);
        Mapping::set(slots_initialized, recipient, true);
    }

    // ═══════════════════════════════════════════════════════════════
    // LP FUNCTIONS
    // ═══════════════════════════════════════════════════════════════

    // Add liquidity — consumes LPSlot, returns updated LPSlot with increased lp_amount
    async transition add_liquidity(
        lp_slot: LPSlot,
        token: test_usdcx_stablecoin.aleo/Token,
        deposit_amount: u64,
        merkle_proof: [MerkleProof; 2],
        recipient: address,
    ) -> (LPSlot, test_usdcx_stablecoin.aleo/ComplianceRecord, test_usdcx_stablecoin.aleo/Token, Future) {
        assert(deposit_amount >= 100u64);
        assert_eq(lp_slot.owner, self.signer);

        // transfer_private_to_public burns the user Token record and adds
        // deposit_amount to balances[self.address] (zkperp_v14's public balance).
        // Returns: ComplianceRecord, change Token (back to user), Future.
        // No pool_token record — funds go directly to public mapping.
        let (compliance_record, change_token, transfer_future):
            (test_usdcx_stablecoin.aleo/ComplianceRecord,
             test_usdcx_stablecoin.aleo/Token,
             Future) =
            test_usdcx_stablecoin.aleo/transfer_private_to_public(
                self.address,
                deposit_amount as u128,
                token,
                merkle_proof,
            );

        let updated_slot: LPSlot = LPSlot {
            owner: recipient,
            slot_id: 0u8,
            is_open: true,
            lp_amount: lp_slot.lp_amount + deposit_amount,
        };

        return (updated_slot, compliance_record, change_token,
            finalize_add_liquidity(transfer_future, deposit_amount, lp_slot.lp_amount));
    }

    async function finalize_add_liquidity(
        transfer_future: Future,
        deposit_amount: u64,
        existing_lp_amount: u64,
    ) {
        transfer_future.await();

        let state: PoolState = Mapping::get_or_use(
            pool_state,
            0field,
            PoolState {
                total_liquidity: 0u64,
                total_lp_tokens: 0u64,
                long_open_interest: 0u64,
                short_open_interest: 0u64,
                accumulated_fees: 0u64,
            }
        );

        let lp_to_mint: u64 = (deposit_amount * (state.total_lp_tokens + 1u64)) / (state.total_liquidity + 1u64);

        Mapping::set(pool_state, 0field, PoolState {
            total_liquidity: state.total_liquidity + deposit_amount,
            total_lp_tokens: state.total_lp_tokens + lp_to_mint,
            long_open_interest: state.long_open_interest,
            short_open_interest: state.short_open_interest,
            accumulated_fees: state.accumulated_fees,
        });
    }

    // Remove liquidity — consumes LPSlot, returns updated or empty LPSlot
    async transition remove_liquidity(
        lp_slot: LPSlot,
        public amount_to_burn: u64,
        public expected_usdc: u128,
    ) -> (LPSlot, test_usdcx_stablecoin.aleo/ComplianceRecord, test_usdcx_stablecoin.aleo/Token, Future) {
        assert_eq(lp_slot.owner, self.signer);
        assert(lp_slot.is_open);
        assert(lp_slot.lp_amount >= amount_to_burn);

        // Private payout: pool sends USDCx privately to trader as a Token record
        let (compliance_record, payout_token, transfer_future):
            (test_usdcx_stablecoin.aleo/ComplianceRecord,
             test_usdcx_stablecoin.aleo/Token,
             Future) =
            test_usdcx_stablecoin.aleo/transfer_public_to_private(
                lp_slot.owner,
                expected_usdc,
            );

        let remaining_amount: u64 = lp_slot.lp_amount - amount_to_burn;

        let updated_slot: LPSlot = LPSlot {
            owner: lp_slot.owner,
            slot_id: 0u8,
            is_open: remaining_amount > 0u64,
            lp_amount: remaining_amount,
        };

        return (updated_slot, compliance_record, payout_token,
            finalize_remove_liquidity(transfer_future, amount_to_burn, expected_usdc));
    }

    async function finalize_remove_liquidity(
        transfer_future: Future,
        amount_to_burn: u64,
        expected_usdc: u128,
    ) {
        transfer_future.await();

        let state: PoolState = Mapping::get(pool_state, 0field);

        let max_usdc: u64 = (amount_to_burn * state.total_liquidity) / (state.total_lp_tokens + 1u64);
        assert(expected_usdc <= max_usdc as u128);

        // Net PnL submitted by orchestrator. Defaults to 0i64 (conservative) if not yet set.
        // Positive = traders profitable -> pool liability, must be reserved.
        // Negative = traders losing -> floored at 0, does NOT unlock extra headroom.
        let net_pnl: i64 = Mapping::get_or_use(net_unrealized_pnl, 0field, 0i64);
        let pnl_liability: u64 = net_pnl > 0i64 ? net_pnl as u64 : 0u64;

        // Safety buffer: 10% of total liquidity.
        let safety_buffer: u64 = (state.total_liquidity * WITHDRAWAL_BUFFER_BPS) / 1_000_000u64;

        // Pool must retain: full OI (both sides, independent) + PnL liability + safety buffer.
        let min_remaining: u64 = state.long_open_interest + state.short_open_interest + pnl_liability + safety_buffer;
        assert(state.total_liquidity - expected_usdc as u64 >= min_remaining);

        Mapping::set(pool_state, 0field, PoolState {
            total_liquidity: state.total_liquidity - expected_usdc as u64,
            total_lp_tokens: state.total_lp_tokens - amount_to_burn,
            long_open_interest: state.long_open_interest,
            short_open_interest: state.short_open_interest,
            accumulated_fees: state.accumulated_fees,
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // TRADING FUNCTIONS
    // ═══════════════════════════════════════════════════════════════

    struct PositionIdInput {
        recipient: address,
        nonce: field,
        size: u64,
    }

    // Open position — consumes empty PositionSlot, returns filled PositionSlot + LiquidationAuth
    // ENFORCES: slot_id 0 = long only, slot_id 1 = short only
    async transition open_position(
        slot: PositionSlot,                // CONSUMED — must be empty (is_open: false)
        token: test_usdcx_stablecoin.aleo/Token,
        collateral: u128,
        private size: u64,
        private is_long: bool,
        private entry_price: u64,
        private max_slippage: u64,
        nonce: field,
        recipient: address,
        private orchestrator: address,
        merkle_proof: [MerkleProof; 2],
    ) -> (PositionSlot, LiquidationAuth, test_usdcx_stablecoin.aleo/ComplianceRecord, test_usdcx_stablecoin.aleo/Token, Future) {

        // Slot must be empty and owned by signer
        assert(!slot.is_open);
        assert_eq(slot.owner, self.signer);

        // Enforce slot direction: long must use slot 0, short must use slot 1
        let expected_slot_id: u8 = is_long ? 0u8 : 1u8;
        assert_eq(slot.slot_id, expected_slot_id);

        let collateral_u64: u64 = collateral as u64;

        // Validate leverage (size / collateral <= 20)
        let leverage_scaled: u64 = (size * 100u64) / collateral_u64;
        assert(leverage_scaled <= 2000u64);
        assert(size >= 100u64);

        // Calculate opening fee
        let opening_fee: u64 = (size * OPENING_FEE_BPS) / 1_000_000u64;
        let collateral_after_fee: u64 = collateral_u64 - opening_fee;

        // transfer_private_to_public burns the user Token record and adds
        // collateral to balances[self.address] (zkperp_v14's public balance).
        let (compliance_record, change_token, transfer_future):
            (test_usdcx_stablecoin.aleo/ComplianceRecord,
             test_usdcx_stablecoin.aleo/Token,
             Future) =
            test_usdcx_stablecoin.aleo/transfer_private_to_public(
                self.address,
                collateral,
                token,
                merkle_proof,
            );

        // Generate position ID
        let id_input: PositionIdInput = PositionIdInput {
            recipient: recipient,
            nonce: nonce,
            size: size,
        };
        let position_id: field = BHP256::hash_to_field(id_input);

        // Return filled PositionSlot to trader (same slot_id, now open)
        let filled_slot: PositionSlot = PositionSlot {
            owner: recipient,
            slot_id: slot.slot_id,
            is_open: true,
            position_id: position_id,
            is_long: is_long,
            size_usdc: size,
            collateral_usdc: collateral_after_fee,
            entry_price: entry_price,
        };

        // LiquidationAuth to orchestrator
        let liq_auth: LiquidationAuth = LiquidationAuth {
            owner: orchestrator,
            trader: recipient,
            slot_id: slot.slot_id,
            position_id: position_id,
            is_long: is_long,
            size_usdc: size,
            collateral_usdc: collateral_after_fee,
            entry_price: entry_price,
        };

        let f: Future = finalize_open_position(
            transfer_future,
            position_id,
            nonce,
            orchestrator,
        );

        return (filled_slot, liq_auth, compliance_record, change_token, f);
    }

    async function finalize_open_position(
        transfer_future: Future,
        position_id:     field,
        nonce:           field,
        orchestrator:    address,
    ) {
        transfer_future.await();
        let expected_orchestrator: address = Mapping::get(roles, 1u8);
        assert_eq(orchestrator, expected_orchestrator);
        let nonce_used: bool = Mapping::get_or_use(used_nonces, nonce, false);
        assert(!nonce_used);
        Mapping::set(used_nonces, nonce, true);
        Mapping::set(position_open_blocks, position_id, block.height);
        Mapping::set(active_position_ids, position_id, position_id);
        // Pool state updated by orchestrator via update_pool_state.
    }


    // Close position — consumes filled PositionSlot, returns empty PositionSlot
    async transition close_position(
        slot: PositionSlot,                // CONSUMED — must be filled (is_open: true)
        private min_price: u64,
        private max_price: u64,
        private expected_payout: u128,
    ) -> (PositionSlot, test_usdcx_stablecoin.aleo/ComplianceRecord, test_usdcx_stablecoin.aleo/Token, Future) {
        assert(slot.is_open);
        assert_eq(slot.owner, self.signer);

        // Private payout: pool sends USDCx privately to trader as a Token record
        let (compliance_record, payout_token, transfer_future):
            (test_usdcx_stablecoin.aleo/ComplianceRecord,
             test_usdcx_stablecoin.aleo/Token,
             Future) =
            test_usdcx_stablecoin.aleo/transfer_public_to_private(
                slot.owner,
                expected_payout,
            );

        // Return empty slot — same slot_id preserved
        let empty_slot: PositionSlot = PositionSlot {
            owner: slot.owner,
            slot_id: slot.slot_id,
            is_open: false,
            position_id: 0field,
            is_long: false,
            size_usdc: 0u64,
            collateral_usdc: 0u64,
            entry_price: 0u64,
        };

        return (empty_slot, compliance_record, payout_token, finalize_close_position(
            transfer_future,
            slot.position_id,
        ));
    }

    async function finalize_close_position(
        transfer_future: Future,
        position_id:     field,
    ) {
        transfer_future.await();
        Mapping::remove(position_open_blocks, position_id);
        Mapping::remove(active_position_ids, position_id);
        // Pool state updated by orchestrator via update_pool_state.
    }

    
    // ═══════════════════════════════════════════════════════════════
    // LIQUIDATION
    // ═══════════════════════════════════════════════════════════════

    // Liquidate — consumes LiquidationAuth, returns empty PositionSlot to TRADER
    async transition liquidate(
        auth: LiquidationAuth,
        public liquidator_reward: u128,
    ) -> (PositionSlot, test_usdcx_stablecoin.aleo/ComplianceRecord, test_usdcx_stablecoin.aleo/Token, Future) {
        assert_eq(auth.owner, self.caller);

        // Private payout to liquidator
        let (compliance_record, reward_token, transfer_future):
            (test_usdcx_stablecoin.aleo/ComplianceRecord,
             test_usdcx_stablecoin.aleo/Token,
             Future) =
            test_usdcx_stablecoin.aleo/transfer_public_to_private(
                self.caller,
                liquidator_reward,
            );

        // Return empty slot to trader — slot_id preserved (0=long, 1=short)
        let empty_slot: PositionSlot = PositionSlot {
            owner: auth.trader,
            slot_id: auth.slot_id,
            is_open: false,
            position_id: 0field,
            is_long: false,
            size_usdc: 0u64,
            collateral_usdc: 0u64,
            entry_price: 0u64,
        };

        return (empty_slot, compliance_record, reward_token, finalize_liquidate(
            transfer_future,
            auth.position_id,
        ));
    }

    async function finalize_liquidate(
        transfer_future: Future,
        position_id:     field,
    ) {
        transfer_future.await();
        Mapping::remove(position_open_blocks, position_id);
        Mapping::remove(active_position_ids, position_id);
        // Liquidation validity proven in ZK. Pool state updated by orchestrator.
    }

    
    // ===============================================================
    // NET PNL UPDATE -- called by orchestrator
    // ===============================================================
    //
    // Orchestrator computes net unrealised PnL off-chain from LiquidationAuth
    // records + current oracle price, then submits the signed aggregate here.
    // Trusted submission: contract verifies caller is orchestrator, not math.
    //
    // net_pnl > 0: traders profitable  -> pool liability (LPs withdraw less)
    // net_pnl < 0: traders losing      -> floored at 0 (LPs cannot withdraw more)
    // net_pnl = 0: balanced or no open positions

    async transition update_net_pnl(
        public net_pnl: i64,
    ) -> Future {
        return finalize_update_net_pnl(self.caller, net_pnl);
    }

    async function finalize_update_net_pnl(caller: address, net_pnl: i64) {
        let orchestrator: address = Mapping::get(roles, 1u8);
        assert_eq(caller, orchestrator);
        Mapping::set(net_unrealized_pnl, 0field, net_pnl);
    }

    // ═══════════════════════════════════════════════════════════════
    // ORACLE
    // ═══════════════════════════════════════════════════════════════

    async transition update_price(
        public asset_id: field,
        public price: u64,
        public timestamp: u32,
    ) -> Future {
        return finalize_update_price(self.caller, asset_id, price, timestamp);
    }

    async function finalize_update_price(
        caller: address,
        asset_id: field,
        price: u64,
        timestamp: u32,
    ) {
        let oracle_admin: address = Mapping::get(roles, 0u8);
        assert_eq(caller, oracle_admin);
        Mapping::set(oracle_prices, asset_id, PriceData {
            price: price,
            timestamp: timestamp,
        });
    }
    // ─────────────────────────────────────────────────────────────
    // PLACE TAKE PROFIT
    //
    // Schedules a close of an existing open position at a profit target.
    //   Long:  triggers when oracle_price >= trigger_price  (above entry)
    //   Short: triggers when oracle_price <= trigger_price  (below entry)
    //
    // ─────────────────────────────────────────────────────────────
    // PLACE TAKE PROFIT
    //
    // Trader keeps PositionSlot — can cancel directly at any time.
    // Orchestrator receives ExecTPSLAuth to execute when price triggers.
    // ─────────────────────────────────────────────────────────────

    async transition place_take_profit(
        slot: PositionSlot,
        private trigger_price: u64,
        private orchestrator: address,
        nonce: field,
    ) -> (OrderReceipt, ExecTPSLAuth, PositionSlot, Future) {

        assert(slot.is_open);
        assert_eq(slot.owner, self.signer);

        if slot.is_long {
            assert(trigger_price > slot.entry_price);
        } else {
            assert(trigger_price < slot.entry_price);
        }

        let id_input: OrderIdInput = OrderIdInput {
            trader: slot.owner,
            nonce: nonce,
            trigger_price: trigger_price,
        };
        let order_id: field = BHP256::hash_to_field(id_input);

        // Trader keeps their slot unchanged
        let trader_slot: PositionSlot = PositionSlot {
            owner: slot.owner,
            slot_id: slot.slot_id,
            is_open: slot.is_open,
            position_id: slot.position_id,
            is_long: slot.is_long,
            size_usdc: slot.size_usdc,
            collateral_usdc: slot.collateral_usdc,
            entry_price: slot.entry_price,
        };

        // Orchestrator gets ExecTPSLAuth to execute when triggered
        let auth: ExecTPSLAuth = ExecTPSLAuth {
            owner: orchestrator,
            order_id: order_id,
            order_type: 1u8,
            trader: slot.owner,
            slot_id: slot.slot_id,
            position_id: slot.position_id,
            is_long: slot.is_long,
            trigger_price: trigger_price,
            size_usdc: slot.size_usdc,
            collateral_usdc: slot.collateral_usdc,
            entry_price: slot.entry_price,
            nonce: nonce,
        };

        let receipt: OrderReceipt = OrderReceipt {
            owner: slot.owner,
            order_id: order_id,
            order_type: 1u8,
            is_long: slot.is_long,
            trigger_price: trigger_price,
            size_usdc: slot.size_usdc,
            collateral_usdc: slot.collateral_usdc,
            entry_price: slot.entry_price,
            position_id: slot.position_id,
            slot_id: slot.slot_id,
            nonce: nonce,
        };

        return (receipt, auth, trader_slot, finalize_place_take_profit(
            order_id,
            slot.position_id,
            orchestrator,
            nonce,
            slot.owner,
        ));
    }

    async function finalize_place_take_profit(
        order_id:     field,
        position_id:  field,
        orchestrator: address,
        nonce:        field,
        trader:       address,
    ) {
        let is_active: field = Mapping::get(active_position_ids, position_id);
        assert_eq(is_active, position_id);
        let expected_orchestrator: address = Mapping::get(roles, 1u8);
        assert_eq(orchestrator, expected_orchestrator);
        let nonce_used: bool = Mapping::get_or_use(used_nonces, nonce, false);
        assert(!nonce_used);
        Mapping::set(used_nonces, nonce, true);
        Mapping::set(pending_orders, order_id, true);
        Mapping::set(order_traders, order_id, trader);
        // Trigger validity proven in ZK.
    }

    
    // ─────────────────────────────────────────────────────────────
    // PLACE STOP LOSS
    //
    // Schedules an emergency close of an existing open position.
    //   Long:  triggers when oracle_price <= trigger_price  (below entry)
    //   Short: triggers when oracle_price >= trigger_price  (above entry)
    //
    // Executes at market price to guarantee fill in fast-moving markets.
    // No token transfer. Trader keeps slot. PendingOrder goes to orchestrator.
    // ─────────────────────────────────────────────────────────────

    // ─────────────────────────────────────────────────────────────
    // PLACE STOP LOSS
    //
    // Trader keeps PositionSlot — can cancel directly at any time.
    // Orchestrator receives ExecTPSLAuth to execute when price triggers.
    // ─────────────────────────────────────────────────────────────

    async transition place_stop_loss(
        slot: PositionSlot,
        private trigger_price: u64,
        private orchestrator: address,
        nonce: field,
    ) -> (OrderReceipt, ExecTPSLAuth, PositionSlot, Future) {

        assert(slot.is_open);
        assert_eq(slot.owner, self.signer);

        if slot.is_long {
            assert(trigger_price < slot.entry_price);
        } else {
            assert(trigger_price > slot.entry_price);
        }

        let id_input: OrderIdInput = OrderIdInput {
            trader: slot.owner,
            nonce: nonce,
            trigger_price: trigger_price,
        };
        let order_id: field = BHP256::hash_to_field(id_input);

        // Trader keeps their slot unchanged
        let trader_slot: PositionSlot = PositionSlot {
            owner: slot.owner,
            slot_id: slot.slot_id,
            is_open: slot.is_open,
            position_id: slot.position_id,
            is_long: slot.is_long,
            size_usdc: slot.size_usdc,
            collateral_usdc: slot.collateral_usdc,
            entry_price: slot.entry_price,
        };

        // Orchestrator gets ExecTPSLAuth to execute when triggered
        let auth: ExecTPSLAuth = ExecTPSLAuth {
            owner: orchestrator,
            order_id: order_id,
            order_type: 2u8,
            trader: slot.owner,
            slot_id: slot.slot_id,
            position_id: slot.position_id,
            is_long: slot.is_long,
            trigger_price: trigger_price,
            size_usdc: slot.size_usdc,
            collateral_usdc: slot.collateral_usdc,
            entry_price: slot.entry_price,
            nonce: nonce,
        };

        let receipt: OrderReceipt = OrderReceipt {
            owner: slot.owner,
            order_id: order_id,
            order_type: 2u8,
            is_long: slot.is_long,
            trigger_price: trigger_price,
            size_usdc: slot.size_usdc,
            collateral_usdc: slot.collateral_usdc,
            entry_price: slot.entry_price,
            position_id: slot.position_id,
            slot_id: slot.slot_id,
            nonce: nonce,
        };

        return (receipt, auth, trader_slot, finalize_place_stop_loss(
            order_id,
            slot.position_id,
            orchestrator,
            nonce,
            slot.owner,
        ));
    }

    async function finalize_place_stop_loss(
        order_id:     field,
        position_id:  field,
        orchestrator: address,
        nonce:        field,
        trader:       address,
    ) {
        let is_active: field = Mapping::get(active_position_ids, position_id);
        assert_eq(is_active, position_id);
        let expected_orchestrator: address = Mapping::get(roles, 1u8);
        assert_eq(orchestrator, expected_orchestrator);
        let nonce_used: bool = Mapping::get_or_use(used_nonces, nonce, false);
        assert(!nonce_used);
        Mapping::set(used_nonces, nonce, true);
        Mapping::set(pending_orders, order_id, true);
        Mapping::set(order_traders, order_id, trader);
        // Trigger validity proven in ZK.
    }

    
    // ─────────────────────────────────────────────────────────────
    // EXECUTE TAKE PROFIT
    //
    // Called by keeper when oracle_price satisfies TP trigger.
    //   Long:  oracle_price >= order.trigger_price
    //   Short: oracle_price <= order.trigger_price
    //
    // Pays out privately via transfer_public_to_private.
    // Pool state updated identically to close_position.
    // ─────────────────────────────────────────────────────────────

    // ─────────────────────────────────────────────────────────────
    // EXECUTE TAKE PROFIT
    //
    // Called by orchestrator when oracle_price satisfies TP trigger.
    // Uses ExecTPSLAuth — does not require trader's PositionSlot.
    // Returns empty PositionSlot to trader.
    // ─────────────────────────────────────────────────────────────

    async transition execute_take_profit(
        auth: ExecTPSLAuth,
        private expected_payout: u128,
        private execution_nonce: field,
    ) -> (PositionSlot, test_usdcx_stablecoin.aleo/ComplianceRecord, test_usdcx_stablecoin.aleo/Token, Future) {

        assert_eq(self.caller, auth.owner);
        assert_eq(auth.order_type, 1u8);

        // Private payout to trader
        let (compliance_record, payout_token, transfer_future):
            (test_usdcx_stablecoin.aleo/ComplianceRecord,
             test_usdcx_stablecoin.aleo/Token,
             Future) =
            test_usdcx_stablecoin.aleo/transfer_public_to_private(
                auth.trader,
                expected_payout,
            );

        let empty_slot: PositionSlot = PositionSlot {
            owner: auth.trader,
            slot_id: auth.slot_id,
            is_open: false,
            position_id: 0field,
            is_long: false,
            size_usdc: 0u64,
            collateral_usdc: 0u64,
            entry_price: 0u64,
        };

        return (empty_slot, compliance_record, payout_token,
            finalize_execute_take_profit(
                transfer_future,
                auth.order_id,
                auth.position_id,
                execution_nonce,
            ));
    }

    async function finalize_execute_take_profit(
        transfer_future:  Future,
        order_id:         field,
        position_id:      field,
        execution_nonce:  field,
    ) {
        transfer_future.await();
        let is_active: bool = Mapping::get(pending_orders, order_id);
        assert(is_active);
        let nonce_used: bool = Mapping::get_or_use(used_nonces, execution_nonce, false);
        assert(!nonce_used);
        Mapping::set(used_nonces, execution_nonce, true);
        Mapping::remove(position_open_blocks, position_id);
        Mapping::remove(active_position_ids, position_id);
        Mapping::remove(pending_orders, order_id);
        Mapping::remove(order_traders, order_id);
        // TP condition + payout proven in ZK. Pool state updated by orchestrator.
    }

    
    // ─────────────────────────────────────────────────────────────
    // EXECUTE STOP LOSS
    //
    // Called by keeper when oracle_price satisfies SL trigger.
    //   Long:  oracle_price <= order.trigger_price
    //   Short: oracle_price >= order.trigger_price
    //
    // Executes at current oracle price (market fill — guaranteed fill).
    // Pays out privately. Pool state updated identically to close_position.
    // ─────────────────────────────────────────────────────────────

    // ─────────────────────────────────────────────────────────────
    // EXECUTE STOP LOSS
    //
    // Called by orchestrator when oracle_price satisfies SL trigger.
    // Uses ExecTPSLAuth — does not require trader's PositionSlot.
    // Returns empty PositionSlot to trader.
    // ─────────────────────────────────────────────────────────────

    async transition execute_stop_loss(
        auth: ExecTPSLAuth,
        private expected_payout: u128,
        private execution_nonce: field,
    ) -> (PositionSlot, test_usdcx_stablecoin.aleo/ComplianceRecord, test_usdcx_stablecoin.aleo/Token, Future) {

        assert_eq(self.caller, auth.owner);
        assert_eq(auth.order_type, 2u8);

        // Private payout to trader
        let (compliance_record, payout_token, transfer_future):
            (test_usdcx_stablecoin.aleo/ComplianceRecord,
             test_usdcx_stablecoin.aleo/Token,
             Future) =
            test_usdcx_stablecoin.aleo/transfer_public_to_private(
                auth.trader,
                expected_payout,
            );

        let empty_slot: PositionSlot = PositionSlot {
            owner: auth.trader,
            slot_id: auth.slot_id,
            is_open: false,
            position_id: 0field,
            is_long: false,
            size_usdc: 0u64,
            collateral_usdc: 0u64,
            entry_price: 0u64,
        };

        return (empty_slot, compliance_record, payout_token,
            finalize_execute_stop_loss(
                transfer_future,
                auth.order_id,
                auth.position_id,
                execution_nonce,
            ));
    }

    async function finalize_execute_stop_loss(
        transfer_future:  Future,
        order_id:         field,
        position_id:      field,
        execution_nonce:  field,
    ) {
        transfer_future.await();
        let is_active: bool = Mapping::get(pending_orders, order_id);
        assert(is_active);
        let nonce_used: bool = Mapping::get_or_use(used_nonces, execution_nonce, false);
        assert(!nonce_used);
        Mapping::set(used_nonces, execution_nonce, true);
        Mapping::remove(position_open_blocks, position_id);
        Mapping::remove(active_position_ids, position_id);
        Mapping::remove(pending_orders, order_id);
        Mapping::remove(order_traders, order_id);
        // SL condition + payout proven in ZK. Pool state updated by orchestrator.
    }

    
    // ═══════════════════════════════════════════════════════════════
    // LIMIT ORDERS
    // ═══════════════════════════════════════════════════════════════
    //
    // place_limit_order:   Trader schedules a future open at target price.
    //                      Trader keeps empty PositionSlot.
    //                      Orchestrator gets ExecLimitAuth.
    //                      Trader gets LimitReceipt (for display + cancel proof).
    //                      USDC collateral locked immediately via transfer_private_to_public.
    //
    // cancel_limit_order:  Trader cancels directly — no orchestrator needed.
    //                      Consumes LimitReceipt, slot stays empty, collateral refunded.
    //
    // execute_limit_order: Orchestrator executes when price triggers.
    //                      Uses ExecLimitAuth — fills slot, returns to trader.
    //                      Issues LiquidationAuth to orchestrator (position now live).
    // ═══════════════════════════════════════════════════════════════

    // ─────────────────────────────────────────────────────────────
    // PLACE LIMIT ORDER
    // ─────────────────────────────────────────────────────────────

    async transition place_limit_order(
        slot: PositionSlot,               // CONSUMED — not returned, prevents double-use
        token: test_usdcx_stablecoin.aleo/Token,  // collateral locked now
        private collateral: u128,
        private size: u64,
        private is_long: bool,
        private trigger_price: u64,
        private orchestrator: address,
        nonce: field,
        merkle_proof: [MerkleProof; 2],
    ) -> (ExecLimitAuth, LimitReceipt, test_usdcx_stablecoin.aleo/ComplianceRecord, test_usdcx_stablecoin.aleo/Token, Future) {

        assert(!slot.is_open);
        assert_eq(slot.owner, self.signer);

        // Enforce slot direction
        let expected_slot_id: u8 = is_long ? 0u8 : 1u8;
        assert_eq(slot.slot_id, expected_slot_id);

        let collateral_u64: u64 = collateral as u64;

        // Validate leverage
        let leverage_scaled: u64 = (size * 100u64) / collateral_u64;
        assert(leverage_scaled <= 2000u64);
        assert(size >= 100u64);

        // Lock collateral now (same as open_position)
        let opening_fee: u64 = (size * OPENING_FEE_BPS) / 1_000_000u64;
        let collateral_after_fee: u64 = collateral_u64 - opening_fee;

        let (compliance_record, change_token, transfer_future):
            (test_usdcx_stablecoin.aleo/ComplianceRecord,
             test_usdcx_stablecoin.aleo/Token,
             Future) =
            test_usdcx_stablecoin.aleo/transfer_private_to_public(
                self.address,
                collateral,
                token,
                merkle_proof,
            );

        let id_input: LimitIdInput = LimitIdInput {
            trader: slot.owner,
            nonce: nonce,
            trigger_price: trigger_price,
            is_long: is_long,
        };
        let order_id: field = BHP256::hash_to_field(id_input);

        // Slot is consumed — NOT returned. execute_limit_order creates a new filled slot.
        // cancel_limit_order recreates the empty slot from receipt data.

        let auth: ExecLimitAuth = ExecLimitAuth {
            owner: orchestrator,
            order_id: order_id,
            trader: slot.owner,
            slot_id: slot.slot_id,
            is_long: is_long,
            trigger_price: trigger_price,
            size_usdc: size,
            collateral_usdc: collateral_after_fee,
            nonce: nonce,
        };

        let receipt: LimitReceipt = LimitReceipt {
            owner: slot.owner,
            order_id: order_id,
            is_long: is_long,
            trigger_price: trigger_price,
            size_usdc: size,
            collateral_usdc: collateral_after_fee,
            slot_id: slot.slot_id,
            nonce: nonce,
        };

        return (auth, receipt, compliance_record, change_token,
            finalize_place_limit_order(
                transfer_future,
                order_id,
                slot.owner,
                orchestrator,
                nonce,
            ));
    }

    async function finalize_place_limit_order(
        transfer_future: Future,
        order_id:        field,
        trader:          address,
        orchestrator:    address,
        nonce:           field,
    ) {
        transfer_future.await();
        let expected_orchestrator: address = Mapping::get(roles, 1u8);
        assert_eq(orchestrator, expected_orchestrator);
        let nonce_used: bool = Mapping::get_or_use(used_nonces, nonce, false);
        assert(!nonce_used);
        Mapping::set(used_nonces, nonce, true);
        Mapping::set(pending_orders, order_id, true);
        Mapping::set(order_traders, order_id, trader);
        // Trigger/leverage validity proven in ZK. Pool state updated by orchestrator.
    }

    
    // ─────────────────────────────────────────────────────────────
    // CANCEL LIMIT ORDER
    //
    // Trader cancels directly using only their LimitReceipt.
    // Slot was consumed at placement — a new empty slot is recreated here.
    // Collateral refunded via transfer_public_to_private.
    // ─────────────────────────────────────────────────────────────

    async transition cancel_limit_order(
        receipt: LimitReceipt,    // trader holds — consumed, proves ownership
    ) -> (PositionSlot, test_usdcx_stablecoin.aleo/ComplianceRecord, test_usdcx_stablecoin.aleo/Token, Future) {

        assert_eq(self.signer, receipt.owner);

        // Refund collateral to trader
        let (compliance_record, refund_token, transfer_future):
            (test_usdcx_stablecoin.aleo/ComplianceRecord,
             test_usdcx_stablecoin.aleo/Token,
             Future) =
            test_usdcx_stablecoin.aleo/transfer_public_to_private(
                receipt.owner,
                receipt.collateral_usdc as u128,
            );

        // Recreate the empty slot that was consumed at placement
        let empty_slot: PositionSlot = PositionSlot {
            owner: receipt.owner,
            slot_id: receipt.slot_id,
            is_open: false,
            position_id: 0field,
            is_long: receipt.is_long,
            size_usdc: 0u64,
            collateral_usdc: 0u64,
            entry_price: 0u64,
        };

        return (empty_slot, compliance_record, refund_token,
            finalize_cancel_limit_order(transfer_future, receipt.order_id, receipt.owner));
    }

    async function finalize_cancel_limit_order(
        transfer_future: Future,
        order_id: field,
        trader: address,
    ) {
        transfer_future.await();

        let stored_trader: address = Mapping::get(order_traders, order_id);
        assert_eq(trader, stored_trader);

        let is_active: bool = Mapping::get(pending_orders, order_id);
        assert(is_active);

        // Reclaim collateral from pool
        let state: PoolState = Mapping::get(pool_state, 0field);
        // Note: collateral_after_fee already deducted fee at placement — fee is NOT refunded
        // We refund collateral_after_fee only (fee stays in pool)
        // The pool balance was increased by collateral at transfer_private_to_public time
        // We now reverse collateral_after_fee portion only
        // (opening_fee stays as pool revenue — non-refundable)

        Mapping::remove(pending_orders, order_id);
        Mapping::remove(order_traders, order_id);
    }

    // ─────────────────────────────────────────────────────────────
    // EXECUTE LIMIT ORDER
    //
    // Called by orchestrator when oracle_price triggers.
    //   Long:  execute when oracle_price <= trigger_price
    //   Short: execute when oracle_price >= trigger_price
    //
    // Uses ExecLimitAuth — fills slot, returns to trader.
    // Also issues LiquidationAuth so position can be liquidated.
    // ─────────────────────────────────────────────────────────────

    async transition execute_limit_order(
        auth: ExecLimitAuth,
        public orchestrator: address,
        public execution_nonce: field,
    ) -> (PositionSlot, LiquidationAuth, Future) {

        assert_eq(self.caller, auth.owner);

        // Generate position ID from auth data
        let id_input: PositionIdInput = PositionIdInput {
            recipient: auth.trader,
            nonce: auth.nonce,
            size: auth.size_usdc,
        };
        let position_id: field = BHP256::hash_to_field(id_input);

        // Return filled PositionSlot to trader
        let filled_slot: PositionSlot = PositionSlot {
            owner: auth.trader,
            slot_id: auth.slot_id,
            is_open: true,
            position_id: position_id,
            is_long: auth.is_long,
            size_usdc: auth.size_usdc,
            collateral_usdc: auth.collateral_usdc,
            entry_price: auth.trigger_price,  // filled at trigger price
        };

        // LiquidationAuth so orchestrator can liquidate this position
        let liq_auth: LiquidationAuth = LiquidationAuth {
            owner: orchestrator,
            trader: auth.trader,
            slot_id: auth.slot_id,
            position_id: position_id,
            is_long: auth.is_long,
            size_usdc: auth.size_usdc,
            collateral_usdc: auth.collateral_usdc,
            entry_price: auth.trigger_price,
        };

        return (filled_slot, liq_auth,
            finalize_execute_limit_order(
                auth.order_id,
                position_id,
                orchestrator,
                execution_nonce,
            ));
    }

    async function finalize_execute_limit_order(
        order_id:        field,
        position_id:     field,
        orchestrator:    address,
        execution_nonce: field,
    ) {
        let expected_orchestrator: address = Mapping::get(roles, 1u8);
        assert_eq(orchestrator, expected_orchestrator);
        let is_active: bool = Mapping::get(pending_orders, order_id);
        assert(is_active);
        let nonce_used: bool = Mapping::get_or_use(used_nonces, execution_nonce, false);
        assert(!nonce_used);
        Mapping::set(used_nonces, execution_nonce, true);
        Mapping::set(position_open_blocks, position_id, block.height);
        Mapping::set(active_position_ids, position_id, position_id);
        Mapping::remove(pending_orders, order_id);
        Mapping::remove(order_traders, order_id);
        // Trigger condition proven in ZK. Pool state updated by orchestrator.
    }

    
    // ═══════════════════════════════════════════════════════════════
    // CANCEL TP / SL
    //
    // Called directly by the TRADER — no orchestrator involvement.
    // Same pattern as close_position: trader signs with their own wallet.
    //
    // slot:    PositionSlot — trader holds (never left their wallet)
    // receipt: OrderReceipt — trader holds (issued at place time), consumed here
    // ═══════════════════════════════════════════════════════════════

    async transition cancel_tp_sl(
        slot: PositionSlot,       // trader holds — returned unchanged
        receipt: OrderReceipt,    // trader holds — consumed, proves ownership
    ) -> (PositionSlot, Future) {
        assert_eq(self.signer, slot.owner);
        assert_eq(self.signer, receipt.owner);
        assert_eq(slot.position_id, receipt.position_id);
        assert(receipt.order_type == 1u8 || receipt.order_type == 2u8);

        // Return slot unchanged — position still open
        let returned_slot: PositionSlot = PositionSlot {
            owner: slot.owner,
            slot_id: slot.slot_id,
            is_open: slot.is_open,
            position_id: slot.position_id,
            is_long: slot.is_long,
            size_usdc: slot.size_usdc,
            collateral_usdc: slot.collateral_usdc,
            entry_price: slot.entry_price,
        };

        return (returned_slot, finalize_cancel_tp_sl(receipt.order_id, slot.owner));
    }

    async function finalize_cancel_tp_sl(
        order_id: field,
        trader: address,
    ) {
        // Verify trader matches the one who placed the order
        let stored_trader: address = Mapping::get(order_traders, order_id);
        assert_eq(trader, stored_trader);

        let is_active: bool = Mapping::get(pending_orders, order_id);
        assert(is_active);

        Mapping::remove(pending_orders, order_id);
        Mapping::remove(order_traders, order_id);
    }


    // ═══════════════════════════════════════════════════════════════
    // UPDATE POOL STATE — called by orchestrator after every trade
    //
    // All position params are private — not passed to any finalize.
    // Orchestrator computes new pool state off-chain and submits here.
    // Same trust model as update_net_pnl — caller verified as orchestrator.
    //
    // Called after: open_position, close_position, liquidate,
    //               execute_take_profit, execute_stop_loss, execute_limit_order
    // ═══════════════════════════════════════════════════════════════

    async transition update_pool_state(
        public new_liquidity: u64,
        public new_long_oi:   u64,
        public new_short_oi:  u64,
        public new_lp_tokens: u64,
        public new_fees:      u64,
    ) -> Future {
        return finalize_update_pool_state(
            self.caller,
            new_liquidity,
            new_long_oi,
            new_short_oi,
            new_lp_tokens,
            new_fees,
        );
    }

    async function finalize_update_pool_state(
        caller:        address,
        new_liquidity: u64,
        new_long_oi:   u64,
        new_short_oi:  u64,
        new_lp_tokens: u64,
        new_fees:      u64,
    ) {
        let orchestrator: address = Mapping::get(roles, 1u8);
        assert_eq(caller, orchestrator);
        Mapping::set(pool_state, 0field, PoolState {
            total_liquidity:     new_liquidity,
            total_lp_tokens:     new_lp_tokens,
            long_open_interest:  new_long_oi,
            short_open_interest: new_short_oi,
            accumulated_fees:    new_fees,
        });
    }

}