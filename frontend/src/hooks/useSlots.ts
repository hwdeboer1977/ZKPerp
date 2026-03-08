import { useState, useCallback } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import type { TransactionOptions } from '@provablehq/aleo-types';
import { useTransaction } from '@/hooks/useTransaction';
import { PROGRAM_ID } from '@/utils/aleo';

export interface PositionSlotRecord {
  id: string;
  owner: string;
  slotId: number;
  isOpen: boolean;
  positionId: string;
  isLong: boolean;
  sizeUsdc: bigint;
  collateralUsdc: bigint;
  entryPrice: bigint;
  plaintext: string;
  ciphertext: string;
  rawRecord: any;
}

export function useSlots() {
  const { address, requestRecords, decrypt } = useWallet();
  const initTx = useTransaction();

  const [positionSlots, setPositionSlots] = useState<PositionSlotRecord[]>([]);
  const [recordCount, setRecordCount] = useState<number | null>(null); // null = not yet fetched
  const [loading, setLoading] = useState(false);
  const [decrypting, setDecrypting] = useState(false);
  const [decrypted, setDecrypted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawRecords, setRawRecords] = useState<any[]>([]);
  const [spentCommitments, setSpentCommitments] = useState<Set<string>>(new Set());

  // Phase 1: fetch PositionSlot records (no decrypt)
  const fetchSlots = useCallback(async () => {
    if (!address || !requestRecords) return;

    setLoading(true);
    setError(null);

    try {
      const records = await requestRecords(PROGRAM_ID);
      const slotRecords = records.filter((r: any) => r.recordName === 'PositionSlot' && !r.spent);
      console.log(`Found ${slotRecords.length} PositionSlot records`);
      setRawRecords(slotRecords);
      setRecordCount(slotRecords.length);
      setDecrypted(false);
      setPositionSlots([]);
    } catch (err) {
      console.error('Failed to fetch PositionSlot records:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch slots');
    } finally {
      setLoading(false);
    }
  }, [address, requestRecords]);

  // Phase 2: decrypt PositionSlot records
  const decryptSlots = useCallback(async () => {
    if (!decrypt || rawRecords.length === 0) return;

    setDecrypting(true);
    setError(null);

    try {
      const results = await Promise.all(
        rawRecords.map(async (record) => {
          try {
            if (!record.recordCiphertext) return null;
            const plaintext = await decrypt(record.recordCiphertext);
            return { record, plaintext };
          } catch {
            return null;
          }
        })
      );

      const slots: PositionSlotRecord[] = [];

      for (const result of results) {
        if (!result) continue;
        const { record, plaintext } = result;

        const slotIdMatch    = plaintext.match(/slot_id:\s*(\d+)u8(?:\.private)?/);
        const isOpenMatch    = plaintext.match(/is_open:\s*(true|false)(?:\.private)?/);
        const posIdMatch     = plaintext.match(/position_id:\s*(\d+field)(?:\.private)?/);
        const isLongMatch    = plaintext.match(/is_long:\s*(true|false)(?:\.private)?/);
        const sizeMatch      = plaintext.match(/size_usdc:\s*(\d+)u64(?:\.private)?/);
        const collMatch      = plaintext.match(/collateral_usdc:\s*(\d+)u64(?:\.private)?/);
        const entryMatch     = plaintext.match(/entry_price:\s*(\d+)u64(?:\.private)?/);

        if (!slotIdMatch) continue;

        slots.push({
          id: record.commitment || record.id || `slot-${slotIdMatch[1]}`,
          owner: address || '',
          slotId: parseInt(slotIdMatch[1]),
          isOpen: isOpenMatch?.[1] === 'true',
          positionId: posIdMatch?.[1] || '0field',
          isLong: isLongMatch?.[1] === 'true',
          sizeUsdc: BigInt(sizeMatch?.[1] || '0'),
          collateralUsdc: BigInt(collMatch?.[1] || '0'),
          entryPrice: BigInt(entryMatch?.[1] || '0'),
          plaintext,
          ciphertext: record.recordCiphertext || '',
          rawRecord: record,
        });
      }

      const filtered = slots.filter(s => !spentCommitments.has(s.id));
      filtered.sort((a, b) => a.slotId - b.slotId);
      console.log(`Decrypted ${filtered.length} PositionSlots`);
      setPositionSlots(filtered);
      setDecrypted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to decrypt slots');
    } finally {
      setDecrypting(false);
    }
  }, [decrypt, rawRecords, address, spentCommitments]);

  // Call initialize_slots — one time per trader
  const initializeSlots = useCallback(async () => {
    if (!address) return;

    const options: TransactionOptions = {
      program: PROGRAM_ID,
      function: 'initialize_slots',
      inputs: [address],
      fee: 3_000_000,
      privateFee: false,
    };

    await initTx.execute(options);
  }, [address, initTx]);

  const markSpent = useCallback((id: string) => {
    setSpentCommitments(prev => new Set([...prev, id]));
    setPositionSlots(prev => prev.filter(s => s.id !== id));
  }, []);

  // isLong=true → slot_id 0, isLong=false → slot_id 1
  const getEmptyPositionSlot = useCallback((isLong: boolean): PositionSlotRecord | null => {
    const expectedSlotId = isLong ? 0 : 1;
    return positionSlots.find(s => !s.isOpen && s.slotId === expectedSlotId) || null;
  }, [positionSlots]);

  const getOpenPositionSlots = useCallback((): PositionSlotRecord[] => {
    return positionSlots.filter(s => s.isOpen);
  }, [positionSlots]);

  // recordCount === 0 after fetch = needs initialization
  const needsInitialization = recordCount === 0;
  const isInitializing = initTx.status === 'submitting' || initTx.status === 'pending';

  return {
    positionSlots,
    recordCount,
    loading,
    decrypting,
    decrypted,
    error,
    fetchSlots,
    decryptSlots,
    initializeSlots,
    getEmptyPositionSlot,
    getOpenPositionSlots,
    markSpent,
    needsInitialization,
    isInitializing,
    initTx,
  };
}
