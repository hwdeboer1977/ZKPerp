/**
 * zkcl-amm-bot.mjs
 * Orchestrator for zkcl_amm_v1.aleo — Concentrated Liquidity AMM
 *
 * Role change vs. the old design:
 *   The orchestrator NO LONGER decides swap routing or amounts.
 *   It only COMPUTES the TickStep structs that the on-chain circuit
 *   will verify independently. All values are verifiable on-chain.
 *
 * What the orchestrator does:
 *   1. Maintains a local tick map (mirror of on-chain tick_info)
 *   2. Given a swap request, finds up to 4 tick crossings
 *   3. Computes exact amounts per step using Uniswap v3 math
 *   4. Builds TickStep[4] array (unused slots = SENTINEL)
 *   5. Submits the swap transition — chain verifies everything
 *
 * What the orchestrator CANNOT do:
 *   - Fabricate liquidity_net (checked against tick_info on-chain)
 *   - Fabricate amount_out (verified via constant-product on-chain)
 *   - Modify fees (verified as exact 30bps on-chain)
 *   - Submit amounts that don't sum to totals (sum check on-chain)
 */

import Fastify from 'fastify';
import { AleoNetworkClient, ProgramManager } from '@provablehq/sdk/testnet.js';
import dotenv from 'dotenv';
dotenv.config();

// ─── Constants ────────────────────────────────────────────────────────────────

const PROGRAM_ID  = process.env.PROGRAM_ID  || 'zkcl_amm_v1.aleo';
const NETWORK_URL = process.env.NETWORK_URL || 'https://api.explorer.provable.com/v1';
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const PORT        = parseInt(process.env.PORT || '3020');

const FEE_BPS      = 3000n;
const FEE_DENOM    = 1_000_000n;
const TICK_SPACING = 60;
const Q64          = 1n << 64n;
const MAX_TICK     = 887_220;
const TICK_SENTINEL = 887_221;

// ─── Q64 / Tick Math ──────────────────────────────────────────────────────────

const tickToSqrtPriceX64 = (tick) => {
  const sqrtRatio = Math.pow(1.0001, tick / 2);
  return BigInt(Math.floor(sqrtRatio * Number(Q64)));
};

const sqrtPriceX64ToTick = (sqrtPriceX64) => {
  const ratio = Number(sqrtPriceX64) / Number(Q64);
  return Math.floor(Math.log(ratio * ratio) / Math.log(1.0001));
};

const priceToSqrtPriceX64 = (price) =>
  BigInt(Math.floor(Math.sqrt(price) * Number(Q64)));

const sqrtPriceX64ToPrice = (s) => {
  const r = Number(s) / Number(Q64);
  return r * r;
};

// token1 (ALEO) out for sqrt move lo→hi: L*(hi-lo)/Q64
const amount1Delta = (liq, sqrtLo, sqrtHi) => {
  if (sqrtHi < sqrtLo) [sqrtLo, sqrtHi] = [sqrtHi, sqrtLo];
  return (liq * (sqrtHi - sqrtLo)) / Q64;
};

// token0 (USDCx) out for sqrt move lo→hi: L*Q64*(hi-lo)/(hi*lo)
const amount0Delta = (liq, sqrtLo, sqrtHi) => {
  if (sqrtHi < sqrtLo) [sqrtLo, sqrtHi] = [sqrtHi, sqrtLo];
  const delta = sqrtHi - sqrtLo;
  const denom = (sqrtHi / Q64) * sqrtLo + 1n;
  return (liq * delta) / denom;
};

// New sqrt price after swapping amountIn of token0 into pool
// sqrtNew = (L * Q64 * sqrtOld) / (L * Q64 + amountIn * sqrtOld)
const sqrtPriceAfterToken0In = (liq, sqrtOld, amountIn) => {
  const num = liq * Q64 * sqrtOld;
  const den = liq * Q64 + amountIn * sqrtOld;
  return num / den;
};

// New sqrt price after swapping amountIn of token1 into pool
// sqrtNew = sqrtOld + amountIn * Q64 / L
const sqrtPriceAfterToken1In = (liq, sqrtOld, amountIn) => {
  return sqrtOld + (amountIn * Q64) / liq;
};

// ─── Off-Chain State ──────────────────────────────────────────────────────────

// Local mirror of on-chain tick_info mapping
// key: tick (number) → { liquidityGross, liquidityNet, liquidityNetIsNegative,
//                         feeGrowthOutside0, feeGrowthOutside1, initialized }
const tickMap = new Map();

let poolState = null;   // current on-chain pool state
let aleoReserve = 0n;

// ─── Aleo Client ──────────────────────────────────────────────────────────────

const aleoClient = new AleoNetworkClient(NETWORK_URL);

const parseu = (raw, field, suffix) => {
  const m = raw.match(new RegExp(`${field}:\\s*([\\d]+)${suffix}`));
  return m ? m[1] : '0';
};
const parseb = (raw, field) => {
  const m = raw.match(new RegExp(`${field}:\\s*(true|false)`));
  return m ? m[1] === 'true' : false;
};

const parsePoolState = (raw) => ({
  sqrtPriceX64:      BigInt(parseu(raw, 'sqrt_price_x64', 'u128')),
  currentTick:       parseInt(parseu(raw, 'current_tick', 'i32')),
  liquidity:         BigInt(parseu(raw, 'liquidity', 'u128')),
  feeGrowthGlobal0:  BigInt(parseu(raw, 'fee_growth_global_0', 'u128')),
  feeGrowthGlobal1:  BigInt(parseu(raw, 'fee_growth_global_1', 'u128')),
  protocolFees0:     BigInt(parseu(raw, 'protocol_fees_0', 'u64')),
  protocolFees1:     BigInt(parseu(raw, 'protocol_fees_1', 'u64')),
});

const parseTickInfo = (raw) => ({
  liquidityGross:          BigInt(parseu(raw, 'liquidity_gross', 'u128')),
  liquidityNet:            BigInt(parseu(raw, 'liquidity_net', 'u128')),
  liquidityNetIsNegative:  parseb(raw, 'liquidity_net_is_negative'),
  feeGrowthOutside0:       BigInt(parseu(raw, 'fee_growth_outside_0', 'u128')),
  feeGrowthOutside1:       BigInt(parseu(raw, 'fee_growth_outside_1', 'u128')),
  initialized:             parseb(raw, 'initialized'),
});

const tickToField = (tick) => `${tick + 2147483647}field`;

async function syncPoolState() {
  try {
    const raw = await aleoClient.getProgramMappingValue(PROGRAM_ID, 'pool_state', '0u8');
    if (raw) poolState = parsePoolState(raw);

    const res = await aleoClient.getProgramMappingValue(PROGRAM_ID, 'aleo_reserve', '0u8');
    if (res) aleoReserve = BigInt(res.replace('u64', ''));

    // Re-sync known ticks
    for (const tick of tickMap.keys()) {
      const traw = await aleoClient.getProgramMappingValue(
        PROGRAM_ID, 'tick_info', tickToField(tick));
      if (traw) tickMap.set(tick, parseTickInfo(traw));
    }
    if (poolState) {
      console.log(`[AMM] Synced: tick=${poolState.currentTick} price=${sqrtPriceX64ToPrice(poolState.sqrtPriceX64).toFixed(4)} liq=${poolState.liquidity}`);
    }
  } catch (e) {
    console.error('[AMM] Sync error:', e.message);
  }
}

// ─── Swap Router — builds TickStep[4] ─────────────────────────────────────────

/**
 * Build up to 4 TickStep structs for a swap.
 * Returns { steps[4], totalIn, totalOut, totalFee, sqrtFinal, tickFinal }
 *
 * Each step corresponds to one tick crossing.
 * The "terminal step" (final partial range) is not a TickStep —
 * it's implied by (totalOut - sum(step.amountOut)).
 */
function buildSwapSteps(zeroForOne, amountIn) {
  if (!poolState) throw new Error('Pool not synced');

  const totalFee = (amountIn * FEE_BPS) / FEE_DENOM;
  const amountInNet = amountIn - totalFee;

  // Find initialized ticks in the swap direction
  const sortedTicks = [...tickMap.entries()]
    .filter(([, info]) => info.initialized)
    .map(([tick]) => tick)
    .sort((a, b) => a - b);

  // Ticks to cross: in direction of price movement
  const ticksToCross = zeroForOne
    ? sortedTicks.filter(t => t <= poolState.currentTick).reverse()  // downward
    : sortedTicks.filter(t => t > poolState.currentTick);            // upward

  // Cap at 4 crossings
  const crossings = ticksToCross.slice(0, 4);

  const EMPTY_STEP = {
    tick_next: TICK_SENTINEL,
    sqrt_price_next: 0n,
    liquidity_net: 0n,
    liquidity_net_is_negative: false,
    amount_in_step: 0n,
    amount_out_step: 0n,
    fee_step: 0n,
  };

  const steps = [{ ...EMPTY_STEP }, { ...EMPTY_STEP }, { ...EMPTY_STEP }, { ...EMPTY_STEP }];

  let sqrtCurrent = poolState.sqrtPriceX64;
  let liqCurrent = poolState.liquidity;
  let amountRemaining = amountInNet;
  let totalOut = 0n;
  let totalFeeUsed = 0n;

  for (let i = 0; i < crossings.length; i++) {
    const tick = crossings[i];
    const tickData = tickMap.get(tick);
    const sqrtNext = BigInt(tickToSqrtPriceX64(tick));

    // How much can we consume to reach this tick boundary?
    let amountToReach, outAtBoundary;

    if (zeroForOne) {
      // token0 in: compute how much token0 moves price from sqrtCurrent to sqrtNext
      // Reverse: from sqrtNew = (L*Q64*sqrtOld)/(L*Q64 + amountIn*sqrtOld)
      // → amountIn = L*Q64*(sqrtOld - sqrtNew) / (sqrtNew * sqrtOld/Q64)  -- but use amount0Delta
      // We use: amount0 to move from sqrtNext to sqrtCurrent (token0 input)
      amountToReach = amount0Delta(liqCurrent, sqrtNext, sqrtCurrent);
      outAtBoundary = amount1Delta(liqCurrent, sqrtNext, sqrtCurrent);
    } else {
      // token1 in: amount1 to move from sqrtCurrent to sqrtNext
      amountToReach = amount1Delta(liqCurrent, sqrtCurrent, sqrtNext);
      outAtBoundary = amount0Delta(liqCurrent, sqrtCurrent, sqrtNext);
    }

    if (amountToReach > amountRemaining) {
      // Can't reach this tick — terminal step handles remainder
      break;
    }

    // Fee for this step (proportional to amount consumed)
    const stepFee = (amountToReach * FEE_BPS) / FEE_DENOM;

    steps[i] = {
      tick_next: tick,
      sqrt_price_next: sqrtNext,
      liquidity_net: tickData.liquidityNet,
      liquidity_net_is_negative: tickData.liquidityNetIsNegative,
      amount_in_step: amountToReach + stepFee,  // gross (including fee)
      amount_out_step: outAtBoundary,
      fee_step: stepFee,
    };

    totalOut += outAtBoundary;
    totalFeeUsed += stepFee;
    amountRemaining -= amountToReach;

    // Update liquidity for next step
    if (zeroForOne) {
      liqCurrent = tickData.liquidityNetIsNegative
        ? liqCurrent + tickData.liquidityNet
        : liqCurrent - tickData.liquidityNet;
    } else {
      liqCurrent = tickData.liquidityNetIsNegative
        ? liqCurrent - tickData.liquidityNet
        : liqCurrent + tickData.liquidityNet;
    }
    sqrtCurrent = sqrtNext;
  }

  // Terminal step: consume remaining amount in final tick range
  let sqrtFinal;
  let termOut;

  if (amountRemaining > 0n) {
    const termFee = (amountRemaining * FEE_BPS) / FEE_DENOM;
    const termNet = amountRemaining - termFee;

    if (zeroForOne) {
      sqrtFinal = sqrtPriceAfterToken0In(liqCurrent, sqrtCurrent, termNet);
      termOut = amount1Delta(liqCurrent, sqrtFinal, sqrtCurrent);
    } else {
      sqrtFinal = sqrtPriceAfterToken1In(liqCurrent, sqrtCurrent, termNet);
      termOut = amount0Delta(liqCurrent, sqrtCurrent, sqrtFinal);
    }
    totalOut += termOut;
    totalFeeUsed += termFee;
  } else {
    sqrtFinal = sqrtCurrent;
    termOut = 0n;
  }

  const tickFinal = sqrtPriceX64ToTick(sqrtFinal);
  const alignedTickFinal = Math.floor(tickFinal / TICK_SPACING) * TICK_SPACING;

  return {
    steps,
    totalAmountIn: amountIn,
    totalAmountOut: totalOut,
    totalFee: totalFeeUsed,
    sqrtFinal,
    tickFinal: alignedTickFinal,
    ticksCrossed: crossings.length,
  };
}

// ─── Leo Input Serialization ──────────────────────────────────────────────────

function stepToLeoStruct(step) {
  return `{tick_next:${step.tick_next}i32,sqrt_price_next:${step.sqrt_price_next}u128,liquidity_net:${step.liquidity_net}u128,liquidity_net_is_negative:${step.liquidity_net_is_negative},amount_in_step:${step.amount_in_step}u64,amount_out_step:${step.amount_out_step}u64,fee_step:${step.fee_step}u64}`;
}

// ─── Compute fee_growth_inside ────────────────────────────────────────────────

function computeFeeGrowthInside(tickLower, tickUpper) {
  if (!poolState) throw new Error('Pool not synced');
  const { currentTick, feeGrowthGlobal0: g0, feeGrowthGlobal1: g1 } = poolState;

  const lo = tickMap.get(tickLower) || { feeGrowthOutside0: 0n, feeGrowthOutside1: 0n };
  const hi = tickMap.get(tickUpper) || { feeGrowthOutside0: 0n, feeGrowthOutside1: 0n };

  const fgb0 = tickLower <= currentTick ? lo.feeGrowthOutside0 : g0 - lo.feeGrowthOutside0;
  const fgb1 = tickLower <= currentTick ? lo.feeGrowthOutside1 : g1 - lo.feeGrowthOutside1;
  const fga0 = tickUpper >  currentTick ? hi.feeGrowthOutside0 : g0 - hi.feeGrowthOutside0;
  const fga1 = tickUpper >  currentTick ? hi.feeGrowthOutside1 : g1 - hi.feeGrowthOutside1;

  return { feeGrowthInside0: g0 - fgb0 - fga0, feeGrowthInside1: g1 - fgb1 - fga1 };
}

// ─── Mint amount calculation ──────────────────────────────────────────────────

function computeMintAmounts(tickLower, tickUpper, liquidity) {
  if (!poolState) throw new Error('Pool not synced');
  const sqrtLo = BigInt(tickToSqrtPriceX64(tickLower));
  const sqrtHi = BigInt(tickToSqrtPriceX64(tickUpper));
  const sqrtCur = poolState.sqrtPriceX64;

  let amount0 = 0n, amount1 = 0n;
  if (sqrtCur <= sqrtLo) {
    amount0 = amount0Delta(liquidity, sqrtLo, sqrtHi);
  } else if (sqrtCur < sqrtHi) {
    amount0 = amount0Delta(liquidity, sqrtCur, sqrtHi);
    amount1 = amount1Delta(liquidity, sqrtLo, sqrtCur);
  } else {
    amount1 = amount1Delta(liquidity, sqrtLo, sqrtHi);
  }
  return { amount0, amount1 };
}

// ─── Transaction Submission ───────────────────────────────────────────────────

async function submitTx(transition, inputs) {
  console.log(`[AMM] Submitting ${transition}...`);
  const pm = new ProgramManager(NETWORK_URL);
  const tx = await pm.buildExecutionTransaction({
    programName: PROGRAM_ID, functionName: transition,
    fee: 0.05, privateFee: false, inputs, privateKey: PRIVATE_KEY,
  });
  const txId = await aleoClient.submitTransaction(tx);
  console.log(`[AMM] ✓ ${transition}: ${txId}`);
  return txId;
}

// ─── REST API ─────────────────────────────────────────────────────────────────

const app = Fastify({ logger: false });

app.get('/pool', async () => {
  await syncPoolState();
  if (!poolState) return { initialized: false };
  return {
    initialized: true,
    price: sqrtPriceX64ToPrice(poolState.sqrtPriceX64),
    current_tick: poolState.currentTick,
    liquidity: poolState.liquidity.toString(),
    sqrt_price_x64: poolState.sqrtPriceX64.toString(),
    aleo_reserve: aleoReserve.toString(),
  };
});

// Quote a swap — returns full TickStep breakdown for transparency
app.post('/quote', async (req) => {
  const { zero_for_one, amount_in } = req.body;
  await syncPoolState();
  const result = buildSwapSteps(zero_for_one, BigInt(amount_in));
  return {
    amount_in: result.totalAmountIn.toString(),
    amount_out: result.totalAmountOut.toString(),
    fee: result.totalFee.toString(),
    sqrt_price_final: result.sqrtFinal.toString(),
    tick_final: result.tickFinal,
    ticks_crossed: result.ticksCrossed,
    price_impact_pct: ((Math.abs(sqrtPriceX64ToPrice(result.sqrtFinal) -
      sqrtPriceX64ToPrice(poolState.sqrtPriceX64)) /
      sqrtPriceX64ToPrice(poolState.sqrtPriceX64)) * 100).toFixed(4),
    // Show the steps so frontend can display what will be verified on-chain
    steps: result.steps.map(s => ({
      tick: s.tick_next, amount_in: s.amount_in_step.toString(),
      amount_out: s.amount_out_step.toString(), fee: s.fee_step.toString(),
    })),
  };
});

// Submit a swap
app.post('/swap', async (req) => {
  const { zero_for_one, amount_in, usdcx_record, usdcx_proof, min_amount_out = '0' } = req.body;
  await syncPoolState();

  const result = buildSwapSteps(zero_for_one, BigInt(amount_in));
  if (result.totalAmountOut < BigInt(min_amount_out)) {
    throw new Error(`Slippage: got ${result.totalAmountOut}, min ${min_amount_out}`);
  }

  const inputs = [
    zero_for_one.toString(),
    usdcx_record,
    JSON.stringify(usdcx_proof),
    `${result.totalAmountIn}u64`,
    `${result.totalAmountOut}u64`,
    `${result.totalFee}u64`,
    `${result.sqrtFinal}u128`,
    `${result.tickFinal}i32`,
    stepToLeoStruct(result.steps[0]),
    stepToLeoStruct(result.steps[1]),
    stepToLeoStruct(result.steps[2]),
    stepToLeoStruct(result.steps[3]),
  ];

  const txId = await submitTx('swap', inputs);
  return { tx_id: txId, amount_out: result.totalAmountOut.toString() };
});

// Add liquidity
app.post('/mint', async (req) => {
  const { tick_lower, tick_upper, liquidity, amount_0_max, amount_1_max, usdcx_record, usdcx_proof } = req.body;
  await syncPoolState();

  if (tick_lower % TICK_SPACING !== 0 || tick_upper % TICK_SPACING !== 0)
    throw new Error(`Ticks must be multiples of ${TICK_SPACING}`);

  const liq = BigInt(liquidity);
  const { amount0, amount1 } = computeMintAmounts(tick_lower, tick_upper, liq);
  if (amount0 > BigInt(amount_0_max)) throw new Error('amount0 exceeds max');
  if (amount1 > BigInt(amount_1_max)) throw new Error('amount1 exceeds max');

  const { feeGrowthInside0, feeGrowthInside1 } = computeFeeGrowthInside(tick_lower, tick_upper);

  const txId = await submitTx('mint_position', [
    usdcx_record, JSON.stringify(usdcx_proof),
    `${tick_lower}i32`, `${tick_upper}i32`, `${liq}u128`,
    `${amount0}u64`, `${amount1}u64`, `${amount0}u64`, `${amount1}u64`,
    `${feeGrowthInside0}u128`, `${feeGrowthInside1}u128`,
  ]);

  // Register ticks locally
  if (!tickMap.has(tick_lower)) tickMap.set(tick_lower, { initialized: false });
  if (!tickMap.has(tick_upper)) tickMap.set(tick_upper, { initialized: false });

  return { tx_id: txId, amount0: amount0.toString(), amount1: amount1.toString() };
});

// Remove liquidity
app.post('/burn', async (req) => {
  const { position_record, usdcx_proof } = req.body;
  await syncPoolState();

  // Parse position from Unshielded record string
  const tickLower = parseInt(position_record.match(/tick_lower:\s*(-?\d+)i32/)?.[1] || '0');
  const tickUpper = parseInt(position_record.match(/tick_upper:\s*(-?\d+)i32/)?.[1] || '0');
  const liq = BigInt(position_record.match(/liquidity:\s*(\d+)u128/)?.[1] || '0');
  const fgi0 = BigInt(position_record.match(/fee_growth_inside_0_last:\s*(\d+)u128/)?.[1] || '0');
  const fgi1 = BigInt(position_record.match(/fee_growth_inside_1_last:\s*(\d+)u128/)?.[1] || '0');

  const { feeGrowthInside0, feeGrowthInside1 } = computeFeeGrowthInside(tickLower, tickUpper);

  // Compute principal + fees
  const sqrtLo = BigInt(tickToSqrtPriceX64(tickLower));
  const sqrtHi = BigInt(tickToSqrtPriceX64(tickUpper));
  const sqrtCur = poolState.sqrtPriceX64;
  let amount0 = 0n, amount1 = 0n;
  if (sqrtCur <= sqrtLo) {
    amount0 = amount0Delta(liq, sqrtLo, sqrtHi);
  } else if (sqrtCur < sqrtHi) {
    amount0 = amount0Delta(liq, sqrtCur, sqrtHi);
    amount1 = amount1Delta(liq, sqrtLo, sqrtCur);
  } else {
    amount1 = amount1Delta(liq, sqrtLo, sqrtHi);
  }
  // Add uncollected fees
  amount0 += ((feeGrowthInside0 - fgi0) * liq) / Q64;
  amount1 += ((feeGrowthInside1 - fgi1) * liq) / Q64;

  const txId = await submitTx('burn_position', [
    position_record, JSON.stringify(usdcx_proof),
    `${feeGrowthInside0}u128`, `${feeGrowthInside1}u128`,
    `${amount0}u64`, `${amount1}u64`,
  ]);

  return { tx_id: txId, amount0: amount0.toString(), amount1: amount1.toString() };
});

// Initialize pool
app.post('/initialize', async (req) => {
  const { price } = req.body;  // price = ALEO per USDCx
  const sqrt = priceToSqrtPriceX64(price);
  const tick = sqrtPriceX64ToTick(sqrt);
  const aligned = Math.floor(tick / TICK_SPACING) * TICK_SPACING;
  const txId = await submitTx('initialize_pool', [`${sqrt}u128`, `${aligned}i32`]);
  return { tx_id: txId, sqrt_price: sqrt.toString(), tick: aligned };
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  if (!PRIVATE_KEY) { console.error('PRIVATE_KEY not set'); process.exit(1); }
  await syncPoolState();
  setInterval(syncPoolState, 30_000);
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[AMM] Running on :${PORT}  program=${PROGRAM_ID}`);
}

main().catch(console.error);
