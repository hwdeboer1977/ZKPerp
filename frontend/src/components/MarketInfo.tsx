import { formatUsdc, formatPrice } from '@/utils/aleo';

interface Props {
  currentPrice: bigint;
  poolLiquidity: bigint;
  longOI: bigint;
  shortOI: bigint;
  oracleSet?: boolean;
  onPriceChange?: (price: bigint) => void;
}

export function MarketInfo({
  currentPrice,
  poolLiquidity,
  longOI,
  shortOI,
  oracleSet = true,
  onPriceChange,
}: Props) {
  const totalOI = Number(longOI) + Number(shortOI);
  const utilization = Number(poolLiquidity) > 0 
    ? (totalOI / Number(poolLiquidity)) * 100 
    : 0;

  const totalOINum = Number(longOI) + Number(shortOI);
  const longPercent = totalOINum > 0 ? (Number(longOI) / totalOINum) * 100 : 50;
  const shortPercent = totalOINum > 0 ? (Number(shortOI) / totalOINum) * 100 : 50;

  return (
    <div className="bg-zkperp-card rounded-xl border border-zkperp-border overflow-hidden">
      {/* Price Display */}
      <div className="p-6 border-b border-zkperp-border">
        <div className="flex items-center justify-between mb-2">
          <span className="text-gray-400 text-sm">BTC/USD</span>
          <span className={`text-xs ${oracleSet ? 'text-zkperp-green' : 'text-yellow-500'}`}>
            {oracleSet ? '● Oracle Price' : '○ Simulated'}
          </span>
        </div>
        <div className="flex items-baseline gap-3">
          <span className="text-3xl font-bold text-white">
            ${formatPrice(currentPrice)}
          </span>
        </div>
        
        {!oracleSet && onPriceChange && (
          <div className="mt-4 pt-4 border-t border-zkperp-border">
            <label className="text-xs text-gray-500 block mb-2">
              Simulated Price (for testing)
            </label>
            <input
              type="number"
              value={Number(currentPrice) / 100_000_000}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val) && val > 0) {
                  onPriceChange(BigInt(Math.floor(val * 100_000_000)));
                }
              }}
              className="w-full bg-zkperp-dark border border-zkperp-border rounded px-3 py-2 text-sm text-white"
            />
          </div>
        )}
      </div>

      {/* Pool Stats */}
      <div className="p-6 space-y-4">
        <h3 className="text-sm font-medium text-gray-400">Pool Statistics</h3>
        
        <div className="space-y-3">
          {/* Total Liquidity - highlighted */}
          <div className="bg-zkperp-dark rounded-lg p-3">
            <div className="flex justify-between items-center">
              <span className="text-gray-400">Total Liquidity</span>
              <span className="text-xl font-bold text-white">${formatUsdc(poolLiquidity)}</span>
            </div>
          </div>
          
          <div className="flex justify-between">
            <span className="text-gray-500">Long Open Interest</span>
            <span className="text-zkperp-green">${formatUsdc(longOI)}</span>
          </div>
          
          <div className="flex justify-between">
            <span className="text-gray-500">Short Open Interest</span>
            <span className="text-zkperp-red">${formatUsdc(shortOI)}</span>
          </div>

          <div className="pt-2">
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>Long {longPercent.toFixed(1)}%</span>
              <span>Short {shortPercent.toFixed(1)}%</span>
            </div>
            <div className="h-2 bg-zkperp-dark rounded-full overflow-hidden flex">
              <div 
                className="bg-zkperp-green transition-all duration-500"
                style={{ width: `${longPercent}%` }}
              />
              <div 
                className="bg-zkperp-red transition-all duration-500"
                style={{ width: `${shortPercent}%` }}
              />
            </div>
          </div>

          <div className="pt-2 border-t border-zkperp-border">
            <div className="flex justify-between">
              <span className="text-gray-500">Pool Utilization</span>
              <span className={`font-medium ${
                utilization > 80 ? 'text-zkperp-red' : 
                utilization > 50 ? 'text-yellow-500' : 
                'text-zkperp-green'
              }`}>
                {utilization.toFixed(1)}%
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Contract Info */}
      <div className="px-6 pb-6">
        <div className="bg-zkperp-dark rounded-lg p-4 space-y-2">
          <h4 className="text-xs font-medium text-gray-500 uppercase">Contract</h4>
          <div className="flex items-center justify-between">
            <code className="text-xs text-zkperp-accent">zkperp_v1.aleo</code>
            <span className="text-xs text-zkperp-green">Testnet</span>
          </div>
        </div>
      </div>
    </div>
  );
}
