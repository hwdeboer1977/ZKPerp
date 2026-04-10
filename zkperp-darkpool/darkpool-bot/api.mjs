// ============================================================
// api.mjs — Provable REST API helpers
// ============================================================

import { API, PROGRAM_ID } from './config.mjs'

async function get(path) {
  const res = await fetch(`${API}${path}`)
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`)
  return res.json()
}

async function getText(path) {
  const res = await fetch(`${API}${path}`)
  if (!res.ok) return null
  return res.text()
}

// Current block height
export async function getBlockHeight() {
  try {
    const text = await getText('/latest/height')
    return parseInt(text?.replace(/"/g, '').trim() ?? '0')
  } catch { return 0 }
}

// Fetch all transitions for our program after a given block
export async function getTransitions(afterBlock, limit = 50) {
  // Try v1 endpoint patterns — Provable API has changed paths across versions
  const paths = [
    `/program/${PROGRAM_ID}/transitions?start=${afterBlock}&limit=${limit}`,
    `/transitions?programId=${PROGRAM_ID}&start=${afterBlock}&limit=${limit}`,
    `/program/${PROGRAM_ID}/transition?page=0&maxTransitions=${limit}`,
  ]
  for (const path of paths) {
    try {
      const res = await fetch(`${API}${path}`)
      if (!res.ok) continue
      const data = await res.json()
      if (Array.isArray(data) && data.length >= 0) return data
    } catch { continue }
  }
  return []
}

// Fetch transactions for a program by scanning recent blocks
export async function getRecentProgramTxs(fromBlock, limit = 20) {
  try {
    // v1 endpoint: get transactions in block range
    const res = await fetch(`${API}/blocks?start=${fromBlock}&end=${fromBlock + 50}`)
    if (!res.ok) return []
    const blocks = await res.json()
    const txs = []
    for (const block of (Array.isArray(blocks) ? blocks : [])) {
      const blockTxs = block?.transactions ?? []
      for (const tx of blockTxs) {
        const transitions = tx?.transaction?.execution?.transitions ?? []
        for (const t of transitions) {
          if (t.program === PROGRAM_ID) txs.push({ ...tx, transition: t })
        }
      }
    }
    return txs.slice(0, limit)
  } catch { return [] }
}

// Fetch a specific transaction by ID
export async function getTransaction(txId) {
  try { return await get(`/transaction/${txId}`) }
  catch { return null }
}

// Check if an order nonce has been consumed
export async function isOrderConsumed(nonce) {
  try {
    const raw = await getText(
      `/program/${PROGRAM_ID}/mapping/order_consumed/${nonce}field`
    )
    return raw?.includes('true') ?? false
  } catch { return false }
}

// Read fee_vault balance
export async function getFeeVault() {
  try {
    const raw = await getText(`/program/${PROGRAM_ID}/mapping/fee_vault/0u8`)
    const m = raw?.match(/(\d+)u64/)
    return m ? BigInt(m[1]) : 0n
  } catch { return 0n }
}

// Submit a raw transaction
export async function broadcastTransaction(txJson) {
  const res = await fetch(`${API}/transaction/broadcast`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(txJson),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Broadcast failed: ${res.status} — ${err}`)
  }
  return res.text()
}
