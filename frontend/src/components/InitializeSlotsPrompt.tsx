import { useState } from 'react';
import { TransactionStatus } from '@/components/TransactionStatus';
import type { TxStatus } from '@/hooks/useTransaction';

interface Props {
  onInitialize: () => void;
  isInitializing: boolean;
  initTx: {
    status: TxStatus;
    tempTxId: string | null;
    onChainTxId: string | null;
    error: string | null;
    reset: () => void;
  };
}

const STEPS = [
  {
    icon: '🔑',
    title: 'Slot-Based Wallet',
    body: 'ZKPerp uses fixed-size record slots so your wallet stays clean forever. No matter how many trades you make, you will always have exactly 3 records.',
  },
  {
    icon: '⚡',
    title: '2 Trading Slots + 1 LP Slot',
    body: 'Slot 0 holds your LONG position, Slot 1 holds your SHORT. One LP Slot accumulates your liquidity share. Each slot is reused every trade — consumed and reissued.',
  },
  {
    icon: '🛡️',
    title: 'Zero-Knowledge Privacy',
    body: 'Position size, collateral, and entry price are fully private on-chain. Only you can decrypt your records. Liquidation is trustless via a separate LiquidationAuth record sent to the orchestrator.',
  },
];

export function InitializeSlotsPrompt({ onInitialize, isInitializing, initTx }: Props) {
  const [step, setStep] = useState(0);
  const isLastStep = step === STEPS.length - 1;
  const isDone = initTx.status === 'accepted';

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)' }}
    >
      {/* Modal */}
      <div
        className="relative w-full max-w-md rounded-2xl overflow-hidden"
        style={{
          background: 'linear-gradient(145deg, #0f1117 0%, #141720 100%)',
          border: '1px solid rgba(99,102,241,0.25)',
          boxShadow: '0 0 60px rgba(99,102,241,0.12), 0 25px 50px rgba(0,0,0,0.6)',
        }}
      >
        {/* Top accent line */}
        <div
          className="h-0.5 w-full"
          style={{ background: 'linear-gradient(90deg, transparent, #6366f1, #8b5cf6, transparent)' }}
        />

        {/* Header */}
        <div className="px-8 pt-8 pb-6">
          <div className="flex items-center gap-3 mb-1">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold"
              style={{ background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)', color: '#818cf8' }}
            >
              ZK
            </div>
            <span className="text-xs font-medium tracking-widest uppercase" style={{ color: '#6366f1' }}>
              First-Time Setup
            </span>
          </div>
          <h2 className="text-2xl font-bold text-white mt-3">
            {isDone ? "🎉 You're all set!" : 'Initialize Your Account'}
          </h2>
          <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>
            {isDone
              ? 'Your slots are live on Aleo testnet. Start trading.'
              : 'A one-time transaction that mints your permanent trading slots.'}
          </p>
        </div>

        {/* Step content */}
        {!isDone && (
          <div className="px-8 pb-6">
            {/* Progress bar */}
            <div className="flex gap-1.5 mb-6">
              {STEPS.map((_, i) => (
                <div
                  key={i}
                  className="h-0.5 flex-1 rounded-full transition-all duration-300"
                  style={{ background: i <= step ? '#6366f1' : 'rgba(255,255,255,0.1)' }}
                />
              ))}
            </div>

            {/* Step card */}
            <div
              className="rounded-xl p-5 mb-6"
              style={{ background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.15)' }}
            >
              <div className="text-3xl mb-3">{STEPS[step].icon}</div>
              <h3 className="font-semibold text-white mb-2">{STEPS[step].title}</h3>
              <p className="text-sm leading-relaxed" style={{ color: '#94a3b8' }}>
                {STEPS[step].body}
              </p>
            </div>

            {/* Slot diagram on step 1 */}
            {step === 1 && (
              <div className="grid grid-cols-3 gap-2 mb-6">
                {[
                  { label: 'Slot 0', sub: 'LONG', color: '#22c55e' },
                  { label: 'Slot 1', sub: 'SHORT', color: '#ef4444' },
                  { label: 'LP Slot', sub: 'LIQUIDITY', color: '#6366f1' },
                ].map((s) => (
                  <div
                    key={s.label}
                    className="rounded-lg p-3 text-center"
                    style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid ${s.color}33` }}
                  >
                    <div className="w-2 h-2 rounded-full mx-auto mb-2" style={{ background: s.color }} />
                    <p className="text-xs font-semibold text-white">{s.label}</p>
                    <p className="text-xs mt-0.5" style={{ color: s.color }}>{s.sub}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Fee warning on last step */}
            {isLastStep && (
              <div
                className="rounded-lg p-3 mb-6 flex gap-3 items-start"
                style={{ background: 'rgba(250,204,21,0.06)', border: '1px solid rgba(250,204,21,0.2)' }}
              >
                <span className="text-yellow-400 mt-0.5 shrink-0">⚠</span>
                <div>
                  <p className="text-xs font-medium text-yellow-300">One-time transaction fee</p>
                  <p className="text-xs mt-0.5" style={{ color: '#94a3b8' }}>
                    ~3 credits for the on-chain transaction. Slots last forever.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Done state — slot confirmation */}
        {isDone && (
          <div className="px-8 pb-6">
            <div className="grid grid-cols-3 gap-2 mb-6">
              {[
                { label: 'Long Slot', icon: '📈', color: '#22c55e' },
                { label: 'Short Slot', icon: '📉', color: '#ef4444' },
                { label: 'LP Slot', icon: '💧', color: '#6366f1' },
              ].map((s) => (
                <div
                  key={s.label}
                  className="rounded-lg p-3 text-center"
                  style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid ${s.color}40` }}
                >
                  <div className="text-xl mb-1">{s.icon}</div>
                  <p className="text-xs text-white font-medium">{s.label}</p>
                  <p className="text-xs mt-0.5" style={{ color: '#22c55e' }}>✓ Ready</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Transaction status */}
        {initTx.status !== 'idle' && (
          <div className="px-8 pb-4">
            <TransactionStatus
              status={initTx.status}
              tempTxId={initTx.tempTxId}
              onChainTxId={initTx.onChainTxId}
              error={initTx.error}
              onDismiss={initTx.reset}
            />
          </div>
        )}

        {/* Buttons */}
        <div className="px-8 pb-8 flex gap-3">
          {!isDone && !isLastStep && (
            <>
              {step > 0 && (
                <button
                  onClick={() => setStep((s) => s - 1)}
                  className="flex-1 py-3 rounded-xl text-sm font-medium transition-colors"
                  style={{ background: 'rgba(255,255,255,0.05)', color: '#94a3b8', border: '1px solid rgba(255,255,255,0.08)' }}
                >
                  Back
                </button>
              )}
              <button
                onClick={() => setStep((s) => s + 1)}
                className="flex-1 py-3 rounded-xl text-sm font-semibold text-white transition-all"
                style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', boxShadow: '0 4px 20px rgba(99,102,241,0.3)' }}
              >
                Next →
              </button>
            </>
          )}

          {!isDone && isLastStep && (
            <>
              <button
                onClick={() => setStep((s) => s - 1)}
                className="py-3 px-5 rounded-xl text-sm font-medium transition-colors"
                style={{ background: 'rgba(255,255,255,0.05)', color: '#94a3b8', border: '1px solid rgba(255,255,255,0.08)' }}
              >
                Back
              </button>
              <button
                onClick={onInitialize}
                disabled={isInitializing || initTx.status === 'submitting' || initTx.status === 'pending'}
                className="flex-1 py-3 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', boxShadow: '0 4px 20px rgba(99,102,241,0.3)' }}
              >
                {isInitializing || initTx.status === 'submitting' || initTx.status === 'pending' ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Initializing...
                  </span>
                ) : (
                  '🔑 Initialize Account'
                )}
              </button>
            </>
          )}

          {isDone && (
            <button
              onClick={() => window.location.reload()}
              className="w-full py-3 rounded-xl text-sm font-semibold text-white transition-all"
              style={{ background: 'linear-gradient(135deg, #22c55e, #16a34a)', boxShadow: '0 4px 20px rgba(34,197,94,0.3)' }}
            >
              Start Trading →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
