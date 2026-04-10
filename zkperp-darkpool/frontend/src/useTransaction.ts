/**
 * useTransaction - Hook for executing Aleo transactions with status polling
 * Wraps the wallet adapter's executeTransaction with automatic status tracking
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import type { TransactionOptions } from '@provablehq/aleo-types';

export type TxStatus = 'idle' | 'submitting' | 'pending' | 'accepted' | 'rejected' | 'failed' | 'error';

interface TransactionState {
  status: TxStatus;
  tempTxId: string | null;
  onChainTxId: string | null;
  error: string | null;
}

export function useTransaction() {
  const { executeTransaction, transactionStatus, connected, address } = useWallet();
  
  const [state, setState] = useState<TransactionState>({
    status: 'idle',
    tempTxId: null,
    onChainTxId: null,
    error: null,
  });

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const maxPollsRef = useRef(0);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, []);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const pollStatus = useCallback(async (tempTxId: string) => {
    maxPollsRef.current++;
    
    // Stop after 120 polls (~2 minutes at 1s intervals)
    if (maxPollsRef.current > 120) {
      stopPolling();
      setState(prev => ({
        ...prev,
        status: 'error',
        error: 'Transaction status polling timed out. Check explorer manually.',
      }));
      return;
    }

    try {
      const statusResponse = await transactionStatus(tempTxId);
      console.log(`[TX Poll #${maxPollsRef.current}] Status:`, statusResponse);

      const statusStr = statusResponse.status?.toLowerCase() || '';

      if (statusStr !== 'pending') {
        stopPolling();

        if (statusStr === 'accepted' || statusStr === 'finalized') {
          setState(prev => ({
            ...prev,
            status: 'accepted',
            onChainTxId: statusResponse.transactionId || null,
            error: null,
          }));
        } else if (statusStr === 'rejected' || statusStr === 'failed') {
          setState(prev => ({
            ...prev,
            status: statusStr as TxStatus,
            onChainTxId: statusResponse.transactionId || null,
            error: statusResponse.error || `Transaction ${statusStr}`,
          }));
        } else {
          // Unknown status
          setState(prev => ({
            ...prev,
            status: 'error',
            error: `Unknown status: ${statusResponse.status}`,
          }));
        }
      }
    } catch (err) {
      console.error('[TX Poll] Error:', err);
      // Don't stop polling on individual poll errors - the wallet might not support it
      // But track the error
      if (maxPollsRef.current > 5) {
        // After 5 failed polls, give up
        stopPolling();
        setState(prev => ({
          ...prev,
          status: 'error',
          error: `Status polling not supported or failed: ${err instanceof Error ? err.message : String(err)}`,
        }));
      }
    }
  }, [transactionStatus, stopPolling]);

  const execute = useCallback(async (options: TransactionOptions): Promise<string | null> => {
    if (!connected || !address || !executeTransaction) {
      setState({ status: 'error', tempTxId: null, onChainTxId: null, error: 'Wallet not connected' });
      return null;
    }

    // Reset state
    stopPolling();
    maxPollsRef.current = 0;
    setState({ status: 'submitting', tempTxId: null, onChainTxId: null, error: null });

    try {
      console.log('[TX] Executing:', options.program, options.function, options.inputs);
      const result = await executeTransaction(options);
      
      const tempId = result?.transactionId || null;
      console.log('[TX] Submitted, temp ID:', tempId);

      setState({ status: 'pending', tempTxId: tempId, onChainTxId: null, error: null });

      // Start polling if we got a transaction ID
     if (tempId) {
        pollingRef.current = setInterval(() => {
          pollStatus(tempId);
        }, 2000); // Poll every 2 seconds

        // Initial poll
        setTimeout(() => pollStatus(tempId), 1000);
      }

      return tempId;
    } catch (err) {
      console.error('[TX] Execution failed:', err);
      setState({
        status: 'error',
        tempTxId: null,
        onChainTxId: null,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }, [connected, address, executeTransaction, transactionStatus, pollStatus, stopPolling]);

  const reset = useCallback(() => {
    stopPolling();
    setState({ status: 'idle', tempTxId: null, onChainTxId: null, error: null });
  }, [stopPolling]);

  return {
    execute,
    reset,
    ...state,
  };
}
