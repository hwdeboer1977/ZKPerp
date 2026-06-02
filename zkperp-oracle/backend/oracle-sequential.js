/**
 * ZKPerp Oracle — fully sequential single-process version
 *
 * Submits in this exact order, waiting for each confirmation:
 *   1. Relayer A → BTC
 *   2. Relayer B → BTC
 *   3. Relayer C → BTC
 *   4. Relayer A → ETH
 *   5. Relayer B → ETH
 *   6. Relayer C → ETH
 *   7. Relayer A → SOL
 *   8. Relayer B → SOL
 *   9. Relayer C → SOL
 *
 * No parallel processes. No JWT race. No manager.
 * Total ~4-5 min per cycle, well within 150-block staleness window.
 */

import dotenv from 'dotenv';
dotenv.config();

import { readChainlinkFeed, normalizeTo8 } from './shared/chainlink.js';
import { submitPriceOnChain } from './shared/aleoClient.js';
import markets from './config/markets.json' with { type: 'json' };

// ── Config ────────────────────────────────────────────────────────────────────

const ORACLE_PROGRAM = process.env.ORACLE_PROGRAM || 'zkperp_oracle_v4.aleo';
const ALEO_NETWORK   = process.env.ALEO_NETWORK   || 'testnet';
const EXPLORER_API   = process.env.ALEO_EXPLORER_API || 'https://api.explorer.provable.com/v1';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 300_000); // 5 min

const RELAYERS = [
  { name: 'A', privateKey: process.env.ALEO_PRIVATE_KEY_A },
  { name: 'B', privateKey: process.env.ALEO_PRIVATE_KEY_B },
  { name: 'C', privateKey: process.env.ALEO_PRIVATE_KEY_C },
];

// Validate
for (const r of RELAYERS) {
  if (!r.privateKey) {
    console.error(`Missing ALEO_PRIVATE_KEY_${r.name}`);
    process.exit(1);
  }
}

const log  = (...args) => console.log(`[Oracle]`, ...args);
const warn = (...args) => console.warn(`[Oracle]`, ...args);

// ── Aleo block height ─────────────────────────────────────────────────────────

async function fetchAleoBlockHeight() {
  const url = `${EXPLORER_API}/${ALEO_NETWORK}/latest/height`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch block height: ${res.status}`);
  const h = Number(await res.json());
  if (!Number.isInteger(h) || h <= 0) throw new Error(`Invalid block height: ${h}`);
  return h;
}

// ── Core tick — fully sequential ──────────────────────────────────────────────

async function tick() {
  log(`\n${'─'.repeat(60)}`);
  log(`Starting cycle — ${new Date().toISOString()}`);

  const block = await fetchAleoBlockHeight();
  log(`Current block: ${block}`);

  // For each market, submit all 3 relayers sequentially
  for (const [marketId, market] of Object.entries(markets)) {
    const rpcUrl = process.env[market.rpcEnvVar || 'EVM_RPC_URL'];
    if (!rpcUrl) {
      warn(`Missing env var: ${market.rpcEnvVar || 'EVM_RPC_URL'} — skipping ${marketId}`);
      continue;
    }

    let feed;
    try {
      feed = await readChainlinkFeed(rpcUrl, market.feedAddress);
    } catch (err) {
      warn(`${marketId} feed error: ${err.message} — skipping`);
      continue;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const chainlinkAge = nowSec - Number(feed.updatedAt);
    if (chainlinkAge > market.heartbeatSec) {
      warn(`${marketId} feed stale (${chainlinkAge}s) — skipping`);
      continue;
    }

    const price = BigInt(normalizeTo8(feed.answer, feed.decimals));
    log(`${marketId} price=${price} roundId=${feed.roundId} age=${chainlinkAge}s`);

    // Submit each relayer sequentially, wait for confirmation
    for (const relayer of RELAYERS) {
      log(`${marketId} Relayer-${relayer.name} submitting...`);
      try {
        const { txId, status } = await submitPriceOnChain({
          privateKey: relayer.privateKey,
          program:    ORACLE_PROGRAM,
          assetKey:   market.assetKey,
          price,
          timestamp:  block,
        });
        log(`${marketId} Relayer-${relayer.name}: ${status} (${txId})`);
      } catch (err) {
        warn(`${marketId} Relayer-${relayer.name} failed: ${err.message}`);
      }
      // Small pause between relayers to avoid any residual nonce issues
      await new Promise(r => setTimeout(r, 2_000));
    }

    log(`${marketId} ✓ all 3 relayers done`);
  }

  log(`Cycle complete — next in ${POLL_INTERVAL_MS / 1000}s`);
}

// ── Start ─────────────────────────────────────────────────────────────────────

log(`ZKPerp Sequential Oracle starting`);
log(`Program:  ${ORACLE_PROGRAM}`);
log(`Network:  ${ALEO_NETWORK}`);
log(`Interval: ${POLL_INTERVAL_MS / 1000}s`);
log(`Relayers: A, B, C (sequential per market)`);

tick().catch(err => warn(`First tick failed: ${err.message}`));
setInterval(() => tick().catch(err => warn(`Tick failed: ${err.message}`)), POLL_INTERVAL_MS);

process.on('SIGINT',  () => { log('Shutting down'); process.exit(0); });
process.on('SIGTERM', () => { log('Shutting down'); process.exit(0); });
