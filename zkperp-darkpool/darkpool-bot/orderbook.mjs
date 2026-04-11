// ============================================================
// orderbook.mjs
// In-memory order book. Groups orders by asset_id + direction.
// Implements uniform clearing price matching algorithm.
// ============================================================

import { isOrderConsumed } from './api.mjs'
import { MIN_FILL_SIZE } from './config.mjs'
import { writeFileSync, readFileSync, existsSync } from 'fs'

const DEPOSIT_AUTHS_FILE = './deposit-auths.json'

function saveDepositAuths() {
  try {
    writeFileSync(DEPOSIT_AUTHS_FILE, JSON.stringify(depositAuths, null, 2))
  } catch (e) {
    console.warn('[orderbook] Failed to save deposit-auths.json:', e.message)
  }
}

export function loadDepositAuths() {
  try {
    if (!existsSync(DEPOSIT_AUTHS_FILE)) return
    const data = JSON.parse(readFileSync(DEPOSIT_AUTHS_FILE, 'utf8'))
    for (const [key, entries] of Object.entries(data)) {
      depositAuths[key] = entries
    }
    const total = Object.values(depositAuths).reduce((n, arr) => n + arr.length, 0)
    console.log(`[orderbook] Loaded ${total} DepositAuth(s) from disk`)
  } catch (e) {
    console.warn('[orderbook] Failed to load deposit-auths.json:', e.message)
  }
}

// orders[assetId][direction] = array of order objects
// direction: true = buy, false = sell
const orders = {}

// depositAuths[user:assetId] = array of DepositAuth entries
// Matched to sell orders by user + asset_id — no nonce linkage needed
const depositAuths = {}

// ── Store a DepositAuth ────────────────────────────────────────
export function addDepositAuth(nonce, plaintext, blockHeight = 0) {
  // Parse user and asset_id from plaintext
  const getField = (name) => {
    for (const line of plaintext.split(/[,\n]/)) {
      const t = line.trim()
      if (t.startsWith(name + ':')) return t.slice(name.length + 1).trim()
    }
    return null
  }
  const user    = getField('user')?.replace('.private','').trim()
  const assetId = getField('asset_id')?.replace('u8','').replace('.private','').trim()
  if (!user || assetId == null) {
    console.log(`[orderbook] DepositAuth parse failed — missing user or asset_id`)
    return false
  }
  const key = `${user}:${assetId}`
  if (!depositAuths[key]) depositAuths[key] = []
  // Avoid duplicates by nonce
  if (depositAuths[key].some(e => e.nonce === nonce)) return false
  depositAuths[key].push({ nonce, plaintext, blockHeight })
  saveDepositAuths()
  console.log(`[orderbook] DepositAuth stored user=${user.slice(0,16)}... asset=${assetId} amount=${getField('amount')?.replace('u64','').replace('.private','').trim()} block=#${blockHeight}`)
  return true
}

// Get first available DepositAuth for a user+asset combination
export function getDepositAuth(user, assetId) {
  const key = `${user}:${assetId}`
  const entries = depositAuths[key]
  if (!entries || entries.length === 0) return null
  return entries[0].plaintext
}

// Remove a specific DepositAuth after settlement
export function consumeDepositAuth(user, assetId, nonce) {
  const key = `${user}:${assetId}`
  if (!depositAuths[key]) return
  depositAuths[key] = depositAuths[key].filter(e => e.nonce !== nonce)
  saveDepositAuths()
  console.log(`[orderbook] DepositAuth consumed user=${user.slice(0,16)}... asset=${assetId}`)
}

// ── Add an order (from scanner) ────────────────────────────────
export function addOrder(order) {
  const { assetId, direction, nonce } = order
  if (!orders[assetId]) orders[assetId] = { true: [], false: [] }

  const key = String(direction)
  const existing = orders[assetId][key].find(o => o.nonce === nonce)
  if (existing) {
    // Update price/size if new record has real values (OrderAuth > OperatorOrderRef)
    if (order.limitPrice && order.limitPrice !== 999_999_999n && order.limitPrice !== 1n) {
      existing.limitPrice = order.limitPrice
      existing.size       = order.size ?? existing.size
      existing.plaintext  = order.plaintext ?? existing.plaintext
      console.log(`[orderbook] Updated ${direction ? 'BUY' : 'SELL'} nonce=${nonce.slice(0,8)}... price=${order.limitPrice}`)
    }
    return false
  }

  orders[assetId][key].push(order)
  console.log(`[orderbook] Added ${direction ? 'BUY' : 'SELL'} asset=${assetId} nonce=${nonce.slice(0,8)}... price=${order.limitPrice} total_buys=${orders[assetId].true.length} total_sells=${orders[assetId].false.length}`)
  return true
}

// ── Remove expired or consumed orders ─────────────────────────
export async function pruneOrders(currentBlock) {
  for (const assetId of Object.keys(orders)) {
    for (const direction of [true, false]) {
      const key = String(direction)
      const before = orders[assetId][key].length
      // Remove expired — skip if expiry is 0 (unknown/not yet scanned from chain)
      orders[assetId][key] = orders[assetId][key].filter(
        o => o.expiry === 0 || o.expiry + 100 >= currentBlock
      )
      // Remove consumed (check on-chain)
      const consumed = await Promise.all(
        orders[assetId][key].map(async o => ({
          nonce: o.nonce,
          consumed: await isOrderConsumed(o.nonce)
        }))
      )
      const consumedNonces = new Set(consumed.filter(c => c.consumed).map(c => c.nonce))
      orders[assetId][key] = orders[assetId][key].filter(o => !consumedNonces.has(o.nonce))
      // Remove sells with no DepositAuth — keyed by user:assetId
      if (direction === false) {
        console.log(`[debug] depositAuths keys:`, Object.keys(depositAuths))
        const before2 = orders[assetId][key].length
        orders[assetId][key] = orders[assetId][key].filter(o => {
          const depKey = `${o.user}:${assetId}`
          const has = !!(depositAuths[depKey]?.length)
          if (!has) console.log(`[orderbook] Pruning SELL nonce=${o.nonce.slice(0,16)}... — no DepositAuth for ${depKey}`)
          return has
        })
        const after2 = orders[assetId][key].length
        if (before2 !== after2) {
          console.log(`[orderbook] Pruned ${before2 - after2} sell(s) with no DepositAuth asset=${assetId}`)
        }
      }
    }
  }
}

// ── Compute uniform clearing price ────────────────────────────
// Classic call auction: find price P that maximises matchable volume.
// Buys with limit >= P, sells with limit <= P.
// Returns { price, matchedVolume } or null if no match.
function computeClearingPrice(buys, sells) {
  if (!buys.length || !sells.length) return null

  // Collect all candidate prices (all limit prices from both sides)
  const candidates = new Set([
    ...buys.map(b => b.limitPrice),
    ...sells.map(s => s.limitPrice),
  ])

  let bestPrice  = 0n
  let bestVolume = 0n

  for (const P of candidates) {
    // Buyers willing at this price: limit >= P
    const eligibleBuys  = buys.filter(b => b.limitPrice >= P)
    // Sellers willing at this price: limit <= P
    const eligibleSells = sells.filter(s => s.limitPrice <= P)

    const buyVol  = eligibleBuys.reduce((sum, b) => sum + b.size, 0n)
    const sellVol = eligibleSells.reduce((sum, s) => sum + s.size, 0n)
    const volume  = buyVol < sellVol ? buyVol : sellVol

    if (volume > bestVolume || (volume === bestVolume && P > bestPrice)) {
      bestVolume = volume
      bestPrice  = P
    }
  }

  if (bestVolume < MIN_FILL_SIZE) return null
  return { price: bestPrice, volume: bestVolume }
}

// ── Run matching for one asset ─────────────────────────────────
// Returns array of match objects: { buyOrder, sellOrder, clearingPrice, fillSize, type }
// type: 'full' | 'partial'
export function matchAsset(assetId) {
  if (!orders[assetId]) return []
  const buys  = [...orders[assetId].true]

  // Only match sells that have a valid DepositAuth in memory (matched by user+asset)
  const sells = [...orders[assetId].false].filter(s => {
    const depKey = `${s.user}:${assetId}`
    const hasAuth = !!(depositAuths[depKey]?.length)
    if (!hasAuth) console.log(`[orderbook] Skipping SELL nonce=${s.nonce.slice(0,8)}... — no DepositAuth for user+asset`)
    return hasAuth
  })

  const result = computeClearingPrice(buys, sells)
  if (!result) return []

  const { price } = result
  const matches = []

  // Sort buys descending by limit (highest first), sells ascending
  const eligibleBuys  = buys.filter(b => b.limitPrice >= price)
    .sort((a, b) => b.limitPrice > a.limitPrice ? 1 : -1)
  const eligibleSells = sells.filter(s => s.limitPrice <= price)
    .sort((a, b) => a.limitPrice > b.limitPrice ? 1 : -1)

  let bi = 0, si = 0
  let buyRemaining  = eligibleBuys[0]?.size  ?? 0n
  let sellRemaining = eligibleSells[0]?.size ?? 0n

  while (bi < eligibleBuys.length && si < eligibleSells.length) {
    const buy  = eligibleBuys[bi]
    const sell = eligibleSells[si]
    const fillSize = buyRemaining < sellRemaining ? buyRemaining : sellRemaining

    if (fillSize < MIN_FILL_SIZE) break

    const type = (fillSize === buy.size && fillSize === sell.size)
      ? 'full'
      : 'partial'

    // Attach the DepositAuth plaintext so settler has it ready
    const depKey      = `${sell.user}:${assetId}`
    const depEntry    = depositAuths[depKey]?.[0] ?? null
    const depositAuth = depEntry?.plaintext ?? null
    const depositNonce = depEntry?.nonce ?? null
    matches.push({ buyOrder: buy, sellOrder: sell, clearingPrice: price, fillSize, type, depositAuth, depositNonce })

    buyRemaining  -= fillSize
    sellRemaining -= fillSize

    if (buyRemaining  === 0n) { bi++; buyRemaining  = eligibleBuys[bi]?.size  ?? 0n }
    if (sellRemaining === 0n) { si++; sellRemaining = eligibleSells[si]?.size ?? 0n }
  }

  return matches
}

// ── Run matching for all assets ────────────────────────────────
export function matchAll() {
  const allMatches = []
  for (const assetId of Object.keys(orders)) {
    const matches = matchAsset(parseInt(assetId))
    if (matches.length) {
      console.log(`[orderbook] asset=${assetId} found ${matches.length} match(es) at price=${matches[0].clearingPrice}`)
      allMatches.push(...matches)
    }
  }
  return allMatches
}

export function getOrderCount(assetId) {
  if (!orders[assetId]) return { buys: 0, sells: 0 }
  return { buys: orders[assetId].true.length, sells: orders[assetId].false.length }
}

export function getAllAssets() { return Object.keys(orders).map(Number) }

export function getAllDepositAuths() {
  const result = []
  for (const entries of Object.values(depositAuths)) {
    for (const entry of entries) {
      const getField = (name) => {
        for (const line of (entry.plaintext ?? '').split(/[,\n]/)) {
          const t = line.trim()
          if (t.startsWith(name + ':')) return t.slice(name.length + 1).replace('.private','').trim()
        }
        return null
      }
      result.push({
        nonce:       entry.nonce,
        user:        getField('user'),
        assetId:     parseInt(getField('asset_id')?.replace('u8','') ?? '-1'),
        amount:      getField('amount')?.replace('u64',''),
        blockHeight: entry.blockHeight ?? 0,
      })
    }
  }
  return result.sort((a, b) => a.blockHeight - b.blockHeight)
}

export function removeOrder(assetId, direction, nonce) {
  if (!orders[assetId]) return
  const key = String(direction)
  const before = orders[assetId][key].length
  orders[assetId][key] = orders[assetId][key].filter(o => o.nonce !== nonce)
  const after = orders[assetId][key].length
  if (before !== after) console.log(`[orderbook] Removed ${direction ? 'BUY' : 'SELL'} nonce=${nonce.slice(0,8)}... from order book`)
}

export function removeDepositAuth(user, assetId, nonce) {
  consumeDepositAuth(user, assetId, nonce)
}

export function getAllOrders() {
  const all = []
  for (const assetId of Object.keys(orders)) {
    for (const dir of ['true', 'false']) {
      all.push(...(orders[assetId][dir] ?? []))
    }
  }
  return all
}
