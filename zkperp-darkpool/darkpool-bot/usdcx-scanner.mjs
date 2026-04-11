// ============================================================
// usdcx-scanner.mjs
// Auto-scans test_usdcx_stablecoin.aleo for the operator's
// unspent Token and Credentials records.
// Updates records.json with fresh values after each settlement.
// ============================================================

import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { Account } from '@provablehq/sdk'

const __dirname    = dirname(fileURLToPath(import.meta.url))
const RECORDS_FILE = join(__dirname, 'records.json')

const PROVABLE_API = 'https://api.provable.com'
const NETWORK      = process.env.NETWORK      ?? 'testnet'
const CONSUMER_ID  = process.env.PROVABLE_CONSUMER_ID ?? ''
const API_KEY      = process.env.PROVABLE_API_KEY ?? ''
const VIEW_KEY     = process.env.OPERATOR_VIEW_KEY ?? ''
const PRIVATE_KEY  = process.env.OPERATOR_PRIVATE_KEY ?? ''
const USDCX_ID     = process.env.USDCX_ID ?? 'test_usdcx_stablecoin.aleo'

const account = PRIVATE_KEY
  ? new Account({ privateKey: PRIVATE_KEY })
  : new Account({ viewKey: VIEW_KEY })

function localDecrypt(ct) {
  if (!ct?.startsWith('record1')) return null
  try { return account.decryptRecords([ct])?.[0] ?? null } catch { return null }
}

function normalize(pt) {
  if (!pt) return ''
  return pt.replace(/\s+/g,' ').replace(/\{ /g,'{').replace(/ \}/g,'}')
           .replace(/,\s+/g,',').replace(/:\s+/g,':').trim()
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
  if (!res.ok) throw new Error(`Register failed: ${res.status}`)
  return res.json()
}

async function getRecords(jwt, uuid) {
  const res = await fetch(`${PROVABLE_API}/scanner/${NETWORK}/records/owned`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uuid,
      decrypt: true,
      unspent: true,
      filter: { programs: [USDCX_ID], results_per_page: 50 },
      response_filter: {
        block_height: true, record_ciphertext: true,
        function_name: true, program_name: true, transaction_id: true,
      },
    }),
  })
  if (!res.ok) throw new Error(`Records failed: ${res.status}`)
  return res.json()
}

function loadRecords() {
  try {
    if (!existsSync(RECORDS_FILE)) return {}
    return JSON.parse(readFileSync(RECORDS_FILE, 'utf8'))
  } catch { return {} }
}

function saveRecords(data) {
  writeFileSync(RECORDS_FILE, JSON.stringify(data, null, 2))
}

// ── In-memory cache — settler reads this instead of records.json ──
let _cachedToken       = null
let _cachedCredentials = null
export function getCachedToken()       { return _cachedToken }
export function getCachedCredentials() { return _cachedCredentials }

// ── Main export: scan and update records.json ──────────────
export async function refreshUSDCxRecords() {
  if (!CONSUMER_ID || !API_KEY) {
    console.warn('[usdcx] PROVABLE_CONSUMER_ID/API_KEY not set — skipping USDCx scan')
    return null
  }

  try {
    console.log('[usdcx] Scanning for fresh Token + Credentials...')
    const jwt  = await getJwt()
    const reg  = await register(jwt)
    const uuid = reg.uuid

    // Wait for scanner to sync to latest block
    for (let i = 0; i < 15; i++) {
      try {
        const statusRes = await fetch(`${PROVABLE_API}/scanner/${NETWORK}/status`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(uuid),
        })
        if (statusRes.ok) {
          const s = await statusRes.json()
          const pct = s.percentage ?? s.synced_percentage ?? (s.synced ? 100 : 0)
          if (pct >= 99 || s.synced === true) break
          process.stdout.write(`\r[usdcx] Syncing ${pct?.toFixed(0) ?? '?'}%...`)
          await new Promise(r => setTimeout(r, 3000))
        } else break
      } catch { break }
    }
    process.stdout.write('\r[usdcx] ✓ Synced            \n')

    const data = await getRecords(jwt, uuid)
    const list = (Array.isArray(data) ? data : (data?.records ?? []))
      .sort((a, b) => (b.block_height ?? 0) - (a.block_height ?? 0))

    // Load blacklisted nonces (tokens already used in a settlement)
    const existing = loadRecords()
    const spentNonces = new Set(existing.spentTokenNonces ?? [])

    let token       = null
    let credentials = null

    for (const r of list) {
      let pt = (r.plaintext && !r.plaintext.startsWith('record1')) ? r.plaintext : null
      if (!pt && r.record_ciphertext) pt = localDecrypt(r.record_ciphertext)
      if (!pt) continue

      const norm = normalize(pt)

      // Token — has amount field, no asset_id or freeze_list_root
      if (!token && norm.includes('amount:') && !norm.includes('asset_id') && !norm.includes('freeze_list_root')) {
        const amtMatch = norm.match(/amount:(\d+)u128/)
        const nonceMatch = norm.match(/_nonce:(\w+)group/)
        const nonce = nonceMatch?.[1]
        if (amtMatch && BigInt(amtMatch[1]) > 0n) {
          if (nonce && spentNonces.has(nonce)) {
            console.log(`[usdcx] Skipping token nonce=${nonce.slice(0,8)}... (blacklisted as spent)`)
            continue
          }
          token = norm
          console.log(`[usdcx] ✓ Token found: ${Number(amtMatch[1])/1e6} USDCx (block #${r.block_height})`)
        }
      }

      // Credentials — has freeze_list_root
      if (!credentials && norm.includes('freeze_list_root')) {
        credentials = norm
        console.log(`[usdcx] ✓ Credentials found (block #${r.block_height})`)
      }

      if (token && credentials) break
    }

    if (!token)       console.warn('[usdcx] ⚠ No unspent Token with balance found')
    if (!credentials) console.warn('[usdcx] ⚠ No unspent Credentials found')

    // Update records.json preserving other fields (existing already loaded above)
    const updated = {
      ...existing,
      ...(token       ? { token }       : {}),
      ...(credentials ? { credentials } : {}),
    }
    saveRecords(updated)

    if (token)       _cachedToken       = token
    if (credentials) _cachedCredentials = credentials
    if (token || credentials) {
      console.log('[usdcx] ✓ records.json updated')
    }

    return { token, credentials }
  } catch (e) {
    console.error('[usdcx] Scan failed:', e.message)
    return null
  }
}

// Call this after a confirmed settlement to prevent reuse of the spent token
export function blacklistTokenNonce(tokenPlaintext) {
  try {
    const m = tokenPlaintext?.match(/_nonce:(\w+)group/)
    if (!m) return
    const nonce = m[1]
    const rec = JSON.parse(existsSync(RECORDS_FILE) ? readFileSync(RECORDS_FILE, 'utf8') : '{}')
    rec.spentTokenNonces = [...new Set([...(rec.spentTokenNonces ?? []), nonce])]
    writeFileSync(RECORDS_FILE, JSON.stringify(rec, null, 2))
    console.log(`[usdcx] Token nonce=${nonce.slice(0,8)}... blacklisted`)
  } catch (e) {
    console.warn('[usdcx] Failed to blacklist token nonce:', e.message)
  }
}
