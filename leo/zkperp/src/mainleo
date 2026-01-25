// The 'ZKPerp' program.
program zkperp_v1.aleo {

    // # Terminal 1: Start devnet
    // leo devnet --snarkos $(which snarkos) --snarkos-features test_network --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11 --clear-storage

    // 1. leo build
    // 2. leo deploy --broadcast --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11
    // 3. leo execute update_price 0field 10000000000u64 1u32 --broadcast --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11

    // 4. leo execute add_liquidity 200u64 aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px --broadcast --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11

    // 5. leo execute open_position 200u64 500u64 true 10100000000u64 9900000000u64 1field aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px --broadcast --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11

    @noupgrade
    async constructor() {}

 // ============== CONSTANTS ==============
    
    // All values scaled by 1_000_000 (6 decimals) for precision
    const SCALE: u128 = 1_000_000u128;
    
    // 20x max leverage = 5% min margin = 50_000 / 1_000_000
    const MIN_MARGIN_BPS: u64 = 50_000u64;  // 5%
    
    // Liquidation at 1% margin = 10_000 / 1_000_000
    const LIQUIDATION_THRESHOLD_BPS: u64 = 10_000u64;  // 1%
    
    // Opening fee: 0.1% = 1_000 / 1_000_000
    const OPENING_FEE_BPS: u64 = 1_000u64;
    
    // Liquidation reward: 0.5% of position size
    const LIQUIDATION_REWARD_BPS: u64 = 5_000u64;
    
    // Max OI per side as % of pool: 50%
    const MAX_OI_RATIO_BPS: u64 = 500_000u64;

 
    // ============== RECORDS ==============

    // Position record - private, owned by trader
    record Position {
        owner: address,
        position_id: field,
        is_long: bool,
        size_usdc: u64,         // notional size (e.g., $10,000)
        collateral_usdc: u64,   // margin deposited
        entry_price: u64,       // BTC price at entry (8 decimals)
        open_block: u32,        // for borrow fee calculation
    }

    // LP token record - private, owned by liquidity provider  
    record LPToken {
        owner: address,
        amount: u64,            // LP token balance
    }


    // ============== MAPPINGS (PUBLIC STATE) ==============

    // Pool state - single entry at key 0field
    mapping pool_state: field => PoolState;
    
    struct PoolState {
        total_liquidity: u64,   // total USDC in pool
        total_lp_tokens: u64,   // total LP tokens minted
        long_open_interest: u64,
        short_open_interest: u64,
        accumulated_fees: u64,
    }

    // Oracle price - updated by oracle program
    // Key is asset_id (0 = BTC)
    mapping oracle_prices: field => PriceData;
    
    struct PriceData {
        price: u64,             // price with 8 decimals
        timestamp: u32,         // block height of update
    }

    // Nonce tracking to prevent replay
    mapping used_nonces: field => bool;


    // ============== LP FUNCTIONS ==============

    // Add liquidity to LP
    async transition add_liquidity(
        public deposit_amount: u64,
        recipient: address,
    ) -> (LPToken, Future) {
        assert(deposit_amount >= 100u64);
        
        let lp_token: LPToken = LPToken {
            owner: recipient,
            amount: deposit_amount,
        };
        
        return (lp_token, finalize_add_liquidity(deposit_amount));
    }

    // Finalize Add Liquidity
    async function finalize_add_liquidity(
        deposit_amount: u64,
    ) {
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
        
        // Add 1 to avoid division by zero, similar to OpenZeppelin virtual shares
        let lp_to_mint: u64 = (deposit_amount * (state.total_lp_tokens + 1u64)) / (state.total_liquidity + 1u64);
        
        Mapping::set(pool_state, 0field, PoolState {
            total_liquidity: state.total_liquidity + deposit_amount,
            total_lp_tokens: state.total_lp_tokens + lp_to_mint,
            long_open_interest: state.long_open_interest,
            short_open_interest: state.short_open_interest,
            accumulated_fees: state.accumulated_fees,
        });
    }

    // Remove liquidity from pool
    async transition remove_liquidity(
        lp_token: LPToken,
        public amount_to_burn: u64,
    ) -> (LPToken, Future) {
        
        assert(lp_token.amount >= amount_to_burn);
        
        let remaining: LPToken = LPToken {
            owner: lp_token.owner,  // keep same owner, not self.caller
            amount: lp_token.amount - amount_to_burn,
        };
        
        return (remaining, finalize_remove_liquidity(amount_to_burn));
    }

    async function finalize_remove_liquidity(
        amount_to_burn: u64,
    ) {
        let state: PoolState = Mapping::get(pool_state, 0field);
        
        // Calculate USDC to return (proportional share of pool)
        let usdc_to_return: u64 = (amount_to_burn * state.total_liquidity) / (state.total_lp_tokens + 1u64);
        
        // Check pool has enough liquidity (accounting for OI)
        let locked_liquidity: u64 = state.long_open_interest + state.short_open_interest;
        assert(state.total_liquidity - usdc_to_return >= locked_liquidity);
        
        // Update pool state
        Mapping::set(pool_state, 0field, PoolState {
            total_liquidity: state.total_liquidity - usdc_to_return,
            total_lp_tokens: state.total_lp_tokens - amount_to_burn,
            long_open_interest: state.long_open_interest,
            short_open_interest: state.short_open_interest,
            accumulated_fees: state.accumulated_fees,
        });
    }

    // ============== TRADING FUNCTIONS ==============

    // Add this struct for hashing
    struct PositionIdInput {
        recipient: address,
        nonce: field,
        size: u64,
    }

    // Open a leveraged position
    async transition open_position(
        public collateral: u64,
        public size: u64,
        public is_long: bool,
        public entry_price: u64,     // User passes current oracle price
        public max_slippage: u64,    // Max allowed price difference
        nonce: field,
        recipient: address,
    ) -> (Position, Future) {
        
        // Validate leverage (size / collateral <= 20)
        let leverage_scaled: u64 = (size * 100u64) / collateral;
        assert(leverage_scaled <= 2000u64);
        
        // Minimum position size
        assert(size >= 100u64);
        
        // Calculate fees
        let opening_fee: u64 = (size * OPENING_FEE_BPS) / 1_000_000u64;
        let collateral_after_fee: u64 = collateral - opening_fee;
        
        // Generate unique position ID
        let id_input: PositionIdInput = PositionIdInput {
            recipient: recipient,
            nonce: nonce,
            size: size,
        };
        let position_id: field = BHP256::hash_to_field(id_input);
        
        let position: Position = Position {
            owner: recipient,
            position_id: position_id,
            is_long: is_long,
            size_usdc: size,
            collateral_usdc: collateral_after_fee,
            entry_price: entry_price,
            open_block: 0u32,
        };
        
        let f: Future = finalize_open_position(
            collateral,
            size,
            is_long,
            entry_price,
            max_slippage,
            nonce,
            opening_fee
        );
        
        return (position, f);
    }

    async function finalize_open_position(
        collateral: u64,
        size: u64,
        is_long: bool,
        entry_price: u64,
        max_slippage: u64,
        nonce: field,
        opening_fee: u64,
    ) {
        // Check nonce not used
        let nonce_used: bool = Mapping::get_or_use(used_nonces, nonce, false);
        assert(!nonce_used);
        Mapping::set(used_nonces, nonce, true);
        
        // Get oracle price and validate entry_price
        let price_data: PriceData = Mapping::get(oracle_prices, 0field);
        let oracle_price: u64 = price_data.price;
        
        // Check entry_price is within slippage of oracle
        let price_diff: u64 = entry_price > oracle_price 
            ? entry_price - oracle_price 
            : oracle_price - entry_price;
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
        
        // Update pool state
        Mapping::set(pool_state, 0field, PoolState {
            total_liquidity: state.total_liquidity + collateral,
            total_lp_tokens: state.total_lp_tokens,
            long_open_interest: new_long_oi,
            short_open_interest: new_short_oi,
            accumulated_fees: state.accumulated_fees + opening_fee,
        });
    }

    // Close position (by owner)
    async transition close_position(
        position: Position,
        public min_price: u64,   // slippage protection for longs closing
        public max_price: u64,   // slippage protection for shorts closing
    ) -> Future {
        // Verify ownership
        assert_eq(position.owner, self.signer);
        
        return finalize_close_position(
            position.position_id,
            position.is_long,
            position.size_usdc,
            position.collateral_usdc,
            position.entry_price,
            position.open_block,
            min_price,
            max_price
        );
    }

    async function finalize_close_position(
        position_id: field,
        is_long: bool,
        size: u64,
        collateral: u64,
        entry_price: u64,
        open_block: u32,
        min_price: u64,
        max_price: u64,
    ) {
    // Get current price
    let price_data: PriceData = Mapping::get(oracle_prices, 0field);
    let current_price: u64 = price_data.price;
    
    // Slippage check - use simple if/else
    if is_long {
        assert(current_price >= min_price);
    } else {
        assert(current_price <= max_price);
    }
    
    // Calculate price difference safely
    let higher_price: u64 = current_price > entry_price ? current_price : entry_price;
    let lower_price: u64 = current_price > entry_price ? entry_price : current_price;
    let price_diff: u128 = (higher_price - lower_price) as u128;
    
    // PnL calculation
    let safe_entry_price: u128 = entry_price as u128 + 1u128;
    let pnl_abs: u64 = ((size as u128 * price_diff) / safe_entry_price) as u64;
    
    // Determine if trader profits
    let trader_profits: bool = (is_long && current_price > entry_price) || (!is_long && current_price < entry_price);
    
    // Calculate borrow fee
    let blocks_open: u64 = (block.height - open_block) as u64 + 1u64;
    let borrow_fee: u64 = (size * blocks_open) / 100_000_000u64;
    
    // Get pool state
    let state: PoolState = Mapping::get(pool_state, 0field);
    
    // Calculate liquidity changes step by step
    // Pool currently has: total_liquidity (includes collateral from open)
    // When closing:
    //   - Collateral goes back to trader
    //   - If trader profits, pool pays extra (pnl_abs)
    //   - If trader loses, pool keeps extra (pnl_abs)
    //   - Pool always gets borrow_fee
    
    // Start with removing collateral
    let after_collateral: u64 = state.total_liquidity - collateral;
    
    // Adjust for PnL
    let after_pnl: u64 = trader_profits
        ? (after_collateral > pnl_abs ? after_collateral - pnl_abs : 0u64)
        : after_collateral + pnl_abs;
    
    // Add borrow fee
    let final_liquidity: u64 = after_pnl + borrow_fee;
    
    // Update OI - calculate separately to avoid nested ternaries
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

    // Liquidate underwater position (called by orchestrator)
    async transition liquidate(
        position: Position,
        public liquidator: address,
    ) -> Future {
        
        return finalize_liquidate(
            position.position_id,
            position.is_long,
            position.size_usdc,
            position.collateral_usdc,
            position.entry_price,
            position.open_block,
            liquidator
        );
    }

    async function finalize_liquidate(
        position_id: field,
        is_long: bool,
        size: u64,
        collateral: u64,
        entry_price: u64,
        open_block: u32,
        liquidator: address,
    ) {
        // Get current price
        let price_data: PriceData = Mapping::get(oracle_prices, 0field);
        let current_price: u64 = price_data.price;
        
        // Calculate PnL inline - same logic as close_position
        let safe_entry_price: u64 = entry_price + 1u64;
        
        let pnl_positive: bool = is_long ? current_price >= entry_price : entry_price >= current_price;
        
        let price_diff: u64 = current_price > entry_price 
            ? current_price - entry_price 
            : entry_price - current_price;
        
        let pnl_abs: u64 = ((price_diff as u128 * size as u128) / (safe_entry_price as u128)) as u64;
        
        let pnl: i64 = pnl_positive 
            ? (is_long ? pnl_abs as i64 : pnl_abs as i64)
            : (is_long ? -(pnl_abs as i64) : -(pnl_abs as i64));
        
        // Calculate borrow fee
        let blocks_open: u32 = block.height - open_block;
        let borrow_fee: u64 = (size * (blocks_open as u64 + 1u64)) / 100_000_000u64;
        
        // Calculate remaining margin
        let remaining_margin: i64 = collateral as i64 + pnl - borrow_fee as i64;
        
        // Margin ratio (as basis points of size)
        // Must be below liquidation threshold to liquidate
        let margin_ratio_bps: i64 = (remaining_margin * 1_000_000i64) / (size as i64 + 1i64);
        assert(margin_ratio_bps < LIQUIDATION_THRESHOLD_BPS as i64);
        
        // Liquidator reward
        let reward: u64 = (size * LIQUIDATION_REWARD_BPS) / 1_000_000u64;
        
        // Remaining goes to pool (could be negative = bad debt)
        let to_pool: i64 = remaining_margin - reward as i64;
        
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
        
        let to_pool_abs: u64 = to_pool > 0i64 ? to_pool as u64 : ((-to_pool) as u64);
        let new_liquidity: u64 = to_pool > 0i64 
            ? state.total_liquidity + to_pool_abs
            : (state.total_liquidity > to_pool_abs ? state.total_liquidity - to_pool_abs : 0u64);
        
        // Update OI
        let new_long_oi: u64 = is_long 
            ? (state.long_open_interest > size ? state.long_open_interest - size : 0u64)
            : state.long_open_interest;
        let new_short_oi: u64 = is_long 
            ? state.short_open_interest 
            : (state.short_open_interest > size ? state.short_open_interest - size : 0u64);
        
        Mapping::set(pool_state, 0field, PoolState {
            total_liquidity: new_liquidity,
            total_lp_tokens: state.total_lp_tokens,
            long_open_interest: new_long_oi,
            short_open_interest: new_short_oi,
            accumulated_fees: state.accumulated_fees,
        });
        
        // TODO: Transfer reward to liquidator
    }


    // ============== ORACLE UPDATE ==============

    async transition update_price(
        public asset_id: field,
        public price: u64,
        public timestamp: u32,
    ) -> Future {
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
