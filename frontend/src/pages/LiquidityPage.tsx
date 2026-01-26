import { useState, useCallback, useEffect } from 'react';
import { useWallet } from '@demox-labs/aleo-wallet-adapter-react';
import { useZKPerp } from '@/hooks/useZKPerp';
import { useLPTokens, formatLPTokens } from '@/hooks/useLPTokens';
import { formatUsdc, parseUsdc } from '@/utils/aleo';

interface Props {
  poolLiquidity: bigint;
  longOI: bigint;
  shortOI: bigint;
  onRefresh: () => void;
}

export function LiquidityPage({ poolLiquidity, longOI, shortOI, onRefresh }: Props) {
  const { connected } = useWallet();
  const { addLiquidity, removeLiquidity, loading, error, clearError } = useZKPerp();
  const { lpTokens, totalLP, loading: lpLoading, refresh: refreshLP } = useLPTokens();

  const [depositAmount, setDepositAmount] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [withdrawTxHash, setWithdrawTxHash] = useState<string | null>(null);
  const [withdrawLoading, setWithdrawLoading] = useState(false);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);

  // Fetch LP tokens when connected
  useEffect(() => {
    if (connected) {
      refreshLP();
    }
  }, [connected, refreshLP]);

  const totalOI = longOI + shortOI;
  const utilization = poolLiquidity > 0 
    ? Number((totalOI * BigInt(100)) / poolLiquidity) 
    : 0;

  const parsedAmount = parseUsdc(depositAmount);
  const isValidAmount = parsedAmount >= BigInt(1000000); // Min $1

  const handleDeposit = useCallback(async () => {
    if (!connected || !isValidAmount) return;

    try {
      clearError();
      setTxHash(null);
      const hash = await addLiquidity(parsedAmount);
      setTxHash(hash);
      setDepositAmount('');
      setTimeout(() => {
        onRefresh();
        refreshLP();
      }, 5000);
    } catch (err) {
      console.error('Deposit failed:', err);
    }
  }, [connected, isValidAmount, parsedAmount, addLiquidity, clearError, onRefresh, refreshLP]);

  const handleWithdraw = useCallback(async () => {
    if (!connected || !withdrawAmount || lpTokens.length === 0) return;

    setWithdrawLoading(true);
    setWithdrawError(null);
    setWithdrawTxHash(null);

    try {
      const lpAmountToWithdraw = parseUsdc(withdrawAmount);
      
      // Find an LP token record with enough balance
      const lpToken = lpTokens.find(t => t.amount >= lpAmountToWithdraw);
      if (!lpToken) {
        throw new Error('No LP token record with sufficient balance');
      }

      // Calculate expected USDC to receive (proportional to pool)
      // expectedUsdc = (lpAmount / totalLpTokens) * totalLiquidity
      const expectedUsdc = (lpAmountToWithdraw * poolLiquidity) / (totalLP + BigInt(1));

      const hash = await removeLiquidity(lpToken, lpAmountToWithdraw, expectedUsdc);
      setWithdrawTxHash(hash);
      setWithdrawAmount('');
      
      setTimeout(() => {
        onRefresh();
        refreshLP();
      }, 5000);
    } catch (err) {
      console.error('Withdraw failed:', err);
      setWithdrawError(err instanceof Error ? err.message : 'Withdrawal failed');
    } finally {
      setWithdrawLoading(false);
    }
  }, [connected, withdrawAmount, lpTokens, totalLP, poolLiquidity, removeLiquidity, onRefresh, refreshLP]);

  const quickAmounts = [10, 50, 100, 500, 1000];

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Page Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-2">Liquidity Pool</h1>
        <p className="text-gray-400">
          Provide liquidity to earn trading fees. LPs act as counterparty to traders.
        </p>
      </div>

      {/* Pool Stats */}
      <div className="grid md:grid-cols-4 gap-4 mb-8">
        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
          <p className="text-gray-400 text-sm mb-1">Total Liquidity</p>
          <p className="text-2xl font-bold text-white">${formatUsdc(poolLiquidity)}</p>
        </div>
        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
          <p className="text-gray-400 text-sm mb-1">Long Open Interest</p>
          <p className="text-2xl font-bold text-zkperp-green">${formatUsdc(longOI)}</p>
        </div>
        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
          <p className="text-gray-400 text-sm mb-1">Short Open Interest</p>
          <p className="text-2xl font-bold text-zkperp-red">${formatUsdc(shortOI)}</p>
        </div>
        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
          <p className="text-gray-400 text-sm mb-1">Pool Utilization</p>
          <p className={`text-2xl font-bold ${utilization > 80 ? 'text-zkperp-red' : utilization > 50 ? 'text-yellow-500' : 'text-zkperp-green'}`}>
            {utilization.toFixed(1)}%
          </p>
        </div>
      </div>

      {/* OI Balance Bar */}
      <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5 mb-8">
        <p className="text-gray-400 text-sm mb-3">Long/Short Balance</p>
        <div className="h-4 bg-zkperp-dark rounded-full overflow-hidden flex">
          <div
            className="bg-zkperp-green h-full transition-all"
            style={{ width: totalOI > 0 ? `${Number((longOI * BigInt(100)) / totalOI)}%` : '50%' }}
          />
          <div
            className="bg-zkperp-red h-full transition-all"
            style={{ width: totalOI > 0 ? `${Number((shortOI * BigInt(100)) / totalOI)}%` : '50%' }}
          />
        </div>
        <div className="flex justify-between mt-2 text-xs text-gray-500">
          <span>Long {totalOI > 0 ? Number((longOI * BigInt(100)) / totalOI) : 50}%</span>
          <span>Short {totalOI > 0 ? Number((shortOI * BigInt(100)) / totalOI) : 50}%</span>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Deposit Form */}
        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
          <h2 className="text-lg font-semibold text-white mb-4">Add Liquidity</h2>

          <div className="space-y-4">
            <div>
              <label className="flex justify-between text-sm mb-2">
                <span className="text-gray-400">Deposit Amount</span>
                <span className="text-gray-500">Min: $1.00</span>
              </label>
              <div className="relative">
                <input
                  type="number"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full bg-zkperp-dark border border-zkperp-border rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500">USDC</span>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {quickAmounts.map((amt) => (
                <button
                  key={amt}
                  onClick={() => setDepositAmount(amt.toString())}
                  className="px-4 py-2 text-sm bg-zkperp-dark border border-zkperp-border rounded-lg text-gray-400 hover:text-white hover:border-blue-500 transition-colors"
                >
                  ${amt}
                </button>
              ))}
            </div>

            <div className="bg-zkperp-dark rounded-lg p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">You deposit</span>
                <span className="text-white">${depositAmount || '0.00'} USDC</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">You receive</span>
                <span className="text-blue-400">~{depositAmount || '0'} LP tokens</span>
              </div>
            </div>

            {error && (
              <div className="bg-zkperp-red/10 border border-zkperp-red/30 rounded-lg p-3">
                <p className="text-zkperp-red text-sm">{error}</p>
              </div>
            )}

            {txHash && (
              <div className="bg-zkperp-green/10 border border-zkperp-green/30 rounded-lg p-3">
                <p className="text-zkperp-green text-sm">Liquidity added!</p>
                <code className="text-xs text-gray-400 break-all">{txHash}</code>
              </div>
            )}

            <button
              onClick={handleDeposit}
              disabled={!connected || !isValidAmount || loading}
              className="w-full py-3 bg-blue-500 hover:bg-blue-600 disabled:bg-blue-500/30 rounded-lg font-semibold text-white transition-colors"
            >
              {loading ? 'Processing...' : !connected ? 'Connect Wallet' : 'Add Liquidity'}
            </button>
          </div>
        </div>

        {/* Info Panel */}
        <div className="space-y-4">
          <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
            <h3 className="font-semibold text-white mb-3">How it Works</h3>
            <ul className="space-y-3 text-sm text-gray-400">
              <li className="flex gap-2">
                <span className="text-zkperp-accent">1.</span>
                Deposit USDC to receive LP tokens representing your share
              </li>
              <li className="flex gap-2">
                <span className="text-zkperp-accent">2.</span>
                The pool acts as counterparty to all traders
              </li>
              <li className="flex gap-2">
                <span className="text-zkperp-accent">3.</span>
                Earn fees from opening positions (0.1%) and funding rates
              </li>
              <li className="flex gap-2">
                <span className="text-zkperp-accent">4.</span>
                Withdraw anytime by burning LP tokens
              </li>
            </ul>
          </div>

          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-5">
            <h3 className="font-semibold text-yellow-500 mb-2">⚠️ Risk Warning</h3>
            <p className="text-sm text-gray-400">
              LP funds pay winning traders. If traders are net profitable, LPs lose money.
              The pool benefits when traders lose or from collected fees.
            </p>
          </div>

          <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
            <div className="flex justify-between items-center mb-4">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-white">Your LP Position</h3>
                <span className="text-xs bg-zkperp-accent/20 text-zkperp-accent px-2 py-0.5 rounded">private</span>
              </div>
              <button
                onClick={refreshLP}
                disabled={lpLoading || !connected}
                className="text-sm text-zkperp-accent hover:text-zkperp-accent/80 disabled:opacity-50"
              >
                {lpLoading ? 'Loading...' : '↻ Refresh'}
              </button>
            </div>
            
            {!connected ? (
              <p className="text-gray-400 text-sm">Connect wallet to view your LP position</p>
            ) : lpLoading ? (
              <div className="flex items-center gap-2 text-gray-400">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span className="text-sm">Loading LP tokens...</span>
              </div>
            ) : totalLP > BigInt(0) ? (
              <div className="space-y-3">
                <div className="bg-zkperp-dark rounded-lg p-4">
                  <p className="text-gray-400 text-sm mb-1">Your LP Tokens</p>
                  <p className="text-2xl font-bold text-white">{formatLPTokens(totalLP)}</p>
                </div>
                
                {poolLiquidity > BigInt(0) && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Pool Share</span>
                    <span className="text-white">
                      {((Number(totalLP) / Number(poolLiquidity)) * 100).toFixed(2)}%
                    </span>
                  </div>
                )}
                
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Estimated Value</span>
                  <span className="text-zkperp-green">${formatLPTokens(totalLP)}</span>
                </div>

                {lpTokens.length > 1 && (
                  <p className="text-xs text-gray-500 mt-2">
                    {lpTokens.length} LP token records
                  </p>
                )}

                {/* Remove Liquidity Section */}
                <div className="border-t border-zkperp-border pt-4 mt-4">
                  <p className="text-sm text-gray-400 mb-2">Withdraw Liquidity</p>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <input
                        type="number"
                        value={withdrawAmount}
                        onChange={(e) => setWithdrawAmount(e.target.value)}
                        placeholder="0.00"
                        max={Number(totalLP) / 1_000_000}
                        className="w-full bg-zkperp-dark border border-zkperp-border rounded-lg px-3 py-2 text-white placeholder-gray-600 text-sm focus:outline-none focus:border-red-500"
                      />
                      <button
                        onClick={() => setWithdrawAmount((Number(totalLP) / 1_000_000).toString())}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-zkperp-accent hover:text-zkperp-accent/80"
                      >
                        MAX
                      </button>
                    </div>
                    <button
                      onClick={handleWithdraw}
                      disabled={!connected || withdrawLoading || !withdrawAmount || parseFloat(withdrawAmount) <= 0}
                      className="px-4 py-2 bg-red-500 hover:bg-red-600 disabled:bg-red-500/30 rounded-lg text-sm font-medium text-white transition-colors"
                    >
                      {withdrawLoading ? '...' : 'Withdraw'}
                    </button>
                  </div>
                  {withdrawError && (
                    <p className="text-red-400 text-xs mt-2">{withdrawError}</p>
                  )}
                  {withdrawTxHash && (
                    <p className="text-zkperp-green text-xs mt-2">Withdrawal submitted!</p>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-center py-4">
                <p className="text-gray-400 text-sm">No LP tokens found</p>
                <p className="text-gray-500 text-xs mt-1">Add liquidity to start earning</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
