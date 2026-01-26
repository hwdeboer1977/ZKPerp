import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@demox-labs/aleo-wallet-adapter-react';

const API_BASE = 'https://api.explorer.provable.com/v1/testnet';
const MOCK_USDC_PROGRAM = 'mock_usdc_0126.aleo';

export function useBalance() {
  const { publicKey, connected } = useWallet();
  const [publicBalance, setPublicBalance] = useState<bigint | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBalance = useCallback(async () => {
    if (!publicKey || !connected) {
      setPublicBalance(null);
      setUsdcBalance(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Fetch ALEO balance
      try {
        const aleoResponse = await fetch(
          `${API_BASE}/program/credits.aleo/mapping/account/${publicKey}`
        );

        if (aleoResponse.ok) {
          const data = await aleoResponse.text();
          const match = data.match(/(\d+)u64/);
          if (match) {
            setPublicBalance(BigInt(match[1]));
          }
        } else if (aleoResponse.status === 404) {
          setPublicBalance(BigInt(0));
        }
      } catch (corsError) {
        // CORS error - set to null, don't break the app
        console.warn('CORS error fetching ALEO balance:', corsError);
        setPublicBalance(null);
      }

      // Fetch mock USDC balance
      try {
        const usdcResponse = await fetch(
          `${API_BASE}/program/${MOCK_USDC_PROGRAM}/mapping/balances/${publicKey}`
        );

        if (usdcResponse.ok) {
          const data = await usdcResponse.text();
          // Could be u64 or u128 depending on token implementation
          const match = data.match(/(\d+)u(?:64|128)/);
          if (match) {
            setUsdcBalance(BigInt(match[1]));
          }
        } else if (usdcResponse.status === 404) {
          setUsdcBalance(BigInt(0));
        }
      } catch (corsError) {
        // CORS error - set to null, don't break the app
        console.warn('CORS error fetching USDC balance:', corsError);
        setUsdcBalance(null);
      }
    } catch (err) {
      console.error('Failed to fetch balance:', err);
      setError('Failed to fetch balance');
    } finally {
      setLoading(false);
    }
  }, [publicKey, connected]);

  // Fetch on connect/address change
  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (!connected) return;
    const interval = setInterval(fetchBalance, 30000);
    return () => clearInterval(interval);
  }, [connected, fetchBalance]);

  return {
    publicBalance,
    usdcBalance,
    loading,
    error,
    refresh: fetchBalance,
  };
}

// Format microcredits to ALEO (6 decimals)
export function formatAleo(microcredits: bigint | null): string {
  if (microcredits === null) return '-';
  const aleo = Number(microcredits) / 1_000_000;
  return aleo.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

// Format mock USDC (assuming 6 decimals like real USDC)
export function formatMockUsdc(amount: bigint | null): string {
  if (amount === null) return '-';
  const usdc = Number(amount) / 1_000_000;
  return usdc.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
