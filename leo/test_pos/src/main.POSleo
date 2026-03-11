// test_pos.aleo — open_position test mirroring zkperp_v9.aleo exactly
//
// TOKEN NOTE:
//   test_usdcx_stablecoin.aleo is Circle-deployed on Aleo testnet/mainnet only.
//   On local devnet we use mock_usdc_0128.aleo instead — same interface
//   (mint_public / transfer_from_public / transfer_public), different program ID.
//   All oracle, orchestrator, OI cap, and slot-init logic is identical to v9.
//
// DEVNET TEST SEQUENCE:
//   Step 1. Deploy mock_usdc_0128.aleo (if not already live)
//   Step 2. leo execute mock_usdc_0128.aleo/mint_public <TRADER> <AMOUNT>u128
//   Step 3. leo execute test_pos.aleo/initialize_slots <TRADER>
//           → outputs: long_slot (slot_id:0), short_slot (slot_id:1), lp_slot
//   Step 4. leo execute test_pos.aleo/add_liquidity <lp_slot> <AMOUNT>u128 <TRADER>
//           → updated LPSlot (lp_amount > 0, is_open: true)
//   --- oracle + roles + pool seed required for open_position only ---
//   Step 5. leo execute test_pos.aleo/seed_roles <ORACLE_ADMIN> <ORCHESTRATOR>
//   Step 6. leo execute test_pos.aleo/seed_oracle 0field <PRICE>u64 <TIMESTAMP>u32
//   Step 7. leo execute test_pos.aleo/seed_pool <LIQUIDITY>u64
//   Step 8a (long):  leo execute test_pos.aleo/open_position <long_slot_record>  ... is_long:true
//   Step 8b (short): leo execute test_pos.aleo/open_position <short_slot_record> ... is_long:false
//
// EXAMPLE VALUES (6 decimals):
//   collateral:   100_000_000u128   (100 USDC)
//   size:         500_000u64        (0.5 USDC notional — 5x leverage example)
//   entry_price:  50_000_000_000u64 ($50,000)
//   max_slippage: 500_000_000u64    ($500 tolerance)
//   nonce:        1field / 2field   (unique per call)
//   recipient:    <TRADER>
//   orchestrator: <ORCHESTRATOR — must match roles[1u8]>

import mock_usdc_0128.aleo;

program test_pos.aleo {

    // ─────────────────────────────────────────────────────────────
    // CONSTANTS — mirrors zkperp_v9 exactly
    // ─────────────────────────────────────────────────────────────
    const OPENING_FEE_BPS: u64   = 1_000u64;   // 0.1%  (v9 value)
    const MAX_OI_RATIO_BPS: u64  = 500_000u64; // 50%

    // ─────────────────────────────────────────────────────────────
    // MAPPINGS
    // ─────────────────────────────────────────────────────────────

    // Key 0u8 = oracle admin, Key 1u8 = orchestrator
    mapping roles: u8 => address;

    // One-time slot init guard (mirrors v9)
    mapping slots_initialized: address => bool;

    // Oracle price feed (mirrors v9 oracle_prices)
    mapping oracle_prices: field => PriceData;

    // Pool state (mirrors v9 — needed for OI cap checks)
    mapping pool_state: field => PoolState;

    // Position open block (for borrow fee reference, mirrors v9)
    mapping position_open_blocks: field => u32;

    // Replay protection
    mapping used_nonces: field => bool;

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
        slot_id: u8,        // 0 = LONG slot only, 1 = SHORT slot only
        is_open: bool,
        position_id: field,
        is_long: bool,
        size_usdc: u64,
        collateral_usdc: u64,
        entry_price: u64,
    }

    record LiquidationAuth {
        owner: address,       // orchestrator
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

    // ─────────────────────────────────────────────────────────────
    // CONSTRUCTOR
    // Sets deployer as oracle admin (roles[0]) and orchestrator (roles[1]).
    // Call seed_roles() manually on devnet if @custom constructor is unsupported.
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
        // Only allow seeding once
        let already_set: bool = Mapping::contains(roles, 0u8);
        assert(!already_set);
        Mapping::set(roles, 0u8, oracle_admin);
        Mapping::set(roles, 1u8, orchestrator);
    }

    // ─────────────────────────────────────────────────────────────
    // ORACLE — seed price before open_position (same as v9 update_price)
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
    // SEED POOL — seed initial pool liquidity so OI cap checks pass
    // Call with enough total_liquidity to cover your test positions.
    // e.g. seed_pool 10_000_000u64 (10,000 USDCx @ 6 decimals)
    // ─────────────────────────────────────────────────────────────

    async transition seed_pool(
        public total_liquidity: u64,
    ) -> Future {
        return finalize_seed_pool(total_liquidity);
    }

    async function finalize_seed_pool(total_liquidity: u64) {
        // Only seed if pool is uninitialised
        let exists: bool = Mapping::contains(pool_state, 0field);
        assert(!exists);
        Mapping::set(pool_state, 0field, PoolState {
            total_liquidity: total_liquidity,
            total_lp_tokens: total_liquidity,
            long_open_interest: 0u64,
            short_open_interest: 0u64,
            accumulated_fees: 0u64,
        });
    }

    // ─────────────────────────────────────────────────────────────
    // INITIALIZE SLOTS — identical to zkperp_v9
    // Mint 2 PositionSlots + 1 LPSlot to recipient (once per address).
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
    // ADD LIQUIDITY — identical to zkperp_v9.aleo
    //
    // Consumes LPSlot, returns updated LPSlot with increased lp_amount.
    // No oracle, no roles check — simplest function to test record passing.
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

        return (updated_slot, finalize_add_liquidity(transfer_future, deposit_u64));
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

    // ─────────────────────────────────────────────────────────────
    // OPEN POSITION — identical logic to zkperp_v9.aleo
    //
    // For LONG:  pass long_slot  (slot_id: 0) + is_long: true
    // For SHORT: pass short_slot (slot_id: 1) + is_long: false
    // ─────────────────────────────────────────────────────────────

    async transition open_position(
        slot: PositionSlot,             // CONSUMED — must be empty (is_open: false)
        public collateral: u128,
        public size: u64,
        public is_long: bool,
        public entry_price: u64,
        public max_slippage: u64,
        nonce: field,
        recipient: address,
        public orchestrator: address,
    ) -> (PositionSlot, LiquidationAuth, Future) {

        // Slot must be empty and owned by signer
        assert(!slot.is_open);
        assert_eq(slot.owner, self.signer);

        // Enforce slot direction: long must use slot 0, short must use slot 1
        let expected_slot_id: u8 = is_long ? 0u8 : 1u8;
        assert_eq(slot.slot_id, expected_slot_id);

        let collateral_u64: u64 = collateral as u64;

        // Validate leverage (size / collateral <= 20x)
        let leverage_scaled: u64 = (size * 100u64) / collateral_u64;
        assert(leverage_scaled <= 2000u64);
        assert(size >= 100u64);

        // Calculate opening fee (0.1%, same as v9)
        let opening_fee: u64 = (size * OPENING_FEE_BPS) / 1_000_000u64;
        let collateral_after_fee: u64 = collateral_u64 - opening_fee;

        // Transfer collateral from trader to pool
        // On devnet: mock_usdc_0128.aleo  |  On testnet/mainnet: test_usdcx_stablecoin.aleo
        let transfer_future: Future = mock_usdc_0128.aleo/transfer_from_public(
            self.caller,
            self.address,
            collateral
        );

        // Generate position ID (same hash as v9)
        let id_input: PositionIdInput = PositionIdInput {
            recipient: recipient,
            nonce: nonce,
            size: size,
        };
        let position_id: field = BHP256::hash_to_field(id_input);

        // Filled PositionSlot → trader
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

        // LiquidationAuth → orchestrator
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

        // Verify orchestrator matches roles mapping (mirrors v9)
        let expected_orchestrator: address = Mapping::get(roles, 1u8);
        assert_eq(orchestrator, expected_orchestrator);

        // Replay protection
        let nonce_used: bool = Mapping::get_or_use(used_nonces, nonce, false);
        assert(!nonce_used);
        Mapping::set(used_nonces, nonce, true);

        // Validate entry_price against oracle with slippage (mirrors v9)
        let price_data: PriceData = Mapping::get(oracle_prices, 0field);
        let oracle_price: u64 = price_data.price;
        let higher_price: u64 = entry_price > oracle_price ? entry_price : oracle_price;
        let lower_price: u64 = entry_price > oracle_price ? oracle_price : entry_price;
        let price_diff: u64 = higher_price - lower_price;
        assert(price_diff <= max_slippage);

        // Store open block
        Mapping::set(position_open_blocks, position_id, block.height);

        // Get/init pool state
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

        // Update OI (mirrors v9)
        let new_long_oi: u64 = state.long_open_interest + (is_long ? size : 0u64);
        let new_short_oi: u64 = state.short_open_interest + (is_long ? 0u64 : size);

        // OI cap check (mirrors v9)
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
}
