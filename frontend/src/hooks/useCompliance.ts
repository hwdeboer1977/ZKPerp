import { useState, useRef, useCallback } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';

const COMPLIANCE_PROGRAM_ID = 'zkperp_compliance_v8b.aleo';
const RECORD_NAME = 'ZKPerpComplianceRecord';
const ALEO_API = 'https://api.explorer.provable.com/v1/testnet';

export interface ComplianceRecordData {
  id: string;
  plaintext: string;
  issuedUnder: string;
  expiresAt: number;
  isExpired: boolean;
}

// Shared in-memory cache so all hook instances share one result.
// Avoids 3 simultaneous requestRecords+decrypt calls from different components.
let cachedRecord: ComplianceRecordData | null = null;
let fetchPromise: Promise<ComplianceRecordData | null> | null = null;

export function useCompliance() {
  const wallet = useWallet();
  const walletRef = useRef(wallet);
  walletRef.current = wallet;

  // Seed state from in-memory cache immediately (no re-decrypt on re-mount)
  const [complianceRecord, setComplianceRecord] = useState<ComplianceRecordData | null>(
    () => cachedRecord
  );
  const [loading, setLoading] = useState(false);

  const runFetch = useCallback(async () => {
    const { requestRecords, decrypt, connected } = walletRef.current;
    if (!connected || !requestRecords || !decrypt) return;

    setLoading(true);
    try {
      const raw: any[] = await (requestRecords(COMPLIANCE_PROGRAM_ID) as Promise<any[]>)
        .catch(() => []);

      // Only look at unspent records
      const crRaw = raw.filter(r => r.recordName === RECORD_NAME && !r.spent);
      if (crRaw.length === 0) {
        cachedRecord = null;
        setComplianceRecord(null);
        return;
      }

      let currentBlock = 0;
      try {
        const res = await fetch(`${ALEO_API}/block/height/latest`);
        const d = await res.json();
        currentBlock = typeof d === 'number' ? d : (d.height || 0);
      } catch {}

      const parsed: ComplianceRecordData[] = [];
      for (const record of crRaw) {
        if (!record.recordCiphertext) continue;
        try {
          const plaintext    = await decrypt(record.recordCiphertext);
          const expiresMatch = plaintext.match(/expires_at[:\s]+(\d+)u32/);
          const issuedMatch  = plaintext.match(/issued_under[:\s]+(\S+?field)/);
          const expiresAt    = expiresMatch ? parseInt(expiresMatch[1]) : 0;
          const issuedUnder  = issuedMatch ? issuedMatch[1] : '';
          // Only check expiry — NOT the Merkle root. The root changes every time
          // a new user registers, which would invalidate all existing records constantly.
          const isExpired    = expiresAt > 0 && currentBlock > 0 && currentBlock > expiresAt;
          parsed.push({
            id: record.commitment || record.tag || String(Math.random()),
            plaintext,
            issuedUnder,
            expiresAt,
            isExpired,
          });
        } catch {}
      }

      const valid = parsed.filter(r => !r.isExpired);
      const best  = valid.length > 0 ? valid.sort((a, b) => b.expiresAt - a.expiresAt)[0] : null;
      cachedRecord = best;
      setComplianceRecord(best);
      return best;
    } finally {
      setLoading(false);
    }
  }, []);

  // Called explicitly when a trade/LP action needs the compliance record.
  // If already cached, returns immediately — no wallet popup.
  // Multiple simultaneous callers share one fetch via fetchPromise.
  const ensureRecord = useCallback(async (): Promise<ComplianceRecordData | null> => {
    if (cachedRecord) {
      setComplianceRecord(cachedRecord);
      return cachedRecord;
    }
    if (!fetchPromise) {
      fetchPromise = runFetch().then(r => {
        fetchPromise = null;
        return r ?? null;
      });
    }
    const result = await fetchPromise;
    return result;
  }, [runFetch]);

  // Force a fresh fetch — call this after issuing a new compliance record
  const refetch = useCallback(async (): Promise<ComplianceRecordData | null> => {
    cachedRecord = null;
    fetchPromise = null;
    setComplianceRecord(null);
    return ensureRecord();
  }, [ensureRecord]);

  return {
    complianceRecord,
    hasRecord: !!complianceRecord,
    loading,
    ensureRecord,
    refetch,
  };
}
