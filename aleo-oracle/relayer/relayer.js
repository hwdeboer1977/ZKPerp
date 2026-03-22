/**
 * Aleo Oracle Relayer
 *
 * Usage:  node relayer/relayer.js A|B|C
 *
 * - Reads ALL markets from config/markets.json every POLL_INTERVAL_MS
 * - Validates freshness against each market's heartbeatSec
 * - Signs the canonical payload and POSTs to the coordinator
 */

import dotenv from "dotenv";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { readChainlinkFeed, normalizeTo8 } from "../shared/chainlink.js";
import { buildCanonicalPayload } from "../shared/canonical.js";
import { signPayload } from "../shared/crypto.js";

dotenv.config();

// ── Config ────────────────────────────────────────────────────────────────────

const relayerName = process.argv[2];
if (!["A", "B", "C"].includes(relayerName)) {
  console.error("Usage: node relayer/relayer.js A|B|C");
  process.exit(1);
}

const pk = process.env[`RELAYER_${relayerName}_PK`];
if (!pk) {
  console.error(`Missing env var: RELAYER_${relayerName}_PK`);
  process.exit(1);
}

const coordinatorUrl = process.env.COORDINATOR_URL;
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || 15000);

if (!coordinatorUrl) { console.error("Missing COORDINATOR_URL"); process.exit(1); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const markets = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../config/markets.json"), "utf8")
);

const log = (...args) => console.log(`[Relayer-${relayerName}]`, ...args);
const warn = (...args) => console.warn(`[Relayer-${relayerName}]`, ...args);

// ── Core tick ─────────────────────────────────────────────────────────────────

async function processMarket(marketId, market) {
  const rpcEnvVar = market.rpcEnvVar || "EVM_RPC_URL";
  const rpcUrl = process.env[rpcEnvVar];
  if (!rpcUrl) throw new Error(`Missing env var: ${rpcEnvVar}`);

  const feed = await readChainlinkFeed(rpcUrl, market.feedAddress);

  // Freshness check
  const nowSec = Math.floor(Date.now() / 1000);
  const age = nowSec - Number(feed.updatedAt);
  if (age > market.heartbeatSec) {
    throw new Error(`Feed stale: age=${age}s heartbeat=${market.heartbeatSec}s`);
  }

  const payload = buildCanonicalPayload({
    assetId: market.assetId,
    price: normalizeTo8(feed.answer, feed.decimals),
    updatedAt: feed.updatedAt,
    roundId: feed.roundId,
    sourceChainId: market.sourceChainId,
    feedAddress: market.feedAddress
  });

  const signed = signPayload(pk, payload);

  await axios.post(
    `${coordinatorUrl}/submit`,
    {
      relayer: relayerName,
      signer: signed.signer,
      digest: signed.digest,
      signature: signed.signature,
      payload: signed.payload
    },
    { timeout: 5000 }
  );

  log(`✓ ${marketId} price=${payload.price} roundId=${payload.roundId} age=${age}s`);
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

log(`Starting — polling every ${pollIntervalMs / 1000}s`);
await tick();
setInterval(tick, pollIntervalMs);
