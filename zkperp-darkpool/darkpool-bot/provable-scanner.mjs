// ============================================================
// provable-scanner.mjs
// Scans for UNSPENT records only, sorted by most recent first
// Usage:
//   PROGRAM_ID=zkdarkpool_v9.aleo node provable-scanner.mjs
//   PROGRAM_ID=zkdarkpool_v9.aleo SCAN_FROM=15700000 node provable-scanner.mjs
//   PROGRAM_ID=test_usdcx_stablecoin.aleo node provable-scanner.mjs
// ============================================================

import 'dotenv/config'
import { writeFileSync } from 'fs'
import { Account } from '@provablehq/sdk'

const PROVABLE_API = 'https://api.provable.com'
const NETWORK      = process.env.NETWORK      ?? 'testnet'
const CONSUMER_ID  = process.env.PROVABLE_CONSUMER_ID ?? ''
const API_KEY      = process.env.PROVABLE_API_KEY ?? ''
const VIEW_KEY     = process.env.OPERATOR_VIEW_KEY ?? ''
const PRIVATE_KEY  = process.env.OPERATOR_PRIVATE_KEY ?? ''
const PROGRAM_ID   = process.env.PROGRAM_ID   ?? 'zkdarkpool_v9.aleo'
const SCAN_FROM    = parseInt(process.env.SCAN_FROM ?? '0')  // filter: only show records >= this block

const account = PRIVATE_KEY
  ? new Account({ privateKey: PRIVATE_KEY })
  : new Account({ viewKey: VIEW_KEY })

function localUnshield(ct) {
  if (!ct?.startsWith('record1')) return null
  try { return account.UnshieldRecords([ct])?.[0] ?? null } catch { return null }
}

async function getJwt() {
  const res = await fetch(`${PROVABLE_API}/jwts/${CONSUMER_ID}`, {
    method: 'POST',
    headers: { 'X-Provable-API-Key': API_KEY, 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw new Error(`JWT failed: ${res.status}`)
  const auth = res.headers.get('Authorization')
  if (auth) return auth.replace('Bearer ', '')
  const data = await res.json().catch(() => null)
  return data?.token ?? data?.jwt ?? (() => { throw new Error('No JWT') })()
}

async function register(jwt) {
  const res = await fetch(`${PROVABLE_API}/scanner/${NETWORK}/register`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ view_key: VIEW_KEY, start: 0 }),
  })
  if (!res.ok) throw new Error(`Register failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function getStatus(jwt, uuid) {
  const res = await fetch(`${PROVABLE_API}/scanner/${NETWORK}/status`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(uuid),
  })
  if (!res.ok) throw new Error(`Status failed: ${res.status}`)
  return res.json()
}

async function getRecords(jwt, uuid) {
  const body = {
    uuid,
    Unshield: true,
    unspent: true,   // ← UNSPENT ONLY
    filter: {
      programs: [PROGRAM_ID],
      results_per_page: 100,
      ...(SCAN_FROM > 0 ? { start: SCAN_FROM } : {}),
    },
    response_filter: {
      block_height:      true,
      record_ciphertext: true,
      function_name:     true,
      program_name:      true,
      record_name:       true,
      transaction_id:    true,
    },
  }

  const res = await fetch(`${PROVABLE_API}/scanner/${NETWORK}/records/owned`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Records failed: ${res.status} ${await res.text()}`)
  return res.json()
}

function detectType(pt, funcName) {
  if (!pt) return 'Unknown'
  if (pt.includes('clearing_price'))                                          return 'FillReceipt'
  if (pt.includes('limit_price') && pt.includes('order_nonce'))               return 'OrderAuth'
  if (pt.includes('limit_price') && pt.includes('direction'))                 return 'OrderCommitment'
  if (pt.includes('order_nonce') && pt.includes('user:') && !pt.includes('amount')) return 'OperatorOrderRef'
  if (pt.includes('order_nonce') && pt.includes('user:') && pt.includes('amount'))  return 'DepositAuth'
  if (pt.includes('order_nonce') && pt.includes('amount'))                    return 'AssetEscrowReceipt'
  if (pt.includes('freeze_list_root'))                                        return 'Credentials'
  if (pt.includes('asset_id') && pt.includes('amount')) {
    if (funcName?.includes('deposit_asset')) {
      const amtMatch = pt.match(/amount:(\d+)u64/)
      const amt = amtMatch ? BigInt(amtMatch[1]) : 0n
      return amt > 0n ? 'AssetRecord[escrowed]' : 'AssetRecord[change=0]'
    }
    return 'AssetRecord'
  }
  if (pt.includes('amount') && !pt.includes('asset_id'))                      return 'Token'
  return 'Unknown'
}

function normalize(pt) {
  if (!pt) return pt
  return pt.replace(/\s+/g,' ').replace(/\{ /g,'{').replace(/ \}/g,'}')
           .replace(/,\s+/g,',').replace(/:\s+/g,':').trim()
}

async function main() {
  if (!CONSUMER_ID || !API_KEY) {
    console.error('Set PROVABLE_CONSUMER_ID and PROVABLE_API_KEY in .env')
    process.exit(1)
  }

  console.log(`Scanning ${PROGRAM_ID} for unspent records...`)
  const jwt  = await getJwt()
  const reg  = await register(jwt)
  const uuid = reg.uuid

  // Wait for sync
  for (let i = 0; i < 10; i++) {
    const status = await getStatus(jwt, uuid)
    if (status.synced || status.percentage >= 99) break
    process.stdout.write(`\rSyncing ${status.percentage?.toFixed(0) ?? '?'}%...`)
    await new Promise(r => setTimeout(r, 2000))
  }
  process.stdout.write('\r✓ Synced                \n')

  const data = await getRecords(jwt, uuid)
  let list = (Array.isArray(data) ? data : (data?.records ?? []))
    .sort((a, b) => (b.block_height ?? 0) - (a.block_height ?? 0))

  // Apply block filter
  if (SCAN_FROM > 0) {
    const before = list.length
    list = list.filter(r => (r.block_height ?? 0) >= SCAN_FROM)
    console.log(`Filtered to blocks >= ${SCAN_FROM}: ${list.length}/${before} records`)
  }

  if (!list.length) {
    console.log('No unspent records found' + (SCAN_FROM > 0 ? ` from block ${SCAN_FROM}` : '') + '.')
    return
  }

  console.log(`\nFound ${list.length} unspent record(s) — newest first:\n`)

  const parsed = []

  for (const [i, r] of list.entries()) {
    let pt = (r.plaintext && !r.plaintext.startsWith('record1')) ? r.plaintext : null
    if (!pt && r.record_ciphertext) pt = localUnshield(r.record_ciphertext)

    const type = detectType(pt ?? '', r.function_name)
    const norm = normalize(pt)

    console.log(`${'='.repeat(60)}`)
    console.log(`[${i}] ${type} | ${r.program_name}::${r.function_name} | block #${r.block_height}`)
    console.log(`tx: ${r.transaction_id}`)
    console.log(`${'='.repeat(60)}`)
    if (pt) console.log(pt)
    else console.log('(could not Unshield)')
    console.log()

    parsed.push({ index: i, type, block: r.block_height, tx: r.transaction_id, plaintext: norm })
  }

  // Write summary JSON for easy reference
  const summary = {
    program:  PROGRAM_ID,
    scanned:  new Date().toISOString(),
    records:  parsed,
  }
  writeFileSync('./scan-results.json', JSON.stringify(summary, null, 2))
  console.log(`\n✓ Saved to scan-results.json`)
  console.log(`\nMost recent useful records:`)

  const useful = ['OrderAuth', 'DepositAuth', 'OrderCommitment', 'Token', 'Credentials', 'AssetRecord[escrowed]', 'FillReceipt']
  for (const type of useful) {
    const rec = parsed.find(r => r.type === type)
    if (rec) console.log(`  [${rec.index}] ${type} — block #${rec.block}`)
  }
}

main().catch(e => { console.error(e.message); process.exit(1) })
