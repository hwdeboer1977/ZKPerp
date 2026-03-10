import { useState, useCallback, useEffect } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import type { TransactionOptions } from '@provablehq/aleo-types';
import { useLPTokens, formatLPTokens } from '@/hooks/useLPTokens';
import { useSlots } from '@/hooks/useSlots';
import { InitializeSlotsPrompt } from '@/components/InitializeSlotsPrompt';
import type { LPSlotRecord } from '@/hooks/useLPTokens';
import { formatUsdc, parseUsdc, USDC_PROGRAM_ID, PROGRAM_ID } from '@/utils/aleo';
import { ADDRESS_LIST } from '../utils/config';
import { useTransaction } from '@/hooks/useTransaction';
import { TransactionStatus } from '@/components/TransactionStatus';

interface Props {
  poolLiquidity: bigint;
  totalLPTokens: bigint;  // pool_state.total_lp_tokens — NOT the user's LP balance
  longOI: bigint;
  shortOI: bigint;
  onRefresh: () => void;
}

function normalizeRecordPlaintext(plaintext: string): string {
  return plaintext
    .replace(/\s+/g, ' ')
    .replace(/{ /g, '{')
    .replace(/ }/g, '}')
    .replace(/,\s+/g, ',')
    .replace(/:\s+/g, ':')
    .trim();
}

export function LiquidityPage({ poolLiquidity, totalLPTokens, longOI, shortOI, onRefresh }: Props) {
  const { address, connected } = useWallet();
  const {
    lpTokens, totalLP, recordCount,
    loading: lpLoading, decrypting, decrypted,
    fetchRecords, decryptAll,
    getEmptySlot, getOpenSlot, markSpent,
  } = useLPTokens();
  const {
    recordCount: slotCount,
    loading: slotsLoading,
    fetchSlots,
    initializeSlots,
    isInitializing,
    initTx,
  } = useSlots();

  const approveTx = useTransaction();
  const depositTx = useTransaction();
  const withdrawTx = useTransaction();

  const [depositAmount, setDepositAmount] = useState('');
  const [withdrawRecordId, setWithdrawRecordId] = useState<string | null>(null);
  const [withdrawAmounts, setWithdrawAmounts] = useState<Record<string, string>>({});

  const handleApprove = useCallback(async () => {
    if (!address) return;
    try {
      const options: TransactionOptions = {
        program: USDC_PROGRAM_ID,
        function: 'approve_public',
        inputs: [ADDRESS_LIST.ZK_PERP_ADDRESS, '50000000000u128'],
        fee: 1_000_000,
        privateFee: false,
      };
      await approveTx.execute(options);
    } catch (err) {
      console.error('Approve error:', err);
    }
  }, [address, approveTx]);

  useEffect(() => {
    if (connected) {
      fetchRecords();
      fetchSlots();
    }
  }, [connected, fetchRecords, fetchSlots]);

  useEffect(() => {
    if (depositTx.status === 'accepted' || withdrawTx.status === 'accepted') {
      onRefresh();
      fetchRecords();
    }
  }, [depositTx.status, withdrawTx.status, onRefresh, fetchRecords]);

  const totalOI = longOI + shortOI;
  const utilization = poolLiquidity > 0
    ? Number((totalOI * BigInt(100)) / poolLiquidity)
    : 0;

  // Available to withdraw = pool minus locked collateral backing open positions
  // Mirrors the contract assert: total_liquidity - expected_usdc >= long_oi + short_oi
  const availableLiquidity = poolLiquidity > totalOI ? poolLiquidity - totalOI : 0n;
  const availablePercent = poolLiquidity > 0n
    ? Number((availableLiquidity * 100n) / poolLiquidity)
    : 0;

  const parsedAmount = parseUsdc(depositAmount);
  const isValidAmount = parsedAmount >= BigInt(1000000);

  const handleDeposit = useCallback(async () => {
    if (!connected || !isValidAmount || !address) return;
    if (!decrypted) {
      console.error('Decrypt your LP slots first');
      return;
    }

    const candidates = [getOpenSlot(), getEmptySlot()].filter(Boolean) as LPSlotRecord[];
    if (candidates.length === 0) {
      console.error('No LPSlot available — call initialize_slots first');
      return;
    }

    for (const slot of candidates) {
      try {
        markSpent(slot.id);
        const inputs = [
          normalizeRecordPlaintext(slot.plaintext),
          parsedAmount.toString() + 'u128',
          address,
        ];
        const options: TransactionOptions = {
          program: PROGRAM_ID,
          function: 'add_liquidity',
          inputs,
          fee: 5_000_000,
          privateFee: false,
        };
        await depositTx.execute(options);
        setDepositAmount('');
        return;
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (msg.includes('already exists in the ledger')) {
          console.warn('Slot already spent on-chain, trying next:', slot.id);
          continue;
        }
        console.error('Deposit failed:', err);
        return;
      }
    }
    console.error('All slots stale — refresh and re-decrypt');
  }, [connected, isValidAmount, parsedAmount, address, depositTx, getEmptySlot, getOpenSlot, markSpent, decrypted]);

  const handleWithdrawRecord = useCallback(async (lpToken: LPSlotRecord) => {
    if (!connected) return;
    try {
      setWithdrawRecordId(lpToken.id);

      // How many LP tokens to burn — either what the user typed or the full amount
      const inputUsdc = parseUsdc(withdrawAmounts[lpToken.id] || '');
      const poolLPSupply = totalLPTokens > 0n ? totalLPTokens : 1n;

      // LP tokens to burn = proportional to requested USDC
      // lp_to_burn = requested_usdc * total_lp_tokens / total_liquidity
      // If no pool data or user left blank, burn everything
      let amountToBurn: bigint;
      let expectedUsdc: bigint;

      if (inputUsdc > 0n && poolLiquidity > 0n) {
        // Partial withdrawal: calculate LP tokens needed for this USDC amount
        amountToBurn = (inputUsdc * poolLPSupply) / poolLiquidity;
        // Cap burn at what this record actually holds
        if (amountToBurn > lpToken.lpAmount) amountToBurn = lpToken.lpAmount;
        // Recalculate actual USDC from capped burn amount
        expectedUsdc = (amountToBurn * poolLiquidity) / poolLPSupply;
      } else {
        // Full withdrawal
        amountToBurn = lpToken.lpAmount;
        expectedUsdc = poolLiquidity > 0n && poolLPSupply > 0n
          ? (amountToBurn * poolLiquidity) / poolLPSupply
          : amountToBurn;
      }

      // Cap at available liquidity (locked collateral backing open positions)
      if (expectedUsdc > availableLiquidity) expectedUsdc = availableLiquidity;

      if (expectedUsdc === 0n) {
        alert('No liquidity available to withdraw right now — all funds are locked backing open positions. Wait for traders to close their positions.');
        setWithdrawRecordId(null);
        return;
      }

      markSpent(lpToken.id);
      const inputs = [
        normalizeRecordPlaintext(lpToken.plaintext),
        amountToBurn.toString() + 'u64',
        expectedUsdc.toString() + 'u128',
      ];
      const options: TransactionOptions = {
        program: PROGRAM_ID,
        function: 'remove_liquidity',
        inputs,
        fee: 5_000_000,
        privateFee: false,
      };
      await withdrawTx.execute(options);
    } catch (err) {
      console.error('Withdraw failed:', err);
    } finally {
      setWithdrawRecordId(null);
    }
  }, [connected, poolLiquidity, totalLPTokens, availableLiquidity, withdrawAmounts, withdrawTx, markSpent]);

  const quickAmounts = [10, 50, 100, 500, 1000];
  const isDepositBusy = depositTx.status === 'submitting' || depositTx.status === 'pending';
  const isWithdrawBusy = withdrawTx.status === 'submitting' || withdrawTx.status === 'pending';

  const Spinner = ({ size = 5 }: { size?: number }) => (
    <svg className={`animate-spin h-${size} w-${size}`} viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-2">Liquidity Pool</h1>
        <p className="text-gray-400">Provide liquidity to earn trading fees. LPs act as counterparty to traders.</p>
      </div>

      {/* Initialize prompt — blocking modal when no slots */}
      {connected && slotCount === 0 && !slotsLoading && (
        <InitializeSlotsPrompt
          onInitialize={initializeSlots}
          isInitializing={isInitializing}
          initTx={initTx}
        />
      )}

      {/* Pool Stats */}
      <div className="grid md:grid-cols-5 gap-4 mb-8">
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
        <div className={`bg-zkperp-card rounded-xl border p-5 ${
          availablePercent < 20 ? 'border-red-500/50' :
          availablePercent < 50 ? 'border-yellow-500/50' :
          'border-zkperp-border'
        }`}>
          <p className="text-gray-400 text-sm mb-1">Available to Withdraw</p>
          <p className={`text-2xl font-bold ${
            availablePercent < 20 ? 'text-red-400' :
            availablePercent < 50 ? 'text-yellow-400' :
            'text-zkperp-green'
          }`}>
            ${formatUsdc(availableLiquidity)}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            {availablePercent.toFixed(1)}% free · ${formatUsdc(totalOI)} locked
          </p>
        </div>
      </div>

      {/* OI Balance Bar */}
      <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5 mb-8">
        <p className="text-gray-400 text-sm mb-3">Long/Short Balance</p>
        <div className="h-4 bg-zkperp-dark rounded-full overflow-hidden flex">
          <div className="bg-zkperp-green h-full transition-all"
            style={{ width: totalOI > 0 ? `${Number((longOI * BigInt(100)) / totalOI)}%` : '50%' }} />
          <div className="bg-zkperp-red h-full transition-all"
            style={{ width: totalOI > 0 ? `${Number((shortOI * BigInt(100)) / totalOI)}%` : '50%' }} />
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

          {/* Approve */}
          <div className="mb-4 p-4 bg-blue-500/10 border border-blue-500/30 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <div>
                <p className="text-sm font-medium text-blue-400">Step 1: Approve USDCx</p>
                <p className="text-xs text-gray-400">Allow ZKPerp to use your USDCx</p>
              </div>
              {approveTx.status === 'accepted' && (
                <span className="text-xs bg-zkperp-green/20 text-zkperp-green px-2 py-1 rounded">✓ Approved</span>
              )}
            </div>
            <button
              onClick={handleApprove}
              disabled={!connected || approveTx.status === 'submitting' || approveTx.status === 'pending'}
              className="w-full py-2 bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/50 disabled:opacity-50 rounded-lg text-sm font-medium text-blue-400 transition-colors"
            >
              {approveTx.status === 'submitting' ? 'Submitting...'
                : approveTx.status === 'pending' ? 'Pending...'
                : approveTx.status === 'accepted' ? 'Approved ✓'
                : 'Approve USDCx (50,000)'}
            </button>
            <TransactionStatus
              status={approveTx.status}
              tempTxId={approveTx.tempTxId}
              onChainTxId={approveTx.onChainTxId}
              error={approveTx.error}
              onDismiss={approveTx.reset}
            />
          </div>

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

            <TransactionStatus
              status={depositTx.status}
              tempTxId={depositTx.tempTxId}
              onChainTxId={depositTx.onChainTxId}
              error={depositTx.error}
              onDismiss={depositTx.reset}
            />

            {/* Single decrypt-or-deposit button */}
            <button
              onClick={!decrypted ? decryptAll : handleDeposit}
              disabled={decrypting || isDepositBusy || (decrypted && (!connected || !isValidAmount))}
              className={`w-full py-3 rounded-lg font-semibold text-white transition-colors disabled:cursor-not-allowed ${
                !decrypted
                  ? 'bg-zkperp-accent hover:bg-zkperp-accent/80 disabled:bg-zkperp-accent/30'
                  : 'bg-blue-500 hover:bg-blue-600 disabled:bg-blue-500/30'
              }`}
            >
              {decrypting ? (
                <span className="flex items-center justify-center gap-2"><Spinner />Decrypting...</span>
              ) : depositTx.status === 'submitting' ? (
                <span className="flex items-center justify-center gap-2"><Spinner />Submitting...</span>
              ) : depositTx.status === 'pending' ? (
                <span className="flex items-center justify-center gap-2"><Spinner />Confirming on-chain...</span>
              ) : !connected ? (
                'Connect Wallet'
              ) : !decrypted ? (
                `🔓 Decrypt ${recordCount} Slot${recordCount !== 1 ? 's' : ''} to Deposit`
              ) : !isValidAmount ? (
                'Step 2: Add Liquidity'
              ) : (
                'Step 2: Add Liquidity'
              )}
            </button>
          </div>
        </div>

        {/* Info + LP Position */}
        <div className="space-y-4">
          <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
            <h3 className="font-semibold text-white mb-3">How it Works</h3>
            <ul className="space-y-3 text-sm text-gray-400">
              <li className="flex gap-2"><span className="text-zkperp-accent">1.</span>Deposit USDC to receive LP tokens representing your share</li>
              <li className="flex gap-2"><span className="text-zkperp-accent">2.</span>The pool acts as counterparty to all traders</li>
              <li className="flex gap-2"><span className="text-zkperp-accent">3.</span>Earn fees from opening positions (0.1%) and funding rates</li>
              <li className="flex gap-2"><span className="text-zkperp-accent">4.</span>Withdraw anytime by burning LP tokens</li>
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
                onClick={fetchRecords}
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
                <Spinner size={4} />
                <span className="text-sm">Loading LP records...</span>
              </div>
            ) : recordCount > 0 ? (
              <div className="space-y-3">
                <div className="bg-zkperp-dark rounded-lg p-4">
                  <div className="flex justify-between items-center">
                    <div>
                      <p className="text-gray-400 text-xs mb-1">LP Records Found</p>
                      <p className="text-xl font-bold text-white">{recordCount} records</p>
                    </div>
                    {decrypted && (
                      <div className="text-right">
                        <p className="text-gray-400 text-xs mb-1">Total Value</p>
                        <p className="text-lg font-semibold text-zkperp-green">${formatLPTokens(totalLP)}</p>
                      </div>
                    )}
                  </div>
                  {decrypted && poolLiquidity > BigInt(0) && totalLPTokens > BigInt(0) && (
                    <div className="flex justify-between text-xs text-gray-500 mt-2 pt-2 border-t border-zkperp-border">
                      <span>Pool Share</span>
                      <span>{((Number(totalLP) / Number(totalLPTokens)) * 100).toFixed(2)}%</span>
                    </div>
                  )}
                </div>

                {!decrypted ? (
                  /* Decrypt button in LP panel — also uses decryptAll */
                  <button
                    onClick={decryptAll}
                    disabled={decrypting}
                    className="w-full py-3 bg-zkperp-accent/20 hover:bg-zkperp-accent/30 border border-zkperp-accent/50 disabled:opacity-50 rounded-lg text-sm font-medium text-zkperp-accent transition-colors"
                  >
                    {decrypting ? (
                      <span className="flex items-center justify-center gap-2">
                        <Spinner size={4} />
                        Decrypting {recordCount} records...
                      </span>
                    ) : (
                      `🔓 Decrypt & Show ${recordCount} Records`
                    )}
                  </button>
                ) : (
                  <>
                    <div className="border-t border-zkperp-border pt-3">
                      <p className="text-sm text-gray-400 mb-2">LP Records ({lpTokens.length})</p>
                      <div className="space-y-2 max-h-64 overflow-y-auto">
                        {lpTokens.map((token, idx) => {
                          const poolLPSupply = totalLPTokens > 0n ? totalLPTokens : 1n;
                          const maxEntitled = poolLiquidity > 0n
                            ? (token.lpAmount * poolLiquidity) / poolLPSupply
                            : token.lpAmount;
                          const maxWithdraw = maxEntitled > availableLiquidity ? availableLiquidity : maxEntitled;
                          const inputVal = withdrawAmounts[token.id] || '';
                          const parsedInput = parseUsdc(inputVal);
                          const isOverMax = parsedInput > maxWithdraw;

                          return (
                            <div key={token.id || idx} className="bg-zkperp-dark rounded-lg p-3 space-y-2">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                  <div className="w-7 h-7 rounded-full bg-blue-500/20 flex items-center justify-center text-blue-400 text-xs font-bold">
                                    {idx + 1}
                                  </div>
                                  <div>
                                    <p className="text-white text-sm font-medium">{formatLPTokens(token.lpAmount)} LP</p>
                                    <p className={`text-xs ${maxWithdraw === 0n ? 'text-red-400' : 'text-gray-500'}`}>
                                      Max withdraw: ${formatUsdc(maxWithdraw)}
                                      {maxWithdraw < maxEntitled && (
                                        <span className="text-yellow-500 ml-1">(locked: ${formatUsdc(totalOI)})</span>
                                      )}
                                    </p>
                                  </div>
                                </div>
                              </div>
                              <div className="flex gap-2">
                                <div className="relative flex-1">
                                  <input
                                    type="number"
                                    placeholder={`Max $${formatUsdc(maxWithdraw)}`}
                                    value={inputVal}
                                    onChange={(e) => setWithdrawAmounts(prev => ({ ...prev, [token.id]: e.target.value }))}
                                    disabled={maxWithdraw === 0n || isWithdrawBusy}
                                    className={`w-full bg-zkperp-card border rounded px-3 py-1.5 text-white text-sm placeholder-gray-600 focus:outline-none disabled:opacity-40 ${
                                      isOverMax ? 'border-red-500' : 'border-zkperp-border focus:border-blue-500'
                                    }`}
                                  />
                                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-xs">USDC</span>
                                </div>
                                <button
                                  onClick={() => setWithdrawAmounts(prev => ({ ...prev, [token.id]: formatUsdc(maxWithdraw) }))}
                                  disabled={maxWithdraw === 0n || isWithdrawBusy}
                                  className="px-2 py-1.5 bg-zkperp-card border border-zkperp-border hover:border-blue-500 disabled:opacity-40 rounded text-xs text-gray-400 hover:text-white transition-colors"
                                >
                                  Max
                                </button>
                                <button
                                  onClick={() => handleWithdrawRecord(token)}
                                  disabled={isWithdrawBusy || withdrawRecordId === token.id || maxWithdraw === 0n || isOverMax}
                                  className="px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 hover:border-red-500/50 disabled:opacity-50 rounded-lg text-xs font-medium text-red-400 transition-colors"
                                >
                                  {withdrawRecordId === token.id ? '...' : 'Withdraw'}
                                </button>
                              </div>
                              {isOverMax && (
                                <p className="text-xs text-red-400">Amount exceeds max withdrawable (${formatUsdc(maxWithdraw)})</p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    <TransactionStatus
                      status={withdrawTx.status}
                      tempTxId={withdrawTx.tempTxId}
                      onChainTxId={withdrawTx.onChainTxId}
                      error={withdrawTx.error}
                      onDismiss={withdrawTx.reset}
                    />
                  </>
                )}
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
