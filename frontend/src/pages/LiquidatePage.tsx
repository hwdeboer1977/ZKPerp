import { useState } from 'react';
import { useWallet } from '@demox-labs/aleo-wallet-adapter-react';
import { formatUsdc, formatPrice } from '@/utils/aleo';

interface Props {
  currentPrice: bigint;
  poolLiquidity: bigint;
  longOI: bigint;
  shortOI: bigint;
}

export function LiquidatePage({ currentPrice, poolLiquidity, longOI, shortOI }: Props) {
  const { connected, publicKey } = useWallet();
  const [liquidationAuths, setLiquidationAuths] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // The designated liquidator address from the contract
  const LIQUIDATOR_ADDRESS = 'aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0';
  const isLiquidator = publicKey === LIQUIDATOR_ADDRESS;

  const handleScanPositions = async () => {
    if (!connected) return;
    
    setLoading(true);
    try {
      // In a real implementation, this would use requestRecords to fetch LiquidationAuth records
      // For now, show placeholder
      console.log('Scanning for LiquidationAuth records...');
      // const records = await wallet.requestRecords('zkperp_v1.aleo');
      // const auths = records.filter(r => r.type === 'LiquidationAuth');
      setLiquidationAuths([]);
    } catch (err) {
      console.error('Failed to scan positions:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Page Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-2">Liquidations</h1>
        <p className="text-gray-400">
          Monitor and liquidate underwater positions to earn rewards.
        </p>
      </div>

      {/* Market Overview */}
      <div className="grid md:grid-cols-4 gap-4 mb-8">
        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
          <p className="text-gray-400 text-sm mb-1">BTC Price</p>
          <p className="text-2xl font-bold text-white">${formatPrice(currentPrice)}</p>
        </div>
        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
          <p className="text-gray-400 text-sm mb-1">Pool Liquidity</p>
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
      </div>

      {/* Liquidator Status */}
      <div className={`rounded-xl border p-6 mb-8 ${isLiquidator ? 'bg-zkperp-green/10 border-zkperp-green/30' : 'bg-zkperp-card border-zkperp-border'}`}>
        <div className="flex items-center gap-3 mb-2">
          <div className={`w-3 h-3 rounded-full ${isLiquidator ? 'bg-zkperp-green' : 'bg-gray-500'}`} />
          <h2 className="font-semibold text-white">
            {isLiquidator ? 'You are the Liquidator' : 'Liquidator Status'}
          </h2>
        </div>
        {isLiquidator ? (
          <p className="text-gray-400 text-sm">
            Your wallet is the designated liquidator. You receive LiquidationAuth records for all positions
            and can liquidate underwater positions to earn 0.5% rewards.
          </p>
        ) : (
          <p className="text-gray-400 text-sm">
            Only the designated liquidator address can perform liquidations. 
            <br />
            <code className="text-xs text-zkperp-accent">{LIQUIDATOR_ADDRESS}</code>
          </p>
        )}
      </div>

      {/* Liquidatable Positions */}
      <div className="bg-zkperp-card rounded-xl border border-zkperp-border overflow-hidden">
        <div className="p-5 border-b border-zkperp-border flex justify-between items-center">
          <h2 className="font-semibold text-white">Liquidatable Positions</h2>
          <button
            onClick={handleScanPositions}
            disabled={!connected || !isLiquidator || loading}
            className="px-4 py-2 bg-zkperp-accent hover:bg-zkperp-accent/80 disabled:bg-zkperp-accent/30 rounded-lg text-sm font-medium text-white transition-colors"
          >
            {loading ? 'Scanning...' : 'Scan Positions'}
          </button>
        </div>

        <div className="p-5">
          {!connected ? (
            <div className="text-center py-8 text-gray-400">
              Connect your wallet to view positions
            </div>
          ) : !isLiquidator ? (
            <div className="text-center py-8 text-gray-400">
              Only the designated liquidator can view and liquidate positions
            </div>
          ) : liquidationAuths.length === 0 ? (
            <div className="text-center py-8">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-zkperp-dark flex items-center justify-center">
                <span className="text-3xl">✓</span>
              </div>
              <p className="text-gray-400">No liquidatable positions found</p>
              <p className="text-gray-500 text-sm mt-1">All positions are healthy</p>
            </div>
          ) : (
            <div className="space-y-3">
              {liquidationAuths.map((auth, i) => (
                <div key={i} className="bg-zkperp-dark rounded-lg p-4 flex justify-between items-center">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className={auth.is_long ? 'text-zkperp-green' : 'text-zkperp-red'}>
                        {auth.is_long ? 'LONG' : 'SHORT'}
                      </span>
                      <span className="text-white">${formatUsdc(BigInt(auth.size_usdc))}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      Entry: ${formatPrice(BigInt(auth.entry_price))} | 
                      Margin: ${formatUsdc(BigInt(auth.collateral_usdc))}
                    </p>
                  </div>
                  <button className="px-4 py-2 bg-zkperp-red hover:bg-zkperp-red/80 rounded-lg text-sm font-medium text-white">
                    Liquidate
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* How Liquidations Work */}
      <div className="grid md:grid-cols-2 gap-6 mt-8">
        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
          <h3 className="font-semibold text-white mb-4">How Liquidations Work</h3>
          <ul className="space-y-3 text-sm text-gray-400">
            <li className="flex gap-2">
              <span className="text-zkperp-accent">1.</span>
              When a position is opened, a LiquidationAuth record is sent to the liquidator
            </li>
            <li className="flex gap-2">
              <span className="text-zkperp-accent">2.</span>
              The liquidator monitors positions against current oracle price
            </li>
            <li className="flex gap-2">
              <span className="text-zkperp-accent">3.</span>
              When margin ratio falls below 1%, position can be liquidated
            </li>
            <li className="flex gap-2">
              <span className="text-zkperp-accent">4.</span>
              Liquidator earns 0.5% of position size as reward
            </li>
          </ul>
        </div>

        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
          <h3 className="font-semibold text-white mb-4">Liquidation Formula</h3>
          <div className="bg-zkperp-dark rounded-lg p-4 font-mono text-sm">
            <p className="text-gray-400 mb-2">// Calculate PnL</p>
            <p className="text-white">pnl = size × (currentPrice - entryPrice) / entryPrice</p>
            <p className="text-gray-400 mt-3 mb-2">// Calculate margin ratio</p>
            <p className="text-white">marginRatio = (collateral + pnl) / size</p>
            <p className="text-gray-400 mt-3 mb-2">// Liquidatable when:</p>
            <p className="text-zkperp-red">marginRatio &lt; 1%</p>
          </div>
        </div>
      </div>

      {/* Automated Liquidator */}
      <div className="bg-zkperp-accent/10 border border-zkperp-accent/30 rounded-xl p-6 mt-8">
        <h3 className="font-semibold text-zkperp-accent mb-2">🤖 Automated Liquidator Bot</h3>
        <p className="text-gray-400 text-sm mb-3">
          For production use, run the liquidator bot to automatically monitor and liquidate positions:
        </p>
        <pre className="bg-zkperp-dark rounded-lg p-3 text-sm overflow-x-auto">
          <code className="text-gray-300">
{`# Clone the repo and run the liquidator
cd ZKPerp/liquidator
npm install
PRIVATE_KEY=your_liquidator_key npm start`}
          </code>
        </pre>
      </div>
    </div>
  );
}
