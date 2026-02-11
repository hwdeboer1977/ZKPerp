/**
 * TransactionStatus - Displays real-time transaction status with polling feedback
 */
import type { TxStatus } from '@/hooks/useTransaction';

interface Props {
  status: TxStatus;
  tempTxId: string | null;
  onChainTxId: string | null;
  error: string | null;
  onDismiss?: () => void;
}

const STATUS_CONFIG: Record<TxStatus, { color: string; bg: string; icon: string; label: string }> = {
  idle: { color: 'text-gray-400', bg: 'bg-gray-500/10', icon: '', label: '' },
  submitting: { color: 'text-blue-400', bg: 'bg-blue-500/10', icon: '⏳', label: 'Submitting to wallet...' },
  pending: { color: 'text-yellow-400', bg: 'bg-yellow-500/10', icon: '🔄', label: 'Transaction pending — proving & broadcasting...' },
  accepted: { color: 'text-green-400', bg: 'bg-green-500/10', icon: '✅', label: 'Transaction accepted!' },
  rejected: { color: 'text-red-400', bg: 'bg-red-500/10', icon: '❌', label: 'Transaction rejected on-chain' },
  failed: { color: 'text-red-400', bg: 'bg-red-500/10', icon: '💥', label: 'Transaction failed' },
  error: { color: 'text-red-400', bg: 'bg-red-500/10', icon: '⚠️', label: 'Error' },
};

export function TransactionStatus({ status, tempTxId, onChainTxId, error, onDismiss }: Props) {
  if (status === 'idle') return null;

  const config = STATUS_CONFIG[status];
  const explorerBase = 'https://testnet.explorer.provable.com/transaction/';

  return (
    <div className={`${config.bg} border border-opacity-30 rounded-lg p-3 mt-3`}>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className={`flex items-center gap-2 ${config.color} font-medium text-sm`}>
            <span>{config.icon}</span>
            <span>{config.label}</span>
            {(status === 'submitting' || status === 'pending') && (
              <span className="animate-pulse">•••</span>
            )}
          </div>

          {tempTxId && (
            <p className="text-xs text-gray-500 mt-1">
              Tracking ID: <code className="text-gray-400">{tempTxId.slice(0, 20)}...</code>
            </p>
          )}

          {onChainTxId && (
            <p className="text-xs mt-1">
              <a
                href={`${explorerBase}${onChainTxId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-zkperp-accent hover:underline"
              >
                View on Explorer →
              </a>
            </p>
          )}

          {error && (
            <p className="text-xs text-red-400 mt-1">{error}</p>
          )}
        </div>

        {(status === 'accepted' || status === 'rejected' || status === 'failed' || status === 'error') && onDismiss && (
          <button
            onClick={onDismiss}
            className="text-gray-500 hover:text-white text-sm ml-2"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
