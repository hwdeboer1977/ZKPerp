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
    fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify({ addresses: [], registrations: {} }, null, 2));
  }
  return JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
}

function saveAllowlist(data) {
  fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(data, null, 2));
}

let currentTree = null;

async function rebuildTree(addresses, existingLeafHashes = {}) {
  // Try cache first — instant if addresses unchanged
  const cached = MerkleTree.fromCache(addresses);
  if (cached) {
    currentTree = cached;
    return currentTree;
  }
  // Build from scratch — only for new/changed allowlist
  currentTree = await MerkleTree.build(addresses, existingLeafHashes);
  return currentTree;
}

// ─── Startup ──────────────────────────────────────────────────────────────────

async function startup() {
  const data = loadAllowlist();
  if (data.addresses.length === 0) {
    console.log('[startup] Empty allowlist — ready for registrations.');
    return;
  }

  // Rebuild tree (from cache if possible)
  rebuildTree(data.addresses);

  // Sync on-chain root if needed
  const onChainRoot = await getCurrentRootOnChain();
  if (onChainRoot !== currentTree.root) {
    console.log(`[startup] Root mismatch — syncing on-chain...`);
    try {
      const txId = await updateRootOnChain(currentTree.root);
      await waitForConfirmation(txId);
      console.log(`[startup] Root synced ✓`);
    } catch (e) {
      console.warn(`[startup] Root sync failed: ${e.message}`);
    }
  } else {
    console.log(`[startup] Root matches on-chain ✓`);
  }
}

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

app.get('/health', (req, res) => {
  const data = loadAllowlist();
  res.json({ status: 'ok', allowlist_count: data.addresses.length, tree_root: currentTree?.root ?? null });
});

app.post('/api/compliance/register', async (req, res) => {
  try {
    const { address, signature } = req.body;
    if (!address || !address.startsWith('aleo1'))
      return res.status(400).json({ error: 'Invalid Aleo address' });
    if (!signature)
      return res.status(400).json({ error: 'Wallet signature required' });

    const data = loadAllowlist();

    if (data.addresses.includes(address)) {
      // Already registered — return from cache
      rebuildTree(data.addresses);
      return res.json({
        status: 'already_registered',
        root: currentTree.root,
        leaf_index: data.addresses.indexOf(address),
        tx_id: data.registrations[address]?.tx_id ?? null,
      });
    }

    // New address — add and rebuild
    data.addresses.push(address);
    data.registrations[address] = { registered_at: new Date().toISOString(), tx_id: null };
    saveAllowlist(data);

    // Pass existing leaf hashes to avoid recomputing them
    const existingLeafHashes = currentTree?.leafHashes || {};
    rebuildTree(data.addresses, existingLeafHashes);
    const leafIndex = data.addresses.indexOf(address);

    const txId = await updateRootOnChain(currentTree.root);
    data.registrations[address].tx_id = txId;
    saveAllowlist(data);
    await waitForConfirmation(txId);

    res.json({ status: 'registered', root: currentTree.root, leaf_index: leafIndex, tx_id: txId });
  } catch (err) {
    console.error('[register]', err);
    res.status(500).json({ error: err.message });
  }
});

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

app.get('/api/compliance/status/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const data = loadAllowlist();
    const isRegistered = data.addresses.includes(address);
    const isRevoked = await isRevokedOnChain(address);
    const onChainRoot = await getCurrentRootOnChain();
    res.json({
      address,
      registered: isRegistered,
      revoked: isRevoked,
      compliant: isRegistered && !isRevoked,
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

app.get('/api/compliance/audit/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const data = loadAllowlist();
    if (!data.addresses.includes(address))
      return res.status(404).json({ error: 'Address not found' });
    const isRevoked = await isRevokedOnChain(address);
    const onChainRoot = await getCurrentRootOnChain();
    const reg = data.registrations[address];
    res.json({
      proof_valid: !isRevoked,
      root_epoch: onChainRoot,
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
