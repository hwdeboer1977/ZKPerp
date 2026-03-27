#!/usr/bin/env node

/**
 * ZKPerp Oracle + Liquidation + Order Execution Bot v13
 * ====================================
 *
 * All transaction proving is delegated to Provable's TEE-backed Delegated Proving Service
 * simply skips and retries on the next interval.
 *  • Oracle and liquidation ticks are fully decoupled — a slow liquidation no longer
 *    delays the next oracle update.
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
  viewKey: process.env.VIEW_KEY || '',

  // Provable API
  consumerId: process.env.PROVABLE_CONSUMER_ID || '',
  apiKey: process.env.PROVABLE_API_KEY || '',

  // Program
  programId: process.env.PROGRAM_ID || 'zkperp_btc_v21.aleo',
  network: process.env.NETWORK || 'testnet',
  networkId: process.env.NETWORK_ID || '1',

  // Multi-asset program IDs (one Aleo program per market)
  programs: {
    BTC_USD: process.env.PROGRAM_ID_BTC || '_btc_v21.aleo',
    ETH_USD: process.env.PROGRAM_ID_ETH || 'zkperp_eth_v21.aleo',
    SOL_USD: process.env.PROGRAM_ID_SOL || 'zkperp_sol_v21.aleo',
  },

  // Oracle endpoint auth token (must match ZKPERP_ORCHESTRATOR_TOKEN in aleo-oracle .env)
  oracleToken: process.env.ORACLE_TOKEN || '',

  // Endpoints
  apiEndpoint:       process.env.API_ENDPOINT       || 'https://api.explorer.provable.com/v1/testnet',
  queryEndpoint:     process.env.QUERY_ENDPOINT     || 'https://api.explorer.provable.com/v1',
  broadcastEndpoint: process.env.BROADCAST_ENDPOINT || 'https://api.explorer.provable.com/v1/testnet/transaction/broadcast',

  // Intervals
  priceIntervalMs: parseInt(process.env.PRICE_INTERVAL || '30000'),
  scanIntervalMs:  parseInt(process.env.SCAN_INTERVAL  || '60000'),

  // HTTP API
  apiPort:        parseInt(process.env.API_PORT || '3001'),
  frontendOrigin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',

  // Set EXEC_USE_FEE_MASTER=true if your Provable account has a fee master —
  // the DPS prover will then pay the transaction fee on your behalf.
  execUseFeeMaster: process.env.EXEC_USE_FEE_MASTER === 'true',

  // Set DISABLE_ORACLE=true to skip Binance price pushes but still run order execution
  // Useful for testing TP/SL with a manually seeded oracle price
  disableOracle: process.env.DISABLE_ORACLE === 'true',

  // Contract constants
  liquidationThresholdBps: 10000n,  // 1%
  liquidationRewardBps:    5000n,   // 0.5%
};

// All known program IDs — scanner matches records from any market
const ALL_PROGRAM_IDS = new Set(Object.values(CONFIG.programs));
ALL_PROGRAM_IDS.add(CONFIG.programId); // also include legacy PROGRAM_ID

// ═══════════════════════════════════════════════════════════════
// STATE: In-memory position store
// ═══════════════════════════════════════════════════════════════

const positionStore = new Map();
// (slotPlaintextStore removed for TP/SL — trader now keeps PositionSlot, orchestrator uses ExecTPSLAuth)
// Still used for limit orders: frontend registers reserved PositionSlot via POST /api/register-slot
const slotPlaintextStore = new Map();

// Pending orders store: orderId => { orderId, orderType, isLong, triggerPrice,
//   size, collateral, entryPrice, positionId, slotId, plaintext, scannedAt }
const pendingOrderStore = new Map();
// ExecTPSLAuth store: orderId => { orderId, orderType, trader, triggerPrice, ... plaintext, scannedAt }
// Orchestrator scans these to execute TP/SL when price triggers — no PositionSlot needed.
const execTPSLAuthStore = new Map();

// ExecLimitAuth store: orderId => { orderId, trader, isLong, triggerPrice, size, collateral, slotId, nonce, plaintext, scannedAt }
// Orchestrator scans these to execute limit orders when price triggers.
const execLimitAuthStore = new Map();
let lastScanAt          = null;
let currentOraclePrice  = 0n;
let botStartedAt        = new Date().toISOString();
let botPaused           = false;

// ── Quorum oracle price store ───────────────────────────────────
// Populated by POST /oracle/update from aleo-oracle coordinator.
// assetId => { price: BigInt, updatedAt: number, roundId: string, receivedAt: number }
const quorumPrices = new Map();

// Oracle tick guard — prevents a stalled Provable Execute from queueing duplicate updates
let oracleInFlight = false;
// Liquidation tick guard (unchanged semantics from v8)
let isProcessing   = false;

// ── Memory management ───────────────────────────────────────────
const MAX_POSITION_STORE_SIZE       = Number(process.env.MAX_POSITION_STORE_SIZE || 2000);
const POSITION_TTL_MS               = Number(process.env.POSITION_TTL_MS         || 30 * 60 * 1000);
const POSITION_CLEANUP_INTERVAL_MS  = Number(process.env.POSITION_CLEANUP_INTERVAL_MS || 5 * 60 * 1000);

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

    // register-slot: used for LIMIT ORDERS only — frontend registers the reserved
    // PositionSlot so the bot can execute execute_limit_order when price hits.
    // TP/SL no longer use this — trader keeps their slot, bot uses ExecTPSLAuth.
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
          // Keyed by nonce for limit orders (bot finds slot via PendingOrder.nonce)
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

    // cancel-order endpoint removed — trader now cancels TP/SL directly on-chain
    // via cancel_tp_sl(slot, receipt) using their own wallet. No bot involvement needed.


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

    // ── POST /oracle/update ────────────────────────────────────────────────────
    // Called by aleo-oracle coordinator when 2-of-3 relayers reach quorum.
    // Body: { assetId, price, updatedAt, roundId, sourceChainId, feedAddress, quorum[] }
    if (req.method === 'POST' && url.pathname === '/oracle/update') {
      const auth = req.headers['authorization'] || '';
      if (CONFIG.oracleToken && auth !== `Bearer ${CONFIG.oracleToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { assetId, price, updatedAt, roundId } = JSON.parse(body);
          if (!assetId || !price || !updatedAt || !roundId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing fields: assetId, price, updatedAt, roundId' }));
            return;
          }
          if (!CONFIG.programs[assetId]) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Unknown assetId: ${assetId}` }));
            return;
          }
          quorumPrices.set(assetId, {
            price:      BigInt(price),
            updatedAt:  Number(updatedAt),
            roundId:    String(roundId),
            receivedAt: Date.now(),
          });
          log('ORACLE', `Quorum price received: ${assetId} @ ${(Number(BigInt(price)) / 1e8).toFixed(2)} (round ${roundId})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status:        'ok',
        paused:        botPaused,
        programId:     CONFIG.programId,
        positionCount: positionStore.size,
        oracleInFlight,
        isProcessing,
        lastScanAt,
        currentPrice:  currentOraclePrice.toString(),
        netUnrealisedPnl: computeNetPnl(currentOraclePrice).toString(),
        pendingOrderCount: pendingOrderStore.size,
        execTPSLAuthCount: execTPSLAuthStore.size,
        execLimitAuthCount: execLimitAuthStore.size,
        upSince:       botStartedAt,
      }));
      return;
    }

    // Look up order_id by nonce — frontend calls this after place_tp/sl to get orderId
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
// ORACLE
// ═══════════════════════════════════════════════════════════════

// ── Multi-asset oracle update (Chainlink quorum) ──────────────────────────────

async function updateOraclePriceForAsset(assetId, priceOnChain, timestamp) {
  const programId = CONFIG.programs[assetId];
  if (!programId) { logError('ORACLE', `No programId configured for ${assetId}`); return false; }

  try {
    const raw = await fetchText(`${CONFIG.apiEndpoint}/program/${programId}/mapping/oracle_prices/0field`);
    if (raw && raw !== 'null') {
      const match = raw.match(/price:\s*(\d+)u64/);
      if (match) {
        const onChainPrice = BigInt(match[1]);
        const diff = onChainPrice > priceOnChain ? onChainPrice - priceOnChain : priceOnChain - onChainPrice;
        const pctChange = Number(diff * 10000n / (onChainPrice + 1n)) / 100;
        if (pctChange < 1.0) {
          log('ORACLE', `${assetId} change ${pctChange.toFixed(2)}% < 1% — skipping`);
          if (assetId === 'BTC_USD') currentOraclePrice = priceOnChain;
          return true;
        }
        log('ORACLE', `${assetId} change ${pctChange.toFixed(2)}% — updating`);
      }
    }
  } catch { /* first update, no existing price */ }

  log('ORACLE', `Updating ${assetId} on ${programId} → ${priceOnChain}u64`);
  try {
    await provableClient.executeTransaction({
      privateKey:    CONFIG.privateKey,
      programId,
      functionName:  'update_price',
      inputs:        ['0field', `${priceOnChain}u64`, `${timestamp}u32`],
      useFeeMaster:  CONFIG.execUseFeeMaster,
      timeoutMs:     120_000,
    });
    log('ORACLE', `✅ ${assetId} updated on ${programId} ($${(Number(priceOnChain) / 1e8).toLocaleString()})`);
    if (assetId === 'BTC_USD') currentOraclePrice = priceOnChain;
    return true;
  } catch (err) {
    logError('ORACLE', `${assetId} update_price failed: ${err.message}`);
    return false;
  }
}

async function fetchBtcPrice() {
  try {
    const data = await fetchJson('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
    if (data?.price) { log('ORACLE', `Binance BTC: $${parseFloat(data.price).toLocaleString()}`); return parseFloat(data.price); }
  } catch (err) { log('ORACLE', `Binance failed: ${err.message}, trying CoinGecko...`); }
  try {
    const data = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
    if (data?.bitcoin?.usd) { log('ORACLE', `CoinGecko BTC: $${data.bitcoin.usd.toLocaleString()}`); return data.bitcoin.usd; }
  } catch (err) { logError('ORACLE', `All price sources failed: ${err.message}`); }
  return null;
}

async function getCurrentOraclePriceFromChain() {
  try {
    const raw = await getMapping('oracle_prices', '0field');
    if (!raw || raw === 'null') return null;
    const match = raw.match(/price:\s*(\d+)u64/);
    return match ? BigInt(match[1]) : null;
  } catch { return null; }
}

async function updateOraclePrice(priceUsd) {
  const priceOnChain = BigInt(Math.round(priceUsd * 100_000_000));
  const timestamp    = Math.floor(Date.now() / 1000);
  return updateOraclePriceForAsset('BTC_USD', priceOnChain, timestamp);
}

// Compute net unrealised PnL across all positions in positionStore.
// Uses BigInt arithmetic consistent with calculateMarginRatio.
// Returns signed BigInt in same u64 units as size/collateral (6-decimal USDC).
// Positive = traders net profitable (pool liability).
// Negative = traders net losing    (pool asset).
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

// Submit net PnL to the on-chain net_unrealized_pnl mapping.
// Called after every successful oracle price update.
// Non-fatal if it fails — contract defaults to 0i64 (conservative full-OI lock).
async function submitNetPnl(price) {
  const netPnl   = computeNetPnl(price);
  const posCount = positionStore.size;
  log('PNL', `Net unrealised PnL: ${netPnl >= 0n ? '+' : ''}${netPnl} (${posCount} position(s))`);

  // No positions — skip the transaction, mapping stays at last submitted value
  // (or 0i64 default). No point paying tx fees for a no-op.
  if (posCount === 0) {
    log('PNL', 'No open positions, skipping update_net_pnl');
    return;
  }

  // Serialise: Leo i64 wants e.g. "123i64" or "-123i64".
  // Use .toString() explicitly — avoids any BigInt quirks in template literals.
  const pnlInput = `${netPnl.toString()}i64`;
  log('PNL', `Submitting update_net_pnl input: ${pnlInput}`);

  try {
    await provableClient.executeTransaction({
      privateKey:   CONFIG.privateKey,
      programId:    CONFIG.programId,
      functionName: 'update_net_pnl',
      inputs:       [pnlInput],
      useFeeMaster: CONFIG.execUseFeeMaster,
      timeoutMs:    120_000,
    });
    log('PNL', `✅ update_net_pnl submitted (${pnlInput})`);
  } catch (err) {
    // Log full error — err may be a string, Error, or object depending on Provable client
    const msg = err?.message ?? (typeof err === 'string' ? err : JSON.stringify(err));
    logError('PNL', `update_net_pnl failed: ${msg}`);
  }
}


// Submit pool state to on-chain pool_state mapping.
// Called after every liquidation scan so Long/Short OI reflects reality.
// Computes OI from positionStore, reads current liquidity from chain.
async function submitPoolState(programId) {
  if (!provableClient) return;
  const pid = programId || CONFIG.programId;

  try {
    // Read current pool state from chain
    const raw = await fetchText(`${CONFIG.apiEndpoint}/program/${pid}/mapping/pool_state/0field`);
    if (!raw || raw === 'null') { log('POOL', `No pool_state on ${pid} — skipping`); return; }

    const liqMatch   = raw.match(/total_liquidity:\s*(\d+)u64/);
    const lpMatch    = raw.match(/total_lp_tokens:\s*(\d+)u64/);
    const feesMatch  = raw.match(/accumulated_fees:\s*(\d+)u64/);
    if (!liqMatch) { log('POOL', 'Could not parse pool_state'); return; }

    const totalLiquidity = BigInt(liqMatch[1]);
    const totalLpTokens  = BigInt(lpMatch?.[1] || '0');
    const accFees        = BigInt(feesMatch?.[1] || '0');

    // Compute OI from in-memory position store (keyed by positionId)
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

const SCANNER_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000]; // backoff sequence

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
  // If scanner isn't registered yet (e.g. startup registration failed and retry
  // is still pending), skip the Provable path silently — the retry timer will
  // re-register and subsequent scans will use it.
  if (scannerRegistered && provableClient) {
    const results = await scanViaProvableScanner();
    if (results.length > 0) return results;
    // Scanner returned 0 results — could be genuinely empty or all records
    // lacked plaintext. Either way, do NOT fall through to Leo RPC; that path
    // has no access to private LiquidationAuth records anyway.
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
    // Map record → programId for use in liquidation execution
    const liqProgramMap = new Map(liquidationRecords.map(r => [r, r.program_name || CONFIG.programId]));
    log('SCAN', `Provable Scanner: ${liquidationRecords.length} LiquidationAuth records (cap=${MAX_RECORDS_PER_SCAN})`);

    // Scan ExecTPSLAuth records — orchestrator uses these to execute TP/SL (no PositionSlot needed)
    const authRecords = allList
      .filter(r => ALL_PROGRAM_IDS.has(r.program_name) && r.record_name === 'ExecTPSLAuth')
      .slice(0, MAX_RECORDS_PER_SCAN);
    log('SCAN', `Provable Scanner: ${authRecords.length} ExecTPSLAuth records`);

    // Process ExecTPSLAuth records
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

      // Verify order still active on-chain
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

    // Scan ExecLimitAuth records — orchestrator executes limit orders when price triggers
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

    // Also scan PendingOrder records (limit orders only)
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
      if (!order || order.orderType !== 0) continue; // limit orders only

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

    const programRecords = liquidationRecords;

    const positions = [];
    for (const record of programRecords) {
      // Prefer pre-decrypted plaintext provided by Provable scanner
      let ptStr = record.record_plaintext || record.plaintext || '';

      // record_plaintext can be absent when the Provable scanner hasn't finished
      // indexing that block yet. Fall back to in-process SDK decrypt (WASM,
      // milliseconds, no subprocess) so we never miss a liquidatable position.
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
      await sleep(50); // yield to event loop between records
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

// Called once at startup after scanner is registered.
// Re-populates execTPSLAuthStore and pendingOrderStore from on-chain records.
//
// New architecture: trader keeps PositionSlot, orchestrator gets ExecTPSLAuth.
// On restart, scan ExecTPSLAuth records (mirrors LiquidationAuth scan).
// Limit order PendingOrders also recovered.
//
// Recovery map:
//   ExecTPSLAuth → execTPSLAuthStore  (keyed by orderId)
//   PendingOrder → pendingOrderStore  (limit orders only, keyed by orderId)
async function recoverPendingOrders() {
  if (!scannerRegistered || !provableClient) {
    log('RECOVER', 'Scanner not ready — recovery skipped');
    return;
  }
  log('RECOVER', 'Scanning for ExecTPSLAuth + PendingOrder records owned by orchestrator...');
  try {
    const allRecords = await provableClient.getOwnedRecords({ decrypt: true, unspent: true });
    const allList = Array.isArray(allRecords) ? allRecords : (allRecords?.records || []);

    const authRecords       = allList.filter(r => ALL_PROGRAM_IDS.has(r.program_name) && r.record_name === 'ExecTPSLAuth');
    const limitAuthRecords  = allList.filter(r => ALL_PROGRAM_IDS.has(r.program_name) && r.record_name === 'ExecLimitAuth');
    const orderRecords      = allList.filter(r => ALL_PROGRAM_IDS.has(r.program_name) && r.record_name === 'PendingOrder');

    log('RECOVER', `Found ${authRecords.length} ExecTPSLAuth + ${limitAuthRecords.length} ExecLimitAuth + ${orderRecords.length} PendingOrder record(s)`);

    // ── Step 1: Recover ExecTPSLAuth records (TP/SL execution) ──
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

    // ── Step 2: Recover PendingOrder records (limit orders only) ──
    let recoveredOrders = 0;
    for (const record of orderRecords) {
      let ptStr = record.record_plaintext || record.plaintext || '';
      if (!ptStr && record.record_ciphertext) {
        try { ptStr = await provableClient.decryptRecord(record.record_ciphertext, CONFIG.viewKey); }
        catch (e) { logError('RECOVER', `PendingOrder decrypt failed: ${e.message}`); continue; }
      }
      if (!ptStr) continue;

      const order = parsePendingOrderFromPlaintext(ptStr);
      if (!order || order.orderType !== 0) continue; // limit orders only

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

    log('RECOVER', `Recovery complete — ${recoveredAuths} ExecTPSLAuth(s), ${recoveredOrders} limit order(s) restored`);

    // ── Step 3: Recover ExecLimitAuth records ──
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
    const slotIdMatch2  = plaintext.match(/slot_id:\s*(\d+)u8(?:\.private)?/);
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
    const futureStr    = String(futureOutput.value);
    const innerBlockEnd = futureStr.indexOf('},');
    if (innerBlockEnd === -1) return null;
    const afterBlock   = futureStr.substring(innerBlockEnd + 2);
    const posIdMatch   = afterBlock.match(/(\d{30,})field/);
    if (!posIdMatch) return null;
    const positionId   = posIdMatch[0];
    const traderMatch  = afterBlock.match(/(aleo1[a-z0-9]+)/);
    const u64Matches   = afterBlock.match(/(\d+)u64/g) || [];
    const u64Values    = u64Matches.map(m => BigInt(m.replace('u64', '')));
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
// MAIN TICKS
// ═══════════════════════════════════════════════════════════════

async function oracleTick() {
  if (botPaused)      { log('ORACLE', 'Bot paused, skipping oracle update'); return; }
  if (oracleInFlight) { log('ORACLE', 'Previous oracle update still in flight, skipping'); return; }
  oracleInFlight = true;
  try {
    if (CONFIG.disableOracle) {
      const onChainPrice = await getCurrentOraclePriceFromChain();
      const priceChanged = onChainPrice && onChainPrice !== currentOraclePrice;
      if (onChainPrice) currentOraclePrice = onChainPrice;
      log('ORACLE', `Oracle disabled — chain price: $${(Number(currentOraclePrice)/1e8).toLocaleString()}`);
      if (priceChanged && provableClient && positionStore.size > 0) await submitNetPnl(currentOraclePrice);
      if (provableClient) await executePendingOrders(currentOraclePrice);
      return;
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const QUORUM_MAX_AGE_MS = 5 * 60 * 1000; // reject quorum prices older than 5 min

    // ── Try Chainlink quorum prices first (all assets) ────────────────────────
    const quorumAssets = [...quorumPrices.entries()]
      .filter(([, q]) => Date.now() - q.receivedAt < QUORUM_MAX_AGE_MS);

    if (quorumAssets.length > 0) {
      log('ORACLE', `Processing ${quorumAssets.length} quorum price(s) from Chainlink relay`);
      let btcUpdated = false;
      for (const [assetId, q] of quorumAssets) {
        if (!provableClient) {
          log('ORACLE', `${assetId} quorum received but Provable not ready — queued`);
          continue;
        }
        const updated = await updateOraclePriceForAsset(assetId, q.price, timestamp);
        if (updated && assetId === 'BTC_USD') btcUpdated = true;
        if (updated) await sleep(3000); // wait 3s between Provable tx submissions
      }
            if (btcUpdated && provableClient && positionStore.size > 0) await submitNetPnl(currentOraclePrice);
      if (provableClient) await executePendingOrders(currentOraclePrice);
      return;
    }

    // ── Fallback: Binance/CoinGecko for BTC only ──────────────────────────────
    log('ORACLE', 'No fresh quorum prices — falling back to Binance for BTC');
    const btcPrice = await fetchBtcPrice();
    if (btcPrice) {
      const updated = await updateOraclePrice(btcPrice);
      if (updated && provableClient && positionStore.size > 0) await submitNetPnl(currentOraclePrice);
      if (updated && provableClient) await executePendingOrders(currentOraclePrice);
    }
  } catch (err) {
    logError('ORACLE', `Tick error: ${err.message}`);
  } finally {
    oracleInFlight = false;
  }
}

async function liquidationTick() {
  if (botPaused)    { log('SCAN', 'Bot paused, skipping liquidation scan'); return; }
  if (isProcessing) return;
  isProcessing = true;

  try {
    const onChainPrice = await getCurrentOraclePriceFromChain();
    if (onChainPrice) currentOraclePrice = onChainPrice;
    if (!currentOraclePrice) { log('SCAN', 'No oracle price, skipping'); return; }

    const positions = await scanPositions();
    lastScanAt = new Date().toISOString();

    for (const pos of positions) {
      upsertPosition({
        positionId:    pos.positionId,
        trader:        pos.trader,
        isLong:        pos.isLong,
        size:          pos.size,
        collateral:    pos.collateral,
        entryPrice:    pos.entryPrice,
        slotNonce:     pos.slotNonce,      // needed for TP/SL slot reconstruction
        slotId:        pos.slotId,
        programId:     pos.programId || CONFIG.programId,  // which market this position belongs to
        scannedAt:     pos.scannedAt || new Date().toISOString(),
      });
    }

    cleanupExpiredPositions();
    emergencyTrimPositionStore();
    logMemoryUsage('after-scan');

    if (positions.length === 0) { log('SCAN', 'No open positions'); return; }

    // Update on-chain pool state with current OI from scanned positions
    if (provableClient) await submitPoolState(CONFIG.programId);

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

function parseExecTPSLAuthFromPlaintext(plaintext) {
  try {
    const orderIdMatch    = plaintext.match(/order_id:\s*(\d+field)(?:\.private)?/);
    const orderTypeMatch  = plaintext.match(/order_type:\s*(\d+)u8(?:\.private)?/);
    const traderMatch     = plaintext.match(/trader:\s*(aleo1[a-z0-9]+)(?:\.private)?/);
    const slotIdMatch     = plaintext.match(/slot_id:\s*(\d+)u8(?:\.private)?/);
    const posIdMatch      = plaintext.match(/position_id:\s*(\d+field)(?:\.private)?/);
    const isLongMatch     = plaintext.match(/is_long:\s*(true|false)(?:\.private)?/);
    const triggerMatch    = plaintext.match(/trigger_price:\s*(\d+)u64(?:\.private)?/);
    const sizeMatch       = plaintext.match(/size_usdc:\s*(\d+)u64(?:\.private)?/);
    const collMatch       = plaintext.match(/collateral_usdc:\s*(\d+)u64(?:\.private)?/);
    const entryMatch      = plaintext.match(/entry_price:\s*(\d+)u64(?:\.private)?/);
    const nonceMatch      = plaintext.match(/nonce:\s*(\d+field)(?:\.private)?/);

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
    const orderIdMatch   = plaintext.match(/order_id:\s*(\d+field)(?:\.private)?/);
    const traderMatch    = plaintext.match(/trader:\s*(aleo1[a-z0-9]+)(?:\.private)?/);
    const slotIdMatch    = plaintext.match(/slot_id:\s*(\d+)u8(?:\.private)?/);
    const isLongMatch    = plaintext.match(/is_long:\s*(true|false)(?:\.private)?/);
    const triggerMatch   = plaintext.match(/trigger_price:\s*(\d+)u64(?:\.private)?/);
    const sizeMatch      = plaintext.match(/size_usdc:\s*(\d+)u64(?:\.private)?/);
    const collMatch      = plaintext.match(/collateral_usdc:\s*(\d+)u64(?:\.private)?/);
    const nonceMatch     = plaintext.match(/nonce:\s*(\d+field)(?:\.private)?/);

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
      // orderType 0 = limit (for isOrderTriggered compatibility)
      orderType:    0,
    };
  } catch { return null; }
}

function parsePendingOrderFromPlaintext(plaintext) {
  try {
    const orderIdMatch    = plaintext.match(/order_id:\s*(\d+field)(?:\.private)?/);
    const orderTypeMatch  = plaintext.match(/order_type:\s*(\d+)u8(?:\.private)?/);
    const isLongMatch     = plaintext.match(/is_long:\s*(true|false)(?:\.private)?/);
    const triggerMatch    = plaintext.match(/trigger_price:\s*(\d+)u64(?:\.private)?/);
    const sizeMatch       = plaintext.match(/size_usdc:\s*(\d+)u64(?:\.private)?/);
    const collMatch       = plaintext.match(/collateral_usdc:\s*(\d+)u64(?:\.private)?/);
    const entryMatch      = plaintext.match(/entry_price:\s*(\d+)u64(?:\.private)?/);
    const posIdMatch      = plaintext.match(/position_id:\s*(\d+field)(?:\.private)?/);
    const slotIdMatch     = plaintext.match(/slot_id:\s*(\d+)u8(?:\.private)?/);

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

// Check if an order's trigger condition is met at the given price
function isOrderTriggered(order, price) {
  if (!price || price === 0n) return false;
  const { orderType, isLong, triggerPrice } = order;
  if (orderType === 0) {
    // Limit order: long triggers when price <= trigger, short when price >= trigger
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

// Calculate expected payout for TP/SL at given price
function calcExpectedPayout(order, execPrice) {
  const { size, collateral, entryPrice, isLong } = order;
  const safeEntry = entryPrice + 1n;
  const higher = execPrice > entryPrice ? execPrice : entryPrice;
  const lower  = execPrice > entryPrice ? entryPrice : execPrice;
  const priceDiff = higher - lower;
  const pnlAbs = (size * priceDiff) / safeEntry;
  const traderProfits = (isLong && execPrice > entryPrice) || (!isLong && execPrice < entryPrice);

  let maxPayout;
  if (traderProfits) {
    maxPayout = collateral + pnlAbs;
  } else {
    maxPayout = collateral > pnlAbs ? collateral - pnlAbs : 0n;
  }
  // 5% safety buffer (generous — TP/SL can have slippage)
  return (maxPayout * 95n) / 100n;
}

// Execute all triggered pending orders
async function executePendingOrders(price) {
  if (!provableClient) return;

  // Execute triggered TP/SL using ExecTPSLAuth records
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

  // Execute triggered limit orders using ExecLimitAuth records
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

  // Legacy: execute limit orders via PendingOrder records (old pattern, kept for backward compat)
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

// Execute a limit order using ExecLimitAuth — no PositionSlot needed
async function executeExecLimitAuth(auth, price) {
  const { orderId, isLong, triggerPrice, trader, slotId } = auth;
  log('ORDER', `Executing LIMIT auth ${orderId.slice(0,20)} | trigger: $${(Number(triggerPrice)/1e8).toFixed(0)} | price: $${(Number(price)/1e8).toFixed(0)} | trader: ${trader.slice(0,20)}`);

  const executionNonce = generateNonce();
  const orchestratorAddress = CONFIG.orchestratorAddress || await getOrchestratorAddress();

  await provableClient.executeTransaction({
    privateKey:   CONFIG.privateKey,
    programId:    CONFIG.programId,
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

// Execute a TP or SL using ExecTPSLAuth — no PositionSlot needed
async function executeTPSLAuth(auth, price) {
  const { orderId, orderType, triggerPrice, positionId, trader } = auth;
  const typeStr = orderType === 1 ? 'take_profit' : 'stop_loss';
  log('ORDER', `Executing ${typeStr} auth ${orderId.slice(0,20)} | trigger: $${(Number(triggerPrice)/1e8).toFixed(0)} | price: $${(Number(price)/1e8).toFixed(0)} | trader: ${trader.slice(0,20)}`);

  const executionNonce = generateNonce();
  const execPrice = orderType === 2 ? price : triggerPrice; // SL = market, TP = trigger price
  const expectedPayout = calcExpectedPayout(auth, execPrice);

  const functionName = orderType === 1 ? 'execute_take_profit' : 'execute_stop_loss';
  const tpslProgramId = auth.programId || CONFIG.programId;
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

// Execute a limit order using PendingOrder + registered PositionSlot
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
    programId:    CONFIG.programId,
    functionName: 'execute_limit_order',
    inputs:       [order.plaintext, registered.slotPlaintext, CONFIG.orchestratorAddress || await getOrchestratorAddress(), executionNonce],
    useFeeMaster: CONFIG.execUseFeeMaster,
    timeoutMs:    180_000,
  });
  log('ORDER', `✅ execute_limit_order submitted for ${orderId.slice(0,20)}`);
  pendingOrderStore.delete(orderId);
}

// Nonce generator (mirrors frontend)
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
  console.log('║  ZKPerp Oracle + Liquidation + Order Bot v13 (+ API Server) ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  log('BOT', `Program:        ${CONFIG.programId}`);
  log('BOT', `Network:        ${CONFIG.network}`);
  log('BOT', `Exec:           Provable DPS (fee master: ${CONFIG.execUseFeeMaster})`);
  log('BOT', `Oracle interval: ${CONFIG.priceIntervalMs / 1000}s`);
  log('BOT', `Scan interval:   ${CONFIG.scanIntervalMs / 1000}s`);
  log('BOT', `API port:        ${CONFIG.apiPort}`);
  log('BOT', `Max store size: ${MAX_POSITION_STORE_SIZE} | TTL: ${POSITION_TTL_MS/60000}min | Max records/scan: ${MAX_RECORDS_PER_SCAN}`);
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
      // Recover PendingOrders + PositionSlots owned by orchestrator after restart.
      // The orchestrator holds both record types when a SL/TP is placed —
      // so full cancel/execute capability is restored from chain state alone.
      await recoverPendingOrders();
    }
  } else {
    log('BOT', 'No Provable credentials — using API fallbacks for scanning');
  }

  log('BOT', 'Initial oracle update...');
  await oracleTick();

  log('BOT', 'Initial liquidation scan...');
  await liquidationTick();

  setInterval(oracleTick, CONFIG.priceIntervalMs);
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
