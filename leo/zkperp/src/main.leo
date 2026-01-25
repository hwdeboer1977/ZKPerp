// ZKPerp - Privacy-Preserving Perpetual DEX on Aleo
// With mock_usdc token integration

import mock_usdc.aleo;

program zkperp_v1.aleo {

    // ═══════════════════════════════════════════════════════════════════
    // SETUP INSTRUCTIONS
    // ═══════════════════════════════════════════════════════════════════
    //
    // Terminal 1: Start devnet
    // leo devnet --snarkos $(which snarkos) --snarkos-features test_network --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11 --clear-storage
    //
    // Terminal 2: Deploy and test
    // 1. Deploy mock_usdc first:
    //    cd mock_usdc && leo deploy --network testnet --broadcast --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11
    //
    // 2. Deploy zkperp:
    //    cd ../zkperp_v1 && leo deploy --network testnet --broadcast --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11
    //
    // 3. Mint USDC to user:
    //    cd ../mock_usdc && leo execute mint_public <USER_ADDRESS> 10000000000u128 --network testnet --broadcast --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11 --yes
    //
    // 4. Approve zkperp to spend USDC:
    //    leo execute approve zkperp_v1.aleo 10000000000u128 --network testnet --broadcast --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11 --yes
    //
    // 5. Set oracle price:
    //    cd ../zkperp_v1 && leo execute update_price 0field 10000000000u64 1u32 --network testnet --broadcast --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11 --yes
    //
    // 6. Add liquidity:
    //    leo execute add_liquidity 100000000u128 <USER_ADDRESS> --network testnet --broadcast --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11 --yes
    //
    // ═══════════════════════════════════════════════════════════════════

    @noupgrade
    async constructor() {}

    // ============== CONSTANTS ==============
    
    // ORACLE_ADMIN now updates price manually (will be updated later!)
    const ORACLE_ADMIN: address = aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px;

    const SCALE: u128 = 1_000_000u128;
    const MIN_MARGIN_BPS: u64 = 50_000u64;      // 5% min margin (20x max leverage)
    const LIQUIDATION_THRESHOLD_BPS: u64 = 10_000u64;  // 1% liquidation threshold
    const OPENING_FEE_BPS: u64 = 1_000u64;      // 0.1% opening fee
    const LIQUIDATION_REWARD_BPS: u64 = 5_000u64;  // 0.5% liquidation reward
    const MAX_OI_RATIO_BPS: u64 = 500_000u64;   // 50% max OI per side

    // ============== RECORDS ==============

    record Position {
        owner: address,
        position_id: field,
        is_long: bool,
        size_usdc: u64,
        collateral_usdc: u64,
        entry_price: u64,
        open_block: u32,
    }

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

    // ============== LP FUNCTIONS ==============

    // Add liquidity - transfers USDC from user to pool
    async transition add_liquidity(
        public deposit_amount: u128,  // u128 to match mock_usdc
        recipient: address,
    ) -> (LPToken, Future) {
        assert(deposit_amount >= 100u128);
        
        // Transfer USDC from user to this program
        let transfer_future: Future = mock_usdc.aleo/transfer_from(
            self.caller,        // owner (user)
            self.address,       // recipient (pool)
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
        // Await the USDC transfer
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

    // Remove liquidity - transfers USDC from pool back to user
    async transition remove_liquidity(
        lp_token: LPToken,
        public amount_to_burn: u64,
        public expected_usdc: u128,  // User calculates expected return off-chain
    ) -> (LPToken, Future) {
        assert(lp_token.amount >= amount_to_burn);
        
        // Transfer USDC from pool to user
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
        
        // Validate expected_usdc doesn't exceed what user is entitled to
        let max_usdc: u64 = (amount_to_burn * state.total_liquidity) / (state.total_lp_tokens + 1u64);
        assert(expected_usdc <= max_usdc);
        
        // Check pool has enough free liquidity
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

    // Open position - transfers collateral from user to pool
    async transition open_position(
        public collateral: u128,      // u128 to match mock_usdc
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
            transfer_future,
            collateral_u64,
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
        transfer_future: Future,
        collateral: u64,
        size: u64,
        is_long: bool,
        entry_price: u64,
        max_slippage: u64,
        nonce: field,
        opening_fee: u64,
    ) {
        // Await USDC transfer
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

    // Close position - calculates payout and transfers to trader
    async transition close_position(
        position: Position,
        public min_price: u64,
        public max_price: u64,
        public expected_payout: u128,  // User calculates expected payout off-chain
    ) -> Future {
        assert_eq(position.owner, self.signer);
        
        // Transfer payout from pool to trader (if positive)
        // We'll validate the amount in finalize
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
        
        // Validate expected_payout
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

    async transition liquidate(
        position: Position,
        public liquidator: address,
        public liquidator_reward: u128,
    ) -> Future {
        // Transfer reward to liquidator
        let transfer_future: Future = mock_usdc.aleo/transfer_public(
            liquidator,
            liquidator_reward
        );
        
        return finalize_liquidate(
            transfer_future,
            position.position_id,
            position.is_long,
            position.size_usdc,
            position.collateral_usdc,
            position.entry_price,
            position.open_block,
            liquidator,
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
        liquidator: address,
        liquidator_reward: u64,
    ) {
        transfer_future.await();
        
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
        
        // Margin ratio check - must be below liquidation threshold
        let margin_ratio_bps: i64 = (remaining_margin_signed * 1_000_000i64) / (size as i64 + 1i64);
        assert(margin_ratio_bps < LIQUIDATION_THRESHOLD_BPS as i64);
        
        // Validate liquidator reward
        let max_reward: u64 = (size * LIQUIDATION_REWARD_BPS) / 1_000_000u64;
        assert(liquidator_reward <= max_reward);
        
        // Get pool state
        let state: PoolState = Mapping::get(pool_state, 0field);
        
        // Calculate what goes to pool (remaining margin minus liquidator reward)
        let remaining_margin: u64 = remaining_margin_signed > 0i64 ? remaining_margin_signed as u64 : 0u64;
        let to_pool: u64 = remaining_margin > liquidator_reward ? remaining_margin - liquidator_reward : 0u64;
        
        let new_liquidity: u64 = state.total_liquidity - collateral + to_pool;
        
        // Update OI
        let long_oi_decrease: u64 = is_long ? size : 0u64;
        let short_oi_decrease: u64 = is_long ? 0u64 : size;
        
        let new_long_oi: u64 = state.long_open_interest > long_oi_decrease 
            ? state.long_open_interest - long_oi_decrease 
            : 0u64;
        let new_short_oi: u64 = state.short_open_interest > short_oi_decrease 
            ? state.short_open_interest - short_oi_decrease 
            : 0u64;
        
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
