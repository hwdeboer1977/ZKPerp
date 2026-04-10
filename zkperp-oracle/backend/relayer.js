/**
 * ZKPerp Oracle Relayer — on-chain quorum version
 *
 * Each relayer (A, B, C) runs independently with its own Aleo private key.
 * No coordinator needed — quorum is enforced by zkperp_oracle.aleo on-chain.
 *
 * Flow:
 *   1. Read Chainlink feed
 *   2. Validate freshness
 *   3. Call zkperp_oracle.aleo/submit_price directly on-chain
 *   4. Contract accumulates votes — at 2-of-3, oracle_prices is updated
 *
 * Environment variables:
 *   RELAYER_NAME          - A, B, or C
 *   ALEO_PRIVATE_KEY      - this relayer's Aleo private key
 *   ALEO_ENDPOINT         - Aleo node RPC endpoint
 *   ALEO_NETWORK          - testnet or mainnet
 *   EVM_RPC_URL           - Ethereum RPC (for BTC/ETH feeds)
 *   EVM_RPC_URL_ARB       - Arbitrum RPC (for SOL feed)
 *   POLL_INTERVAL_MS      - polling interval (default 15000)
 *   ORACLE_PROGRAM        - zkperp_oracle.aleo (default)
 */

import dotenv from 'dotenv';
import { readChainlinkFeed, normalizeTo8 } from './shared/chainlink.js';
import { submitPriceOnChain } from './shared/aleoClient.js';
import markets from './config/markets.json' with { type: 'json' };

dotenv.config();

// ── Config ────────────────────────────────────────────────────────────────────

const RELAYER_NAME    = process.env.RELAYER_NAME;
const ALEO_PRIVATE_KEY = process.env.ALEO_PRIVATE_KEY;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 15_000);
const ORACLE_PROGRAM   = process.env.ORACLE_PROGRAM || 'zkperp_oracle.aleo';

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

// ── Dedup — avoid re-submitting same round ────────────────────────────────────

const lastSubmittedRound = new Map(); // assetKey → roundId string

function shouldSubmit(assetKey, roundId) {
  const last = lastSubmittedRound.get(assetKey);
  return last !== roundId;
}

// ── Core tick ─────────────────────────────────────────────────────────────────

async function processMarket(marketId, market) {
  const rpcUrl = process.env[market.rpcEnvVar || 'EVM_RPC_URL'];
  if (!rpcUrl) throw new Error(`Missing env var: ${market.rpcEnvVar || 'EVM_RPC_URL'}`);

  // 1. Read Chainlink feed
  const feed = await readChainlinkFeed(rpcUrl, market.feedAddress);

  // 2. Freshness check
  const nowSec = Math.floor(Date.now() / 1000);
  const age = nowSec - Number(feed.updatedAt);
  if (age > market.heartbeatSec) {
    throw new Error(`Feed stale: age=${age}s heartbeat=${market.heartbeatSec}s`);
  }

  // 3. Dedup — skip if same round already submitted
  if (!shouldSubmit(market.assetKey, feed.roundId)) {
    log(`⏭  ${marketId} round=${feed.roundId} already submitted — skipping`);
    return;
  }

  // 4. Normalize price to 8 decimals → u64 for Aleo
  const price = BigInt(normalizeTo8(feed.answer, feed.decimals));
  const timestamp = Number(feed.updatedAt);

  log(`📡 ${marketId} price=${price} roundId=${feed.roundId} age=${age}s — submitting on-chain`);

  // 5. Submit directly to zkperp_oracle.aleo
  await submitPriceOnChain({
    privateKey: ALEO_PRIVATE_KEY,
    program:    ORACLE_PROGRAM,
    assetKey:   market.assetKey,   // e.g. "1field"
    price,
    timestamp,
  });

  // 6. Mark this round as submitted
  lastSubmittedRound.set(market.assetKey, feed.roundId);
  log(`✅ ${marketId} submitted — waiting for on-chain quorum`);
}

async function tick() {
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
log(`Aleo network: ${process.env.ALEO_NETWORK || 'testnet'}`);

await tick();
setInterval(tick, POLL_INTERVAL_MS);
