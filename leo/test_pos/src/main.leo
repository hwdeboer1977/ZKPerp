// test_pos.aleo — local devnet mirror of zkperp_v9.aleo
//
// TOKEN NOTE:
//   test_usdcx_stablecoin.aleo is Circle-deployed on Aleo testnet/mainnet only.
//   On local devnet we use mock_usdc_0128.aleo instead — same interface
//   (mint_public / transfer_from_public / transfer_public), different program ID.
//   All logic is identical to zkperp_v9 — only the import and token calls differ.
//
// DEVNET TEST SEQUENCE:
//   Step 1.  Deploy (deploys mock_usdc dependency automatically)
//   Step 2.  mock_usdc_0128/initialize_admin
//   Step 3.  mock_usdc_0128/mint_public <TRADER> <AMOUNT>u128
//   Step 4.  seed_roles <ORACLE_ADMIN> <ORCHESTRATOR>
//   Step 5.  seed_oracle 0field <PRICE>u64 <TIMESTAMP>u32
//   Step 6.  initialize_slots <TRADER>
//            → outputs: long_slot (slot_id:0), short_slot (slot_id:1), lp_slot
//   Step 7.  add_liquidity <lp_slot> <AMOUNT>u128 <TRADER>
//            → updated LPSlot (lp_amount > 0, is_open: true)
//   Step 8.  open_position <long_slot> ... is_long:true
//            → filled PositionSlot + LiquidationAuth
//   Step 9.  remove_liquidity <filled_lp_slot> <amount_to_burn>u64 <expected_usdc>u128
//            → empty/reduced LPSlot + USDC back to trader
//   Step 10. close_position <filled_slot> <min_price>u64 <max_price>u64 <expected_payout>u128
//            → empty PositionSlot + payout to trader

import mock_usdc_0128.aleo;

program test_pos.aleo {

    // ─────────────────────────────────────────────────────────────
    // CONSTANTS — mirrors zkperp_v9 exactly
    // ─────────────────────────────────────────────────────────────

    const OPENING_FEE_BPS: u64          = 1_000u64;    // 0.1%
    const MAX_OI_RATIO_BPS: u64         = 500_000u64;  // 50%
    const LIQUIDATION_THRESHOLD_BPS: u64 = 10_000u64;  // 1%
    const LIQUIDATION_REWARD_BPS: u64   = 5_000u64;    // 0.5%

    // ─────────────────────────────────────────────────────────────
    // MAPPINGS
    // ─────────────────────────────────────────────────────────────

    // Key 0u8 = oracle admin, Key 1u8 = orchestrator
    mapping roles: u8 => address;

    // One-time slot init guard
    mapping slots_initialized: address => bool;

    // Oracle price feed
    mapping oracle_prices: field => PriceData;

    // Pool state
    mapping pool_state: field => PoolState;

    // Position open block (for borrow fee calculation)
    mapping position_open_blocks: field => u32;

    // Active position index (set on open, removed on close/liquidate — enables bot cross-check)
    mapping active_position_ids: field => field;

    // Replay protection
    mapping used_nonces: field => bool;

    // Liquidation debug (mirrors v9 — useful for diagnosing liquidation rejections)
    mapping debug_liquidation: u8 => i64;

    // ─────────────────────────────────────────────────────────────
    // STRUCTS
    // ─────────────────────────────────────────────────────────────

    struct PriceData {
        price: u64,
        timestamp: u32,
    }

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

    // ─────────────────────────────────────────────────────────────
    // RECORDS — identical to zkperp_v9
    // ─────────────────────────────────────────────────────────────

    record PositionSlot {
        owner: address,
        slot_id: u8,         // 0 = LONG slot only, 1 = SHORT slot only
        is_open: bool,
        position_id: field,  // 0field when empty
        is_long: bool,
        size_usdc: u64,
        collateral_usdc: u64,
        entry_price: u64,
    }

    record LiquidationAuth {
        owner: address,      // orchestrator
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
        slot_id: u8,         // always 0u8
        is_open: bool,
        lp_amount: u64,      // 0 when empty
    }

    // ─────────────────────────────────────────────────────────────
    // CONSTRUCTOR & ROLE MANAGEMENT
    // ─────────────────────────────────────────────────────────────

    @noupgrade
    async constructor() {}

    // Seed roles — call once after deploy (mirrors v9 initialize_roles)
    async transition seed_roles(
        public oracle_admin: address,
        public orchestrator: address,
    ) -> Future {
        return finalize_seed_roles(oracle_admin, orchestrator);
    }

    async function finalize_seed_roles(oracle_admin: address, orchestrator: address) {
        let already_set: bool = Mapping::contains(roles, 0u8);
        assert(!already_set);
        Mapping::set(roles, 0u8, oracle_admin);
        Mapping::set(roles, 1u8, orchestrator);
    }

    // ─────────────────────────────────────────────────────────────
    // ORACLE — seed/update price (mirrors v9 update_price)
    // ─────────────────────────────────────────────────────────────

    async transition seed_oracle(
        public asset_id: field,
        public price: u64,
        public timestamp: u32,
    ) -> Future {
        return finalize_seed_oracle(self.caller, asset_id, price, timestamp);
    }

    async function finalize_seed_oracle(
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
    // INITIALIZE SLOTS — identical to zkperp_v9
    // Mints 2 PositionSlots + 1 LPSlot to recipient. Call once per address.
    // ─────────────────────────────────────────────────────────────

    async transition initialize_slots(
        recipient: address,
    ) -> (PositionSlot, PositionSlot, LPSlot, Future) {

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

    // ─────────────────────────────────────────────────────────────
    // ADD LIQUIDITY — mirrors zkperp_v9, token swapped to mock_usdc
    // ─────────────────────────────────────────────────────────────

    async transition add_liquidity(
        lp_slot: LPSlot,
        public deposit_amount: u128,
        recipient: address,
    ) -> (LPSlot, Future) {
        assert(deposit_amount >= 100u128);
        assert_eq(lp_slot.owner, self.signer);

        let transfer_future: Future = mock_usdc_0128.aleo/transfer_from_public(
            self.caller,
            self.address,
            deposit_amount
        );

        let deposit_u64: u64 = deposit_amount as u64;

        let updated_slot: LPSlot = LPSlot {
            owner: recipient,
            slot_id: 0u8,
            is_open: true,
            lp_amount: lp_slot.lp_amount + deposit_u64,
        };

        return (updated_slot, finalize_add_liquidity(transfer_future, deposit_u64, lp_slot.lp_amount));
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

    // ─────────────────────────────────────────────────────────────
    // REMOVE LIQUIDITY — mirrors zkperp_v9, token swapped to mock_usdc
    //
    // amount_to_burn: LP tokens to burn (must be <= lp_slot.lp_amount)
    // expected_usdc:  USDC to receive (must be <= max_usdc in finalize)
    // ─────────────────────────────────────────────────────────────

    async transition remove_liquidity(
        lp_slot: LPSlot,
        public amount_to_burn: u64,
        public expected_usdc: u128,
    ) -> (LPSlot, Future) {
        assert_eq(lp_slot.owner, self.signer);
        assert(lp_slot.is_open);
        assert(lp_slot.lp_amount >= amount_to_burn);

        let transfer_future: Future = mock_usdc_0128.aleo/transfer_public(
            lp_slot.owner,
            expected_usdc
        );

        let remaining_amount: u64 = lp_slot.lp_amount - amount_to_burn;

        let updated_slot: LPSlot = LPSlot {
            owner: lp_slot.owner,
            slot_id: 0u8,
            is_open: remaining_amount > 0u64,
            lp_amount: remaining_amount,
        };

        return (updated_slot, finalize_remove_liquidity(transfer_future, amount_to_burn, expected_usdc as u64));
    }

    async function finalize_remove_liquidity(
        transfer_future: Future,
        amount_to_burn: u64,
        expected_usdc: u64,
    ) {
        transfer_future.await();

        let state: PoolState = Mapping::get(pool_state, 0field);

        let max_usdc: u64 = (amount_to_burn * state.total_liquidity) / (state.total_lp_tokens + 1u64);
        assert(expected_usdc <= max_usdc);

        // Cannot withdraw locked liquidity (used as collateral for open positions)
        let locked_liquidity: u64 = state.long_open_interest + state.short_open_interest;
        assert(state.total_liquidity - expected_usdc >= locked_liquidity);

        Mapping::set(pool_state, 0field, PoolState {
            total_liquidity: state.total_liquidity - expected_usdc,
            total_lp_tokens: state.total_lp_tokens - amount_to_burn,
            long_open_interest: state.long_open_interest,
            short_open_interest: state.short_open_interest,
            accumulated_fees: state.accumulated_fees,
        });
    }

    // ─────────────────────────────────────────────────────────────
    // OPEN POSITION — mirrors zkperp_v9, token swapped to mock_usdc
    //
    // For LONG:  pass long_slot  (slot_id: 0) + is_long: true
    // For SHORT: pass short_slot (slot_id: 1) + is_long: false
    // ─────────────────────────────────────────────────────────────

    async transition open_position(
        slot: PositionSlot,
        public collateral: u128,
        public size: u64,
        public is_long: bool,
        public entry_price: u64,
        public max_slippage: u64,
        nonce: field,
        recipient: address,
        public orchestrator: address,
    ) -> (PositionSlot, LiquidationAuth, Future) {

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

        let transfer_future: Future = mock_usdc_0128.aleo/transfer_from_public(
            self.caller,
            self.address,
            collateral
        );

        let id_input: PositionIdInput = PositionIdInput {
            recipient: recipient,
            nonce: nonce,
            size: size,
        };
        let position_id: field = BHP256::hash_to_field(id_input);

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
            recipient,
            orchestrator,
            collateral_u64,
            size,
            is_long,
            entry_price,
            max_slippage,
            nonce,
            opening_fee,
            collateral_after_fee,
        );

        return (filled_slot, liq_auth, f);
    }

    async function finalize_open_position(
        transfer_future: Future,
        position_id: field,
        recipient: address,
        orchestrator: address,
        collateral: u64,
        size: u64,
        is_long: bool,
        entry_price: u64,
        max_slippage: u64,
        nonce: field,
        opening_fee: u64,
        collateral_after_fee: u64,
    ) {
        transfer_future.await();

        let expected_orchestrator: address = Mapping::get(roles, 1u8);
        assert_eq(orchestrator, expected_orchestrator);

        let nonce_used: bool = Mapping::get_or_use(used_nonces, nonce, false);
        assert(!nonce_used);
        Mapping::set(used_nonces, nonce, true);

        let price_data: PriceData = Mapping::get(oracle_prices, 0field);
        let oracle_price: u64 = price_data.price;
        let higher_price: u64 = entry_price > oracle_price ? entry_price : oracle_price;
        let lower_price: u64 = entry_price > oracle_price ? oracle_price : entry_price;
        let price_diff: u64 = higher_price - lower_price;
        assert(price_diff <= max_slippage);

        Mapping::set(position_open_blocks, position_id, block.height);
        Mapping::set(active_position_ids, position_id, position_id);

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

        let new_long_oi: u64 = state.long_open_interest + (is_long ? size : 0u64);
        let new_short_oi: u64 = state.short_open_interest + (is_long ? 0u64 : size);

        let max_oi: u64 = (state.total_liquidity * MAX_OI_RATIO_BPS) / 1_000_000u64;
        assert(new_long_oi <= max_oi);
        assert(new_short_oi <= max_oi);

        Mapping::set(pool_state, 0field, PoolState {
            total_liquidity: state.total_liquidity + collateral,
            total_lp_tokens: state.total_lp_tokens,
            long_open_interest: new_long_oi,
            short_open_interest: new_short_oi,
            accumulated_fees: state.accumulated_fees + opening_fee,
        });
    }

    // ─────────────────────────────────────────────────────────────
    // CLOSE POSITION — mirrors zkperp_v9, token swapped to mock_usdc
    //
    // min_price / max_price: slippage bounds on exit price
    //   long:  oracle_price must be >= min_price
    //   short: oracle_price must be <= max_price
    // expected_payout: must be <= max_payout calculated in finalize
    // ─────────────────────────────────────────────────────────────

    async transition close_position(
        slot: PositionSlot,
        public min_price: u64,
        public max_price: u64,
        public expected_payout: u128,
    ) -> (PositionSlot, Future) {
        assert(slot.is_open);
        assert_eq(slot.owner, self.signer);

        let transfer_future: Future = mock_usdc_0128.aleo/transfer_public(
            slot.owner,
            expected_payout
        );

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

        return (empty_slot, finalize_close_position(
            transfer_future,
            slot.position_id,
            slot.is_long,
            slot.size_usdc,
            slot.collateral_usdc,
            slot.entry_price,
            min_price,
            max_price,
            expected_payout as u64,
            slot.owner,
        ));
    }

    async function finalize_close_position(
        transfer_future: Future,
        position_id: field,
        is_long: bool,
        size: u64,
        collateral: u64,
        entry_price: u64,
        min_price: u64,
        max_price: u64,
        expected_payout: u64,
        trader: address,
    ) {
        transfer_future.await();

        let price_data: PriceData = Mapping::get(oracle_prices, 0field);
        let current_price: u64 = price_data.price;

        // Slippage check
        if is_long {
            assert(current_price >= min_price);
        } else {
            assert(current_price <= max_price);
        }

        // Calculate PnL
        let safe_entry_price: u128 = entry_price as u128 + 1u128;
        let higher_price: u64 = current_price > entry_price ? current_price : entry_price;
        let lower_price: u64 = current_price > entry_price ? entry_price : current_price;
        let price_diff: u128 = (higher_price - lower_price) as u128;
        let pnl_abs: u64 = ((size as u128 * price_diff) / safe_entry_price) as u64;
        let trader_profits: bool = (is_long && current_price > entry_price) || (!is_long && current_price < entry_price);

        // Borrow fee
        let open_block: u32 = Mapping::get(position_open_blocks, position_id);
        let blocks_open: u64 = (block.height - open_block) as u64 + 1u64;
        let borrow_fee: u64 = (size * blocks_open) / 100_000_000u64;

        // Validate payout
        let max_payout: u64 = trader_profits
            ? collateral + pnl_abs - borrow_fee
            : (collateral > pnl_abs + borrow_fee ? collateral - pnl_abs - borrow_fee : 0u64);
        assert(expected_payout <= max_payout);

        // Update pool state
        let state: PoolState = Mapping::get(pool_state, 0field);

        let after_collateral: u64 = state.total_liquidity - collateral;
        let after_pnl: u64 = trader_profits
            ? (after_collateral > pnl_abs ? after_collateral - pnl_abs : 0u64)
            : after_collateral + pnl_abs;
        let final_liquidity: u64 = after_pnl + borrow_fee;

        let long_oi_decrease: u64 = is_long ? size : 0u64;
        let short_oi_decrease: u64 = is_long ? 0u64 : size;
        let new_long_oi: u64 = state.long_open_interest > long_oi_decrease
            ? state.long_open_interest - long_oi_decrease
            : 0u64;
        let new_short_oi: u64 = state.short_open_interest > short_oi_decrease
            ? state.short_open_interest - short_oi_decrease
            : 0u64;

        Mapping::set(pool_state, 0field, PoolState {
            total_liquidity: final_liquidity,
            total_lp_tokens: state.total_lp_tokens,
            long_open_interest: new_long_oi,
            short_open_interest: new_short_oi,
            accumulated_fees: state.accumulated_fees + borrow_fee,
        });

        Mapping::remove(position_open_blocks, position_id);
        Mapping::remove(active_position_ids, position_id);
    }

    // ─────────────────────────────────────────────────────────────
    // LIQUIDATE — mirrors zkperp_v9, token swapped to mock_usdc
    //
    // Called by orchestrator (auth.owner). Consumes LiquidationAuth,
    // returns empty PositionSlot to the original trader.
    // liquidator_reward must be <= size * 0.5% (LIQUIDATION_REWARD_BPS)
    // ─────────────────────────────────────────────────────────────

    async transition liquidate(
        auth: LiquidationAuth,
        public liquidator_reward: u128,
    ) -> (PositionSlot, Future) {
        assert_eq(auth.owner, self.caller);

        let transfer_future: Future = mock_usdc_0128.aleo/transfer_public(
            self.caller,
            liquidator_reward
        );

        // Return empty slot to trader — slot_id preserved
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

        return (empty_slot, finalize_liquidate(
            transfer_future,
            auth.position_id,
            auth.is_long,
            auth.size_usdc,
            auth.collateral_usdc,
            auth.entry_price,
            liquidator_reward as u64,
            auth.trader,
        ));
    }

    async function finalize_liquidate(
        transfer_future: Future,
        position_id: field,
        is_long: bool,
        size: u64,
        collateral: u64,
        entry_price: u64,
        liquidator_reward: u64,
        trader: address,
    ) {
        transfer_future.await();

        let price_data: PriceData = Mapping::get(oracle_prices, 0field);
        let current_price: u64 = price_data.price;

        // Calculate PnL
        let safe_entry_price: u128 = entry_price as u128 + 1u128;
        let higher_price: u64 = current_price > entry_price ? current_price : entry_price;
        let lower_price: u64 = current_price > entry_price ? entry_price : current_price;
        let price_diff: u128 = (higher_price - lower_price) as u128;
        let pnl_abs: u64 = ((size as u128 * price_diff) / safe_entry_price) as u64;
        let trader_profits: bool = (is_long && current_price > entry_price) || (!is_long && current_price < entry_price);

        // Borrow fee
        let open_block: u32 = Mapping::get(position_open_blocks, position_id);
        let blocks_open: u64 = (block.height - open_block) as u64 + 1u64;
        let borrow_fee: u64 = (size * blocks_open) / 100_000_000u64;

        // Remaining margin — must be below liquidation threshold
        let remaining_margin_signed: i64 = trader_profits
            ? (collateral as i64 + pnl_abs as i64 - borrow_fee as i64)
            : (collateral as i64 - pnl_abs as i64 - borrow_fee as i64);

        let margin_ratio_bps: i64 = (remaining_margin_signed * 1_000_000i64) / (size as i64 + 1i64);
        assert(margin_ratio_bps < LIQUIDATION_THRESHOLD_BPS as i64);

        // Debug mappings — useful for diagnosing "why did liquidation reject?"
        Mapping::set(debug_liquidation, 0u8, remaining_margin_signed);
        Mapping::set(debug_liquidation, 1u8, margin_ratio_bps);
        Mapping::set(debug_liquidation, 2u8, LIQUIDATION_THRESHOLD_BPS as i64);
        Mapping::set(debug_liquidation, 3u8, pnl_abs as i64);
        Mapping::set(debug_liquidation, 4u8, collateral as i64);

        // Reward cap
        let max_reward: u64 = (size * LIQUIDATION_REWARD_BPS) / 1_000_000u64;
        assert(liquidator_reward <= max_reward);

        // Update pool state
        let state: PoolState = Mapping::get(pool_state, 0field);

        let capped_pnl: u64 = pnl_abs <= collateral ? pnl_abs : collateral;
        let margin_if_loss: u64 = collateral - capped_pnl;
        let margin_after_pnl: u64 = trader_profits ? (collateral + pnl_abs) : margin_if_loss;
        let capped_fee: u64 = borrow_fee <= margin_after_pnl ? borrow_fee : margin_after_pnl;
        let remaining_margin: u64 = margin_after_pnl - capped_fee;

        let capped_collateral: u64 = collateral <= state.total_liquidity ? collateral : state.total_liquidity;
        let liq_after_remove: u64 = state.total_liquidity - capped_collateral;
        let liq_after_margin: u64 = liq_after_remove + remaining_margin;
        let capped_reward: u64 = liquidator_reward <= liq_after_margin ? liquidator_reward : liq_after_margin;
        let new_liquidity: u64 = liq_after_margin - capped_reward;

        let long_oi_decrease: u64 = is_long ? size : 0u64;
        let short_oi_decrease: u64 = is_long ? 0u64 : size;
        let capped_long_dec: u64 = long_oi_decrease <= state.long_open_interest ? long_oi_decrease : state.long_open_interest;
        let capped_short_dec: u64 = short_oi_decrease <= state.short_open_interest ? short_oi_decrease : state.short_open_interest;

        Mapping::set(pool_state, 0field, PoolState {
            total_liquidity: new_liquidity,
            total_lp_tokens: state.total_lp_tokens,
            long_open_interest: state.long_open_interest - capped_long_dec,
            short_open_interest: state.short_open_interest - capped_short_dec,
            accumulated_fees: state.accumulated_fees,
        });

        Mapping::remove(position_open_blocks, position_id);
        Mapping::remove(active_position_ids, position_id);
    }
}
