import { useState, useCallback } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import { useZKPerp, Position } from '@/hooks/useZKPerp';
import { formatUsdc, formatPrice, calculatePnL, calculateLeverage } from '@/utils/aleo';

interface Props {
  currentPrice: bigint;
}

const PROGRAM_ID = 'zkperp_v6.aleo';
const ALEO_API = 'https://api.explorer.provable.com/v1/testnet';

export function PositionDisplay({ currentPrice }: Props) {
  const { connected, decrypt } = useWallet();
  const { fetchPositions, closePosition, loading, error } = useZKPerp();
  const [positions, setPositions] = useState<Position[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [showManualDecrypt, setShowManualDecrypt] = useState(false);
  const [ciphertextInput, setCiphertextInput] = useState('');
  const [decryptError, setDecryptError] = useState<string | null>(null);
  const [decryptLoading, setDecryptLoading] = useState(false);

  // Check if a position is closed on-chain
  const checkPositionClosedOnChain = async (positionId: string): Promise<boolean> => {
    try {
      // Clean the position ID - remove .private/.public suffix if present
      const cleanId = positionId.replace('.private', '').replace('.public', '');
      
      // Query the closed_positions mapping
      const response = await fetch(
        `${ALEO_API}/program/${PROGRAM_ID}/mapping/closed_positions/${cleanId}`
      );
      
      if (!response.ok) {
        // If 404, position is not in mapping (not closed)
        if (response.status === 404) {
          return false;
        }
        console.warn('Failed to check closed status:', response.status);
        return false;
      }
      
      const data = await response.text();
      console.log(`Position ${cleanId.slice(0, 20)}... closed status:`, data);
      
      // The mapping returns "true" if closed, or 404/null if not
      return data.includes('true');
    } catch (err) {
      console.error('Error checking position closed status:', err);
      return false;
    }
  };

  const loadPositions = useCallback(async () => {
    if (!connected) {
      setPositions([]);
      return;
    }

    setRefreshing(true);
    try {
      const records = await fetchPositions();
      
      // Get locally closed positions
      const closedIds = JSON.parse(localStorage.getItem('zkperp_closed_positions') || '[]');
      
      // Filter out locally closed positions first
      const locallyOpen = records.filter(p => {
        const id = String(p.position_id);
        return !closedIds.some((closedId: string) => id.includes(closedId));
      });
      
      // Now check on-chain for each remaining position
      const openPositions: Position[] = [];
      
      for (const position of locallyOpen) {
        const positionId = String(position.position_id);
        const isClosedOnChain = await checkPositionClosedOnChain(positionId);
        
        if (isClosedOnChain) {
          console.log('Position was liquidated/closed on-chain:', positionId.slice(0, 30) + '...');
          // Also add to local storage so we don't check again
          const cleanId = positionId.replace('.private', '').replace('.public', '');
          if (!closedIds.includes(cleanId)) {
            closedIds.push(cleanId);
            localStorage.setItem('zkperp_closed_positions', JSON.stringify(closedIds));
          }
        } else {
          openPositions.push(position);
        }
      }
      
      setPositions(openPositions);
    } catch (err) {
      console.error('Failed to load positions:', err);
    } finally {
      setRefreshing(false);
    }
  }, [connected, fetchPositions]);

  const handleClose = async (position: Position) => {
    setClosingId(position.position_id);
    try {
      const slippageAmount = (currentPrice * 1n) / 100n;
      const minPrice = currentPrice - slippageAmount;
      const maxPrice = currentPrice + slippageAmount;
      
      const result = await closePosition(position, minPrice, maxPrice);
      
      // Save closed position ID to localStorage
      const closedIds: string[] = JSON.parse(localStorage.getItem('zkperp_closed_positions') || '[]');
      const posId = String(position.position_id).replace('.private', '').replace('.public', '');
      if (!closedIds.includes(posId)) {
        closedIds.push(posId);
        localStorage.setItem('zkperp_closed_positions', JSON.stringify(closedIds));
      }
      
      // Remove from local state immediately
      setPositions(prev => prev.filter(p => p.position_id !== position.position_id));
      
      console.log('Position closed successfully:', result);
      
    } catch (err) {
      console.error('Close failed:', err);
    } finally {
      setClosingId(null);
    }
  };

  // Manual decrypt a position record
  const handleManualDecrypt = async () => {
    if (!decrypt || !ciphertextInput.trim()) return;
    
    setDecryptLoading(true);
    setDecryptError(null);
    
    try {
      const decrypted = await decrypt(ciphertextInput.trim());
      console.log('Decrypted record:', decrypted);
      
      if (!decrypted) {
        setDecryptError('Could not decrypt - not your record?');
        return;
      }
      
      // Parse the decrypted record
      const ownerMatch = decrypted.match(/owner:\s*(aleo1[a-z0-9]+)/);
      const positionIdMatch = decrypted.match(/position_id:\s*(\d+field)/);
      const isLongMatch = decrypted.match(/is_long:\s*(true|false)/);
      const sizeMatch = decrypted.match(/size_usdc:\s*(\d+)u64/);
      const collateralMatch = decrypted.match(/collateral_usdc:\s*(\d+)u64/);
      const entryPriceMatch = decrypted.match(/entry_price:\s*(\d+)u64/);
      const openBlockMatch = decrypted.match(/open_block:\s*(\d+)u32/);
      
      if (!positionIdMatch || !sizeMatch) {
        setDecryptError('Not a valid Position record');
        console.log('Decrypted content:', decrypted);
        return;
      }
      
      const position: Position = {
        owner: ownerMatch?.[1] || '',
        position_id: positionIdMatch[1],
        is_long: isLongMatch?.[1] === 'true',
        size_usdc: BigInt(sizeMatch[1]),
        collateral_usdc: BigInt(collateralMatch?.[1] || '0'),
        entry_price: BigInt(entryPriceMatch?.[1] || '0'),
        open_block: parseInt(openBlockMatch?.[1] || '0'),
      };
      
      // Check if this position is closed on-chain before adding
      const isClosedOnChain = await checkPositionClosedOnChain(position.position_id);
      if (isClosedOnChain) {
        setDecryptError('This position has already been closed or liquidated');
        return;
      }
      
      // Add to positions if not already there
      setPositions(prev => {
        const exists = prev.some(p => p.position_id === position.position_id);
        if (exists) return prev;
        return [...prev, position];
      });
      
      setCiphertextInput('');
      setShowManualDecrypt(false);
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

  return (
    <div className="bg-zkperp-card rounded-xl border border-zkperp-border overflow-hidden">
      <div className="flex items-center justify-between p-4 border-b border-zkperp-border">
        <h2 className="text-lg font-semibold text-white">Your Positions</h2>
        <button
          onClick={loadPositions}
          disabled={refreshing}
          className="text-sm text-zkperp-accent hover:text-zkperp-accent/80 disabled:opacity-50"
        >
          {refreshing ? 'Checking...' : 'Refresh'}
        </button>
      </div>

      {positions.length === 0 ? (
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
      ) : (
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
                  disabled={isClosing || loading}
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
              </div>
            );
          })}
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
