/**
 * Provable API Client
 * Handles JWT auth, record scanning, and Delegated Proving Service (DPS).
 *
 * DPS replaces `snarkos developer execute` with Provable's TEE-backed prover:
 *   https://api.provable.com/prove/{network}
 *
 * Flow (encrypted):
 *   1. GET  /pubkey              → ephemeral X25519 key
 *   2. Build ProvingRequest via @provablehq/sdk ProgramManager
 *   3. Encrypt with encryptProvingRequest()
 *   4. POST /prove/encrypted     → { transaction, broadcast_result }
 *
 * Requires: npm install @provablehq/sdk
 */

const PROVABLE_API_BASE    = 'https://api.provable.com';
const PROVABLE_API_BASE_V2 = 'https://api.provable.com/v2';

export class ProvableClient {
  constructor(consumerId, apiKey, network = 'testnet') {
    this.consumerId = consumerId;
    this.apiKey     = apiKey;
    this.network    = network;
    this.proverBase = `${PROVABLE_API_BASE}/prove/${network}`;
    this.jwtToken   = null;
    this.jwtExpiry  = null;
    this.uuid       = null;

    // Lazily loaded SDK exports
    this._sdk = null;
  }

  // ─────────────────────────────────────────────────────────────
  // AUTH
  // ─────────────────────────────────────────────────────────────

  async getJwtToken() {
    if (this.jwtToken && this.jwtExpiry && Date.now() < this.jwtExpiry) {
      return this.jwtToken;
    }

    const response = await fetch(`${PROVABLE_API_BASE}/jwts/${this.consumerId}`, {
      method: 'POST',
      headers: {
        'X-Provable-API-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get JWT: ${response.status} ${response.statusText}`);
    }

    const authHeader = response.headers.get('Authorization');
    if (authHeader) {
      this.jwtToken  = authHeader.replace('Bearer ', '');
      this.jwtExpiry = Date.now() + 55 * 60 * 1000;
      return this.jwtToken;
    }

    const data = await response.json().catch(() => null);
    if (data?.token || data?.jwt) {
      this.jwtToken  = data.token || data.jwt;
      this.jwtExpiry = Date.now() + 55 * 60 * 1000;
      return this.jwtToken;
    }

    throw new Error('JWT not found in response');
  }

  // ─────────────────────────────────────────────────────────────
  // SCANNER
  // ─────────────────────────────────────────────────────────────

  async registerViewKey(viewKey, startBlock = 0) {
    const token = await this.getJwtToken();
    const response = await fetch(`${PROVABLE_API_BASE}/scanner/${this.network}/register`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ view_key: viewKey, start: startBlock }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Registration failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    this.uuid = data.uuid;
    return data;
  }

  async getStatus() {
    if (!this.uuid) throw new Error('No UUID - call registerViewKey first');
    const token = await this.getJwtToken();

    const response = await fetch(`${PROVABLE_API_BASE}/scanner/${this.network}/status`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(this.uuid),
    });

    if (!response.ok) throw new Error(`Status check failed: ${response.status}`);
    return response.json();
  }

  async getOwnedRecords(options = {}) {
    if (!this.uuid) throw new Error('No UUID - call registerViewKey first');
    const token = await this.getJwtToken();

    const body = {
      uuid:    this.uuid,
      decrypt: options.decrypt !== false,
      unspent: options.unspent !== false,
    };

    if (options.programs) {
      body.filter = { programs: options.programs };
    }

    body.response_filter = {
      block_height:      true,
      commitment:        true,
      record_ciphertext: true,
      record_plaintext:  true,
      function_name:     true,
      nonce:             true,
      owner:             true,
      program_name:      true,
      record_name:       true,
      transaction_id:    true,
      transition_id:     true,
    };

    const response = await fetch(`${PROVABLE_API_BASE}/scanner/${this.network}/records/owned`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Get records failed: ${response.status} - ${errorText}`);
    }

    return response.json();
  }

  setUuid(uuid) { this.uuid = uuid; }

  // ─────────────────────────────────────────────────────────────
  // SDK lazy-loader
  // ─────────────────────────────────────────────────────────────

  async _loadSdk() {
    if (this._sdk) return this._sdk;
    // Dynamic import keeps the file runnable without the SDK installed
    // (falls back to snarkOS when DPS is unavailable)
    const sdk = await import('@provablehq/sdk');
    this._sdk = sdk;
    return sdk;
  }

  // ─────────────────────────────────────────────────────────────
  // DELEGATED PROVING SERVICE
  // ─────────────────────────────────────────────────────────────

  /**
   * decryptRecord()
   *
   * Decrypts a record ciphertext in-process using the @provablehq/sdk WASM bindings.
   * Takes ~1-5ms, no subprocess, no network call.
   * Used as a fallback when the Provable scanner hasn't indexed record_plaintext yet.
   *
   * @param {string} ciphertext  - Record ciphertext string (record1...)
   * @param {string} viewKey     - Aleo view key (AViewKey1...)
   * @returns {Promise<string>}  - Decrypted plaintext record as a string
   */
  async decryptRecord(ciphertext, viewKey) {
    const { RecordCiphertext, ViewKey } = await this._loadSdk();
    const vk  = ViewKey.from_string(viewKey);
    const ct  = RecordCiphertext.fromString(ciphertext);
    const pt  = ct.decrypt(vk);
    return pt.toString();
  }

    /**
   * executeTransaction()
   *
   * Submits a ZK execution to Provable's TEE-backed Delegated Proving Service.
   * No local snarkOS or WASM proving — the prover generates and broadcasts
   * the transaction from inside a Trusted Execution Environment.
   *
   * The DPS flow (encrypted):
   *   1. GET  {proverBase}/pubkey          → ephemeral X25519 key
   *   2. Build ProvingRequest via SDK
   *   3. encryptProvingRequest(publicKey, request)
   *   4. POST {proverBase}/prove/encrypted  → { transaction, broadcast_result }
   *
   * @param {object} opts
   * @param {string}   opts.privateKey     - Caller's Aleo private key
   * @param {string}   opts.programId      - e.g. 'zkperp_v9.aleo'
   * @param {string}   opts.functionName   - e.g. 'update_price' | 'liquidate'
   * @param {string[]} opts.inputs         - Ordered function inputs as strings
   * @param {boolean}  [opts.useFeeMaster] - true = prover pays fee (if configured)
   * @param {number}   [opts.priorityFee]  - Priority fee in microcredits (default 0)
   * @param {boolean}  [opts.privateFee]   - Use private fee record (default false)
   * @param {boolean}  [opts.broadcast]    - Prover broadcasts tx (default true)
   * @param {boolean}  [opts.encrypted]    - Use encrypted proving flow (default true)
   * @param {number}   [opts.timeoutMs]    - Max wait ms for /prove/encrypted (default 120000)
   *
   * @returns {{ txId: string|null, broadcastStatus: string|null }}
   * @throws  on proof failure, broadcast failure, SDK import failure, or timeout
   */
  async executeTransaction({
    privateKey,
    programId,
    functionName,
    inputs,
    useFeeMaster = false,
    priorityFee  = 0,
    privateFee   = false,
    broadcast    = true,
    encrypted    = true,
    timeoutMs    = 120_000,
  }) {
    const sdk = await this._loadSdk();
    const {
      Account,
      AleoKeyProvider,
      AleoNetworkClient,
      NetworkRecordProvider,
      ProgramManager,
      encryptProvingRequest,
    } = sdk;

    // Build SDK objects pointing at the Provable v2 API
    const account        = new Account({ privateKey });
    const networkClient  = new AleoNetworkClient(PROVABLE_API_BASE_V2);
    const keyProvider    = new AleoKeyProvider();
    const recordProvider = new NetworkRecordProvider(account, networkClient);
    keyProvider.useCache(true);

    const programManager = new ProgramManager(PROVABLE_API_BASE_V2, keyProvider, recordProvider);
    programManager.setAccount(account);

    // Build the ProvingRequest (authorisation + optional fee auth)
    const provingRequest = await programManager.provingRequest({
      programName:  programId,
      functionName,
      inputs,
      privateFee,
      priorityFee,
      useFeeMaster,
      broadcast,
    });

    const jwt = await this.getJwtToken();

    if (!encrypted) {
      return this._submitUnencrypted(provingRequest, jwt, timeoutMs);
    }

    return this._submitEncrypted(provingRequest, jwt, encryptProvingRequest, timeoutMs);
  }

  async _submitEncrypted(provingRequest, jwt, encryptProvingRequest, timeoutMs) {
    const authHeaders = {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${jwt}`,
    };

    // Step 1: fetch ephemeral public key
    const pubkeyRes = await _fetchWithTimeout(
      `${this.proverBase}/pubkey`,
      { method: 'GET', headers: authHeaders },
      15_000,
    );
    if (!pubkeyRes.ok) {
      throw new Error(`DPS /pubkey failed (${pubkeyRes.status}): ${await pubkeyRes.text()}`);
    }
    const pubkeyData = await pubkeyRes.json();
    // Forward session cookie so prover can correlate pubkey ↔ prove requests (Node only)
    const cookie = pubkeyRes.headers.get('set-cookie');

    // Step 2: encrypt the proving request
    const ciphertext = encryptProvingRequest(pubkeyData.public_key, provingRequest);

    // Step 3: POST encrypted request — can take 10–60s while the TEE proves
    const proveRes = await _fetchWithTimeout(
      `${this.proverBase}/prove/encrypted`,
      {
        method: 'POST',
        headers: { ...authHeaders, ...(cookie ? { Cookie: cookie } : {}) },
        body:    JSON.stringify({ key_id: pubkeyData.key_id, ciphertext }),
      },
      timeoutMs,
    );

    const text = await proveRes.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { message: text }; }

    if (!proveRes.ok) {
      throw new Error(`DPS /prove/encrypted failed (${proveRes.status}): ${body?.message ?? text}`);
    }

    return {
      txId:            body.transaction?.id ?? body.tx_id ?? null,
      broadcastStatus: body.broadcast_result?.status ?? null,
    };
  }

  async _submitUnencrypted(provingRequest, jwt, timeoutMs) {
    const res = await _fetchWithTimeout(
      `${this.proverBase}/prove`,
      {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${jwt}`,
        },
        body: provingRequest.toString(),
      },
      timeoutMs,
    );

    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { message: text }; }

    if (!res.ok) {
      throw new Error(`DPS /prove failed (${res.status}): ${body?.message ?? text}`);
    }

    return {
      txId:            body.transaction?.id ?? body.tx_id ?? null,
      broadcastStatus: body.broadcast_result?.status ?? null,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

function _fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}
