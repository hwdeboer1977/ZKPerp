#!/usr/bin/env node

/**
 * ZKPerp Oracle + Liquidation Bot v7
 * ====================================
 * 
 * 1. Fetches BTC/USD price from Binance every 30s → updates on-chain oracle
 * 2. Uses Provable Record Scanner to find LiquidationAuth records
 * 3. Calculates margin ratios and liquidates underwater positions
 * 
 * Environment variables (see .env.example):
 *   PRIVATE_KEY            - Orchestrator/admin private key
 *   VIEW_KEY               - Orchestrator view key (for record scanning)
 *   PROVABLE_CONSUMER_ID   - Provable API consumer ID
 *   PROVABLE_API_KEY       - Provable API key
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
  programId: process.env.PROGRAM_ID || 'zkperp_v7.aleo',
  network: process.env.NETWORK || 'testnet',
  networkId: process.env.NETWORK_ID || '1',
  
  // Endpoints
  apiEndpoint: process.env.API_ENDPOINT || 'https://api.explorer.provable.com/v1/testnet',
  queryEndpoint: process.env.QUERY_ENDPOINT || 'https://api.explorer.provable.com/v1',
  broadcastEndpoint: process.env.BROADCAST_ENDPOINT || 'https://api.explorer.provable.com/v1/testnet/transaction/broadcast',
  
  // Intervals
  priceIntervalMs: parseInt(process.env.PRICE_INTERVAL || '30000'),
  scanIntervalMs: parseInt(process.env.SCAN_INTERVAL || '60000'),
  
  // Contract constants
  liquidationThresholdBps: 10000n,  // 1%
  liquidationRewardBps: 5000n,      // 0.5%
};

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
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON')); }
      });
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════
// ORACLE: Fetch BTC price and update on-chain
// ═══════════════════════════════════════════════════════════════

async function fetchBtcPrice() {
  try {
    const data = await fetchJson('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
    if (data?.price) {
      const price = parseFloat(data.price);
      log('ORACLE', `Binance BTC: $${price.toLocaleString()}`);
      return price;
    }
  } catch (err) {
    log('ORACLE', `Binance failed: ${err.message}, trying CoinGecko...`);
  }
  
  try {
    const data = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
    if (data?.bitcoin?.usd) {
      log('ORACLE', `CoinGecko BTC: $${data.bitcoin.usd.toLocaleString()}`);
      return data.bitcoin.usd;
    }
  } catch (err) {
    logError('ORACLE', `All sources failed: ${err.message}`);
  }
  return null;
}

async function getCurrentOraclePrice() {
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
  
  const currentPrice = await getCurrentOraclePrice();
  if (currentPrice !== null) {
    const diff = currentPrice > priceOnChain ? currentPrice - priceOnChain : priceOnChain - currentPrice;
    const pctChange = Number(diff * 10000n / (currentPrice + 1n)) / 100;
    if (pctChange < 0.1) {
      log('ORACLE', `Price stable ($${priceUsd.toLocaleString()}, ${pctChange.toFixed(2)}% change), skipping`);
      return true;
    }
  }
  
  log('ORACLE', `Updating to $${priceUsd.toLocaleString()} (${priceOnChain}u64)`);
  
  try {
    const cmd = [
      'snarkos developer execute',
      `--private-key ${CONFIG.privateKey}`,
      `--query ${CONFIG.queryEndpoint}`,
      `--broadcast ${CONFIG.broadcastEndpoint}`,
      `--network ${CONFIG.networkId}`,
      CONFIG.programId,
      'update_price',
      '0field',
      `${priceOnChain}u64`,
      `${timestamp}u32`,
    ].join(' ');
    
    execSync(cmd, { timeout: 120000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    log('ORACLE', `✅ Price updated to $${priceUsd.toLocaleString()}`);
    return true;
  } catch (err) {
    logError('ORACLE', `update_price failed: ${err.stderr?.substring(0, 200) || err.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// SCANNER: Use Provable Record Scanner for LiquidationAuth
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
  if (!scannerRegistered || !provableClient) {
    log('SCAN', 'Scanner not registered, skipping');
    return [];
  }
  
  log('SCAN', 'Fetching records from Provable...');
  
  try {
    // First: fetch ALL records (no program filter) to see what exists
    const allRecords = await provableClient.getOwnedRecords({
      decrypt: true,
      unspent: true,
    });
    
    const allList = Array.isArray(allRecords) ? allRecords : (allRecords?.records || []);
    log('SCAN', `Total records (all programs): ${allList.length}`);
    
    // Debug: show what we got
    for (const rec of allList.slice(0, 10)) {
      console.log(`  [DEBUG] program: ${rec.program_name}, record: ${rec.record_name}, function: ${rec.function_name}, block: ${rec.block_height}`);
      if (rec.plaintext) {
        console.log(`  [DEBUG] plaintext: ${String(rec.plaintext).substring(0, 150)}...`);
      } else if (rec.data) {
        console.log(`  [DEBUG] data: ${JSON.stringify(rec.data).substring(0, 150)}...`);
      }
    }
    
    // Now filter for our program
    const programRecords = allList.filter(r => 
      r.program_name === CONFIG.programId || 
      r.program_name?.includes('zkperp')
    );
    log('SCAN', `Records for ${CONFIG.programId}: ${programRecords.length}`);
    
    const positions = [];
    
    for (const record of programRecords) {
      console.log(`  [DEBUG] Processing: record_name=${record.record_name}, has trader: ${String(record.plaintext || '').includes('trader:')}`);
      
      // Process LiquidationAuth records (check both record_name and plaintext content)
      const plaintext = record.plaintext || record.data || JSON.stringify(record);
      const ptStr = String(plaintext);
      
      const isLiqAuth = record.record_name === 'LiquidationAuth' || ptStr.includes('trader:');
      if (!isLiqAuth) continue;
      
      const posIdMatch = plaintext.match(/position_id:\s*(\d+field)(?:\.private)?/);
      const traderMatch = plaintext.match(/trader:\s*(aleo1[a-z0-9]+)(?:\.private)?/);
      const isLongMatch = plaintext.match(/is_long:\s*(true|false)(?:\.private)?/);
      const sizeMatch = plaintext.match(/size_usdc:\s*(\d+)u64(?:\.private)?/);
      const collateralMatch = plaintext.match(/collateral_usdc:\s*(\d+)u(?:64|128)(?:\.private)?/);
      const entryPriceMatch = plaintext.match(/entry_price:\s*(\d+)u64(?:\.private)?/);
      
      if (!posIdMatch || !sizeMatch || !entryPriceMatch) continue;
      
      const positionId = posIdMatch[1];
      const sizeUsdc = BigInt(sizeMatch[1]);
      if (sizeUsdc < 10000n) continue; // Skip dust
      
      // Check if closed on-chain
      try {
        const closedRaw = await getMapping('closed_positions', positionId);
        if (closedRaw && closedRaw.includes('true')) continue;
      } catch {}
      
      positions.push({
        positionId,
        trader: traderMatch?.[1] || 'unknown',
        isLong: isLongMatch?.[1] === 'true',
        size: sizeUsdc,
        collateral: BigInt(collateralMatch?.[1] || '0'),
        entryPrice: BigInt(entryPriceMatch?.[1] || '0'),
      });
    }
    
    log('SCAN', `Found ${positions.length} open LiquidationAuth position(s)`);
    return positions;
  } catch (err) {
    logError('SCAN', `Scan failed: ${err.message}`);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// LIQUIDATION: Check margins and liquidate
// ═══════════════════════════════════════════════════════════════

function calculateMarginRatio(position, currentPrice) {
  const { isLong, size, collateral, entryPrice } = position;
  const priceDiff = currentPrice > entryPrice ? currentPrice - entryPrice : entryPrice - currentPrice;
  const pnlAbs = (size * priceDiff) / (entryPrice + 1n);
  const traderProfits = (isLong && currentPrice > entryPrice) || (!isLong && currentPrice < entryPrice);
  const pnl = traderProfits ? pnlAbs : -pnlAbs;
  const remainingMargin = collateral + pnl;
  const marginRatioBps = (remainingMargin * 1_000_000n) / (size + 1n);
  
  return {
    pnl,
    marginRatioBps,
    marginPercent: Number(marginRatioBps) / 10000,
    isLiquidatable: marginRatioBps < CONFIG.liquidationThresholdBps,
  };
}

async function liquidatePosition(position) {
  const { positionId, isLong, size, collateral, entryPrice, trader } = position;
  
  let reward = (size * CONFIG.liquidationRewardBps) / 1_000_000n;
  if (reward < 1n) reward = 1n;
  
  log('LIQUIDATE', `Liquidating ${positionId.slice(0, 20)}...`);
  log('LIQUIDATE', `  Size: $${(Number(size) / 1_000_000).toFixed(2)} | Reward: $${(Number(reward) / 1_000_000).toFixed(4)} | Trader: ${trader.slice(0, 20)}...`);
  
  try {
    const cmd = [
      'snarkos developer execute',
      `--private-key ${CONFIG.privateKey}`,
      `--query ${CONFIG.queryEndpoint}`,
      `--broadcast ${CONFIG.broadcastEndpoint}`,
      `--network ${CONFIG.networkId}`,
      CONFIG.programId,
      'liquidate',
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
    return true;
  } catch (err) {
    logError('LIQUIDATE', `Failed: ${err.stderr?.substring(0, 200) || err.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════════════════════════

let isProcessing = false;

async function oracleTick() {
  try {
    const btcPrice = await fetchBtcPrice();
    //if (btcPrice) await updateOraclePrice(btcPrice);
  } catch (err) {
    logError('ORACLE', `Tick error: ${err.message}`);
  }
}

async function liquidationTick() {
  if (isProcessing) return;
  isProcessing = true;
  
  try {
    const currentPrice = await getCurrentOraclePrice();
    if (!currentPrice) { log('SCAN', 'No oracle price, skipping'); return; }
    
    // Pool state
    try {
      const raw = await getMapping('pool_state', '0field');
      if (raw && raw !== 'null') {
        const liq = raw.match(/total_liquidity:\s*(\d+)u64/);
        const longOi = raw.match(/long_open_interest:\s*(\d+)u64/);
        const shortOi = raw.match(/short_open_interest:\s*(\d+)u64/);
        log('SCAN', `Pool: $${(Number(liq?.[1] || 0) / 1e6).toFixed(2)} liq | Long: $${(Number(longOi?.[1] || 0) / 1e6).toFixed(2)} | Short: $${(Number(shortOi?.[1] || 0) / 1e6).toFixed(2)}`);
      }
    } catch {}
    
    // Scan positions via Provable Scanner
    const positions = await scanPositions();
    if (positions.length === 0) { log('SCAN', 'No open positions'); return; }
    
    const priceUsd = (Number(currentPrice) / 1e8).toLocaleString();
    
    for (const pos of positions) {
      const m = calculateMarginRatio(pos, currentPrice);
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

async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     ZKPerp Oracle + Liquidation Bot v7 (Provable Scanner)  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  log('BOT', `Program: ${CONFIG.programId}`);
  log('BOT', `Network: ${CONFIG.network}`);
  log('BOT', `Oracle interval: ${CONFIG.priceIntervalMs / 1000}s`);
  log('BOT', `Scan interval: ${CONFIG.scanIntervalMs / 1000}s`);
  console.log('');
  
  // Validate
  if (!CONFIG.privateKey || CONFIG.privateKey.includes('...')) {
    logError('BOT', 'Missing PRIVATE_KEY in .env'); process.exit(1);
  }
  if (!CONFIG.viewKey) {
    logError('BOT', 'Missing VIEW_KEY in .env'); process.exit(1);
  }
  if (!CONFIG.consumerId || !CONFIG.apiKey) {
    logError('BOT', 'Missing PROVABLE_CONSUMER_ID or PROVABLE_API_KEY in .env'); process.exit(1);
  }
  
  // Initialize Provable scanner
  const scannerOk = await initScanner();
  if (!scannerOk) {
    logError('BOT', 'Scanner init failed — liquidation monitoring disabled');
  }
  
  // Initial oracle update
  log('BOT', 'Initial oracle update...');
  await oracleTick();
  
  // Initial scan
  if (scannerOk) {
    log('BOT', 'Initial liquidation scan...');
    await liquidationTick();
  }
  
  // Scheduled loops
  setInterval(oracleTick, CONFIG.priceIntervalMs);
  if (scannerOk) {
    setInterval(liquidationTick, CONFIG.scanIntervalMs);
  }
  
  log('BOT', '✅ Running. Ctrl+C to stop.');
}

main().catch(err => {
  logError('BOT', `Fatal: ${err.message}`);
  process.exit(1);
});
