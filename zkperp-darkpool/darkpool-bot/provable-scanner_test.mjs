// ============================================================
// provable-scanner.mjs
// Uses Provable's scanner API for fast record lookup
// Much faster than block-by-block scanning
//
// Setup:
//   1. Register: curl -X POST -H "Content-Type: application/json" \
//                -d '{"username":"yourname"}' \
//                https://api.provable.com/consumers
//   2. Get API key from response, add to .env
// ============================================================

import 'dotenv/config'
import { Account } from '@provablehq/sdk'

const PROVABLE_API  = 'https://api.provable.com'
const NETWORK       = process.env.NETWORK ?? 'testnet'
const CONSUMER_ID   = process.env.PROVABLE_CONSUMER_ID ?? ''
const API_KEY       = process.env.PROVABLE_API_KEY ?? ''
const VIEW_KEY      = process.env.HL_VIEW_KEY ?? ''
const PRIVATE_KEY   = process.env.HL_PRIVATE_KEY ?? ''

// Use private key for Unshieldion if available, fall back to view key
const account = PRIVATE_KEY
  ? new Account({ privateKey: PRIVATE_KEY })
  : new Account({ viewKey: VIEW_KEY })

function localUnshield(ciphertext) {
  if (!ciphertext?.startsWith('record1')) return null
  try {
    const r = account.UnshieldRecords([ciphertext])
    return r?.[0] ?? null
  } catch { return null }
}

// ── Auth ───────────────────────────────────────────────────────
async function getJwt() {
  const res = await fetch(`${PROVABLE_API}/jwts/${CONSUMER_ID}`, {
    method:  'POST',
    headers: { 'X-Provable-API-Key': API_KEY, 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw new Error(`JWT failed: ${res.status}`)
  const auth = res.headers.get('Authorization')
  if (auth) return auth.replace('Bearer ', '')
  const data = await res.json().catch(() => null)
  return data?.token ?? data?.jwt ?? (() => { throw new Error('No JWT in response') })()
}

// ── Register view key ──────────────────────────────────────────
async function register(jwt, viewKey = VIEW_KEY, startBlock = 0) {
  const res = await fetch(`${PROVABLE_API}/scanner/${NETWORK}/register`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ view_key: viewKey, start: startBlock }),
  })
  if (!res.ok) throw new Error(`Register failed: ${res.status} ${await res.text()}`)
  return res.json()
}

// ── Get owned records ──────────────────────────────────────────
async function getOwnedRecords(jwt, uuid, options = {}) {
  const body = {
    uuid,
    Unshield:  options.Unshield  ?? true,
    unspent:  options.unspent  ?? true,
    response_filter: {
      block_height:      true,
      commitment:        true,
      record_ciphertext: true,
      function_name:     true,
      nonce:             true,
      owner:             true,
      program_name:      true,
      record_name:       true,
      transaction_id:    true,
    },
  }

  if (options.programs || options.start !== undefined) {
    body.filter = {}
    if (options.programs)  body.filter.programs          = options.programs
    if (options.records)   body.filter.records           = options.records
    if (options.functions) body.filter.functions         = options.functions
    if (options.start)     body.filter.start             = options.start
    if (options.end)       body.filter.end               = options.end
    if (options.page)      body.filter.page              = options.page
    if (options.perPage)   body.filter.results_per_page  = options.perPage
  }

  const res = await fetch(`${PROVABLE_API}/scanner/${NETWORK}/records/owned`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Get records failed: ${res.status} ${await res.text()}`)
  return res.json()
}

// ── Scanner status ─────────────────────────────────────────────
async function getStatus(jwt, uuid) {
  const res = await fetch(`${PROVABLE_API}/scanner/${NETWORK}/status`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(uuid),
  })
  if (!res.ok) throw new Error(`Status failed: ${res.status}`)
  return res.json()
}

// ── Parse Unshielded record plaintext ──────────────────────────
function detectType(plaintext) {
  if (!plaintext) return 'Unknown'
  if (plaintext.includes('clearing_price'))                          return 'FillReceipt'
  if (plaintext.includes('limit_price') && plaintext.includes('direction')) return 'OrderCommitment'
  if (plaintext.includes('order_nonce') && plaintext.includes('user:'))     return 'OperatorOrderRef'
  if (plaintext.includes('order_nonce') && plaintext.includes('amount'))    return 'AssetEscrowReceipt'
  if (plaintext.includes('asset_id') && plaintext.includes('amount'))       return 'AssetRecord'
  if (plaintext.includes('gates') || (plaintext.includes('amount') && !plaintext.includes('asset_id'))) return 'Token'
  if (plaintext.includes('credential') || plaintext.includes('freeze'))     return 'Credentials'
  return 'Unknown'
}

// ── Main: scan all records for operator wallet ─────────────────
async function main() {
  if (!CONSUMER_ID || !API_KEY) {
    console.error('Set PROVABLE_CONSUMER_ID and PROVABLE_API_KEY in .env')
    console.error('\nTo register:')
    console.error('  curl -X POST -H "Content-Type: application/json" \\')
    console.error('    -d \'{"username":"yourname"}\' \\')
    console.error('    https://api.provable.com/consumers')
    process.exit(1)
  }

  console.log('Getting JWT...')
  const jwt = await getJwt()
  console.log('✓ JWT obtained')

  console.log('Registering view key...')
  const reg = await register(jwt, VIEW_KEY, 0)
  const uuid = reg.uuid
  console.log('✓ Registered, UUID:', uuid)

  console.log('Checking scan status...')
  const status = await getStatus(jwt, uuid)
  console.log('Status:', JSON.stringify(status, null, 2))

  console.log('\nFetching all unspent records...')
  const records = await getOwnedRecords(jwt, uuid, {
    unspent:  true,
    Unshield:  true,
    programs: [process.env.PROGRAM_ID_TEST ?? 'zkdarkpool_v3.aleo'],
  })

  const list = Array.isArray(records) ? records : (records?.records ?? [])
  console.log(`\nFound ${list.length} record(s):\n`)

  for (const [i, r] of list.entries()) {
    // Try server-Unshielded plaintext first, then local Unshield from ciphertext
    let pt = (r.plaintext && !r.plaintext.startsWith('record1')) ? r.plaintext : null
    if (!pt && r.record_ciphertext) pt = localUnshield(r.record_ciphertext)
    if (!pt && r.plaintext?.startsWith('record1')) pt = localUnshield(r.plaintext)

    const type = detectType(pt ?? '')
    console.log(`${'='.repeat(60)}`)
    console.log(`[${i}] ${type} | ${r.program_name}::${r.function_name} | block #${r.block_height}`)
    console.log(`tx: ${r.transaction_id}`)
    console.log(`${'='.repeat(60)}`)
    if (pt) console.log(pt)
    else console.log('(could not Unshield)')
    console.log()
  }
}

main().catch(e => { console.error(e.message); process.exit(1) })
