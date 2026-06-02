/**
 * crash-price.mjs
 * Submits a fake BTC price of $50,000 to zkperp_oracle_v4.aleo
 * Used to trigger liquidation demo.
 * Run: node crash-price.mjs
 */

import dotenv from 'dotenv';
dotenv.config();

import { submitPriceOnChain } from './shared/aleoClient.js';

const ORACLE_PROGRAM = 'zkperp_oracle_v4.aleo';
const BTC_ASSET_KEY  = '1field';
const CRASH_PRICE    = 5000000000000n; // $50,000 with 8 decimals

const EXPLORER_API = process.env.ALEO_EXPLORER_API || 'https://api.explorer.provable.com/v1';
const ALEO_NETWORK = process.env.ALEO_NETWORK || 'testnet';

async function getBlock() {
  const res = await fetch(`${EXPLORER_API}/${ALEO_NETWORK}/latest/height`);
  return Number(await res.json());
}

const RELAYERS = [
  { name: 'A', privateKey: process.env.ALEO_PRIVATE_KEY_A },
  { name: 'B', privateKey: process.env.ALEO_PRIVATE_KEY_B },
];

console.log('💥 ZKPerp Price Crash Script');
console.log(`   Target price: $50,000`);
console.log(`   Oracle: ${ORACLE_PROGRAM}`);
console.log(`   Asset: BTC (1field)\n`);

const block = await getBlock();
console.log(`Current block: ${block}\n`);

for (const relayer of RELAYERS) {
  console.log(`Relayer-${relayer.name} submitting crash price...`);
  try {
    const { txId, status } = await submitPriceOnChain({
      privateKey: relayer.privateKey,
      program:    ORACLE_PROGRAM,
      assetKey:   BTC_ASSET_KEY,
      price:      CRASH_PRICE,
      timestamp:  block,
    });
    console.log(`Relayer-${relayer.name}: ${status} (${txId})`);
    if (status === 'accepted') {
      console.log(`✅ Relayer-${relayer.name} vote confirmed\n`);
    }
  } catch (err) {
    console.error(`❌ Relayer-${relayer.name} failed: ${err.message}`);
  }
}

console.log('\n💥 Price crash submitted — BTC should now show $50,000');
console.log('   Bot will detect undercollateralized positions and liquidate.');
console.log('   Run: pm2 start zkperp-bot-btc to trigger liquidation.');
