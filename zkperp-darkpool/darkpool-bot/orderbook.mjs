// ============================================================
// orderbook.mjs
// In-memory order book. Groups orders by asset_id + direction.
// Implements uniform clearing price matching algorithm.
// ============================================================

import { isOrderConsumed } from './api.mjs'
import { MIN_FILL_SIZE } from './config.mjs'

// orders[assetId][direction] = array of order objects
// direction: true = buy, false = sell
const orders = {}

// depositAuths[orderNonce] = DepositAuth plaintext
// Linked to sell orders by nonce — used in settle_match
const depositAuths = {}

// ── Store a DepositAuth ────────────────────────────────────────
export function addDepositAuth(nonce, plaintext, blockHeight = 0) {
  if (depositAuths[nonce]) return false
  depositAuths[nonce] = { plaintext, blockHeight }
  console.log(`[orderbook] DepositAuth stored nonce=${nonce.slice(0,8)}... block=#${blockHeight}`)
  return true
}

export function getDepositAuth(nonce) {
  const entry = depositAuths[nonce]
  if (!entry) return null
  return typeof entry === 'string' ? entry : entry.plaintext
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
      // Remove sells with no DepositAuth — their escrow is spent
      if (direction === false) {
        const before2 = orders[assetId][key].length
        orders[assetId][key] = orders[assetId][key].filter(o => {
          const nonce = o.nonce.replace('field', '')
          return !!depositAuths[nonce] || !!depositAuths[o.nonce]
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

  // Only match sells that have a valid unspent DepositAuth in memory
  const sells = [...orders[assetId].false].filter(s => {
    const nonce = s.nonce.replace('field', '')
    const hasAuth = !!depositAuths[nonce] || !!depositAuths[s.nonce]
    if (!hasAuth) console.log(`[orderbook] Skipping SELL nonce=${s.nonce.slice(0,8)}... — no DepositAuth in memory (likely spent)`)
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

    matches.push({ buyOrder: buy, sellOrder: sell, clearingPrice: price, fillSize, type })

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
  return Object.entries(depositAuths)
    .map(([nonce, entry]) => {
      const plaintext = typeof entry === 'string' ? entry : entry.plaintext
      const blockHeight = typeof entry === 'string' ? 0 : (entry.blockHeight ?? 0)
      const f = (name) => {
        const m = plaintext?.match(new RegExp(`${name}:\\s*([^.,\\n}]+)`))
        return m?.[1]?.replace('.private','').trim() ?? null
      }
      const rawNonce = nonce.endsWith('field') ? nonce : `${nonce}field`
      return {
        nonce:   rawNonce,
        user:    f('user'),
        assetId: parseInt(f('asset_id')?.replace('u8','') ?? '-1'),
        amount:  f('amount')?.replace('u64',''),
        blockHeight,
      }
    })
    .sort((a, b) => a.blockHeight - b.blockHeight) // oldest first, newest last
}

export function removeOrder(assetId, direction, nonce) {
  if (!orders[assetId]) return
  const key = String(direction)
  const before = orders[assetId][key].length
  orders[assetId][key] = orders[assetId][key].filter(o => o.nonce !== nonce)
  const after = orders[assetId][key].length
  if (before !== after) console.log(`[orderbook] Removed ${direction ? 'BUY' : 'SELL'} nonce=${nonce.slice(0,8)}... from order book`)
}

export function removeDepositAuth(nonce) {
  const key = nonce.replace('field', '')
  if (depositAuths[key]) {
    delete depositAuths[key]
    console.log(`[orderbook] Removed DepositAuth nonce=${key.slice(0,8)}... from memory`)
  }
  if (depositAuths[nonce]) {
    delete depositAuths[nonce]
    console.log(`[orderbook] Removed DepositAuth nonce=${nonce.slice(0,8)}... from memory`)
  }
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
