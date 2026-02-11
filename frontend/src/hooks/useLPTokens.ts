import { useState, useCallback } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import { PROGRAM_IDS } from '../utils/config';

const PROGRAM_ID = PROGRAM_IDS.ZKPERP;

export interface LPTokenRecord {
  id: string;
  owner: string;
  amount: bigint;
  spent: boolean;
  rawRecord: any;
}

export function useLPTokens() {
  const { address, requestRecords } = useWallet();
  const [lpTokens, setLpTokens] = useState<LPTokenRecord[]>([]);
  const [totalLP, setTotalLP] = useState<bigint>(BigInt(0));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLPTokens = useCallback(async () => {
    if (!address || !requestRecords) {
      setLpTokens([]);
      setTotalLP(BigInt(0));
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const records = await requestRecords(PROGRAM_ID);
      console.log('Fetched records:', records);

      const lpRecords: LPTokenRecord[] = [];
      let total = BigInt(0);

      records.forEach((record: any) => {
        if (record.recordName === 'LPToken' && !record.spent) {
          const amount = parseLeoU64(record.data?.amount);
          lpRecords.push({
            id: record.id || record.nonce || '',
            owner: record.owner || address,
            amount,
            spent: record.spent || false,
            rawRecord: record,
          });
          total += amount;
        }
      });

      setLpTokens(lpRecords);
      setTotalLP(total);
    } catch (err) {
      console.error('Failed to fetch LP tokens:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch LP tokens');
    } finally {
      setLoading(false);
    }
  }, [address, requestRecords]);

  return {
    lpTokens,
    totalLP,
    loading,
    error,
    refresh: fetchLPTokens,
  };
}

function parseLeoU64(value: string | undefined): bigint {
  if (!value) return BigInt(0);
  const cleaned = value.replace(/['"]/g, '').replace(/u64\.private$/, '').replace(/u64$/, '');
  try {
    return BigInt(cleaned);
  } catch {
    return BigInt(0);
  }
}

export function formatLPTokens(amount: bigint): string {
  const value = Number(amount) / 1_000_000;
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}