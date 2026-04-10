// ============================================================
// scanner.mjs — scans blocks for OperatorOrderRef records
// ============================================================

import { Account } from '@provablehq/sdk'
import { OPERATOR_PK, OPERATOR_VK, PROGRAM_ID, API, START_BLOCK } from './config.mjs'

let lastScannedBlock = START_BLOCK

// Use private key for full decryption capability
// View key alone cannot decrypt Leo 4.0 records in this SDK version
let _account = null
function getAccount() {
  if (!_account) {
    _account = OPERATOR_PK
      ? new Account({ privateKey: OPERATOR_PK })
      : new Account({ viewKey: OPERATOR_VK })
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(_account))
      .filter(m => m !== 'constructor')
    console.log('[scanner] Account address:', _account.address().to_string())
  }
  return _account
}

function tryDecrypt(ciphertext) {
  try {
    const acct = getAccount()
    const results = acct.decryptRecords([ciphertext])
    if (!results || results.length === 0) return null
    return typeof results[0] === 'string' ? results[0] : JSON.stringify(results[0])
  } catch (e) {
    // "did not match" = not our record, silently skip
    const msg = String(e)
    if (!msg.includes('did not match') && !msg.includes('Decryption failed')) {
      console.log(`[scanner]   decrypt error:`, msg.slice(0, 100))
    }
    return null
  }
}

function parseOrderRef(plaintext, txId, blockHeight) {
  try {
    const f = (name) => {
      const m = plaintext.match(new RegExp(`${name}:\\s*([^.\\n]+)`))
      return m?.[1]?.trim() ?? null
    }
    const user      = f('user')?.replace('.private','').trim()
    const nonce     = f('order_nonce')?.replace('.private','').trim() // keep 'field' suffix
    const assetId   = parseInt(f('asset_id')?.replace('u8','').replace('.private','').trim() ?? '-1')
    const dirStr    = f('direction')?.replace('.private','').trim()
    const direction = dirStr === 'true'
    const expiry    = parseInt(f('expiry')?.replace('u32','').replace('.private','').trim() ?? '0')

    // v5: OrderAuth also has size and limit_price
    const sizeStr  = f('size')?.replace('u64','').replace('.private','').trim()
    const priceStr = f('limit_price')?.replace('u64','').replace('.private','').trim()
    const size       = sizeStr  ? BigInt(sizeStr)  : null
    const limitPrice = priceStr ? BigInt(priceStr) : null

    if (!user || !nonce || assetId < 0) return null
    return { txId, blockHeight, user, nonce, assetId, direction, expiry, size, limitPrice, plaintext }
  } catch { return null }
}

// Detect if a decrypted record is an OrderAuth (v5) vs OperatorOrderRef (v4)
function isOrderAuth(pt) {
  return pt?.includes('limit_price') && pt?.includes('order_nonce') && pt?.includes('user:')
}

// Extract orders from a single block object (handles various API shapes)
function extractFromBlock(block, orders) {
  // API may nest differently — walk all possible paths
  const height =
    block?.block_height ??
    block?.header?.metadata?.height ??
    block?.height ??
    0

  // Transactions may be at block.transactions or block.block.transactions
  const txList =
    block?.transactions ??
    block?.block?.transactions ??
    []

  for (const txEntry of txList) {
    // Transaction may be wrapped in { status, transaction } or be direct
    const tx   = txEntry?.transaction ?? txEntry
    const txId = tx?.id ?? tx?.transaction_id ?? 'unknown'

    // Transitions may be at execution.transitions or direct
    const transitions =
      tx?.execution?.transitions ??
      tx?.transitions ??
      []

    for (const t of transitions) {
      const prog = t?.program ?? t?.program_id ?? ''
      const fn   = (t?.function ?? t?.function_name ?? '').toLowerCase()

      if (prog !== PROGRAM_ID) continue
      if (!fn.includes('submit_order') && !fn.includes('partial_fill') && !fn.includes('deposit_asset')) continue

      console.log(`[scanner] ✓ ${fn} in block #${height} tx=${txId.slice(0,24)}...`)

      for (const output of (t?.outputs ?? [])) {
        if (output?.type !== 'record') continue
        const ct = output?.value
        if (!ct?.startsWith('record1')) continue

        const pt = tryDecrypt(ct)
        if (!pt) {
          console.log(`[scanner]   record found but not decryptable by operator view key (not ours)`)
          continue
        }

        // DepositAuth — operator's copy of escrowed asset from deposit_asset
        if (fn.includes('deposit_asset') && pt.includes('order_nonce') && pt.includes('user:') && pt.includes('amount')) {
          const f = (name) => {
            const m = pt.match(new RegExp(`${name}:\\s*([^.\\n,}]+)`))
            return m?.[1]?.trim() ?? null
          }
          const user       = f('user')?.replace('.private','').trim()
          const orderNonce = f('order_nonce')?.replace('.private','').trim() // keep 'field' suffix
          const assetId    = parseInt(f('asset_id')?.replace('u8','').replace('.private','').trim() ?? '-1')
          const amtStr     = f('amount')?.replace('u64','').replace('.private','').trim()
          const amount     = amtStr ? BigInt(amtStr) : 0n
          if (user && orderNonce && assetId >= 0 && amount > 0n) {
            console.log(`[scanner] 🔓 DepositAuth: nonce=${orderNonce.slice(0,8)}... asset=${assetId} amount=${amount} user=${user.slice(0,20)}...`)
            orders.push({ txId, blockHeight: height, user, nonce: orderNonce, assetId, direction: false, expiry: 99999999, size: amount, limitPrice: 1n, plaintext: pt, isDepositAuth: true })
          }
          continue
        }

        // v5: OrderAuth has limit_price — use it directly for order book
        // v4: OperatorOrderRef has only nonce + direction — no price/size
        if (!pt.includes('order_nonce')) {
          console.log(`[scanner]   decrypted but not an order ref (fields: ${pt.slice(0,80)}...)`)
          continue
        }

        const order = parseOrderRef(pt, txId, height)
        if (order) {
          const isV5 = isOrderAuth(pt)
          console.log(`[scanner] 🔓 ${isV5 ? 'OrderAuth' : 'OperatorOrderRef'}: nonce=${order.nonce.slice(0,8)}... dir=${order.direction ? 'BUY' : 'SELL'} asset=${order.assetId}${isV5 ? ` price=${order.limitPrice} size=${order.size}` : ''} user=${order.user.slice(0,20)}...`)
          orders.push(order)
        }
      }
    }
  }
}

// ── Fetch real _nonce for OrderCommitment from chain ──────────
// The OrderCommitment is encrypted to the user so we can't decrypt it,
// but we can read its public _nonce from the transaction outputs
async function fetchOrderCommitmentNonce(txId, orderNonce) {
  try {
    const res = await fetch(`${API}/transaction/${txId}`)
    if (!res.ok) return null
    const tx = await res.json()
    const transitions = tx?.execution?.transitions ?? []
    for (const t of transitions) {
      if (!(t?.function ?? '').includes('submit_order')) continue
      for (const output of (t?.outputs ?? [])) {
        if (output?.type !== 'record') continue
        // The public _nonce is visible even for encrypted records
        const nonce = output?.id ?? output?.nonce
        if (nonce && output?.value?.includes(orderNonce.replace('field',''))) {
          return nonce
        }
      }
    }
    return null
  } catch { return null }
}

// ── Fetch tx and decrypt all record outputs ────────────────────
export async function fetchAndDecryptTx(txId) {
  try {
    const res = await fetch(`${API}/transaction/${txId}`)
    if (!res.ok) return []
    const tx = await res.json()
    const results = []
    const transitions = tx?.execution?.transitions ?? []
    for (const t of transitions) {
      for (const output of (t?.outputs ?? [])) {
        if (output?.type !== 'record') continue
        const ct = output?.value
        if (!ct?.startsWith('record1')) continue
        const pt = tryDecrypt(ct)
        if (pt) results.push({ plaintext: pt, function: t.function ?? '' })
      }
    }
    return results
  } catch (e) {
    console.warn('[scanner] fetchAndDecryptTx error:', e.message)
    return []
  }
}

async function fetchBlock(height) {
  try {
    const res = await fetch(`${API}/block/${height}`)
    if (!res.ok) return null
    return res.json()
  } catch { return null }
}

export async function scanNewOrders() {
  const orders = []
  try {
    // Fetch current height
    const hRes = await fetch(`${API}/latest/height`)
    if (!hRes.ok) return orders
    const currentBlock = parseInt((await hRes.text()).replace(/"/g,'').trim())
    if (!currentBlock || currentBlock <= lastScannedBlock) return orders

    const toBlock = Math.min(currentBlock, lastScannedBlock + 500) // 500 blocks per tick during catch-up
    console.log(`[scanner] Scanning #${lastScannedBlock} → #${toBlock} (current #${currentBlock})`)

    // Try range endpoint first
    let usedRange = false
    try {
      const res = await fetch(`${API}/blocks?start=${lastScannedBlock}&end=${toBlock}`)
      if (res.ok) {
        const data = await res.json()
        const blocks = Array.isArray(data) ? data : [data]
        if (blocks.length > 0) {
          usedRange = true
          for (const block of blocks) extractFromBlock(block, orders)
        }
      }
    } catch {}

    // Fallback: fetch blocks individually
    if (!usedRange) {
      for (let h = lastScannedBlock; h <= toBlock; h++) {
        const block = await fetchBlock(h)
        if (block) extractFromBlock(block, orders)
      }
    }

    lastScannedBlock = toBlock + 1
  } catch (err) {
    console.error('[scanner] Error:', err.message)
  }
  return orders
}

export function getLastScannedBlock() { return lastScannedBlock }
export function setStartBlock(block)  { lastScannedBlock = block }
