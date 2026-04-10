// Run once to generate the operator's P-256 keypair for ECIES encryption
// Add OPERATOR_ECIES_PRIVATE_KEY to bot .env
// Add VITE_OPERATOR_PUBKEY_HEX to frontend .env

const { subtle } = globalThis.crypto

const keypair = await subtle.generateKey(
  { name: 'ECDH', namedCurve: 'P-256' },
  true,
  ['deriveKey'],
)

const pubRaw  = await subtle.exportKey('raw',   keypair.publicKey)
const privRaw = await subtle.exportKey('pkcs8', keypair.privateKey)

const pubHex  = Buffer.from(pubRaw).toString('hex')
const privB64 = Buffer.from(privRaw).toString('base64')

console.log('\n=== Operator ECIES Keypair ===\n')
console.log('Add to FRONTEND .env:')
console.log(`VITE_OPERATOR_PUBKEY_HEX=${pubHex}`)
console.log()
console.log('Add to BOT .env:')
console.log(`OPERATOR_ECIES_PRIVATE_KEY=${privB64}`)
console.log()
