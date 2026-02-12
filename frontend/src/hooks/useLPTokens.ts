import { useState, useCallback } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import { PROGRAM_IDS } from '../utils/config';

const PROGRAM_ID = PROGRAM_IDS.ZKPERP;
const MIN_DUST = BigInt(10000); // $0.01 — filter out dust records

export interface LPTokenRecord {
  id: string;
  owner: string;
  amount: bigint;
  spent: boolean;
  plaintext: string;
  rawRecord: any;
}

export function useLPTokens() {
  const { address, requestRecords, decrypt } = useWallet();
  const [lpTokens, setLpTokens] = useState<LPTokenRecord[]>([]);
  const [totalLP, setTotalLP] = useState<bigint>(BigInt(0));
  const [recordCount, setRecordCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [decrypting, setDecrypting] = useState(false);
  const [decrypted, setDecrypted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Raw (encrypted) records stored between fetch and decrypt
  const [rawRecords, setRawRecords] = useState<any[]>([]);

  // Phase 1: Fetch records from wallet (1 popup) — no decryption
  const fetchRecords = useCallback(async () => {
    if (!address || !requestRecords) {
      setLpTokens([]);
      setTotalLP(BigInt(0));
      setRecordCount(0);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const records = await requestRecords(PROGRAM_ID);
      console.log('Fetched records:', records);

      const lpRecordsRaw = records.filter(
        (r: any) => r.recordName === 'LPToken' && !r.spent
      );

      setRawRecords(lpRecordsRaw);
      setRecordCount(lpRecordsRaw.length);
      setDecrypted(false);
      setLpTokens([]);
      setTotalLP(BigInt(0));
    } catch (err) {
      console.error('Failed to fetch LP records:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch LP records');
    } finally {
      setLoading(false);
    }
  }, [address, requestRecords]);

  // Phase 2: Decrypt all records (batch — user clicks "Show Records")
  const decryptAll = useCallback(async () => {
    if (!decrypt || rawRecords.length === 0) return;

    setDecrypting(true);
    setError(null);

    try {
      // Batch decrypt with Promise.all — may be 1 popup or N popups depending on Shield
      const plaintexts = await Promise.all(
        rawRecords.map(async (record) => {
          try {
            // Try data first (no decrypt needed)
            if (record.data?.amount) {
              const amount = parseLeoU64(record.data.amount);
              const pt = `{\n  owner: ${record.owner || address}.private,\n  amount: ${record.data.amount},\n  _nonce: ${record.nonce || '0group.public'}\n}`;
              return { record, plaintext: pt, amount };
            }
            // Decrypt ciphertext
            if (record.recordCiphertext) {
              const plaintext = await decrypt(record.recordCiphertext);
              console.log('Decrypted LP record:', plaintext);
              const amountMatch = plaintext.match(/amount:\s*(\d+)u64/);
              const amount = amountMatch ? BigInt(amountMatch[1]) : BigInt(0);
              return { record, plaintext, amount };
            }
            return { record, plaintext: '', amount: BigInt(0) };
          } catch (err) {
            console.warn('Could not decrypt record:', err);
            return { record, plaintext: '', amount: BigInt(0) };
          }
        })
      );

      const lpRecords: LPTokenRecord[] = [];
      let total = BigInt(0);

      for (const { record, plaintext, amount } of plaintexts) {
        if (amount <= MIN_DUST) continue; // Filter dust

        lpRecords.push({
          id: record.commitment || record.id || record.nonce || '',
          owner: record.sender || record.owner || address,
          amount,
          spent: false,
          plaintext,
          rawRecord: record,
        });
        total += amount;
      }

      console.log('LP tokens decrypted:', lpRecords.length, 'Total:', total.toString());
      setLpTokens(lpRecords);
      setTotalLP(total);
      setDecrypted(true);
    } catch (err) {
      console.error('Failed to decrypt LP records:', err);
      setError(err instanceof Error ? err.message : 'Failed to decrypt LP records');
    } finally {
      setDecrypting(false);
    }
  }, [decrypt, rawRecords, address]);

  return {
    lpTokens,
    totalLP,
    recordCount,
    loading,
    decrypting,
    decrypted,
    error,
    fetchRecords,
    decryptAll,
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
