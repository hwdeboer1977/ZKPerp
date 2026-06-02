/**
 * ZKPerp Oracle Relayer — on-chain quorum version
 *
 * Each relayer (A, B, C) runs independently with its own Aleo private key.
 * No coordinator needed — quorum is enforced by zkperp_oracle.aleo on-chain.
 *
 * Flow:
 *   1. Read Chainlink feed
 *   2. Validate freshness (uses Chainlink updatedAt unix timestamp)
 *   3. Fetch current Aleo block height (used as on-chain timestamp)
 *   4. Call zkperp_oracle.aleo/submit_price directly on-chain
 *   5. Wait for tx confirmation before proceeding to next market
 *   6. Contract accumulates votes — at 2-of-3, oracle_prices is updated
 *
 * Relayers are staggered so A submits first, B waits for A to confirm,
 * C waits for B to confirm — no more same-block finalize race conditions.
 *
 * Environment variables:
 *   RELAYER_NAME          - A, B, or C
 *   ALEO_PRIVATE_KEY      - this relayer's Aleo private key
 *   ALEO_ENDPOINT         - Aleo node RPC endpoint
 *   ALEO_NETWORK          - testnet or mainnet
 *   EVM_RPC_URL           - Ethereum RPC (for BTC/ETH feeds)
 *   EVM_RPC_URL_ARB       - Arbitrum RPC (for SOL feed)
 *   POLL_INTERVAL_MS      - polling interval (default 120000)
 *   ORACLE_PROGRAM        - zkperp_oracle_v4.aleo (default)
 *   ALEO_EXPLORER_API     - explorer API base (default https://api.explorer.provable.com/v1)
 */

import dotenv from 'dotenv';
import { readChainlinkFeed, normalizeTo8 } from './shared/chainlink.js';
import { submitPriceOnChain } from './shared/aleoClient.js';
import markets from './config/markets.json' with { type: 'json' };

dotenv.config();

// ── Config ────────────────────────────────────────────────────────────────────

const RELAYER_NAME     = process.env.RELAYER_NAME;
const ALEO_PRIVATE_KEY = process.env.ALEO_PRIVATE_KEY;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 120_000); // 2 min cycles
const ORACLE_PROGRAM   = process.env.ORACLE_PROGRAM || 'zkperp_oracle_v4.aleo';
const ALEO_NETWORK     = process.env.ALEO_NETWORK || 'testnet';
const EXPLORER_API     = process.env.ALEO_EXPLORER_API || 'https://api.explorer.provable.com/v1';

// Stagger relayers so they don't race:
//   A: starts immediately
//   B: waits 60s (A's 3 txs should all be confirmed by then)
//   C: waits 120s (A+B confirmed, quorum reached, C may skip via dedup)
const STAGGER_OFFSET_MS = { A: 0, B: 60_000, C: 120_000 };

if (!['A', 'B', 'C'].includes(RELAYER_NAME)) {
  console.error('RELAYER_NAME must be A, B, or C');
  process.exit(1);
}
if (!ALEO_PRIVATE_KEY) {
  console.error('Missing ALEO_PRIVATE_KEY');
  process.exit(1);
}

const log  = (...args) => console.log(`[Relayer-${RELAYER_NAME}]`, ...args);
const warn = (...args) => console.warn(`[Relayer-${RELAYER_NAME}]`, ...args);

// ── Aleo block height ─────────────────────────────────────────────────────────

async function fetchAleoBlockHeight() {
  const url = `${EXPLORER_API}/${ALEO_NETWORK}/latest/height`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch Aleo block height: ${res.status}`);
  const height = await res.json();
  const h = Number(height);
  if (!Number.isInteger(h) || h <= 0) throw new Error(`Invalid block height: ${height}`);
  return h;
}

// ── Dedup — avoid re-submitting same round UNLESS price is going stale ────────

const lastSubmittedRound = new Map(); // assetKey → roundId string
const lastSubmittedBlock = new Map(); // assetKey → aleoBlockHeight
const MAX_BLOCKS_WITHOUT_UPDATE = 120; // resubmit if no update in 120 blocks (~4 min)

function shouldSubmit(assetKey, roundId, currentBlock) {
  const sameRound = lastSubmittedRound.get(assetKey) === roundId;
  if (!sameRound) return true; // new Chainlink round → always submit
  const lastBlock = lastSubmittedBlock.get(assetKey) ?? 0;
  return (currentBlock - lastBlock) >= MAX_BLOCKS_WITHOUT_UPDATE; // stale → resubmit
}

// ── Core tick ─────────────────────────────────────────────────────────────────
// Markets are processed SEQUENTIALLY — each tx waits for confirmation
// before the next one starts. This prevents same-block finalize races.

async function processMarket(marketId, market) {
  const rpcUrl = process.env[market.rpcEnvVar || 'EVM_RPC_URL'];
  if (!rpcUrl) throw new Error(`Missing env var: ${market.rpcEnvVar || 'EVM_RPC_URL'}`);

  // 1. Read Chainlink feed
  const feed = await readChainlinkFeed(rpcUrl, market.feedAddress);

  // 2. Freshness check
  const nowSec = Math.floor(Date.now() / 1000);
  const chainlinkAge = nowSec - Number(feed.updatedAt);
  if (chainlinkAge > market.heartbeatSec) {
    throw new Error(`Feed stale: age=${chainlinkAge}s heartbeat=${market.heartbeatSec}s`);
  }

  // 3. Fetch Aleo block height
  const aleoBlockHeight = await fetchAleoBlockHeight();

  // 4. Dedup check
  if (!shouldSubmit(market.assetKey, feed.roundId, aleoBlockHeight)) {
    log(`⏭  ${marketId} round=${feed.roundId} price fresh — skipping`);
    return;
  }

  // 5. Normalize price
  const price = BigInt(normalizeTo8(feed.answer, feed.decimals));

  log(`📡 ${marketId} price=${price} roundId=${feed.roundId} chainlinkAge=${chainlinkAge}s aleoBlock=${aleoBlockHeight} — submitting on-chain`);

  // 6. Submit and WAIT for confirmation before returning
  const { txId, status } = await submitPriceOnChain({
    privateKey: ALEO_PRIVATE_KEY,
    program:    ORACLE_PROGRAM,
    assetKey:   market.assetKey,
    price,
    timestamp:  aleoBlockHeight,
  });

  if (status === 'accepted') {
    // 7. Only mark as submitted if accepted
    lastSubmittedRound.set(market.assetKey, feed.roundId);
    lastSubmittedBlock.set(market.assetKey, aleoBlockHeight);
    log(`✅ ${marketId} confirmed on-chain (${txId})`);
  } else {
    warn(`✗ ${marketId} tx ${status} (${txId}) — will retry next cycle`);
  }
}

async function tick() {
  // Sequential — await each market before starting the next
  for (const [marketId, market] of Object.entries(markets)) {
    try {
      await processMarket(marketId, market);
    } catch (err) {
      warn(`✗ ${marketId}:`, err.message);
    }
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

log(`Starting — polling every ${POLL_INTERVAL_MS / 1000}s`);
log(`Oracle program: ${ORACLE_PROGRAM}`);
log(`Aleo network: ${ALEO_NETWORK}`);
log(`Stagger offset: ${STAGGER_OFFSET_MS[RELAYER_NAME] / 1000}s`);

// Wait for stagger offset before first tick
await new Promise(r => setTimeout(r, STAGGER_OFFSET_MS[RELAYER_NAME]));
log(`Stagger complete — starting first tick`);
await tick();
setInterval(tick, POLL_INTERVAL_MS);
