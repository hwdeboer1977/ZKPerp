// LiquidityPage.tsx — multi-pair version
// Route: /liquidity/:pair  (e.g. /liquidity/btc, /liquidity/eth, /liquidity/sol)
//
// CHANGES FROM SINGLE-PAIR VERSION:
//   1. Accepts `pair: PairId` prop
//   2. Pair selector tabs at the top (same pattern as TradePage)
//   3. All pool stat labels reference pairConfig.baseAsset where relevant
//   4. Everything else (LP slot logic, deposit, withdraw, USDCx) is UNCHANGED

import { useState, useCallback, useEffect } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import type { TransactionOptions } from '@provablehq/aleo-types';
import { useLPTokens, formatLPTokens } from '@/hooks/useLPTokens';
import { useSlots } from '@/hooks/useSlots';
import { useUSDCx } from '@/hooks/useUSDCx';
import { InitializeSlotsPrompt } from '@/components/InitializeSlotsPrompt';
import type { LPSlotRecord } from '@/hooks/useLPTokens';
import { formatUsdc, parseUsdc, USDCX_PROGRAM_ID } from '@/utils/aleo';
import { getMerkleProof } from '@/utils/merkleProof';
import { useTransaction } from '@/hooks/useTransaction';
import { TransactionStatus } from '@/components/TransactionStatus';
import { getPair, PAIR_IDS } from '@/config/pairs';   // ← new
import type { PairId } from '@/config/pairs';           // ← new

interface Props {
  pair: PairId;               // ← NEW
  poolLiquidity: bigint;
  totalLPTokens: bigint;
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

export function LiquidityPage({ pair, poolLiquidity, totalLPTokens, longOI, shortOI, onRefresh }: Props) {
  // ── Pair config ────────────────────────────────────────────────────────────
  const pairConfig = getPair(pair);
  const PROGRAM_ID = pairConfig.programId;  // shadows any imported constant

  const { address, connected } = useWallet();

  const {
    lpTokens, totalLP, recordCount,
    loading: lpLoading, decrypting, decrypted,
    fetchRecords, decryptAll,
    getEmptySlot, getOpenSlot, markSpent,
  } = useLPTokens(PROGRAM_ID);

  const {
    recordCount: slotCount,
    loading: slotsLoading,
    fetchSlots,
    initializeSlots,
    isInitializing,
    initTx,
  } = useSlots(PROGRAM_ID);

  const {
    tokens: usdcTokens,
    total: usdcTotal,
    loading: usdcLoading,
    decrypted: usdcDecrypted,
    fetchAndDecrypt: fetchUSDCx,
    markSpent: markUSDCxSpent,
  } = useUSDCx();

  const depositTx = useTransaction();
  const withdrawTx = useTransaction();

  const [depositAmount, setDepositAmount] = useState('');
  const [withdrawRecordId, setWithdrawRecordId] = useState<string | null>(null);
  const [withdrawAmounts, setWithdrawAmounts] = useState<Record<string, string>>({});

  // Reset form when pair changes
  useEffect(() => {
    setDepositAmount('');
    setWithdrawAmounts({});
  }, [pair]);

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
      if (usdcDecrypted) fetchUSDCx();
    }
  }, [depositTx.status, withdrawTx.status, onRefresh, fetchRecords, fetchUSDCx, usdcDecrypted]);

  // ── Pool math ──────────────────────────────────────────────────────────────
  const totalOI = longOI + shortOI;
  const utilization = poolLiquidity > 0n
    ? Number((totalOI * BigInt(100)) / poolLiquidity)
    : 0;

  // Safety buffer: 10% of total liquidity (WITHDRAWAL_BUFFER_BPS = 100_000 / 1_000_000)
  const safetyBuffer = (poolLiquidity * 100_000n) / 1_000_000n;
  const totalLocked = totalOI + safetyBuffer;
  const availableLiquidity = poolLiquidity > totalLocked ? poolLiquidity - totalLocked : 0n;
  const availablePercent = poolLiquidity > 0n
    ? Number((availableLiquidity * 100n) / poolLiquidity)
    : 0;

  const parsedDepositAmount = parseUsdc(depositAmount);
  const isValidAmount = parsedDepositAmount >= 100n;

  // ── Deposit ────────────────────────────────────────────────────────────────
  const handleDeposit = useCallback(async () => {
    if (!connected || !isValidAmount || !address) return;
    if (!decrypted) { console.error('Decrypt your LP slots first'); return; }
    if (!usdcDecrypted || usdcTokens.length === 0) { console.error('Decrypt USDCx first'); return; }

    const candidates = [getOpenSlot(), getEmptySlot()].filter(Boolean) as LPSlotRecord[];
    if (candidates.length === 0) { console.error('No LPSlot available'); return; }

    const usdcToken = usdcTokens.find(t => t.amount >= parsedDepositAmount);
    if (!usdcToken) { console.error('No single Token record covers deposit amount'); return; }

    const merkleProof = await getMerkleProof(USDCX_PROGRAM_ID, address);

    for (const slot of candidates) {
      try {
        markSpent(slot.id);
        markUSDCxSpent(usdcToken.id);

        const inputs = [
          normalizeRecordPlaintext(slot.plaintext),
          normalizeRecordPlaintext(usdcToken.plaintext),
          parsedDepositAmount.toString() + 'u64',
          merkleProof,
          address,
        ];

        await depositTx.execute({
          program: PROGRAM_ID,   // ← pair-specific
          function: 'add_liquidity',
          inputs,
          fee: 5_000_000,
          privateFee: false,
        } as TransactionOptions);

        setDepositAmount('');
        return;
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (msg.includes('already exists in the ledger')) {
          console.warn('Slot already spent, trying next:', slot.id);
          continue;
        }
        console.error('Deposit failed:', err);
        return;
      }
    }
    console.error('All slots stale — refresh and re-decrypt');
  }, [connected, isValidAmount, parsedDepositAmount, address, depositTx,
      usdcTokens, usdcDecrypted, getEmptySlot, getOpenSlot, markSpent,
      markUSDCxSpent, decrypted, PROGRAM_ID]);

  // ── Withdraw ───────────────────────────────────────────────────────────────
  const handleWithdrawRecord = useCallback(async (lpToken: LPSlotRecord) => {
    if (!connected) return;
    try {
      setWithdrawRecordId(lpToken.id);

      let freshLiquidity = poolLiquidity;
      let freshLPTokens = totalLPTokens;
      let freshAvailable = availableLiquidity;

      try {
        const res = await fetch(
          `https://api.explorer.provable.com/v1/testnet/program/${PROGRAM_ID}/mapping/pool_state/0field`
        );
        if (res.ok) {
          const raw = await res.text();
          const cleaned = raw.replace(/\s+/g, '');
          const extract = (key: string) => {
            const m = cleaned.match(new RegExp(`${key}:(\\d+)u64`));
            return m ? BigInt(m[1]) : 0n;
          };
          freshLiquidity = extract('total_liquidity');
          freshLPTokens  = extract('total_lp_tokens');
          const freshLongOI  = extract('long_open_interest');
          const freshShortOI = extract('short_open_interest');
          const buffer = (freshLiquidity * 100_000n) / 1_000_000n;
          const minRemaining = freshLongOI + freshShortOI + buffer;
          freshAvailable = freshLiquidity > minRemaining ? freshLiquidity - minRemaining : 0n;
        }
      } catch (e) {
        console.warn('Could not fetch fresh pool state, using cached:', e);
      }

      const inputUsdc = parseUsdc(withdrawAmounts[lpToken.id] || '');
      const poolLPSupply = freshLPTokens > 0n ? freshLPTokens : 1n;

      let amountToBurn: bigint;
      let expectedUsdc: bigint;

      if (inputUsdc > 0n && freshLiquidity > 0n) {
        amountToBurn = (inputUsdc * poolLPSupply) / freshLiquidity;
        if (amountToBurn > lpToken.lpAmount) amountToBurn = lpToken.lpAmount;
        expectedUsdc = (amountToBurn * freshLiquidity) / poolLPSupply;
      } else {
        amountToBurn = lpToken.lpAmount;
        expectedUsdc = freshLiquidity > 0n && poolLPSupply > 0n
          ? (amountToBurn * freshLiquidity) / poolLPSupply
          : amountToBurn;
      }

      expectedUsdc = (expectedUsdc * 98n) / 100n;
      if (expectedUsdc > freshAvailable) expectedUsdc = freshAvailable;

      if (expectedUsdc === 0n) {
        alert('No liquidity available to withdraw right now — all funds are locked backing open positions.');
        setWithdrawRecordId(null);
        return;
      }

      markSpent(lpToken.id);
      await withdrawTx.execute({
        program: PROGRAM_ID,   // ← pair-specific
        function: 'remove_liquidity',
        inputs: [
          normalizeRecordPlaintext(lpToken.plaintext),
          amountToBurn.toString() + 'u64',
          expectedUsdc.toString() + 'u128',
        ],
        fee: 5_000_000,
        privateFee: false,
      } as TransactionOptions);
    } catch (err) {
      console.error('Withdraw failed:', err);
    } finally {
      setWithdrawRecordId(null);
    }
  }, [connected, poolLiquidity, totalLPTokens, availableLiquidity, withdrawAmounts,
      withdrawTx, markSpent, PROGRAM_ID]);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const quickAmounts = [10, 50, 100, 500, 1000];
  const isDepositBusy = depositTx.status === 'submitting' || depositTx.status === 'pending';
  const isWithdrawBusy = withdrawTx.status === 'submitting' || withdrawTx.status === 'pending';
  const bestToken = usdcTokens.find(t => t.amount >= parsedDepositAmount);
  const insufficientBalance = usdcDecrypted && usdcTokens.length > 0 && isValidAmount && !bestToken;
  const depositReady = decrypted && usdcDecrypted && usdcTokens.length > 0 && isValidAmount && !insufficientBalance;

  const Spinner = ({ size = 5 }: { size?: number }) => (
    <svg className={`animate-spin h-${size} w-${size}`} viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Page header with pair selector */}
      <div className="mb-8">
        {/* Pair selector tabs — same pattern as TradePage */}
        <div className="flex items-center gap-1 mb-4 p-1 bg-zkperp-card border border-zkperp-border rounded-xl w-fit">
          {PAIR_IDS.map((pid) => {
            const p = getPair(pid);
            const isActive = pid === pair;
            return (
              <a
                key={pid}
                href={`/liquidity/${pid}`}
                className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                  isActive
                    ? 'bg-zkperp-dark text-white'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                {p.label}
              </a>
            );
          })}
        </div>

        <h1 className="text-2xl font-bold text-white mb-2">
          {pairConfig.label} Liquidity Pool
        </h1>
        <p className="text-gray-400">
          Provide liquidity to earn trading fees. LPs act as counterparty to {pairConfig.baseAsset} traders.
        </p>
        <span className="inline-flex items-center gap-1.5 mt-2 text-xs bg-zkperp-accent/10 border border-zkperp-accent/30 text-zkperp-accent px-2.5 py-1 rounded-full">
          🔒 Fully private · USDCx Token records
        </span>
      </div>

      {/* Initialize prompt */}
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
          <p className="text-gray-400 text-sm mb-1">Long OI</p>
          <p className="text-2xl font-bold text-zkperp-green">${formatUsdc(longOI)}</p>
        </div>
        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
          <p className="text-gray-400 text-sm mb-1">Short OI</p>
          <p className="text-2xl font-bold text-zkperp-red">${formatUsdc(shortOI)}</p>
        </div>
        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
          <p className="text-gray-400 text-sm mb-1">Utilization</p>
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
            {availablePercent.toFixed(1)}% free · ${formatUsdc(totalOI)} OI · ${formatUsdc(safetyBuffer)} buffer
          </p>
        </div>
      </div>

      {/* OI Balance Bar */}
      <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5 mb-8">
        <p className="text-gray-400 text-sm mb-3">{pairConfig.baseAsset} Long/Short Balance</p>
        <div className="h-4 bg-zkperp-dark rounded-full overflow-hidden flex">
          <div className="bg-zkperp-green h-full transition-all"
            style={{ width: totalOI > 0n ? `${Number((longOI * 100n) / totalOI)}%` : '50%' }} />
          <div className="bg-zkperp-red h-full transition-all"
            style={{ width: totalOI > 0n ? `${Number((shortOI * 100n) / totalOI)}%` : '50%' }} />
        </div>
        <div className="flex justify-between mt-2 text-xs text-gray-500">
          <span>Long {totalOI > 0n ? Number((longOI * 100n) / totalOI) : 50}%</span>
          <span>Short {totalOI > 0n ? Number((shortOI * 100n) / totalOI) : 50}%</span>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6">

        {/* ── Deposit Form ───────────────────────────────────────────────── */}
        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
          <h2 className="text-lg font-semibold text-white mb-4">Add Liquidity</h2>

          {/* Step 1 */}
          <div className="mb-4 p-4 bg-zkperp-dark border border-zkperp-border rounded-lg space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-300">Step 1: LP Slot</p>
                <p className="text-xs text-gray-500">Decrypt your persistent LP slot record</p>
              </div>
              {decrypted && <span className="text-xs bg-zkperp-green/20 text-zkperp-green px-2 py-1 rounded">✓ Ready</span>}
            </div>
            {!decrypted && recordCount > 0 && (
              <button onClick={decryptAll} disabled={decrypting}
                className="w-full py-2 bg-zkperp-accent/20 hover:bg-zkperp-accent/30 border border-zkperp-accent/50 disabled:opacity-50 rounded-lg text-sm font-medium text-zkperp-accent transition-colors">
                {decrypting
                  ? <span className="flex items-center justify-center gap-2"><Spinner size={4} />Decrypting...</span>
                  : `🔓 Decrypt ${recordCount} LP Slot${recordCount !== 1 ? 's' : ''}`}
              </button>
            )}
          </div>

          {/* Step 2 */}
          <div className="mb-4 p-4 bg-zkperp-dark border border-zkperp-border rounded-lg space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-300">Step 2: USDCx Tokens</p>
                <p className="text-xs text-gray-500">
                  {usdcDecrypted
                    ? `${usdcTokens.length} record${usdcTokens.length !== 1 ? 's' : ''} · Total: $${formatUsdc(usdcTotal)}`
                    : 'Load your private USDCx Token records'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {usdcDecrypted && usdcTokens.length > 0 && (
                  <span className="text-xs bg-zkperp-green/20 text-zkperp-green px-2 py-1 rounded">✓ Ready</span>
                )}
                <button onClick={fetchUSDCx} disabled={usdcLoading || !connected}
                  className="text-xs text-zkperp-accent hover:text-zkperp-accent/80 disabled:opacity-40">
                  {usdcLoading ? '…' : '↻'}
                </button>
              </div>
            </div>
            {!usdcDecrypted && connected && (
              <button onClick={fetchUSDCx} disabled={usdcLoading}
                className="w-full py-2 bg-zkperp-accent/20 hover:bg-zkperp-accent/30 border border-zkperp-accent/50 disabled:opacity-50 rounded-lg text-sm font-medium text-zkperp-accent transition-colors">
                {usdcLoading
                  ? <span className="flex items-center justify-center gap-2"><Spinner size={4} />Scanning...</span>
                  : '🔓 Scan & Decrypt USDCx'}
              </button>
            )}
            {usdcDecrypted && usdcTokens.length === 0 && (
              <p className="text-xs text-yellow-500">No USDCx Token records found.</p>
            )}
            {usdcDecrypted && usdcTokens.length > 1 && (
              <div className="mt-2 space-y-1">
                <p className="text-xs text-yellow-400">
                  ⚠️ Balance split across {usdcTokens.length} records. Max per deposit: ${formatUsdc(usdcTokens[0]?.amount ?? 0n)}
                </p>
                <div className="space-y-0.5 max-h-24 overflow-y-auto">
                  {usdcTokens.map((t, i) => (
                    <div key={t.id} className="flex justify-between text-xs text-gray-500">
                      <span>Record {i + 1}</span>
                      <button onClick={() => setDepositAmount((Number(t.amount) / 1_000_000).toFixed(6))}
                        className="text-zkperp-accent hover:underline">
                        ${formatUsdc(t.amount)} ↑ use
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Step 3 */}
          <div className="space-y-4">
            <div>
              <label className="flex justify-between text-sm mb-2">
                <span className="text-gray-400">Step 3: Deposit Amount</span>
                <div className="flex items-center gap-2">
                  {usdcDecrypted && usdcTokens.length > 0 && (
                    <button onClick={() => setDepositAmount((Number(usdcTokens[0]?.amount ?? 0n) / 1_000_000).toFixed(6))}
                      className="text-xs text-zkperp-accent hover:underline">
                      Max ${formatUsdc(usdcTokens[0]?.amount ?? 0n)}
                    </button>
                  )}
                  <span className="text-gray-500 text-xs">per record</span>
                </div>
              </label>
              <div className="relative">
                <input type="number" value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  placeholder="0.00"
                  disabled={!usdcDecrypted || usdcTokens.length === 0}
                  className={`w-full bg-zkperp-dark border rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:outline-none disabled:opacity-40 ${
                    insufficientBalance ? 'border-red-500' : 'border-zkperp-border focus:border-blue-500'
                  }`}
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500">USDCx</span>
              </div>
              {insufficientBalance && (
                <p className="text-xs text-red-400 mt-1">
                  Exceeds largest record (${formatUsdc(usdcTokens[0]?.amount ?? 0n)}). Click "↑ use" above or Max.
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {quickAmounts
                .filter(amt => BigInt(amt * 1_000_000) <= (usdcTokens[0]?.amount ?? BigInt(Number.MAX_SAFE_INTEGER)))
                .map((amt) => (
                  <button key={amt} onClick={() => setDepositAmount(amt.toString())}
                    disabled={!usdcDecrypted || usdcTokens.length === 0}
                    className="px-4 py-2 text-sm bg-zkperp-dark border border-zkperp-border rounded-lg text-gray-400 hover:text-white hover:border-blue-500 disabled:opacity-40 transition-colors">
                    ${amt}
                  </button>
                ))}
            </div>

            <div className="bg-zkperp-dark rounded-lg p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">You deposit</span>
                <span className="text-white">${depositAmount || '0.00'} USDCx</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">You receive</span>
                <span className="text-blue-400">~{depositAmount || '0'} LP tokens</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Pool</span>
                <span className="text-zkperp-accent text-xs">{pairConfig.label}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Privacy</span>
                <span className="text-zkperp-accent text-xs">🔒 private · ZK proof</span>
              </div>
            </div>

            <TransactionStatus
              status={depositTx.status}
              tempTxId={depositTx.tempTxId}
              onChainTxId={depositTx.onChainTxId}
              error={depositTx.error}
              onDismiss={depositTx.reset}
            />

            <button onClick={handleDeposit}
              disabled={!connected || !depositReady || isDepositBusy}
              className="w-full py-3 rounded-lg font-semibold text-white transition-colors disabled:cursor-not-allowed bg-blue-500 hover:bg-blue-600 disabled:bg-blue-500/30">
              {!connected ? 'Connect Wallet'
                : isDepositBusy
                  ? depositTx.status === 'submitting'
                    ? <span className="flex items-center justify-center gap-2"><Spinner />Submitting...</span>
                    : <span className="flex items-center justify-center gap-2"><Spinner />Confirming...</span>
                  : !decrypted ? 'Decrypt LP Slot First'
                  : !usdcDecrypted ? 'Scan USDCx Records First'
                  : usdcTokens.length === 0 ? 'No USDCx Token Records'
                  : !isValidAmount ? 'Enter Amount to Deposit'
                  : insufficientBalance ? `Max $${formatUsdc(usdcTokens[0]?.amount ?? 0n)} per record`
                  : `Add Liquidity to ${pairConfig.label}`}
            </button>
          </div>
        </div>

        {/* ── Info + LP Position ─────────────────────────────────────────── */}
        <div className="space-y-4">
          <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
            <h3 className="font-semibold text-white mb-3">How it Works</h3>
            <ul className="space-y-3 text-sm text-gray-400">
              <li className="flex gap-2"><span className="text-zkperp-accent">1.</span>Initialize slots once — creates your persistent LP slot record</li>
              <li className="flex gap-2"><span className="text-zkperp-accent">2.</span>Deposit private USDCx into the {pairConfig.label} pool — amount hidden via ZK proof</li>
              <li className="flex gap-2"><span className="text-zkperp-accent">3.</span>LP balance stored in an encrypted on-chain record (only you can see it)</li>
              <li className="flex gap-2"><span className="text-zkperp-accent">4.</span>Withdraw anytime — payout arrives as a private USDCx Token record</li>
            </ul>
          </div>

          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-5">
            <h3 className="font-semibold text-yellow-500 mb-2">⚠️ Risk Warning</h3>
            <p className="text-sm text-gray-400">
              LP funds pay winning {pairConfig.baseAsset} traders. If traders are net profitable, LPs lose money.
              The pool benefits when traders lose or from collected fees.
            </p>
          </div>

          {/* LP Position panel */}
          <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
            <div className="flex justify-between items-center mb-4">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-white">Your LP Position</h3>
                <span className="text-xs bg-zkperp-accent/20 text-zkperp-accent px-2 py-0.5 rounded">{pairConfig.label}</span>
              </div>
              <button onClick={fetchRecords} disabled={lpLoading || !connected}
                className="text-sm text-zkperp-accent hover:text-zkperp-accent/80 disabled:opacity-50">
                {lpLoading ? 'Loading...' : '↻ Refresh'}
              </button>
            </div>

            {!connected ? (
              <p className="text-gray-400 text-sm">Connect wallet to view your LP position</p>
            ) : lpLoading ? (
              <div className="flex items-center gap-2 text-gray-400">
                <Spinner size={4} /><span className="text-sm">Loading LP records...</span>
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
                        <p className="text-gray-400 text-xs mb-1">Total LP Balance</p>
                        <p className="text-lg font-semibold text-zkperp-green">{formatLPTokens(totalLP)} LP</p>
                      </div>
                    )}
                  </div>
                  {decrypted && poolLiquidity > 0n && totalLPTokens > 0n && (
                    <div className="flex justify-between text-xs text-gray-500 mt-2 pt-2 border-t border-zkperp-border">
                      <span>Pool Share</span>
                      <span>{((Number(totalLP) / Number(totalLPTokens)) * 100).toFixed(2)}%</span>
                    </div>
                  )}
                </div>

                {!decrypted ? (
                  <button onClick={decryptAll} disabled={decrypting}
                    className="w-full py-3 bg-zkperp-accent/20 hover:bg-zkperp-accent/30 border border-zkperp-accent/50 disabled:opacity-50 rounded-lg text-sm font-medium text-zkperp-accent transition-colors">
                    {decrypting
                      ? <span className="flex items-center justify-center gap-2"><Spinner size={4} />Decrypting {recordCount} records...</span>
                      : `🔓 Decrypt & Show ${recordCount} Records`}
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
                                        <span className="text-yellow-500 ml-1">(locked: ${formatUsdc(totalOI)} OI + ${formatUsdc(safetyBuffer)} buffer)</span>
                                      )}
                                    </p>
                                  </div>
                                </div>
                              </div>
                              <div className="flex gap-2">
                                <div className="relative flex-1">
                                  <input type="number"
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
                                  className="px-2 py-1.5 bg-zkperp-card border border-zkperp-border hover:border-blue-500 disabled:opacity-40 rounded text-xs text-gray-400 hover:text-white transition-colors">
                                  Max
                                </button>
                                <button
                                  onClick={() => handleWithdrawRecord(token)}
                                  disabled={isWithdrawBusy || withdrawRecordId === token.id || maxWithdraw === 0n || isOverMax}
                                  className="px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 hover:border-red-500/50 disabled:opacity-50 rounded-lg text-xs font-medium text-red-400 transition-colors">
                                  {withdrawRecordId === token.id ? '...' : 'Withdraw'}
                                </button>
                              </div>
                              {isOverMax && (
                                <p className="text-xs text-red-400">Amount exceeds max (${formatUsdc(maxWithdraw)})</p>
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
                <p className="text-gray-400 text-sm">No LP tokens found for {pairConfig.label}</p>
                <p className="text-gray-500 text-xs mt-1">Add liquidity to start earning</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
