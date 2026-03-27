/**
 * Aleo Oracle Coordinator
 *
 * - Accepts signed price submissions from relayers A, B, C
 * - Verifies secp256k1 signatures
 * - Groups identical canonical payloads per asset
 * - On 2-of-3 quorum: submits ALL qualifying assets to ZKPerp orchestrator
 * - Deduplicates per (assetId, roundId, updatedAt) — won't re-submit same round
 *
 * Endpoints:
 *   POST /submit   — relayer submission
 *   GET  /health   — liveness check + recent submissions
 *   GET  /state    — full coordinator state dump
 */

import express from "express";
import dotenv from "dotenv";
import { recoverSigner } from "../shared/crypto.js";
import { canonicalString } from "../shared/canonical.js";
import { submitToZKPerpOrchestrator } from "./aleoSubmit.js";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = Number(process.env.COORDINATOR_PORT || 3010);
const ENTRY_MAX_AGE_MS = Number(process.env.ENTRY_MAX_AGE_MS || 60_000);

// ── Allowlist ─────────────────────────────────────────────────────────────────
const ALLOWED_SIGNERS = new Set(
  ["A", "B", "C"]
    .map((r) => process.env[`RELAYER_${r}_ADDR`])
    .filter(Boolean)
    .map((a) => a.toLowerCase())
);

if (ALLOWED_SIGNERS.size === 0) {
  console.warn("[Coordinator] No RELAYER_*_ADDR set — allowlist disabled (dev mode)");
} else {
  console.log("[Coordinator] Allowlisted signers:", [...ALLOWED_SIGNERS]);
}

// ── State ─────────────────────────────────────────────────────────────────────

// latestBySigner: signer → { relayer, signer, signature, payload, receivedAt }
// NOTE: one entry per signer — stores their LATEST submission across ALL assets.
// To track per-asset per-signer we key by `${signer}:${assetId}`.
const latestBySignerAsset = new Map();

// lastSubmittedKey: assetId → "assetId:roundId:updatedAt"
const lastSubmittedTime = new Map(); // assetId → timestamp of last submission
const lastSubmittedKey = new Map();

// submission history (last 50)
const submissionHistory = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

function submitKey(payload) {
  return `${payload.assetId}:${payload.roundId}:${payload.updatedAt}`;
}

function pruneOldEntries() {
  const now = Date.now();
  for (const [key, item] of latestBySignerAsset.entries()) {
    if (now - item.receivedAt > ENTRY_MAX_AGE_MS) {
      latestBySignerAsset.delete(key);
    }
  }
}

/**
 * Group entries by canonical payload string, per asset.
 * Returns Map<assetId, Map<payloadKey, item[]>>
 */
function groupByAsset() {
  const byAsset = new Map();

  for (const item of latestBySignerAsset.values()) {
    const assetId = item.payload.assetId;
    if (!byAsset.has(assetId)) byAsset.set(assetId, new Map());

    const key = canonicalString(item.payload);
    const group = byAsset.get(assetId);
    if (!group.has(key)) group.set(key, []);
    group.get(key).push(item);
  }

  return byAsset;
}

const log = (...args) => console.log("[Coordinator]", ...args);
const warn = (...args) => console.warn("[Coordinator]", ...args);

// ── Routes ────────────────────────────────────────────────────────────────────

app.post("/submit", async (req, res) => {
  try {
    const { relayer, signer, signature, payload } = req.body;

    // Field validation
    if (!relayer || !signer || !signature || !payload) {
      return res.status(400).json({ error: "Missing fields: relayer, signer, signature, payload" });
    }
    for (const f of ["assetId", "price", "updatedAt", "roundId", "sourceChainId", "feedAddress"]) {
      if (payload[f] === undefined || payload[f] === null) {
        return res.status(400).json({ error: `Missing payload field: ${f}` });
      }
    }

    // Signature verification
    let recovered;
    try {
      recovered = recoverSigner(payload, signature);
    } catch (e) {
      return res.status(400).json({ error: `Signature recovery failed: ${e.message}` });
    }

    if (recovered !== signer.toLowerCase()) {
      warn(`Sig mismatch relayer ${relayer}: claimed=${signer} recovered=${recovered}`);
      return res.status(400).json({ error: "Signature does not match signer" });
    }

    // Allowlist check
    if (ALLOWED_SIGNERS.size > 0 && !ALLOWED_SIGNERS.has(recovered)) {
      warn(`Rejected signer not in allowlist: ${recovered}`);
      return res.status(403).json({ error: "Signer not in allowlist" });
    }

    // Store per signer+asset (so each relayer can hold one entry per market)
    const storeKey = `${recovered}:${payload.assetId}`;
    latestBySignerAsset.set(storeKey, {
      relayer,
      signer: recovered,
      signature,
      payload,
      receivedAt: Date.now()
    });

    log(`Received ${payload.assetId} from Relayer-${relayer} (${recovered.slice(0, 10)}...) price=${payload.price}`);

    pruneOldEntries();

    // ── Quorum check — process ALL assets independently ───────────────────────
    const byAsset = groupByAsset();
    const fired = [];
    const deduped = [];

    for (const [assetId, payloadGroups] of byAsset.entries()) {
      // Find the payload group with the most agreements for this asset
      let bestItems = [];
      for (const items of payloadGroups.values()) {
        if (items.length > bestItems.length) bestItems = items;
      }

      if (bestItems.length < 2) continue;

      const agreedPayload = bestItems[0].payload;
      const key = submitKey(agreedPayload);

      // Dedup — skip if this exact round was already submitted recently.
      // Allow re-submit after RESUBMIT_INTERVAL_MS even on same roundId,
      // so the bot's quorumPrices map stays fresh when Chainlink feed is slow.
      const RESUBMIT_INTERVAL_MS = Number(process.env.RESUBMIT_INTERVAL_MS || 5 * 60 * 1000);
      const lastSubmitTime = lastSubmittedTime.get(assetId) || 0;
      const staleOverride = Date.now() - lastSubmitTime > RESUBMIT_INTERVAL_MS;

      if (lastSubmittedKey.get(assetId) === key && !staleOverride) {
        deduped.push(assetId);
        continue; // continue — don't block other assets
      }

      lastSubmittedKey.set(assetId, key);
      lastSubmittedTime.set(assetId, Date.now());

      const signers = bestItems.map((x) => ({ signer: x.signer, signature: x.signature }));

      submissionHistory.push({
        assetId,
        price: agreedPayload.price,
        roundId: agreedPayload.roundId,
        updatedAt: agreedPayload.updatedAt,
        signers: signers.map((s) => s.signer),
        submittedAt: Date.now()
      });
      if (submissionHistory.length > 50) submissionHistory.shift();

      log(`✓ Quorum! ${assetId} @ ${agreedPayload.price} — submitting to ZKPerp`);

      // Fire-and-forget — process all assets before responding
      submitToZKPerpOrchestrator(agreedPayload, signers).catch((err) => {
        warn("submitToZKPerpOrchestrator threw:", err.message);
      });

      fired.push({ assetId, price: agreedPayload.price });
    }

    if (fired.length > 0) {
      return res.json({ ok: true, quorum: true, fired, deduped });
    }
    if (deduped.length > 0) {
      return res.json({ ok: true, quorum: true, deduped });
    }

    log(`No quorum yet for ${payload.assetId} — ${latestBySignerAsset.size} entries in window`);
    return res.json({ ok: true, quorum: false, entries: latestBySignerAsset.size });

  } catch (err) {
    warn("Unhandled error:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    entriesInWindow: latestBySignerAsset.size,
    allowlistEnabled: ALLOWED_SIGNERS.size > 0,
    lastSubmissions: submissionHistory.slice(-5)
  });
});

app.get("/state", (_req, res) => {
  const entries = {};
  for (const [k, v] of latestBySignerAsset.entries()) {
    entries[k] = {
      relayer: v.relayer,
      assetId: v.payload.assetId,
      price: v.payload.price,
      ageMs: Date.now() - v.receivedAt
    };
  }
  res.json({
    entriesInWindow: entries,
    lastSubmittedKeys: Object.fromEntries(lastSubmittedKey),
    submissionHistory
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  log(`Listening on :${PORT}`);
  log(`Entry max age: ${ENTRY_MAX_AGE_MS}ms`);
});
