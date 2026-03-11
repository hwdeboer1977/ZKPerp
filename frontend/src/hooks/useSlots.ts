import { useState, useCallback } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import type { TransactionOptions } from '@provablehq/aleo-types';
import { useTransaction } from '@/hooks/useTransaction';
import { PROGRAM_ID } from '@/utils/aleo';

const EXPLORER_API = 'https://api.explorer.provable.com/v1/testnet';

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
  const [rawRecordCount, setRawRecordCount] = useState<number | null>(null);
  const [spentCommitments, setSpentCommitments] = useState<Set<string>>(new Set());

  // Phase 1: fetch PositionSlot records (no decrypt)
  const fetchSlots = useCallback(async () => {
    if (!address || !requestRecords) return;

    setLoading(true);
    setError(null);

    try {
      const records = await requestRecords(PROGRAM_ID);

      // DEBUG: log all unspent records
      records.filter((r: any) => !r.spent).forEach((r: any) => 
        console.log('record:', r.recordName, r.commitment?.slice(0,20))
      );

      const allSlotRecords = records.filter((r: any) => r.recordName === 'PositionSlot');
      allSlotRecords.forEach((r: any) => console.log('slot spent-check:', 'spent:', r.spent, 'commitment:', r.commitment?.slice(0, 20)));
      const slotRecords = allSlotRecords.filter((r: any) => !r.spent);
      console.log(`Found ${slotRecords.length} unspent PositionSlot records (${allSlotRecords.length} total)`);

      setRawRecords(slotRecords);
      setRawRecordCount(slotRecords.length);
      setRecordCount(slotRecords.length > 0 ? slotRecords.length : 0);
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

      // Deduplicate by slot_id: if multiple records exist for same slot_id,
      // prefer the open one; if all closed, keep only the last one.
      const dedupMap = new Map<number, PositionSlotRecord>();
      for (const slot of filtered) {
        const existing = dedupMap.get(slot.slotId);
        if (!existing || slot.isOpen) {
          dedupMap.set(slot.slotId, slot);
        }
      }
      const deduped = Array.from(dedupMap.values()).sort((a, b) => a.slotId - b.slotId);

      // Cross-check open slots against chain — wallet may not know about third-party spends (e.g. liquidation)
      const verifiedDeduped = await Promise.all(deduped.map(async (slot) => {
        if (!slot.isOpen) return slot;
        try {
          const res = await fetch(`${EXPLORER_API}/program/${PROGRAM_ID}/mapping/position_open_blocks/${slot.positionId}`);
          const val = await res.text();
          if (!val || val === 'null') {
            console.log(`Slot ${slot.slotId} position_open_blocks=null — marking closed (liquidated/closed on-chain)`);
            return { ...slot, isOpen: false };
          }
        } catch { /* network error — trust wallet state */ }
        return slot;
      }));

      const openSlots = verifiedDeduped.filter(s => s.isOpen);
      console.log(`Decrypted ${filtered.length} slots, deduped to ${verifiedDeduped.length}, ${openSlots.length} open (chain-verified)`);
      setPositionSlots(verifiedDeduped);
      // recordCount = total slots (used to detect if account is initialized)
      // openSlots.length is available via positionSlots.filter(s => s.isOpen)
      setRecordCount(verifiedDeduped.length);
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
    rawRecordCount,
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
