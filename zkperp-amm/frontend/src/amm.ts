// ── Constants ─────────────────────────────────────────────────
export const PROGRAM_ID    = 'zkperp_amm_v3.aleo'
export const USDCX_ID      = 'test_usdcx_stablecoin.aleo'
export const API           = 'https://api.explorer.provable.com/v1/testnet'
export const Q64           = 2n ** 64n
export const FEE_BPS       = 3000n
export const FEE_DENOM     = 1_000_000n
export const TICK_SENTINEL = 887221
export const TICK_SPACING  = 60

export const ZERO_PROOF = '[{siblings: [0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field], leaf_index: 1u32}, {siblings: [0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field, 0field], leaf_index: 1u32}]'

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
  sqrtAfter:  bigint
  tickAfter:  number
  impactBps:  number
  steps:      TickStep[]
}

export interface MintQuote {
  tickLower:       number
  tickUpper:       number
  liquidity:       bigint
  amount0:         bigint   // USDCx needed
  amount1:         bigint   // ALEO needed
  feeGrowthIn0:    bigint
  feeGrowthIn1:    bigint
  priceLower:      number
  priceUpper:      number
  priceCurrent:    number
}

export interface LPPosition {
  plaintext:       string
  tickLower:       number
  tickUpper:       number
  liquidity:       bigint
  feeGrowth0Last:  bigint
  feeGrowth1Last:  bigint
  tokensOwed0:     bigint
  tokensOwed1:     bigint
  label:           string
}

// ── Pool fetch ────────────────────────────────────────────────
export async function fetchPoolState(): Promise<PoolState | null> {
  try {
    const res = await fetch(`${API}/program/${PROGRAM_ID}/mapping/pool_state/0u8`)
    if (!res.ok) return null
    const raw = await res.text()
    return parsePoolState(raw)
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

// ── Math helpers ──────────────────────────────────────────────
export function sqrtToPrice(sqrtX64: bigint): number {
  const r = Number(sqrtX64) / Number(Q64)
  return r * r
}

export function sqrtToTick(sqrtX64: bigint): number {
  const price = sqrtToPrice(sqrtX64)
  if (price <= 0) return 0
  return Math.floor(Math.log(price) / Math.log(1.0001))
}

export function tickToSqrtX64(tick: number): bigint {
  const sqrtRatio = Math.pow(1.0001, tick / 2)
  return BigInt(Math.floor(sqrtRatio * Number(Q64)))
}

export function tickToPrice(tick: number): number {
  return Math.pow(1.0001, tick)
}

export function priceToTick(price: number): number {
  return Math.floor(Math.log(price) / Math.log(1.0001))
}

export function alignTick(tick: number): number {
  return Math.floor(tick / TICK_SPACING) * TICK_SPACING
}

export function formatUsdc(amount: bigint): string {
  return (Number(amount) / 1_000_000).toFixed(6)
}

export function formatAleo(amount: bigint): string {
  return (Number(amount) / 1_000_000).toFixed(6)
}

// ── Liquidity amount math ─────────────────────────────────────
// Q64 ~ 1.8e19 > JS Number.MAX_SAFE_INTEGER ~ 9e15 → precision loss.
// Fix: divide sqrt values by 2^32 using bigint (stays exact), then use floats.
// Verified formulas (S = 2^32):
//   amount0 = L * (sqrtHiS - sqrtLoS) * S / (sqrtHiS * sqrtLoS)
//   amount1 = L * (sqrtHiS - sqrtLoS) / S
const S = 4294967296  // 2^32

function toS(sqrt: bigint): number {
  // integer division by 2^32, result fits safely in JS float
  return Number(sqrt / 4294967296n)
}

export function getLiquidityAmounts(
  liq: bigint,
  sqrtCurrent: bigint,
  sqrtLower: bigint,
  sqrtUpper: bigint,
): { amount0: bigint; amount1: bigint } {
  const L      = Number(liq)
  const sqrtCS = toS(sqrtCurrent)
  const sqrtLS = toS(sqrtLower)
  const sqrtHS = toS(sqrtUpper)

  // amount0 = USDCx (token0), amount1 = ALEO (token1)
  // Formula: amount0 uses (sqrtHi-sqrtCur)/(sqrtHi*sqrtCur) — the 1/sqrt formula
  //          amount1 uses (sqrtCur-sqrtLo) — the sqrt formula
  let usdcx = 0, aleo = 0

  if (sqrtCS <= sqrtLS) {
    // Price below range — only USDCx needed
    usdcx = L * (sqrtHS - sqrtLS) * S / (sqrtHS * sqrtLS)
  } else if (sqrtCS < sqrtHS) {
    // Price in range — both tokens
    usdcx = L * (sqrtHS - sqrtCS) * S / (sqrtHS * sqrtCS)
    aleo  = L * (sqrtCS - sqrtLS) / S
  } else {
    // Price above range — only ALEO needed
    aleo = L * (sqrtHS - sqrtLS) / S
  }

  return {
    amount0: BigInt(Math.floor(usdcx)),  // token0 = USDCx
    amount1: BigInt(Math.floor(aleo)),   // token1 = ALEO
  }
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

  const sqrtLower   = tickToSqrtX64(tickLower)
  const sqrtUpper   = tickToSqrtX64(tickUpper)
  const sqrtCurrent = pool.sqrtPriceX64

  const { amount0, amount1 } = getLiquidityAmounts(
    liquidityDesired, sqrtCurrent, sqrtLower, sqrtUpper
  )

  // fee_growth_inside: simplified — use global as proxy when ticks not initialized
  // (accurate for first mint in a range)
  const feeGrowthIn0 = pool.feeGrowth0
  const feeGrowthIn1 = pool.feeGrowth1

  return {
    tickLower, tickUpper,
    liquidity:    liquidityDesired,
    amount0, amount1,
    feeGrowthIn0, feeGrowthIn1,
    priceLower:   tickToPrice(tickLower),
    priceUpper:   tickToPrice(tickUpper),
    priceCurrent: sqrtToPrice(sqrtCurrent),
  }
}

// ── Build mint_position inputs ────────────────────────────────
export function buildMintInputs(q: MintQuote, tokenRecord: string, pool: PoolState, merkleProof: string = ZERO_PROOF): string[] {
  // 10% slippage buffer on max amounts
  const max0 = q.amount0 * 110n / 100n
  const max1 = q.amount1 * 110n / 100n
  return [
    tokenRecord,
    merkleProof,
    `${q.tickLower}i32`,
    `${q.tickUpper}i32`,
    `${q.liquidity}u128`,
    `${max0}u64`,                          // amount_0_max
    `${max1}u64`,                          // amount_1_max
    `${q.amount0}u64`,                     // amount_0_actual
    `${q.amount1}u64`,                     // amount_1_actual
    `${pool.sqrtPriceX64}u128`,            // verified on-chain
    `${pool.currentTick}i32`,             // verified on-chain
    `${q.feeGrowthIn0}u128`,
    `${q.feeGrowthIn1}u128`,
  ]
}

// ── Parse LP position record ──────────────────────────────────
export function parseLPPosition(plaintext: string): LPPosition | null {
  try {
    const n = (field: string, suffix: string) => {
      const m = plaintext.match(new RegExp(`${field}:\\s*(-?\\d+)${suffix}`))
      return m ? m[1] : '0'
    }
    const tickLower  = parseInt(n('tick_lower', 'i32'))
    const tickUpper  = parseInt(n('tick_upper', 'i32'))
    const liquidity  = BigInt(n('liquidity', 'u128'))
    const fg0        = BigInt(n('fee_growth_inside_0_last', 'u128'))
    const fg1        = BigInt(n('fee_growth_inside_1_last', 'u128'))
    const owed0      = BigInt(n('tokens_owed_0', 'u64'))
    const owed1      = BigInt(n('tokens_owed_1', 'u64'))
    const pLo        = tickToPrice(tickLower).toFixed(4)
    const pHi        = tickToPrice(tickUpper).toFixed(4)
    return {
      plaintext, tickLower, tickUpper, liquidity,
      feeGrowth0Last: fg0, feeGrowth1Last: fg1,
      tokensOwed0: owed0, tokensOwed1: owed1,
      label: `[${pLo} – ${pHi}] liq=${liquidity}`,
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
    ZERO_PROOF,
    `${pool.feeGrowth0}u128`,
    `${pool.feeGrowth1}u128`,
    `${amount0Out}u64`,
    `${amount1Out}u64`,
    `${pool.sqrtPriceX64}u128`,
    `${pool.currentTick}i32`,
  ]
}

// ── Swap quote ────────────────────────────────────────────────
export function computeQuote(
  pool: PoolState,
  amountIn: bigint,
  zeroForOne: boolean,
): SwapQuote | null {
  if (pool.liquidity === 0n) return null

  const { sqrtPriceX64, liquidity } = pool
  const fee = (amountIn * FEE_BPS) / FEE_DENOM
  const net = amountIn - fee

  let sqrtAfter: bigint
  let amountOut: bigint

  if (zeroForOne) {
    const num = liquidity * Q64 * sqrtPriceX64
    const den = liquidity * Q64 + net * sqrtPriceX64
    sqrtAfter = num / den
    amountOut = (liquidity * (sqrtPriceX64 - sqrtAfter)) / Q64
  } else {
    sqrtAfter = sqrtPriceX64 + (net * Q64) / liquidity
    const delta = sqrtAfter - sqrtPriceX64
    const denom = (sqrtAfter / Q64) * sqrtPriceX64 + 1n
    amountOut = (liquidity * delta) / denom
  }

  const priceBefore = sqrtToPrice(sqrtPriceX64)
  const priceAfter  = sqrtToPrice(sqrtAfter)
  const impactBps   = Math.abs((priceAfter - priceBefore) / priceBefore * 10000)

  const emptyStep: TickStep = {
    tick_next: TICK_SENTINEL, sqrt_price_next: 0n,
    liquidity_net: 0n, liquidity_net_is_negative: false,
    amount_in_step: 0n, amount_out_step: 0n, fee_step: 0n,
  }
  const step0: TickStep = {
    ...emptyStep,
    amount_in_step: amountIn, amount_out_step: amountOut, fee_step: fee,
  }

  return {
    amountIn, amountOut, fee,
    sqrtAfter, tickAfter: sqrtToTick(sqrtAfter),
    impactBps,
    steps: [step0, emptyStep, emptyStep, emptyStep],
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

export function buildSwapBuyInputs(q: SwapQuote, tokenRecord: string, merkleProof: string = ZERO_PROOF): string[] {
  return [
    tokenRecord, merkleProof,
    `${q.amountIn}u64`, `${q.amountOut}u64`, `${q.fee}u64`,
    `${q.sqrtAfter}u128`, `${q.tickAfter}i32`,
    ...q.steps.map(stepToLeo),
  ]
}

export function buildSwapSellInputs(q: SwapQuote): string[] {
  return [
    ZERO_PROOF,
    `${q.amountIn}u64`, `${q.amountOut}u64`, `${q.fee}u64`,
    `${q.sqrtAfter}u128`, `${q.tickAfter}i32`,
    ...q.steps.map(stepToLeo),
  ]
}
