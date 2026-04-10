// hooks/useCompliance.ts
// Fetches ZKPerpComplianceRecord from the user's wallet.
// Shield returns records with recordCiphertext — this is passed directly
// as input to gated core transitions.

import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';

const COMPLIANCE_PROGRAM_ID = 'zkperp_compliance_v7.aleo';
const RECORD_NAME = 'ZKPerpComplianceRecord';
const ALEO_API = 'https://api.explorer.provable.com/v1/testnet';

export interface ComplianceRecordData {
  id: string;
  plaintext: string;       // recordCiphertext — passed directly as tx input
  issuedUnder: string;     // parsed from on-chain tx if available
  expiresAt: number;       // parsed from on-chain tx if available
  isExpired: boolean;
}

export function useCompliance() {
  const { requestRecords, connected } = useWallet();
  const [complianceRecord, setComplianceRecord] = useState<ComplianceRecordData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchCompliance = useCallback(async () => {
    if (!requestRecords || !connected) {
      setComplianceRecord(null);
      return;
    }
    setLoading(true);
    setError(null);

    try {
      const raw: any[] = await (requestRecords(COMPLIANCE_PROGRAM_ID) as Promise<any[]>)
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          if (!msg.includes('WalletNotConnected') && !msg.includes('not connected')) {
            console.warn('[useCompliance] requestRecords failed:', e);
          }
          return [];
        });

      // Filter for ZKPerpComplianceRecord, unspent
      const crRaw = raw.filter(r => r.recordName === RECORD_NAME && !r.spent);

      if (crRaw.length === 0) {
        setComplianceRecord(null);
        return;
      }

      // Get current block height
      let currentBlock = 0;
      try {
        const res = await fetch(`${ALEO_API}/block/height/latest`);
        const d = await res.json();
        currentBlock = typeof d === 'number' ? d : (d.height || 0);
      } catch {}

      // Parse records — use recordCiphertext as the plaintext input for transactions
      const parsed: ComplianceRecordData[] = crRaw.map(r => {
        // Try to get expires_at from on-chain transaction output
        // For now use blockHeight as rough proxy for issuance time
        const blockHeight = r.blockHeight || 0;
        const estimatedExpiry = blockHeight > 0 ? blockHeight + 7_776_000 : 0;
        const isExpired = estimatedExpiry > 0 && currentBlock > estimatedExpiry;

        return {
          id: r.commitment || r.tag || String(Math.random()),
          plaintext: r.recordCiphertext,  // ← this is what Shield expects as tx input
          issuedUnder: 'on-chain',
          expiresAt: estimatedExpiry,
          isExpired,
        };
      });

      const valid = parsed.filter(r => !r.isExpired);
      const best = valid.length > 0
        ? valid.sort((a, b) => b.expiresAt - a.expiresAt)[0]
        : parsed[0] ?? null; // fallback to any if all "expired" by estimate

      setComplianceRecord(best);
    } catch (e: any) {
      console.error('[useCompliance] error:', e);
      setError(e?.message || 'Failed to fetch compliance record');
      setComplianceRecord(null);
    } finally {
      setLoading(false);
    }
  }, [requestRecords, connected]);

  useEffect(() => {
    if (connected) fetchCompliance();
    else setComplianceRecord(null);
  }, [connected, fetchCompliance]);

  return { complianceRecord, loading, error, refetch: fetchCompliance };
}
