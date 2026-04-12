import {
  Account, ProgramManager, AleoKeyProvider, encryptProvingRequest
} from '@provablehq/sdk';
import dotenv from 'dotenv';

dotenv.config();

const NETWORK_URL          = process.env.ALEO_ENDPOINT || 'https://api.explorer.provable.com/v1';
const PROVABLE_API_KEY     = process.env.PROVABLE_API_KEY;
const PROVABLE_CONSUMER_ID = process.env.PROVABLE_CONSUMER_ID;
const PROVER_BASE          = 'https://api.provable.com/prove/testnet';
const EXPLORER_API         = process.env.ALEO_EXPLORER_API || 'https://api.explorer.provable.com/v1';
const ALEO_NETWORK         = process.env.ALEO_NETWORK || 'testnet';

const RETRY_ATTEMPTS       = 3;
const RETRY_BASE_MS        = 5000;
const CONFIRM_POLL_MS      = 5000;   // poll every 5s
const CONFIRM_TIMEOUT_MS   = 120000; // give up after 2 minutes

const log  = (...args) => console.log('[AleoClient]', ...args);
const warn = (...args) => console.warn('[AleoClient]', ...args);

// ── Retry helper ──────────────────────────────────────────────────────────────

async function withRetry(fn, label) {
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === RETRY_ATTEMPTS;
      warn(`${label} attempt ${attempt}/${RETRY_ATTEMPTS} failed: ${err.message}`);
      if (isLast) throw err;
      const delay = RETRY_BASE_MS * attempt;
      warn(`Retrying in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ── Wait for tx confirmation ──────────────────────────────────────────────────
// Polls the explorer until the tx is accepted or rejected.
// Returns 'accepted' | 'rejected' | 'timeout'

export async function waitForConfirmation(txId) {
  const url = `${EXPLORER_API}/${ALEO_NETWORK}/transaction/${txId}`;
  const start = Date.now();
  log(`Waiting for confirmation: ${txId}`);
  while (Date.now() - start < CONFIRM_TIMEOUT_MS) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const status = data?.status ?? data?.type ?? null;
        if (status === 'accepted' || status === 'Accepted') {
          log(`✅ Confirmed: ${txId}`);
          return 'accepted';
        }
        if (status === 'rejected' || status === 'Rejected') {
          warn(`❌ Rejected: ${txId}`);
          return 'rejected';
        }
        // Still pending — keep polling
      }
    } catch {}
    await new Promise(r => setTimeout(r, CONFIRM_POLL_MS));
  }
  warn(`⏱ Timeout waiting for: ${txId}`);
  return 'timeout';
}

// ── JWT ───────────────────────────────────────────────────────────────────────

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

// ── Delegated proving ─────────────────────────────────────────────────────────

async function submitDelegated(provingRequest, jwt) {
  const pubkeyRes = await fetch(`${PROVER_BASE}/pubkey`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: jwt },
  });
  if (!pubkeyRes.ok) {
    _jwt = null;
    throw new Error(`Pubkey fetch failed: ${pubkeyRes.status}`);
  }
  const pubkey = await pubkeyRes.json();
  const cookie = pubkeyRes.headers.get('set-cookie');

  const ciphertext = encryptProvingRequest(pubkey.public_key, provingRequest);

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

// ── Main export ───────────────────────────────────────────────────────────────

export async function submitPriceOnChain({ privateKey, program, assetKey, price, timestamp }) {
  const inputs = [
    assetKey,
    `${price}u64`,
    `${timestamp}u32`,
  ];

  log(`Submitting: ${program}/submit_price(${inputs.join(', ')})`);

  const keyProvider = new AleoKeyProvider();
  keyProvider.useCache(true);
  const pm = new ProgramManager(NETWORK_URL, keyProvider);
  const account = new Account({ privateKey });
  pm.setAccount(account);

  let txId;

  if (PROVABLE_API_KEY && PROVABLE_CONSUMER_ID) {
    txId = await withRetry(async () => {
      log(`Building proving request (delegated)...`);
      const jwt = await getJWT();
      const provingRequest = await pm.provingRequest({
        programName:  program,
        functionName: 'submit_price',
        inputs,
        priorityFee:  0,
        privateFee:   false,
        broadcast:    true,
      });
      const id = await submitDelegated(provingRequest, jwt);
      log(`✅ Broadcast: txId=${id}`);
      return id;
    }, `submit_price(${assetKey})`);
  } else {
    warn(`No PROVABLE_API_KEY set — falling back to local proving (slow)`);
    txId = await withRetry(async () => {
      const id = await pm.execute({
        programName:  program,
        functionName: 'submit_price',
        inputs,
        fee:          0.01,
        privateFee:   false,
      });
      log(`✅ Broadcast: txId=${id}`);
      return id;
    }, `submit_price(${assetKey}) local`);
  }

  // Wait for on-chain confirmation before returning
  // This ensures sequential relayers don't race in finalize
  const status = await waitForConfirmation(txId);
  return { txId, status };
}
