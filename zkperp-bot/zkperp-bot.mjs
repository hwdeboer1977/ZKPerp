#!/usr/bin/env node

/**
 * ZKPerp Oracle + Liquidation Bot v8
 * ====================================
 * 
 * 1. Fetches BTC/USD price from Binance every 30s → updates on-chain oracle
 * 2. Uses Provable Record Scanner to find LiquidationAuth records
 * 3. Calculates margin ratios and liquidates underwater positions
 * 4. Exposes HTTP API so the frontend can fetch positions without wallet prompts
 * 
 * API endpoints:
 *   GET /api/liq-auths          - All known open LiquidationAuth positions
 *   GET /api/liq-auths/:posId   - Single position by ID
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
import { execSync } from 'child_process';
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
  programId: process.env.PROGRAM_ID || 'zkperp_v9.aleo',
  network: process.env.NETWORK || 'testnet',
  networkId: process.env.NETWORK_ID || '1',

  // Endpoints
  apiEndpoint: process.env.API_ENDPOINT || 'https://api.explorer.provable.com/v1/testnet',
  queryEndpoint: process.env.QUERY_ENDPOINT || 'https://api.explorer.provable.com/v1',
  broadcastEndpoint: process.env.BROADCAST_ENDPOINT || 'https://api.explorer.provable.com/v1/testnet/transaction/broadcast',

  // Intervals
  priceIntervalMs: parseInt(process.env.PRICE_INTERVAL || '30000'),
  scanIntervalMs: parseInt(process.env.SCAN_INTERVAL || '60000'),

  // HTTP API
  apiPort: parseInt(process.env.API_PORT || '3001'),
  frontendOrigin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',

  // Contract constants
  liquidationThresholdBps: 10000n,  // 1%
  liquidationRewardBps: 5000n,      // 0.5%
};

// ═══════════════════════════════════════════════════════════════
// STATE: In-memory position store
// positionStore: Map<positionId, PositionEntry>
// ═══════════════════════════════════════════════════════════════

const positionStore = new Map();
let lastScanAt = null;
let currentOraclePrice = 0n;
let botStartedAt = new Date().toISOString();

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

async function getMapping(mapping, key) {
  return fetchText(`${CONFIG.apiEndpoint}/program/${CONFIG.programId}/mapping/${mapping}/${key}`);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ═══════════════════════════════════════════════════════════════
// HTTP API SERVER
// ═══════════════════════════════════════════════════════════════

function calcLiquidation(pos, price) {
  if (!price || price === 0n) return { pnl: 0n, marginRatio: 100, isLiquidatable: false, reward: 0n };
  const priceDiff = price > pos.entryPrice ? price - pos.entryPrice : pos.entryPrice - price;
  const pnlAbs = (pos.size * priceDiff) / (pos.entryPrice + 1n);
  const traderProfits = (pos.isLong && price > pos.entryPrice) || (!pos.isLong && price < pos.entryPrice);
  const pnl = traderProfits ? pnlAbs : -pnlAbs;
  const remainingMargin = pos.collateral + pnl;
  const marginRatio = Number(remainingMargin * 100n * 10000n / (pos.size + 1n)) / 10000;
  const isLiquidatable = marginRatio < 1;
  const reward = (pos.size * CONFIG.liquidationRewardBps) / 1_000_000n;
  return { pnl, marginRatio, isLiquidatable, reward };
}

function serializePosition(pos) {
  const calc = calcLiquidation(pos, currentOraclePrice);
  return {
    positionId: pos.positionId,
    trader: pos.trader,
    isLong: pos.isLong,
    sizeUsdc: pos.size.toString(),
    collateralUsdc: pos.collateral.toString(),
    entryPrice: pos.entryPrice.toString(),
    currentPrice: currentOraclePrice.toString(),
    pnl: calc.pnl.toString(),
    marginRatio: calc.marginRatio,
    isLiquidatable: calc.isLiquidatable,
    reward: calc.reward.toString(),
    scannedAt: pos.scannedAt,
  };
}

function startApiServer() {
  const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', CONFIG.frontendOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://localhost:${CONFIG.apiPort}`);

    // POST /api/bot/pause
    if (req.method === 'POST' && url.pathname === '/api/bot/pause') {
      botPaused = true;
      log('API', '⏸ Bot paused via API');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ paused: true }));
      return;
    }

    // POST /api/bot/resume
    if (req.method === 'POST' && url.pathname === '/api/bot/resume') {
      botPaused = false;
      log('API', '▶️ Bot resumed via API');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ paused: false }));
      return;
    }

    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }

    // GET /health
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        paused: botPaused,
        programId: CONFIG.programId,
        positionCount: positionStore.size,
        lastScanAt,
        currentPrice: currentOraclePrice.toString(),
        upSince: botStartedAt,
      }));
      return;
    }

    // GET /api/liq-auths
    if (url.pathname === '/api/liq-auths') {
      const positions = Array.from(positionStore.values()).map(serializePosition);
      // Sort: liquidatable first, then by margin ratio ascending
      positions.sort((a, b) => {
        if (a.isLiquidatable && !b.isLiquidatable) return -1;
        if (!a.isLiquidatable && b.isLiquidatable) return 1;
        return a.marginRatio - b.marginRatio;
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ positions, lastScanAt, currentPrice: currentOraclePrice.toString() }));
      return;
    }

    // GET /api/liq-auths/:posId
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

async function fetchBtcPrice() {
  try {
    const data = await fetchJson('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
    if (data?.price) { log('ORACLE', `Binance BTC: $${parseFloat(data.price).toLocaleString()}`); return parseFloat(data.price); }
  } catch (err) { log('ORACLE', `Binance failed: ${err.message}, trying CoinGecko...`); }
  try {
    const data = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
    if (data?.bitcoin?.usd) { log('ORACLE', `CoinGecko BTC: $${data.bitcoin.usd.toLocaleString()}`); return data.bitcoin.usd; }
  } catch (err) { logError('ORACLE', `All sources failed: ${err.message}`); }
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
  const timestamp = Math.floor(Date.now() / 1000);

  if (currentOraclePrice !== 0n) {
    const diff = currentOraclePrice > priceOnChain ? currentOraclePrice - priceOnChain : priceOnChain - currentOraclePrice;
    const pctChange = Number(diff * 10000n / (currentOraclePrice + 1n)) / 100;
    if (pctChange < 1.0) { log('ORACLE', `Price change ${pctChange.toFixed(2)}% < 1%, skipping on-chain update`); currentOraclePrice = priceOnChain; return true; }
  }

  log('ORACLE', `Updating to $${priceUsd.toLocaleString()} (${priceOnChain}u64)`);
  try {
    const cmd = [
      'snarkos developer execute',
      `--private-key ${CONFIG.privateKey}`,
      `--query ${CONFIG.queryEndpoint}`,
      `--broadcast ${CONFIG.broadcastEndpoint}`,
      `--network ${CONFIG.networkId}`,
      CONFIG.programId, 'update_price',
      '0field', `${priceOnChain}u64`, `${timestamp}u32`,
    ].join(' ');
    execSync(cmd, { timeout: 120000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    currentOraclePrice = priceOnChain;
    log('ORACLE', `✅ Price updated to $${priceUsd.toLocaleString()}`);
    return true;
  } catch (err) {
    logError('ORACLE', `update_price failed: ${err.stderr?.substring(0, 200) || err.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// SCANNER
// ═══════════════════════════════════════════════════════════════

let provableClient = null;
let scannerRegistered = false;

async function initScanner() {
  if (!CONFIG.consumerId || !CONFIG.apiKey || !CONFIG.viewKey) {
    logError('SCAN', 'Missing PROVABLE_CONSUMER_ID, PROVABLE_API_KEY, or VIEW_KEY');
    return false;
  }
  provableClient = new ProvableClient(CONFIG.consumerId, CONFIG.apiKey, CONFIG.network);
  try {
    log('SCAN', 'Registering view key with Provable scanner...');
    const startBlock = parseInt(process.env.SCANNER_START_BLOCK || '14864000');
    const reg = await provableClient.registerViewKey(CONFIG.viewKey, startBlock);
    log('SCAN', `✅ Registered. UUID: ${reg.uuid} (from block ${startBlock})`);
    const status = await provableClient.getStatus();
    log('SCAN', `Scanner status: ${status.synced ? 'synced' : `syncing (${status.percentage}%)`}`);
    scannerRegistered = true;
    return true;
  } catch (err) {
    logError('SCAN', `Scanner registration failed: ${err.message}`);
    return false;
  }
}

async function scanPositions() {
  if (scannerRegistered && provableClient) {
    const results = await scanViaProvableScanner();
    if (results.length > 0) return results;
  }
  log('SCAN', 'Trying Leo RPC fallback...');
  return await scanViaLeoRpc();
}

async function scanViaProvableScanner() {
  log('SCAN', 'Fetching records from Provable Scanner...');
  try {
    const allRecords = await provableClient.getOwnedRecords({ decrypt: true, unspent: true });
    const allList = Array.isArray(allRecords) ? allRecords : (allRecords?.records || []);
    const programRecords = allList.filter(r => r.program_name === CONFIG.programId);
    log('SCAN', `Provable Scanner: ${programRecords.length} ${CONFIG.programId} records`);

    const positions = [];
    for (const record of programRecords) {
      if (record.record_name !== 'LiquidationAuth') continue;
      let ptStr = '';
      if (record.record_ciphertext) {
        try {
          const cmd = `snarkos developer decrypt --view-key ${CONFIG.viewKey} --ciphertext ${record.record_ciphertext}`;
          ptStr = execSync(cmd, { timeout: 10000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        } catch { logError('SCAN', `Decrypt failed for block ${record.block_height}`); continue; }
      }
      if (!ptStr) continue;
      const pos = parsePositionFromPlaintext(ptStr);
      if (!pos) continue;
      try {
        const closedRaw = await getMapping('closed_positions', pos.positionId);
        if (closedRaw && closedRaw.includes('true')) continue;
      } catch {}
      positions.push(pos);
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
// PARSERS
// ═══════════════════════════════════════════════════════════════

function parsePositionFromPlaintext(plaintext) {
  try {
    const posIdMatch = plaintext.match(/position_id:\s*(\d+field)(?:\.private)?/);
    const traderMatch = plaintext.match(/trader:\s*(aleo1[a-z0-9]+)(?:\.private)?/);
    const isLongMatch = plaintext.match(/is_long:\s*(true|false)(?:\.private)?/);
    const sizeMatch = plaintext.match(/size_usdc:\s*(\d+)u64(?:\.private)?/);
    const collateralMatch = plaintext.match(/collateral_usdc:\s*(\d+)u(?:64|128)(?:\.private)?/);
    const entryPriceMatch = plaintext.match(/entry_price:\s*(\d+)u64(?:\.private)?/);
    if (!posIdMatch || !sizeMatch || !entryPriceMatch) return null;
    const sizeUsdc = BigInt(sizeMatch[1]);
    if (sizeUsdc < 10000n) return null;
    return {
      positionId: posIdMatch[1],
      trader: traderMatch?.[1] || 'unknown',
      isLong: isLongMatch?.[1] === 'true',
      size: sizeUsdc,
      collateral: BigInt(collateralMatch?.[1] || '0'),
      entryPrice: BigInt(entryPriceMatch?.[1] || '0'),
      scannedAt: new Date().toISOString(),
    };
  } catch { return null; }
}

function parsePositionFromTransition(transition) {
  try {
    const futureOutput = (transition.outputs || []).find(o => o.type === 'future');
    if (!futureOutput?.value) return null;
    const futureStr = String(futureOutput.value);
    const innerBlockEnd = futureStr.indexOf('},');
    if (innerBlockEnd === -1) return null;
    const afterBlock = futureStr.substring(innerBlockEnd + 2);
    const posIdMatch = afterBlock.match(/(\d{30,})field/);
    if (!posIdMatch) return null;
    const positionId = posIdMatch[0];
    const traderMatch = afterBlock.match(/(aleo1[a-z0-9]+)/);
    const u64Matches = afterBlock.match(/(\d+)u64/g) || [];
    const u64Values = u64Matches.map(m => BigInt(m.replace('u64', '')));
    if (u64Values.length < 3) return null;
    return {
      positionId,
      trader: traderMatch?.[1] || 'unknown',
      isLong: !afterBlock.includes('\n    false') && !afterBlock.match(/,\s*false\s*,/),
      size: u64Values[1],
      collateral: u64Values.length >= 6 ? u64Values[5] : u64Values[0],
      entryPrice: u64Values[2],
      scannedAt: new Date().toISOString(),
    };
  } catch { return null; }
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
// LIQUIDATION
// ═══════════════════════════════════════════════════════════════

function calculateMarginRatio(position, price) {
  const { isLong, size, collateral, entryPrice } = position;
  const priceDiff = price > entryPrice ? price - entryPrice : entryPrice - price;
  const pnlAbs = (size * priceDiff) / (entryPrice + 1n);
  const traderProfits = (isLong && price > entryPrice) || (!isLong && price < entryPrice);
  const pnl = traderProfits ? pnlAbs : -pnlAbs;
  const remainingMargin = collateral + pnl;
  const marginRatioBps = (remainingMargin * 1_000_000n) / (size + 1n);
  return {
    pnl, marginRatioBps,
    marginPercent: Number(marginRatioBps) / 10000,
    isLiquidatable: marginRatioBps < CONFIG.liquidationThresholdBps,
  };
}

async function liquidatePosition(position) {
  const { positionId, isLong, size, collateral, entryPrice, trader } = position;
  let reward = (size * CONFIG.liquidationRewardBps) / 1_000_000n;
  if (reward < 1n) reward = 1n;
  log('LIQUIDATE', `Liquidating ${positionId.slice(0, 20)}...`);
  try {
    const cmd = [
      'snarkos developer execute',
      `--private-key ${CONFIG.privateKey}`,
      `--query ${CONFIG.queryEndpoint}`,
      `--broadcast ${CONFIG.broadcastEndpoint}`,
      `--network ${CONFIG.networkId}`,
      CONFIG.programId, 'liquidate',
      `"${positionId}"`,
      `${isLong}`,
      `${size}u64`,
      `${collateral}u64`,
      `${entryPrice}u64`,
      `${reward}u128`,
      `${trader}`,
    ].join(' ');
    execSync(cmd, { timeout: 180000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    log('LIQUIDATE', `✅ Liquidated! Reward: $${(Number(reward) / 1_000_000).toFixed(4)}`);
    // Remove from store after successful liquidation
    positionStore.delete(positionId);
    return true;
  } catch (err) {
    logError('LIQUIDATE', `Failed: ${err.stderr?.substring(0, 200) || err.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN TICKS
// ═══════════════════════════════════════════════════════════════

let isProcessing = false;
let botPaused = false;

async function oracleTick() {
  if (botPaused) { log('ORACLE', 'Bot paused, skipping oracle update'); return; }
  try {
    const btcPrice = await fetchBtcPrice();
    if (btcPrice) await updateOraclePrice(btcPrice);
  } catch (err) {
    logError('ORACLE', `Tick error: ${err.message}`);
  }
}

async function liquidationTick() {
  if (botPaused) { log('SCAN', 'Bot paused, skipping liquidation scan'); return; }
  if (isProcessing) return;
  isProcessing = true;

  try {
    // Refresh oracle price from chain
    const onChainPrice = await getCurrentOraclePriceFromChain();
    if (onChainPrice) currentOraclePrice = onChainPrice;
    if (!currentOraclePrice) { log('SCAN', 'No oracle price, skipping'); return; }

    const positions = await scanPositions();
    lastScanAt = new Date().toISOString();

    // Upsert all found positions into the store
    for (const pos of positions) {
      positionStore.set(pos.positionId, pos);
    }

    if (positions.length === 0) { log('SCAN', 'No open positions'); return; }

    // Check margins and liquidate if needed
    for (const pos of positions) {
      const m = calculateMarginRatio(pos, currentOraclePrice);
      const entryUsd = (Number(pos.entryPrice) / 1e8).toLocaleString();
      const status = m.isLiquidatable ? '⚠️ LIQUIDATABLE' : '✓ Healthy';
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
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     ZKPerp Oracle + Liquidation Bot v8 (+ API Server)      ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  log('BOT', `Program: ${CONFIG.programId}`);
  log('BOT', `Network: ${CONFIG.network}`);
  log('BOT', `Oracle interval: ${CONFIG.priceIntervalMs / 1000}s`);
  log('BOT', `Scan interval: ${CONFIG.scanIntervalMs / 1000}s`);
  log('BOT', `API port: ${CONFIG.apiPort}`);
  console.log('');

  if (!CONFIG.privateKey || CONFIG.privateKey.includes('...')) {
    logError('BOT', 'Missing PRIVATE_KEY in .env'); process.exit(1);
  }

  // Start HTTP API server immediately (serves empty store until first scan)
  startApiServer();

  // Init Provable scanner
  if (CONFIG.viewKey && CONFIG.consumerId && CONFIG.apiKey) {
    const scannerOk = await initScanner();
    if (!scannerOk) log('BOT', 'Provable Scanner unavailable — will use API fallbacks');
  } else {
    log('BOT', 'No Provable credentials — using API fallbacks for scanning');
  }

  log('BOT', 'Initial oracle update...');
  await oracleTick();

  log('BOT', 'Initial liquidation scan...');
  await liquidationTick();

  setInterval(oracleTick, CONFIG.priceIntervalMs);
  setInterval(liquidationTick, CONFIG.scanIntervalMs);

  log('BOT', '✅ Running. Ctrl+C to stop.');
}

main().catch(err => {
  logError('BOT', `Fatal: ${err.message}`);
  process.exit(1);
});
