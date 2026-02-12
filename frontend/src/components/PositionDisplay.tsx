import { useState, useCallback } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import type { TransactionOptions } from '@provablehq/aleo-types';
import { useTransaction } from '@/hooks/useTransaction';
import { TransactionStatus } from '@/components/TransactionStatus';
import {
  formatUsdc,
  formatPrice,
  calculatePnL,
  calculateLeverage,
  PROGRAM_ID,
} from '@/utils/aleo';

interface Position {
  owner: string;
  position_id: string;
  is_long: boolean;
  size_usdc: bigint;
  collateral_usdc: bigint;
  entry_price: bigint;
  open_block: number;
  plaintext: string;
}

interface Props {
  currentPrice: bigint;
}

const ALEO_API = 'https://api.explorer.provable.com/v1/testnet';

export function PositionDisplay({ currentPrice }: Props) {
  const { address, connected, requestRecords, decrypt } = useWallet();
  const closeTx = useTransaction();

  const [positions, setPositions] = useState<Position[]>([]);
  const [recordCount, setRecordCount] = useState(0);
  const [rawRecords, setRawRecords] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [decrypting, setDecrypting] = useState(false);
  const [decrypted, setDecrypted] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Manual decrypt state
  const [showManualDecrypt, setShowManualDecrypt] = useState(false);
  const [ciphertextInput, setCiphertextInput] = useState('');
  const [decryptError, setDecryptError] = useState<string | null>(null);
  const [decryptLoading, setDecryptLoading] = useState(false);

  // Check if a position is closed on-chain
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

  // Phase 1: Fetch records (1 popup, no decrypt)
  const fetchRecords = useCallback(async () => {
    if (!connected || !requestRecords) return;

    setLoading(true);
    setError(null);

    try {
      const records = await requestRecords(PROGRAM_ID);
      console.log('Fetched position records:', records);

      const positionRecords = records.filter(
        (r: any) => r.recordName === 'Position' && !r.spent
      );

      setRawRecords(positionRecords);
      setRecordCount(positionRecords.length);
      setDecrypted(false);
      setPositions([]);
    } catch (err) {
      console.error('Failed to fetch position records:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch records');
    } finally {
      setLoading(false);
    }
  }, [connected, requestRecords]);

  // Phase 2: Decrypt all position records (batch)
  const decryptAll = useCallback(async () => {
    if (!decrypt || rawRecords.length === 0) return;

    setDecrypting(true);
    setError(null);

    try {
      const results = await Promise.all(
        rawRecords.map(async (record) => {
          try {
            if (!record.recordCiphertext) return null;
            const plaintext = await decrypt(record.recordCiphertext);
            console.log('Decrypted position:', plaintext);
            return { record, plaintext };
          } catch (err) {
            console.warn('Could not decrypt position record:', err);
            return null;
          }
        })
      );

      const openPositions: Position[] = [];
      const closedIds: string[] = JSON.parse(localStorage.getItem('zkperp_closed_positions') || '[]');

      for (const result of results) {
        if (!result) continue;
        const { plaintext } = result;

        const positionIdMatch = plaintext.match(/position_id:\s*(\d+field)/);
        const isLongMatch = plaintext.match(/is_long:\s*(true|false)/);
        const sizeMatch = plaintext.match(/size_usdc:\s*(\d+)u64/);
        const collateralMatch = plaintext.match(/collateral_usdc:\s*(\d+)u(?:64|128)/);
        const entryPriceMatch = plaintext.match(/entry_price:\s*(\d+)u64/);
        const openBlockMatch = plaintext.match(/open_block:\s*(\d+)u32/);

        if (!positionIdMatch || !sizeMatch) continue;
        const sizeUsdc = BigInt(sizeMatch[1]);
        const MIN_POSITION_SIZE = BigInt(10000); // $0.01

        if (sizeUsdc < MIN_POSITION_SIZE) continue; // Skip dust positions

        const posId = positionIdMatch[1];

        // Skip locally known closed positions
        const cleanId = posId.replace('.private', '').replace('.public', '');
        if (closedIds.some((id: string) => cleanId.includes(id))) continue;

        // Check on-chain if closed
        const isClosedOnChain = await checkPositionClosedOnChain(posId);
        if (isClosedOnChain) {
          if (!closedIds.includes(cleanId)) {
            closedIds.push(cleanId);
            localStorage.setItem('zkperp_closed_positions', JSON.stringify(closedIds));
          }
          continue;
        }

        openPositions.push({
          owner: address || '',
          position_id: posId,
          is_long: isLongMatch?.[1] === 'true',
          size_usdc: BigInt(sizeMatch[1]),
          collateral_usdc: BigInt(collateralMatch?.[1] || '0'),
          entry_price: BigInt(entryPriceMatch?.[1] || '0'),
          open_block: parseInt(openBlockMatch?.[1] || '0'),
          plaintext: plaintext,
        });
      }

      console.log('Open positions found:', openPositions.length);
      setPositions(openPositions);
      setDecrypted(true);
    } catch (err) {
      console.error('Failed to decrypt positions:', err);
      setError(err instanceof Error ? err.message : 'Failed to decrypt positions');
    } finally {
      setDecrypting(false);
    }
  }, [decrypt, rawRecords, address]);

  // Close position using useTransaction
 const handleClose = useCallback(async (position: Position) => {
    if (!connected) return;

    setClosingId(position.position_id);
    try {
      const slippageAmount = (currentPrice * 1n) / 100n;
      const minPrice = currentPrice - slippageAmount;
      const maxPrice = currentPrice + slippageAmount;

      // PnL calculation using BigInts directly
      const priceDiff = currentPrice > position.entry_price
        ? currentPrice - position.entry_price
        : position.entry_price - currentPrice;
      const safeEntryPrice = position.entry_price + 1n;
      const pnlAbs = (position.size_usdc * priceDiff) / safeEntryPrice;
      const isProfit = position.is_long
        ? currentPrice > position.entry_price
        : currentPrice < position.entry_price;

      let expectedPayout: bigint;
      if (isProfit) {
        expectedPayout = position.collateral_usdc + pnlAbs;
      } else {
        expectedPayout = pnlAbs >= position.collateral_usdc
          ? BigInt(0)
          : position.collateral_usdc - pnlAbs;
      }

      // 10% safety buffer for borrow fees + rounding
      expectedPayout = (expectedPayout * BigInt(90)) / BigInt(100);
      // Never zero — minimum 1 to avoid transfer_public(0) failing
      if (expectedPayout < BigInt(1)) expectedPayout = BigInt(1);

      console.log('=== CLOSE POSITION DEBUG ===');
      console.log('Plaintext:', position.plaintext);
      console.log('Min price:', minPrice.toString());
      console.log('Max price:', maxPrice.toString());
      console.log('PnL abs:', pnlAbs.toString());
      console.log('Is profit:', isProfit);
      console.log('Expected payout:', expectedPayout.toString());

      const inputs = [
        position.plaintext,
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

      // Save closed position to localStorage
      const closedIds: string[] = JSON.parse(localStorage.getItem('zkperp_closed_positions') || '[]');
      const posId = position.position_id.replace('.private', '').replace('.public', '');
      if (!closedIds.includes(posId)) {
        closedIds.push(posId);
        localStorage.setItem('zkperp_closed_positions', JSON.stringify(closedIds));
      }

      // Remove from local state
      setPositions(prev => prev.filter(p => p.position_id !== position.position_id));
    } catch (err) {
      console.error('Close failed:', err);
    } finally {
      setClosingId(null);
    }
  }, [connected, currentPrice, closeTx]);

  // Manual decrypt handler
  const handleManualDecrypt = async () => {
    if (!decrypt || !ciphertextInput.trim()) return;

    setDecryptLoading(true);
    setDecryptError(null);

    try {
      const plaintext = await decrypt(ciphertextInput.trim());
      console.log('Decrypted record:', plaintext);

      if (!plaintext) {
        setDecryptError('Could not decrypt - not your record?');
        return;
      }

      const positionIdMatch = plaintext.match(/position_id:\s*(\d+field)/);
      const isLongMatch = plaintext.match(/is_long:\s*(true|false)/);
      const sizeMatch = plaintext.match(/size_usdc:\s*(\d+)u64/);
      const collateralMatch = plaintext.match(/collateral_usdc:\s*(\d+)u(?:64|128)/);
      const entryPriceMatch = plaintext.match(/entry_price:\s*(\d+)u64/);
      const openBlockMatch = plaintext.match(/open_block:\s*(\d+)u32/);

      if (!positionIdMatch || !sizeMatch) {
        setDecryptError('Not a valid Position record');
        return;
      }

      const posId = positionIdMatch[1];
      const isClosedOnChain = await checkPositionClosedOnChain(posId);
      if (isClosedOnChain) {
        setDecryptError('This position has already been closed or liquidated');
        return;
      }

      const position: Position = {
        owner: address || '',
        position_id: posId,
        is_long: isLongMatch?.[1] === 'true',
        size_usdc: BigInt(sizeMatch[1]),
        collateral_usdc: BigInt(collateralMatch?.[1] || '0'),
        entry_price: BigInt(entryPriceMatch?.[1] || '0'),
        open_block: parseInt(openBlockMatch?.[1] || '0'),
        plaintext,
      };

      setPositions(prev => {
        const exists = prev.some(p => p.position_id === position.position_id);
        if (exists) return prev;
        return [...prev, position];
      });

      setCiphertextInput('');
      setShowManualDecrypt(false);
      setDecrypted(true);
    } catch (err) {
      console.error('Decrypt failed:', err);
      setDecryptError(err instanceof Error ? err.message : 'Decryption failed');
    } finally {
      setDecryptLoading(false);
    }
  };

  if (!connected) {
    return (
      <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Your Positions</h2>
        <p className="text-gray-500 text-center py-8">
          Connect your wallet to view positions
        </p>
      </div>
    );
  }

  const isCloseBusy = closeTx.status === 'submitting' || closeTx.status === 'pending';

  return (
    <div className="bg-zkperp-card rounded-xl border border-zkperp-border overflow-hidden">
      <div className="flex items-center justify-between p-4 border-b border-zkperp-border">
        <h2 className="text-lg font-semibold text-white">Your Positions</h2>
        <button
          onClick={fetchRecords}
          disabled={loading}
          className="text-sm text-zkperp-accent hover:text-zkperp-accent/80 disabled:opacity-50"
        >
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {/* Records found but not decrypted */}
      {recordCount > 0 && !decrypted && !loading && (
        <div className="p-4">
          <div className="bg-zkperp-dark rounded-lg p-4 mb-3">
            <p className="text-white text-sm font-medium">{recordCount} position record{recordCount > 1 ? 's' : ''} found</p>
            <p className="text-gray-500 text-xs mt-1">Decrypt to view details and manage positions</p>
          </div>
          <button
            onClick={decryptAll}
            disabled={decrypting}
            className="w-full py-3 bg-zkperp-accent/20 hover:bg-zkperp-accent/30 border border-zkperp-accent/50 disabled:opacity-50 rounded-lg text-sm font-medium text-zkperp-accent transition-colors"
          >
            {decrypting ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Decrypting {recordCount} position{recordCount > 1 ? 's' : ''}...
              </span>
            ) : (
              `🔓 Decrypt & Show ${recordCount} Position${recordCount > 1 ? 's' : ''}`
            )}
          </button>
        </div>
      )}

      {/* Decrypted positions */}
      {decrypted && positions.length > 0 && (
        <div className="divide-y divide-zkperp-border">
          {positions.map((position) => {
            const pnl = calculatePnL(
              position.entry_price,
              currentPrice,
              position.size_usdc,
              position.is_long
            );
            const leverage = calculateLeverage(position.collateral_usdc, position.size_usdc);
            const isClosing = closingId === position.position_id;

            return (
              <div key={position.position_id} className="p-4 hover:bg-zkperp-dark/50 transition-colors">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      position.is_long 
                        ? 'bg-zkperp-green/20 text-zkperp-green' 
                        : 'bg-zkperp-red/20 text-zkperp-red'
                    }`}>
                      {position.is_long ? 'LONG' : 'SHORT'}
                    </span>
                    <span className="text-white font-medium">BTC/USD</span>
                    <span className="text-gray-500 text-sm">{leverage.toFixed(1)}x</span>
                  </div>
                  <span className={`font-medium ${pnl.isProfit ? 'text-zkperp-green' : 'text-zkperp-red'}`}>
                    {pnl.isProfit ? '+' : ''}{pnl.pnlPercent.toFixed(2)}%
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-4 text-sm mb-4">
                  <div>
                    <span className="text-gray-500">Size</span>
                    <p className="text-white">${formatUsdc(position.size_usdc)}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">Collateral</span>
                    <p className="text-white">${formatUsdc(position.collateral_usdc)}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">Entry Price</span>
                    <p className="text-white">${formatPrice(position.entry_price)}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">PnL (USDC)</span>
                    <p className={pnl.isProfit ? 'text-zkperp-green' : 'text-zkperp-red'}>
                      {pnl.isProfit ? '+' : ''}${pnl.pnl.toFixed(2)}
                    </p>
                  </div>
                </div>

                <button
                  onClick={() => handleClose(position)}
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

      {/* No positions after decrypt */}
      {((decrypted && positions.length === 0) || (recordCount === 0 && !loading)) && (
        <div className="p-8 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-zkperp-dark flex items-center justify-center">
            <svg className="w-8 h-8 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <p className="text-gray-500">No open positions</p>
          <p className="text-sm text-gray-600 mt-1">Open a trade to get started</p>

          {/* Manual decrypt option */}
          <div className="mt-4 pt-4 border-t border-zkperp-border">
            <button
              onClick={() => setShowManualDecrypt(!showManualDecrypt)}
              className="text-xs text-zkperp-accent hover:underline"
            >
              {showManualDecrypt ? 'Hide' : '🔑 Have a position record? Decrypt manually'}
            </button>

            {showManualDecrypt && (
              <div className="mt-3 text-left">
                <p className="text-xs text-gray-500 mb-2">
                  Paste the record ciphertext from the transaction explorer:
                </p>
                <textarea
                  value={ciphertextInput}
                  onChange={(e) => setCiphertextInput(e.target.value)}
                  placeholder="record1qyqsq..."
                  rows={3}
                  className="w-full bg-zkperp-dark border border-zkperp-border rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-zkperp-accent font-mono"
                />
                <button
                  onClick={handleManualDecrypt}
                  disabled={decryptLoading || !ciphertextInput.trim()}
                  className="mt-2 w-full py-2 bg-zkperp-accent hover:bg-zkperp-accent/80 disabled:bg-zkperp-accent/30 rounded-lg text-sm font-medium text-white transition-colors"
                >
                  {decryptLoading ? 'Decrypting...' : 'Decrypt Position'}
                </button>
                {decryptError && (
                  <p className="text-xs text-red-400 mt-2">{decryptError}</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Close transaction status (shown globally when no specific position is closing) */}
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
