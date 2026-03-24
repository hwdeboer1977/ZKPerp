import { useState } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import { useTransaction } from '@/hooks/useTransaction';
import { type OrderReceiptRecord } from '@/hooks/useOrderReceipts';
import { TransactionStatus } from '@/components/TransactionStatus';
import { formatPrice, formatUsdc, PROGRAM_ID } from '@/utils/aleo';

const EXPLORER_API = 'https://api.explorer.provable.com/v1/testnet';

interface InnerProps {
  receipts: OrderReceiptRecord[];
  loading?: boolean;
  onCancelled?: (receiptId: string) => void;
}

function compact(pt: string) {
  return pt.substring(pt.indexOf('{'))
    .replace(/:\s+/g, ':').replace(/,\s+/g, ',')
    .replace(/\s*{\s*/g, '{').replace(/\s*}\s*/g, '}').trim();
}

function PendingOrdersDisplayInner({ receipts, loading, onCancelled }: InnerProps) {
  const { connected } = useWallet();
  const cancelTx = useTransaction();
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const handleCancelLimit = async (receipt: OrderReceiptRecord) => {
    setCancellingId(receipt.id);
    try {
      await cancelTx.execute({
        program: PROGRAM_ID,
        function: 'cancel_limit_order',
        inputs: [compact(receipt.plaintext)],
        fee: 3_000_000,
        privateFee: false,
      });

      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 5000));
        try {
          const res = await fetch(`${EXPLORER_API}/program/${PROGRAM_ID}/mapping/pending_orders/${receipt.orderId}`);
          const val = await res.text();
          if (!val || val.includes('null') || val.includes('false')) {
            onCancelled?.(receipt.id);
            setCancellingId(null);
            return;
          }
        } catch {}
      }
      setCancellingId(null);
    } catch (err) {
      console.error('Cancel limit failed:', err);
      setCancellingId(null);
    }
  };

  if (!connected || loading || receipts.length === 0) return null;

  return (
    <div className="mt-4 bg-zkperp-card rounded-xl border border-zkperp-border overflow-hidden">
      <div className="flex items-center justify-between p-4 border-b border-zkperp-border">
        <h3 className="text-sm font-semibold text-white">
          Pending Orders
          <span className="ml-2 text-xs text-gray-500">({receipts.length})</span>
        </h3>
      </div>

      <div className="divide-y divide-zkperp-border">
        {receipts.map((receipt) => {
          const isLimit = Number(receipt.orderType) === 0;
          const typeColor = isLimit
            ? 'text-zkperp-accent border-zkperp-accent/30 bg-zkperp-accent/10'
            : receipt.orderType === 1
            ? 'text-zkperp-green border-zkperp-green/30 bg-zkperp-green/10'
            : 'text-zkperp-red border-zkperp-red/30 bg-zkperp-red/10';
          const isCancelling = cancellingId === receipt.id;

          return (
            <div key={receipt.id} className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className={`px-2 py-0.5 rounded text-xs font-medium border ${typeColor}`}>
                  {receipt.orderTypeStr}
                </span>
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                  receipt.isLong ? 'bg-zkperp-green/20 text-zkperp-green' : 'bg-zkperp-red/20 text-zkperp-red'
                }`}>
                  {receipt.isLong ? 'LONG' : 'SHORT'}
                </span>
                <span className="text-gray-400 text-xs">BTC/USD</span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs mb-3">
                <div>
                  <p className="text-gray-500">Trigger Price</p>
                  <p className="text-white font-medium">${formatPrice(receipt.triggerPrice)}</p>
                </div>
                <div>
                  <p className="text-gray-500">Size</p>
                  <p className="text-white">${formatUsdc(receipt.sizeUsdc)}</p>
                </div>
                {!isLimit && receipt.entryPrice > 0n && (
                  <div>
                    <p className="text-gray-500">Entry Price</p>
                    <p className="text-white">${formatPrice(receipt.entryPrice)}</p>
                  </div>
                )}
              </div>

              {isLimit && (
                <>
                  <button
                    onClick={() => handleCancelLimit(receipt)}
                    disabled={isCancelling || cancelTx.status === 'submitting' || cancelTx.status === 'pending'}
                    className="w-full py-2 rounded-lg text-xs font-medium transition-colors border border-red-500/30 text-red-400 hover:bg-red-500/10 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isCancelling ? '⏳ Cancelling...' : '✕ Cancel Limit Order'}
                  </button>
                  {cancelTx.status !== 'idle' && cancellingId === receipt.id && (
                    <div className="mt-2">
                      <TransactionStatus
                        status={cancelTx.status}
                        tempTxId={cancelTx.tempTxId}
                        onChainTxId={cancelTx.onChainTxId}
                        error={cancelTx.error}
                        onDismiss={cancelTx.reset}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface DisplayProps {
  receipts: OrderReceiptRecord[];
  decrypted: boolean;
  loading?: boolean;
  decrypting?: boolean;
  onCancelled?: (id: string) => void;
}

export function PendingOrdersDisplay({ receipts, decrypted, decrypting, onCancelled }: DisplayProps) {
  if (!decrypted) return null;

  return (
    <PendingOrdersDisplayInner
      receipts={receipts}
      loading={decrypting}
      onCancelled={onCancelled}
    />
  );
}
