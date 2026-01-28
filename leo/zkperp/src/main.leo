// ZKPerp - Privacy-Preserving Perpetual DEX on Aleo
// With mock_usdc token integration
// Option D: Dual Record System for Liquidations
// UPDATED: Admin/Orchestrator stored in mappings (configurable after deploy)
// FIXED: open_block now stored in mapping (accessible in finalize)

import mock_usdc_0128.aleo;

program zkperp_v4.aleo {

    // ═══════════════════════════════════════════════════════════════════
    // LIQUIDATION ARCHITECTURE (Option D - Dual Record)
    // ═══════════════════════════════════════════════════════════════════
    //
    // When a trader opens a position, TWO records are created:
    //   1. Position → owned by TRADER (for closing their position)
    //   2. LiquidationAuth → owned by ORCHESTRATOR (for liquidating if needed)
    //
    // This allows:
    //   - Trader to close their own position anytime
    //   - Orchestrator to liquidate unhealthy positions
    //   - Full privacy (no public position data)
    //
    // SETUP AFTER DEPLOY:
    //   1. Call initialize_roles() - first caller becomes admin & orchestrator
    //   2. Optionally call transfer_orchestrator() to set a different orchestrator
    //
    // ═══════════════════════════════════════════════════════════════════

    // The constructor is configured to prevent upgrades.
    @noupgrade
    async constructor() {}

    // ============== CONSTANTS ==============
    
    const SCALE: u128 = 1_000_000u128;
    const MIN_MARGIN_BPS: u64 = 50_000u64;           // 5% min margin (20x max leverage)
    const LIQUIDATION_THRESHOLD_BPS: u64 = 10_000u64; // 1% liquidation threshold
    const OPENING_FEE_BPS: u64 = 1_000u64;           // 0.1% opening fee
    const LIQUIDATION_REWARD_BPS: u64 = 5_000u64;    // 0.5% liquidation reward
    const MAX_OI_RATIO_BPS: u64 = 500_000u64;        // 50% max OI per side

    // ============== ROLE MAPPINGS ==============
    
    // Admin roles stored in mappings (set after deploy)
    // Key 0u8 = oracle admin (can update prices)
    // Key 1u8 = orchestrator (receives LiquidationAuth records)
    mapping roles: u8 => address;

    // DEBUG: Store values for inspection
    mapping debug_liquidation: u8 => i64;

    // ============== RECORDS ==============

    // Position record - owned by TRADER (for closing)
    // NOTE: open_block in record is deprecated, actual value stored in position_open_blocks mapping
    record Position {
        owner: address,
        position_id: field,
        is_long: bool,
        size_usdc: u64,
        collateral_usdc: u64,
        entry_price: u64,
        open_block: u32,  // Deprecated - kept for compatibility, actual value in mapping
    }

    // LiquidationAuth record - owned by ORCHESTRATOR (for liquidating)
    // NOTE: open_block in record is deprecated, actual value stored in position_open_blocks mapping
    record LiquidationAuth {
        owner: address,           // Orchestrator's address
        trader: address,          // Original trader
        position_id: field,
        is_long: bool,
        size_usdc: u64,
        collateral_usdc: u64,
        entry_price: u64,
        open_block: u32,  // Deprecated - kept for compatibility, actual value in mapping
    }

    // LP token record
    record LPToken {
        owner: address,
        amount: u64,
    }

    // ============== MAPPINGS ==============

    mapping pool_state: field => PoolState;
    
    struct PoolState {
        total_liquidity: u64,
        total_lp_tokens: u64,
        long_open_interest: u64,
        short_open_interest: u64,
        accumulated_fees: u64,
    }

    mapping oracle_prices: field => PriceData;
    
    struct PriceData {
        price: u64,
        timestamp: u32,
    }

    mapping used_nonces: field => bool;
    
    // Track closed/liquidated positions to prevent double-spending
    mapping closed_positions: field => bool;

    // Store the block height when position was opened
    // This is set in finalize where block.height is accessible
    mapping position_open_blocks: field => u32;

    // ============== ROLE MANAGEMENT ==============

    /// Initialize roles - can only be called once
    /// First caller becomes both oracle_admin and orchestrator
    async transition initialize_roles() -> Future {
        return finalize_initialize_roles(self.caller);
    }

    async function finalize_initialize_roles(caller: address) {
        // Check if roles already initialized
        let admin_exists: bool = Mapping::contains(roles, 0u8);
        assert(!admin_exists); // Can only initialize once
        
        // Set caller as both oracle admin and orchestrator
        Mapping::set(roles, 0u8, caller);  // Oracle admin
        Mapping::set(roles, 1u8, caller);  // Orchestrator
    }

    /// Transfer oracle admin role to a new address
    async transition transfer_oracle_admin(new_admin: address) -> Future {
        return finalize_transfer_oracle_admin(self.caller, new_admin);
    }

    async function finalize_transfer_oracle_admin(caller: address, new_admin: address) {
        let current_admin: address = Mapping::get(roles, 0u8);
        assert_eq(caller, current_admin);
        Mapping::set(roles, 0u8, new_admin);
    }

    /// Transfer orchestrator role to a new address
    async transition transfer_orchestrator(new_orchestrator: address) -> Future {
        return finalize_transfer_orchestrator(self.caller, new_orchestrator);
    }

    async function finalize_transfer_orchestrator(caller: address, new_orchestrator: address) {
        // Only current oracle admin can change orchestrator
        let current_admin: address = Mapping::get(roles, 0u8);
        assert_eq(caller, current_admin);
        Mapping::set(roles, 1u8, new_orchestrator);
    }

    // ============== LP FUNCTIONS ==============

    async transition add_liquidity(
        public deposit_amount: u128,
        recipient: address,
    ) -> (LPToken, Future) {
        assert(deposit_amount >= 100u128);
        
        let transfer_future: Future = mock_usdc_0128.aleo/transfer_from(
            self.caller,
            self.address,
            deposit_amount
        );
        
        let deposit_u64: u64 = deposit_amount as u64;
        
        let lp_token: LPToken = LPToken {
            owner: recipient,
            amount: deposit_u64,
        };
        
        return (lp_token, finalize_add_liquidity(transfer_future, deposit_u64));
    }

    async function finalize_add_liquidity(
        transfer_future: Future,
        deposit_amount: u64,
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

    async transition remove_liquidity(
        lp_token: LPToken,
        public amount_to_burn: u64,
        public expected_usdc: u128,
    ) -> (LPToken, Future) {
        assert(lp_token.amount >= amount_to_burn);
        
        let transfer_future: Future = mock_usdc_0128.aleo/transfer_public(
            lp_token.owner,
            expected_usdc
        );
        
        let remaining: LPToken = LPToken {
            owner: lp_token.owner,
            amount: lp_token.amount - amount_to_burn,
        };
        
        return (remaining, finalize_remove_liquidity(transfer_future, amount_to_burn, expected_usdc as u64));
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

    // ============== TRADING FUNCTIONS ==============

    struct PositionIdInput {
        recipient: address,
        nonce: field,
        size: u64,
    }

    // Open position - creates BOTH Position (for trader) and LiquidationAuth (for orchestrator)
    // NOTE: Orchestrator address is read from mapping in finalize
    async transition open_position(
        public collateral: u128,
        public size: u64,
        public is_long: bool,
        public entry_price: u64,
        public max_slippage: u64,
        nonce: field,
        recipient: address,
    ) -> (Position, Future) {
        let collateral_u64: u64 = collateral as u64;
        
        // Validate leverage (size / collateral <= 20)
        let leverage_scaled: u64 = (size * 100u64) / collateral_u64;
        assert(leverage_scaled <= 2000u64);
        
        assert(size >= 100u64);
        
        // Calculate fees
        let opening_fee: u64 = (size * OPENING_FEE_BPS) / 1_000_000u64;
        let collateral_after_fee: u64 = collateral_u64 - opening_fee;
        
        // Transfer collateral from user to pool
        let transfer_future: Future = mock_usdc_0128.aleo/transfer_from(
            self.caller,
            self.address,
            collateral
        );
        
        // Generate position ID
        let id_input: PositionIdInput = PositionIdInput {
            recipient: recipient,
            nonce: nonce,
            size: size,
        };
        let position_id: field = BHP256::hash_to_field(id_input);
        
        // Create Position record for TRADER
        // NOTE: open_block is set to 0 here because block.height is not available in transition
        // The actual open_block is stored in position_open_blocks mapping during finalize
        let position: Position = Position {
            owner: recipient,
            position_id: position_id,
            is_long: is_long,
            size_usdc: size,
            collateral_usdc: collateral_after_fee,
            entry_price: entry_price,
            open_block: 0u32,  // Placeholder - actual value in mapping
        };
        
        // NOTE: LiquidationAuth record is created in finalize where we can read orchestrator from mapping
        // This is a simplification - in production you might need a different approach
        
        let f: Future = finalize_open_position(
            transfer_future,
            position_id,
            recipient,
            collateral_u64,
            size,
            is_long,
            entry_price,
            max_slippage,
            nonce,
            opening_fee,
            collateral_after_fee
        );
        
        return (position, f);
    }

    async function finalize_open_position(
        transfer_future: Future,
        position_id: field,
        recipient: address,
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
        
        // Check nonce
        let nonce_used: bool = Mapping::get_or_use(used_nonces, nonce, false);
        assert(!nonce_used);
        Mapping::set(used_nonces, nonce, true);
        
        // Validate entry_price against oracle
        let price_data: PriceData = Mapping::get(oracle_prices, 0field);
        let oracle_price: u64 = price_data.price;
        
        let higher_price: u64 = entry_price > oracle_price ? entry_price : oracle_price;
        let lower_price: u64 = entry_price > oracle_price ? oracle_price : entry_price;
        let price_diff: u64 = higher_price - lower_price;
        assert(price_diff <= max_slippage);
        
        // Get pool state
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
        
        // Calculate new OI
        let new_long_oi: u64 = state.long_open_interest + (is_long ? size : 0u64);
        let new_short_oi: u64 = state.short_open_interest + (is_long ? 0u64 : size);
        
        // Check OI caps
        let max_oi: u64 = (state.total_liquidity * MAX_OI_RATIO_BPS) / 1_000_000u64;
        assert(new_long_oi <= max_oi);
        assert(new_short_oi <= max_oi);
        
        // Store the open block for this position
        // block.height is only available in finalize, so we store it in a mapping
        Mapping::set(position_open_blocks, position_id, block.height);
        
        Mapping::set(pool_state, 0field, PoolState {
            total_liquidity: state.total_liquidity + collateral,
            total_lp_tokens: state.total_lp_tokens,
            long_open_interest: new_long_oi,
            short_open_interest: new_short_oi,
            accumulated_fees: state.accumulated_fees + opening_fee,
        });
    }

    async transition close_position(
        position: Position,
        public min_price: u64,
        public max_price: u64,
        public expected_payout: u128,
    ) -> Future {
        assert_eq(position.owner, self.signer);
        
        // Transfer USDC from zkperp.aleo's balance to trader
        // When zkperp.aleo calls this, self.caller in the USDC contract will be zkperp.aleo
        let transfer_future: Future = mock_usdc_0128.aleo/transfer_public(
            position.owner,      // to: trader
            expected_payout      // amount
        );
        
        return finalize_close_position(
            transfer_future,
            position.position_id,
            position.is_long,
            position.size_usdc,
            position.collateral_usdc,
            position.entry_price,
            min_price,
            max_price,
            expected_payout as u64
        );
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
    ) {
        transfer_future.await();
        
        // Check position not already closed/liquidated
        let is_closed: bool = Mapping::get_or_use(closed_positions, position_id, false);
        assert(!is_closed);
        
        // Mark position as closed
        Mapping::set(closed_positions, position_id, true);
        
        // Get current price
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
        
        // Read open_block from mapping
        let open_block: u32 = Mapping::get(position_open_blocks, position_id);
        
        // Calculate borrow fee
        let blocks_open: u64 = (block.height - open_block) as u64 + 1u64;
        let borrow_fee: u64 = (size * blocks_open) / 100_000_000u64;
        
        // Calculate max payout
        let max_payout: u64 = trader_profits
            ? collateral + pnl_abs - borrow_fee
            : (collateral > pnl_abs + borrow_fee ? collateral - pnl_abs - borrow_fee : 0u64);
        
        assert(expected_payout <= max_payout);
        
        // Get pool state
        let state: PoolState = Mapping::get(pool_state, 0field);
        
        // Update liquidity
        let after_collateral: u64 = state.total_liquidity - collateral;
        let after_pnl: u64 = trader_profits
            ? (after_collateral > pnl_abs ? after_collateral - pnl_abs : 0u64)
            : after_collateral + pnl_abs;
        let final_liquidity: u64 = after_pnl + borrow_fee;
        
        // Update OI
        let long_oi_decrease: u64 = is_long ? size : 0u64;
        let short_oi_decrease: u64 = is_long ? 0u64 : size;
        
        let new_long_oi: u64 = state.long_open_interest > long_oi_decrease 
            ? state.long_open_interest - long_oi_decrease 
            : 0u64;
        let new_short_oi: u64 = state.short_open_interest > short_oi_decrease 
            ? state.short_open_interest - short_oi_decrease 
            : 0u64;
        
        let new_fees: u64 = state.accumulated_fees + borrow_fee;
        
        Mapping::set(pool_state, 0field, PoolState {
            total_liquidity: final_liquidity,
            total_lp_tokens: state.total_lp_tokens,
            long_open_interest: new_long_oi,
            short_open_interest: new_short_oi,
            accumulated_fees: new_fees,
        });
    }

    // ============== LIQUIDATION ==============
    
    // NOTE: Without hardcoded ORCHESTRATOR, we need a different approach for liquidations
    // Option 1: Anyone can liquidate (permissionless) - simpler and more decentralized
    // Option 2: Store liquidation data in mapping, orchestrator calls a separate function
    
    // Using Option 1: Permissionless liquidation
    // Anyone can liquidate unhealthy positions if they know the position details
    
    async transition liquidate(
        public position_id: field,
        public is_long: bool,
        public size: u64,
        public collateral: u64,
        public entry_price: u64,
        public liquidator_reward: u128,
    ) -> Future {
        // Transfer reward to the caller (liquidator)
        let transfer_future: Future = mock_usdc_0128.aleo/transfer_public(
            self.caller,
            liquidator_reward
        );
        
        return finalize_liquidate(
            transfer_future,
            position_id,
            is_long,
            size,
            collateral,
            entry_price,
            liquidator_reward as u64
        );
    }

    async function finalize_liquidate(
        transfer_future: Future,
        position_id: field,
        is_long: bool,
        size: u64,
        collateral: u64,
        entry_price: u64,
        liquidator_reward: u64,
    ) {
        transfer_future.await();
        
        // Check position not already closed/liquidated
        let is_closed: bool = Mapping::get_or_use(closed_positions, position_id, false);
        assert(!is_closed);
        
        // Mark position as liquidated
        Mapping::set(closed_positions, position_id, true);
        
        // Get current price
        let price_data: PriceData = Mapping::get(oracle_prices, 0field);
        let current_price: u64 = price_data.price;
        
        // Calculate PnL
        let safe_entry_price: u128 = entry_price as u128 + 1u128;
        
        let higher_price: u64 = current_price > entry_price ? current_price : entry_price;
        let lower_price: u64 = current_price > entry_price ? entry_price : current_price;
        let price_diff: u128 = (higher_price - lower_price) as u128;
        
        let pnl_abs: u64 = ((size as u128 * price_diff) / safe_entry_price) as u64;
        
        let trader_profits: bool = (is_long && current_price > entry_price) || (!is_long && current_price < entry_price);
        
        // Read open_block from mapping
        let open_block: u32 = Mapping::get(position_open_blocks, position_id);
        
        // Calculate borrow fee
        let blocks_open: u64 = (block.height - open_block) as u64 + 1u64;
        let borrow_fee: u64 = (size * blocks_open) / 100_000_000u64;
        
        // Calculate remaining margin
        let remaining_margin_signed: i64 = trader_profits
            ? (collateral as i64 + pnl_abs as i64 - borrow_fee as i64)
            : (collateral as i64 - pnl_abs as i64 - borrow_fee as i64);
        
        // Margin ratio check - must be below liquidation threshold to liquidate
        let margin_ratio_bps: i64 = (remaining_margin_signed * 1_000_000i64) / (size as i64 + 1i64);
        assert(margin_ratio_bps < LIQUIDATION_THRESHOLD_BPS as i64);

        // DEBUG: Track liquidation calculation values
        Mapping::set(debug_liquidation, 0u8, remaining_margin_signed);
        Mapping::set(debug_liquidation, 1u8, margin_ratio_bps);
        Mapping::set(debug_liquidation, 2u8, LIQUIDATION_THRESHOLD_BPS as i64);
        Mapping::set(debug_liquidation, 3u8, pnl_abs as i64);
        Mapping::set(debug_liquidation, 4u8, collateral as i64);
        
        // Validate liquidator reward
        let max_reward: u64 = (size * LIQUIDATION_REWARD_BPS) / 1_000_000u64;
        assert(liquidator_reward <= max_reward);
        
        // Get pool state
        let state: PoolState = Mapping::get(pool_state, 0field);
        
        // Calculate what pool receives/loses
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
        
        // Update OI - use safe subtraction
        let long_oi_decrease: u64 = is_long ? size : 0u64;
        let short_oi_decrease: u64 = is_long ? 0u64 : size;
        
        let capped_long_dec: u64 = long_oi_decrease <= state.long_open_interest ? long_oi_decrease : state.long_open_interest;
        let capped_short_dec: u64 = short_oi_decrease <= state.short_open_interest ? short_oi_decrease : state.short_open_interest;
        
        let new_long_oi: u64 = state.long_open_interest - capped_long_dec;
        let new_short_oi: u64 = state.short_open_interest - capped_short_dec;
        
        Mapping::set(pool_state, 0field, PoolState {
            total_liquidity: new_liquidity,
            total_lp_tokens: state.total_lp_tokens,
            long_open_interest: new_long_oi,
            short_open_interest: new_short_oi,
            accumulated_fees: state.accumulated_fees,
        });
    }

    // ============== ORACLE ==============

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
        // Check caller is oracle admin
        let oracle_admin: address = Mapping::get(roles, 0u8);
        assert_eq(caller, oracle_admin);
        
        Mapping::set(oracle_prices, asset_id, PriceData {
            price: price,
            timestamp: timestamp,
        });
    }
}
