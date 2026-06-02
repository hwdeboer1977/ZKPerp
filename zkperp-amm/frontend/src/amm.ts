// amm.ts — ZKPerp AMM frontend helpers.
//
// All on-chain-relevant math is EXACT bigint mirroring the contract's integer
// routines (sqrt_ratio_at_tick, the liquidity-derived CEIL deposits, and the
// swap terminal FLOOR/CEIL). Float math is used ONLY for display (prices).
//
// Verified against devnet:
//   mint (L=1700000, price 10, ticks 16080/30000) -> amount0=177280 amount1=1577442
//   buy  50000 USDCx -> out 434679, fee 150, sqrt 53617007038538979776, tick 21340
//
// IMPORTANT config notes:
//  • PROGRAM_ID / API below target public testnet v4b. For LOCAL devnet, set
//    API='http://localhost:3030/testnet' and PROGRAM_ID='zkperp_amm_devnet.aleo'.
//  • The pool MUST be initialized in the price>=1 orientation (e.g. price 10:
//    sqrt 58333726687135158849, tick 23027, ranges in positive ticks). At price
//    0.1 the token0 denominator degenerates and mint/swap will be rejected.

// ── Constants ─────────────────────────────────────────────────
export const PROGRAM_ID    = 'zkperp_amm_v6.aleo'
export const USDCX_ID      = 'test_usdcx_stablecoin.aleo'
export const API           = 'https://api.explorer.provable.com/v1/testnet'
export const Q64           = 2n ** 64n
export const FEE_BPS       = 3000n
export const FEE_DENOM     = 1_000_000n
export const TICK_SENTINEL = 887221
export const TICK_SPACING  = 60
export const OP_CAP        = 88440
export const MAX_U32       = 4294967295  // deadline sentinel (never expires)
const U128MAX = (1n << 128n) - 1n

export const ZERO_PROOF = '[{siblings: [0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field], leaf_index: 1u32}, {siblings: [0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field], leaf_index: 1u32}]'

// 20 magic constants: floor(sqrt(1.0001)^(-2^i) * 2^64), round-half-even.
const SR: bigint[] = [
  18445821805675392312n, 18444899583751176498n, 18443055278223354163n, 18439367220385604838n,
  18431993317065449818n, 18417254355718160513n, 18387811781193591352n, 18329067761203520168n,
  18212142134806087855n, 17980523815641551639n, 17526086738831147014n, 16651378430235024244n,
  15030750278693429945n, 12247334978882834400n, 8131365268884726201n,  3584323654723342298n,
  696457651847595234n,   26294789957452057n,    37481735321082n,        76158724n,
]

// ── Types ─────────────────────────────────────────────────────
export interface PoolState {
  sqrtPriceX64: bigint
  currentTick:  number
  liquidity:    bigint
  feeGrowth0:   bigint
  feeGrowth1:   bigint
}

export interface TickStep {
  tick_next:                 number
  sqrt_price_next:           bigint
  liquidity_net:             bigint
  liquidity_net_is_negative: boolean
  amount_in_step:            bigint
  amount_out_step:           bigint
  fee_step:                  bigint
}

export interface SwapQuote {
  amountIn:   bigint
  amountOut:  bigint
  fee:        bigint
  minOut:     bigint
  deadline:   number
  sqrtAfter:  bigint
  tickAfter:  number
  impactBps:  number
  steps:      TickStep[]
}

export interface MintQuote {
  tickLower:    number
  tickUpper:    number
  liquidity:    bigint
  amount0:      bigint   // USDCx needed (CEIL)
  amount1:      bigint   // ALEO needed  (CEIL)
  feeGrowthIn0: bigint
  feeGrowthIn1: bigint
  priceLower:   number
  priceUpper:   number
  priceCurrent: number
}

export interface LPPosition {
  plaintext:      string
  tickLower:      number
  tickUpper:      number
  liquidity:      bigint
  feeGrowth0Last: bigint
  feeGrowth1Last: bigint
  tokensOwed0:    bigint
  tokensOwed1:    bigint
  label:          string
}

// ── Pool fetch ────────────────────────────────────────────────
export async function fetchPoolState(): Promise<PoolState | null> {
  try {
    const res = await fetch(`${API}/program/${PROGRAM_ID}/mapping/pool_state/0u8`)
    if (!res.ok) return null
    return parsePoolState(await res.text())
  } catch { return null }
}

function parsePoolState(raw: string): PoolState {
  const n = (field: string, suffix: string) => {
    const m = raw.match(new RegExp(`${field}:\\s*(-?\\d+)${suffix}`))
    return m ? m[1] : '0'
  }
  return {
    sqrtPriceX64: BigInt(n('sqrt_price_x64', 'u128')),
    currentTick:  parseInt(n('current_tick',  'i32')),
    liquidity:    BigInt(n('liquidity',       'u128')),
    feeGrowth0:   BigInt(n('fee_growth_global_0', 'u128')),
    feeGrowth1:   BigInt(n('fee_growth_global_1', 'u128')),
  }
}

// ── EXACT integer math (mirrors the contract) ─────────────────

/** Exact sqrt_ratio_at_tick (Q64.64). Identical to the in-circuit helper. */
export function sqrtRatioAtTick(tick: number): bigint {
  if (tick < -OP_CAP || tick > OP_CAP) throw new Error(`tick ${tick} out of envelope`)
  const neg = tick < 0
  let a = neg ? -tick : tick
  let r = Q64
  for (let i = 0; i < 20; i++) {
    if (a & (1 << i)) r = (r * SR[i]) / Q64
  }
  return neg ? r : U128MAX / r + 1n
}

/** Back-compat alias: old callers import tickToSqrtX64 (now exact). */
export const tickToSqrtX64 = sqrtRatioAtTick

/** Largest tick t with sqrtRatioAtTick(t) <= sp (contract current_tick semantics). */
export function sqrtToTick(sp: bigint): number {
  let lo = -OP_CAP, hi = OP_CAP
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (sqrtRatioAtTick(mid) <= sp) lo = mid
    else hi = mid - 1
  }
  return lo
}

export function alignTick(tick: number): number {
  return Math.floor(tick / TICK_SPACING) * TICK_SPACING
}

// ── Display-only float helpers (never used for tx inputs) ─────
export function sqrtToPrice(sqrtX64: bigint): number {
  const r = Number(sqrtX64) / Number(Q64)
  return r * r
}
export function tickToPrice(tick: number): number { return Math.pow(1.0001, tick) }
export function priceToTick(price: number): number { return Math.floor(Math.log(price) / Math.log(1.0001)) }
export function formatUsdc(amount: bigint): string { return (Number(amount) / 1_000_000).toFixed(6) }
export function formatAleo(amount: bigint): string { return (Number(amount) / 1_000_000).toFixed(6) }

// ── Liquidity deposit amounts — EXACT, mirrors mint_position finalize ─
export function getLiquidityAmounts(
  liq: bigint,
  sqrtCurrent: bigint,
  tickLower: number,
  tickUpper: number,
  currentTick: number,
): { amount0: bigint; amount1: bigint } {
  const spL = sqrtRatioAtTick(tickLower)
  const spU = sqrtRatioAtTick(tickUpper)
  const spC = sqrtCurrent
  const below = currentTick < tickLower
  const above = currentTick >= tickUpper

  const lo0 = below ? spL : spC
  const d0  = spU >= lo0 ? spU - lo0 : 0n
  const den0 = (spU / Q64) * lo0 + 1n
  const amount0 = above ? 0n : (liq * d0 + den0 - 1n) / den0   // CEIL

  const hi1 = above ? spU : spC
  const d1  = hi1 >= spL ? hi1 - spL : 0n
  const amount1 = below ? 0n : (liq * d1 + Q64 - 1n) / Q64     // CEIL

  return { amount0, amount1 }
}

// ── Mint quote ────────────────────────────────────────────────
export function computeMintQuote(
  pool: PoolState,
  tickLower: number,
  tickUpper: number,
  liquidityDesired: bigint,
): MintQuote | null {
  if (tickLower >= tickUpper) return null
  if (liquidityDesired <= 0n) return null

  const { amount0, amount1 } = getLiquidityAmounts(
    liquidityDesired, pool.sqrtPriceX64, tickLower, tickUpper, pool.currentTick
  )

  // fee_growth_inside: global as proxy (accurate for first mint in a fresh range)
  return {
    tickLower, tickUpper,
    liquidity:    liquidityDesired,
    amount0, amount1,
    feeGrowthIn0: pool.feeGrowth0,
    feeGrowthIn1: pool.feeGrowth1,
    priceLower:   tickToPrice(tickLower),
    priceUpper:   tickToPrice(tickUpper),
    priceCurrent: sqrtToPrice(pool.sqrtPriceX64),
  }
}

// ── Credits record helper ─────────────────────────────────────
export function parseCreditsRecordMicrocredits(plaintext: string): bigint | null {
  const m = plaintext.match(/microcredits:\s*(\d+)u64/)
  return m ? BigInt(m[1]) : null
}

// ── Build mint_position inputs (v5: 14 args) ──────────────────
export function buildMintInputs(
  q: MintQuote,
  tokenRecord: string,
  aleoRecord: string,
  pool: PoolState,
  merkleProof: string = ZERO_PROOF,
): string[] {
  const bal = parseCreditsRecordMicrocredits(aleoRecord)
  if (bal === null) throw new Error('buildMintInputs: aleoRecord is not a valid credits plaintext')
  if (bal < q.amount1) throw new Error(`buildMintInputs: aleoRecord ${bal} < required ${q.amount1}`)

  const max0 = q.amount0 * 110n / 100n   // 10% buffer; contract asserts actual <= max
  const max1 = q.amount1 * 110n / 100n
  return [
    tokenRecord,                  // 0  lp_token
    merkleProof,                  // 1  merkle_proof
    aleoRecord,                   // 2  aleo_in (credits)
    `${q.tickLower}i32`,          // 3  tick_lower
    `${q.tickUpper}i32`,          // 4  tick_upper
    `${q.liquidity}u128`,         // 5  liquidity_desired
    `${max0}u64`,                 // 6  amount_0_max
    `${max1}u64`,                 // 7  amount_1_max
    `${q.amount0}u64`,            // 8  amount_0_actual
    `${q.amount1}u64`,            // 9  amount_1_actual
    `${pool.sqrtPriceX64}u128`,   // 10 sqrt_price_x64 (verified on-chain)
    `${pool.currentTick}i32`,     // 11 current_tick   (verified on-chain)
    `${q.feeGrowthIn0}u128`,      // 12 fee_growth_inside_0
    `${q.feeGrowthIn1}u128`,      // 13 fee_growth_inside_1
  ]
}

// ── Parse LP position record ──────────────────────────────────
export function parseLPPosition(plaintext: string): LPPosition | null {
  try {
    const n = (field: string, suffix: string) => {
      const m = plaintext.match(new RegExp(`${field}:\\s*(-?\\d+)${suffix}`))
      return m ? m[1] : '0'
    }
    const tickLower = parseInt(n('tick_lower', 'i32'))
    const tickUpper = parseInt(n('tick_upper', 'i32'))
    const liquidity = BigInt(n('liquidity', 'u128'))
    const fg0 = BigInt(n('fee_growth_inside_0_last', 'u128'))
    const fg1 = BigInt(n('fee_growth_inside_1_last', 'u128'))
    const owed0 = BigInt(n('tokens_owed_0', 'u64'))
    const owed1 = BigInt(n('tokens_owed_1', 'u64'))
    return {
      plaintext, tickLower, tickUpper, liquidity,
      feeGrowth0Last: fg0, feeGrowth1Last: fg1,
      tokensOwed0: owed0, tokensOwed1: owed1,
      label: `[${tickToPrice(tickLower).toFixed(4)} – ${tickToPrice(tickUpper).toFixed(4)}] liq=${liquidity}`,
    }
  } catch { return null }
}

// ── Build burn_position inputs ────────────────────────────────
export function buildBurnInputs(
  pos: LPPosition,
  pool: PoolState,
  amount0Out: bigint,
  amount1Out: bigint,
): string[] {
  return [
    pos.plaintext,
    `${pool.feeGrowth0}u128`,
    `${pool.feeGrowth1}u128`,
    `${amount0Out}u64`,
    `${amount1Out}u64`,
    `${pool.sqrtPriceX64}u128`,
    `${pool.currentTick}i32`,
  ]
}

// ── Swap quote — EXACT terminal math; ALL steps empty (single range) ──
// slippageBps: tolerance below the exact out for min_amount_out (0 = none).
export function computeQuote(
  pool: PoolState,
  amountIn: bigint,
  zeroForOne: boolean,
  slippageBps: bigint = 50n,           // 0.50% default
  deadline: number = MAX_U32,
): SwapQuote | null {
  if (pool.liquidity === 0n) return null
  if (amountIn <= 0n) return null

  const { sqrtPriceX64: spC, liquidity: L } = pool
  const fee = (amountIn * FEE_BPS) / FEE_DENOM
  const net = amountIn - fee

  let sqrtAfter: bigint
  let amountOut: bigint

  if (zeroForOne) {
    // USDCx in, price DOWN. Find smallest sp_f whose required input (CEIL) <= net.
    let lo = 1n, hi = spC - 1n, best = 0n
    while (lo <= hi) {
      const m = (lo + hi) / 2n
      const den = (spC / Q64) * m + 1n
      const reqIn = (L * (spC - m) + den - 1n) / den       // contract CEIL
      if (reqIn <= net) { best = m; hi = m - 1n } else { lo = m + 1n }
    }
    sqrtAfter = best
    amountOut = (L * (spC - sqrtAfter)) / Q64               // FLOOR
  } else {
    // ALEO in, price UP. Find largest sp_f whose required ALEO input (CEIL) <= net.
    let lo = spC + 1n, hi = spC + (net * Q64) / L + 4n, best = spC + 1n
    while (lo <= hi) {
      const m = (lo + hi) / 2n
      const reqIn = (L * (m - spC) + Q64 - 1n) / Q64        // contract CEIL
      if (reqIn <= net) { best = m; lo = m + 1n } else { hi = m - 1n }
    }
    sqrtAfter = best
    const den = (sqrtAfter / Q64) * spC + 1n
    amountOut = (L * (sqrtAfter - spC)) / den               // FLOOR
  }

  const minOut = amountOut * (10000n - slippageBps) / 10000n
  const priceBefore = sqrtToPrice(spC)
  const priceAfter  = sqrtToPrice(sqrtAfter)
  const impactBps   = Math.abs((priceAfter - priceBefore) / priceBefore * 10000)

  const empty: TickStep = {
    tick_next: TICK_SENTINEL, sqrt_price_next: 0n,
    liquidity_net: 0n, liquidity_net_is_negative: false,
    amount_in_step: 0n, amount_out_step: 0n, fee_step: 0n,
  }

  return {
    amountIn, amountOut, fee, minOut, deadline,
    sqrtAfter, tickAfter: sqrtToTick(sqrtAfter),
    impactBps,
    steps: [empty, empty, empty, empty],   // single-range: amounts ride in totals
  }
}

export function stepToLeo(s: TickStep): string {
  return (
    `{tick_next:${s.tick_next}i32,` +
    `sqrt_price_next:${s.sqrt_price_next}u128,` +
    `liquidity_net:${s.liquidity_net}u128,` +
    `liquidity_net_is_negative:${s.liquidity_net_is_negative},` +
    `amount_in_step:${s.amount_in_step}u64,` +
    `amount_out_step:${s.amount_out_step}u64,` +
    `fee_step:${s.fee_step}u64}`
  )
}

// ── Build swap_buy inputs (v5: usdcx_in, proof, in, out, fee, min, deadline, sqrt, tick, step0..3) ──
export function buildSwapBuyInputs(
  q: SwapQuote,
  tokenRecord: string,
  merkleProof: string = ZERO_PROOF,
): string[] {
  return [
    tokenRecord,                  // 0  usdcx_in
    merkleProof,                  // 1  merkle_proof
    `${q.amountIn}u64`,           // 2  total_amount_in
    `${q.amountOut}u64`,          // 3  total_amount_out
    `${q.fee}u64`,                // 4  total_fee
    `${q.minOut}u64`,             // 5  min_amount_out
    `${q.deadline}u32`,           // 6  deadline
    `${q.sqrtAfter}u128`,         // 7  sqrt_price_final
    `${q.tickAfter}i32`,          // 8  tick_final
    ...q.steps.map(stepToLeo),    // 9-12 step0..step3
  ]
}

// ── Build swap_sell inputs (v5: proof, aleo_in, in, out, fee, min, deadline, sqrt, tick, step0..3) ──
export function buildSwapSellInputs(
  q: SwapQuote,
  aleoRecord: string,
  merkleProof: string = ZERO_PROOF,
): string[] {
  const bal = parseCreditsRecordMicrocredits(aleoRecord)
  if (bal === null) throw new Error('buildSwapSellInputs: aleoRecord is not a valid credits plaintext')
  if (bal < q.amountIn) throw new Error(`buildSwapSellInputs: aleoRecord ${bal} < required ${q.amountIn}`)
  return [
    merkleProof,                  // 0  merkle_proof (USDCx payout)
    aleoRecord,                   // 1  aleo_in (credits)
    `${q.amountIn}u64`,           // 2  total_amount_in
    `${q.amountOut}u64`,          // 3  total_amount_out
    `${q.fee}u64`,                // 4  total_fee
    `${q.minOut}u64`,             // 5  min_amount_out
    `${q.deadline}u32`,           // 6  deadline
    `${q.sqrtAfter}u128`,         // 7  sqrt_price_final
    `${q.tickAfter}i32`,          // 8  tick_final
    ...q.steps.map(stepToLeo),    // 9-12 step0..step3
  ]
}
