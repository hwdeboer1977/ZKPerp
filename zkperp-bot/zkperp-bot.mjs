#!/usr/bin/env node

/**
 * ZKPerp Liquidation + Order Execution Bot v14
 * ====================================
 *
 * Oracle price updates are now handled by zkperp_oracle_v2.aleo directly.
 * This bot no longer calls update_price or receives POST /oracle/update.
 * Price is read from zkperp_oracle_v2.aleo::oracle_prices on every liquidation tick.
 *
 * All transaction proving is delegated to Provable's TEE-backed Delegated Proving Service.
 *
 * API endpoints:
 *   GET /api/liq-auths          - All known open LiquidationAuth positions
 *   GET /api/liq-auths/:posId   - Single position by ID
 *   GET /api/pending-orders     - All known pending orders (limit/TP/SL)
 *   GET /health                 - Bot status
 *
 * Environment variables (see .env.example):
 *   PRIVATE_KEY            - Orchestrator/admin private key
 *   VIEW_KEY               - Orchestrator view key (for record scanning)
 *   PROVABLE_CONSUMER_ID   - Provable API consumer ID
 *   PROVABLE_API_KEY       - Provable API key
 *   ORACLE_PROGRAM_ID      - Oracle program (default: zkperp_oracle_v2.aleo)
 *   ASSET_ID               - BTC_USD | ETH_USD | SOL_USD
 *   API_PORT               - HTTP port (default: 3001)
 *   FRONTEND_ORIGIN        - CORS origin (default: http://localhost:5173)
 */

import 'dotenv/config';
import https from 'https';
import http from 'http';
import { ProvableClient } from './provable-client.mjs';

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const CONFIG = {
  // Keys
  privateKey: process.env.PRIVATE_KEY || '',
  viewKey:    process.env.VIEW_KEY    || '',

  // Provable API
  consumerId: process.env.PROVABLE_CONSUMER_ID || '',
  apiKey:     process.env.PROVABLE_API_KEY     || '',

  // Single program + asset — deploy one bot per market
  // BTC bot: PROGRAM_ID=zkperp_core_v26.aleo ASSET_ID=BTC_USD
  // ETH bot: PROGRAM_ID=zkperp_eth_v26.aleo  ASSET_ID=ETH_USD
  // SOL bot: PROGRAM_ID=zkperp_sol_v26.aleo  ASSET_ID=SOL_USD
  programId:       process.env.PROGRAM_ID,
  assetId:         process.env.ASSET_ID,
  oracleProgramId: process.env.ORACLE_PROGRAM_ID || 'zkperp_oracle_v2.aleo',
  network:         process.env.NETWORK    || 'testnet',
  networkId:       process.env.NETWORK_ID || '1',

  // Endpoints
  apiEndpoint:       process.env.API_ENDPOINT       || 'https://api.explorer.provable.com/v1/testnet',
  queryEndpoint:     process.env.QUERY_ENDPOINT     || 'https://api.explorer.provable.com/v1',
  broadcastEndpoint: process.env.BROADCAST_ENDPOINT || 'https://api.explorer.provable.com/v1/testnet/transaction/broadcast',

  // Intervals
  scanIntervalMs: parseInt(process.env.SCAN_INTERVAL || '60000'),

  // HTTP API
  apiPort:        parseInt(process.env.API_PORT || '3001'),
  frontendOrigin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',

  execUseFeeMaster: process.env.EXEC_USE_FEE_MASTER === 'true',

  // Contract constants
  liquidationThresholdBps: 10000n,  // 1%
  liquidationRewardBps:    5000n,   // 0.5%
};

// Oracle asset key mapping — matches zkperp_oracle_v2.aleo markets.json
const ORACLE_ASSET_KEYS = {
  'BTC_USD': '1field',
  'ETH_USD': '2field',
  'SOL_USD': '3field',
};

const ALL_PROGRAM_IDS = new Set([CONFIG.programId]);

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════

const positionStore      = new Map();
const slotPlaintextStore = new Map();
const pendingOrderStore  = new Map();
const execTPSLAuthStore  = new Map();
const execLimitAuthStore = new Map();

let lastScanAt         = null;
let currentOraclePrice = 0n;
let botStartedAt       = new Date().toISOString();
let botPaused          = false;
let isProcessing       = false;

// ── Memory management ───────────────────────────────────────────
const MAX_POSITION_STORE_SIZE      = Number(process.env.MAX_POSITION_STORE_SIZE      || 2000);
const POSITION_TTL_MS              = Number(process.env.POSITION_TTL_MS              || 30 * 60 * 1000);
const POSITION_CLEANUP_INTERVAL_MS = Number(process.env.POSITION_CLEANUP_INTERVAL_MS || 5 * 60 * 1000);

function upsertPosition(pos) {
  if (!pos?.positionId) return;
  const existing = positionStore.get(pos.positionId);
  positionStore.set(pos.positionId, {
    ...existing,
    ...pos,
    scannedAt: pos.scannedAt || new Date().toISOString(),
  });
  while (positionStore.size > MAX_POSITION_STORE_SIZE) {
    positionStore.delete(positionStore.keys().next().value);
  }
}

function cleanupExpiredPositions() {
  const cutoff = Date.now() - POSITION_TTL_MS;
  let removed = 0;
  for (const [id, pos] of positionStore.entries()) {
    if (new Date(pos.scannedAt).getTime() < cutoff) { positionStore.delete(id); removed++; }
  }
  if (removed > 0) log('CLEANUP', `Removed ${removed} stale positions, remaining=${positionStore.size}`);
}

function emergencyTrimPositionStore() {
  const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  if (rssMb > 400) {
    const keys = Array.from(positionStore.keys());
    const removeCount = Math.floor(keys.length / 2);
    for (let i = 0; i < removeCount; i++) positionStore.delete(keys[i]);
    log('MEM', `⚠️ Emergency trim: rss=${rssMb}MB, removed ${removeCount} positions`);
  }
}

function logMemoryUsage(tag = 'mem') {
  const m = process.memoryUsage();
  log(tag, `rss=${Math.round(m.rss/1024/1024)}MB heapUsed=${Math.round(m.heapUsed/1024/1024)}MB storeSize=${positionStore.size}`);
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function log(tag, msg) {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function logError(tag, msg) {
  const ts = new Date().toISOString().substring(11, 19);
  console.error(`[${ts}] [${tag}] ❌ ${msg}`);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
    }).on('error', reject);
  });
}

async function fetchText(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function getMapping(mapping, key, programId) {
  const pid = programId || CONFIG.programId;
  return fetchText(`${CONFIG.apiEndpoint}/program/${pid}/mapping/${mapping}/${key}`);
}

async function fetchJsonPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname, port: urlObj.port || 443, path: urlObj.pathname,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => { try { resolve(JSON.parse(responseData)); } catch { reject(new Error('Invalid JSON')); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// ORACLE PRICE — reads from zkperp_oracle_v2.aleo
// ═══════════════════════════════════════════════════════════════

async function getCurrentOraclePriceFromChain() {
  const assetKey = ORACLE_ASSET_KEYS[CONFIG.assetId] || '1field';
  try {
    const raw = await fetchText(
      `${CONFIG.apiEndpoint}/program/${CONFIG.oracleProgramId}/mapping/oracle_prices/${assetKey}`
    );
    if (!raw || raw === 'null') return null;
    const match = raw.match(/price:\s*(\d+)u64/);
    return match ? BigInt(match[1]) : null;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════
// HTTP API SERVER
// ═══════════════════════════════════════════════════════════════

function calcLiquidation(pos, price) {
  if (!price || price === 0n) return { pnl: 0n, marginRatio: 100, isLiquidatable: false, reward: 0n };
  const size8       = pos.size * 100n;
  const collateral8 = pos.collateral * 100n;
  const priceDiff   = price > pos.entryPrice ? price - pos.entryPrice : pos.entryPrice - price;
  const pnlAbs      = (size8 * priceDiff) / (pos.entryPrice + 1n);
  const traderProfits = (pos.isLong && price > pos.entryPrice) || (!pos.isLong && price < pos.entryPrice);
  const pnl           = traderProfits ? pnlAbs : -pnlAbs;
  const remainingMargin = collateral8 + pnl;
  const marginRatio   = Number(remainingMargin * 100n * 10000n / (size8 + 1n)) / 10000;
  const isLiquidatable = marginRatio < 1;
  const reward        = (pos.size * CONFIG.liquidationRewardBps) / 1_000_000n;
  return { pnl, marginRatio, isLiquidatable, reward };
}

function serializePosition(pos) {
  const calc = calcLiquidation(pos, currentOraclePrice);
  return {
    positionId:     pos.positionId,
    trader:         pos.trader,
    isLong:         pos.isLong,
    sizeUsdc:       pos.size.toString(),
    collateralUsdc: pos.collateral.toString(),
    entryPrice:     pos.entryPrice.toString(),
    currentPrice:   currentOraclePrice.toString(),
    pnl:            calc.pnl.toString(),
    marginRatio:    calc.marginRatio,
    isLiquidatable: calc.isLiquidatable,
    reward:         calc.reward.toString(),
    scannedAt:      pos.scannedAt,
  };
}

function startApiServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', CONFIG.frontendOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://localhost:${CONFIG.apiPort}`);

    if (req.method === 'POST' && url.pathname === '/api/register-slot') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { positionId, slotPlaintext, trader, nonce } = JSON.parse(body);
          if (!positionId || !slotPlaintext) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'positionId and slotPlaintext required' }));
            return;
          }
          const entry = { slotPlaintext, trader, registeredAt: new Date().toISOString() };
          if (nonce) slotPlaintextStore.set(nonce, entry);
          slotPlaintextStore.set(positionId, entry);
          log('API', `Registered slot for limit order (positionId: ${positionId.slice(0,20)}, trader: ${trader?.slice(0,20)})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/bot/pause') {
      botPaused = true;
      log('API', '⏸ Bot paused via API');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ paused: true }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/bot/resume') {
      botPaused = false;
      log('API', '▶️ Bot resumed via API');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ paused: false }));
      return;
    }

    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status:        'ok',
        paused:        botPaused,
        programId:     CONFIG.programId,
        oracleProgramId: CONFIG.oracleProgramId,
        assetId:       CONFIG.assetId,
        positionCount: positionStore.size,
        isProcessing,
        lastScanAt,
        currentPrice:  currentOraclePrice.toString(),
        netUnrealisedPnl: computeNetPnl(currentOraclePrice).toString(),
        pendingOrderCount:  pendingOrderStore.size,
        execTPSLAuthCount:  execTPSLAuthStore.size,
        execLimitAuthCount: execLimitAuthStore.size,
        upSince: botStartedAt,
      }));
      return;
    }

    if (url.pathname.startsWith('/api/order-by-nonce/')) {
      const nonce = url.pathname.split('/').pop();
      const found = Array.from(pendingOrderStore.values()).find(o => o.nonce === nonce);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(found ? { orderId: found.orderId, orderType: found.orderType } : { orderId: null }));
      return;
    }

    if (url.pathname === '/api/pending-orders') {
      const tpslOrders = Array.from(execTPSLAuthStore.values()).map(o => ({
        orderId:      o.orderId,
        orderType:    o.orderType,
        orderTypeStr: o.orderType === 1 ? 'take_profit' : 'stop_loss',
        isLong:       o.isLong,
        triggerPrice: o.triggerPrice.toString(),
        size:         o.size.toString(),
        collateral:   o.collateral.toString(),
        positionId:   o.positionId,
        slotId:       o.slotId,
        scannedAt:    o.scannedAt,
        triggered:    isOrderTriggered(o, currentOraclePrice),
      }));
      const limitOrders = Array.from(execLimitAuthStore.values()).map(o => ({
        orderId:      o.orderId,
        orderType:    0,
        orderTypeStr: 'limit',
        isLong:       o.isLong,
        triggerPrice: o.triggerPrice.toString(),
        size:         o.size.toString(),
        collateral:   o.collateral.toString(),
        positionId:   '0field',
        slotId:       o.slotId,
        scannedAt:    o.scannedAt,
        triggered:    isOrderTriggered(o, currentOraclePrice),
      }));
      const orders = [...tpslOrders, ...limitOrders];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ orders, count: orders.length, currentPrice: currentOraclePrice.toString() }));
      return;
    }

    if (url.pathname === '/api/liq-auths') {
      const positions = Array.from(positionStore.values()).map(serializePosition);
      positions.sort((a, b) => {
        if (a.isLiquidatable && !b.isLiquidatable) return -1;
        if (!a.isLiquidatable && b.isLiquidatable) return 1;
        return a.marginRatio - b.marginRatio;
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ positions, lastScanAt, currentPrice: currentOraclePrice.toString() }));
      return;
    }

    const posMatch = url.pathname.match(/^\/api\/liq-auths\/(.+)$/);
    if (posMatch) {
      const pos = positionStore.get(posMatch[1]);
      if (!pos) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(serializePosition(pos)));
      return;
    }

    res.writeHead(404); res.end();
  });

  server.listen(CONFIG.apiPort, () => {
    log('API', `✅ HTTP server listening on port ${CONFIG.apiPort}`);
    log('API', `   GET http://localhost:${CONFIG.apiPort}/api/liq-auths`);
    log('API', `   GET http://localhost:${CONFIG.apiPort}/health`);
  });

  server.on('error', err => logError('API', `Server error: ${err.message}`));
  return server;
}

// ═══════════════════════════════════════════════════════════════
// PNL + POOL STATE
// ═══════════════════════════════════════════════════════════════

function computeNetPnl(price) {
  if (!price || price === 0n) return 0n;
  let net = 0n;
  for (const pos of positionStore.values()) {
    if (!pos.size || !pos.entryPrice || pos.entryPrice === 0n) continue;
    const priceDiff    = price > pos.entryPrice ? price - pos.entryPrice : pos.entryPrice - price;
    const pnlAbs       = (pos.size * priceDiff) / (pos.entryPrice + 1n);
    const traderProfit = (pos.isLong && price > pos.entryPrice) || (!pos.isLong && price < pos.entryPrice);
    net += traderProfit ? pnlAbs : -pnlAbs;
  }
  return net;
}

async function submitNetPnl(price) {
  const netPnl   = computeNetPnl(price);
  const posCount = positionStore.size;
  log('PNL', `Net unrealised PnL: ${netPnl >= 0n ? '+' : ''}${netPnl} (${posCount} position(s))`);

  if (posCount === 0) {
    log('PNL', 'No open positions, skipping update_net_pnl');
    return;
  }

  const pnlInput = `${netPnl.toString()}i64`;
  log('PNL', `Submitting update_net_pnl input: ${pnlInput}`);

  try {
    const pid = CONFIG.programId;
    await provableClient.executeTransaction({
      privateKey:   CONFIG.privateKey,
      programId:    pid,
      functionName: 'update_net_pnl',
      inputs:       [pnlInput],
      useFeeMaster: CONFIG.execUseFeeMaster,
      timeoutMs:    120_000,
    });
    log('PNL', `✅ update_net_pnl submitted to ${pid} (${pnlInput})`);
  } catch (err) {
    const msg = err?.message ?? (typeof err === 'string' ? err : JSON.stringify(err));
    logError('PNL', `update_net_pnl failed: ${msg}`);
  }
}

async function submitPoolState() {
  if (!provableClient) return;
  const pid = CONFIG.programId;

  try {
    const raw = await fetchText(`${CONFIG.apiEndpoint}/program/${pid}/mapping/pool_state/0field`);
    if (!raw || raw === 'null') { log('POOL', `No pool_state on ${pid} — skipping`); return; }

    const liqMatch  = raw.match(/total_liquidity:\s*(\d+)u64/);
    const lpMatch   = raw.match(/total_lp_tokens:\s*(\d+)u64/);
    const feesMatch = raw.match(/accumulated_fees:\s*(\d+)u64/);
    if (!liqMatch) { log('POOL', 'Could not parse pool_state'); return; }

    const totalLiquidity = BigInt(liqMatch[1]);
    const totalLpTokens  = BigInt(lpMatch?.[1]  || '0');
    const accFees        = BigInt(feesMatch?.[1] || '0');

    let longOI = 0n, shortOI = 0n;
    for (const pos of positionStore.values()) {
      if (pos.isLong) longOI  += pos.size || 0n;
      else            shortOI += pos.size || 0n;
    }

    log('POOL', `Submitting update_pool_state: liquidity=${totalLiquidity} longOI=${longOI} shortOI=${shortOI}`);

    await provableClient.executeTransaction({
      privateKey:   CONFIG.privateKey,
      programId:    pid,
      functionName: 'update_pool_state',
      inputs: [
        `${totalLiquidity}u64`,
        `${longOI}u64`,
        `${shortOI}u64`,
        `${totalLpTokens}u64`,
        `${accFees}u64`,
      ],
      useFeeMaster: CONFIG.execUseFeeMaster,
      timeoutMs:    120_000,
    });
    log('POOL', `✅ update_pool_state submitted (longOI=${longOI} shortOI=${shortOI})`);
  } catch (err) {
    const msg = err?.message ?? (typeof err === 'string' ? err : JSON.stringify(err));
    logError('POOL', `update_pool_state failed: ${msg}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// SCANNER
// ═══════════════════════════════════════════════════════════════

let provableClient    = null;
let scannerRegistered = false;

const SCANNER_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];

async function initScanner({ attempt = 0 } = {}) {
  if (!CONFIG.consumerId || !CONFIG.apiKey || !CONFIG.viewKey) {
    logError('SCAN', 'Missing PROVABLE_CONSUMER_ID, PROVABLE_API_KEY, or VIEW_KEY — scanner disabled');
    return false;
  }
  if (!provableClient) {
    provableClient = new ProvableClient(CONFIG.consumerId, CONFIG.apiKey, CONFIG.network);
  }
  try {
    log('SCAN', `Registering view key with Provable scanner${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}...`);
    const startBlock = parseInt(process.env.SCANNER_START_BLOCK || '14864000');
    const reg = await provableClient.registerViewKey(CONFIG.viewKey, startBlock);
    log('SCAN', `✅ Registered. UUID: ${reg.uuid} (from block ${startBlock})`);
    const status = await provableClient.getStatus();
    log('SCAN', `Scanner status: ${status.synced ? 'synced' : `syncing (${status.percentage}%)`}`);
    scannerRegistered = true;
    return true;
  } catch (err) {
    logError('SCAN', `Scanner registration failed: ${err.message}`);
    scannerRegistered = false;
    const delayMs = SCANNER_RETRY_DELAYS_MS[Math.min(attempt, SCANNER_RETRY_DELAYS_MS.length - 1)];
    log('SCAN', `Retrying registration in ${delayMs / 1000}s...`);
    setTimeout(() => initScanner({ attempt: attempt + 1 }), delayMs);
    return false;
  }
}

async function scanPositions() {
  if (scannerRegistered && provableClient) {
    const results = await scanViaProvableScanner();
    if (results.length > 0) return results;
    return [];
  }
  log('SCAN', 'Scanner not registered — skipping scan (retry pending)');
  return [];
}

const MAX_RECORDS_PER_SCAN = Number(process.env.MAX_RECORDS_PER_SCAN || 50);

async function scanViaProvableScanner() {
  log('SCAN', 'Fetching records from Provable Scanner...');
  try {
    const allRecords = await provableClient.getOwnedRecords({ decrypt: true, unspent: true });
    const allList = Array.isArray(allRecords) ? allRecords : (allRecords?.records || []);
    const liquidationRecords = allList
      .filter(r => ALL_PROGRAM_IDS.has(r.program_name) && r.record_name === 'LiquidationAuth')
      .slice(0, MAX_RECORDS_PER_SCAN);
    const liqProgramMap = new Map(liquidationRecords.map(r => [r, r.program_name || CONFIG.programId]));
    log('SCAN', `Provable Scanner: ${liquidationRecords.length} LiquidationAuth records (cap=${MAX_RECORDS_PER_SCAN})`);

    const authRecords = allList
      .filter(r => ALL_PROGRAM_IDS.has(r.program_name) && r.record_name === 'ExecTPSLAuth')
      .slice(0, MAX_RECORDS_PER_SCAN);
    log('SCAN', `Provable Scanner: ${authRecords.length} ExecTPSLAuth records`);

    for (const record of authRecords) {
      let ptStr = record.record_plaintext || record.plaintext || '';
      if (!ptStr && record.record_ciphertext) {
        try {
          ptStr = await provableClient.decryptRecord(record.record_ciphertext, CONFIG.viewKey);
        } catch (e) {
          logError('SCAN', `ExecTPSLAuth decrypt failed: ${e.message}`);
          continue;
        }
      }
      if (!ptStr) continue;
      const auth = parseExecTPSLAuthFromPlaintext(ptStr);
      if (!auth) continue;

      try {
        const tpslPid = record.program_name || CONFIG.programId;
        const activeRaw = await getMapping('pending_orders', auth.orderId, tpslPid);
        if (!activeRaw || activeRaw === 'null' || activeRaw.includes('false')) {
          log('SCAN', `Skipping inactive ExecTPSLAuth ${auth.orderId.slice(0,20)}`);
          execTPSLAuthStore.delete(auth.orderId);
          continue;
        }
      } catch { continue; }

      const recordOnly = ptStr.substring(ptStr.indexOf('{'));
      const compactPt = recordOnly
        .replace(/:\s+/g, ':').replace(/,\s+/g, ',')
        .replace(/\s*{\s*/g, '{').replace(/\s*}\s*/g, '}').trim();

      const tpslProgramId = record.program_name || CONFIG.programId;
      execTPSLAuthStore.set(auth.orderId, { ...auth, plaintext: compactPt, programId: tpslProgramId, scannedAt: new Date().toISOString() });
    }
    log('SCAN', `ExecTPSLAuth store: ${execTPSLAuthStore.size} active TP/SL auth(s)`);

    const limitAuthRecords = allList
      .filter(r => ALL_PROGRAM_IDS.has(r.program_name) && r.record_name === 'ExecLimitAuth')
      .slice(0, MAX_RECORDS_PER_SCAN);
    log('SCAN', `Provable Scanner: ${limitAuthRecords.length} ExecLimitAuth records`);

    for (const record of limitAuthRecords) {
      let ptStr = record.record_plaintext || record.plaintext || '';
      if (!ptStr && record.record_ciphertext) {
        try { ptStr = await provableClient.decryptRecord(record.record_ciphertext, CONFIG.viewKey); }
        catch (e) { logError('SCAN', `ExecLimitAuth decrypt failed: ${e.message}`); continue; }
      }
      if (!ptStr) continue;
      const auth = parseExecLimitAuthFromPlaintext(ptStr);
      if (!auth) continue;

      try {
        const activeRaw = await getMapping('pending_orders', auth.orderId);
        if (!activeRaw || activeRaw === 'null' || activeRaw.includes('false')) {
          log('SCAN', `Skipping inactive ExecLimitAuth ${auth.orderId.slice(0,20)}`);
          execLimitAuthStore.delete(auth.orderId);
          continue;
        }
      } catch { continue; }

      const recordOnly = ptStr.substring(ptStr.indexOf('{'));
      const compactPt = recordOnly
        .replace(/:\s+/g, ':').replace(/,\s+/g, ',')
        .replace(/\s*{\s*/g, '{').replace(/\s*}\s*/g, '}').trim();

      execLimitAuthStore.set(auth.orderId, { ...auth, plaintext: compactPt, scannedAt: new Date().toISOString() });
    }
    log('SCAN', `ExecLimitAuth store: ${execLimitAuthStore.size} active limit auth(s)`);

    const orderRecords = allList
      .filter(r => ALL_PROGRAM_IDS.has(r.program_name) && r.record_name === 'PendingOrder')
      .slice(0, MAX_RECORDS_PER_SCAN);
    log('SCAN', `Provable Scanner: ${orderRecords.length} PendingOrder records (limit orders)`);

    for (const record of orderRecords) {
      let ptStr = record.record_plaintext || record.plaintext || '';
      if (!ptStr && record.record_ciphertext) {
        try {
          ptStr = await provableClient.decryptRecord(record.record_ciphertext, CONFIG.viewKey);
        } catch (e) {
          logError('SCAN', `PendingOrder decrypt failed: ${e.message}`);
          continue;
        }
      }
      if (!ptStr) continue;
      const order = parsePendingOrderFromPlaintext(ptStr);
      if (!order || order.orderType !== 0) continue;

      try {
        const activeRaw = await getMapping('pending_orders', order.orderId);
        if (!activeRaw || activeRaw === 'null' || activeRaw.includes('false')) {
          log('SCAN', `Skipping orphaned PendingOrder ${order.orderId.slice(0,20)}`);
          pendingOrderStore.delete(order.orderId);
          continue;
        }
      } catch { continue; }

      const recordOnly = ptStr.substring(ptStr.indexOf('{'));
      const compactPt = recordOnly
        .replace(/:\s+/g, ':').replace(/,\s+/g, ',')
        .replace(/\s*{\s*/g, '{').replace(/\s*}\s*/g, '}').trim();

      pendingOrderStore.set(order.orderId, { ...order, plaintext: compactPt, scannedAt: new Date().toISOString() });
    }
    log('SCAN', `PendingOrder store: ${pendingOrderStore.size} active limit order(s)`);

    const positions = [];
    for (const record of liquidationRecords) {
      let ptStr = record.record_plaintext || record.plaintext || '';
      if (!ptStr && record.record_ciphertext) {
        try {
          ptStr = await provableClient.decryptRecord(record.record_ciphertext, CONFIG.viewKey);
          if (ptStr) log('SCAN', `Block ${record.block_height}: decrypted in-process (scanner lag)`);
        } catch (e) {
          logError('SCAN', `Block ${record.block_height}: in-process decrypt failed: ${e.message} — skipping`);
          continue;
        }
      }
      if (!ptStr) continue;
      const pos = parsePositionFromPlaintext(ptStr);
      if (!pos) continue;

      try {
        const closedRaw = await getMapping('closed_positions', pos.positionId);
        if (closedRaw && closedRaw.includes('true')) continue;
        const openRaw = await getMapping('position_open_blocks', pos.positionId);
        if (!openRaw || openRaw === 'null') continue;
      } catch {}

      const recordOnly = ptStr.substring(ptStr.indexOf('{'));
      const compactPt  = recordOnly
        .replace(/:\s+/g, ':').replace(/,\s+/g, ',')
        .replace(/\s*{\s*/g, '{').replace(/\s*}\s*/g, '}').trim();

      positions.push({ ...pos, ciphertext: record.record_ciphertext, plaintext: compactPt });
      await sleep(50);
    }

    if (positions.length > 0) log('SCAN', `Scanner found ${positions.length} position(s)`);
    return positions;
  } catch (err) {
    logError('SCAN', `Provable Scanner failed: ${err.message}`);
    return [];
  }
}

async function scanViaLeoRpc() {
  log('SCAN', 'Scanning via Leo RPC...');
  const positions = [];
  try {
    const rpcEndpoint = 'https://testnetbeta.aleorpc.com';
    const countRes = await fetchJsonPost(rpcEndpoint, {
      jsonrpc: '2.0', id: 1, method: 'transactionsForProgramCount',
      params: { programId: CONFIG.programId, functionName: 'open_position' },
    });
    const count = parseInt(countRes?.result) || 0;
    if (count === 0) { log('SCAN', 'Leo RPC: 0 open_position transactions'); return positions; }
    log('SCAN', `Leo RPC: ${count} open_position transactions`);

    const txsRes = await fetchJsonPost(rpcEndpoint, {
      jsonrpc: '2.0', id: 1, method: 'aleoTransactionsForProgram',
      params: { programId: CONFIG.programId, functionName: 'open_position', page: 0, maxTransactions: 50 },
    });
    const txs = Array.isArray(txsRes?.result) ? txsRes.result : [];

    for (const tx of txs) {
      try {
        if (tx.status !== 'accepted') continue;
        const transitions = tx.transaction?.execution?.transitions || [];
        for (const transition of transitions) {
          if (transition.function !== 'open_position') continue;
          const pos = parsePositionFromTransition(transition);
          if (pos && !positions.some(p => p.positionId === pos.positionId)) {
            try {
              const closedRaw = await getMapping('closed_positions', pos.positionId);
              if (closedRaw && closedRaw.includes('true')) continue;
              const openRaw = await getMapping('position_open_blocks', pos.positionId);
              if (!openRaw || openRaw === 'null') continue;
            } catch {}
            positions.push(pos);
          }
        }
      } catch { continue; }
    }

    log('SCAN', `Leo RPC found ${positions.length} open position(s)`);
    return positions;
  } catch (err) {
    logError('SCAN', `Leo RPC scan failed: ${err.message}`);
    return positions;
  }
}

// ═══════════════════════════════════════════════════════════════
// STARTUP RECOVERY
// ═══════════════════════════════════════════════════════════════

async function recoverPendingOrders() {
  if (!scannerRegistered || !provableClient) {
    log('RECOVER', 'Scanner not ready — recovery skipped');
    return;
  }
  log('RECOVER', 'Scanning for ExecTPSLAuth + PendingOrder records owned by orchestrator...');
  try {
    const allRecords = await provableClient.getOwnedRecords({ decrypt: true, unspent: true });
    const allList = Array.isArray(allRecords) ? allRecords : (allRecords?.records || []);

    const authRecords      = allList.filter(r => ALL_PROGRAM_IDS.has(r.program_name) && r.record_name === 'ExecTPSLAuth');
    const limitAuthRecords = allList.filter(r => ALL_PROGRAM_IDS.has(r.program_name) && r.record_name === 'ExecLimitAuth');
    const orderRecords     = allList.filter(r => ALL_PROGRAM_IDS.has(r.program_name) && r.record_name === 'PendingOrder');

    log('RECOVER', `Found ${authRecords.length} ExecTPSLAuth + ${limitAuthRecords.length} ExecLimitAuth + ${orderRecords.length} PendingOrder record(s)`);

    let recoveredAuths = 0;
    for (const record of authRecords) {
      let ptStr = record.record_plaintext || record.plaintext || '';
      if (!ptStr && record.record_ciphertext) {
        try { ptStr = await provableClient.decryptRecord(record.record_ciphertext, CONFIG.viewKey); }
        catch (e) { logError('RECOVER', `ExecTPSLAuth decrypt failed: ${e.message}`); continue; }
      }
      if (!ptStr) continue;
      const auth = parseExecTPSLAuthFromPlaintext(ptStr);
      if (!auth) continue;
      try {
        const activeRaw = await getMapping('pending_orders', auth.orderId);
        if (!activeRaw || activeRaw === 'null' || activeRaw.includes('false')) {
          log('RECOVER', `Skipping inactive ExecTPSLAuth ${auth.orderId.slice(0, 20)}`);
          continue;
        }
      } catch { continue; }
      const recordOnly = ptStr.substring(ptStr.indexOf('{'));
      const compactPt  = recordOnly
        .replace(/:\s+/g, ':').replace(/,\s+/g, ',')
        .replace(/\s*{\s*/g, '{').replace(/\s*}\s*/g, '}').trim();
      const typeStr = auth.orderType === 1 ? 'TP' : 'SL';
      const tpslProgramId = record.program_name || CONFIG.programId;
      execTPSLAuthStore.set(auth.orderId, { ...auth, plaintext: compactPt, programId: tpslProgramId, scannedAt: new Date().toISOString() });
      recoveredAuths++;
      log('RECOVER', `✅ Restored ${typeStr} ExecTPSLAuth ${auth.orderId.slice(0, 20)} | trigger: $${(Number(auth.triggerPrice) / 1e8).toFixed(0)} | trader: ${auth.trader.slice(0, 20)}`);
    }

    let recoveredOrders = 0;
    for (const record of orderRecords) {
      let ptStr = record.record_plaintext || record.plaintext || '';
      if (!ptStr && record.record_ciphertext) {
        try { ptStr = await provableClient.decryptRecord(record.record_ciphertext, CONFIG.viewKey); }
        catch (e) { logError('RECOVER', `PendingOrder decrypt failed: ${e.message}`); continue; }
      }
      if (!ptStr) continue;
      const order = parsePendingOrderFromPlaintext(ptStr);
      if (!order || order.orderType !== 0) continue;
      try {
        const activeRaw = await getMapping('pending_orders', order.orderId);
        if (!activeRaw || activeRaw === 'null' || activeRaw.includes('false')) {
          log('RECOVER', `Skipping inactive PendingOrder ${order.orderId.slice(0, 20)}`);
          continue;
        }
      } catch { continue; }
      const recordOnly = ptStr.substring(ptStr.indexOf('{'));
      const compactPt  = recordOnly
        .replace(/:\s+/g, ':').replace(/,\s+/g, ',')
        .replace(/\s*{\s*/g, '{').replace(/\s*}\s*/g, '}').trim();
      pendingOrderStore.set(order.orderId, { ...order, plaintext: compactPt, scannedAt: new Date().toISOString() });
      recoveredOrders++;
      log('RECOVER', `✅ Restored LIMIT order ${order.orderId.slice(0, 20)}`);
    }

    let recoveredLimitAuths = 0;
    for (const record of limitAuthRecords) {
      let ptStr = record.record_plaintext || record.plaintext || '';
      if (!ptStr && record.record_ciphertext) {
        try { ptStr = await provableClient.decryptRecord(record.record_ciphertext, CONFIG.viewKey); }
        catch (e) { logError('RECOVER', `ExecLimitAuth decrypt failed: ${e.message}`); continue; }
      }
      if (!ptStr) continue;
      const auth = parseExecLimitAuthFromPlaintext(ptStr);
      if (!auth) continue;
      try {
        const activeRaw = await getMapping('pending_orders', auth.orderId);
        if (!activeRaw || activeRaw === 'null' || activeRaw.includes('false')) {
          log('RECOVER', `Skipping inactive ExecLimitAuth ${auth.orderId.slice(0, 20)}`);
          continue;
        }
      } catch { continue; }
      const recordOnly = ptStr.substring(ptStr.indexOf('{'));
      const compactPt  = recordOnly
        .replace(/:\s+/g, ':').replace(/,\s+/g, ',')
        .replace(/\s*{\s*/g, '{').replace(/\s*}\s*/g, '}').trim();
      execLimitAuthStore.set(auth.orderId, { ...auth, plaintext: compactPt, scannedAt: new Date().toISOString() });
      recoveredLimitAuths++;
      log('RECOVER', `✅ Restored LIMIT ExecLimitAuth ${auth.orderId.slice(0, 20)} | trigger: $${(Number(auth.triggerPrice) / 1e8).toFixed(0)} | trader: ${auth.trader.slice(0, 20)}`);
    }

    log('RECOVER', `Full recovery complete — ${recoveredAuths} TP/SL + ${recoveredLimitAuths} limit ExecAuth(s) + ${recoveredOrders} PendingOrder(s)`);
  } catch (err) {
    logError('RECOVER', `Recovery failed: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// PARSERS
// ═══════════════════════════════════════════════════════════════

function parsePositionFromPlaintext(plaintext) {
  try {
    const posIdMatch      = plaintext.match(/position_id:\s*(\d+field)(?:\.private)?/);
    const traderMatch     = plaintext.match(/trader:\s*(aleo1[a-z0-9]+)(?:\.private)?/);
    const isLongMatch     = plaintext.match(/is_long:\s*(true|false)(?:\.private)?/);
    const sizeMatch       = plaintext.match(/size_usdc:\s*(\d+)u64(?:\.private)?/);
    const collateralMatch = plaintext.match(/collateral_usdc:\s*(\d+)u(?:64|128)(?:\.private)?/);
    const entryPriceMatch = plaintext.match(/entry_price:\s*(\d+)u64(?:\.private)?/);
    if (!posIdMatch || !sizeMatch || !entryPriceMatch) return null;
    const sizeUsdc = BigInt(sizeMatch[1]);
    if (sizeUsdc < 10000n) return null;
    const slotIdMatch2   = plaintext.match(/slot_id:\s*(\d+)u8(?:\.private)?/);
    const slotNonceMatch = plaintext.match(/_nonce:\s*(\d+)group/);
    return {
      positionId: posIdMatch[1],
      trader:     traderMatch?.[1] || 'unknown',
      isLong:     isLongMatch?.[1] === 'true',
      size:       sizeUsdc,
      collateral: BigInt(collateralMatch?.[1] || '0'),
      entryPrice: BigInt(entryPriceMatch?.[1] || '0'),
      slotId:     parseInt(slotIdMatch2?.[1] || '0'),
      slotNonce:  slotNonceMatch?.[1] || null,
      scannedAt:  new Date().toISOString(),
    };
  } catch { return null; }
}

function parsePositionFromTransition(transition) {
  try {
    const futureOutput = (transition.outputs || []).find(o => o.type === 'future');
    if (!futureOutput?.value) return null;
    const futureStr     = String(futureOutput.value);
    const innerBlockEnd = futureStr.indexOf('},');
    if (innerBlockEnd === -1) return null;
    const afterBlock  = futureStr.substring(innerBlockEnd + 2);
    const posIdMatch  = afterBlock.match(/(\d{30,})field/);
    if (!posIdMatch) return null;
    const positionId  = posIdMatch[0];
    const traderMatch = afterBlock.match(/(aleo1[a-z0-9]+)/);
    const u64Matches  = afterBlock.match(/(\d+)u64/g) || [];
    const u64Values   = u64Matches.map(m => BigInt(m.replace('u64', '')));
    if (u64Values.length < 3) return null;
    return {
      positionId,
      trader:     traderMatch?.[1] || 'unknown',
      isLong:     !afterBlock.includes('\n    false') && !afterBlock.match(/,\s*false\s*,/),
      size:       u64Values[1],
      collateral: u64Values.length >= 6 ? u64Values[5] : u64Values[0],
      entryPrice: u64Values[2],
      scannedAt:  new Date().toISOString(),
    };
  } catch { return null; }
}

function parseExecTPSLAuthFromPlaintext(plaintext) {
  try {
    const orderIdMatch   = plaintext.match(/order_id:\s*(\d+field)(?:\.private)?/);
    const orderTypeMatch = plaintext.match(/order_type:\s*(\d+)u8(?:\.private)?/);
    const traderMatch    = plaintext.match(/trader:\s*(aleo1[a-z0-9]+)(?:\.private)?/);
    const slotIdMatch    = plaintext.match(/slot_id:\s*(\d+)u8(?:\.private)?/);
    const posIdMatch     = plaintext.match(/position_id:\s*(\d+field)(?:\.private)?/);
    const isLongMatch    = plaintext.match(/is_long:\s*(true|false)(?:\.private)?/);
    const triggerMatch   = plaintext.match(/trigger_price:\s*(\d+)u64(?:\.private)?/);
    const sizeMatch      = plaintext.match(/size_usdc:\s*(\d+)u64(?:\.private)?/);
    const collMatch      = plaintext.match(/collateral_usdc:\s*(\d+)u64(?:\.private)?/);
    const entryMatch     = plaintext.match(/entry_price:\s*(\d+)u64(?:\.private)?/);
    const nonceMatch     = plaintext.match(/nonce:\s*(\d+field)(?:\.private)?/);
    if (!orderIdMatch || !triggerMatch || !traderMatch) return null;
    return {
      orderId:      orderIdMatch[1],
      orderType:    parseInt(orderTypeMatch?.[1] || '1'),
      trader:       traderMatch[1],
      slotId:       parseInt(slotIdMatch?.[1] || '0'),
      positionId:   posIdMatch?.[1] || '0field',
      isLong:       isLongMatch?.[1] === 'true',
      triggerPrice: BigInt(triggerMatch[1]),
      size:         BigInt(sizeMatch?.[1] || '0'),
      collateral:   BigInt(collMatch?.[1] || '0'),
      entryPrice:   BigInt(entryMatch?.[1] || '0'),
      nonce:        nonceMatch?.[1] || null,
    };
  } catch { return null; }
}

function parseExecLimitAuthFromPlaintext(plaintext) {
  try {
    const orderIdMatch  = plaintext.match(/order_id:\s*(\d+field)(?:\.private)?/);
    const traderMatch   = plaintext.match(/trader:\s*(aleo1[a-z0-9]+)(?:\.private)?/);
    const slotIdMatch   = plaintext.match(/slot_id:\s*(\d+)u8(?:\.private)?/);
    const isLongMatch   = plaintext.match(/is_long:\s*(true|false)(?:\.private)?/);
    const triggerMatch  = plaintext.match(/trigger_price:\s*(\d+)u64(?:\.private)?/);
    const sizeMatch     = plaintext.match(/size_usdc:\s*(\d+)u64(?:\.private)?/);
    const collMatch     = plaintext.match(/collateral_usdc:\s*(\d+)u64(?:\.private)?/);
    const nonceMatch    = plaintext.match(/nonce:\s*(\d+field)(?:\.private)?/);
    if (!orderIdMatch || !triggerMatch || !traderMatch) return null;
    return {
      orderId:      orderIdMatch[1],
      trader:       traderMatch[1],
      slotId:       parseInt(slotIdMatch?.[1] || '0'),
      isLong:       isLongMatch?.[1] === 'true',
      triggerPrice: BigInt(triggerMatch[1]),
      size:         BigInt(sizeMatch?.[1] || '0'),
      collateral:   BigInt(collMatch?.[1] || '0'),
      nonce:        nonceMatch?.[1] || null,
      orderType:    0,
    };
  } catch { return null; }
}

function parsePendingOrderFromPlaintext(plaintext) {
  try {
    const orderIdMatch   = plaintext.match(/order_id:\s*(\d+field)(?:\.private)?/);
    const orderTypeMatch = plaintext.match(/order_type:\s*(\d+)u8(?:\.private)?/);
    const isLongMatch    = plaintext.match(/is_long:\s*(true|false)(?:\.private)?/);
    const triggerMatch   = plaintext.match(/trigger_price:\s*(\d+)u64(?:\.private)?/);
    const sizeMatch      = plaintext.match(/size_usdc:\s*(\d+)u64(?:\.private)?/);
    const collMatch      = plaintext.match(/collateral_usdc:\s*(\d+)u64(?:\.private)?/);
    const entryMatch     = plaintext.match(/entry_price:\s*(\d+)u64(?:\.private)?/);
    const posIdMatch     = plaintext.match(/position_id:\s*(\d+field)(?:\.private)?/);
    const slotIdMatch    = plaintext.match(/slot_id:\s*(\d+)u8(?:\.private)?/);
    if (!orderIdMatch || !triggerMatch || !sizeMatch) return null;
    const nonceMatch = plaintext.match(/nonce:\s*(\d+field)(?:\.private)?/);
    return {
      orderId:      orderIdMatch[1],
      orderType:    parseInt(orderTypeMatch?.[1] || '0'),
      isLong:       isLongMatch?.[1] === 'true',
      triggerPrice: BigInt(triggerMatch[1]),
      size:         BigInt(sizeMatch[1]),
      collateral:   BigInt(collMatch?.[1] || '0'),
      entryPrice:   BigInt(entryMatch?.[1] || '0'),
      positionId:   posIdMatch?.[1] || '0field',
      slotId:       parseInt(slotIdMatch?.[1] || '0'),
      nonce:        nonceMatch?.[1] || null,
    };
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════
// LIQUIDATION
// ═══════════════════════════════════════════════════════════════

function calculateMarginRatio(position, price) {
  const { isLong, size, collateral, entryPrice } = position;
  const size8           = size * 100n;
  const collateral8     = collateral * 100n;
  const priceDiff       = price > entryPrice ? price - entryPrice : entryPrice - price;
  const pnlAbs          = (size8 * priceDiff) / (entryPrice + 1n);
  const traderProfits   = (isLong && price > entryPrice) || (!isLong && price < entryPrice);
  const pnl             = traderProfits ? pnlAbs : -pnlAbs;
  const remainingMargin = collateral8 + pnl;
  const marginRatioBps  = (remainingMargin * 1_000_000n) / (size8 + 1n);
  return {
    pnl, marginRatioBps,
    marginPercent:  Number(marginRatioBps) / 10000,
    isLiquidatable: marginRatioBps < CONFIG.liquidationThresholdBps,
  };
}

async function liquidatePosition(position) {
  const { positionId, size, plaintext } = position;

  if (!plaintext) {
    logError('LIQUIDATE', `No plaintext record for ${positionId.slice(0, 20)} — cannot liquidate`);
    return false;
  }

  let reward = (size * CONFIG.liquidationRewardBps) / 1_000_000n;
  if (reward < 1n) reward = 1n;

  log('LIQUIDATE', `Liquidating ${positionId.slice(0, 20)}...`);
  log('LIQUIDATE', `Plaintext preview: ${plaintext?.substring(0, 150)}`);

  try {
    const liqProgramId = position.programId || CONFIG.programId;
    await provableClient.executeTransaction({
      privateKey:    CONFIG.privateKey,
      programId:     liqProgramId,
      functionName:  'liquidate',
      inputs:        [plaintext, `${reward}u128`],
      useFeeMaster:  CONFIG.execUseFeeMaster,
      timeoutMs:     180_000,
    });
    log('LIQUIDATE', `✅ Liquidated! Reward: $${(Number(reward) / 1_000_000).toFixed(4)}`);
    positionStore.delete(positionId);
    return true;
  } catch (err) {
    logError('LIQUIDATE', `Failed: ${err.message.substring(0, 200)}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN TICK
// ═══════════════════════════════════════════════════════════════

async function liquidationTick() {
  if (botPaused)    { log('SCAN', 'Bot paused, skipping liquidation scan'); return; }
  if (isProcessing) return;
  isProcessing = true;

  try {
    // Read current price from zkperp_oracle_v2.aleo
    const onChainPrice = await getCurrentOraclePriceFromChain();
    if (onChainPrice) {
      currentOraclePrice = onChainPrice;
      log('PRICE', `${CONFIG.assetId} @ $${(Number(onChainPrice) / 1e8).toLocaleString()}`);
    }
    if (!currentOraclePrice) { log('SCAN', 'No oracle price yet, skipping'); return; }

    const positions = await scanPositions();
    lastScanAt = new Date().toISOString();

    for (const pos of positions) {
      upsertPosition({
        positionId: pos.positionId,
        trader:     pos.trader,
        isLong:     pos.isLong,
        size:       pos.size,
        collateral: pos.collateral,
        entryPrice: pos.entryPrice,
        slotNonce:  pos.slotNonce,
        slotId:     pos.slotId,
        programId:  pos.programId || CONFIG.programId,
        scannedAt:  pos.scannedAt || new Date().toISOString(),
      });
    }

    cleanupExpiredPositions();
    emergencyTrimPositionStore();
    logMemoryUsage('after-scan');

    if (positions.length === 0) { log('SCAN', 'No open positions'); return; }

    if (provableClient) await submitPoolState();
    if (provableClient && positionStore.size > 0) await submitNetPnl(currentOraclePrice);
    if (provableClient) await executePendingOrders(currentOraclePrice);

    for (const pos of positions) {
      const m        = calculateMarginRatio(pos, currentOraclePrice);
      const entryUsd = (Number(pos.entryPrice) / 1e8).toLocaleString();
      const status   = m.isLiquidatable ? '⚠️ LIQUIDATABLE' : '✓ Healthy';
      log('SCAN', `${pos.isLong ? 'LONG' : 'SHORT'} | Entry: $${entryUsd} | Margin: ${m.marginPercent.toFixed(2)}% | ${status}`);

      if (m.isLiquidatable) {
        log('LIQUIDATE', '🔴 Below threshold! Liquidating...');
        await liquidatePosition(pos);
        await sleep(5000);
      }
    }
  } catch (err) {
    logError('SCAN', `Tick error: ${err.message}`);
  } finally {
    isProcessing = false;
  }
}

// ═══════════════════════════════════════════════════════════════
// PENDING ORDER HELPERS
// ═══════════════════════════════════════════════════════════════

function isOrderTriggered(order, price) {
  if (!price || price === 0n) return false;
  const { orderType, isLong, triggerPrice } = order;
  if (orderType === 0) {
    return isLong ? price <= triggerPrice : price >= triggerPrice;
  } else if (orderType === 1) {
    // Take profit: long triggers when price >= trigger, short when price <= trigger
    return isLong ? price >= triggerPrice : price <= triggerPrice;
  } else if (orderType === 2) {
    // Stop loss: long triggers when price <= trigger, short when price >= trigger
    return isLong ? price <= triggerPrice : price >= triggerPrice;
  }
  return false;
}

async function executePendingOrders(price) {
  if (execTPSLAuthStore.size > 0) {
    const triggeredAuths = Array.from(execTPSLAuthStore.values())
      .filter(a => isOrderTriggered(a, price));

    if (triggeredAuths.length > 0) {
      log('ORDER', `${triggeredAuths.length} TP/SL auth(s) triggered at price $${(Number(price) / 1e8).toLocaleString()}`);
      for (const auth of triggeredAuths) {
        try {
          await executeTPSLAuth(auth, price);
          await sleep(3000);
        } catch (err) {
          logError('ORDER', `Failed to execute ExecTPSLAuth ${auth.orderId.slice(0,20)}: ${err.message}`);
        }
      }
    }
  }

  if (execLimitAuthStore.size > 0) {
    const triggeredLimits = Array.from(execLimitAuthStore.values())
      .filter(a => isOrderTriggered(a, price));

    if (triggeredLimits.length > 0) {
      log('ORDER', `${triggeredLimits.length} limit auth(s) triggered at price $${(Number(price) / 1e8).toLocaleString()}`);
      for (const auth of triggeredLimits) {
        try {
          await executeExecLimitAuth(auth, price);
          await sleep(3000);
        } catch (err) {
          logError('ORDER', `Failed to execute ExecLimitAuth ${auth.orderId.slice(0,20)}: ${err.message}`);
        }
      }
    }
  }

  if (pendingOrderStore.size > 0) {
    const triggeredOrders = Array.from(pendingOrderStore.values())
      .filter(o => isOrderTriggered(o, price));

    if (triggeredOrders.length > 0) {
      log('ORDER', `${triggeredOrders.length} legacy limit order(s) triggered at price $${(Number(price) / 1e8).toLocaleString()}`);
      for (const order of triggeredOrders) {
        try {
          await executeOrder(order, price);
          await sleep(3000);
        } catch (err) {
          logError('ORDER', `Failed to execute legacy limit order ${order.orderId.slice(0,20)}: ${err.message}`);
        }
      }
    }
  }
}

async function executeExecLimitAuth(auth, price) {
  const { orderId, isLong, triggerPrice, trader, slotId } = auth;
  log('ORDER', `Executing LIMIT auth ${orderId.slice(0,20)} | trigger: $${(Number(triggerPrice)/1e8).toFixed(0)} | price: $${(Number(price)/1e8).toFixed(0)} | trader: ${trader.slice(0,20)}`);

  const executionNonce = generateNonce();
  const orchestratorAddress = CONFIG.orchestratorAddress || await getOrchestratorAddress();

  await provableClient.executeTransaction({
    privateKey:   CONFIG.privateKey,
    programId:    auth.programId || CONFIG.programId,
    functionName: 'execute_limit_order',
    inputs: [
      auth.plaintext,
      orchestratorAddress,
      executionNonce,
    ],
    useFeeMaster: CONFIG.execUseFeeMaster,
    timeoutMs:    180_000,
  });
  log('ORDER', `✅ execute_limit_order submitted for ${orderId.slice(0,20)}`);
  execLimitAuthStore.delete(orderId);
}

async function executeTPSLAuth(auth, price) {
  const { orderId, orderType, triggerPrice, positionId, trader } = auth;
  const typeStr = orderType === 1 ? 'take_profit' : 'stop_loss';
  log('ORDER', `Executing ${typeStr} auth ${orderId.slice(0,20)} | trigger: $${(Number(triggerPrice)/1e8).toFixed(0)} | price: $${(Number(price)/1e8).toFixed(0)} | trader: ${trader.slice(0,20)}`);

  const executionNonce = generateNonce();
  const execPrice = orderType === 2 ? price : triggerPrice;
  const expectedPayout = calcExpectedPayout(auth, execPrice);

  const functionName   = orderType === 1 ? 'execute_take_profit' : 'execute_stop_loss';
  const tpslProgramId  = auth.programId || CONFIG.programId;
  log('ORDER', `Using program: ${tpslProgramId}`);
  await provableClient.executeTransaction({
    privateKey:   CONFIG.privateKey,
    programId:    tpslProgramId,
    functionName,
    inputs: [
      auth.plaintext,
      `${expectedPayout}u128`,
      executionNonce,
    ],
    useFeeMaster: CONFIG.execUseFeeMaster,
    timeoutMs:    180_000,
  });
  log('ORDER', `✅ ${functionName} submitted | payout: $${(Number(expectedPayout)/1e6).toFixed(4)}`);
  execTPSLAuthStore.delete(orderId);
  positionStore.delete(positionId);
}

async function executeOrder(order, price) {
  const { orderId, orderType } = order;
  if (orderType !== 0) {
    logError('ORDER', `executeOrder called for non-limit order ${orderId.slice(0,20)} — skipping`);
    return;
  }
  log('ORDER', `Executing limit order ${orderId.slice(0,20)} | price: $${(Number(price)/1e8).toFixed(0)}`);

  const executionNonce = generateNonce();

  const registeredByOrderId = slotPlaintextStore.get(orderId);
  const registeredByNonce   = order.nonce ? slotPlaintextStore.get(order.nonce) : null;
  const registered = registeredByOrderId || registeredByNonce;
  if (registeredByNonce && !registeredByOrderId) slotPlaintextStore.set(orderId, registeredByNonce);

  if (!registered?.slotPlaintext) {
    logError('ORDER', `No registered slot for limit order ${orderId.slice(0,20)} — frontend must POST slot to /api/register-slot`);
    return;
  }

  await provableClient.executeTransaction({
    privateKey:   CONFIG.privateKey,
    programId:    order.programId || CONFIG.programId,
    functionName: 'execute_limit_order',
    inputs:       [order.plaintext, registered.slotPlaintext, CONFIG.orchestratorAddress || await getOrchestratorAddress(), executionNonce],
    useFeeMaster: CONFIG.execUseFeeMaster,
    timeoutMs:    180_000,
  });
  log('ORDER', `✅ execute_limit_order submitted for ${orderId.slice(0,20)}`);
  pendingOrderStore.delete(orderId);
}

function calcExpectedPayout(auth, execPrice) {
  const PRICE_PRECISION = 100_000_000_000n;
  const rawPnl = auth.isLong
    ? (execPrice - auth.entryPrice) * auth.size / PRICE_PRECISION
    : (auth.entryPrice - execPrice) * auth.size / PRICE_PRECISION;
  const payout = auth.collateral + rawPnl;
  return payout > 0n ? payout : 0n;
}

function generateNonce() {
  const bytes = new Uint8Array(31);
  for (let i = 0; i < 31; i++) bytes[i] = Math.floor(Math.random() * 256);
  let nonce = 0n;
  for (const b of bytes) nonce = (nonce << 8n) | BigInt(b);
  return nonce.toString() + 'field';
}

let _orchestratorAddress = null;
async function getOrchestratorAddress() {
  if (_orchestratorAddress) return _orchestratorAddress;
  try {
    const raw = await getMapping('roles', '1u8');
    _orchestratorAddress = raw.replace(/"/g, '').trim();
    return _orchestratorAddress;
  } catch { return ''; }
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  ZKPerp Liquidation + Order Bot v14                        ║');
  console.log('║  Oracle: zkperp_oracle_v2.aleo (2-of-3 Chainlink quorum)  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  log('BOT', `Program:         ${CONFIG.programId}`);
  log('BOT', `Asset:           ${CONFIG.assetId}`);
  log('BOT', `Oracle program:  ${CONFIG.oracleProgramId}`);
  log('BOT', `Network:         ${CONFIG.network}`);
  log('BOT', `Exec:            Provable DPS (fee master: ${CONFIG.execUseFeeMaster})`);
  log('BOT', `Scan interval:   ${CONFIG.scanIntervalMs / 1000}s`);
  log('BOT', `API port:        ${CONFIG.apiPort}`);
  console.log('');

  if (!CONFIG.privateKey || CONFIG.privateKey.includes('...')) {
    logError('BOT', 'Missing PRIVATE_KEY in .env'); process.exit(1);
  }

  startApiServer();

  if (CONFIG.viewKey && CONFIG.consumerId && CONFIG.apiKey) {
    const scannerOk = await initScanner();
    if (!scannerOk) {
      log('BOT', 'Provable Scanner unavailable — will use API fallbacks');
    } else {
      await recoverPendingOrders();
    }
  } else {
    log('BOT', 'No Provable credentials — using API fallbacks for scanning');
  }

  log('BOT', 'Initial liquidation scan...');
  await liquidationTick();

  setInterval(liquidationTick, CONFIG.scanIntervalMs);
  setInterval(() => {
    cleanupExpiredPositions();
    logMemoryUsage('periodic');
  }, POSITION_CLEANUP_INTERVAL_MS);

  log('BOT', '✅ Running. Ctrl+C to stop.');
}

main().catch(err => {
  logError('BOT', `Fatal: ${err.message}`);
  process.exit(1);
});
