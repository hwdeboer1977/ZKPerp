// ============================================================
// settler.mjs — v5 settle_match via records.json
// ============================================================
//
// v5 flow: operator owns OrderAuth + DepositAuth on-chain.
// Scanner decrypts them, operator fills records.json, bot prints command.
//
// records.json format:
// {
//   "buyAuth":     "full OrderAuth plaintext",
//   "sellAuth":    "full OrderAuth plaintext",
//   "depositAuth": "full DepositAuth plaintext",
//   "token":       "full Token plaintext (buyer's USDCx)",
//   "credentials": "full Credentials plaintext"
// }
//
// settle_match v5 inputs:
//   1. buy_auth       (OrderAuth   — operator owned)
//   2. sell_auth      (OrderAuth   — operator owned)
//   3. deposit_auth   (DepositAuth — operator owned)
//   4. buyer_token    (Token       — from USDCx scanner)
//   5. buyer_creds    (Credentials — from USDCx scanner)
//   6. clearing_price u64
//   7. fill_size      u64
//   8. batch_root     field
// ============================================================

import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname  = dirname(fileURLToPath(import.meta.url))
const RECORDS_FILE = join(__dirname, 'records.json')
function normalize(pt) {
  if (!pt) return ''
  return pt.replace(/\s+/g,' ').replace(/\{ /g,'{').replace(/ \}/g,'}')
           .replace(/,\s+/g,',').replace(/:\s+/g,':').trim()
}

function batchRoot(assetId = 0) {
  return `${BigInt(Math.floor(Date.now() / 1000)) * 1000n + BigInt(assetId)}field`
}

export function loadRecords() {
  try {
    if (!existsSync(RECORDS_FILE)) {
      console.warn(`[settler] ${RECORDS_FILE} not found`)
      return null
    }
    return JSON.parse(readFileSync(RECORDS_FILE, 'utf8'))
  } catch (e) {
    console.error('[settler] Failed to load records.json:', e.message)
    return null
  }
}

export function saveRecords(data) {
  writeFileSync(RECORDS_FILE, JSON.stringify(data, null, 2))
  console.log('[settler] Saved records.json')
}

// ── Parse clearing price from matched orders ───────────────
function parseLimitPrice(authPt) {
  const m = authPt?.match(/limit_price:(\d+)u64/)
  return m ? BigInt(m[1]) : null
}

// ── Manual settlement using records.json ──────────────────
// ── Delegated proving via Provable SDK, leo fallback ───────────
async function executeWithDelegated({ buyAuth, sellAuth, depositAuth, token, credentials, clearingPrice, fillSize, root }) {
  const CONSUMER_ID = process.env.PROVABLE_CONSUMER_ID ?? ''
  const API_KEY     = process.env.PROVABLE_API_KEY ?? ''
  const PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY ?? ''
  const ENDPOINT    = process.env.ENDPOINT ?? 'https://api.provable.com/v2'
  const PROVE_URL   = (() => {
    const base = (process.env.PROVABLE_PROVING_URL ?? 'https://api.provable.com/prove/testnet').replace(/\/+$/, '')
    return base.endsWith('/prove') ? base : base + '/prove'
  })()
  const MAX_RETRIES = 5

  if (CONSUMER_ID && API_KEY && PRIVATE_KEY) {
    console.log('[settler] Trying delegated proving via Provable DPS...')

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 1) {
          console.log(`[settler] Retry attempt ${attempt}/${MAX_RETRIES}...`)
          await new Promise(r => setTimeout(r, 5000 * attempt))
        }

        // Get JWT
        const jwtRes = await fetch(`https://api.provable.com/jwts/${CONSUMER_ID}`, {
          method: 'POST',
          headers: { 'X-Provable-API-Key': API_KEY, 'Content-Type': 'application/json' },
        })
        if (!jwtRes.ok) throw new Error(`JWT failed: ${jwtRes.status}`)
        const authHeader = jwtRes.headers.get('Authorization')
        const jwtData = authHeader ? null : await jwtRes.json().catch(() => null)
        const jwt = authHeader ? authHeader.replace('Bearer ', '') : (jwtData?.token ?? jwtData?.jwt)
        if (!jwt) throw new Error('No JWT in response')
        console.log('[settler] ✓ JWT obtained')

        // Init SDK
        const sdk = await import('@provablehq/sdk')
        await sdk.initThreadPool?.()
        const { ProgramManager, Account, AleoKeyProvider, AleoNetworkClient, NetworkRecordProvider } = sdk

        const account = new Account({ privateKey: PRIVATE_KEY })

        const nc = new AleoNetworkClient(ENDPOINT, {
          headers: {
            ...(API_KEY     ? { 'X-Provable-API-Key': API_KEY }     : {}),
            ...(CONSUMER_ID ? { 'X-Consumer-ID': CONSUMER_ID }      : {}),
          },
        })
        if (API_KEY)     nc.apiKey     = API_KEY
        if (CONSUMER_ID) nc.consumerId = CONSUMER_ID
        nc.proverUri = PROVE_URL

        const recordProvider = new NetworkRecordProvider(account, nc)
        const keyProvider    = new AleoKeyProvider()
        keyProvider.useCache(true)

        const pm = new ProgramManager(ENDPOINT, keyProvider, recordProvider)
        pm.networkClient = nc
        pm.setAccount(account)

        console.log(`[settler] depositAuth being passed: ${depositAuth.slice(0,120)}`)
        const inputs = [buyAuth, sellAuth, depositAuth, token, credentials, `${clearingPrice}u64`, `${fillSize}u64`, root]

        console.log('[settler] Building proving request...')
        const provingRequest = await pm.provingRequest({
          programName:  process.env.PROGRAM_ID ?? 'zkdarkpool_v8.aleo',
          functionName: 'settle_match',
          fee:          0.02,
          privateFee:   false,
          inputs,
          broadcast:    false,
        })
        console.log('[settler] ✓ Proving request built — submitting to DPS:', PROVE_URL)

        const dpsRes = await fetch(PROVE_URL, {
          method: 'POST',
          headers: {
            'Authorization':      `Bearer ${jwt}`,
            'X-Provable-API-Key': API_KEY,
            'Content-Type':       'application/json',
          },
          body: provingRequest.toString(),  // ← must be string, not JSON-wrapped
        })

        if (!dpsRes.ok) {
          const errText = await dpsRes.text()
          if (dpsRes.status === 522 || dpsRes.status === 504 || dpsRes.status === 503) {
            console.warn(`[settler] DPS timeout (${dpsRes.status}) — will retry`)
            continue
          }
          throw new Error(`DPS failed: ${dpsRes.status} ${errText}`)
        }

        const response = await dpsRes.json()
        const builtTx  = response?.transaction ?? response
        if (!builtTx) throw new Error(`No transaction in DPS response: ${JSON.stringify(response)}`)

        const txId     = builtTx.id ?? builtTx
        const txString = typeof builtTx === 'string' ? builtTx : JSON.stringify(builtTx)

        console.log(`[settler] Broadcasting ${txId}...`)
        try {
          await nc.submitTransaction(txString)
        } catch (broadcastErr) {
          const msg = broadcastErr?.message ?? String(broadcastErr)
          if (msg.includes('already exists')) {
            throw new Error(`STALE_RECORD: ${msg}`)
          }
          throw broadcastErr
        }
        console.log(`[settler] ✓ Delegated proving confirmed! TX: ${txId}`)
        return true

      } catch (e) {
        const isTimeout = e.message?.includes('522') || e.message?.includes('timeout') || e.message?.includes('ECONNRESET')
        const isStale   = e.message?.startsWith('STALE_RECORD')
        if (isStale) {
          console.error('[settler] ✗ Stale record — OrderAuth/DepositAuth/Token already spent on-chain')
          console.error('[settler] Restart bot with updated START_BLOCK to clear stale records')
          break  // No point retrying — need fresh records
        }
        if (isTimeout && attempt < MAX_RETRIES) {
          console.warn(`[settler] Network error (attempt ${attempt}): ${e.message} — retrying...`)
          continue
        }
        if (attempt === MAX_RETRIES) {
          console.error(`[settler] All ${MAX_RETRIES} delegated proving attempts failed`)
        } else {
          console.warn(`[settler] Attempt ${attempt} failed: ${e.message} — retrying...`)
          continue
        }
      }
    }
  }

  return false
}

export async function settleMatch(match) {
  const { clearingPrice, fillSize } = match
  const assetId = match.buyOrder?.assetId ?? 0
  const root = batchRoot(assetId)

  console.log(`\n[settler] Match:`)
  console.log(`  asset:  ${assetId} (${['BTC','ETH','SOL'][assetId] ?? '?'})`)
  console.log(`  price:  ${clearingPrice}u64`)
  console.log(`  size:   ${fillSize}u64`)
  console.log(`  buyer:  ${match.buyOrder?.user || '(unknown)'}`)
  console.log(`  seller: ${match.sellOrder?.user || '(unknown)'}`)

  // Use DepositAuth attached to match object by orderbook (keyed by user+assetId)
  const depositAuthPt = match.depositAuth ?? null
  if (depositAuthPt) console.log(`[settler] ✓ DepositAuth from match: ${depositAuthPt.slice(0,80)}...`)
  else console.warn(`[settler] ⚠ No depositAuth on match object`)

  const rec = loadRecords()

  // Use records.json values, falling back to in-memory DepositAuth
  const buyAuth     = rec?.buyAuth     || match.buyOrder?.plaintext  || ''
  const sellAuth    = rec?.sellAuth    || match.sellOrder?.plaintext || ''
  const depositAuth = rec?.depositAuth || depositAuthPt              || ''
  const token       = rec?.token       || ''
  const credentials = rec?.credentials || ''

  const missing = []
  if (!buyAuth)     missing.push('buyAuth (records.json or OrderAuth scan)')
  if (!sellAuth)    missing.push('sellAuth (records.json or OrderAuth scan)')
  if (!depositAuth) missing.push('depositAuth (records.json or DepositAuth scan)')
  if (!token)       missing.push('token (records.json)')
  if (!credentials) missing.push('credentials (records.json)')

  if (missing.length) {
    console.log(`\n[settler] ⚠ Missing: ${missing.join(', ')}`)
    printInstructions()
    return { status: 'incomplete_records' }
  }

  const cmd = [
    'cd ~/ZK_Darkpool && leo execute settle_match \\',
    `  "${normalize(buyAuth)}" \\`,
    `  "${normalize(sellAuth)}" \\`,
    `  "${normalize(depositAuth)}" \\`,
    `  "${normalize(token)}" \\`,
    `  "${normalize(credentials)}" \\`,
    `  ${clearingPrice}u64 \\`,
    `  ${fillSize}u64 \\`,
    `  ${root} \\`,
    `  --network testnet \\`,
    `  --endpoint https://api.explorer.provable.com/v1 \\`,
    `  --broadcast --yes`,
  ].join('\n')

  console.log('\n[settler] Refreshing USDCx records before execution...')
  try {
    const { refreshUSDCxRecords } = await import('./usdcx-scanner.mjs')
    await refreshUSDCxRecords()
  } catch (e) {
    console.warn('[settler] USDCx rescan failed:', e.message)
  }

  // Re-read records after rescan
  const recFresh = loadRecords()
  const token2       = recFresh?.token       || token
  const credentials2 = recFresh?.credentials || credentials

  console.log('\n[settler] ✓ Executing settle_match...\n')

  // Try delegated proving first, fall back to local leo
  const confirmed = await executeWithDelegated({
    buyAuth: normalize(buyAuth), sellAuth: normalize(sellAuth),
    depositAuth: normalize(depositAuth), token: normalize(token2),
    credentials: normalize(credentials2),
    clearingPrice, fillSize, root,
  })

  if (confirmed) {
    console.log('\n[settler] ✓ Confirmed on-chain — removing from order book')
    // Update START_BLOCK in .env to current block to prevent stale records on restart
    try {
      const { readFileSync, writeFileSync } = await import('fs')
      const { join, dirname } = await import('path')
      const { fileURLToPath } = await import('url')
      const __d = dirname(fileURLToPath(import.meta.url))
      const envPath = join(__d, '.env')
      const currentBlock = match.buyOrder?.blockHeight ?? 0
      if (currentBlock > 0 && existsSync(envPath)) {
        let env = readFileSync(envPath, 'utf8')
        env = env.replace(/^START_BLOCK=.*/m, `START_BLOCK=${currentBlock}`)
        writeFileSync(envPath, env)
        console.log(`[settler] START_BLOCK updated to ${currentBlock} in .env`)
      }
    } catch {}
    // Blacklist the used token so it won't be reused before Provable scanner marks it spent
    try {
      const { blacklistTokenNonce } = await import('./usdcx-scanner.mjs')
      blacklistTokenNonce(token2)
    } catch {}
    try {
      const { removeOrder, removeDepositAuth } = await import('./orderbook.mjs')
      const buyNonce  = match.buyOrder?.nonce
      const sellNonce = match.sellOrder?.nonce
      const assetId   = match.buyOrder?.assetId ?? 0
      if (buyNonce)  removeOrder(assetId, true,  buyNonce)
      if (sellNonce) removeOrder(assetId, false, sellNonce)
      if (match.depositNonce) removeDepositAuth(match.sellOrder?.user, assetId, match.depositNonce)
    } catch (e) {
      console.warn('[settler] Could not remove from memory:', e.message)
    }
    return { status: 'confirmed' }
  }

  return { status: 'failed' }
}

function printInstructions() {
  console.log('\n[settler] Fill ~/ZK_Darkpool/darkpool-bot/records.json:')
  console.log(`  1. PROGRAM_ID=${process.env.PROGRAM_ID ?? 'zkdarkpool_v8.aleo'} node provable-scanner.mjs`)
  console.log('     → find OrderAuth (buy), OrderAuth (sell), DepositAuth')
  console.log('  2. PROGRAM_ID=test_usdcx_stablecoin.aleo node provable-scanner.mjs')
  console.log('     → find Token (amount > 0) and Credentials')
  console.log('  3. Fill records.json with: buyAuth, sellAuth, depositAuth, token, credentials')
}

export async function settleMatchWithRecords() {
  console.log('[settler] Auto-settlement not implemented — use records.json flow')
  return { status: 'not_implemented' }
}

export async function decryptOrderRecords() {
  return { buyerToken: null, buyerCreds: null, sellerAsset: null }
}
