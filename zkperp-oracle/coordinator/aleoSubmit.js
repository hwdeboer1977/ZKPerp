/**
 * aleoSubmit.js
 *
 * Called by the coordinator when 2-of-3 relayers agree on a price.
 * POSTs the quorum payload to all ZKPerp bot instances (one per market).
 *
 * Each bot ignores prices for other assets — so it's safe to broadcast
 * to all bots. The BTC bot ignores ETH/SOL prices, etc.
 *
 * Environment variables:
 *   ZKPERP_ORCHESTRATOR_URL_BTC  - BTC bot URL
 *   ZKPERP_ORCHESTRATOR_URL_ETH  - ETH bot URL
 *   ZKPERP_ORCHESTRATOR_URL_SOL  - SOL bot URL
 *   ZKPERP_ORCHESTRATOR_TOKEN    - shared auth token (same for all bots)
 *
 * Legacy single-bot fallback:
 *   ZKPERP_ORCHESTRATOR_URL      - if set and no per-market URLs, sends to this
 */

import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const log  = (...args) => console.log("[aleoSubmit]", ...args);
const warn = (...args) => console.warn("[aleoSubmit]", ...args);

/**
 * @param {object} payload  - canonical payload that reached quorum
 * @param {Array}  signers  - array of { signer, signature } from agreeing relayers
 */
export async function submitToZKPerpOrchestrator(payload, signers) {
  const token = process.env.ZKPERP_ORCHESTRATOR_TOKEN;

  // Collect all bot URLs — per-market takes priority over legacy single URL
  const urls = [
    process.env.ZKPERP_ORCHESTRATOR_URL_BTC,
    process.env.ZKPERP_ORCHESTRATOR_URL_ETH,
    process.env.ZKPERP_ORCHESTRATOR_URL_SOL,
  ].filter(Boolean);

  // Fallback to legacy single URL if no per-market URLs set
  if (urls.length === 0 && process.env.ZKPERP_ORCHESTRATOR_URL) {
    urls.push(process.env.ZKPERP_ORCHESTRATOR_URL);
  }

  const body = {
    assetId:       payload.assetId,
    price:         payload.price,
    updatedAt:     payload.updatedAt,
    roundId:       payload.roundId,
    sourceChainId: payload.sourceChainId,
    feedAddress:   payload.feedAddress,
    quorum:        signers.map((s) => ({ signer: s.signer, signature: s.signature }))
  };

  log(`Quorum reached for ${payload.assetId} @ ${payload.price} (round ${payload.roundId})`);
  log("Signers:", signers.map((s) => s.signer).join(", "));

  if (urls.length === 0) {
    warn("No orchestrator URLs set — logging only (dry run)");
    log("Dry-run payload:", JSON.stringify(body, null, 2));
    return;
  }

  log(`Broadcasting to ${urls.length} bot(s)...`);

  // Send to all bots in parallel — each bot ignores prices for other assets
  const results = await Promise.allSettled(
    urls.map(async (url) => {
      try {
        const res = await axios.post(
          `${url}/oracle/update`,
          body,
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`
            },
            timeout: 10_000
          }
        );
        log(`✓ ${url} responded: ${res.status}`, res.data);
        return res;
      } catch (err) {
        const detail = err.response
          ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
          : err.message;
        warn(`✗ ${url} failed:`, detail);
        // Don't rethrow — other bots should still receive the update
      }
    })
  );

  const succeeded = results.filter(r => r.status === 'fulfilled' && r.value).length;
  log(`Broadcast complete: ${succeeded}/${urls.length} bots reached`);
}
