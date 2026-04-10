import { useState, useCallback } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import type { TransactionOptions } from '@provablehq/aleo-types';
import { useTransaction } from '@/hooks/useTransaction';

const EXPLORER_API = 'https://api.explorer.provable.com/v1/testnet';

export interface PositionSlotRecord {
  id: string;
  owner: string;
  slotId: number;
  isOpen: boolean;
  isStale: boolean;       // true = open in wallet but liquidated on-chain
  positionId: string;
  isLong: boolean;
  sizeUsdc: bigint;
  collateralUsdc: bigint;
  entryPrice: bigint;
  plaintext: string;
  ciphertext: string;
  rawRecord: any;
}

export function useSlots(programId: string) {
  const { address, requestRecords, decrypt } = useWallet();
  const initTx = useTransaction();

  const [positionSlots, setPositionSlots] = useState<PositionSlotRecord[]>([]);
  const [recordCount, setRecordCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [decrypting, setDecrypting] = useState(false);
  const [decrypted, setDecrypted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawRecords, setRawRecords] = useState<any[]>([]);
  const [rawRecordCount, setRawRecordCount] = useState<number | null>(null);
  const [spentCommitments, setSpentCommitments] = useState<Set<string>>(new Set());

  // ─── helpers ────────────────────────────────────────────────────────────────

  // Returns true if the position is still live on-chain.
  // Uses active_position_ids (set on open, removed on close/liquidate/burn).
  async function checkPositionActive(positionId: string): Promise<boolean> {
    if (!positionId || positionId === '0field') return false;
    try {
      const res = await fetch(
        `${EXPLORER_API}/program/${programId}/mapping/active_position_ids/${positionId}`
      );
      if (res.status === 404) return false;
      const val = await res.text();
      return !!val && val !== 'null';
    } catch {
      return true; // network error — assume active to avoid false positives
    }
  }

  // ─── parse helper ───────────────────────────────────────────────────────────

  function parseSlots(
    results: Array<{ record: any; plaintext: string } | null>
  ): PositionSlotRecord[] {
    const slots: PositionSlotRecord[] = [];

    for (const result of results) {
      if (!result) continue;
      const { record, plaintext } = result;

      const slotIdMatch  = plaintext.match(/slot_id:\s*(\d+)u8(?:\.private)?/);
      const isOpenMatch  = plaintext.match(/is_open:\s*(true|false)(?:\.private)?/);
      const posIdMatch   = plaintext.match(/position_id:\s*(\d+field)(?:\.private)?/);
      const isLongMatch  = plaintext.match(/is_long:\s*(true|false)(?:\.private)?/);
      const sizeMatch    = plaintext.match(/size_usdc:\s*(\d+)u64(?:\.private)?/);
      const collMatch    = plaintext.match(/collateral_usdc:\s*(\d+)u64(?:\.private)?/);
      const entryMatch   = plaintext.match(/entry_price:\s*(\d+)u64(?:\.private)?/);

      if (!slotIdMatch) continue;

      slots.push({
        id: record.commitment || record.id || `slot-${slotIdMatch[1]}`,
        owner: address || '',
        slotId: parseInt(slotIdMatch[1]),
        isOpen: isOpenMatch?.[1] === 'true',
        isStale: false, // filled in during on-chain verification below
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

    return slots;
  }

  // ─── on-chain verification ──────────────────────────────────────────────────
  // For each open slot:
  //   - Check active_position_ids: missing → STALE (liquidated, needs burn)
  //   - Also check position_open_blocks as fallback (keeps existing logic)

  async function verifySlots(
    slots: PositionSlotRecord[]
  ): Promise<PositionSlotRecord[]> {
    return Promise.all(
      slots.map(async (slot) => {
        if (!slot.isOpen) return slot;

        const active = await checkPositionActive(slot.positionId);

        if (!active) {
          // Position gone from chain — slot is stale (was liquidated)
          console.log(
            `[useSlots][${programId}] Slot ${slot.slotId} is STALE — position ${slot.positionId} not in active_position_ids`
          );
          return { ...slot, isStale: true };
        }

        return slot;
      })
    );
  }

  // ─── phase 1: fetch ─────────────────────────────────────────────────────────

  const fetchSlots = useCallback(async () => {
    if (!address || !requestRecords) return;

    setLoading(true);
    setError(null);

    try {
      const records = await requestRecords(programId);

      records.filter((r: any) => !r.spent).forEach((r: any) =>
        console.log(`[useSlots][${programId}] record:`, r.recordName, r.commitment?.slice(0, 20))
      );

      const allSlotRecords = records.filter((r: any) =>
        r.recordName === 'PositionSlot' &&
        (!r.programId || r.programId === programId)
      );

      const slotRecords = allSlotRecords.filter((r: any) => !r.spent);
      console.log(`[useSlots][${programId}] ${slotRecords.length} unspent PositionSlot records`);

      const sortedRecords = slotRecords
        .slice()
        .sort((a: any, b: any) => (b.commitment || '').localeCompare(a.commitment || ''));
      const dedupedRaw = sortedRecords.slice(0, 2);

      setRawRecords(dedupedRaw);
      setRawRecordCount(slotRecords.length);
      setRecordCount(dedupedRaw.length > 0 ? dedupedRaw.length : 0);
      setDecrypted(false);
      setPositionSlots([]);
    } catch (err) {
      console.error(`[useSlots][${programId}] Failed to fetch:`, err);
      setError(err instanceof Error ? err.message : 'Failed to fetch slots');
    } finally {
      setLoading(false);
    }
  }, [address, requestRecords, programId]);

  // ─── phase 2: decrypt ───────────────────────────────────────────────────────

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

      const slots = parseSlots(results).filter(s => !spentCommitments.has(s.id));

      // Deduplicate by slot_id — prefer open record if both exist
      const dedupMap = new Map<number, PositionSlotRecord>();
      for (const slot of slots) {
        const existing = dedupMap.get(slot.slotId);
        if (!existing || slot.isOpen) dedupMap.set(slot.slotId, slot);
      }

      const deduped = Array.from(dedupMap.values())
        .filter(s => s.slotId === 0 || s.slotId === 1)
        .sort((a, b) => a.slotId - b.slotId);

      const verified = await verifySlots(deduped);

      const openSlots = verified.filter(s => s.isOpen && !s.isStale);
      const staleSlots = verified.filter(s => s.isStale);
      console.log(
        `[useSlots][${programId}] ${verified.length} slots, ${openSlots.length} open, ${staleSlots.length} stale`
      );

      setPositionSlots(verified);
      setRecordCount(verified.length);
      setDecrypted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to decrypt slots');
    } finally {
      setDecrypting(false);
    }
  }, [decrypt, rawRecords, address, spentCommitments, programId]);

  // ─── combined fetch + decrypt ────────────────────────────────────────────────

  const fetchAndDecryptSlots = useCallback(async () => {
    if (!address || !requestRecords || !decrypt) return;

    setLoading(true);
    setError(null);
    let dedupedRaw: any[] = [];

    try {
      const records = await requestRecords(programId);
      const slotRecords = records.filter((r: any) =>
        r.recordName === 'PositionSlot' &&
        (!r.programId || r.programId === programId) &&
        !r.spent
      );
      const sorted = slotRecords
        .slice()
        .sort((a: any, b: any) => (b.commitment || '').localeCompare(a.commitment || ''));
      dedupedRaw = sorted.slice(0, 2);
      setRawRecords(dedupedRaw);
      setRawRecordCount(slotRecords.length);
      setRecordCount(dedupedRaw.length > 0 ? dedupedRaw.length : 0);
      setDecrypted(false);
      setPositionSlots([]);
    } finally {
      setLoading(false);
    }

    if (dedupedRaw.length === 0) return;

    setDecrypting(true);
    try {
      const results = await Promise.all(
        dedupedRaw.map(async (record) => {
          try {
            if (!record.recordCiphertext) return null;
            const plaintext = await decrypt(record.recordCiphertext);
            return { record, plaintext };
          } catch {
            return null;
          }
        })
      );

      const slots = parseSlots(results).filter(s => !spentCommitments.has(s.id));

      const dedupMap = new Map<number, PositionSlotRecord>();
      for (const slot of slots) {
        const existing = dedupMap.get(slot.slotId);
        if (!existing || slot.isOpen) dedupMap.set(slot.slotId, slot);
      }

      const deduped = Array.from(dedupMap.values())
        .filter(s => s.slotId === 0 || s.slotId === 1)
        .sort((a, b) => a.slotId - b.slotId);

      const verified = await verifySlots(deduped);

      setPositionSlots(verified);
      setRecordCount(verified.length);
      setDecrypted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to decrypt slots');
    } finally {
      setDecrypting(false);
    }
  }, [address, requestRecords, decrypt, programId, spentCommitments]);

  // ─── initialize slots ────────────────────────────────────────────────────────

  const initializeSlots = useCallback(async () => {
    if (!address) return;

    const options: TransactionOptions = {
      program: programId,
      function: 'initialize_slots',
      inputs: [address],
      fee: 3_000_000,
      privateFee: false,
    };

    await initTx.execute(options);
  }, [address, initTx, programId]);

  // ─── mark spent ─────────────────────────────────────────────────────────────

  const markSpent = useCallback((id: string) => {
    setSpentCommitments(prev => new Set([...prev, id]));
    setPositionSlots(prev => prev.filter(s => s.id !== id));
  }, []);

  // ─── selectors ──────────────────────────────────────────────────────────────

  // Returns an empty (non-stale) slot for the given direction
  const getEmptyPositionSlot = useCallback(
    (isLong: boolean): PositionSlotRecord | null => {
      const expectedSlotId = isLong ? 0 : 1;
      return (
        positionSlots.find(
          s => !s.isOpen && !s.isStale && s.slotId === expectedSlotId
        ) || null
      );
    },
    [positionSlots]
  );

  const getOpenPositionSlots = useCallback(
    (): PositionSlotRecord[] => positionSlots.filter(s => s.isOpen && !s.isStale),
    [positionSlots]
  );

  // All slots that need to be burned before trading can resume
  const getStaleSlots = useCallback(
    (): PositionSlotRecord[] => positionSlots.filter(s => s.isStale),
    [positionSlots]
  );

  // ─── derived state ───────────────────────────────────────────────────────────

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
    fetchAndDecryptSlots,
    initializeSlots,
    getEmptyPositionSlot,
    getOpenPositionSlots,
    getStaleSlots,
    markSpent,
    needsInitialization,
    isInitializing,
    initTx,
  };
}
