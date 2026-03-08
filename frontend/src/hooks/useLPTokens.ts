import { useState, useCallback } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import { PROGRAM_IDS } from '../utils/config';

const PROGRAM_ID = PROGRAM_IDS.ZKPERP;
const MIN_DUST = BigInt(10000); // $0.01 — filter out dust

export interface LPSlotRecord {
  id: string;
  owner: string;
  slotId: number;
  isOpen: boolean;
  lpAmount: bigint;
  plaintext: string;
  ciphertext: string;   // full plaintext — passed as first input to add/remove_liquidity
  rawRecord: any;
}

export function useLPTokens() {
  const { address, requestRecords, decrypt } = useWallet();

  // All decrypted LPSlot records (open + empty)
  const [lpSlots, setLpSlots] = useState<LPSlotRecord[]>([]);

  // Convenience: only open slots with meaningful balance
  const [lpTokens, setLpTokens] = useState<LPSlotRecord[]>([]);
  const [totalLP, setTotalLP] = useState<bigint>(BigInt(0));
  const [recordCount, setRecordCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [decrypting, setDecrypting] = useState(false);
  const [decrypted, setDecrypted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [rawRecords, setRawRecords] = useState<any[]>([]);
  // Track locally spent commitments to avoid reusing records the wallet hasn't marked spent yet
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
      //const records = await requestRecords(PROGRAM_ID);
      const records = await requestRecords(PROGRAM_ID, true);
      console.log('Fetched records:', records);

      // v8: filter LPSlot records (not LPToken)
      // Also filter out wallet-confirmed spent records
      // and locally tracked spent commitments (wallet sync lag)
      const lpRecordsRaw = records.filter(
        (r: any) => r.recordName === 'LPSlot' && !r.spent
      );

      console.log(`Found ${lpRecordsRaw.length} LPSlot records`);
      setRawRecords(lpRecordsRaw);
      setRecordCount(lpRecordsRaw.length);
      setDecrypted(false);
      setLpSlots([]);
      setLpTokens([]);
      setTotalLP(BigInt(0));
    } catch (err) {
      console.error('Failed to fetch LP records:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch LP records');
    } finally {
      setLoading(false);
    }
  }, [address, requestRecords]);

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
            console.log('Decrypted LPSlot:', plaintext);
            return { record, plaintext };
          } catch (err) {
            console.warn('Could not decrypt LPSlot record:', err);
            return null;
          }
        })
      );

      const allSlots: LPSlotRecord[] = [];
      let total = BigInt(0);

      for (const result of results) {
        if (!result) continue;
        const { record, plaintext } = result;

        const slotIdMatch = plaintext.match(/slot_id:\s*(\d+)u8(?:\.private)?/);
        const isOpenMatch = plaintext.match(/is_open:\s*(true|false)(?:\.private)?/);
        const lpAmountMatch = plaintext.match(/lp_amount:\s*(\d+)u64(?:\.private)?/);

        console.log('LPSlot parse:', {
          slotId: slotIdMatch?.[1],
          isOpen: isOpenMatch?.[1],
          lpAmount: lpAmountMatch?.[1],
        });

        if (!slotIdMatch) {
          console.log('SKIP: not a valid LPSlot (no slot_id)');
          continue;
        }

        const slotId = parseInt(slotIdMatch[1]);
        const isOpen = isOpenMatch?.[1] === 'true';
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

      // Filter out locally-known spent records (wallet sync lag protection)
      const filteredSlots = allSlots.filter(s => !spentCommitments.has(s.id));
      filteredSlots.sort((a, b) => a.slotId - b.slotId);
      const allSlotsFiltered = filteredSlots;

      const openSlots = allSlotsFiltered.filter(s => s.isOpen && s.lpAmount > MIN_DUST);

      console.log(`LPSlots: ${allSlotsFiltered.length} total, ${openSlots.length} open, total LP: ${total}`);

      setLpSlots(allSlotsFiltered);
      setLpTokens(openSlots);
      setTotalLP(total);
      setDecrypted(true);
    } catch (err) {
      console.error('Failed to decrypt LP records:', err);
      setError(err instanceof Error ? err.message : 'Failed to decrypt LP records');
    } finally {
      setDecrypting(false);
    }
  }, [decrypt, rawRecords, address, spentCommitments]);

  // Mark a record as locally spent (call this right before submitting a tx)
  const markSpent = useCallback((commitment: string) => {
    setSpentCommitments(prev => new Set([...prev, commitment]));
    // Also immediately remove it from lpSlots so UI updates instantly
    setLpSlots(prev => prev.filter(s => s.id !== commitment));
    setLpTokens(prev => prev.filter(s => s.id !== commitment));
  }, []);

  // Returns first empty LPSlot available for a fresh deposit
  const getEmptySlot = useCallback((): LPSlotRecord | null => {
    return lpSlots.find(s => !s.isOpen) || null;
  }, [lpSlots]);

  // Returns first open LPSlot for top-up deposit
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
