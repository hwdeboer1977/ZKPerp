import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@demox-labs/aleo-wallet-adapter-react';
import { useZKPerp, Position } from '@/hooks/useZKPerp';
import { formatUsdc, formatPrice, calculatePnL, calculateLeverage } from '@/utils/aleo';

interface Props {
  currentPrice: bigint;
}

export function PositionDisplay({ currentPrice }: Props) {
  const { connected } = useWallet();
  const { fetchPositions, closePosition, loading, error } = useZKPerp();
  const [positions, setPositions] = useState<Position[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);

  const loadPositions = useCallback(async () => {
    if (!connected) {
      setPositions([]);
      return;
    }

    setRefreshing(true);
    try {
      const records = await fetchPositions();
      setPositions(records);
    } catch (err) {
      console.error('Failed to load positions:', err);
    } finally {
      setRefreshing(false);
    }
  }, [connected, fetchPositions]);

  useEffect(() => {
    loadPositions();
  }, [loadPositions]);

  const handleClose = async (position: Position) => {
    setClosingId(position.position_id);
    try {
      const slippageAmount = BigInt(Math.floor(Number(currentPrice) * 0.01));
      const minPrice = currentPrice - slippageAmount;
      const maxPrice = currentPrice + slippageAmount;
      
      await closePosition(position, minPrice, maxPrice);
      setTimeout(loadPositions, 2000);
    } catch (err) {
      console.error('Close failed:', err);
    } finally {
      setClosingId(null);
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
          {refreshing ? 'Loading...' : 'Refresh'}
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
