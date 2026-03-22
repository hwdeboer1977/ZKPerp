// src/hooks/useOnChainData.ts
import { useState, useEffect, useCallback } from 'react';
import { getPair } from '@/config/pairs';
import type { PairId } from '@/config/pairs';

const EXPLORER_BASE = 'https://api.explorer.provable.com/v1/testnet';

interface PoolState {
  total_liquidity: bigint;
  total_lp_tokens: bigint;
  long_open_interest: bigint;
  short_open_interest: bigint;
}

interface PriceData {
  price: bigint;
}

interface OnChainData {
  poolState: PoolState | null;
  priceData: PriceData | null;
  availableLiquidity: bigint;
  loading: boolean;
  refresh: () => void;
}

// The API returns values as a JSON-encoded string, e.g.:
//   "{\n  price: 7000000000000u64,\n  timestamp: 1u32\n}"
// JSON.parse unwraps the outer quotes, then we strip whitespace before regex matching.
function parseMapping(responseText: string): string {
  try {
    const inner = JSON.parse(responseText); // unwrap outer JSON string
    return typeof inner === 'string' ? inner.replace(/\s+/g, '') : responseText.replace(/\s+/g, '');
  } catch {
    return responseText.replace(/\s+/g, '');
  }
}

function extractU64(cleaned: string, key: string): bigint {
  const m = cleaned.match(new RegExp(`${key}:(\\d+)u64`));
  return m ? BigInt(m[1]) : 0n;
}

export function useOnChainData(pair: PairId = 'btc'): OnChainData {
  const pairConfig = getPair(pair);

  const [poolState, setPoolState] = useState<PoolState | null>(null);
  const [priceData, setPriceData] = useState<PriceData | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // ── Pool state ────────────────────────────────────────────────────────
      const poolRes = await fetch(
        `${EXPLORER_BASE}/program/${pairConfig.programId}/mapping/pool_state/0field`
      );
      if (poolRes.ok) {
        const cleaned = parseMapping(await poolRes.text());
        setPoolState({
          total_liquidity:    extractU64(cleaned, 'total_liquidity'),
          total_lp_tokens:    extractU64(cleaned, 'total_lp_tokens'),
          long_open_interest: extractU64(cleaned, 'long_open_interest'),
          short_open_interest: extractU64(cleaned, 'short_open_interest'),
        });
      } else {
        setPoolState(null);
      }

      // ── Oracle price ──────────────────────────────────────────────────────
      // Mapping name is oracle_prices (plural), key is always 0field per program.
      const priceRes = await fetch(
        `${EXPLORER_BASE}/program/${pairConfig.programId}/mapping/oracle_prices/${pairConfig.oracleMappingKey}`
      );
      if (priceRes.ok) {
        const cleaned = parseMapping(await priceRes.text());
        console.log(`[useOnChainData][${pair}] oracle_prices cleaned:`, cleaned);
        const price = extractU64(cleaned, 'price');
        if (price > 0n) setPriceData({ price });
        else setPriceData(null);
      } else {
        console.warn(`[useOnChainData][${pair}] oracle_prices fetch failed:`, priceRes.status);
        setPriceData(null);
      }
    } catch (e) {
      console.error(`[useOnChainData][${pair}] fetch error:`, e);
    } finally {
      setLoading(false);
    }
  }, [pair, pairConfig.programId, pairConfig.oracleMappingKey]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const totalLiquidity = poolState?.total_liquidity ?? 0n;
  const longOI = poolState?.long_open_interest ?? 0n;
  const shortOI = poolState?.short_open_interest ?? 0n;
  const totalOI = longOI + shortOI;
  const buffer = (totalLiquidity * 100_000n) / 1_000_000n;
  const minRemaining = totalOI + buffer;
  const availableLiquidity = totalLiquidity > minRemaining ? totalLiquidity - minRemaining : 0n;

  return {
    poolState,
    priceData,
    availableLiquidity,
    loading,
    refresh: fetchData,
  };
}
