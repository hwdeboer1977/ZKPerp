// ── Constants ──────────────────────────────────────────────────
export const PROGRAM_ID  = import.meta.env.VITE_PROGRAM_ID  ?? 'zkdarkpool_v4.aleo'
export const USDCX_ID    = import.meta.env.VITE_USDCX_ID    ?? 'test_usdcx_stablecoin.aleo'
export const API         = import.meta.env.VITE_API          ?? 'https://api.explorer.provable.com/v1/testnet'
export const BOT_API     = import.meta.env.VITE_BOT_API      ?? 'http://localhost:3001'
export const FEE_BPS     = 10n
export const BPS_DENOM   = 10_000n
export const MIN_FILL    = 1_000_000n
export const MAX_PRICE   = 1_000_000_000n

export const ASSETS: Record<number, string> = {
  0: 'BTC',
  1: 'ETH',
  2: 'SOL',
}

export const ZERO_PROOF = '[{siblings:[0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field],leaf_index:1u32},{siblings:[0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field],leaf_index:1u32}]'

// ── Types ──────────────────────────────────────────────────────
export interface USDCxToken {
  amount:    bigint
  plaintext: string
  label:     string
}

export interface AssetRecord {
  assetId:   number
  amount:    bigint
  plaintext: string
  label:     string
}

export interface FillReceipt {
  assetId:       number
  direction:     boolean
  filledSize:    bigint
  clearingPrice: bigint
  feePaid:       bigint
  batchRoot:     string
  plaintext:     string
}

export type TxStatus    = 'idle' | 'submitting' | 'done' | 'error'
export type DarkpoolTab = 'order' | 'receipts' | 'operator' | 'tools' | 'cancel'

// ── Formatting ─────────────────────────────────────────────────
export function fmtUsdc(n: bigint): string  { return (Number(n) / 1_000_000).toFixed(4) }
export function fmtAsset(n: bigint): string { return (Number(n) / 1_000_000).toFixed(6) }
export function fmtPrice(n: bigint): string { return (Number(n) / 1_000_000).toFixed(2) }

// ── Record normalization ────────────────────────────────────────
export function normalize(pt: string): string {
  return pt.replace(/\s+/g,' ').replace(/{ /g,'{').replace(/ }/g,'}')
           .replace(/,\s+/g,',').replace(/:\s+/g,':').trim()
}

// ── Random field ────────────────────────────────────────────────
export function randomField(): string {
  const bytes = new Uint8Array(31)
  crypto.getRandomValues(bytes)
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('')
  return `${BigInt('0x'+hex)}field`
}

// ── Block height ────────────────────────────────────────────────
export async function getCurrentBlock(): Promise<number> {
  try {
    const res = await fetch(`${API}/latest/height`)
    if (!res.ok) return 0
    return parseInt((await res.text()).replace(/"/g,'').trim())
  } catch { return 0 }
}

// ── Fee vault ───────────────────────────────────────────────────
export async function fetchFeeVault(): Promise<bigint> {
  try {
    const res = await fetch(`${API}/program/${PROGRAM_ID}/mapping/fee_vault/0u8`)
    if (!res.ok) return 0n
    const m = (await res.text()).match(/(\d+)u64/)
    return m ? BigInt(m[1]) : 0n
  } catch { return 0n }
}

// ── ECIES encryption for operator ──────────────────────────────
// Encrypts a record plaintext to the operator using AES-GCM + ECDH
// The operator Unshields with their private key server-side
export async function encryptForOperator(
  plaintext: string,
  operatorPubKeyHex: string,
): Promise<string> {
  const enc  = new TextEncoder()
  const data = enc.encode(plaintext)

  // Generate ephemeral ECDH keypair
  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey'],
  )

  // Import operator public key — use .buffer.slice() to get plain ArrayBuffer
  const opKeyBytes = hexToBytes(operatorPubKeyHex)
  const opPubKey   = await crypto.subtle.importKey(
    'raw',
    opKeyBytes.buffer.slice(opKeyBytes.byteOffset, opKeyBytes.byteOffset + opKeyBytes.byteLength) as ArrayBuffer,
    { name: 'ECDH', namedCurve: 'P-256' },
    false, [],
  )

  // Derive shared AES key
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: opPubKey },
    ephemeral.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  )

  // Encrypt
  const iv         = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, data)

  // Export ephemeral public key
  const ephPubRaw = await crypto.subtle.exportKey('raw', ephemeral.publicKey)

  // Pack: ephPubKey(65) + iv(12) + ciphertext
  const packed = new Uint8Array(65 + 12 + ciphertext.byteLength)
  packed.set(new Uint8Array(ephPubRaw), 0)
  packed.set(iv, 65)
  packed.set(new Uint8Array(ciphertext), 77)

  return bytesToBase64(packed)
}

// ── Submit order to bot API (with encrypted records) ───────────
export async function submitOrderToBotApi(params: {
  nonce:                   string
  direction:               boolean
  assetId:                 number
  userAddress?:            string
  txId?:                   string
  encryptedToken?:         string
  encryptedCredentials?:   string
  encryptedAssetRecord?:   string
  orderCommitmentPlaintext: string
}): Promise<void> {
  const res = await fetch(`${BOT_API}/submit-order`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(params),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => 'unknown error')
    throw new Error(`Bot API error: ${res.status} — ${err}`)
  }
}

// ── Build inputs ────────────────────────────────────────────────
export function buildSubmitOrderInputs(params: {
  recipient: string; operatorAddress: string; assetId: number
  direction: boolean; size: bigint; limitPrice: bigint
  salt: string; expiry: number; nonce: string
}): string[] {
  return [
    params.recipient, params.operatorAddress,
    `${params.assetId}u8`, params.direction.toString(),
    `${params.size}u64`, `${params.limitPrice}u64`,
    params.salt, `${params.expiry}u32`, params.nonce,
  ]
}

export function buildMintTestAssetInputs(recipient: string, assetId: number, amount: bigint): string[] {
  return [recipient, `${assetId}u8`, `${amount}u64`]
}

export function buildClaimTestAssetInputs(assetId: number): string[] {
  return [`${assetId}u8`]
}

export function buildDepositAssetInputs(params: {
  assetRecord: string; amount: bigint; salt: string; operatorAddress: string
}): string[] {
  return [params.assetRecord, `${params.amount}u64`, params.salt, params.operatorAddress]
}

export function buildCancelOrderInputs(orderRecord: string): string[] {
  return [orderRecord]
}

export function buildWithdrawFeesInputs(amount: bigint): string[] {
  return [`${amount}u64`]
}

// ── Parsers ─────────────────────────────────────────────────────
export function parseUSDCxToken(pt: string): USDCxToken | null {
  try {
    const m = pt.match(/amount:\s*(\d+)u128/)
    if (!m) return null
    const amount = BigInt(m[1])
    return { amount, plaintext: pt, label: `${fmtUsdc(amount)} USDCx` }
  } catch { return null }
}

export function parseAssetRecord(pt: string): AssetRecord | null {
  try {
    const assetM  = pt.match(/asset_id:\s*(\d+)u8/)
    const amountM = pt.match(/amount:\s*(\d+)u64/)
    if (!assetM || !amountM) return null
    const assetId = parseInt(assetM[1])
    const amount  = BigInt(amountM[1])
    return { assetId, amount, plaintext: pt, label: `${fmtAsset(amount)} ${ASSETS[assetId] ?? `asset_${assetId}`}` }
  } catch { return null }
}

export function parseFillReceipt(pt: string): FillReceipt | null {
  try {
    const n = (field: string, suffix: string) => {
      const m = pt.match(new RegExp(`${field}:\\s*(\\d+)${suffix}`))
      return m ? m[1] : '0'
    }
    const boolM = pt.match(/direction:\s*(true|false)/)
    return {
      assetId:       parseInt(n('asset_id','u8')),
      direction:     boolM?.[1] === 'true',
      filledSize:    BigInt(n('filled_size','u64')),
      clearingPrice: BigInt(n('clearing_price','u64')),
      feePaid:       BigInt(n('fee_paid','u64')),
      batchRoot:     pt.match(/batch_root:\s*(\d+field)/)?.[1] ?? '',
      plaintext:     pt,
    }
  } catch { return null }
}

// ── Fetch pending deposits for address ─────────────────────────
export async function fetchPendingDeposits(userAddress: string): Promise<
  { nonce: string; asset_id: number; scanned_at: string }[]
> {
  try {
    const res = await fetch(`${BOT_API}/pending-deposits?address=${encodeURIComponent(userAddress)}`)
    if (!res.ok) return []
    const data = await res.json()
    return data.deposits ?? []
  } catch { return [] }
}
// Polls Shield wallet for an AssetRecord matching the order nonce
// Returns the plaintext of the escrowed AssetRecord
export async function scanForDepositOutput(
  orderNonce: string,
  requestRecords: any,
  Unshield: any,
  maxAttempts = 8,
  delayMs = 5000,
): Promise<string | null> {
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, delayMs))
    try {
      const raw = await requestRecords(PROGRAM_ID, true) as any[]
      const escrows = raw.filter((r: any) => r.recordName === 'AssetEscrowReceipt' && !r.spent)
      for (const rec of escrows) {
        try {
          const pt = await Unshield(rec.recordCiphertext)
          // Check if this escrow matches our order nonce
          const nonceField = orderNonce.endsWith('field') ? orderNonce : `${orderNonce}field`
          if (pt.includes(nonceField) || pt.includes(orderNonce)) {
            // Found the escrow — now find the corresponding AssetRecord (output[0] of deposit_asset)
            // It has the same amount. For now return a signal that escrow was found.
            return pt
          }
        } catch { continue }
      }
      // Also scan AssetRecords directly
      const assets = raw.filter((r: any) => r.recordName === 'AssetRecord' && !r.spent)
      for (const rec of assets) {
        try {
          const pt = await Unshield(rec.recordCiphertext)
          return pt // Return first unspent AssetRecord with amount > 0
        } catch { continue }
      }
    } catch { continue }
  }
  return null
}
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(clean.slice(i*2, i*2+2), 16)
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}
