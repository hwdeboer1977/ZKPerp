// ZKPerp - Privacy-Preserving Perpetual DEX on Aleo
// With mock_usdc token integration
// Option D: Dual Record System for Liquidations

import mock_usdc.aleo;

program zkperp_v1.aleo {

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
    // ═══════════════════════════════════════════════════════════════════

    @noupgrade
    async constructor() {}

    // ============== CONSTANTS ==============
    
    const SCALE: u128 = 1_000_000u128;
    const MIN_MARGIN_BPS: u64 = 50_000u64;           // 5% min margin (20x max leverage)
    const LIQUIDATION_THRESHOLD_BPS: u64 = 10_000u64; // 1% liquidation threshold
    const OPENING_FEE_BPS: u64 = 1_000u64;           // 0.1% opening fee
    const LIQUIDATION_REWARD_BPS: u64 = 5_000u64;    // 0.5% liquidation reward
    const MAX_OI_RATIO_BPS: u64 = 500_000u64;        // 50% max OI per side
    
    // Oracle admin - only this address can update prices
    const ORACLE_ADMIN: address = aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px;
    
    // Orchestrator - receives LiquidationAuth records for all positions
    const ORCHESTRATOR: address = aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px;

    // DEBUG: Store values for inspection
    mapping debug_liquidation: u8 => i64;

    // ============== RECORDS ==============

    // Position record - owned by TRADER (for closing)
    record Position {
        owner: address,
        position_id: field,
        is_long: bool,
        size_usdc: u64,
        collateral_usdc: u64,
        entry_price: u64,
        open_block: u32,
    }

    // LiquidationAuth record - owned by ORCHESTRATOR (for liquidating)
    record LiquidationAuth {
        owner: address,           // Orchestrator's address
        trader: address,          // Original trader
        position_id: field,
        is_long: bool,
        size_usdc: u64,
        collateral_usdc: u64,
        entry_price: u64,
        open_block: u32,
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

    // ============== LP FUNCTIONS ==============

    async transition add_liquidity(
        public deposit_amount: u128,
        recipient: address,
    ) -> (LPToken, Future) {
        assert(deposit_amount >= 100u128);
        
        let transfer_future: Future = mock_usdc.aleo/transfer_from(
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
        
        let transfer_future: Future = mock_usdc.aleo/transfer_public(
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
    async transition open_position(
        public collateral: u128,
        public size: u64,
        public is_long: bool,
        public entry_price: u64,
        public max_slippage: u64,
        nonce: field,
        recipient: address,
    ) -> (Position, LiquidationAuth, Future) {
        let collateral_u64: u64 = collateral as u64;
        
        // Validate leverage (size / collateral <= 20)
        let leverage_scaled: u64 = (size * 100u64) / collateral_u64;
        assert(leverage_scaled <= 2000u64);
        
        assert(size >= 100u64);
        
        // Calculate fees
        let opening_fee: u64 = (size * OPENING_FEE_BPS) / 1_000_000u64;
        let collateral_after_fee: u64 = collateral_u64 - opening_fee;
        
        // Transfer collateral from user to pool
        let transfer_future: Future = mock_usdc.aleo/transfer_from(
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
        let position: Position = Position {
            owner: recipient,
            position_id: position_id,
            is_long: is_long,
            size_usdc: size,
            collateral_usdc: collateral_after_fee,
            entry_price: entry_price,
            open_block: 0u32,
        };
        
        // Create LiquidationAuth record for ORCHESTRATOR
        let liq_auth: LiquidationAuth = LiquidationAuth {
            owner: ORCHESTRATOR,
            trader: recipient,
            position_id: position_id,
            is_long: is_long,
            size_usdc: size,
            collateral_usdc: collateral_after_fee,
            entry_price: entry_price,
            open_block: 0u32,
        };
        
        let f: Future = finalize_open_position(
            transfer_future,
            collateral_u64,
            size,
            is_long,
            entry_price,
            max_slippage,
            nonce,
            opening_fee
        );
        
        return (position, liq_auth, f);
    }

    async function finalize_open_position(
        transfer_future: Future,
        collateral: u64,
        size: u64,
        is_long: bool,
        entry_price: u64,
        max_slippage: u64,
        nonce: field,
        opening_fee: u64,
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
        
        Mapping::set(pool_state, 0field, PoolState {
            total_liquidity: state.total_liquidity + collateral,
            total_lp_tokens: state.total_lp_tokens,
            long_open_interest: new_long_oi,
            short_open_interest: new_short_oi,
            accumulated_fees: state.accumulated_fees + opening_fee,
        });
    }

    // Close position - called by TRADER using their Position record
    async transition close_position(
        position: Position,
        public min_price: u64,
        public max_price: u64,
        public expected_payout: u128,
    ) -> Future {
        assert_eq(position.owner, self.signer);
        
        let transfer_future: Future = mock_usdc.aleo/transfer_public(
            position.owner,
            expected_payout
        );
        
        return finalize_close_position(
            transfer_future,
            position.position_id,
            position.is_long,
            position.size_usdc,
            position.collateral_usdc,
            position.entry_price,
            position.open_block,
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
        open_block: u32,
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

    // ============== LIQUIDATION (Option D) ==============

    // Liquidate - called by ORCHESTRATOR using their LiquidationAuth record
    async transition liquidate(
        liq_auth: LiquidationAuth,
        public liquidator_reward: u128,
    ) -> Future {
        // Orchestrator owns liq_auth, so they can pass it
        // Transfer reward to the caller (orchestrator/liquidator)
        let transfer_future: Future = mock_usdc.aleo/transfer_public(
            self.caller,
            liquidator_reward
        );
        
        return finalize_liquidate(
            transfer_future,
            liq_auth.position_id,
            liq_auth.is_long,
            liq_auth.size_usdc,
            liq_auth.collateral_usdc,
            liq_auth.entry_price,
            liq_auth.open_block,
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
        open_block: u32,
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
        // Pool already has collateral in total_liquidity from open_position
        // Now we need to:
        //   1. Account for trader's PnL (pool gains if trader loses)
        //   2. Subtract liquidator reward (paid from pool)
    
        // If remaining margin is positive, it stays in pool (minus reward)
        // If remaining margin is negative, pool absorbs the loss
        // FIX: Use safe subtraction - cap the subtrahend to avoid underflow
        let capped_pnl: u64 = pnl_abs <= collateral ? pnl_abs : collateral;
        let margin_if_loss: u64 = collateral - capped_pnl;
        let margin_after_pnl: u64 = trader_profits ? (collateral + pnl_abs) : margin_if_loss;
        
        let capped_fee: u64 = borrow_fee <= margin_after_pnl ? borrow_fee : margin_after_pnl;
        let remaining_margin: u64 = margin_after_pnl - capped_fee;
                
        // After liquidation: pool should have (total_liquidity - collateral) + remaining_margin - liquidator_reward
        // FIX: Use safe subtraction pattern
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
        // Only admin can update price
        assert_eq(self.caller, ORACLE_ADMIN);
        
        return finalize_update_price(asset_id, price, timestamp);
    }

    async function finalize_update_price(
        asset_id: field,
        price: u64,
        timestamp: u32,
    ) {
        Mapping::set(oracle_prices, asset_id, PriceData {
            price: price,
            timestamp: timestamp,
        });
    }
}
