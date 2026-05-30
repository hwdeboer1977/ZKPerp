import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { MerkleTree } from './compliance-tree.js';
import {
  updateRootOnChain, revokeUserOnChain, unrevokeUserOnChain,
  waitForConfirmation, getCurrentRootOnChain, isRevokedOnChain,
} from './aleo-admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALLOWLIST_PATH = path.join(__dirname, 'allowlist.json');
const PORT = process.env.PORT || 3001;

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST_PATH)) {
    fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify({
      addresses: [],
      registrations: {},
      compliance_epochs: {},  // address => { issued_under: field, issued_at: ISO }
    }, null, 2));
  }
  const data = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  // Migrate old files that don't have compliance_epochs yet
  if (!data.compliance_epochs) data.compliance_epochs = {};
  return data;
}

function saveAllowlist(data) {
  fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(data, null, 2));
}

let currentTree = null;

function rebuildTree(addresses, existingLeafHashes = {}) {
  const cached = MerkleTree.fromCache(addresses);
  if (cached) {
    currentTree = cached;
    return currentTree;
  }
  currentTree = MerkleTree.build(addresses, existingLeafHashes);
  return currentTree;
}

// ─── Epoch repair ─────────────────────────────────────────────────────────────
// NOTE (compliance fix): the compliance contract no longer asserts a record's
// issued_under against the current root at verify/trade time. A record stays
// valid until it expires or the address is revoked. Rotating the root when a
// NEW user registers therefore does NOT invalidate existing holders, so we must
// NOT mark them stale. This function only ensures every address has an epoch
// entry; it never flips an already-issued holder back to needs_reissuance.

function ensureEpochEntries(data) {
  let repaired = 0;
  for (const address of data.addresses) {
    if (!data.compliance_epochs[address]) {
      data.compliance_epochs[address] = {
        issued_under: null,
        issued_at: null,
        needs_reissuance: true,   // genuinely never issued
      };
      repaired++;
    }
  }
  if (repaired > 0) {
    console.log(`[epoch] Initialized ${repaired} missing epoch entr${repaired === 1 ? 'y' : 'ies'}.`);
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────

async function startup() {
  const data = loadAllowlist();
  if (data.addresses.length === 0) {
    console.log('[startup] Empty allowlist — ready for registrations.');
    return;
  }

  rebuildTree(data.addresses);

  const onChainRoot = await getCurrentRootOnChain();
  if (onChainRoot !== currentTree.root) {
    console.log(`[startup] Root mismatch — syncing on-chain...`);
    try {
      const txId = await updateRootOnChain(currentTree.root);
      await waitForConfirmation(txId);
      ensureEpochEntries(data);
      saveAllowlist(data);
      console.log(`[startup] Root synced ✓ (existing holders remain valid)`);
    } catch (e) {
      console.warn(`[startup] Root sync failed: ${e.message}`);
    }
  } else {
    console.log(`[startup] Root matches on-chain ✓`);
    // Repair any missing epoch entries without rotating the root
    ensureEpochEntries(data);
    saveAllowlist(data);
  }
}

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

app.get('/health', (req, res) => {
  const data = loadAllowlist();
  res.json({ status: 'ok', allowlist_count: data.addresses.length, tree_root: currentTree?.root ?? null });
});

// ─── Register ─────────────────────────────────────────────────────────────────

app.post('/api/compliance/register', async (req, res) => {
  try {
    const { address, signature } = req.body;
    if (!address || !address.startsWith('aleo1'))
      return res.status(400).json({ error: 'Invalid Aleo address' });
    if (!signature)
      return res.status(400).json({ error: 'Wallet signature required' });

    const data = loadAllowlist();

    if (data.addresses.includes(address)) {
      rebuildTree(data.addresses);
      return res.json({
        status: 'already_registered',
        root: currentTree.root,
        leaf_index: data.addresses.indexOf(address),
        tx_id: data.registrations[address]?.tx_id ?? null,
        needs_reissuance: data.compliance_epochs[address]?.needs_reissuance ?? true,
      });
    }

    // New address — add and rebuild
    data.addresses.push(address);
    data.registrations[address] = { registered_at: new Date().toISOString(), tx_id: null };
    // New address always needs issuance
    data.compliance_epochs[address] = { issued_under: null, issued_at: null, needs_reissuance: true };
    saveAllowlist(data);

    const existingLeafHashes = currentTree?.leafHashes || {};
    rebuildTree(data.addresses, existingLeafHashes);
    const leafIndex = data.addresses.indexOf(address);

    // Root rotated by adding this leaf. Existing holders stay valid (their
    // records are checked on expiry + revocation, not root), so we do NOT
    // mark them stale. We still push the new root on-chain so that THIS new
    // user can be issued against it.
    const txId = await updateRootOnChain(currentTree.root);
    data.registrations[address].tx_id = txId;
    saveAllowlist(data);
    await waitForConfirmation(txId);

    res.json({
      status: 'registered',
      root: currentTree.root,
      leaf_index: leafIndex,
      tx_id: txId,
      // Only THIS newly-registered address needs issuance. Existing holders
      // are unaffected by the root rotation.
      needs_reissuance: true,
    });
  } catch (err) {
    console.error('[register]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Proof ────────────────────────────────────────────────────────────────────

app.get('/api/compliance/proof/:address', (req, res) => {
  try {
    const { address } = req.params;
    const data = loadAllowlist();
    if (!data.addresses.includes(address))
      return res.status(404).json({ error: 'Address not in allowlist' });
    if (!currentTree)
      return res.status(503).json({ error: 'Tree not initialized' });
    res.json({
      address,
      root: currentTree.root,
      leaf_index: data.addresses.indexOf(address),
      proof: currentTree.formatProofForAPI(address),
      leo_proof: currentTree.formatProofForLeo(address),
    });
  } catch (err) {
    console.error('[proof]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Reissue check — call this before every trade ────────────────────────────
// Returns needs_reissuance: true if the address's compliance record was issued
// under an old root and must be re-issued before trading.
// The frontend/orchestrator should call issue_compliance again and then call
// /api/compliance/confirm-issuance to update the server-side epoch record.

app.get('/api/compliance/reissue-check/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const data = loadAllowlist();

    if (!data.addresses.includes(address))
      return res.status(404).json({ error: 'Address not in allowlist' });

    const epoch = data.compliance_epochs[address];
    const currentRoot = currentTree?.root ?? null;
    // A record issued under ANY past root is still valid (verified on expiry +
    // revocation, not root). So reissuance is needed only if never issued or
    // explicitly flagged — NOT because the root has since rotated.
    const needsReissuance = !epoch || epoch.needs_reissuance;

    res.json({
      address,
      current_root: currentRoot,
      issued_under: epoch?.issued_under ?? null,
      needs_reissuance: needsReissuance,
      // If true: call issue_compliance on-chain with the proof, then POST /confirm-issuance
      proof_endpoint: needsReissuance ? `/api/compliance/proof/${address}` : null,
    });
  } catch (err) {
    console.error('[reissue-check]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Confirm issuance — call after issue_compliance tx confirms on-chain ──────
// Body: { address, tx_id }
// Updates compliance_epochs so reissue-check returns needs_reissuance: false.

app.post('/api/compliance/confirm-issuance', async (req, res) => {
  try {
    const { address, tx_id } = req.body;
    if (!address || !address.startsWith('aleo1'))
      return res.status(400).json({ error: 'Invalid address' });

    const data = loadAllowlist();
    if (!data.addresses.includes(address))
      return res.status(404).json({ error: 'Address not in allowlist' });

    const currentRoot = currentTree?.root ?? null;
    if (!currentRoot)
      return res.status(503).json({ error: 'Tree not initialized' });

    data.compliance_epochs[address] = {
      issued_under: currentRoot,
      issued_at: new Date().toISOString(),
      needs_reissuance: false,
      tx_id: tx_id ?? null,
    };
    saveAllowlist(data);

    console.log(`[epoch] ${address.slice(0, 16)}... confirmed issuance under root ${currentRoot.slice(0, 20)}...`);
    res.json({ status: 'ok', issued_under: currentRoot });
  } catch (err) {
    console.error('[confirm-issuance]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Status ───────────────────────────────────────────────────────────────────

app.get('/api/compliance/status/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const data = loadAllowlist();
    const isRegistered = data.addresses.includes(address);
    const isRevoked = await isRevokedOnChain(address);
    const onChainRoot = await getCurrentRootOnChain();
    const epoch = data.compliance_epochs[address];
    const needsReissuance = !epoch || epoch.needs_reissuance;

    res.json({
      address,
      registered: isRegistered,
      revoked: isRevoked,
      compliant: isRegistered && !isRevoked && !needsReissuance,
      needs_reissuance: needsReissuance,
      issued_under: epoch?.issued_under ?? null,
      current_root: currentTree?.root ?? null,
      on_chain_root: onChainRoot,
      roots_match: currentTree?.root === onChainRoot,
      registration: data.registrations[address] ?? null,
    });
  } catch (err) {
    console.error('[status]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Audit ────────────────────────────────────────────────────────────────────

app.get('/api/compliance/audit/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const data = loadAllowlist();
    if (!data.addresses.includes(address))
      return res.status(404).json({ error: 'Address not found' });
    const isRevoked = await isRevokedOnChain(address);
    const onChainRoot = await getCurrentRootOnChain();
    const reg = data.registrations[address];
    const epoch = data.compliance_epochs[address];
    res.json({
      proof_valid: !isRevoked,
      root_epoch: onChainRoot,
      issued_under: epoch?.issued_under ?? null,
      needs_reissuance: !epoch || epoch.needs_reissuance,
      registered_at: reg?.registered_at ?? null,
      revoked: isRevoked,
      trade_details: '— hidden —',
      wallet_identity: '— hidden —',
    });
  } catch (err) {
    console.error('[audit]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Revoke / Unrevoke ────────────────────────────────────────────────────────

app.post('/api/compliance/revoke', async (req, res) => {
  try {
    const { address, admin_key } = req.body;
    if (admin_key !== process.env.ADMIN_API_KEY)
      return res.status(401).json({ error: 'Unauthorized' });
    const txId = await revokeUserOnChain(address);
    await waitForConfirmation(txId);
    res.json({ status: 'revoked', address, tx_id: txId });
  } catch (err) {
    console.error('[revoke]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/compliance/unrevoke', async (req, res) => {
  try {
    const { address, admin_key } = req.body;
    if (admin_key !== process.env.ADMIN_API_KEY)
      return res.status(401).json({ error: 'Unauthorized' });
    const txId = await unrevokeUserOnChain(address);
    await waitForConfirmation(txId);
    res.json({ status: 'unrevoked', address, tx_id: txId });
  } catch (err) {
    console.error('[unrevoke]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Allowlist ────────────────────────────────────────────────────────────────

app.get('/api/compliance/allowlist', (req, res) => {
  const data = loadAllowlist();
  res.json({ count: data.addresses.length, root: currentTree?.root ?? null, addresses: data.addresses });
});

app.listen(PORT, async () => {
  console.log(`\n✓ ZKPerp Compliance Server running on port ${PORT}`);
  console.log(`  Program: ${process.env.COMPLIANCE_PROGRAM_ID}`);
  console.log(`  Network: ${process.env.ALEO_NETWORK_URL}\n`);
  await startup();
});
