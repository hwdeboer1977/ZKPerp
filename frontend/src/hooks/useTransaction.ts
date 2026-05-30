/**
 * useTransaction - Aleo tx execution with confirmation polling.
 *
 * Confirmation source (verified by curl against a real tx):
 *   GET https://api.provable.com/v2/{network}/transaction/confirmed/{at1Id}
 *   -> 200 { "type":"execute", "status":"accepted" | "rejected", ... }
 *   -> 404 while the tx is not yet finalized (this is normal — keep polling)
 *
 * We poll this endpoint via the same-origin Vite proxy (/aleo-api) to avoid
 * CORS. The Shield wallet returns a temp `shield_…` id first and only later the
 * real `at1…` id via transactionStatus(), so Phase 1 just resolves that id; we
 * do NOT trust the wallet's own status field (it stays 'pending' on alpha).
 *
 * NOTE: set the Vite proxy to:
 *   '/aleo-api': { target: 'https://api.provable.com', changeOrigin: true,
 *                  secure: true, rewrite: p => p.replace(/^\/aleo-api/, '/v2') }
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import type { TransactionOptions } from '@provablehq/aleo-types';

export type TxStatus = 'idle' | 'submitting' | 'pending' | 'accepted' | 'rejected' | 'failed' | 'error';

interface TransactionState {
  status: TxStatus;
  tempTxId: string | null;     // shield_ temp id
  onChainTxId: string | null;  // at1 real id
  error: string | null;
}

const EXPLORER_PROXY  = '/aleo-api';   // -> https://api.provable.com/v2 (via vite proxy)
const NETWORK         = import.meta.env.VITE_ALEO_NETWORK || 'testnet';
const POLL_INTERVAL_MS = 3000;
const MAX_POLLS        = 80;   // ~4 min — must outlast block inclusion + finalize

export function useTransaction() {
  const { executeTransaction, transactionStatus, connected, address } = useWallet();

  const [state, setState] = useState<TransactionState>({
    status: 'idle', tempTxId: null, onChainTxId: null, error: null,
  });

  const pollingRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const maxPollsRef = useRef(0);
  const realIdRef   = useRef<string | null>(null);

  useEffect(() => () => { if (pollingRef.current) clearInterval(pollingRef.current); }, []);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
  }, []);

  const finish = useCallback((status: TxStatus, error: string | null) => {
    stopPolling();
    setState(prev => ({ ...prev, status, onChainTxId: realIdRef.current ?? prev.onChainTxId, error }));
  }, [stopPolling]);

  const pollStatus = useCallback(async (tempId: string) => {
    maxPollsRef.current++;
    if (maxPollsRef.current > MAX_POLLS) {
      setState(prev => ({ ...prev, status: 'pending',
        error: 'Still confirming - taking longer than usual. Use the explorer link to verify.' }));
      stopPolling();
      return;
    }

    // ── Phase 1: get the real at1 id from the wallet (status field ignored) ──
    if (!realIdRef.current) {
      try {
        const s = await transactionStatus(tempId);
        if (typeof s?.transactionId === 'string' && s.transactionId.startsWith('at1')) {
          const at1 = s.transactionId;
          realIdRef.current = at1;
          setState(prev => ({ ...prev, onChainTxId: at1 }));
        }
      } catch { /* wallet not ready - keep trying */ }
      if (!realIdRef.current) return;   // need the at1 id before we can query
    }

    // ── Phase 2: poll the confirmed endpoint (authoritative status field) ──
    try {
      const res = await fetch(`${EXPLORER_PROXY}/${NETWORK}/transaction/confirmed/${realIdRef.current}`);
      if (res.status === 404) return;   // not finalized yet — keep polling
      if (!res.ok) return;              // transient (522 etc) — keep polling

      const data = await res.json();
      const status = String(data?.status ?? '').toLowerCase();

      if (status === 'accepted')      finish('accepted', null);
      else if (status === 'rejected') finish('rejected', 'Transaction rejected on-chain (a finalize assert failed).');
      // any other/empty status -> still settling, keep polling
    } catch (err) {
      console.warn('[TX Poll] transient:', err instanceof Error ? err.message : String(err));
    }
  }, [transactionStatus, finish, stopPolling]);

  const execute = useCallback(async (options: TransactionOptions): Promise<string | null> => {
    if (!connected || !address || !executeTransaction) {
      setState({ status: 'error', tempTxId: null, onChainTxId: null, error: 'Wallet not connected' });
      return null;
    }

    stopPolling();
    maxPollsRef.current = 0;
    realIdRef.current = null;
    setState({ status: 'submitting', tempTxId: null, onChainTxId: null, error: null });

    try {
      console.log('[TX] Executing:', options.program, options.function, options.inputs);
      const result = await executeTransaction(options);
      const tempId = result?.transactionId || null;
      console.log('[TX] Submitted, temp ID:', tempId);

      setState({ status: 'pending', tempTxId: tempId, onChainTxId: null, error: null });

      if (tempId) {
        pollingRef.current = setInterval(() => pollStatus(tempId), POLL_INTERVAL_MS);
        setTimeout(() => pollStatus(tempId), 1500);
      } else {
        setState(prev => ({ ...prev, status: 'pending',
          error: 'Submitted, but no tracking id returned. Verify on the explorer.' }));
      }
      return tempId;
    } catch (err) {
      console.error('[TX] Execution failed:', err);
      setState({ status: 'error', tempTxId: null, onChainTxId: null,
        error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }, [connected, address, executeTransaction, pollStatus, stopPolling]);

  const reset = useCallback(() => {
    stopPolling();
    realIdRef.current = null;
    setState({ status: 'idle', tempTxId: null, onChainTxId: null, error: null });
  }, [stopPolling]);

  return { execute, reset, ...state };
}
