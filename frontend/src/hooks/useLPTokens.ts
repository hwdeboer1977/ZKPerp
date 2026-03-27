import { useState, useCallback } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';

const MIN_DUST = BigInt(10000); // $0.01 — filter out dust

export interface LPSlotRecord {
  id: string;
  owner: string;
  slotId: number;
  isOpen: boolean;
  lpAmount: bigint;
  plaintext: string;
  ciphertext: string;
  rawRecord: any;
}

// programId is now a required parameter — callers pass pairConfig.programId
// so BTC LP records from zkperp_btc_v21.aleo never bleed into the ETH page.
export function useLPTokens(programId: string) {
  const { address, requestRecords, decrypt } = useWallet();

  const [lpSlots, setLpSlots] = useState<LPSlotRecord[]>([]);
  const [lpTokens, setLpTokens] = useState<LPSlotRecord[]>([]);
  const [totalLP, setTotalLP] = useState<bigint>(BigInt(0));
  const [recordCount, setRecordCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [decrypting, setDecrypting] = useState(false);
  const [decrypted, setDecrypted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawRecords, setRawRecords] = useState<any[]>([]);
  const [spentCommitments, setSpentCommitments] = useState<Set<string>>(new Set());

  // Phase 1: Fetch LPSlot records from wallet (no decrypt)
  const fetchRecords = useCallback(async () => {
    if (!address || !requestRecords) {
      setLpSlots([]);
      setLpTokens([]);
      setTotalLP(BigInt(0));
      setRecordCount(0);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Request records scoped to this pair's program only.
      // Shield Wallet returns records across all registered programs if programId
      // isn't specified — passing it here ensures ETH LP slots don't appear on BTC page.
      const records = await requestRecords(programId, true);
      console.log(`[useLPTokens][${programId}] Fetched ${records.length} records`);

      const lpRecordsRaw = records.filter(
        (r: any) =>
          r.recordName === 'LPSlot' &&
          !r.spent &&
          // Belt-and-suspenders: also filter by programId field if wallet sets it
          (!r.programId || r.programId === programId)
      );

      console.log(`[useLPTokens][${programId}] Found ${lpRecordsRaw.length} LPSlot records`);
      setRawRecords(lpRecordsRaw);
      setRecordCount(lpRecordsRaw.length);
      setDecrypted(false);
      setLpSlots([]);
      setLpTokens([]);
      setTotalLP(BigInt(0));
    } catch (err) {
      console.error(`[useLPTokens][${programId}] Failed to fetch LP records:`, err);
      setError(err instanceof Error ? err.message : 'Failed to fetch LP records');
    } finally {
      setLoading(false);
    }
  }, [address, requestRecords, programId]);

  // Phase 2: Decrypt all LPSlot records
  const decryptAll = useCallback(async () => {
    if (!decrypt || rawRecords.length === 0) return;

    setDecrypting(true);
    setError(null);

    try {
      const results = await Promise.all(
        rawRecords.map(async (record) => {
          try {
            if (!record.recordCiphertext) return null;
            const plaintext = await decrypt(record.recordCiphertext);
            console.log(`[useLPTokens][${programId}] Decrypted LPSlot:`, plaintext);
            return { record, plaintext };
          } catch (err) {
            console.warn(`[useLPTokens][${programId}] Could not decrypt LPSlot:`, err);
            return null;
          }
        })
      );

      const allSlots: LPSlotRecord[] = [];
      let total = BigInt(0);

      for (const result of results) {
        if (!result) continue;
        const { record, plaintext } = result;

        const slotIdMatch  = plaintext.match(/slot_id:\s*(\d+)u8(?:\.private)?/);
        const isOpenMatch  = plaintext.match(/is_open:\s*(true|false)(?:\.private)?/);
        const lpAmountMatch = plaintext.match(/lp_amount:\s*(\d+)u64(?:\.private)?/);

        if (!slotIdMatch) {
          console.log(`[useLPTokens][${programId}] SKIP: not a valid LPSlot`);
          continue;
        }

        const slotId   = parseInt(slotIdMatch[1]);
        const isOpen   = isOpenMatch?.[1] === 'true';
        const lpAmount = BigInt(lpAmountMatch?.[1] || '0');

        const slot: LPSlotRecord = {
          id: record.commitment || record.id || record.nonce || `slot-${slotId}`,
          owner: address || '',
          slotId,
          isOpen,
          lpAmount,
          plaintext,
          ciphertext: record.recordCiphertext || '',
          rawRecord: record,
        };

        allSlots.push(slot);

        if (isOpen && lpAmount > MIN_DUST) {
          total += lpAmount;
        }
      }

      const filteredSlots = allSlots
        .filter(s => !spentCommitments.has(s.id))
        .sort((a, b) => a.slotId - b.slotId);

      const openSlots = filteredSlots.filter(s => s.isOpen && s.lpAmount > MIN_DUST);

      console.log(`[useLPTokens][${programId}] ${filteredSlots.length} total, ${openSlots.length} open, total LP: ${total}`);

      setLpSlots(filteredSlots);
      setLpTokens(openSlots);
      setTotalLP(total);
      setDecrypted(true);
    } catch (err) {
      console.error(`[useLPTokens][${programId}] Failed to decrypt:`, err);
      setError(err instanceof Error ? err.message : 'Failed to decrypt LP records');
    } finally {
      setDecrypting(false);
    }
  }, [decrypt, rawRecords, address, spentCommitments, programId]);

  const markSpent = useCallback((commitment: string) => {
    setSpentCommitments(prev => new Set([...prev, commitment]));
    setLpSlots(prev => prev.filter(s => s.id !== commitment));
    setLpTokens(prev => prev.filter(s => s.id !== commitment));
  }, []);

  const getEmptySlot = useCallback((): LPSlotRecord | null => {
    return lpSlots.find(s => !s.isOpen) || null;
  }, [lpSlots]);

  const getOpenSlot = useCallback((): LPSlotRecord | null => {
    return lpSlots.find(s => s.isOpen) || null;
  }, [lpSlots]);

  return {
    lpSlots,
    lpTokens,
    totalLP,
    recordCount,
    loading,
    decrypting,
    decrypted,
    error,
    fetchRecords,
    decryptAll,
    getEmptySlot,
    getOpenSlot,
    markSpent,
  };
}

export function formatLPTokens(amount: bigint): string {
  const value = Number(amount) / 1_000_000;
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
