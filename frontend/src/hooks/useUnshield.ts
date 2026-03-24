import { useState, useCallback } from 'react';

export type UnshieldPhase = 'idle' | 'unshielding' | 'done' | 'error';

interface UnshieldDeps {
  fetchAndDecryptSlots: () => Promise<void>;
  fetchAndDecryptOrders: () => Promise<void>;
  fetchAndDecryptUsdcx: () => Promise<void>;
  slotsDecrypted: boolean;
  ordersDecrypted: boolean;
  usdcxDecrypted: boolean;
}

export function useUnshield({
  fetchAndDecryptSlots,
  fetchAndDecryptOrders,
  fetchAndDecryptUsdcx,
  slotsDecrypted,
  ordersDecrypted,
  usdcxDecrypted,
}: UnshieldDeps) {
  const [phase, setPhase] = useState<UnshieldPhase>('idle');
  const [error, setError] = useState<string | null>(null);

  const allDecrypted = slotsDecrypted && ordersDecrypted && usdcxDecrypted;

  const unshieldAll = useCallback(async () => {
    setError(null);
    setPhase('unshielding');
    try {
      // All three run in parallel — each does its own fetch then decrypt
      // using local variables, avoiding React state race conditions
      await Promise.all([
        fetchAndDecryptSlots(),
        fetchAndDecryptOrders(),
        fetchAndDecryptUsdcx(),
      ]);
      setPhase('done');
    } catch (err) {
      console.error('[useUnshield] error:', err);
      setError(err instanceof Error ? err.message : 'Unshield failed');
      setPhase('error');
    }
  }, [fetchAndDecryptSlots, fetchAndDecryptOrders, fetchAndDecryptUsdcx]);

  const reset = useCallback(() => {
    setPhase('idle');
    setError(null);
  }, []);

  const isBusy = phase === 'unshielding';

  const statusLabel = (() => {
    if (phase === 'unshielding') return '🔓 Unshielding... (approve in Shield)';
    if (phase === 'error')       return '⚠ Unshield failed — try again';
    return '🛡️ Unshield All Private Info\n\nApprove in wallet\n&\nUnlock Private USDCx\nslots, and positions!';
  })();

  return { unshieldAll, phase, isBusy, allDecrypted, statusLabel, error, reset };
}
