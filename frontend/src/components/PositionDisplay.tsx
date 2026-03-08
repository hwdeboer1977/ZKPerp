import { useState, useCallback } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import type { TransactionOptions } from '@provablehq/aleo-types';
import { useTransaction } from '@/hooks/useTransaction';
import { TransactionStatus } from '@/components/TransactionStatus';
import { useSlots, type PositionSlotRecord } from '@/hooks/useSlots';
import {
  formatUsdc,
  formatPrice,
  calculatePnL,
  calculateLeverage,
  PROGRAM_ID,
} from '@/utils/aleo';

interface Props {
  currentPrice: bigint;
}

const ALEO_API = 'https://api.explorer.provable.com/v1/testnet';

export function PositionDisplay({ currentPrice }: Props) {
  const { connected, decrypt } = useWallet();
  const closeTx = useTransaction();

  const {
    positionSlots,
    recordCount,
    loading,
    decrypting,
    decrypted,
    error,
    fetchSlots,
    decryptSlots,
    markSpent,
    needsInitialization,
  } = useSlots();

  const [closingId, setClosingId] = useState<string | null>(null);

  // Manual decrypt state
  const [showManualDecrypt, setShowManualDecrypt] = useState(false);
  const [ciphertextInput, setCiphertextInput] = useState('');
  const [decryptError, setDecryptError] = useState<string | null>(null);
  const [decryptLoading, setDecryptLoading] = useState(false);
  const [manualPositions, setManualPositions] = useState<PositionSlotRecord[]>([]);

  // Only show open slots (is_open === true)
  const openSlots = positionSlots.filter(s => s.isOpen);

  // Check if a position is closed on-chain (for manual decrypt only)
  const checkPositionClosedOnChain = async (positionId: string): Promise<boolean> => {
    try {
      const cleanId = positionId.replace('.private', '').replace('.public', '');
      const response = await fetch(
        `${ALEO_API}/program/${PROGRAM_ID}/mapping/closed_positions/${cleanId}`
      );
      if (!response.ok) return false;
      const data = await response.text();
      return data.includes('true');
    } catch {
      return false;
    }
  };

  // Close position using the slot's plaintext
  const handleClose = useCallback(async (slot: PositionSlotRecord) => {
    if (!connected) return;

    setClosingId(slot.id);
    try {
      const slippageAmount = (currentPrice * 1n) / 100n;
      const minPrice = currentPrice - slippageAmount;
      const maxPrice = currentPrice + slippageAmount;

      const priceDiff = currentPrice > slot.entryPrice
        ? currentPrice - slot.entryPrice
        : slot.entryPrice - currentPrice;
      const safeEntryPrice = slot.entryPrice + 1n;
      const pnlAbs = (slot.sizeUsdc * priceDiff) / safeEntryPrice;
      const isProfit = slot.isLong
        ? currentPrice > slot.entryPrice
        : currentPrice < slot.entryPrice;

      let expectedPayout: bigint;
      if (isProfit) {
        expectedPayout = slot.collateralUsdc + pnlAbs;
      } else {
        expectedPayout = pnlAbs >= slot.collateralUsdc
          ? BigInt(0)
          : slot.collateralUsdc - pnlAbs;
      }

      // 10% safety buffer
      expectedPayout = (expectedPayout * BigInt(90)) / BigInt(100);
      if (expectedPayout < BigInt(1)) expectedPayout = BigInt(1);

      console.log('=== CLOSE POSITION (slot-based) ===');
      console.log('Slot ID:', slot.slotId);
      console.log('Position ID:', slot.positionId);
      console.log('Plaintext:', slot.plaintext);
      console.log('Min price:', minPrice.toString());
      console.log('Max price:', maxPrice.toString());
      console.log('Expected payout:', expectedPayout.toString());

      const inputs = [
        slot.plaintext,
        `${minPrice}u64`,
        `${maxPrice}u64`,
        `${expectedPayout}u128`,
      ];

      const options: TransactionOptions = {
        program: PROGRAM_ID,
        function: 'close_position',
        inputs,
        fee: 5_000_000,
        privateFee: false,
      };

      await closeTx.execute(options);

      // Mark slot as spent so it disappears from UI immediately
      markSpent(slot.id);
    } catch (err) {
      console.error('Close failed:', err);
    } finally {
      setClosingId(null);
    }
  }, [connected, currentPrice, closeTx, markSpent]);

  // Manual decrypt handler (fallback for edge cases)
  const handleManualDecrypt = async () => {
    if (!decrypt || !ciphertextInput.trim()) return;

    setDecryptLoading(true);
    setDecryptError(null);

    try {
      const plaintext = await decrypt(ciphertextInput.trim());
      if (!plaintext) {
        setDecryptError('Could not decrypt — not your record?');
        return;
      }

      const slotIdMatch    = plaintext.match(/slot_id:\s*(\d+)u8(?:\.private)?/);
      const isOpenMatch    = plaintext.match(/is_open:\s*(true|false)(?:\.private)?/);
      const posIdMatch     = plaintext.match(/position_id:\s*(\d+field)(?:\.private)?/);
      const isLongMatch    = plaintext.match(/is_long:\s*(true|false)(?:\.private)?/);
      const sizeMatch      = plaintext.match(/size_usdc:\s*(\d+)u64(?:\.private)?/);
      const collMatch      = plaintext.match(/collateral_usdc:\s*(\d+)u(?:64|128)(?:\.private)?/);
      const entryMatch     = plaintext.match(/entry_price:\s*(\d+)u64(?:\.private)?/);

      if (!slotIdMatch || !sizeMatch) {
        setDecryptError('Not a valid PositionSlot record');
        return;
      }

      if (isOpenMatch?.[1] !== 'true') {
        setDecryptError('This slot has no open position (is_open: false)');
        return;
      }

      const posId = posIdMatch?.[1] || '0field';
      const isClosedOnChain = await checkPositionClosedOnChain(posId);
      if (isClosedOnChain) {
        setDecryptError('This position has already been closed or liquidated');
        return;
      }

      const manualSlot: PositionSlotRecord = {
        id: `manual-${slotIdMatch[1]}-${Date.now()}`,
        owner: '',
        slotId: parseInt(slotIdMatch[1]),
        isOpen: true,
        positionId: posId,
        isLong: isLongMatch?.[1] === 'true',
        sizeUsdc: BigInt(sizeMatch[1]),
        collateralUsdc: BigInt(collMatch?.[1] || '0'),
        entryPrice: BigInt(entryMatch?.[1] || '0'),
        plaintext,
        ciphertext: ciphertextInput.trim(),
        rawRecord: null,
      };

      setManualPositions(prev => {
        const exists = prev.some(p => p.positionId === manualSlot.positionId);
        return exists ? prev : [...prev, manualSlot];
      });

      setCiphertextInput('');
      setShowManualDecrypt(false);
    } catch (err) {
      setDecryptError(err instanceof Error ? err.message : 'Decryption failed');
    } finally {
      setDecryptLoading(false);
    }
  };

  if (!connected) {
    return (
      <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Your Positions</h2>
        <p className="text-gray-500 text-center py-8">Connect your wallet to view positions</p>
      </div>
    );
  }

  const isCloseBusy = closeTx.status === 'submitting' || closeTx.status === 'pending';

  // All positions to display: open slots from wallet + any manual additions
  const allOpenPositions = [
    ...openSlots,
    ...manualPositions.filter(m => !openSlots.some(s => s.positionId === m.positionId)),
  ];

  return (
    <div className="bg-zkperp-card rounded-xl border border-zkperp-border overflow-hidden">
      <div className="flex items-center justify-between p-4 border-b border-zkperp-border">
        <h2 className="text-lg font-semibold text-white">Your Positions</h2>
        <button
          onClick={fetchSlots}
          disabled={loading}
          className="text-sm text-zkperp-accent hover:text-zkperp-accent/80 disabled:opacity-50"
        >
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {/* Needs initialization */}
      {needsInitialization && !loading && (
        <div className="p-4 text-center text-sm text-gray-500">
          No slots found. Initialize your position slots first.
        </div>
      )}

      {/* Slots found but not decrypted yet */}
      {recordCount !== null && recordCount > 0 && !decrypted && !loading && (
        <div className="p-4">
          <div className="bg-zkperp-dark rounded-lg p-4 mb-3">
            <p className="text-white text-sm font-medium">{recordCount} slot record{recordCount > 1 ? 's' : ''} found</p>
            <p className="text-gray-500 text-xs mt-1">Decrypt to view your positions</p>
          </div>
          <button
            onClick={decryptSlots}
            disabled={decrypting}
            className="w-full py-3 bg-zkperp-accent/20 hover:bg-zkperp-accent/30 border border-zkperp-accent/50 disabled:opacity-50 rounded-lg text-sm font-medium text-zkperp-accent transition-colors"
          >
            {decrypting ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Decrypting slots...
              </span>
            ) : (
              `🔓 Decrypt & Show Positions`
            )}
          </button>
        </div>
      )}

      {/* Open positions */}
      {decrypted && allOpenPositions.length > 0 && (
        <div className="divide-y divide-zkperp-border">
          {allOpenPositions.map((slot) => {
            const pnl = calculatePnL(
              slot.entryPrice,
              currentPrice,
              slot.sizeUsdc,
              slot.isLong
            );
            const leverage = calculateLeverage(slot.collateralUsdc, slot.sizeUsdc);
            const isClosing = closingId === slot.id;

            return (
              <div key={slot.id} className="p-4 hover:bg-zkperp-dark/50 transition-colors">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      slot.isLong
                        ? 'bg-zkperp-green/20 text-zkperp-green'
                        : 'bg-zkperp-red/20 text-zkperp-red'
                    }`}>
                      {slot.isLong ? 'LONG' : 'SHORT'}
                    </span>
                    <span className="text-white font-medium">BTC/USD</span>
                    <span className="text-gray-500 text-sm">{leverage.toFixed(1)}x</span>
                    <span className="text-gray-600 text-xs">Slot {slot.slotId}</span>
                  </div>
                  <span className={`font-medium ${pnl.isProfit ? 'text-zkperp-green' : 'text-zkperp-red'}`}>
                    {pnl.isProfit ? '+' : ''}{pnl.pnlPercent.toFixed(2)}%
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-4 text-sm mb-4">
                  <div>
                    <span className="text-gray-500">Size</span>
                    <p className="text-white">${formatUsdc(slot.sizeUsdc)}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">Collateral</span>
                    <p className="text-white">${formatUsdc(slot.collateralUsdc)}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">Entry Price</span>
                    <p className="text-white">${formatPrice(slot.entryPrice)}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">PnL (USDC)</span>
                    <p className={pnl.isProfit ? 'text-zkperp-green' : 'text-zkperp-red'}>
                      {pnl.isProfit ? '+' : ''}${pnl.pnl.toFixed(2)}
                    </p>
                  </div>
                </div>

                <button
                  onClick={() => handleClose(slot)}
                  disabled={isClosing || isCloseBusy}
                  className="w-full py-2 bg-zkperp-dark border border-zkperp-border rounded-lg text-sm text-white hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isClosing ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Closing...
                    </span>
                  ) : (
                    'Close Position'
                  )}
                </button>

                {isClosing && (
                  <div className="mt-2">
                    <TransactionStatus
                      status={closeTx.status}
                      tempTxId={closeTx.tempTxId}
                      onChainTxId={closeTx.onChainTxId}
                      error={closeTx.error}
                      onDismiss={closeTx.reset}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* No open positions after decrypt */}
      {decrypted && allOpenPositions.length === 0 && (
        <div className="p-8 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-zkperp-dark flex items-center justify-center">
            <svg className="w-8 h-8 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <p className="text-gray-500">No open positions</p>
          <p className="text-sm text-gray-600 mt-1">Open a trade to get started</p>
          <ManualDecryptSection
            show={showManualDecrypt}
            onToggle={() => setShowManualDecrypt(v => !v)}
            ciphertextInput={ciphertextInput}
            onCiphertextChange={setCiphertextInput}
            onDecrypt={handleManualDecrypt}
            decryptLoading={decryptLoading}
            decryptError={decryptError}
          />
        </div>
      )}

      {/* Empty state before any fetch */}
      {recordCount === null && !loading && (
        <div className="p-8 text-center">
          <p className="text-gray-500">No open positions</p>
          <p className="text-sm text-gray-600 mt-1">Open a trade to get started</p>
          <ManualDecryptSection
            show={showManualDecrypt}
            onToggle={() => setShowManualDecrypt(v => !v)}
            ciphertextInput={ciphertextInput}
            onCiphertextChange={setCiphertextInput}
            onDecrypt={handleManualDecrypt}
            decryptLoading={decryptLoading}
            decryptError={decryptError}
          />
        </div>
      )}

      {/* Close transaction status */}
      {closeTx.status !== 'idle' && !closingId && (
        <div className="p-4 border-t border-zkperp-border">
          <TransactionStatus
            status={closeTx.status}
            tempTxId={closeTx.tempTxId}
            onChainTxId={closeTx.onChainTxId}
            error={closeTx.error}
            onDismiss={closeTx.reset}
          />
        </div>
      )}

      {error && (
        <div className="p-4 bg-zkperp-red/10 border-t border-zkperp-red/30">
          <p className="text-zkperp-red text-sm">{error}</p>
        </div>
      )}
    </div>
  );
}

// ── Manual decrypt sub-component ─────────────────────────────────────────────
function ManualDecryptSection({
  show, onToggle, ciphertextInput, onCiphertextChange, onDecrypt, decryptLoading, decryptError,
}: {
  show: boolean;
  onToggle: () => void;
  ciphertextInput: string;
  onCiphertextChange: (v: string) => void;
  onDecrypt: () => void;
  decryptLoading: boolean;
  decryptError: string | null;
}) {
  return (
    <div className="mt-4 pt-4 border-t border-zkperp-border">
      <button onClick={onToggle} className="text-xs text-zkperp-accent hover:underline">
        {show ? 'Hide' : '🔑 Have a position record? Decrypt manually'}
      </button>
      {show && (
        <div className="mt-3 text-left">
          <p className="text-xs text-gray-500 mb-2">
            Paste a PositionSlot record ciphertext:
          </p>
          <textarea
            value={ciphertextInput}
            onChange={(e) => onCiphertextChange(e.target.value)}
            placeholder="record1qyqsq..."
            rows={3}
            className="w-full bg-zkperp-dark border border-zkperp-border rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-zkperp-accent font-mono"
          />
          <button
            onClick={onDecrypt}
            disabled={decryptLoading || !ciphertextInput.trim()}
            className="mt-2 w-full py-2 bg-zkperp-accent hover:bg-zkperp-accent/80 disabled:bg-zkperp-accent/30 rounded-lg text-sm font-medium text-white transition-colors"
          >
            {decryptLoading ? 'Decrypting...' : 'Decrypt Position'}
          </button>
          {decryptError && <p className="text-xs text-red-400 mt-2">{decryptError}</p>}
        </div>
      )}
    </div>
  );
}
