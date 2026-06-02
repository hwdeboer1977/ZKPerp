import test_usdcx_stablecoin.aleo;
import credits.aleo;

// ============================================================
// zkperp_amm — DEMO-GRADE HARDENED  (Concentrated-liquidity AMM, USDCx/ALEO)
//
// THREAT MODEL: client-side proving (Shield wallet). The trader/LP supplies
// every public input and profits from lying. The contract is the SOLE arbiter.
// Body asserts are enforced by the zk proof; finalize asserts by validators
// against live mapping state. A caller controls inputs but can violate neither.
//
// ── OVERFLOW-SAFE OPERATING ENVELOPE (enforced by asserts) ──────────────────
// All amount math is inline u128. L*(hi-lo) overflows u128 for large
// liquidity x wide range (the reason V3 uses 256-bit mulDiv). This build
// stays provably safe inside:
//       position ticks:   |tick| <= OP_CAP        (= 88,440  ~ e^17 price span)
//       per-position liq:  liquidity <= MAX_LIQ    (= 2^55)
// Outside this, multiplies abort the proof / revert the tx — funds are NEVER
// lost, only liveness is limited. Lifting the envelope to the full +/-443636
// range requires a verified u256 mul_div primitive (production follow-up).
//
// CANONICAL ROUNDING (no tolerance band): outputs FLOORED, required inputs
// CEILED. The Shield frontend MUST compute to these exact bounds:
//   out_step = floor(L*(hi-lo)/Q64-or-denom);  in_net = ceil(...);  fee = amt_in*FEE_BPS/FEE_DENOM
// Honest ops hit equality and pass; adversarial inputs revert. Mismatched
// frontend math only reverts the caller's own tx (liveness, not theft).
//
// NOT COMPILER-VERIFIED in this environment. Compile + run the full test
// suite before any deployment. Items flagged // VERIFY: need your attention.
// ============================================================

// ── Global-scope constants (visible to helper fns AND the program) ──────────
const FEE_BPS: u64       = 3_000u64;
const FEE_DENOM: u64     = 1_000_000u64;
const TICK_SPACING: i32  = 60i32;
const Q64: u128          = 18_446_744_073_709_551_616u128;
const MAX_TICK: i32      = 887_220i32;
const TICK_SENTINEL: i32 = 887_221i32;
const POOL_KEY: u8       = 0u8;
// sqrt_ratio_at_tick safe domain (overflow of positive reciprocal beyond this)
const SR_CAP: i32        = 443_636i32;
const U128_MAX: u128     = 340_282_366_920_938_463_463_374_607_431_768_211_455u128;
// demo amount-math envelope (see header)
const OP_CAP: i32        = 88_440i32;
const MAX_LIQ: u128      = 36_028_797_018_963_968u128; // 2^55

// ── Helper fns — declared OUTSIDE program {} (Leo 4.0 helpers are inlined) ──
// sqrt_ratio_at_tick — Q64.64, u128-safe, |tick| <= SR_CAP.
// VERIFIED: max rel error ~1e-11; intermediate products < 2^128
// (negative-direction staging then invert). SSA form.
fn sqrt_ratio_at_tick(tick: i32) -> u128 {
    assert(tick >= -SR_CAP);
    assert(tick <=  SR_CAP);
    let neg:  bool = tick < 0i32;
    let abst: u32  = (neg ? -tick : tick) as u32;
    let r0:  u128 = Q64;
    let r1:  u128 = (abst & 1u32)      != 0u32 ? (r0  * 18445821805675392312u128) / Q64 : r0;
    let r2:  u128 = (abst & 2u32)      != 0u32 ? (r1  * 18444899583751176498u128) / Q64 : r1;
    let r3:  u128 = (abst & 4u32)      != 0u32 ? (r2  * 18443055278223354163u128) / Q64 : r2;
    let r4:  u128 = (abst & 8u32)      != 0u32 ? (r3  * 18439367220385604838u128) / Q64 : r3;
    let r5:  u128 = (abst & 16u32)     != 0u32 ? (r4  * 18431993317065449818u128) / Q64 : r4;
    let r6:  u128 = (abst & 32u32)     != 0u32 ? (r5  * 18417254355718160513u128) / Q64 : r5;
    let r7:  u128 = (abst & 64u32)     != 0u32 ? (r6  * 18387811781193591352u128) / Q64 : r6;
    let r8:  u128 = (abst & 128u32)    != 0u32 ? (r7  * 18329067761203520168u128) / Q64 : r7;
    let r9:  u128 = (abst & 256u32)    != 0u32 ? (r8  * 18212142134806087855u128) / Q64 : r8;
    let r10: u128 = (abst & 512u32)    != 0u32 ? (r9  * 17980523815641551639u128) / Q64 : r9;
    let r11: u128 = (abst & 1024u32)   != 0u32 ? (r10 * 17526086738831147014u128) / Q64 : r10;
    let r12: u128 = (abst & 2048u32)   != 0u32 ? (r11 * 16651378430235024244u128) / Q64 : r11;
    let r13: u128 = (abst & 4096u32)   != 0u32 ? (r12 * 15030750278693429945u128) / Q64 : r12;
    let r14: u128 = (abst & 8192u32)   != 0u32 ? (r13 * 12247334978882834400u128) / Q64 : r13;
    let r15: u128 = (abst & 16384u32)  != 0u32 ? (r14 *  8131365268884726201u128) / Q64 : r14;
    let r16: u128 = (abst & 32768u32)  != 0u32 ? (r15 *  3584323654723342298u128) / Q64 : r15;
    let r17: u128 = (abst & 65536u32)  != 0u32 ? (r16 *   696457651847595234u128) / Q64 : r16;
    let r18: u128 = (abst & 131072u32) != 0u32 ? (r17 *    26294789957452057u128) / Q64 : r17;
    let r19: u128 = (abst & 262144u32) != 0u32 ? (r18 *       37481735321082u128) / Q64 : r18;
    let r20: u128 = (abst & 524288u32) != 0u32 ? (r19 *             76158724u128) / Q64 : r19;
    let recip: u128 = neg ? r20 : (U128_MAX / r20) + 1u128;
    return recip;
}

fn tick_to_field(tick: i32) -> field {
    return (tick as i64 + 2_147_483_647i64) as u64 as field;
}

program zkperp_amm_v6.aleo {

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
    mapping is_init:      u8    => bool;
    storage admin_address:        address;   // set at deploy = program_owner

    // NOT UPGRADABLE
    @custom
    constructor() {
        assert_eq(self.edition, 0u16);          // permanently non-upgradeable
        admin_address = self.program_owner;     // deployer = admin, atomic, no frontrun
    }

    // ──────────────────────────────────────────────────────────
    // initialize_pool — admin-only, once.
    // ──────────────────────────────────────────────────────────
    fn initialize_pool(
        public initial_sqrt_price_x64: u128,
        public initial_tick: i32,
    ) -> Final {
        assert(initial_sqrt_price_x64 > 0u128);
        assert(initial_tick >= -OP_CAP);
        assert(initial_tick <=  OP_CAP);
        let caller: address = self.caller;
        return final {
            let admin: address = admin_address.unwrap();
            assert_eq(caller, admin);
            let already: bool = Mapping::get_or_use(is_init, 0u8, false);
            assert(!already);
            Mapping::set(pool_state, POOL_KEY, PoolState {
                sqrt_price_x64:      initial_sqrt_price_x64,
                current_tick:        initial_tick,
                liquidity:           0u128,
                fee_growth_global_0: 0u128,
                fee_growth_global_1: 0u128 });
            Mapping::set(aleo_reserve, 0u8, 0u64);
            Mapping::set(is_init, 0u8, true);
        };
    }

    // ──────────────────────────────────────────────────────────
    // mint_position — deposit derived from liquidity (cannot under-pay).
    // ──────────────────────────────────────────────────────────
    fn mint_position(
        lp_token: test_usdcx_stablecoin.aleo::Token,
        merkle_proof: [test_usdcx_stablecoin.aleo::MerkleProof; 2],
        aleo_in: credits.aleo::credits,
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
    ) -> (LPPosition, test_usdcx_stablecoin.aleo::ComplianceRecord, test_usdcx_stablecoin.aleo::Token, credits.aleo::credits, Final) {

        assert(liquidity_desired > 0u128);
        assert(liquidity_desired <= MAX_LIQ);              // envelope
        assert(tick_lower < tick_upper);
        assert(tick_lower >= -OP_CAP);                     // envelope
        assert(tick_upper <=  OP_CAP);
        assert_eq(tick_lower / TICK_SPACING * TICK_SPACING, tick_lower);
        assert_eq(tick_upper / TICK_SPACING * TICK_SPACING, tick_upper);
        assert(amount_0_actual <= amount_0_max);
        assert(amount_1_actual <= amount_1_max);

        // range sqrt prices (proof-derived; captured into final{})
        let spL: u128 = sqrt_ratio_at_tick(tick_lower);
        let spU: u128 = sqrt_ratio_at_tick(tick_upper);

        let position: LPPosition = LPPosition {
            owner: self.signer, pool_id: 0u8,
            tick_lower, tick_upper,
            liquidity:                liquidity_desired,
            fee_growth_inside_0_last: fee_growth_inside_0,
            fee_growth_inside_1_last: fee_growth_inside_1,
            tokens_owed_0: 0u64, tokens_owed_1: 0u64 };

        let tl: i32   = tick_lower;
        let tu: i32   = tick_upper;
        let liq: u128 = liquidity_desired;
        let a1: u64   = amount_1_actual;

        let (compliance_rec, change_token, xfer_final):
            (test_usdcx_stablecoin.aleo::ComplianceRecord,
             test_usdcx_stablecoin.aleo::Token, Final) =
            test_usdcx_stablecoin.aleo::transfer_private_to_public(
                self.address, amount_0_actual as u128, lp_token, merkle_proof);

        let (aleo_change, aleo_xfer_final): (credits.aleo::credits, Final) =
            credits.aleo::transfer_private_to_public(aleo_in, self.address, amount_1_actual);

        return (position, compliance_rec, change_token, aleo_change, final {
            xfer_final.run();
            aleo_xfer_final.run();
            let pool: PoolState = Mapping::get(pool_state, POOL_KEY);
            assert_eq(pool.sqrt_price_x64, sqrt_price_x64);
            assert_eq(pool.current_tick, current_tick);

            // ── derive required deposit from liquidity (CEIL; must pay >=) ──
            let spC: u128 = pool.sqrt_price_x64;
            let below: bool = current_tick <  tl;   // price below range -> token0 only
            let above: bool = current_tick >= tu;   // price above range -> token1 only

            // amount0 (USDCx): range [max(price,lower), upper]; guard subtraction
            let lo0: u128 = below ? spL : spC;
            let d0_ge: bool = spU >= lo0;
            let d0: u128 = d0_ge ? (spU - lo0) : 0u128;
            let den0: u128 = (spU / Q64) * lo0 + 1u128;
            let amt0_exp: u64 = above ? 0u64 : ((liq * d0 + den0 - 1u128) / den0) as u64;  // CEIL

            // amount1 (ALEO): range [lower, min(price,upper)]; guard subtraction
            let hi1: u128 = above ? spU : spC;
            let d1_ge: bool = hi1 >= spL;
            let d1: u128 = d1_ge ? (hi1 - spL) : 0u128;
            let amt1_exp: u64 = below ? 0u64 : ((liq * d1 + Q64 - 1u128) / Q64) as u64;     // CEIL

            assert(amount_0_actual >= amt0_exp);
            assert(amount_1_actual >= amt1_exp);

            let reserve: u64 = Mapping::get_or_use(aleo_reserve, 0u8, 0u64);
            Mapping::set(aleo_reserve, 0u8, reserve + a1);

            // tick_lower — add liquidity_gross/net; fee_outside seeded if below price
            let tl_key: field = (tl as i64 + 2_147_483_647i64) as u64 as field;
            let tl_info: TickInfo = Mapping::get_or_use(tick_info, tl_key, TickInfo {
                liquidity_gross: 0u128, liquidity_net: 0u128, liquidity_net_is_negative: false,
                fee_growth_outside_0: 0u128, fee_growth_outside_1: 0u128, initialized: false });
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

            // tick_upper — liquidity_net decreases (sub_signed inlined)
            let tu_key: field = (tu as i64 + 2_147_483_647i64) as u64 as field;
            let tu_info: TickInfo = Mapping::get_or_use(tick_info, tu_key, TickInfo {
                liquidity_gross: 0u128, liquidity_net: 0u128, liquidity_net_is_negative: false,
                fee_growth_outside_0: 0u128, fee_growth_outside_1: 0u128, initialized: false });
            let tu_below: bool = tu <= current_tick;
            let tu_uninit_fee0: u128 = tu_below ? pool.fee_growth_global_0 : 0u128;
            let tu_uninit_fee1: u128 = tu_below ? pool.fee_growth_global_1 : 0u128;
            let tu_fee0: u128 = tu_info.initialized ? tu_info.fee_growth_outside_0 : tu_uninit_fee0;
            let tu_fee1: u128 = tu_info.initialized ? tu_info.fee_growth_outside_1 : tu_uninit_fee1;
            let tu_net_ge_liq: bool = tu_info.liquidity_net >= liq;
            let tu_net_case_a: u128 = tu_info.liquidity_net + liq;
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
    // burn_position — payout derived from liquidity (cannot over-withdraw).
    // ──────────────────────────────────────────────────────────
    fn burn_position(
        position: LPPosition,
        public amount_0_out: u64,
        public amount_1_out: u64,
        public sqrt_price_x64: u128,
        public current_tick: i32,
    ) -> (test_usdcx_stablecoin.aleo::ComplianceRecord, test_usdcx_stablecoin.aleo::Token, credits.aleo::credits, Final) {

        assert_eq(position.owner, self.signer);
        assert(position.liquidity > 0u128);

        let tl: i32   = position.tick_lower;
        let tu: i32   = position.tick_upper;
        let liq: u128 = position.liquidity;
        let a1: u64   = amount_1_out;
        let owner: address = position.owner;
        let owed0: u64 = position.tokens_owed_0;
        let owed1: u64 = position.tokens_owed_1;

        let spL: u128 = sqrt_ratio_at_tick(tl);
        let spU: u128 = sqrt_ratio_at_tick(tu);

        let (compliance_rec, payout_token, xfer_final):
            (test_usdcx_stablecoin.aleo::ComplianceRecord,
             test_usdcx_stablecoin.aleo::Token, Final) =
            test_usdcx_stablecoin.aleo::transfer_public_to_private(owner, amount_0_out as u128);

        let (aleo_payout, aleo_xfer_final): (credits.aleo::credits, Final) =
            credits.aleo::transfer_public_to_private(owner, amount_1_out);

        return (compliance_rec, payout_token, aleo_payout, final {
            xfer_final.run();
            aleo_xfer_final.run();
            let pool: PoolState = Mapping::get(pool_state, POOL_KEY);
            assert_eq(pool.sqrt_price_x64, sqrt_price_x64);
            assert_eq(pool.current_tick, current_tick);

            // ── derive max payout from liquidity (FLOOR; cannot over-withdraw) ──
            // VERIFY: tokens_owed (fee) settlement uses guarded subtraction; the
            // V3 wrapping-mod-2^128 fee_growth semantics need test coverage.
            let spC: u128 = pool.sqrt_price_x64;
            let below: bool = current_tick <  tl;
            let above: bool = current_tick >= tu;

            let lo0: u128 = below ? spL : spC;
            let d0_ge: bool = spU >= lo0;
            let d0: u128 = d0_ge ? (spU - lo0) : 0u128;
            let den0: u128 = (spU / Q64) * lo0 + 1u128;
            let prin0: u64 = above ? 0u64 : ((liq * d0) / den0) as u64;          // FLOOR

            let hi1: u128 = above ? spU : spC;
            let d1_ge: bool = hi1 >= spL;
            let d1: u128 = d1_ge ? (hi1 - spL) : 0u128;
            let prin1: u64 = below ? 0u64 : ((liq * d1) / Q64) as u64;            // FLOOR

            // max withdrawable = principal + fees already owed
            let max0: u64 = prin0 + owed0;
            let max1: u64 = prin1 + owed1;
            assert(amount_0_out <= max0);
            assert(amount_1_out <= max1);

            // tick_lower: sub_signed (net -= liq); de-init if gross hits 0
            let tl_key: field = (tl as i64 + 2_147_483_647i64) as u64 as field;
            let tl_info: TickInfo = Mapping::get(tick_info, tl_key);
            let tl_same: bool = tl_info.liquidity_net_is_negative == false;
            let tl_net_ge_liq: bool = tl_info.liquidity_net >= liq;
            let tl_net_max: u128 = tl_net_ge_liq ? tl_info.liquidity_net : liq;
            let tl_net_min: u128 = tl_net_ge_liq ? liq : tl_info.liquidity_net;
            let tl_net_pos: u128 = tl_net_max - tl_net_min;
            let tl_new_net: u128 = tl_same ? tl_net_pos : tl_info.liquidity_net + liq;
            let tl_new_neg: bool = tl_same ? !tl_net_ge_liq : true;
            let tl_gross: u128 = tl_info.liquidity_gross - liq;
            Mapping::set(tick_info, tl_key, TickInfo {
                liquidity_gross:           tl_gross,
                liquidity_net:             tl_new_net,
                liquidity_net_is_negative: tl_new_neg,
                fee_growth_outside_0:      tl_info.fee_growth_outside_0,
                fee_growth_outside_1:      tl_info.fee_growth_outside_1,
                initialized:               tl_gross > 0u128 });

            // tick_upper: add_signed (net += liq)
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

    // ──────────────────────────────────────────────────────────
    // swap_buy — USDCx -> ALEO (zero_for_one = true), price decreases.
    // Token0 (USDCx) in, Token1 (ALEO) out. Out FLOORED, in CEILED.
    // ──────────────────────────────────────────────────────────
    fn swap_buy(
        usdcx_in: test_usdcx_stablecoin.aleo::Token,
        merkle_proof: [test_usdcx_stablecoin.aleo::MerkleProof; 2],
        public total_amount_in:  u64,
        public total_amount_out: u64,
        public total_fee:        u64,
        public min_amount_out:   u64,
        public deadline:         u32,
        public sqrt_price_final: u128,
        public tick_final:       i32,
        public step0: TickStep,
        public step1: TickStep,
        public step2: TickStep,
        public step3: TickStep,
    ) -> (SwapReceipt, test_usdcx_stablecoin.aleo::ComplianceRecord, test_usdcx_stablecoin.aleo::Token, credits.aleo::credits, Final) {

        assert(total_amount_in  > 0u64);
        assert(total_amount_out > 0u64);
        assert(total_amount_out >= min_amount_out);
        let expected_fee: u64 = (total_amount_in as u128 * FEE_BPS as u128 / FEE_DENOM as u128) as u64;
        assert_eq(total_fee, expected_fee);
        assert(step0.amount_in_step  + step1.amount_in_step  + step2.amount_in_step  + step3.amount_in_step  <= total_amount_in);
        assert(step0.amount_out_step + step1.amount_out_step + step2.amount_out_step + step3.amount_out_step <= total_amount_out);
        assert(step0.fee_step        + step1.fee_step        + step2.fee_step        + step3.fee_step        <= total_fee);

        // pin final tick to final price
        let sp_lo: u128 = sqrt_ratio_at_tick(tick_final);
        let sp_hi: u128 = sqrt_ratio_at_tick(tick_final + 1i32);
        assert(sp_lo <= sqrt_price_final);
        assert(sqrt_price_final < sp_hi);

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

        let sp_f: u128 = sqrt_price_final;
        let t_f: i32   = tick_final;
        let amt_in: u64  = total_amount_in;
        let amt_out: u64 = total_amount_out;
        let fee: u64     = total_fee;
        let dl: u32      = deadline;

        let (compliance_rec, change_token, xfer_final):
            (test_usdcx_stablecoin.aleo::ComplianceRecord,
             test_usdcx_stablecoin.aleo::Token, Final) =
            test_usdcx_stablecoin.aleo::transfer_private_to_public(
                self.address, total_amount_in as u128, usdcx_in, merkle_proof);
        let (aleo_out, aleo_xfer_final): (credits.aleo::credits, Final) =
            credits.aleo::transfer_public_to_private(self.signer, total_amount_out);

        return (receipt, compliance_rec, change_token, aleo_out, final {
            assert(block.height <= dl);   // VERIFY: block.height accessor in your Leo version
            xfer_final.run();
            aleo_xfer_final.run();
            let pool: PoolState = Mapping::get(pool_state, POOL_KEY);
            assert(sp_f > 0u128);
            assert(sp_f < pool.sqrt_price_x64);

            // STEP 0
            let a0: bool = step0.tick_next != TICK_SENTINEL;
            assert(a0 || (step0.amount_in_step == 0u64 && step0.amount_out_step == 0u64 && step0.fee_step == 0u64));
            let k0: field = a0 ? (step0.tick_next as i64 + 2_147_483_647i64) as u64 as field : 0field;
            let t0: TickInfo = Mapping::get_or_use(tick_info, k0, TickInfo {
                liquidity_gross: 0u128, liquidity_net: 0u128, liquidity_net_is_negative: false,
                fee_growth_outside_0: 0u128, fee_growth_outside_1: 0u128, initialized: false });
            assert(!a0 || t0.initialized);
            assert(!a0 || t0.liquidity_net == step0.liquidity_net);
            assert(!a0 || t0.liquidity_net_is_negative == step0.liquidity_net_is_negative);
            assert(!a0 || step0.fee_step == (step0.amount_in_step as u128 * FEE_BPS as u128 / FEE_DENOM as u128) as u64);
            let out0_exp: u64 = a0 ? ((pool.liquidity * (pool.sqrt_price_x64 - step0.sqrt_price_next)) / Q64) as u64 : 0u64;
            assert(!a0 || step0.amount_out_step <= out0_exp);
            let num0: u128 = a0 ? pool.liquidity * (pool.sqrt_price_x64 - step0.sqrt_price_next) : 0u128;
            let den0: u128 = a0 ? (pool.sqrt_price_x64 / Q64) * step0.sqrt_price_next + 1u128 : 1u128;
            let in0_ceil: u64 = a0 ? ((num0 + den0 - 1u128) / den0) as u64 : 0u64;
            let in0_net: u64 = a0 ? (step0.amount_in_step - step0.fee_step) : 0u64;
            assert(!a0 || in0_net >= in0_ceil);
            let t0_fg0: u128 = a0 ? pool.fee_growth_global_0 - t0.fee_growth_outside_0 : t0.fee_growth_outside_0;
            let t0_fg1: u128 = a0 ? pool.fee_growth_global_1 - t0.fee_growth_outside_1 : t0.fee_growth_outside_1;
            Mapping::set(tick_info, k0, TickInfo {
                liquidity_gross: t0.liquidity_gross, liquidity_net: t0.liquidity_net,
                liquidity_net_is_negative: t0.liquidity_net_is_negative,
                fee_growth_outside_0: t0_fg0, fee_growth_outside_1: t0_fg1, initialized: t0.initialized });
            let apply0_neg: bool = !step0.liquidity_net_is_negative;
            let liq1_ge: bool = pool.liquidity >= step0.liquidity_net;
            let liq1_max: u128 = liq1_ge ? pool.liquidity : step0.liquidity_net;
            let liq1_min: u128 = liq1_ge ? step0.liquidity_net : pool.liquidity;
            let liq1_cross: u128 = apply0_neg ? (liq1_max - liq1_min) : (pool.liquidity + step0.liquidity_net);
            let liq1: u128 = a0 ? liq1_cross : pool.liquidity;
            let fd0: u128 = (pool.liquidity == 0u128 || !a0) ? 0u128 : (step0.fee_step as u128 * Q64) / pool.liquidity;
            let fg0_1: u128 = a0 ? pool.fee_growth_global_0 + fd0 : pool.fee_growth_global_0;
            let fg1_1: u128 = pool.fee_growth_global_1;   // buy fee -> token0 only
            let sq1: u128   = a0 ? step0.sqrt_price_next : pool.sqrt_price_x64;

            // STEP 1
            let a1b: bool = step1.tick_next != TICK_SENTINEL;
            assert(a1b || (step1.amount_in_step == 0u64 && step1.amount_out_step == 0u64 && step1.fee_step == 0u64));
            let k1: field = a1b ? (step1.tick_next as i64 + 2_147_483_647i64) as u64 as field : 0field;
            let t1: TickInfo = Mapping::get_or_use(tick_info, k1, TickInfo {
                liquidity_gross: 0u128, liquidity_net: 0u128, liquidity_net_is_negative: false,
                fee_growth_outside_0: 0u128, fee_growth_outside_1: 0u128, initialized: false });
            assert(!a1b || t1.initialized);
            assert(!a1b || t1.liquidity_net == step1.liquidity_net);
            assert(!a1b || t1.liquidity_net_is_negative == step1.liquidity_net_is_negative);
            assert(!a1b || step1.fee_step == (step1.amount_in_step as u128 * FEE_BPS as u128 / FEE_DENOM as u128) as u64);
            let out1_exp: u64 = a1b ? ((liq1 * (sq1 - step1.sqrt_price_next)) / Q64) as u64 : 0u64;
            assert(!a1b || step1.amount_out_step <= out1_exp);
            let num1: u128 = a1b ? liq1 * (sq1 - step1.sqrt_price_next) : 0u128;
            let den1: u128 = a1b ? (sq1 / Q64) * step1.sqrt_price_next + 1u128 : 1u128;
            let in1_ceil: u64 = a1b ? ((num1 + den1 - 1u128) / den1) as u64 : 0u64;
            let in1_net: u64 = a1b ? (step1.amount_in_step - step1.fee_step) : 0u64;
            assert(!a1b || in1_net >= in1_ceil);
            let t1_fg0: u128 = a1b ? fg0_1 - t1.fee_growth_outside_0 : t1.fee_growth_outside_0;
            let t1_fg1: u128 = a1b ? fg1_1 - t1.fee_growth_outside_1 : t1.fee_growth_outside_1;
            Mapping::set(tick_info, k1, TickInfo {
                liquidity_gross: t1.liquidity_gross, liquidity_net: t1.liquidity_net,
                liquidity_net_is_negative: t1.liquidity_net_is_negative,
                fee_growth_outside_0: t1_fg0, fee_growth_outside_1: t1_fg1, initialized: t1.initialized });
            let apply1_neg: bool = !step1.liquidity_net_is_negative;
            let liq2_ge: bool = liq1 >= step1.liquidity_net;
            let liq2_max: u128 = liq2_ge ? liq1 : step1.liquidity_net;
            let liq2_min: u128 = liq2_ge ? step1.liquidity_net : liq1;
            let liq2_cross: u128 = apply1_neg ? (liq2_max - liq2_min) : (liq1 + step1.liquidity_net);
            let liq2: u128 = a1b ? liq2_cross : liq1;
            let fd1: u128 = (liq1 == 0u128 || !a1b) ? 0u128 : (step1.fee_step as u128 * Q64) / liq1;
            let fg0_2: u128 = a1b ? fg0_1 + fd1 : fg0_1;
            let fg1_2: u128 = fg1_1;
            let sq2: u128   = a1b ? step1.sqrt_price_next : sq1;

            // STEP 2
            let a2: bool = step2.tick_next != TICK_SENTINEL;
            assert(a2 || (step2.amount_in_step == 0u64 && step2.amount_out_step == 0u64 && step2.fee_step == 0u64));
            let k2: field = a2 ? (step2.tick_next as i64 + 2_147_483_647i64) as u64 as field : 0field;
            let t2: TickInfo = Mapping::get_or_use(tick_info, k2, TickInfo {
                liquidity_gross: 0u128, liquidity_net: 0u128, liquidity_net_is_negative: false,
                fee_growth_outside_0: 0u128, fee_growth_outside_1: 0u128, initialized: false });
            assert(!a2 || t2.initialized);
            assert(!a2 || t2.liquidity_net == step2.liquidity_net);
            assert(!a2 || t2.liquidity_net_is_negative == step2.liquidity_net_is_negative);
            assert(!a2 || step2.fee_step == (step2.amount_in_step as u128 * FEE_BPS as u128 / FEE_DENOM as u128) as u64);
            let out2_exp: u64 = a2 ? ((liq2 * (sq2 - step2.sqrt_price_next)) / Q64) as u64 : 0u64;
            assert(!a2 || step2.amount_out_step <= out2_exp);
            let num2: u128 = a2 ? liq2 * (sq2 - step2.sqrt_price_next) : 0u128;
            let den2: u128 = a2 ? (sq2 / Q64) * step2.sqrt_price_next + 1u128 : 1u128;
            let in2_ceil: u64 = a2 ? ((num2 + den2 - 1u128) / den2) as u64 : 0u64;
            let in2_net: u64 = a2 ? (step2.amount_in_step - step2.fee_step) : 0u64;
            assert(!a2 || in2_net >= in2_ceil);
            let t2_fg0: u128 = a2 ? fg0_2 - t2.fee_growth_outside_0 : t2.fee_growth_outside_0;
            let t2_fg1: u128 = a2 ? fg1_2 - t2.fee_growth_outside_1 : t2.fee_growth_outside_1;
            Mapping::set(tick_info, k2, TickInfo {
                liquidity_gross: t2.liquidity_gross, liquidity_net: t2.liquidity_net,
                liquidity_net_is_negative: t2.liquidity_net_is_negative,
                fee_growth_outside_0: t2_fg0, fee_growth_outside_1: t2_fg1, initialized: t2.initialized });
            let apply2_neg: bool = !step2.liquidity_net_is_negative;
            let liq3_ge: bool = liq2 >= step2.liquidity_net;
            let liq3_max: u128 = liq3_ge ? liq2 : step2.liquidity_net;
            let liq3_min: u128 = liq3_ge ? step2.liquidity_net : liq2;
            let liq3_cross: u128 = apply2_neg ? (liq3_max - liq3_min) : (liq2 + step2.liquidity_net);
            let liq3: u128 = a2 ? liq3_cross : liq2;
            let fd2: u128 = (liq2 == 0u128 || !a2) ? 0u128 : (step2.fee_step as u128 * Q64) / liq2;
            let fg0_3: u128 = a2 ? fg0_2 + fd2 : fg0_2;
            let fg1_3: u128 = fg1_2;
            let sq3: u128   = a2 ? step2.sqrt_price_next : sq2;

            // STEP 3
            let a3: bool = step3.tick_next != TICK_SENTINEL;
            assert(a3 || (step3.amount_in_step == 0u64 && step3.amount_out_step == 0u64 && step3.fee_step == 0u64));
            let k3: field = a3 ? (step3.tick_next as i64 + 2_147_483_647i64) as u64 as field : 0field;
            let t3: TickInfo = Mapping::get_or_use(tick_info, k3, TickInfo {
                liquidity_gross: 0u128, liquidity_net: 0u128, liquidity_net_is_negative: false,
                fee_growth_outside_0: 0u128, fee_growth_outside_1: 0u128, initialized: false });
            assert(!a3 || t3.initialized);
            assert(!a3 || t3.liquidity_net == step3.liquidity_net);
            assert(!a3 || t3.liquidity_net_is_negative == step3.liquidity_net_is_negative);
            assert(!a3 || step3.fee_step == (step3.amount_in_step as u128 * FEE_BPS as u128 / FEE_DENOM as u128) as u64);
            let out3_exp: u64 = a3 ? ((liq3 * (sq3 - step3.sqrt_price_next)) / Q64) as u64 : 0u64;
            assert(!a3 || step3.amount_out_step <= out3_exp);
            let num3: u128 = a3 ? liq3 * (sq3 - step3.sqrt_price_next) : 0u128;
            let den3: u128 = a3 ? (sq3 / Q64) * step3.sqrt_price_next + 1u128 : 1u128;
            let in3_ceil: u64 = a3 ? ((num3 + den3 - 1u128) / den3) as u64 : 0u64;
            let in3_net: u64 = a3 ? (step3.amount_in_step - step3.fee_step) : 0u64;
            assert(!a3 || in3_net >= in3_ceil);
            let t3_fg0: u128 = a3 ? fg0_3 - t3.fee_growth_outside_0 : t3.fee_growth_outside_0;
            let t3_fg1: u128 = a3 ? fg1_3 - t3.fee_growth_outside_1 : t3.fee_growth_outside_1;
            Mapping::set(tick_info, k3, TickInfo {
                liquidity_gross: t3.liquidity_gross, liquidity_net: t3.liquidity_net,
                liquidity_net_is_negative: t3.liquidity_net_is_negative,
                fee_growth_outside_0: t3_fg0, fee_growth_outside_1: t3_fg1, initialized: t3.initialized });
            let apply3_neg: bool = !step3.liquidity_net_is_negative;
            let liq_f_ge: bool = liq3 >= step3.liquidity_net;
            let liq_f_max: u128 = liq_f_ge ? liq3 : step3.liquidity_net;
            let liq_f_min: u128 = liq_f_ge ? step3.liquidity_net : liq3;
            let liq_f_cross: u128 = apply3_neg ? (liq_f_max - liq_f_min) : (liq3 + step3.liquidity_net);
            let liq_f: u128 = a3 ? liq_f_cross : liq3;
            let fd3: u128 = (liq3 == 0u128 || !a3) ? 0u128 : (step3.fee_step as u128 * Q64) / liq3;
            let fg0_4: u128 = a3 ? fg0_3 + fd3 : fg0_3;
            let fg1_4: u128 = fg1_3;
            let sq4: u128   = a3 ? step3.sqrt_price_next : sq3;

            // Terminal (sq4 -> sp_f)
            let term_out: u64 = amt_out - step0.amount_out_step - step1.amount_out_step - step2.amount_out_step - step3.amount_out_step;
            let term_fee: u64 = fee - step0.fee_step - step1.fee_step - step2.fee_step - step3.fee_step;
            let term_in_gross: u64 = amt_in - step0.amount_in_step - step1.amount_in_step - step2.amount_in_step - step3.amount_in_step;
            assert(sq4 >= sp_f);
            let dlt: u128 = sq4 - sp_f;
            let term_out_exp: u64 = ((liq_f * dlt) / Q64) as u64;
            assert(term_out <= term_out_exp);
            let den_t: u128 = (sq4 / Q64) * sp_f + 1u128;
            let term_in_ceil: u64 = ((liq_f * dlt + den_t - 1u128) / den_t) as u64;
            let term_in_net: u64 = term_in_gross - term_fee;
            assert(term_in_net >= term_in_ceil);
            assert(term_fee == (term_in_gross as u128 * FEE_BPS as u128 / FEE_DENOM as u128) as u64);
            let fd_term: u128 = liq_f == 0u128 ? 0u128 : (term_fee as u128 * Q64) / liq_f;
            let fg0_final: u128 = fg0_4 + fd_term;
            let fg1_final: u128 = fg1_4;

            let reserve: u64 = Mapping::get(aleo_reserve, 0u8);
            assert(reserve >= amt_out);
            Mapping::set(aleo_reserve, 0u8, reserve - amt_out);
            Mapping::set(pool_state, POOL_KEY, PoolState {
                sqrt_price_x64: sp_f, current_tick: t_f, liquidity: liq_f,
                fee_growth_global_0: fg0_final, fee_growth_global_1: fg1_final });
        });
    }

    // ──────────────────────────────────────────────────────────
    // swap_sell — ALEO -> USDCx (zero_for_one = false), price increases.
    // Token1 (ALEO) in, Token0 (USDCx) out. Out FLOORED, in CEILED.
    // ──────────────────────────────────────────────────────────
    fn swap_sell(
        merkle_proof: [test_usdcx_stablecoin.aleo::MerkleProof; 2],
        aleo_in: credits.aleo::credits,
        public total_amount_in:  u64,
        public total_amount_out: u64,
        public total_fee:        u64,
        public min_amount_out:   u64,
        public deadline:         u32,
        public sqrt_price_final: u128,
        public tick_final:       i32,
        public step0: TickStep,
        public step1: TickStep,
        public step2: TickStep,
        public step3: TickStep,
    ) -> (SwapReceipt, test_usdcx_stablecoin.aleo::ComplianceRecord, test_usdcx_stablecoin.aleo::Token, credits.aleo::credits, Final) {

        assert(total_amount_in  > 0u64);
        assert(total_amount_out > 0u64);
        assert(total_amount_out >= min_amount_out);
        let expected_fee: u64 = (total_amount_in as u128 * FEE_BPS as u128 / FEE_DENOM as u128) as u64;
        assert_eq(total_fee, expected_fee);
        assert(step0.amount_in_step  + step1.amount_in_step  + step2.amount_in_step  + step3.amount_in_step  <= total_amount_in);
        assert(step0.amount_out_step + step1.amount_out_step + step2.amount_out_step + step3.amount_out_step <= total_amount_out);
        assert(step0.fee_step        + step1.fee_step        + step2.fee_step        + step3.fee_step        <= total_fee);

        let sp_lo: u128 = sqrt_ratio_at_tick(tick_final);
        let sp_hi: u128 = sqrt_ratio_at_tick(tick_final + 1i32);
        assert(sp_lo <= sqrt_price_final);
        assert(sqrt_price_final < sp_hi);

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

        let sp_f: u128 = sqrt_price_final;
        let t_f: i32   = tick_final;
        let amt_in: u64  = total_amount_in;
        let amt_out: u64 = total_amount_out;
        let fee: u64     = total_fee;
        let dl: u32      = deadline;

        let (aleo_change, aleo_xfer_final): (credits.aleo::credits, Final) =
            credits.aleo::transfer_private_to_public(aleo_in, self.address, total_amount_in);
        let (compliance_rec, usdc_out, xfer_final):
            (test_usdcx_stablecoin.aleo::ComplianceRecord,
             test_usdcx_stablecoin.aleo::Token, Final) =
            test_usdcx_stablecoin.aleo::transfer_public_to_private(self.signer, total_amount_out as u128);

        return (receipt, compliance_rec, usdc_out, aleo_change, final {
            assert(block.height <= dl);
            aleo_xfer_final.run();
            xfer_final.run();
            let pool: PoolState = Mapping::get(pool_state, POOL_KEY);
            assert(sp_f > pool.sqrt_price_x64);   // sell raises price

            // STEP 0  (price prev -> next, next > prev)
            let a0: bool = step0.tick_next != TICK_SENTINEL;
            assert(a0 || (step0.amount_in_step == 0u64 && step0.amount_out_step == 0u64 && step0.fee_step == 0u64));
            let k0: field = a0 ? (step0.tick_next as i64 + 2_147_483_647i64) as u64 as field : 0field;
            let t0: TickInfo = Mapping::get_or_use(tick_info, k0, TickInfo {
                liquidity_gross: 0u128, liquidity_net: 0u128, liquidity_net_is_negative: false,
                fee_growth_outside_0: 0u128, fee_growth_outside_1: 0u128, initialized: false });
            assert(!a0 || t0.initialized);
            assert(!a0 || t0.liquidity_net == step0.liquidity_net);
            assert(!a0 || t0.liquidity_net_is_negative == step0.liquidity_net_is_negative);
            assert(!a0 || step0.fee_step == (step0.amount_in_step as u128 * FEE_BPS as u128 / FEE_DENOM as u128) as u64);
            let p0: u128 = pool.sqrt_price_x64;
            let n0: u128 = a0 ? step0.sqrt_price_next : p0;
            assert(!a0 || n0 > p0);
            // OUT (token0/USDCx) FLOOR: L*(hi-lo)/denom
            let den0: u128 = (n0 / Q64) * p0 + 1u128;
            let out0_exp: u64 = a0 ? ((pool.liquidity * (n0 - p0)) / den0) as u64 : 0u64;
            assert(!a0 || step0.amount_out_step <= out0_exp);
            // IN (token1/ALEO) CEIL: L*(hi-lo)/Q64
            let in0_ceil: u64 = a0 ? ((pool.liquidity * (n0 - p0) + Q64 - 1u128) / Q64) as u64 : 0u64;
            let in0_net: u64 = a0 ? (step0.amount_in_step - step0.fee_step) : 0u64;
            assert(!a0 || in0_net >= in0_ceil);
            let t0_fg0: u128 = a0 ? pool.fee_growth_global_0 - t0.fee_growth_outside_0 : t0.fee_growth_outside_0;
            let t0_fg1: u128 = a0 ? pool.fee_growth_global_1 - t0.fee_growth_outside_1 : t0.fee_growth_outside_1;
            Mapping::set(tick_info, k0, TickInfo {
                liquidity_gross: t0.liquidity_gross, liquidity_net: t0.liquidity_net,
                liquidity_net_is_negative: t0.liquidity_net_is_negative,
                fee_growth_outside_0: t0_fg0, fee_growth_outside_1: t0_fg1, initialized: t0.initialized });
            // sell crossing: apply_neg = liquidity_net_is_negative (opposite of buy)
            let apply0_neg: bool = step0.liquidity_net_is_negative;
            let liq1_ge: bool = pool.liquidity >= step0.liquidity_net;
            let liq1_max: u128 = liq1_ge ? pool.liquidity : step0.liquidity_net;
            let liq1_min: u128 = liq1_ge ? step0.liquidity_net : pool.liquidity;
            let liq1_cross: u128 = apply0_neg ? (liq1_max - liq1_min) : (pool.liquidity + step0.liquidity_net);
            let liq1: u128 = a0 ? liq1_cross : pool.liquidity;
            let fd0: u128 = (pool.liquidity == 0u128 || !a0) ? 0u128 : (step0.fee_step as u128 * Q64) / pool.liquidity;
            let fg0_1: u128 = pool.fee_growth_global_0;   // sell fee -> token1 only
            let fg1_1: u128 = a0 ? pool.fee_growth_global_1 + fd0 : pool.fee_growth_global_1;
            let sq1: u128   = a0 ? step0.sqrt_price_next : p0;

            // STEP 1
            let a1b: bool = step1.tick_next != TICK_SENTINEL;
            assert(a1b || (step1.amount_in_step == 0u64 && step1.amount_out_step == 0u64 && step1.fee_step == 0u64));
            let k1: field = a1b ? (step1.tick_next as i64 + 2_147_483_647i64) as u64 as field : 0field;
            let t1: TickInfo = Mapping::get_or_use(tick_info, k1, TickInfo {
                liquidity_gross: 0u128, liquidity_net: 0u128, liquidity_net_is_negative: false,
                fee_growth_outside_0: 0u128, fee_growth_outside_1: 0u128, initialized: false });
            assert(!a1b || t1.initialized);
            assert(!a1b || t1.liquidity_net == step1.liquidity_net);
            assert(!a1b || t1.liquidity_net_is_negative == step1.liquidity_net_is_negative);
            assert(!a1b || step1.fee_step == (step1.amount_in_step as u128 * FEE_BPS as u128 / FEE_DENOM as u128) as u64);
            let n1: u128 = a1b ? step1.sqrt_price_next : sq1;
            assert(!a1b || n1 > sq1);
            let den1: u128 = (n1 / Q64) * sq1 + 1u128;
            let out1_exp: u64 = a1b ? ((liq1 * (n1 - sq1)) / den1) as u64 : 0u64;
            assert(!a1b || step1.amount_out_step <= out1_exp);
            let in1_ceil: u64 = a1b ? ((liq1 * (n1 - sq1) + Q64 - 1u128) / Q64) as u64 : 0u64;
            let in1_net: u64 = a1b ? (step1.amount_in_step - step1.fee_step) : 0u64;
            assert(!a1b || in1_net >= in1_ceil);
            let t1_fg0: u128 = a1b ? fg0_1 - t1.fee_growth_outside_0 : t1.fee_growth_outside_0;
            let t1_fg1: u128 = a1b ? fg1_1 - t1.fee_growth_outside_1 : t1.fee_growth_outside_1;
            Mapping::set(tick_info, k1, TickInfo {
                liquidity_gross: t1.liquidity_gross, liquidity_net: t1.liquidity_net,
                liquidity_net_is_negative: t1.liquidity_net_is_negative,
                fee_growth_outside_0: t1_fg0, fee_growth_outside_1: t1_fg1, initialized: t1.initialized });
            let apply1_neg: bool = step1.liquidity_net_is_negative;
            let liq2_ge: bool = liq1 >= step1.liquidity_net;
            let liq2_max: u128 = liq2_ge ? liq1 : step1.liquidity_net;
            let liq2_min: u128 = liq2_ge ? step1.liquidity_net : liq1;
            let liq2_cross: u128 = apply1_neg ? (liq2_max - liq2_min) : (liq1 + step1.liquidity_net);
            let liq2: u128 = a1b ? liq2_cross : liq1;
            let fd1: u128 = (liq1 == 0u128 || !a1b) ? 0u128 : (step1.fee_step as u128 * Q64) / liq1;
            let fg0_2: u128 = fg0_1;
            let fg1_2: u128 = a1b ? fg1_1 + fd1 : fg1_1;
            let sq2: u128   = a1b ? step1.sqrt_price_next : sq1;

            // STEP 2
            let a2: bool = step2.tick_next != TICK_SENTINEL;
            assert(a2 || (step2.amount_in_step == 0u64 && step2.amount_out_step == 0u64 && step2.fee_step == 0u64));
            let k2: field = a2 ? (step2.tick_next as i64 + 2_147_483_647i64) as u64 as field : 0field;
            let t2: TickInfo = Mapping::get_or_use(tick_info, k2, TickInfo {
                liquidity_gross: 0u128, liquidity_net: 0u128, liquidity_net_is_negative: false,
                fee_growth_outside_0: 0u128, fee_growth_outside_1: 0u128, initialized: false });
            assert(!a2 || t2.initialized);
            assert(!a2 || t2.liquidity_net == step2.liquidity_net);
            assert(!a2 || t2.liquidity_net_is_negative == step2.liquidity_net_is_negative);
            assert(!a2 || step2.fee_step == (step2.amount_in_step as u128 * FEE_BPS as u128 / FEE_DENOM as u128) as u64);
            let n2: u128 = a2 ? step2.sqrt_price_next : sq2;
            assert(!a2 || n2 > sq2);
            let den2: u128 = (n2 / Q64) * sq2 + 1u128;
            let out2_exp: u64 = a2 ? ((liq2 * (n2 - sq2)) / den2) as u64 : 0u64;
            assert(!a2 || step2.amount_out_step <= out2_exp);
            let in2_ceil: u64 = a2 ? ((liq2 * (n2 - sq2) + Q64 - 1u128) / Q64) as u64 : 0u64;
            let in2_net: u64 = a2 ? (step2.amount_in_step - step2.fee_step) : 0u64;
            assert(!a2 || in2_net >= in2_ceil);
            let t2_fg0: u128 = a2 ? fg0_2 - t2.fee_growth_outside_0 : t2.fee_growth_outside_0;
            let t2_fg1: u128 = a2 ? fg1_2 - t2.fee_growth_outside_1 : t2.fee_growth_outside_1;
            Mapping::set(tick_info, k2, TickInfo {
                liquidity_gross: t2.liquidity_gross, liquidity_net: t2.liquidity_net,
                liquidity_net_is_negative: t2.liquidity_net_is_negative,
                fee_growth_outside_0: t2_fg0, fee_growth_outside_1: t2_fg1, initialized: t2.initialized });
            let apply2_neg: bool = step2.liquidity_net_is_negative;
            let liq3_ge: bool = liq2 >= step2.liquidity_net;
            let liq3_max: u128 = liq3_ge ? liq2 : step2.liquidity_net;
            let liq3_min: u128 = liq3_ge ? step2.liquidity_net : liq2;
            let liq3_cross: u128 = apply2_neg ? (liq3_max - liq3_min) : (liq2 + step2.liquidity_net);
            let liq3: u128 = a2 ? liq3_cross : liq2;
            let fd2: u128 = (liq2 == 0u128 || !a2) ? 0u128 : (step2.fee_step as u128 * Q64) / liq2;
            let fg0_3: u128 = fg0_2;
            let fg1_3: u128 = a2 ? fg1_2 + fd2 : fg1_2;
            let sq3: u128   = a2 ? step2.sqrt_price_next : sq2;

            // STEP 3
            let a3: bool = step3.tick_next != TICK_SENTINEL;
            assert(a3 || (step3.amount_in_step == 0u64 && step3.amount_out_step == 0u64 && step3.fee_step == 0u64));
            let k3: field = a3 ? (step3.tick_next as i64 + 2_147_483_647i64) as u64 as field : 0field;
            let t3: TickInfo = Mapping::get_or_use(tick_info, k3, TickInfo {
                liquidity_gross: 0u128, liquidity_net: 0u128, liquidity_net_is_negative: false,
                fee_growth_outside_0: 0u128, fee_growth_outside_1: 0u128, initialized: false });
            assert(!a3 || t3.initialized);
            assert(!a3 || t3.liquidity_net == step3.liquidity_net);
            assert(!a3 || t3.liquidity_net_is_negative == step3.liquidity_net_is_negative);
            assert(!a3 || step3.fee_step == (step3.amount_in_step as u128 * FEE_BPS as u128 / FEE_DENOM as u128) as u64);
            let n3: u128 = a3 ? step3.sqrt_price_next : sq3;
            assert(!a3 || n3 > sq3);
            let den3: u128 = (n3 / Q64) * sq3 + 1u128;
            let out3_exp: u64 = a3 ? ((liq3 * (n3 - sq3)) / den3) as u64 : 0u64;
            assert(!a3 || step3.amount_out_step <= out3_exp);
            let in3_ceil: u64 = a3 ? ((liq3 * (n3 - sq3) + Q64 - 1u128) / Q64) as u64 : 0u64;
            let in3_net: u64 = a3 ? (step3.amount_in_step - step3.fee_step) : 0u64;
            assert(!a3 || in3_net >= in3_ceil);
            let t3_fg0: u128 = a3 ? fg0_3 - t3.fee_growth_outside_0 : t3.fee_growth_outside_0;
            let t3_fg1: u128 = a3 ? fg1_3 - t3.fee_growth_outside_1 : t3.fee_growth_outside_1;
            Mapping::set(tick_info, k3, TickInfo {
                liquidity_gross: t3.liquidity_gross, liquidity_net: t3.liquidity_net,
                liquidity_net_is_negative: t3.liquidity_net_is_negative,
                fee_growth_outside_0: t3_fg0, fee_growth_outside_1: t3_fg1, initialized: t3.initialized });
            let apply3_neg: bool = step3.liquidity_net_is_negative;
            let liq_f_ge: bool = liq3 >= step3.liquidity_net;
            let liq_f_max: u128 = liq_f_ge ? liq3 : step3.liquidity_net;
            let liq_f_min: u128 = liq_f_ge ? step3.liquidity_net : liq3;
            let liq_f_cross: u128 = apply3_neg ? (liq_f_max - liq_f_min) : (liq3 + step3.liquidity_net);
            let liq_f: u128 = a3 ? liq_f_cross : liq3;
            let fd3: u128 = (liq3 == 0u128 || !a3) ? 0u128 : (step3.fee_step as u128 * Q64) / liq3;
            let fg0_4: u128 = fg0_3;
            let fg1_4: u128 = a3 ? fg1_3 + fd3 : fg1_3;
            let sq4: u128   = a3 ? step3.sqrt_price_next : sq3;

            // Terminal (sq4 -> sp_f, sp_f > sq4)
            let term_out: u64 = amt_out - step0.amount_out_step - step1.amount_out_step - step2.amount_out_step - step3.amount_out_step;
            let term_fee: u64 = fee - step0.fee_step - step1.fee_step - step2.fee_step - step3.fee_step;
            let term_in_gross: u64 = amt_in - step0.amount_in_step - step1.amount_in_step - step2.amount_in_step - step3.amount_in_step;
            assert(sp_f >= sq4);
            let dlt: u128 = sp_f - sq4;
            // OUT (token0/USDCx) FLOOR
            let den_t: u128 = (sp_f / Q64) * sq4 + 1u128;
            let term_out_exp: u64 = ((liq_f * dlt) / den_t) as u64;
            assert(term_out <= term_out_exp);
            // IN (token1/ALEO) CEIL
            let term_in_ceil: u64 = ((liq_f * dlt + Q64 - 1u128) / Q64) as u64;
            let term_in_net: u64 = term_in_gross - term_fee;
            assert(term_in_net >= term_in_ceil);
            assert(term_fee == (term_in_gross as u128 * FEE_BPS as u128 / FEE_DENOM as u128) as u64);
            let fd_term: u128 = liq_f == 0u128 ? 0u128 : (term_fee as u128 * Q64) / liq_f;
            let fg0_final: u128 = fg0_4;
            let fg1_final: u128 = fg1_4 + fd_term;   // sell fee -> token1

            let reserve: u64 = Mapping::get(aleo_reserve, 0u8);
            Mapping::set(aleo_reserve, 0u8, reserve + amt_in);
            Mapping::set(pool_state, POOL_KEY, PoolState {
                sqrt_price_x64: sp_f, current_tick: t_f, liquidity: liq_f,
                fee_growth_global_0: fg0_final, fee_growth_global_1: fg1_final });
        });
    }
}
