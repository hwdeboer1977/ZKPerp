import {
  Account, ProgramManager, AleoKeyProvider, encryptProvingRequest
} from '@provablehq/sdk';

const NETWORK_URL      = process.env.ALEO_NETWORK_URL || 'https://api.explorer.provable.com/v2';
const PROGRAM_ID       = process.env.COMPLIANCE_PROGRAM_ID || 'zkperp_compliance_v9.aleo';
const EXPLORER_URL     = `${NETWORK_URL}/testnet`;
const PROVABLE_API_KEY = process.env.PROVABLE_API_KEY;
const PROVABLE_CONSUMER_ID = process.env.PROVABLE_CONSUMER_ID;
const PROVER_BASE      = process.env.PROVABLE_PROVING_URL?.replace(/\/prove\/?$/, '')
  || 'https://api.provable.com/prove/testnet';

// ─── Retry helper ─────────────────────────────────────────────────────────────

async function withRetry(fn, maxAttempts = 5, delayMs = 10000) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isRetryable = err.message.includes('522') ||
                          err.message.includes('502') ||
                          err.message.includes('503') ||
                          err.message.includes('504') ||
                          err.message.includes('ECONNRESET') ||
                          err.message.includes('fetch failed');
      if (!isRetryable || attempt === maxAttempts) throw err;
      console.warn(`[aleo-admin] Attempt ${attempt}/${maxAttempts} failed: ${err.message} — retrying in ${delayMs/1000}s...`);
      // Force JWT refresh on next attempt
      _jwt = null;
      _jwtExpiry = 0;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// ─── JWT ──────────────────────────────────────────────────────────────────────

let _jwt = null;
let _jwtExpiry = 0;

async function getJWT() {
  if (_jwt && Date.now() < _jwtExpiry) return _jwt;
  const base = PROVER_BASE.replace(/\/prove\/.*$/, '').replace(/\/prove$/, '');
  const res = await fetch(`${base}/jwts/${PROVABLE_CONSUMER_ID}`, {
    method: 'POST',
    headers: { 'X-Provable-API-Key': PROVABLE_API_KEY, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`JWT fetch failed: ${res.status}`);
  const auth = res.headers.get('Authorization');
  const body = await res.json().catch(() => ({}));
  _jwt = auth || body.jwt || body.token;
  _jwtExpiry = Date.now() + 55 * 60 * 1000;
  return _jwt;
}

// ─── Delegated proving (TEE encrypted flow) ───────────────────────────────────

async function submitDelegated(provingRequest, jwt) {
  // Step 1: get ephemeral pubkey
  const pubkeyRes = await fetch(`${PROVER_BASE}/pubkey`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: jwt },
  });
  if (!pubkeyRes.ok) throw new Error(`Pubkey fetch failed: ${pubkeyRes.status}`);
  const pubkey = await pubkeyRes.json();
  const cookie = pubkeyRes.headers.get('set-cookie');

  // Step 2: encrypt proving request
  const ciphertext = encryptProvingRequest(pubkey.public_key, provingRequest);

  // Step 3: submit encrypted request
  const res = await fetch(`${PROVER_BASE}/prove/encrypted`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: jwt,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ key_id: pubkey.key_id, ciphertext }),
  });

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { message: text }; }
  if (!res.ok) throw new Error(`Delegated proving failed: ${body?.message || text}`);
  return body?.transaction?.id || body?.transaction;
}

// ─── Execute on-chain ─────────────────────────────────────────────────────────

async function executeOnChain(functionName, inputs) {
  const keyProvider = new AleoKeyProvider();
  keyProvider.useCache(true);
  const pm = new ProgramManager(NETWORK_URL, keyProvider);
  const account = new Account({ privateKey: process.env.ADMIN_PRIVATE_KEY });
  pm.setAccount(account);

  if (PROVABLE_API_KEY && PROVABLE_CONSUMER_ID) {
    console.log(`[aleo-admin] Building proving request for ${functionName}...`);

    // Build proving request once (outside retry — it's deterministic)
    const provingRequest = await pm.provingRequest({
      programName: PROGRAM_ID,
      functionName,
      inputs,
      priorityFee: 0,
      privateFee: false,
      broadcast: true,
    });

    // Retry JWT + submission on 5xx/network errors
    return await withRetry(async () => {
      const jwt = await getJWT();
      console.log(`[aleo-admin] Submitting via delegated proving...`);
      const txId = await submitDelegated(provingRequest, jwt);
      console.log(`[aleo-admin] tx: ${txId}`);
      return txId;
    }, 5, 15000);
  }

  // Fallback: local proving
  console.log(`[aleo-admin] Local proving for ${functionName} (no Provable credentials)`);
  const pm2 = new ProgramManager(NETWORK_URL, keyProvider);
  pm2.setAccount(account);
  return await pm2.execute({
    programName: PROGRAM_ID,
    functionName,
    inputs,
    fee: 0.01,
    privateFee: false,
    broadcast: true,
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function updateRootOnChain(newRoot) {
  console.log(`[aleo-admin] update_root: ${newRoot.slice(0, 20)}...`);
  return await executeOnChain('update_root', [newRoot]);
}

export async function revokeUserOnChain(address) {
  return await executeOnChain('revoke_user', [address]);
}

export async function unrevokeUserOnChain(address) {
  return await executeOnChain('unrevoke_user', [address]);
}

export async function waitForConfirmation(txId, timeoutMs = 180000) {
  const start = Date.now();
  console.log(`[aleo-admin] Waiting for tx ${txId}...`);
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${EXPLORER_URL}/transaction/${txId}`);
      if (res.ok) { console.log(`[aleo-admin] Confirmed ✓`); return true; }
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`Tx not confirmed within ${timeoutMs}ms`);
}

export async function getCurrentRootOnChain() {
  const res = await fetch(`${EXPLORER_URL}/program/${PROGRAM_ID}/mapping/compliance_root/0u8`);
  if (!res.ok) return null;
  return (await res.text()).replace(/"/g, '').trim();
}

export async function isRevokedOnChain(address) {
  const res = await fetch(`${EXPLORER_URL}/program/${PROGRAM_ID}/mapping/revoked/${address}`);
  if (res.status === 404) return false;
  if (!res.ok) return false;
  return (await res.text()).includes('true');
}
