import { useEffect, useCallback } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import { useTransaction } from '@/hooks/useTransaction';
import { TransactionStatus } from '@/components/TransactionStatus';
import { useOrderReceipts, type OrderReceiptRecord } from '@/hooks/useOrderReceipts';
import { formatPrice, formatUsdc, PROGRAM_ID } from '@/utils/aleo';

function normalizeRecordPlaintext(plaintext: string): string {
  return plaintext
    .replace(/\s+/g, ' ')
    .replace(/{ /g, '{').replace(/ }/g, '}')
    .replace(/,\s+/g, ',').replace(/:\s+/g, ':')
    .trim();
}

export function PendingOrdersDisplay() {
  const { connected } = useWallet();
  const cancelTx = useTransaction();

  const {
    receipts,
    recordCount,
    loading,
    decrypting,
    decrypted,
    error,
    fetchRecords,
    decryptAll,
    markSpent,
  } = useOrderReceipts();

  useEffect(() => {
    if (connected) fetchRecords();
  }, [connected, fetchRecords]);

  // Auto-decrypt once records are fetched
  useEffect(() => {
    if (recordCount && recordCount > 0 && !decrypted && !decrypting) {
      decryptAll();
    }
  }, [recordCount, decrypted, decrypting, decryptAll]);

  const handleCancel = useCallback(async (receipt: OrderReceiptRecord) => {
    if (!connected) return;
    try {
      if (receipt.orderType === 0) {
        await cancelTx.execute({
          program: PROGRAM_ID,
          function: 'cancel_limit_order',
          inputs: [
            normalizeRecordPlaintext(receipt.plaintext),
            receipt.collateralUsdc.toString() + 'u128',
          ],
          fee: 4_000_000,
          privateFee: false,
        });
      } else {
        await cancelTx.execute({
          program: PROGRAM_ID,
          function: 'cancel_tp_sl',
          inputs: [normalizeRecordPlaintext(receipt.plaintext)],
          fee: 3_000_000,
          privateFee: false,
        });
      }
      markSpent(receipt.id);
    } catch (err) {
      console.error('Cancel failed:', err);
    }
  }, [connected, cancelTx, markSpent]);

  if (!connected) return null;
  if (loading) return null;
  if (recordCount === 0 || (decrypted && receipts.length === 0)) return null;

  // Found but not decrypted yet
  if (!decrypted && recordCount && recordCount > 0) {
    return (
      <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-4">
        <h3 className="text-sm font-semibold text-white mb-2">Pending Orders</h3>
        <p className="text-xs text-gray-500">{recordCount} order{recordCount > 1 ? 's' : ''} found</p>
        <button
          onClick={decryptAll}
          disabled={decrypting}
          className="mt-2 w-full py-2 bg-zkperp-accent/20 hover:bg-zkperp-accent/30 border border-zkperp-accent/50 disabled:opacity-50 rounded-lg text-xs font-medium text-zkperp-accent transition-colors"
        >
          {decrypting ? 'Decrypting...' : '🔓 Decrypt Orders'}
        </button>
      </div>
    );
  }

  if (!decrypted || receipts.length === 0) return null;

  const isCancelBusy = cancelTx.status === 'submitting' || cancelTx.status === 'pending';

  return (
    <div className="bg-zkperp-card rounded-xl border border-zkperp-border overflow-hidden">
      <div className="flex items-center justify-between p-4 border-b border-zkperp-border">
        <h3 className="text-sm font-semibold text-white">
          Pending Orders
          <span className="ml-2 text-xs text-gray-500">({receipts.length})</span>
        </h3>
        <button
          onClick={fetchRecords}
          disabled={loading}
          className="text-xs text-zkperp-accent hover:text-zkperp-accent/80 disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      <div className="divide-y divide-zkperp-border">
        {receipts.map((receipt) => {
          const typeColor = receipt.orderType === 0
            ? 'text-zkperp-accent border-zkperp-accent/30 bg-zkperp-accent/10'
            : receipt.orderType === 1
            ? 'text-zkperp-green border-zkperp-green/30 bg-zkperp-green/10'
            : 'text-zkperp-red border-zkperp-red/30 bg-zkperp-red/10';

          return (
            <div key={receipt.id} className="p-4">
              {/* Header */}
              <div className="flex items-center gap-2 mb-3">
                <span className={`px-2 py-0.5 rounded text-xs font-medium border ${typeColor}`}>
                  {receipt.orderTypeStr}
                </span>
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                  receipt.isLong
                    ? 'bg-zkperp-green/20 text-zkperp-green'
                    : 'bg-zkperp-red/20 text-zkperp-red'
                }`}>
                  {receipt.isLong ? 'LONG' : 'SHORT'}
                </span>
                <span className="text-gray-400 text-xs">BTC/USD</span>
              </div>

              {/* Details */}
              <div className="grid grid-cols-2 gap-2 text-xs mb-3">
                <div>
                  <p className="text-gray-500">Trigger Price</p>
                  <p className="text-white font-medium">${formatPrice(receipt.triggerPrice)}</p>
                </div>
                <div>
                  <p className="text-gray-500">Size</p>
                  <p className="text-white">${formatUsdc(receipt.sizeUsdc)}</p>
                </div>
                {receipt.orderType === 0 ? (
                  <div>
                    <p className="text-gray-500">Collateral (locked)</p>
                    <p className="text-white">${formatUsdc(receipt.collateralUsdc)}</p>
                  </div>
                ) : (
                  <div>
                    <p className="text-gray-500">Entry Price</p>
                    <p className="text-white">${formatPrice(receipt.entryPrice)}</p>
                  </div>
                )}
              </div>

              {/* Cancel button */}
              <button
                onClick={() => handleCancel(receipt)}
                disabled={isCancelBusy}
                className="w-full py-1.5 bg-zkperp-dark border border-zkperp-border hover:border-red-500/50 hover:text-red-400 rounded-lg text-xs text-gray-400 disabled:opacity-50 transition-colors"
              >
                {isCancelBusy ? 'Cancelling...' : 'Cancel Order'}
              </button>

              {isCancelBusy && (
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
            </div>
          );
        })}
      </div>

      {error && (
        <div className="p-3 bg-zkperp-red/10 border-t border-zkperp-red/30">
          <p className="text-zkperp-red text-xs">{error}</p>
        </div>
      )}
    </div>
  );
}
