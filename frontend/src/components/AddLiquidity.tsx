import { useState, useCallback } from 'react';
import { useWallet } from '@demox-labs/aleo-wallet-adapter-react';
import { useZKPerp } from '@/hooks/useZKPerp';
import { parseUsdc, formatUsdc } from '@/utils/aleo';

interface Props {
  currentLiquidity: bigint;
  onSuccess?: () => void;
}

export function AddLiquidity({ currentLiquidity, onSuccess }: Props) {
  const { connected } = useWallet();
  const { addLiquidity, loading, error, clearError } = useZKPerp();

  const [amount, setAmount] = useState('');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const parsedAmount = parseUsdc(amount);
  const isValidAmount = parsedAmount >= BigInt(100); // Minimum 100 (0.0001 USDC with 6 decimals)

  const handleSubmit = useCallback(async () => {
    if (!connected || !isValidAmount) return;

    try {
      clearError();
      setTxHash(null);

      const hash = await addLiquidity(parsedAmount);
      setTxHash(hash);
      setAmount('');
      
      // Trigger refresh after a delay
      if (onSuccess) {
        setTimeout(onSuccess, 3000);
      }
    } catch (err) {
      console.error('Add liquidity failed:', err);
    }
  }, [connected, isValidAmount, parsedAmount, addLiquidity, clearError, onSuccess]);

  const quickAmounts = [10, 50, 100, 500];

  return (
    <div className="bg-zkperp-card rounded-xl border border-zkperp-border overflow-hidden">
      {/* Header - clickable to expand/collapse */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full p-4 flex items-center justify-between hover:bg-zkperp-dark/30 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
            <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
          </div>
          <div className="text-left">
            <h3 className="font-semibold text-white">Add Liquidity</h3>
            <p className="text-xs text-gray-500">
              Current pool: ${formatUsdc(currentLiquidity)}
            </p>
          </div>
        </div>
        <svg
          className={`w-5 h-5 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expandable content */}
      {isExpanded && (
        <div className="p-4 pt-0 space-y-4">
          {/* Amount input */}
          <div className="space-y-2">
            <label className="flex justify-between text-sm">
              <span className="text-gray-400">Amount (USDC)</span>
              <span className="text-gray-500">Min: $0.0001</span>
            </label>
            <div className="relative">
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full bg-zkperp-dark border border-zkperp-border rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500">
                USDC
              </span>
            </div>
          </div>

          {/* Quick amount buttons */}
          <div className="flex gap-2">
            {quickAmounts.map((quickAmount) => (
              <button
                key={quickAmount}
                onClick={() => setAmount(quickAmount.toString())}
                className="flex-1 py-2 text-sm bg-zkperp-dark border border-zkperp-border rounded-lg text-gray-400 hover:text-white hover:border-blue-500 transition-colors"
              >
                ${quickAmount}
              </button>
            ))}
          </div>

          {/* Info box */}
          <div className="bg-zkperp-dark rounded-lg p-3 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-400">You deposit</span>
              <span className="text-white">${amount || '0.00'} USDC</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">You receive</span>
              <span className="text-blue-400">~{amount || '0'} LP tokens</span>
            </div>
            <div className="pt-2 border-t border-zkperp-border text-xs text-gray-500">
              LP tokens represent your share of the pool. Earn fees from trading activity.
            </div>
          </div>

          {/* Error display */}
          {error && (
            <div className="bg-zkperp-red/10 border border-zkperp-red/30 rounded-lg p-3">
              <p className="text-zkperp-red text-sm">{error}</p>
            </div>
          )}

          {/* Success display */}
          {txHash && (
            <div className="bg-zkperp-green/10 border border-zkperp-green/30 rounded-lg p-3">
              <p className="text-zkperp-green text-sm">Liquidity added!</p>
              <code className="text-xs text-gray-400 break-all">{txHash}</code>
            </div>
          )}

          {/* Submit button */}
          <button
            onClick={handleSubmit}
            disabled={!connected || !isValidAmount || loading}
            className="w-full py-3 bg-blue-500 hover:bg-blue-600 disabled:bg-blue-500/30 rounded-lg font-semibold text-white transition-colors disabled:cursor-not-allowed"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Adding Liquidity...
              </span>
            ) : !connected ? (
              'Connect Wallet'
            ) : !isValidAmount && amount ? (
              'Amount too small'
            ) : (
              'Add Liquidity'
            )}
          </button>

          {/* Warning */}
          <p className="text-xs text-gray-500 text-center">
            ⚠️ LP funds are used to pay winning traders. You may lose money if traders profit.
          </p>
        </div>
      )}
    </div>
  );
}
