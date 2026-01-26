import { useState, useEffect, useCallback } from 'react';
import { PROGRAM_ID } from '@/utils/aleo';

// Aleo Testnet API endpoint
const API_BASE = 'https://api.explorer.provable.com/v1/testnet';

export interface PoolState {
  total_liquidity: bigint;
  total_lp_tokens: bigint;
  long_open_interest: bigint;
  short_open_interest: bigint;
  accumulated_fees: bigint;
}

export interface PriceData {
  price: bigint;
  timestamp: number;
}

// Parse Aleo struct response into typed object
function parsePoolState(raw: string): PoolState | null {
  try {
    // Response format: { total_liquidity: 100u64, total_lp_tokens: 100u64, ... }
    const cleaned = raw.replace(/\s+/g, '');
    
    const extract = (key: string): bigint => {
      const regex = new RegExp(`${key}:(\\d+)u64`);
      const match = cleaned.match(regex);
      return match ? BigInt(match[1]) : BigInt(0);
    };

    return {
      total_liquidity: extract('total_liquidity'),
      total_lp_tokens: extract('total_lp_tokens'),
      long_open_interest: extract('long_open_interest'),
      short_open_interest: extract('short_open_interest'),
      accumulated_fees: extract('accumulated_fees'),
    };
  } catch (err) {
    console.error('Failed to parse pool state:', err);
    return null;
  }
}

function parsePriceData(raw: string): PriceData | null {
  try {
    // Response format: { price: 10000000000u64, timestamp: 123u32 }
    const cleaned = raw.replace(/\s+/g, '');
    
    const priceMatch = cleaned.match(/price:(\d+)u64/);
    const timestampMatch = cleaned.match(/timestamp:(\d+)u32/);
    
    if (!priceMatch) return null;
    
    return {
      price: BigInt(priceMatch[1]),
      timestamp: timestampMatch ? parseInt(timestampMatch[1]) : 0,
    };
  } catch (err) {
    console.error('Failed to parse price data:', err);
    return null;
  }
}

export function useOnChainData() {
  const [poolState, setPoolState] = useState<PoolState | null>(null);
  const [priceData, setPriceData] = useState<PriceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPoolState = useCallback(async () => {
    try {
      // Query pool_state mapping at key 0field
      const response = await fetch(
        `${API_BASE}/program/${PROGRAM_ID}/mapping/pool_state/0field`
      );
      
      if (!response.ok) {
        if (response.status === 404) {
          // Mapping entry doesn't exist yet (no liquidity added)
          setPoolState({
            total_liquidity: BigInt(0),
            total_lp_tokens: BigInt(0),
            long_open_interest: BigInt(0),
            short_open_interest: BigInt(0),
            accumulated_fees: BigInt(0),
          });
          return;
        }
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.text();
      const parsed = parsePoolState(data);
      if (parsed) {
        setPoolState(parsed);
      }
    } catch (err) {
      console.error('Failed to fetch pool state:', err);
      setError('Failed to fetch pool state');
    }
  }, []);

  const fetchPriceData = useCallback(async () => {
    try {
      // Query oracle_prices mapping at key 0field (BTC)
      const response = await fetch(
        `${API_BASE}/program/${PROGRAM_ID}/mapping/oracle_prices/0field`
      );
      
      if (!response.ok) {
        if (response.status === 404) {
          // No price set yet
          setPriceData(null);
          return;
        }
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.text();
      const parsed = parsePriceData(data);
      if (parsed) {
        setPriceData(parsed);
      }
    } catch (err) {
      console.error('Failed to fetch price data:', err);
      setError('Failed to fetch oracle price');
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    
    await Promise.all([fetchPoolState(), fetchPriceData()]);
    
    setLoading(false);
  }, [fetchPoolState, fetchPriceData]);

  // Initial fetch
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [refresh]);

  return {
    poolState,
    priceData,
    loading,
    error,
    refresh,
  };
}
