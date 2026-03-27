import { useState, useCallback } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import { PROGRAM_ID as DEFAULT_PROGRAM_ID } from '../utils/aleo';

export interface OrderReceiptRecord {
  id: string;
  owner: string;
  orderId: string;
  orderType: number;       // 0=limit 1=take_profit 2=stop_loss
  orderTypeStr: string;
  isLong: boolean;
  triggerPrice: bigint;
  sizeUsdc: bigint;
  collateralUsdc: bigint;
  entryPrice: bigint;
  positionId: string;
  slotId: number;
  nonce: string;
  plaintext: string;
  ciphertext: string;
  rawRecord: any;
}

export function useOrderReceipts(programId?: string) {
  const PROGRAM_ID = programId || DEFAULT_PROGRAM_ID;
  const { address, requestRecords, decrypt } = useWallet();

  const [receipts, setReceipts]         = useState<OrderReceiptRecord[]>([]);
  const [recordCount, setRecordCount]   = useState<number | null>(null);
  const [loading, setLoading]           = useState(false);
  const [decrypting, setDecrypting]     = useState(false);
  const [decrypted, setDecrypted]       = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [rawRecords, setRawRecords]     = useState<any[]>([]);
  const [spentIds, setSpentIds]         = useState<Set<string>>(new Set());

  // Phase 1: fetch OrderReceipt records from wallet
  const fetchRecords = useCallback(async () => {
    if (!address || !requestRecords) return;
    setLoading(true);
    setError(null);
    try {
      const records = await requestRecords(PROGRAM_ID);
      // Include spent records — OrderReceipt is consumed on cancel/execute but
      // wallet may mark it spent before the frontend processes it
      const raw = records.filter(
        (r: any) => (r.recordName === 'OrderReceipt' || r.recordName === 'LimitReceipt') && !r.spent
      );
      console.log(`Found ${raw.length} OrderReceipt+LimitReceipt records (unspent)`);
      setRawRecords(raw);
      setRecordCount(raw.length);
      setDecrypted(false);
      setReceipts([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch OrderReceipt records');
    } finally {
      setLoading(false);
    }
  }, [address, requestRecords]);

  // Phase 2: decrypt all OrderReceipt records
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
            return { record, plaintext };
          } catch {
            return null;
          }
        })
      );

      const parsed: OrderReceiptRecord[] = [];
      for (const result of results) {
        if (!result) continue;
        const { record, plaintext } = result;

        const orderIdMatch    = plaintext.match(/order_id:\s*(\d+field)(?:\.private)?/);
        const orderTypeMatch  = plaintext.match(/order_type:\s*(\d+)u8(?:\.private)?/);
        const isLongMatch     = plaintext.match(/is_long:\s*(true|false)(?:\.private)?/);
        const triggerMatch    = plaintext.match(/trigger_price:\s*(\d+)u64(?:\.private)?/);
        const sizeMatch       = plaintext.match(/size_usdc:\s*(\d+)u64(?:\.private)?/);
        const collMatch       = plaintext.match(/collateral_usdc:\s*(\d+)u64(?:\.private)?/);
        const entryMatch      = plaintext.match(/entry_price:\s*(\d+)u64(?:\.private)?/);
        const posIdMatch      = plaintext.match(/position_id:\s*(\d+field)(?:\.private)?/);
        const slotIdMatch     = plaintext.match(/slot_id:\s*(\d+)u8(?:\.private)?/);
        const nonceMatch      = plaintext.match(/nonce:\s*(\d+field)(?:\.private)?/);

        if (!orderIdMatch || !triggerMatch) continue;

        const isLimitReceipt = record.recordName === 'LimitReceipt';
        const orderType = isLimitReceipt ? 0 : parseInt(orderTypeMatch?.[1] || '0');
        const orderTypeStr = orderType === 0 ? 'Limit' : orderType === 1 ? 'Take Profit' : 'Stop Loss';

        parsed.push({
          id:             record.commitment || record.id || `receipt-${orderIdMatch[1]}`,
          owner:          address || '',
          orderId:        orderIdMatch[1],
          orderType,
          orderTypeStr,
          isLong:         isLongMatch?.[1] === 'true',
          triggerPrice:   BigInt(triggerMatch[1]),
          sizeUsdc:       BigInt(sizeMatch?.[1] || '0'),
          collateralUsdc: BigInt(collMatch?.[1] || '0'),
          entryPrice:     BigInt(entryMatch?.[1] || '0'),
          positionId:     posIdMatch?.[1] || '0field',
          slotId:         parseInt(slotIdMatch?.[1] || '0'),
          nonce:          nonceMatch?.[1] || '0field',
          plaintext,
          ciphertext:     record.recordCiphertext || '',
          rawRecord:      record,
        });
      }

      const filtered = parsed.filter(r => !spentIds.has(r.id));
      // Chain verification removed — wallet holding the record IS the proof of ownership.
      // Spent records are filtered via spentIds after cancel/execute.
      console.log(`OrderReceipts: ${filtered.length} active`);
      setReceipts(filtered);
      setDecrypted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to decrypt OrderReceipt records');
    } finally {
      setDecrypting(false);
    }
  }, [decrypt, rawRecords, address, spentIds]);

  const markSpent = useCallback((id: string) => {
    setSpentIds(prev => new Set([...prev, id]));
    setReceipts(prev => prev.filter(r => r.id !== id));
  }, []);

  // Combined fetch+decrypt — avoids React state race between the two phases
  const fetchAndDecrypt = useCallback(async () => {
    if (!address || !requestRecords) return;
    setLoading(true);
    setError(null);
    let raw: any[] = [];
    try {
      const records = await requestRecords(PROGRAM_ID);
      raw = records.filter(
        (r: any) => (r.recordName === 'OrderReceipt' || r.recordName === 'LimitReceipt') && !r.spent
      );
      setRawRecords(raw);
      setRecordCount(raw.length);
      setDecrypted(false);
      setReceipts([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch OrderReceipt records');
      setLoading(false);
      return;
    } finally {
      setLoading(false);
    }
    if (raw.length === 0) { setDecrypted(true); return; }

    // Decrypt immediately using local variable — not React state
    if (!decrypt) return;
    setDecrypting(true);
    try {
      const results = await Promise.all(
        raw.map(async (record) => {
          try {
            if (!record.recordCiphertext) return null;
            const plaintext = await decrypt(record.recordCiphertext);
            return { record, plaintext };
          } catch { return null; }
        })
      );
      const parsed: OrderReceiptRecord[] = [];
      for (const result of results) {
        if (!result) continue;
        const { record, plaintext } = result;
        const orderIdMatch   = plaintext.match(/order_id:\s*(\d+field)(?:\.private)?/);
        const orderTypeMatch = plaintext.match(/order_type:\s*(\d+)u8(?:\.private)?/);
        const isLongMatch    = plaintext.match(/is_long:\s*(true|false)(?:\.private)?/);
        const triggerMatch   = plaintext.match(/trigger_price:\s*(\d+)u64(?:\.private)?/);
        const sizeMatch      = plaintext.match(/size_usdc:\s*(\d+)u64(?:\.private)?/);
        const collMatch      = plaintext.match(/collateral_usdc:\s*(\d+)u64(?:\.private)?/);
        const entryMatch     = plaintext.match(/entry_price:\s*(\d+)u64(?:\.private)?/);
        const posIdMatch     = plaintext.match(/position_id:\s*(\d+field)(?:\.private)?/);
        const slotIdMatch    = plaintext.match(/slot_id:\s*(\d+)u8(?:\.private)?/);
        const nonceMatch     = plaintext.match(/nonce:\s*(\d+field)(?:\.private)?/);
        if (!orderIdMatch || !triggerMatch) continue;
        const isLimitReceipt = record.recordName === 'LimitReceipt';
        const orderType = isLimitReceipt ? 0 : parseInt(orderTypeMatch?.[1] || '0');
        parsed.push({
          id:             record.commitment || record.id || `receipt-${orderIdMatch[1]}`,
          owner:          address || '',
          orderId:        orderIdMatch[1],
          orderType,
          orderTypeStr:   orderType === 0 ? 'Limit' : orderType === 1 ? 'Take Profit' : 'Stop Loss',
          isLong:         isLongMatch?.[1] === 'true',
          triggerPrice:   BigInt(triggerMatch[1]),
          sizeUsdc:       BigInt(sizeMatch?.[1] || '0'),
          collateralUsdc: BigInt(collMatch?.[1] || '0'),
          entryPrice:     BigInt(entryMatch?.[1] || '0'),
          positionId:     posIdMatch?.[1] || '0field',
          slotId:         parseInt(slotIdMatch?.[1] || '0'),
          nonce:          nonceMatch?.[1] || '0field',
          plaintext,
          ciphertext:     record.recordCiphertext || '',
          rawRecord:      record,
        });
      }
      const filtered = parsed.filter(r => !spentIds.has(r.id));
      // Chain verification removed — wallet holding the record IS the proof of ownership.
      setReceipts(filtered);
      setDecrypted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to decrypt OrderReceipt records');
    } finally {
      setDecrypting(false);
    }
  }, [address, requestRecords, decrypt, spentIds]);

  return {
    receipts,
    recordCount,
    loading,
    decrypting,
    decrypted,
    error,
    fetchRecords,
    fetchAndDecrypt,
    decryptAll,
    markSpent,
  };
}
