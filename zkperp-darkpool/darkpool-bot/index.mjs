// ============================================================
// index.mjs — ZK Darkpool Operator Bot v5
// ============================================================
// No DB. Bot scans chain for OrderAuth + DepositAuth records,
// builds order book from on-chain data, prints settle commands.
// ============================================================

import 'dotenv/config'
import { createServer } from 'http'
import { BATCH_BLOCKS, POLL_MS, OPERATOR_ADDRESS, PROGRAM_ID, START_BLOCK, PORT } from './config.mjs'
import { getBlockHeight, getFeeVault } from './api.mjs'
import { scanNewOrders, setStartBlock } from './scanner.mjs'
import { addOrder, addDepositAuth, getDepositAuth, consumeDepositAuth, getAllDepositAuths, loadDepositAuths, matchAll, pruneOrders, getOrderCount, getAllAssets } from './orderbook.mjs'
import { settleMatch } from './settler.mjs'
import { refreshUSDCxRecords } from './usdcx-scanner.mjs'

let lastBatchBlock = 0
let totalMatches   = 0
let totalSettled   = 0
let isSettling     = false

// ── Status display ─────────────────────────────────────────
async function printStatus(block) {
  const feeVault   = await getFeeVault().catch(() => 0n)
  const assets     = getAllAssets()
  const blocksLeft = lastBatchBlock > 0
    ? Math.max(0, lastBatchBlock + BATCH_BLOCKS - block)
    : BATCH_BLOCKS

  console.log(`\n${'─'.repeat(40)}`)
  console.log(` ZK Darkpool Operator Bot v5`)
  console.log(` Program:  ${PROGRAM_ID}`)
  console.log(` Operator: ${OPERATOR_ADDRESS.slice(0,20)}...`)
  console.log(`${'─'.repeat(40)}`)
  console.log(` Block:         #${block}`)
  console.log(` Next batch in: ~${blocksLeft} blocks`)
  console.log(` Fee vault:     ${(Number(feeVault)/1e6).toFixed(4)} USDCx`)
  console.log(` Total matched: ${totalMatches}`)
  console.log(` Total settled: ${totalSettled}`)
  if (assets.length) {
    console.log(` Order book:`)
    const symbols = { 0:'BTC', 1:'ETH', 2:'SOL' }
    for (const id of assets) {
      const { buys, sells } = getOrderCount(id)
      console.log(`   ${symbols[id] ?? `asset_${id}`}: ${buys} buys / ${sells} sells`)
    }
  } else {
    console.log(` Order book:    empty`)
  }
  console.log(`${'─'.repeat(40)}\n`)
}

// ── Run matching ───────────────────────────────────────────
async function runMatching(block) {
  if (isSettling) { console.log('[bot] Settlement in progress — skipping'); return }
  await pruneOrders(block)
  const matches = matchAll()
  if (!matches.length) { console.log('[bot] No matches this batch.'); return }
  totalMatches += matches.length
  console.log(`[bot] ${matches.length} match(es) found.`)
  isSettling = true
  try {
    for (const match of matches) {
      const result = await settleMatch(match)
      if (result?.status === 'confirmed') {
        totalSettled++
        console.log(`[bot] ✓ Settlement confirmed. Total: ${totalSettled}`)
        // Consume the DepositAuth so it can't be reused
        if (match.depositNonce) {
          consumeDepositAuth(match.sellOrder.user, match.sellOrder.assetId, match.depositNonce)
        }
        // Refresh USDCx for next settlement
        await refreshUSDCxRecords().catch(e => console.warn('[bot] USDCx refresh failed:', e.message))
      }
    }
  } finally {
    isSettling = false
  }
}

// ── Main tick ──────────────────────────────────────────────
async function tick() {
  try {
    const block = await getBlockHeight()
    if (!block) { console.warn('[bot] Cannot fetch block height'); return }

    const newOrders = await scanNewOrders()
    for (const order of newOrders) {
      if (order.isDepositAuth) {
        // DepositAuth — store by user+asset, matched at settle time
        addDepositAuth('', order.plaintext, order.blockHeight ?? 0)
      } else {
        // OrderAuth / OperatorOrderRef — add to order book
        order.limitPrice = order.limitPrice ?? (order.direction ? 999_999_999n : 1n)
        order.size       = order.size       ?? 1_000_000n
        addOrder(order)
      }
    }

    if (lastBatchBlock === 0) lastBatchBlock = block
    if (block >= lastBatchBlock + BATCH_BLOCKS) {
      console.log(`[bot] Batch window closed at #${block}. Running matcher...`)
      await runMatching(block)
      lastBatchBlock = block
    }

    await printStatus(block)
  } catch (err) {
    console.error('[bot] Tick error:', err.message)
  }
}

// ── HTTP API ──────────────────────────────────────────────
function startHttpServer() {
  createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin',  '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return }

    // GET /status
    if (req.method === 'GET' && req.url === '/status') {
      const assets = getAllAssets()
      const book   = {}
      for (const id of assets) book[id] = getOrderCount(id)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ block: await getBlockHeight(), book, totalMatches, totalSettled }))
      return
    }

    // GET /deposits — returns DepositAuth nonces known to the bot
    if (req.method === 'GET' && req.url?.startsWith('/deposits')) {
      const url     = new URL(req.url, 'http://localhost')
      const address = url.searchParams.get('address') ?? ''
      const all = getAllDepositAuths()
      const filtered = address ? all.filter(d => d.user === address) : all
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ deposits: filtered }))
      return
    }
    if (req.method === 'POST' && req.url === '/force-match') {
      console.log('[bot] Force match triggered via API')
      const block = await getBlockHeight()
      await runMatching(block ?? 0)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, totalMatches, totalSettled }))
      return
    }

    res.writeHead(404); res.end()
  }).listen(PORT, () => {
    console.log(`[bot] HTTP API on http://localhost:${PORT}`)
    console.log(`[bot]   GET  /status`)
    console.log(`[bot]   POST /force-match`)
  })
}

// ── Startup ───────────────────────────────────────────────
async function main() {
  console.log('🔒 ZK Darkpool Operator Bot v5')
  console.log(`   Program:  ${PROGRAM_ID}`)
  console.log(`   Operator: ${OPERATOR_ADDRESS}`)
  console.log(`   Poll:     every ${POLL_MS/1000}s`)
  console.log(`   Batch:    every ~${BATCH_BLOCKS} blocks`)
  console.log()

  const currentBlock = await getBlockHeight()
  const scanFrom = START_BLOCK > 0 ? START_BLOCK : Math.max(0, currentBlock - 500)
  setStartBlock(scanFrom)
  lastBatchBlock = currentBlock

  loadDepositAuths()
  console.log(`[bot] Current block: #${currentBlock}`)
  console.log(`[bot] Scanning from: #${scanFrom}`)

  startHttpServer()

  // Scan USDCx records on startup — populate token + credentials in records.json
  refreshUSDCxRecords().catch(e => console.warn('[usdcx] Startup scan failed:', e.message))

  await tick()
  setInterval(tick, POLL_MS)
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
