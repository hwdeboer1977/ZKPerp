import { useState, useEffect, useRef } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';

const COMPLIANCE_PROGRAM_ID = 'zkperp_compliance_v7.aleo';
const RECORD_NAME = 'ZKPerpComplianceRecord';
const ALEO_API = 'https://api.explorer.provable.com/v1/testnet';

export interface ComplianceRecordData {
  id: string;
  plaintext: string;
  issuedUnder: string;
  expiresAt: number;
  isExpired: boolean;
}

export function useCompliance() {
  const wallet = useWallet();
  const walletRef = useRef(wallet);
  walletRef.current = wallet;

  const [complianceRecord, setComplianceRecord] = useState<ComplianceRecordData | null>(null);
  const [loading, setLoading] = useState(false);
  const runningRef = useRef(false);

  const { connected } = wallet;

  useEffect(() => {
    if (!connected) {
      setComplianceRecord(null);
      runningRef.current = false;
      return;
    }
    if (runningRef.current) return;
    runningRef.current = true;

    const run = async () => {
      const { requestRecords, decrypt } = walletRef.current;
      if (!requestRecords || !decrypt) { runningRef.current = false; return; }
      setLoading(true);
      try {
        const raw: any[] = await (requestRecords(COMPLIANCE_PROGRAM_ID) as Promise<any[]>)
          .catch(() => []);

        const crRaw = raw.filter(r => r.recordName === RECORD_NAME && !r.spent);
        if (crRaw.length === 0) { setComplianceRecord(null); return; }

        let currentBlock = 0;
        try {
          const res = await fetch(`${ALEO_API}/block/height/latest`);
          const d = await res.json();
          currentBlock = typeof d === 'number' ? d : (d.height || 0);
        } catch {}

        // Fetch current on-chain compliance root to discard stale records
        let activeRoot = '';
        try {
          const rootRes = await fetch(
            `${ALEO_API}/program/${COMPLIANCE_PROGRAM_ID}/mapping/compliance_root/0u8`
          );
          activeRoot = (await rootRes.text()).replace(/"/g, '').trim();
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
            const isExpired    = expiresAt > 0 && currentBlock > 0 && currentBlock > expiresAt;
            const isStaleRoot  = activeRoot !== '' && issuedUnder !== activeRoot;
            parsed.push({
              id: record.commitment || record.tag || String(Math.random()),
              plaintext,
              issuedUnder,
              expiresAt,
              isExpired: isExpired || isStaleRoot,
            });
          } catch {}
        }

        const valid = parsed.filter(r => !r.isExpired);
        setComplianceRecord(valid.length > 0
          ? valid.sort((a, b) => b.expiresAt - a.expiresAt)[0]
          : null);
      } finally {
        setLoading(false);
      }
    };

    run();
  }, [connected]); // only connected in deps — wallet fns via ref

  const refetch = () => {
    runningRef.current = false;
    setComplianceRecord(null);
    // force re-run by toggling — simplest approach
    const { requestRecords, decrypt, connected: c } = walletRef.current;
    if (!c || !requestRecords || !decrypt) return;
    runningRef.current = true;
    const run = async () => {
      setLoading(true);
      try {
        const raw: any[] = await (requestRecords(COMPLIANCE_PROGRAM_ID) as Promise<any[]>).catch(() => []);
        const crRaw = raw.filter(r => r.recordName === RECORD_NAME && !r.spent);
        if (crRaw.length === 0) { setComplianceRecord(null); return; }
        let currentBlock = 0;
        try { const res = await fetch(`${ALEO_API}/block/height/latest`); const d = await res.json(); currentBlock = typeof d === 'number' ? d : (d.height || 0); } catch {}
        let activeRoot = '';
        try { const rr = await fetch(`${ALEO_API}/program/${COMPLIANCE_PROGRAM_ID}/mapping/compliance_root/0u8`); activeRoot = (await rr.text()).replace(/"/g, '').trim(); } catch {}
        const parsed: ComplianceRecordData[] = [];
        for (const record of crRaw) {
          if (!record.recordCiphertext) continue;
          try {
            const plaintext = await decrypt(record.recordCiphertext);
            const expiresMatch = plaintext.match(/expires_at[:\s]+(\d+)u32/);
            const issuedMatch = plaintext.match(/issued_under[:\s]+(\S+?field)/);
            const expiresAt = expiresMatch ? parseInt(expiresMatch[1]) : 0;
            const issuedUnder = issuedMatch?.[1] || '';
            const isExpired = expiresAt > 0 && currentBlock > 0 && currentBlock > expiresAt;
            const isStaleRoot = activeRoot !== '' && issuedUnder !== activeRoot;
            parsed.push({ id: record.commitment || String(Math.random()), plaintext, issuedUnder, expiresAt, isExpired: isExpired || isStaleRoot });
          } catch {}
        }
        const valid = parsed.filter(r => !r.isExpired);
        setComplianceRecord(valid.length > 0 ? valid.sort((a, b) => b.expiresAt - a.expiresAt)[0] : null);
      } finally { setLoading(false); runningRef.current = false; }
    };
    run();
  };

  return { complianceRecord, hasRecord: !!complianceRecord, loading, refetch };
}
