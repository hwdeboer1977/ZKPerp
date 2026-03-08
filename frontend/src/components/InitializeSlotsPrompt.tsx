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

// Shown on Trade and Liquidity pages when the trader has no slots yet.
// One-time setup — mints 2 PositionSlots + 1 LPSlot.
export function InitializeSlotsPrompt({ onInitialize, isInitializing, initTx }: Props) {
  return (
    <div className="bg-zkperp-card rounded-xl border border-zkperp-accent/40 p-6 mb-6">
      <div className="flex items-start gap-4">
        <div className="w-10 h-10 rounded-lg bg-zkperp-accent/20 flex items-center justify-center shrink-0 text-xl">
          🔑
        </div>
        <div className="flex-1">
          <h3 className="font-semibold text-white mb-1">Initialize Your Account</h3>
          <p className="text-sm text-gray-400 mb-4">
            ZKPerp uses a slot-based system to keep your wallet clean.
            This one-time setup mints your 2 trading slots and 1 LP slot —
            your wallet will never accumulate more records than this, no matter how many trades you make.
          </p>

          <TransactionStatus
            status={initTx.status}
            tempTxId={initTx.tempTxId}
            onChainTxId={initTx.onChainTxId}
            error={initTx.error}
            onDismiss={initTx.reset}
          />

          <button
            onClick={onInitialize}
            disabled={isInitializing || initTx.status === 'accepted'}
            className="mt-2 px-6 py-2.5 bg-zkperp-accent hover:bg-zkperp-accent/80 disabled:bg-zkperp-accent/30 rounded-lg font-medium text-white transition-colors"
          >
            {initTx.status === 'accepted'
              ? '✅ Initialized! Refresh the page'
              : isInitializing
              ? 'Initializing...'
              : 'Initialize Account (one-time)'}
          </button>
        </div>
      </div>
    </div>
  );
}
