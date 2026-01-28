import { useState, useCallback } from 'react';
import { useWallet } from '@demox-labs/aleo-wallet-adapter-react';
import { PROGRAM_IDS } from '../utils/config';


const PROGRAM_ID = PROGRAM_IDS.ZKPERP;

export interface LPTokenRecord {
  id: string;
  owner: string;
  amount: bigint;
  spent: boolean;
  rawRecord: any; // Keep the raw record for transaction building
}

export function useLPTokens() {
  const { publicKey, requestRecords } = useWallet();
  const [lpTokens, setLpTokens] = useState<LPTokenRecord[]>([]);
  const [totalLP, setTotalLP] = useState<bigint>(BigInt(0));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLPTokens = useCallback(async () => {
    if (!publicKey || !requestRecords) {
      setLpTokens([]);
      setTotalLP(BigInt(0));
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Request all records from the zkperp program
      const records = await requestRecords(PROGRAM_ID);
      
      console.log('Fetched records:', records);

      // Filter for LPToken records that aren't spent
      const lpRecords: LPTokenRecord[] = [];
      let total = BigInt(0);

      for (const record of records) {
        // Check if this is an LPToken record
        if (record.recordName === 'LPToken' && !record.spent) {
          const amount = parseLeoU64(record.data?.amount);
          lpRecords.push({
            id: record.id || record.nonce || '',
            owner: record.owner || publicKey,
            amount,
            spent: record.spent || false,
            rawRecord: record,
          });
          total += amount;
        }
      }

      setLpTokens(lpRecords);
      setTotalLP(total);
    } catch (err) {
      console.error('Failed to fetch LP tokens:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch LP tokens');
    } finally {
      setLoading(false);
    }
  }, [publicKey, requestRecords]);

  return {
    lpTokens,
    totalLP,
    loading,
    error,
    refresh: fetchLPTokens,
  };
}

// Parse Leo u64 value from record data
function parseLeoU64(value: string | undefined): bigint {
  if (!value) return BigInt(0);
  
  // Remove quotes and type suffix
  const cleaned = value.replace(/['"]/g, '').replace(/u64\.private$/, '').replace(/u64$/, '');
  
  try {
    return BigInt(cleaned);
  } catch {
    return BigInt(0);
  }
}

// Format LP tokens for display (6 decimals like USDC)
export function formatLPTokens(amount: bigint): string {
  const value = Number(amount) / 1_000_000;
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
