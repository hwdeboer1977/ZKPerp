// src/config/pairs.ts
// Single source of truth for all trading pairs.
// Add a new pair here and routes/UI update automatically.

export type PairId = 'btc' | 'eth' | 'sol';

export interface PairConfig {
  id: PairId;
  label: string;            // e.g. "BTC/USDC"
  baseAsset: string;        // e.g. "BTC"
  programId: string;        // The zkperp Leo program for this pair
  oracleMappingKey: string; // key in the oracle mapping
  poolMappingKey: string;   // key in pool_state mapping (0field, 1field, 2field)
  defaultPrice: bigint;     // fallback for test/devnet
  color: string;            // hex accent for charts / UI
}

export const PAIRS: Record<PairId, PairConfig> = {
  btc: {
    id: 'btc',
    label: 'BTC/USDC',
    baseAsset: 'BTC',
    programId: import.meta.env.VITE_PROGRAM_ID_BTC ?? 'zkperp_v19.aleo',
    oracleMappingKey: '0field',
    poolMappingKey: '0field',
    defaultPrice: BigInt(6_742_000_000_000),
    color: '#F7931A',
  },
  eth: {
    id: 'eth',
    label: 'ETH/USDC',
    baseAsset: 'ETH',
    programId: import.meta.env.VITE_PROGRAM_ID_ETH ?? 'zkperp_v19b.aleo',
    oracleMappingKey: '0field',
    poolMappingKey: '0field',
    defaultPrice: BigInt(352_400_000_000),
    color: '#627EEA',
  },
  sol: {
    id: 'sol',
    label: 'SOL/USDC',
    baseAsset: 'SOL',
    programId: import.meta.env.VITE_PROGRAM_ID_SOL ?? 'zkperp_v19c.aleo',
    oracleMappingKey: '0field',
    poolMappingKey: '0field',
    defaultPrice: BigInt(14_280_000_000),
    color: '#9945FF',
  },
};

export const PAIR_IDS = Object.keys(PAIRS) as PairId[];

export function getPair(id: string): PairConfig {
  if (id in PAIRS) return PAIRS[id as PairId];
  return PAIRS.btc; // fallback
}
