import { useState, useCallback } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import { USDCX_PROGRAM_ID, PROGRAM_ID } from '@/utils/aleo';

export interface USDCxRecord {
  id: string;
  amount: bigint;
  plaintext: string;
  ciphertext: string;
  rawRecord: any;
}

export function useUSDCx() {
  // Use same API as useLPTokens — requestRecords + decrypt (Promise.all for batch)
  // requestRecordPlaintexts is NOT used — not available in all Shield Wallet versions
  const { address, requestRecords, decrypt } = useWallet();

  const [tokens, setTokens]     = useState<USDCxRecord[]>([]);
  const [total, setTotal]       = useState(0n);
  const [loading, setLoading]   = useState(false);
  const [decrypted, setDecrypted] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [spentIds, setSpentIds] = useState<Set<string>>(new Set());

  const fetchAndDecrypt = useCallback(async () => {
    if (!address || !requestRecords || !decrypt) return;
    setLoading(true);
    setError(null);
    try {
      // Shield Wallet returns ALL records for connected programs.
      // Try USDCX_PROGRAM_ID first; if the program wasn't registered at connect time
      // it returns 0 records — fall back to PROGRAM_ID which is always connected.
      let records: any[] = [];

      try {
        records = await requestRecords(USDCX_PROGRAM_ID, true);
        console.log(`[useUSDCx] requestRecords(${USDCX_PROGRAM_ID}): ${records.length} records`);
      } catch (e) {
        console.warn('[useUSDCx] USDCX_PROGRAM_ID failed, trying PROGRAM_ID:', e);
      }

      if (records.length === 0) {
        records = await requestRecords(PROGRAM_ID, true);
        console.log(`[useUSDCx] fallback requestRecords(${PROGRAM_ID}): ${records.length} records`);
      }

      // Log full breakdown to diagnose balance discrepancies
      const allToken = records.filter((r: any) => r.recordName === 'Token');
      const unspent  = allToken.filter((r: any) => !r.spent);
      const spent    = allToken.filter((r: any) =>  r.spent);
      console.log(`[useUSDCx] Token: ${allToken.length} total, ${unspent.length} unspent, ${spent.length} wallet-marked-spent`);
      console.log('[useUSDCx] All record names:', records.map((r: any) => r.recordName).join(', '));
      if (spent.length > 0) {
        console.log('[useUSDCx] Spent (excluded):', spent.map((r: any) => r.commitment?.slice(0, 20)));
      }

      if (unspent.length === 0) {
        setTokens([]);
        setTotal(0n);
        setDecrypted(true);
        return;
      }

      // Promise.all fires all decrypt calls simultaneously → Shield Wallet
      // batches them into ONE approval prompt (same as useLPTokens pattern)
      const results = await Promise.all(
        unspent.map(async (r: any) => {
          try {
            const plaintext = await decrypt(r.recordCiphertext);
            const amtMatch  = plaintext.match(/amount:\s*(\d+)u128/);
            const amount    = BigInt(amtMatch?.[1] || '0');
            const id        = r.commitment || r.id || r.nonce || Math.random().toString();
            console.log(`[useUSDCx] $${(Number(amount) / 1_000_000).toFixed(2)} id=${id.slice(0, 16)}`);
            return { id, amount, plaintext, ciphertext: r.recordCiphertext, rawRecord: r } as USDCxRecord;
          } catch {
            return null;
          }
        })
      );

      const parsed = results.filter((r): r is USDCxRecord => r !== null);

      // Sort largest first — deposit consumes one record, biggest = most flexible
      const filtered = parsed
        .filter(t => !spentIds.has(t.id))
        .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
      const sum = filtered.reduce((acc, t) => acc + t.amount, 0n);

      console.log(`[useUSDCx] Final: ${filtered.length} records, total $${(Number(sum) / 1_000_000).toFixed(2)}`);
      setTokens(filtered);
      setTotal(sum);
      setDecrypted(true);
    } catch (e: any) {
      console.error('[useUSDCx] error:', e);
      setError(e?.message || 'Failed to load USDCx records');
    } finally {
      setLoading(false);
    }
  }, [address, requestRecords, decrypt, spentIds]);

  const markSpent = useCallback((id: string) => {
    setSpentIds(prev => new Set([...prev, id]));
    setTokens(prev => {
      const updated = prev.filter(t => t.id !== id);
      setTotal(updated.reduce((acc, t) => acc + t.amount, 0n));
      return updated;
    });
  }, []);

  return { tokens, total, loading, decrypted, error, fetchAndDecrypt, markSpent };
}
