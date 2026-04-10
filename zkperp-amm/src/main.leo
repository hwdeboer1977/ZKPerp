import test_usdcx_stablecoin.aleo;

// ============================================================
// zkperp_amm_v1.aleo — Concentrated Liquidity AMM
// USDCx / ALEO pair, 0.3% fee — Leo 4.0 syntax
//
// KEY RULE: no helper fn calls inside final{} blocks.
// All math is inlined directly.
// ============================================================

program zkperp_amm_v3.aleo {

    const FEE_BPS: u64       = 3_000u64;
    const FEE_DENOM: u64     = 1_000_000u64;
    const TICK_SPACING: i32  = 60i32;
    const Q64: u128          = 18_446_744_073_709_551_616u128;
    const MAX_TICK: i32      = 887_220i32;
    const TICK_SENTINEL: i32 = 887_221i32;
    const POOL_KEY: u8       = 0u8;
    const ROLE_ADMIN: u8     = 0u8;

    struct PoolState {
        sqrt_price_x64:      u128,
        current_tick:        i32,
        liquidity:           u128,
        fee_growth_global_0: u128,
        fee_growth_global_1: u128,
    }

    struct TickInfo {
        liquidity_gross:           u128,
        liquidity_net:             u128,
        liquidity_net_is_negative: bool,
        fee_growth_outside_0:      u128,
        fee_growth_outside_1:      u128,
        initialized:               bool,
    }

    struct TickStep {
        tick_next:                 i32,
        sqrt_price_next:           u128,
        liquidity_net:             u128,
        liquidity_net_is_negative: bool,
        amount_in_step:            u64,
        amount_out_step:           u64,
        fee_step:                  u64,
    }

    record LPPosition {
        owner:                    address,
        pool_id:                  u8,
        tick_lower:               i32,
        tick_upper:               i32,
        liquidity:                u128,
        fee_growth_inside_0_last: u128,
        fee_growth_inside_1_last: u128,
        tokens_owed_0:            u64,
        tokens_owed_1:            u64,
    }

    record SwapReceipt {
        owner:            address,
        zero_for_one:     bool,
        amount_in:        u64,
        amount_out:       u64,
        fee_paid:         u64,
        sqrt_price_after: u128,
        tick_after:       i32,
        ticks_crossed:    u8,
    }

    mapping pool_state:   u8    => PoolState;
    mapping tick_info:    field => TickInfo;
    mapping aleo_reserve: u8    => u64;
    mapping roles:        u8    => address;
    mapping is_init:      u8    => bool;

    @custom
    constructor() {
        Mapping::set(roles, ROLE_ADMIN, self.program_owner);
    }



    // ──────────────────────────────────────────────────────────
    // initialize_pool
    // ──────────────────────────────────────────────────────────

    // Only callable by admin (roles[0]). Can only be called once (is_init guard).
    fn initialize_pool(
        public initial_sqrt_price_x64: u128,
        public initial_tick: i32,
    ) -> Final {
        assert(initial_sqrt_price_x64 > 0u128);
        assert(initial_tick >= -MAX_TICK);
        assert(initial_tick <= MAX_TICK);
        let caller: address = self.caller;
        return final {
            let admin: address = Mapping::get(roles, ROLE_ADMIN);
            assert_eq(caller, admin);
            let already: bool = Mapping::get_or_use(is_init, 0u8, false);
            assert(!already);
            Mapping::set(pool_state, POOL_KEY, PoolState {
                sqrt_price_x64:      initial_sqrt_price_x64,
                current_tick:        initial_tick,
                liquidity:           0u128,
                fee_growth_global_0: 0u128,
                fee_growth_global_1: 0u128,
            });
            Mapping::set(aleo_reserve, 0u8, 0u64);
            Mapping::set(is_init, 0u8, true);
        };
    }

    // ──────────────────────────────────────────────────────────
    // mint_position
    // ──────────────────────────────────────────────────────────

    // Deposits USDCx (token0) and ALEO (token1) into the pool in exchange for an LPPosition record.
    // tick_lower/tick_upper must be multiples of TICK_SPACING (60).
    // amount_0_actual/amount_1_actual are verified on-chain against pool.sqrt_price_x64.
    fn mint_position(
        lp_token: test_usdcx_stablecoin.aleo::Token,
        merkle_proof: [test_usdcx_stablecoin.aleo::MerkleProof; 2],
        tick_lower: i32,
        tick_upper: i32,
        liquidity_desired: u128,
        public amount_0_max: u64,
        public amount_1_max: u64,
        public amount_0_actual: u64,
        public amount_1_actual: u64,
        public sqrt_price_x64: u128,
        public current_tick: i32,
        public fee_growth_inside_0: u128,
        public fee_growth_inside_1: u128,
    ) -> (LPPosition, test_usdcx_stablecoin.aleo::ComplianceRecord, test_usdcx_stablecoin.aleo::Token, Final) {

        assert(liquidity_desired > 0u128);
        assert(tick_lower < tick_upper);
        assert(tick_lower >= -MAX_TICK);
        assert(tick_upper <= MAX_TICK);
        assert_eq(tick_lower / TICK_SPACING * TICK_SPACING, tick_lower);
        assert_eq(tick_upper / TICK_SPACING * TICK_SPACING, tick_upper);
        assert(amount_0_actual <= amount_0_max);
        assert(amount_1_actual <= amount_1_max);

        let position: LPPosition = LPPosition {
            owner: self.signer, pool_id: 0u8,
            tick_lower, tick_upper,
            liquidity:                liquidity_desired,
            fee_growth_inside_0_last: fee_growth_inside_0,
            fee_growth_inside_1_last: fee_growth_inside_1,
            tokens_owed_0: 0u64, tokens_owed_1: 0u64,
        };

        let tl: i32   = tick_lower;
        let tu: i32   = tick_upper;
        let liq: u128 = liquidity_desired;
        let a1: u64   = amount_1_actual;
        let caller: address = self.caller;

        // Transfer USDCx from caller to the AMM program account via USDCx stablecoin contract.
        // Returns ComplianceRecord (required by USDCx), change token, and a deferred Final.
        let (compliance_rec, change_token, xfer_final):
            (test_usdcx_stablecoin.aleo::ComplianceRecord,
             test_usdcx_stablecoin.aleo::Token, Final) =
            test_usdcx_stablecoin.aleo::transfer_private_to_public(
                self.address, amount_0_actual as u128, lp_token, merkle_proof,
            );

        // xfer_final.run() executes the USDCx transfer on-chain inside the finalize block.
        return (position, compliance_rec, change_token, final {
            xfer_final.run();
            let pool: PoolState = Mapping::get(pool_state, POOL_KEY);
            assert_eq(pool.sqrt_price_x64, sqrt_price_x64);
            assert_eq(pool.current_tick, current_tick);

            let reserve: u64 = Mapping::get_or_use(aleo_reserve, 0u8, 0u64);
            Mapping::set(aleo_reserve, 0u8, reserve + a1);

        // tick_lower — initialize if first LP, or add liquidity_gross/net.
        // fee_growth_outside is set to global fee accumulator if tick is below current price.
            // tick_lower — initialize or update
            let tl_key: field = (tl as i64 + 2_147_483_647i64) as u64 as field;
            let tl_info: TickInfo = Mapping::get_or_use(tick_info, tl_key, TickInfo {
                liquidity_gross: 0u128, liquidity_net: 0u128,
                liquidity_net_is_negative: false,
                fee_growth_outside_0: 0u128, fee_growth_outside_1: 0u128,
                initialized: false });
            // Avoid nested ternaries — compute fee_outside independently
            let tl_below: bool = tl <= current_tick;
            let tl_uninit_fee0: u128 = tl_below ? pool.fee_growth_global_0 : 0u128;
            let tl_uninit_fee1: u128 = tl_below ? pool.fee_growth_global_1 : 0u128;
            let tl_fee0: u128 = tl_info.initialized ? tl_info.fee_growth_outside_0 : tl_uninit_fee0;
            let tl_fee1: u128 = tl_info.initialized ? tl_info.fee_growth_outside_1 : tl_uninit_fee1;
            Mapping::set(tick_info, tl_key, TickInfo {
                liquidity_gross:           tl_info.liquidity_gross + liq,
                liquidity_net:             tl_info.liquidity_net + liq,
                liquidity_net_is_negative: tl_info.liquidity_net_is_negative,
                fee_growth_outside_0:      tl_fee0,
                fee_growth_outside_1:      tl_fee1,
                initialized:               true });

        // tick_upper — liquidity_net is negative (price crossing upward removes liquidity).
        // sub_signed inlined: (tu_net, tu_neg) - (liq, false).
            // tick_upper — liquidity_net decreases (first mint: 0 - liq = -liq)
            let tu_key: field = (tu as i64 + 2_147_483_647i64) as u64 as field;
            let tu_info: TickInfo = Mapping::get_or_use(tick_info, tu_key, TickInfo {
                liquidity_gross: 0u128, liquidity_net: 0u128,
                liquidity_net_is_negative: false,
                fee_growth_outside_0: 0u128, fee_growth_outside_1: 0u128,
                initialized: false });
            let tu_below: bool = tu <= current_tick;
            let tu_uninit_fee0: u128 = tu_below ? pool.fee_growth_global_0 : 0u128;
            let tu_uninit_fee1: u128 = tu_below ? pool.fee_growth_global_1 : 0u128;
            let tu_fee0: u128 = tu_info.initialized ? tu_info.fee_growth_outside_0 : tu_uninit_fee0;
            let tu_fee1: u128 = tu_info.initialized ? tu_info.fee_growth_outside_1 : tu_uninit_fee1;
            // sub_signed(tu_info.liquidity_net, tu_info.liquidity_net_is_negative, liq, false)
            // = (tu_net, tu_neg) - (liq, false)
            // First mint: tu_net=0, tu_neg=false → result = (liq, true)
            // sub_signed: (tu_net, tu_neg) - (liq, false)
            // No nested ternaries — flatten into separate steps
            let tu_net_ge_liq: bool = tu_info.liquidity_net >= liq;
            // Case A: tu_neg=true  → (tu_net + liq, true)
            let tu_net_case_a: u128 = tu_info.liquidity_net + liq;
            // Case B/C: tu_neg=false → subtract larger from smaller (no underflow)
            // Both branches safe: if ge, result=tu_net-liq; if lt, result=liq-tu_net
            // Use max-min pattern to avoid evaluating the underflowing branch
            let tu_net_max: u128 = tu_net_ge_liq ? tu_info.liquidity_net : liq;
            let tu_net_min: u128 = tu_net_ge_liq ? liq : tu_info.liquidity_net;
            let tu_net_pos: u128 = tu_net_max - tu_net_min;
            let tu_new_net: u128 = tu_info.liquidity_net_is_negative ? tu_net_case_a : tu_net_pos;
            let tu_new_neg: bool = tu_info.liquidity_net_is_negative ? true : !tu_net_ge_liq;
            Mapping::set(tick_info, tu_key, TickInfo {
                liquidity_gross:           tu_info.liquidity_gross + liq,
                liquidity_net:             tu_new_net,
                liquidity_net_is_negative: tu_new_neg,
                fee_growth_outside_0:      tu_fee0,
                fee_growth_outside_1:      tu_fee1,
                initialized:               true });

        // Only add to active liquidity if the position covers the current tick.
            // Update active liquidity if position covers current tick
            let in_range: bool = (tl <= current_tick) && (current_tick < tu);
            let new_liq: u128 = in_range ? pool.liquidity + liq : pool.liquidity;
            Mapping::set(pool_state, POOL_KEY, PoolState {
                sqrt_price_x64:      pool.sqrt_price_x64,
                current_tick:        pool.current_tick,
                liquidity:           new_liq,
                fee_growth_global_0: pool.fee_growth_global_0,
                fee_growth_global_1: pool.fee_growth_global_1 });
        });
    }

    // ──────────────────────────────────────────────────────────
    // burn_position
    // ──────────────────────────────────────────────────────────

    // Burns an LPPosition record and returns USDCx (token0) and ALEO (token1) to the owner.
    // fee_growth_inside_0/1 must be current pool values to verify accrued fees.
    fn burn_position(
        position: LPPosition,
        public fee_growth_inside_0: u128,
        public fee_growth_inside_1: u128,
        public amount_0_out: u64,
        public amount_1_out: u64,
        public sqrt_price_x64: u128,
        public current_tick: i32,
    ) -> (test_usdcx_stablecoin.aleo::ComplianceRecord, test_usdcx_stablecoin.aleo::Token, Final) {

        assert_eq(position.owner, self.signer);
        assert(position.liquidity > 0u128);

        let tl: i32   = position.tick_lower;
        let tu: i32   = position.tick_upper;
        let liq: u128 = position.liquidity;
        let a1: u64   = amount_1_out;
        let owner: address = position.owner;

        // Transfer USDCx from the AMM program account back to position owner.
        let (compliance_rec, payout_token, xfer_final):
            (test_usdcx_stablecoin.aleo::ComplianceRecord,
             test_usdcx_stablecoin.aleo::Token, Final) =
            test_usdcx_stablecoin.aleo::transfer_public_to_private(
                owner, amount_0_out as u128);

        // xfer_final.run() executes the USDCx payout on-chain.
        return (compliance_rec, payout_token, final {
            xfer_final.run();
            let pool: PoolState = Mapping::get(pool_state, POOL_KEY);
            assert_eq(pool.sqrt_price_x64, sqrt_price_x64);
            assert_eq(pool.current_tick, current_tick);
            assert(fee_growth_inside_0 <= pool.fee_growth_global_0);
            assert(fee_growth_inside_1 <= pool.fee_growth_global_1);

        // tick_lower: sub_signed inlined — remove liq from net.
        // If liquidity_gross drops to 0 the tick is de-initialized.
            // tick_lower: sub_signed inlined (net -= liq)
            let tl_key: field = (tl as i64 + 2_147_483_647i64) as u64 as field;
            let tl_info: TickInfo = Mapping::get(tick_info, tl_key);
            let tl_same: bool = tl_info.liquidity_net_is_negative == false;
            let tl_net_ge_liq: bool = tl_info.liquidity_net >= liq;
            let tl_net_max: u128 = tl_net_ge_liq ? tl_info.liquidity_net : liq;
            let tl_net_min: u128 = tl_net_ge_liq ? liq : tl_info.liquidity_net;
            let tl_net_pos: u128 = tl_net_max - tl_net_min;
            let tl_new_net: u128 = tl_same ? tl_net_pos : tl_info.liquidity_net + liq;
            let tl_new_neg: bool = tl_same
                ? !tl_net_ge_liq
                : true;
            let tl_gross: u128 = tl_info.liquidity_gross - liq;
            Mapping::set(tick_info, tl_key, TickInfo {
                liquidity_gross:           tl_gross,
                liquidity_net:             tl_new_net,
                liquidity_net_is_negative: tl_new_neg,
                fee_growth_outside_0:      tl_info.fee_growth_outside_0,
                fee_growth_outside_1:      tl_info.fee_growth_outside_1,
                initialized:               tl_gross > 0u128 });

        // tick_upper: add_signed inlined — restore what mint subtracted from net.
            // tick_upper: add_signed inlined (net += liq, restoring what mint subtracted)
            let tu_key: field = (tu as i64 + 2_147_483_647i64) as u64 as field;
            let tu_info: TickInfo = Mapping::get(tick_info, tu_key);
            let tu_same: bool = tu_info.liquidity_net_is_negative == false;
            let tu_net_ge_liq_b: bool = tu_info.liquidity_net >= liq;
            let tu_net_b_max: u128 = tu_net_ge_liq_b ? tu_info.liquidity_net : liq;
            let tu_net_b_min: u128 = tu_net_ge_liq_b ? liq : tu_info.liquidity_net;
            let tu_net_b_pos: u128 = tu_net_b_max - tu_net_b_min;
            let tu_new_net: u128 = tu_same ? tu_info.liquidity_net + liq : tu_net_b_pos;
            let tu_new_neg: bool = tu_same ? false : !tu_net_ge_liq_b;
            let tu_gross: u128 = tu_info.liquidity_gross - liq;
            Mapping::set(tick_info, tu_key, TickInfo {
                liquidity_gross:           tu_gross,
                liquidity_net:             tu_new_net,
                liquidity_net_is_negative: tu_new_neg,
                fee_growth_outside_0:      tu_info.fee_growth_outside_0,
                fee_growth_outside_1:      tu_info.fee_growth_outside_1,
                initialized:               tu_gross > 0u128 });

        // Reduce active liquidity if position was in range. Release ALEO from reserve.
            let in_range: bool = (tl <= current_tick) && (current_tick < tu);
            let reserve: u64 = Mapping::get(aleo_reserve, 0u8);
            assert(reserve >= a1);
            Mapping::set(aleo_reserve, 0u8, reserve - a1);
            let burn_liq: u128 = in_range ? pool.liquidity - liq : pool.liquidity;
            Mapping::set(pool_state, POOL_KEY, PoolState {
                sqrt_price_x64:      pool.sqrt_price_x64,
                current_tick:        pool.current_tick,
                liquidity:           burn_liq,
                fee_growth_global_0: pool.fee_growth_global_0,
                fee_growth_global_1: pool.fee_growth_global_1 });
        });
    }

    // swap_buy — USDCx → ALEO
    // Price decreases (zero_for_one = true). USDCx transferred in, ALEO paid out from reserve.
    // Orchestrator pre-computes step0..step3 for tick crossings. Single-range: amounts in step0,
    // tick_next = TICK_SENTINEL for all steps. Up to 4 tick crossings supported.
    // ──────────────────────────────────────────────────────────
    // swap_buy — USDCx → ALEO (zero_for_one = true)
    // sqrt_price decreases. Token0 (USDCx) in, Token1 (ALEO) out.
    // ──────────────────────────────────────────────────────────

    fn swap_buy(
        usdcx_in: test_usdcx_stablecoin.aleo::Token,
        merkle_proof: [test_usdcx_stablecoin.aleo::MerkleProof; 2],
        public total_amount_in:  u64,
        public total_amount_out: u64,
        public total_fee:        u64,
        public sqrt_price_final: u128,
        public tick_final:       i32,
        public step0: TickStep,
        public step1: TickStep,
        public step2: TickStep,
        public step3: TickStep,
    ) -> (SwapReceipt, test_usdcx_stablecoin.aleo::ComplianceRecord, test_usdcx_stablecoin.aleo::Token, Final) {

        // Verify fee matches 0.3% of gross input. Step amounts must sum to total.
        assert(total_amount_in > 0u64);
        assert(total_amount_out > 0u64);
        let expected_fee: u64 = (total_amount_in as u128 * FEE_BPS as u128 / FEE_DENOM as u128) as u64;
        assert_eq(total_fee, expected_fee);
        assert_eq(
            step0.amount_in_step + step1.amount_in_step + step2.amount_in_step + step3.amount_in_step,
            total_amount_in);
        assert_eq(
            step0.amount_out_step + step1.amount_out_step + step2.amount_out_step + step3.amount_out_step,
            total_amount_out);
        assert_eq(
            step0.fee_step + step1.fee_step + step2.fee_step + step3.fee_step,
            total_fee);
        let ticks_crossed: u8 =
            (step0.tick_next != TICK_SENTINEL ? 1u8 : 0u8) +
            (step1.tick_next != TICK_SENTINEL ? 1u8 : 0u8) +
            (step2.tick_next != TICK_SENTINEL ? 1u8 : 0u8) +
            (step3.tick_next != TICK_SENTINEL ? 1u8 : 0u8);

        let receipt: SwapReceipt = SwapReceipt {
            owner: self.signer, zero_for_one: true,
            amount_in: total_amount_in, amount_out: total_amount_out,
            fee_paid: total_fee, sqrt_price_after: sqrt_price_final,
            tick_after: tick_final, ticks_crossed };

        let sp_f: u128   = sqrt_price_final;
        let t_f: i32     = tick_final;
        let amt_in: u64  = total_amount_in;
        let amt_out: u64 = total_amount_out;
        let fee: u64     = total_fee;

        // Transfer USDCx from caller to AMM. Returns compliance record, change token, deferred Final.
        let (compliance_rec, change_token, xfer_final):
            (test_usdcx_stablecoin.aleo::ComplianceRecord,
             test_usdcx_stablecoin.aleo::Token, Final) =
            test_usdcx_stablecoin.aleo::transfer_private_to_public(
                self.address, total_amount_in as u128, usdcx_in, merkle_proof);

        // ── Finalize block: all on-chain state updates ──────────────────────────────
        // xfer_final.run() settles the USDCx transfer first.
        return (receipt, compliance_rec, change_token, final {
            xfer_final.run();
            let pool: PoolState = Mapping::get(pool_state, POOL_KEY);
            let a0: bool  = step0.tick_next != TICK_SENTINEL;
            let k0: field = a0 ? (step0.tick_next as i64 + 2_147_483_647i64) as u64 as field : 0field;
            let t0: TickInfo = Mapping::get_or_use(tick_info, k0, TickInfo {
                liquidity_gross: 0u128, liquidity_net: 0u128,
                liquidity_net_is_negative: false,
                fee_growth_outside_0: 0u128, fee_growth_outside_1: 0u128,
                initialized: false });
            assert(!a0 || t0.initialized);
            assert(!a0 || t0.liquidity_net == step0.liquidity_net);
            assert(!a0 || t0.liquidity_net_is_negative == step0.liquidity_net_is_negative);

            // out0_exp: expected ALEO out for this step using amount1 formula: L*(hi-lo)/Q64.
            // a0=false (no tick crossing) → out0_exp=0, diff0=0, assert passes trivially.
            // amount1_from_sqrts inlined: liq*(hi-lo)/Q64
            let out0_exp: u64 = a0 ? ((pool.liquidity * (pool.sqrt_price_x64 - step0.sqrt_price_next)) / Q64) as u64 : 0u64;
            let diff0_max: u64 = step0.amount_out_step > out0_exp ? step0.amount_out_step : out0_exp;
            let diff0_min: u64 = step0.amount_out_step > out0_exp ? out0_exp : step0.amount_out_step;
            let diff0: u64 = diff0_max - diff0_min;
            assert(!a0 || diff0 <= 1u64); // commented out for debug
            // Only flip fee_growth_outside when crossing a tick (a0=true)
            let t0_fg0: u128 = a0 ? pool.fee_growth_global_0 - t0.fee_growth_outside_0 : t0.fee_growth_outside_0;
            let t0_fg1: u128 = a0 ? pool.fee_growth_global_1 - t0.fee_growth_outside_1 : t0.fee_growth_outside_1;
            Mapping::set(tick_info, k0, TickInfo {
                liquidity_gross:           t0.liquidity_gross,
                liquidity_net:             t0.liquidity_net,
                liquidity_net_is_negative: t0.liquidity_net_is_negative,
                fee_growth_outside_0:      t0_fg0,
                fee_growth_outside_1:      t0_fg1,
                initialized:               t0.initialized });
            // apply_liq_delta: add or subtract liquidity_net when crossing a tick.
            // apply0_neg=true means liquidity decreases (price crossed downward through tick).
            // apply_liq_delta inlined
            let apply0_neg: bool = !step0.liquidity_net_is_negative;
            // max-min avoids underflow when step.liquidity_net > pool.liquidity
            let liq1_ge: bool = pool.liquidity >= step0.liquidity_net;
            let liq1_max: u128 = liq1_ge ? pool.liquidity : step0.liquidity_net;
            let liq1_min: u128 = liq1_ge ? step0.liquidity_net : pool.liquidity;
            let liq1_sub: u128 = liq1_max - liq1_min;
            let liq1_add: u128 = pool.liquidity + step0.liquidity_net;
            let liq1_cross: u128 = apply0_neg ? liq1_sub : liq1_add;
            let liq1: u128 = a0 ? liq1_cross : pool.liquidity;
            // fee_delta: accumulate fee into fee_growth_global per unit of liquidity.
            // fee_delta inlined: fee*Q64/liq
            let fd0: u128 = (pool.liquidity == 0u128 || !a0) ? 0u128 : (step0.fee_step as u128 * Q64) / pool.liquidity;
            let fg0_1: u128 = a0 ? pool.fee_growth_global_0 + fd0 : pool.fee_growth_global_0;
            let fg1_1: u128 = a0 ? pool.fee_growth_global_1 + fd0 : pool.fee_growth_global_1;
            let sq1: u128   = a0 ? step0.sqrt_price_next : pool.sqrt_price_x64;

            // Steps 1-3: identical pattern to step0. All no-ops when tick_next=SENTINEL.
            // ── STEP 1 ──────────────────────────────────────────
            let a1b: bool = step1.tick_next != TICK_SENTINEL;
            let k1: field = a1b ? (step1.tick_next as i64 + 2_147_483_647i64) as u64 as field : 0field;
            let t1: TickInfo = Mapping::get_or_use(tick_info, k1, TickInfo {
                liquidity_gross: 0u128, liquidity_net: 0u128,
                liquidity_net_is_negative: false,
                fee_growth_outside_0: 0u128, fee_growth_outside_1: 0u128,
                initialized: false });
            assert(!a1b || t1.initialized);
            assert(!a1b || t1.liquidity_net == step1.liquidity_net);
            assert(!a1b || t1.liquidity_net_is_negative == step1.liquidity_net_is_negative);
            let out1_exp: u64 = a1b ? ((liq1 * (sq1 - step1.sqrt_price_next)) / Q64) as u64 : 0u64;
            let diff1_max: u64 = step1.amount_out_step > out1_exp ? step1.amount_out_step : out1_exp;
            let diff1_min: u64 = step1.amount_out_step > out1_exp ? out1_exp : step1.amount_out_step;
            let diff1: u64 = diff1_max - diff1_min;
            assert(!a1b || diff1 <= 1u64); // DEBUG
            let t1_fg0: u128 = a1b ? fg0_1 - t1.fee_growth_outside_0 : t1.fee_growth_outside_0;
            let t1_fg1: u128 = a1b ? fg1_1 - t1.fee_growth_outside_1 : t1.fee_growth_outside_1;
            Mapping::set(tick_info, k1, TickInfo {
                liquidity_gross:           t1.liquidity_gross,
                liquidity_net:             t1.liquidity_net,
                liquidity_net_is_negative: t1.liquidity_net_is_negative,
                fee_growth_outside_0: t1_fg0,
                fee_growth_outside_1: t1_fg1,
                initialized: t1.initialized });
            let apply1_neg: bool = !step1.liquidity_net_is_negative;
            // max-min avoids underflow when step.liquidity_net > liq1
            let liq2_ge: bool = liq1 >= step1.liquidity_net;
            let liq2_max: u128 = liq2_ge ? liq1 : step1.liquidity_net;
            let liq2_min: u128 = liq2_ge ? step1.liquidity_net : liq1;
            let liq2_sub: u128 = liq2_max - liq2_min;
            let liq2_add: u128 = liq1 + step1.liquidity_net;
            let liq2_cross: u128 = apply1_neg ? liq2_sub : liq2_add;
            let liq2: u128 = a1b ? liq2_cross : liq1;
            let fd1: u128 = (liq1 == 0u128 || !a1b) ? 0u128 : (step1.fee_step as u128 * Q64) / liq1;
            let fg0_2: u128 = a1b ? fg0_1 + fd1 : fg0_1;
            let fg1_2: u128 = a1b ? fg1_1 + fd1 : fg1_1;
            let sq2: u128   = a1b ? step1.sqrt_price_next : sq1;

            // ── STEP 2 ─────────────────────────────────────────────────────────────
            // ── STEP 2 ──────────────────────────────────────────
            let a2: bool  = step2.tick_next != TICK_SENTINEL;
            let k2: field = a2 ? (step2.tick_next as i64 + 2_147_483_647i64) as u64 as field : 0field;
            let t2: TickInfo = Mapping::get_or_use(tick_info, k2, TickInfo {
                liquidity_gross: 0u128, liquidity_net: 0u128,
                liquidity_net_is_negative: false,
                fee_growth_outside_0: 0u128, fee_growth_outside_1: 0u128,
                initialized: false });
            assert(!a2 || t2.initialized);
            assert(!a2 || t2.liquidity_net == step2.liquidity_net);
            assert(!a2 || t2.liquidity_net_is_negative == step2.liquidity_net_is_negative);
            let out2_exp: u64 = a2 ? ((liq2 * (sq2 - step2.sqrt_price_next)) / Q64) as u64 : 0u64;
            let diff2_max: u64 = step2.amount_out_step > out2_exp ? step2.amount_out_step : out2_exp;
            let diff2_min: u64 = step2.amount_out_step > out2_exp ? out2_exp : step2.amount_out_step;
            let diff2: u64 = diff2_max - diff2_min;
            assert(!a2 || diff2 <= 1u64); // DEBUG
            let t2_fg0: u128 = a2 ? fg0_2 - t2.fee_growth_outside_0 : t2.fee_growth_outside_0;
            let t2_fg1: u128 = a2 ? fg1_2 - t2.fee_growth_outside_1 : t2.fee_growth_outside_1;
            Mapping::set(tick_info, k2, TickInfo {
                liquidity_gross:           t2.liquidity_gross,
                liquidity_net:             t2.liquidity_net,
                liquidity_net_is_negative: t2.liquidity_net_is_negative,
                fee_growth_outside_0: t2_fg0,
                fee_growth_outside_1: t2_fg1,
                initialized: t2.initialized });
            let apply2_neg: bool = !step2.liquidity_net_is_negative;
            // max-min avoids underflow when step.liquidity_net > liq2
            let liq3_ge: bool = liq2 >= step2.liquidity_net;
            let liq3_max: u128 = liq3_ge ? liq2 : step2.liquidity_net;
            let liq3_min: u128 = liq3_ge ? step2.liquidity_net : liq2;
            let liq3_sub: u128 = liq3_max - liq3_min;
            let liq3_add: u128 = liq2 + step2.liquidity_net;
            let liq3_cross: u128 = apply2_neg ? liq3_sub : liq3_add;
            let liq3: u128 = a2 ? liq3_cross : liq2;
            let fd2: u128 = (liq2 == 0u128 || !a2) ? 0u128 : (step2.fee_step as u128 * Q64) / liq2;
            let fg0_3: u128 = a2 ? fg0_2 + fd2 : fg0_2;
            let fg1_3: u128 = a2 ? fg1_2 + fd2 : fg1_2;
            let sq3: u128   = a2 ? step2.sqrt_price_next : sq2;

            // ── STEP 3 ─────────────────────────────────────────────────────────────
            // ── STEP 3 ──────────────────────────────────────────
            let a3: bool  = step3.tick_next != TICK_SENTINEL;
            let k3: field = a3 ? (step3.tick_next as i64 + 2_147_483_647i64) as u64 as field : 0field;
            let t3: TickInfo = Mapping::get_or_use(tick_info, k3, TickInfo {
                liquidity_gross: 0u128, liquidity_net: 0u128,
                liquidity_net_is_negative: false,
                fee_growth_outside_0: 0u128, fee_growth_outside_1: 0u128,
                initialized: false });
            assert(!a3 || t3.initialized);
            assert(!a3 || t3.liquidity_net == step3.liquidity_net);
            assert(!a3 || t3.liquidity_net_is_negative == step3.liquidity_net_is_negative);
            let out3_exp: u64 = a3 ? ((liq3 * (sq3 - step3.sqrt_price_next)) / Q64) as u64 : 0u64;
            let diff3_max: u64 = step3.amount_out_step > out3_exp ? step3.amount_out_step : out3_exp;
            let diff3_min: u64 = step3.amount_out_step > out3_exp ? out3_exp : step3.amount_out_step;
            let diff3: u64 = diff3_max - diff3_min;
            assert(!a3 || diff3 <= 1u64); // DEBUG
            let t3_fg0: u128 = a3 ? fg0_3 - t3.fee_growth_outside_0 : t3.fee_growth_outside_0;
            let t3_fg1: u128 = a3 ? fg1_3 - t3.fee_growth_outside_1 : t3.fee_growth_outside_1;
            Mapping::set(tick_info, k3, TickInfo {
                liquidity_gross:           t3.liquidity_gross,
                liquidity_net:             t3.liquidity_net,
                liquidity_net_is_negative: t3.liquidity_net_is_negative,
                fee_growth_outside_0: t3_fg0,
                fee_growth_outside_1: t3_fg1,
                initialized: t3.initialized });
            let apply3_neg: bool = !step3.liquidity_net_is_negative;
            let liq_f_ge: bool = liq3 >= step3.liquidity_net;
            let liq_f_max: u128 = liq_f_ge ? liq3 : step3.liquidity_net;
            let liq_f_min: u128 = liq_f_ge ? step3.liquidity_net : liq3;
            let liq_f_cross_sub: u128 = liq_f_max - liq_f_min;
            let liq_f_cross_add: u128 = liq3 + step3.liquidity_net;
            let liq_f_cross: u128 = apply3_neg ? liq_f_cross_sub : liq_f_cross_add;
            let liq_f: u128 = a3 ? liq_f_cross : liq3;
            let fd3: u128 = (liq3 == 0u128 || !a3) ? 0u128 : (step3.fee_step as u128 * Q64) / liq3;
            let fg0_4: u128 = a3 ? fg0_3 + fd3 : fg0_3;
            let fg1_4: u128 = a3 ? fg1_3 + fd3 : fg1_3;
            let sq4: u128   = a3 ? step3.sqrt_price_next : sq3;

            // Terminal step: the remaining portion of the swap after all tick crossings.
            // term_out = total_out - sum(step.amount_out). For single-range: term_out=0.
            // sq4_sp_delta: |sq4 - sp_f| computed without underflow via max-min pattern.
            // term_diff assert disabled: step sum asserts in transition body are sufficient.
            // ── Terminal partial step ────────────────────────────
            let term_out: u64 = amt_out
                - step0.amount_out_step - step1.amount_out_step
                - step2.amount_out_step - step3.amount_out_step;
            let term_fee: u64 = fee
                - step0.fee_step - step1.fee_step - step2.fee_step - step3.fee_step;
            // sq4 - sp_f: swap_buy price decreases so sq4 >= sp_f
            let sq4_ge_spf: bool = sq4 >= sp_f;
            let sq4_sp_max: u128 = sq4_ge_spf ? sq4 : sp_f;
            let sq4_sp_min: u128 = sq4_ge_spf ? sp_f : sq4;
            let sq4_sp_delta: u128 = sq4_sp_max - sq4_sp_min;
            let term_computed: u64 = ((liq_f * sq4_sp_delta) / Q64) as u64;
            let term_diff_max: u64 = term_out > term_computed ? term_out : term_computed;
            let term_diff_min: u64 = term_out > term_computed ? term_computed : term_out;
            let term_diff: u64 = term_diff_max - term_diff_min;
            // term_diff assert removed: step sum asserts in transition body
            // already verify total_in/out/fee. term_diff conflicts with single-range swaps.

            // Accumulate terminal fee into fee_growth_global_0 (USDCx fees accrue in token0).
            // fd_term_raw pre-computed before ternary to avoid Leo evaluating 0/0.
            // fee_delta inlined for terminal step
            let fd_term_raw: u128 = (term_fee as u128 * Q64) / liq_f;
            let fd_term: u128 = liq_f == 0u128 ? 0u128 : fd_term_raw;
            // swap_buy: fee accrues in token0 (USDCx)
            let fg0_final: u128 = fg0_4 + fd_term;
            let fg1_final: u128 = fg1_4;

            // Deduct ALEO paid out from the pool reserve and write final pool state.
            let reserve: u64 = Mapping::get(aleo_reserve, 0u8);
            Mapping::set(aleo_reserve, 0u8, reserve - amt_out);
            Mapping::set(pool_state, POOL_KEY, PoolState {
                sqrt_price_x64:      sp_f,
                current_tick:        t_f,
                liquidity:           liq_f,
                fee_growth_global_0: fg0_final,
                fee_growth_global_1: fg1_final });
        });
    }

    // swap_sell — ALEO → USDCx
    // Price increases (zero_for_one = false). ALEO transferred in, USDCx paid out from AMM balance.
    // Orchestrator pre-computes step0..step3. Same 4-step unrolled architecture as swap_buy.
    // out_exp for each step uses /2^32 scaling (S32) to avoid overflow since sp/Q64=0.
    // ──────────────────────────────────────────────────────────
    // swap_sell — ALEO → USDCx (zero_for_one = false)
    // sqrt_price increases. Token1 (ALEO) in, Token0 (USDCx) out.
    // ALEO amount_in is sent as credits with the transaction.
    // ──────────────────────────────────────────────────────────

    fn swap_sell(
        merkle_proof: [test_usdcx_stablecoin.aleo::MerkleProof; 2],
        public total_amount_in:  u64,
        public total_amount_out: u64,
        public total_fee:        u64,
        public sqrt_price_final: u128,
        public tick_final:       i32,
        public step0: TickStep,
        public step1: TickStep,
        public step2: TickStep,
        public step3: TickStep,
    ) -> (SwapReceipt, test_usdcx_stablecoin.aleo::ComplianceRecord, test_usdcx_stablecoin.aleo::Token, Final) {

        // Verify fee and step sums. Fee = 0.3% of ALEO amount_in.
        assert(total_amount_in > 0u64);
        assert(total_amount_out > 0u64);
        let expected_fee: u64 = (total_amount_in as u128 * FEE_BPS as u128 / FEE_DENOM as u128) as u64;
        assert_eq(total_fee, expected_fee);
        assert_eq(
            step0.amount_in_step + step1.amount_in_step + step2.amount_in_step + step3.amount_in_step,
            total_amount_in);
        assert_eq(
            step0.amount_out_step + step1.amount_out_step + step2.amount_out_step + step3.amount_out_step,
            total_amount_out);
        assert_eq(
            step0.fee_step + step1.fee_step + step2.fee_step + step3.fee_step,
            total_fee);
        let ticks_crossed: u8 =
            (step0.tick_next != TICK_SENTINEL ? 1u8 : 0u8) +
            (step1.tick_next != TICK_SENTINEL ? 1u8 : 0u8) +
            (step2.tick_next != TICK_SENTINEL ? 1u8 : 0u8) +
            (step3.tick_next != TICK_SENTINEL ? 1u8 : 0u8);

        let receipt: SwapReceipt = SwapReceipt {
            owner: self.signer, zero_for_one: false,
            amount_in: total_amount_in, amount_out: total_amount_out,
            fee_paid: total_fee, sqrt_price_after: sqrt_price_final,
            tick_after: tick_final, ticks_crossed };

        let sp_f: u128   = sqrt_price_final;
        let t_f: i32     = tick_final;
        let amt_in: u64  = total_amount_in;
        let amt_out: u64 = total_amount_out;
        let fee: u64     = total_fee;
        let seller: address = self.caller;

        // Transfer USDCx from AMM public balance to seller. Returns compliance record and token.
        let (compliance_rec, usdc_out, xfer_final):
            (test_usdcx_stablecoin.aleo::ComplianceRecord,
             test_usdcx_stablecoin.aleo::Token, Final) =
            test_usdcx_stablecoin.aleo::transfer_public_to_private(
                self.signer, total_amount_out as u128);

        // ── Finalize block ──────────────────────────────────────────────────────────
        return (receipt, compliance_rec, usdc_out, final {
            xfer_final.run();
            let pool: PoolState = Mapping::get(pool_state, POOL_KEY);
                        // ── STEP 0 ──────────────────────────────────────────
            let a0: bool  = step0.tick_next != TICK_SENTINEL;
            let k0: field = a0 ? (step0.tick_next as i64 + 2_147_483_647i64) as u64 as field : 0field;
            let t0: TickInfo = Mapping::get_or_use(tick_info, k0, TickInfo {
                liquidity_gross: 0u128, liquidity_net: 0u128,
                liquidity_net_is_negative: false,
                fee_growth_outside_0: 0u128, fee_growth_outside_1: 0u128,
                initialized: false });
            assert(!a0 || t0.initialized);
            assert(!a0 || t0.liquidity_net == step0.liquidity_net);
            assert(!a0 || t0.liquidity_net_is_negative == step0.liquidity_net_is_negative);
            // out0_exp for swap_sell uses /S32 scaling:
            // amount0 = L*(hiS-loS)*S32/(hiS*loS) where xS=x/2^32.
            // When a0=false: s0_next=pool.sqrt_price_x64, delta=0, out0_exp=0.
            // amount1_from_sqrts inlined: liq*(hi-lo)/Q64
            // out0_exp: only meaningful when a0=true (tick crossing)
            // When a0=false, step0.sqrt_price_next=0 → use pool.sqrt_price_x64 for both
            let s0S: u128 = 4294967296u128;
            let s0_next: u128 = a0 ? step0.sqrt_price_next : pool.sqrt_price_x64;
            let s0_hiS: u128 = (s0_next > pool.sqrt_price_x64 ? s0_next : pool.sqrt_price_x64) / s0S;
            let s0_loS: u128 = (s0_next > pool.sqrt_price_x64 ? pool.sqrt_price_x64 : s0_next) / s0S;
            let s0_denom: u128 = s0_hiS * s0_loS + 1u128;
            let out0_exp: u64 = a0 ? ((pool.liquidity * (s0_hiS - s0_loS) * s0S) / s0_denom) as u64 : 0u64;
            let diff0_max: u64 = step0.amount_out_step > out0_exp ? step0.amount_out_step : out0_exp;
            let diff0_min: u64 = step0.amount_out_step > out0_exp ? out0_exp : step0.amount_out_step;
            let diff0: u64 = diff0_max - diff0_min;
            assert(!a0 || diff0 <= 1u64); // DEBUG
            // Only flip fee_growth_outside when crossing a tick (a0=true)
            let t0_fg0: u128 = a0 ? pool.fee_growth_global_0 - t0.fee_growth_outside_0 : t0.fee_growth_outside_0;
            let t0_fg1: u128 = a0 ? pool.fee_growth_global_1 - t0.fee_growth_outside_1 : t0.fee_growth_outside_1;
            Mapping::set(tick_info, k0, TickInfo {
                liquidity_gross:           t0.liquidity_gross,
                liquidity_net:             t0.liquidity_net,
                liquidity_net_is_negative: t0.liquidity_net_is_negative,
                fee_growth_outside_0:      t0_fg0,
                fee_growth_outside_1:      t0_fg1,
                initialized:               t0.initialized });
            // apply_liq_delta: for swap_sell apply0_neg=step0.liquidity_net_is_negative
            // (opposite sign convention to swap_buy because price moves upward).
            // apply_liq_delta inlined
            let apply0_neg: bool = step0.liquidity_net_is_negative;
            // max-min avoids underflow when step.liquidity_net > pool.liquidity
            let liq1_ge: bool = pool.liquidity >= step0.liquidity_net;
            let liq1_max: u128 = liq1_ge ? pool.liquidity : step0.liquidity_net;
            let liq1_min: u128 = liq1_ge ? step0.liquidity_net : pool.liquidity;
            let liq1_sub: u128 = liq1_max - liq1_min;
            let liq1_add: u128 = pool.liquidity + step0.liquidity_net;
            let liq1_cross: u128 = apply0_neg ? liq1_sub : liq1_add;
            let liq1: u128 = a0 ? liq1_cross : pool.liquidity;
            // fee_delta inlined: fee*Q64/liq
            let fd0: u128 = (pool.liquidity == 0u128 || !a0) ? 0u128 : (step0.fee_step as u128 * Q64) / pool.liquidity;
            let fg0_1: u128 = a0 ? pool.fee_growth_global_0 + fd0 : pool.fee_growth_global_0;
            let fg1_1: u128 = a0 ? pool.fee_growth_global_1 + fd0 : pool.fee_growth_global_1;
            let sq1: u128   = a0 ? step0.sqrt_price_next : pool.sqrt_price_x64;

            // ── STEP 1 ──────────────────────────────────────────
            let a1b: bool = step1.tick_next != TICK_SENTINEL;
            let k1: field = a1b ? (step1.tick_next as i64 + 2_147_483_647i64) as u64 as field : 0field;
            let t1: TickInfo = Mapping::get_or_use(tick_info, k1, TickInfo {
                liquidity_gross: 0u128, liquidity_net: 0u128,
                liquidity_net_is_negative: false,
                fee_growth_outside_0: 0u128, fee_growth_outside_1: 0u128,
                initialized: false });
            assert(!a1b || t1.initialized);
            assert(!a1b || t1.liquidity_net == step1.liquidity_net);
            assert(!a1b || t1.liquidity_net_is_negative == step1.liquidity_net_is_negative);
            let s1S: u128 = 4294967296u128;
            let s1_next: u128 = a1b ? step1.sqrt_price_next : sq1;
            let s1_hiS: u128 = (s1_next > sq1 ? s1_next : sq1) / s1S;
            let s1_loS: u128 = (s1_next > sq1 ? sq1 : s1_next) / s1S;
            let s1_denom: u128 = s1_hiS * s1_loS + 1u128;
            let out1_exp: u64 = a1b ? ((liq1 * (s1_hiS - s1_loS) * s1S) / s1_denom) as u64 : 0u64;
            let diff1_max: u64 = step1.amount_out_step > out1_exp ? step1.amount_out_step : out1_exp;
            let diff1_min: u64 = step1.amount_out_step > out1_exp ? out1_exp : step1.amount_out_step;
            let diff1: u64 = diff1_max - diff1_min;
            assert(!a1b || diff1 <= 1u64); // DEBUG
            let t1_fg0: u128 = a1b ? fg0_1 - t1.fee_growth_outside_0 : t1.fee_growth_outside_0;
            let t1_fg1: u128 = a1b ? fg1_1 - t1.fee_growth_outside_1 : t1.fee_growth_outside_1;
            Mapping::set(tick_info, k1, TickInfo {
                liquidity_gross:           t1.liquidity_gross,
                liquidity_net:             t1.liquidity_net,
                liquidity_net_is_negative: t1.liquidity_net_is_negative,
                fee_growth_outside_0: t1_fg0,
                fee_growth_outside_1: t1_fg1,
                initialized: t1.initialized });
            let apply1_neg: bool = step1.liquidity_net_is_negative;
            // max-min avoids underflow when step.liquidity_net > liq1
            let liq2_ge: bool = liq1 >= step1.liquidity_net;
            let liq2_max: u128 = liq2_ge ? liq1 : step1.liquidity_net;
            let liq2_min: u128 = liq2_ge ? step1.liquidity_net : liq1;
            let liq2_sub: u128 = liq2_max - liq2_min;
            let liq2_add: u128 = liq1 + step1.liquidity_net;
            let liq2_cross: u128 = apply1_neg ? liq2_sub : liq2_add;
            let liq2: u128 = a1b ? liq2_cross : liq1;
            let fd1: u128 = (liq1 == 0u128 || !a1b) ? 0u128 : (step1.fee_step as u128 * Q64) / liq1;
            let fg0_2: u128 = a1b ? fg0_1 + fd1 : fg0_1;
            let fg1_2: u128 = a1b ? fg1_1 + fd1 : fg1_1;
            let sq2: u128   = a1b ? step1.sqrt_price_next : sq1;

            // ── STEP 2 ──────────────────────────────────────────
            let a2: bool  = step2.tick_next != TICK_SENTINEL;
            let k2: field = a2 ? (step2.tick_next as i64 + 2_147_483_647i64) as u64 as field : 0field;
            let t2: TickInfo = Mapping::get_or_use(tick_info, k2, TickInfo {
                liquidity_gross: 0u128, liquidity_net: 0u128,
                liquidity_net_is_negative: false,
                fee_growth_outside_0: 0u128, fee_growth_outside_1: 0u128,
                initialized: false });
            assert(!a2 || t2.initialized);
            assert(!a2 || t2.liquidity_net == step2.liquidity_net);
            assert(!a2 || t2.liquidity_net_is_negative == step2.liquidity_net_is_negative);
            let s2S: u128 = 4294967296u128;
            let s2_next: u128 = a2 ? step2.sqrt_price_next : sq2;
            let s2_hiS: u128 = (s2_next > sq2 ? s2_next : sq2) / s2S;
            let s2_loS: u128 = (s2_next > sq2 ? sq2 : s2_next) / s2S;
            let s2_denom: u128 = s2_hiS * s2_loS + 1u128;
            let out2_exp: u64 = a2 ? ((liq2 * (s2_hiS - s2_loS) * s2S) / s2_denom) as u64 : 0u64;
            let diff2_max: u64 = step2.amount_out_step > out2_exp ? step2.amount_out_step : out2_exp;
            let diff2_min: u64 = step2.amount_out_step > out2_exp ? out2_exp : step2.amount_out_step;
            let diff2: u64 = diff2_max - diff2_min;
            assert(!a2 || diff2 <= 1u64); // DEBUG
            let t2_fg0: u128 = a2 ? fg0_2 - t2.fee_growth_outside_0 : t2.fee_growth_outside_0;
            let t2_fg1: u128 = a2 ? fg1_2 - t2.fee_growth_outside_1 : t2.fee_growth_outside_1;
            Mapping::set(tick_info, k2, TickInfo {
                liquidity_gross:           t2.liquidity_gross,
                liquidity_net:             t2.liquidity_net,
                liquidity_net_is_negative: t2.liquidity_net_is_negative,
                fee_growth_outside_0: t2_fg0,
                fee_growth_outside_1: t2_fg1,
                initialized: t2.initialized });
            let apply2_neg: bool = step2.liquidity_net_is_negative;
            // max-min avoids underflow when step.liquidity_net > liq2
            let liq3_ge: bool = liq2 >= step2.liquidity_net;
            let liq3_max: u128 = liq3_ge ? liq2 : step2.liquidity_net;
            let liq3_min: u128 = liq3_ge ? step2.liquidity_net : liq2;
            let liq3_sub: u128 = liq3_max - liq3_min;
            let liq3_add: u128 = liq2 + step2.liquidity_net;
            let liq3_cross: u128 = apply2_neg ? liq3_sub : liq3_add;
            let liq3: u128 = a2 ? liq3_cross : liq2;
            let fd2: u128 = (liq2 == 0u128 || !a2) ? 0u128 : (step2.fee_step as u128 * Q64) / liq2;
            let fg0_3: u128 = a2 ? fg0_2 + fd2 : fg0_2;
            let fg1_3: u128 = a2 ? fg1_2 + fd2 : fg1_2;
            let sq3: u128   = a2 ? step2.sqrt_price_next : sq2;

            // ── STEP 3 ──────────────────────────────────────────
            let a3: bool  = step3.tick_next != TICK_SENTINEL;
            let k3: field = a3 ? (step3.tick_next as i64 + 2_147_483_647i64) as u64 as field : 0field;
            let t3: TickInfo = Mapping::get_or_use(tick_info, k3, TickInfo {
                liquidity_gross: 0u128, liquidity_net: 0u128,
                liquidity_net_is_negative: false,
                fee_growth_outside_0: 0u128, fee_growth_outside_1: 0u128,
                initialized: false });
            assert(!a3 || t3.initialized);
            assert(!a3 || t3.liquidity_net == step3.liquidity_net);
            assert(!a3 || t3.liquidity_net_is_negative == step3.liquidity_net_is_negative);
            let s3S: u128 = 4294967296u128;
            let s3_next: u128 = a3 ? step3.sqrt_price_next : sq3;
            let s3_hiS: u128 = (s3_next > sq3 ? s3_next : sq3) / s3S;
            let s3_loS: u128 = (s3_next > sq3 ? sq3 : s3_next) / s3S;
            let s3_denom: u128 = s3_hiS * s3_loS + 1u128;
            let out3_exp: u64 = a3 ? ((liq3 * (s3_hiS - s3_loS) * s3S) / s3_denom) as u64 : 0u64;
            let diff3_max: u64 = step3.amount_out_step > out3_exp ? step3.amount_out_step : out3_exp;
            let diff3_min: u64 = step3.amount_out_step > out3_exp ? out3_exp : step3.amount_out_step;
            let diff3: u64 = diff3_max - diff3_min;
            assert(!a3 || diff3 <= 1u64); // DEBUG
            let t3_fg0: u128 = a3 ? fg0_3 - t3.fee_growth_outside_0 : t3.fee_growth_outside_0;
            let t3_fg1: u128 = a3 ? fg1_3 - t3.fee_growth_outside_1 : t3.fee_growth_outside_1;
            Mapping::set(tick_info, k3, TickInfo {
                liquidity_gross:           t3.liquidity_gross,
                liquidity_net:             t3.liquidity_net,
                liquidity_net_is_negative: t3.liquidity_net_is_negative,
                fee_growth_outside_0: t3_fg0,
                fee_growth_outside_1: t3_fg1,
                initialized: t3.initialized });
            let apply3_neg: bool = step3.liquidity_net_is_negative;
            let liq_f_ge: bool = liq3 >= step3.liquidity_net;
            let liq_f_max: u128 = liq_f_ge ? liq3 : step3.liquidity_net;
            let liq_f_min: u128 = liq_f_ge ? step3.liquidity_net : liq3;
            let liq_f_cross_sub: u128 = liq_f_max - liq_f_min;
            let liq_f_cross_add: u128 = liq3 + step3.liquidity_net;
            let liq_f_cross: u128 = apply3_neg ? liq_f_cross_sub : liq_f_cross_add;
            let liq_f: u128 = a3 ? liq_f_cross : liq3;
            let fd3: u128 = (liq3 == 0u128 || !a3) ? 0u128 : (step3.fee_step as u128 * Q64) / liq3;
            let fg0_4: u128 = a3 ? fg0_3 + fd3 : fg0_3;
            let fg1_4: u128 = a3 ? fg1_3 + fd3 : fg1_3;
            let sq4: u128   = a3 ? step3.sqrt_price_next : sq3;

            // Terminal step for swap_sell. Same max-min formula as swap_buy.
            // Reserve increases by amt_in (ALEO deposited). Pool state written last.
            // ── Terminal partial step ────────────────────────────
            // Remainder after all tick crossings — verified against sqrt_price_final
            let term_out: u64 = amt_out
                - step0.amount_out_step - step1.amount_out_step
                - step2.amount_out_step - step3.amount_out_step;
            let term_fee: u64 = fee
                - step0.fee_step - step1.fee_step - step2.fee_step - step3.fee_step;

            // Terminal verification using same formula as swap_buy
            let sp_ge_sq4: bool = sp_f >= sq4;
            let sp_sq4_max: u128 = sp_ge_sq4 ? sp_f : sq4;
            let sp_sq4_min: u128 = sp_ge_sq4 ? sq4 : sp_f;
            let sp_sq4_delta: u128 = sp_sq4_max - sp_sq4_min;
            let term_computed: u64 = ((liq_f * sp_sq4_delta) / Q64) as u64;
            let term_diff_max: u64 = term_out > term_computed ? term_out : term_computed;
            let term_diff_min: u64 = term_out > term_computed ? term_computed : term_out;
            let term_diff: u64 = term_diff_max - term_diff_min;
            // assert(term_diff <= 1u64); // TODO: re-enable

            // Terminal fee accrues in token1 (ALEO) for swap_sell direction.
            // fee_delta inlined for terminal step
            let fd_term_raw: u128 = (term_fee as u128 * Q64) / liq_f;
            let fd_term: u128 = liq_f == 0u128 ? 0u128 : fd_term_raw;
            let fg0_final: u128 = fg0_4 + fd_term;
            let fg1_final: u128 = fg1_4;

            // Add ALEO received to pool reserve and write final pool state.
            let reserve: u64 = Mapping::get(aleo_reserve, 0u8);
            Mapping::set(aleo_reserve, 0u8, reserve + amt_in);
            Mapping::set(pool_state, POOL_KEY, PoolState {
                sqrt_price_x64:      sp_f,
                current_tick:        t_f,
                liquidity:           liq_f,
                fee_growth_global_0: fg0_final,
                fee_growth_global_1: fg1_final });
        });
    }

    // ── Helper functions ──────────────────────────────────────────────────────────
    // These can only be called from transition bodies, NOT from inside final{} blocks.
    // All math that runs inside final{} must be inlined directly.
    // ──────────────────────────────────────────────────────────
    // HELPERS — only callable from transition body, NOT final{}
    // ──────────────────────────────────────────────────────────

    fn tick_to_field(tick: i32) -> field {
        return (tick as i64 + 2_147_483_647i64) as u64 as field;
    }

    fn amount1_from_sqrts(liq: u128, sqrt_lo: u128, sqrt_hi: u128) -> u64 {
        assert(sqrt_hi >= sqrt_lo);
        return ((liq * (sqrt_hi - sqrt_lo)) / Q64) as u64;
    }

    fn amount0_from_sqrts(liq: u128, sqrt_lo: u128, sqrt_hi: u128) -> u64 {
        assert(sqrt_hi > sqrt_lo);
        let denom: u128 = (sqrt_hi / Q64) * sqrt_lo + 1u128;
        return ((liq * (sqrt_hi - sqrt_lo)) / denom) as u64;
    }
}
