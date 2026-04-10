// ============================================================
// config.mjs — shared config for all bot modules
// ============================================================

import 'dotenv/config'

export const NETWORK          = process.env.NETWORK          ?? 'testnet'
export const API              = process.env.API              ?? 'https://api.explorer.provable.com/v1/testnet'
export const PROGRAM_ID       = process.env.PROGRAM_ID       ?? 'zkdarkpool_v5.aleo'
export const USDCX_ID         = process.env.USDCX_ID         ?? 'test_usdcx_stablecoin.aleo'
export const OPERATOR_PK      = process.env.OPERATOR_PRIVATE_KEY ?? ''
export const OPERATOR_VK      = process.env.OPERATOR_VIEW_KEY    ?? ''
export const OPERATOR_ADDRESS = process.env.OPERATOR_ADDRESS     ?? ''
export const BATCH_BLOCKS     = parseInt(process.env.BATCH_BLOCKS     ?? '30')
export const POLL_MS          = parseInt(process.env.POLL_INTERVAL_MS ?? '15000')
export const FEE              = parseInt(process.env.FEE_PER_TX       ?? '3000000')
export const START_BLOCK      = parseInt(process.env.START_BLOCK      ?? '0')
export const PORT             = parseInt(process.env.BOT_PORT         ?? '3001')

// Protocol constants — must match the Leo contract
export const MIN_FILL_SIZE    = 1_000_000n  // 1 USDCx
export const FEE_BPS          = 10n
export const BPS_DENOM        = 10_000n

if (!OPERATOR_PK)      throw new Error('OPERATOR_PRIVATE_KEY not set in .env')
if (!OPERATOR_VK)      throw new Error('OPERATOR_VIEW_KEY not set in .env')
if (!OPERATOR_ADDRESS) throw new Error('OPERATOR_ADDRESS not set in .env')
