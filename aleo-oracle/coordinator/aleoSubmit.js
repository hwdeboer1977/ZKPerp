/**
 * aleoSubmit.js
 *
 * Called by the coordinator when 2-of-3 relayers agree on a price.
 * POSTs the quorum payload to your ZKPerp orchestrator's /oracle/update endpoint.
 *
 * Your orchestrator is then responsible for submitting the Aleo transaction
 * (same pattern as order execution / liquidations).
 */

import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const log = (...args) => console.log("[aleoSubmit]", ...args);
const warn = (...args) => console.warn("[aleoSubmit]", ...args);

/**
 * @param {object} payload  - canonical payload that reached quorum
 * @param {Array}  signers  - array of { signer, signature } from agreeing relayers
 */
export async function submitToZKPerpOrchestrator(payload, signers) {
  const orchestratorUrl = process.env.ZKPERP_ORCHESTRATOR_URL;
  const token = process.env.ZKPERP_ORCHESTRATOR_TOKEN;

  const body = {
    assetId: payload.assetId,
    price: payload.price,           // normalised to 8 decimals, integer string
    updatedAt: payload.updatedAt,   // unix seconds string
    roundId: payload.roundId,
    sourceChainId: payload.sourceChainId,
    feedAddress: payload.feedAddress,
    quorum: signers.map((s) => ({ signer: s.signer, signature: s.signature }))
  };

  log(`Quorum reached for ${payload.assetId} @ ${payload.price} (round ${payload.roundId})`);
  log("Signers:", signers.map((s) => s.signer).join(", "));

  if (!orchestratorUrl) {
    warn("ZKPERP_ORCHESTRATOR_URL not set — logging only (dry run)");
    log("Dry-run payload:", JSON.stringify(body, null, 2));
    return;
  }

  try {
    const res = await axios.post(
      `${orchestratorUrl}/oracle/update`,
      body,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        timeout: 10_000
      }
    );
    log(`Orchestrator responded: ${res.status}`, res.data);
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
      : err.message;
    warn("Failed to reach ZKPerp orchestrator:", detail);
    // Don't rethrow — coordinator should not crash on submission failure.
    // The next quorum round will retry.
  }
}
