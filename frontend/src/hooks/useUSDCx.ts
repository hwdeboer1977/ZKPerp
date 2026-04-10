// src/hooks/useUSDCx.ts
//
// Dual-mode hook — original self-fetch behaviour fully preserved:
//
// MODE A — no argument: useUSDCx()
//   LiquidityPage and any standalone caller.
//   fetchAndDecrypt() calls requestRecords(USDCX_PROGRAM_ID, true) itself.
//   This is the original working behaviour — unchanged.
//
// MODE B — injected records: useUSDCx(rawRecords)
//   Called by PrivateDataContext for TradePage.
//   fetchAndDecrypt() decrypts the injected slice — no requestRecords call.
//   Auto-decrypts when the injected slice changes (stable key to avoid loops).

import { useState, useCallback, useEffect } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import { USDCX_PROGRAM_ID, PROGRAM_ID } from '@/utils/aleo';

// Minimal type for injected records from useWalletRecords.
// Kept inline so LiquidityPage has no dependency on useWalletRecords.
interface RawRecord {
  recordName?: string;
  commitment?: string;
  id?: string;
  nonce?: string;
  recordCiphertext?: string;
  programId?: string;
  spent?: boolean;
  [key: string]: any;
}

export interface USDCxRecord {
  id: string;
  amount: bigint;
  plaintext: string;
  ciphertext: string;
  rawRecord: any;
}

export function useUSDCx(rawRecords?: RawRecord[]) {
  const { address, requestRecords, decrypt } = useWallet();

  const selfFetchMode = rawRecords === undefined;

  const [tokens, setTokens]       = useState<USDCxRecord[]>([]);
  const [total, setTotal]         = useState(0n);
  const [loading, setLoading]     = useState(false);
  const [decrypted, setDecrypted] = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [spentIds, setSpentIds]   = useState<Set<string>>(new Set());

  // ── MODE A: self-fetch (original behaviour, used by LiquidityPage) ────────
  const fetchAndDecryptSelf = useCallback(async () => {
    if (!address || !requestRecords || !decrypt) return;
    setLoading(true);
    setError(null);
    try {
      let records: any[] = [];

      try {
        // includePlaintext: true — required for Shield to return recordCiphertext
        records = await requestRecords(USDCX_PROGRAM_ID, true);
        console.log(`[useUSDCx] requestRecords(${USDCX_PROGRAM_ID}): ${records.length} records`);
      } catch (e) {
        console.warn('[useUSDCx] USDCX_PROGRAM_ID failed, trying PROGRAM_ID:', e);
      }

      if (records.length === 0) {
        records = await requestRecords(PROGRAM_ID, true);
        console.log(`[useUSDCx] fallback requestRecords(${PROGRAM_ID}): ${records.length} records`);
      }

      const allToken = records.filter((r: any) => r.recordName === 'Token');
      const unspent  = allToken.filter((r: any) => !r.spent);
      const spent    = allToken.filter((r: any) =>  r.spent);
      console.log(`[useUSDCx] Token: ${allToken.length} total, ${unspent.length} unspent, ${spent.length} spent`);
      console.log('[useUSDCx] All record names:', records.map((r: any) => r.recordName).join(', '));

      if (unspent.length === 0) {
        setTokens([]);
        setTotal(0n);
        setDecrypted(true);
        return;
      }

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

  // ── MODE B: injected records (used by PrivateDataContext → TradePage) ─────
  const fetchAndDecryptInjected = useCallback(async () => {
    if (!decrypt || !address) return;
    const records = rawRecords ?? [];

    if (records.length === 0) {
      setTokens([]);
      setTotal(0n);
      setDecrypted(true);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const unspent = records.filter(r => !r.spent && !spentIds.has(r.commitment || r.id || ''));
      console.log(`[useUSDCx] injected: decrypting ${unspent.length} records`);

      const results = await Promise.all(
        unspent.map(async (r) => {
          try {
            if (!r.recordCiphertext) return null;
            const plaintext = await decrypt(r.recordCiphertext);
            const amtMatch  = plaintext.match(/amount:\s*(\d+)u128/);
            if (!amtMatch) return null;
            const amount = BigInt(amtMatch[1]);
            const id = r.commitment || r.id || r.nonce || Math.random().toString();
            return { id, amount, plaintext, ciphertext: r.recordCiphertext, rawRecord: r } as USDCxRecord;
          } catch {
            return null;
          }
        })
      );

      const parsed = results.filter((r): r is USDCxRecord => r !== null);
      const filtered = parsed
        .filter(t => !spentIds.has(t.id))
        .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
      const sum = filtered.reduce((acc, t) => acc + t.amount, 0n);

      console.log(`[useUSDCx] injected final: ${filtered.length} records, $${(Number(sum) / 1_000_000).toFixed(2)}`);
      setTokens(filtered);
      setTotal(sum);
      setDecrypted(true);
    } catch (e: any) {
      setError(e?.message || 'Failed to decrypt USDCx records');
    } finally {
      setLoading(false);
    }
  }, [decrypt, address, rawRecords, spentIds]);

  // Public API — routes to correct mode
  const fetchAndDecrypt = selfFetchMode ? fetchAndDecryptSelf : fetchAndDecryptInjected;

  // Auto-decrypt when injected records change (MODE B only)
  // Stable string key prevents infinite loops from array reference churn
  const rawKey = selfFetchMode
    ? null
    : (rawRecords ?? []).map(r => r.commitment || r.id || '').join(',');

  useEffect(() => {
    if (selfFetchMode) return;
    if ((rawRecords ?? []).length > 0) {
      fetchAndDecryptInjected();
    } else {
      setTokens([]);
      setTotal(0n);
      setDecrypted(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawKey]);

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
