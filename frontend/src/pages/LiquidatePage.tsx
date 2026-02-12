import { useState, useEffect } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import type { TransactionOptions } from '@provablehq/aleo-types';
import { formatUsdc, formatPrice } from '@/utils/aleo';

interface Props {
  currentPrice: bigint;
  poolLiquidity: bigint;
  longOI: bigint;
  shortOI: bigint;
}

// Contract constants
const LIQUIDATION_THRESHOLD_PERCENT = 1; // 1%
const LIQUIDATION_REWARD_BPS = 5000n; // 0.5%
const PROGRAM_ID = 'zkperp_v6.aleo';

const ALEO_API = 'https://api.explorer.provable.com/v1/testnet';

interface PositionData {
  positionId: string;
  isLong: boolean;
  sizeUsdc: bigint;
  collateralUsdc: bigint;
  entryPrice: bigint;
}

export function LiquidatePage({ currentPrice, poolLiquidity, longOI, shortOI }: Props) {
 const { connected, executeTransaction } = useWallet();
  
  // Input state
  const [txId, setTxId] = useState('');
  const [position, setPosition] = useState<PositionData | null>(null);
  
  // UI state
  const [fetching, setFetching] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [calculation, setCalculation] = useState<{
    pnl: bigint;
    marginRatio: number;
    isLiquidatable: boolean;
    reward: bigint;
  } | null>(null);

  // Fetch transaction and parse position data
  const fetchTransaction = async (transactionId: string) => {
    setFetching(true);
    setError(null);
    setPosition(null);
    setCalculation(null);

    try {
      // Clean up tx ID
      const cleanTxId = transactionId.trim();
      
      // Fetch from Aleo API
      const response = await fetch(`${ALEO_API}/transaction/${cleanTxId}`);
      
      if (!response.ok) {
        throw new Error(`Transaction not found (${response.status})`);
      }
      
      const data = await response.json();
      console.log('Transaction data:', data);
      
      // Find the open_position transition
      const transitions = data.execution?.transitions || [];
      const openPositionTransition = transitions.find(
        (t: any) => t.function === 'open_position' && t.program?.includes('zkperp')
      );
      
      if (!openPositionTransition) {
        // Try to find any transition from our program
        const zkperpTransition = transitions.find(
          (t: any) => t.program?.includes('zkperp')
        );
        if (zkperpTransition) {
          console.log('Found zkperp transition:', zkperpTransition);
        }
        throw new Error('This transaction does not contain an open_position call from zkperp');
      }
      
      // Parse outputs - the position data is in the outputs
      const positionData = parsePositionFromTransition(openPositionTransition);
      
      if (!positionData) {
        throw new Error('Could not parse position data from transaction. Try manual override.');
      }
      
      setPosition(positionData);
      console.log('Parsed position:', positionData);
      
    } catch (err: any) {
      console.error('Fetch error:', err);
      setError(err.message || 'Failed to fetch transaction');
    } finally {
      setFetching(false);
    }
  };

  // Parse position data from transaction transition
  const parsePositionFromTransition = (transition: any): PositionData | null => {
    try {
      console.log('Parsing transition:', transition);
      
      // Collect all string values from inputs, outputs, and finalize
      const allValues: string[] = [];
      
      // From inputs
      for (const input of (transition.inputs || [])) {
        if (input.value) allValues.push(String(input.value));
      }
      
      // From outputs  
      for (const output of (transition.outputs || [])) {
        if (output.value) allValues.push(String(output.value));
      }
      
      // From finalize (this often has the clearest data)
      for (const val of (transition.finalize || [])) {
        allValues.push(String(val));
      }
      
      console.log('All values to parse:', allValues);
      
      // Initialize position data
      let positionId = '';
      let isLong = true;
      let sizeUsdc = 0n;
      let collateralUsdc = 0n;
      let entryPrice = 0n;
      
      // Collect all u64 values for later sorting
      const u64Values: bigint[] = [];
      
      // First pass: extract all values including embedded ones
      for (const val of allValues) {
        // Position ID - large number ending in field
        // Can be standalone OR embedded in a string
        const fieldMatches = val.match(/(\d{30,})field/g);
        if (fieldMatches) {
          for (const match of fieldMatches) {
            const numPart = match.replace('field', '');
            // Position IDs are typically 70+ digits, nonces are shorter
            if (numPart.length >= 70 && !positionId) {
              positionId = match;
              console.log('Found position ID:', positionId);
            }
          }
        }
        
        // Boolean - check for exact match or embedded
        if (val === 'true' || val.includes('\ttrue') || val.match(/[:,\s]true[,\s\n]/)) {
          isLong = true;
        }
        if (val === 'false' || val.includes('\tfalse') || val.match(/[:,\s]false[,\s\n]/)) {
          isLong = false;
        }
        
        // u64 values - can be standalone OR embedded
        const u64Matches = val.match(/(\d+)u64/g);
        if (u64Matches) {
          for (const match of u64Matches) {
            const num = BigInt(match.replace('u64', ''));
            u64Values.push(num);
          }
        }
      }
      
      console.log('Found u64 values:', u64Values.map(v => v.toString()));
      
      // Deduplicate u64 values
      const uniqueU64Values = [...new Set(u64Values.map(v => v.toString()))].map(s => BigInt(s));
      console.log('Unique u64 values:', uniqueU64Values.map(v => v.toString()));
      
      // Sort u64 values to identify them by magnitude
      // Entry price: 10,000,000,000 (for $100k with 8 decimals)
      // Size: 50,000,000 (for $50 with 6 decimals)  
      // Collateral: 4,950,000 (for $4.95 with 6 decimals)
      
      // Group by magnitude - use STRICT ranges
      const entryPriceCandidates: bigint[] = []; // 5-15 billion only (for $50k-$150k BTC)
      const sizeCandidates: bigint[] = [];       // 10-200 million ($10-$200 positions)
      const collateralCandidates: bigint[] = []; // 1-10 million ($1-$10 collateral)
      
      for (const val of uniqueU64Values) {
        // Entry price: STRICT range for BTC ($50k-$150k with 8 decimals)
        if (val >= 5_000_000_000n && val <= 15_000_000_000n) {
          entryPriceCandidates.push(val);
        } 
        // Size range: $10-$200 with 6 decimals
        else if (val >= 10_000_000n && val <= 200_000_000n) {
          sizeCandidates.push(val);
        } 
        // Collateral range: $1-$10 with 6 decimals
        else if (val >= 1_000_000n && val < 10_000_000n) {
          collateralCandidates.push(val);
        }
        // Skip values outside these ranges (garbage data)
      }
      
      console.log('Candidates - entry:', entryPriceCandidates.map(v => v.toString()), 
                  'size:', sizeCandidates.map(v => v.toString()),
                  'collateral:', collateralCandidates.map(v => v.toString()));
      
      // Select the most likely values
      // Entry price: BTC is ~$80k-$100k, with 8 decimals that's 8,000,000,000 - 10,000,000,000
      // Filter for reasonable BTC prices ($50k - $150k = 5B - 15B)
      if (entryPriceCandidates.length > 0) {
        const reasonablePrices = entryPriceCandidates.filter(v => v >= 5_000_000_000n && v <= 15_000_000_000n);
        if (reasonablePrices.length > 0) {
          // Take the one closest to $100k (10B)
          entryPrice = reasonablePrices.reduce((a, b) => {
            const diffA = a > 10_000_000_000n ? a - 10_000_000_000n : 10_000_000_000n - a;
            const diffB = b > 10_000_000_000n ? b - 10_000_000_000n : 10_000_000_000n - b;
            return diffA < diffB ? a : b;
          });
        } else {
          entryPrice = entryPriceCandidates[0];
        }
      }
      
      // FALLBACK: If no valid entry price found, check if there's a value that SHOULD be entry price
      // by looking at all u64 values and finding one close to $100k
      if (entryPrice === 0n) {
        console.log('No entry price in candidates, searching all u64 values...');
        for (const val of uniqueU64Values) {
          // Check if dividing by 100M gives a reasonable BTC price ($50k-$150k)
          const priceUsd = Number(val) / 100_000_000;
          if (priceUsd >= 50_000 && priceUsd <= 150_000) {
            entryPrice = val;
            console.log('Found entry price via fallback:', val.toString(), '=', priceUsd);
            break;
          }
        }
      }
      
      // Size: take the largest in the size range
      if (sizeCandidates.length > 0) {
        sizeUsdc = sizeCandidates.reduce((a, b) => a > b ? a : b);
      }
      
      // Collateral: take the largest in the collateral range
      if (collateralCandidates.length > 0) {
        collateralUsdc = collateralCandidates.reduce((a, b) => a > b ? a : b);
      }
      
      // If collateral wasn't found in its range, it might be in size range (just smaller than size)
      if (collateralUsdc === 0n && sizeCandidates.length > 1) {
        const sorted = [...sizeCandidates].sort((a, b) => Number(b - a));
        sizeUsdc = sorted[0];
        collateralUsdc = sorted[1];
      }
      
      console.log('Parsed values:', { 
        positionId, 
        isLong, 
        sizeUsdc: sizeUsdc.toString(), 
        collateralUsdc: collateralUsdc.toString(), 
        entryPrice: entryPrice.toString() 
      });
      
      // Validate required fields
      if (!positionId) {
        console.log('Missing position ID');
        return null;
      }
      if (sizeUsdc === 0n) {
        console.log('Missing size');
        return null;
      }
      if (entryPrice === 0n) {
        console.log('Missing entry price');
        return null;
      }
      
      // If collateral still not found, estimate from size (assume ~10x leverage minus fee)
      if (collateralUsdc === 0n) {
        console.log('Collateral not found, estimating from size...');
        const estimatedCollateral = sizeUsdc / 10n;
        const fee = estimatedCollateral / 1000n; // 0.1% fee
        collateralUsdc = estimatedCollateral - fee;
      }
      
      return {
        positionId,
        isLong,
        sizeUsdc,
        collateralUsdc,
        entryPrice,
      };
      
    } catch (err) {
      console.error('Parse error:', err);
      return null;
    }
  };

  // Calculate liquidation status when position or price changes
  useEffect(() => {
    if (!position || currentPrice === 0n) {
      setCalculation(null);
      return;
    }

    const { isLong, sizeUsdc, collateralUsdc, entryPrice } = position;

    // Calculate PnL
    const priceDiff = currentPrice > entryPrice 
      ? currentPrice - entryPrice 
      : entryPrice - currentPrice;
    
    const pnlAbs = (sizeUsdc * priceDiff) / (entryPrice + 1n);
    
    const traderProfits = (isLong && currentPrice > entryPrice) || 
                         (!isLong && currentPrice < entryPrice);
    
    const pnl = traderProfits ? pnlAbs : -pnlAbs;

    // Calculate margin ratio (as percentage)
    const remainingMargin = collateralUsdc + pnl;
    const marginRatio = Number(remainingMargin * 100n * 10000n / sizeUsdc) / 10000;

    // Position is liquidatable if margin ratio < 1%
    const isLiquidatable = marginRatio < LIQUIDATION_THRESHOLD_PERCENT;

    // Calculate reward (0.5% of size)
    const reward = (sizeUsdc * LIQUIDATION_REWARD_BPS) / 1_000_000n;

    setCalculation({
      pnl,
      marginRatio,
      isLiquidatable,
      reward,
    });
  }, [position, currentPrice]);

  // Handle TX ID input
  const handleTxIdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTxId(e.target.value);
  };

  const handleFetch = () => {
    if (txId.trim()) {
      fetchTransaction(txId);
    }
  };

  // Handle Enter key
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && txId.trim()) {
      fetchTransaction(txId);
    }
  };

  // Execute liquidation
  const handleLiquidate = async () => {
    if (!connected || !executeTransaction || !calculation?.isLiquidatable || !position) {
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const { positionId, isLong, sizeUsdc, collateralUsdc, entryPrice } = position;
      
      // Calculate reward
      const reward = (sizeUsdc * LIQUIDATION_REWARD_BPS) / 1_000_000n;

      // Build inputs for liquidate function
      const inputs = [
        positionId,                        // position_id: field
        `${isLong}`,                       // is_long: bool
        `${sizeUsdc}u64`,                  // size: u64
        `${collateralUsdc}u64`,            // collateral: u64  
        `${entryPrice}u64`,                // entry_price: u64
        `${reward}u128`,                   // liquidator_reward: u128
      ];

      console.log('Liquidation inputs:', inputs);

      const options: TransactionOptions = {
        program: PROGRAM_ID,
        function: 'liquidate',
        inputs,
        fee: 2_000_000,
        privateFee: false,
      };

      const result = await executeTransaction(options);
      const resultTxId = result?.transactionId;
      console.log('Liquidation submitted:', resultTxId);
      
      setSuccess(`Liquidation submitted! TX: ${resultTxId}`);
      
      // Clear form
      setTxId('');
      setPosition(null);
      setCalculation(null);
      
    } catch (err: any) {
      console.error('Liquidation failed:', err);
      setError(err.message || 'Liquidation failed');
    } finally {
      setLoading(false);
    }
  };

  // Format helpers
  const formatUsdcDisplay = (value: bigint) => {
    return (Number(value) / 1_000_000).toFixed(2);
  };

  const formatPriceDisplay = (value: bigint) => {
    return (Number(value) / 100_000_000).toLocaleString();
  };

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Page Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-2">Liquidations</h1>
        <p className="text-gray-400">
          Liquidate underwater positions to earn 0.5% rewards. Anyone can liquidate.
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

      {/* Status Messages */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 mb-6">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}
      {success && (
        <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-4 mb-6">
          <p className="text-green-400 text-sm">{success}</p>
        </div>
      )}

      {/* Liquidation Form */}
      <div className="bg-zkperp-card rounded-xl border border-zkperp-border overflow-hidden">
        <div className="p-5 border-b border-zkperp-border">
          <h2 className="font-semibold text-white">Liquidate Position</h2>
          <p className="text-gray-500 text-sm mt-1">
            Paste the open_position transaction ID to load position details
          </p>
        </div>

        <div className="p-5 space-y-4">
          {/* TX ID Input */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">
              Transaction ID
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={txId}
                onChange={handleTxIdChange}
                onKeyDown={handleKeyDown}
                placeholder="at1mlv2xx0l9zkm6ta0tndhsnnvf3x3zq7us4amvrh2tv3mlc73dsyq3cashq"
                className="flex-1 bg-zkperp-dark border border-zkperp-border rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:outline-none focus:border-zkperp-accent font-mono text-sm"
              />
              <button
                onClick={handleFetch}
                disabled={!txId.trim() || fetching}
                className="px-6 py-3 bg-zkperp-accent hover:bg-zkperp-accent/80 disabled:bg-zkperp-accent/30 rounded-lg font-medium text-white transition-colors"
              >
                {fetching ? 'Loading...' : 'Fetch'}
              </button>
            </div>
          </div>

          {/* Position Details */}
          {position && (
            <div className="bg-zkperp-dark rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-gray-400 text-sm font-medium">Position Details</p>
                <span className={`px-2 py-1 rounded text-xs font-medium ${
                  position.isLong 
                    ? 'bg-zkperp-green/20 text-zkperp-green' 
                    : 'bg-zkperp-red/20 text-zkperp-red'
                }`}>
                  {position.isLong ? 'LONG' : 'SHORT'}
                </span>
              </div>
              
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-gray-500">Position ID</p>
                  <p className="text-white font-mono text-xs truncate" title={position.positionId}>
                    {position.positionId.slice(0, 20)}...{position.positionId.slice(-10)}
                  </p>
                </div>
                <div>
                  <p className="text-gray-500">Size</p>
                  <p className="text-white">${formatUsdcDisplay(position.sizeUsdc)} USDC</p>
                </div>
                <div>
                  <p className="text-gray-500">Collateral</p>
                  <p className="text-white">${formatUsdcDisplay(position.collateralUsdc)} USDC</p>
                </div>
                <div>
                  <p className="text-gray-500">Entry Price</p>
                  <p className="text-white">${formatPriceDisplay(position.entryPrice)}</p>
                </div>
              </div>
            </div>
          )}

          {/* Calculation Result */}
          {calculation && (
            <div className={`rounded-lg p-4 ${
              calculation.isLiquidatable 
                ? 'bg-red-500/10 border border-red-500/30' 
                : 'bg-green-500/10 border border-green-500/30'
            }`}>
              <div className="flex items-center gap-2 mb-3">
                <span className={`text-lg font-semibold ${
                  calculation.isLiquidatable ? 'text-red-400' : 'text-green-400'
                }`}>
                  {calculation.isLiquidatable ? '⚠️ LIQUIDATABLE' : '✓ HEALTHY'}
                </span>
              </div>
              
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-gray-400">Current Price</p>
                  <p className="text-white font-medium">${formatPrice(currentPrice)}</p>
                </div>
                <div>
                  <p className="text-gray-400">PnL</p>
                  <p className={`font-medium ${calculation.pnl >= 0n ? 'text-zkperp-green' : 'text-zkperp-red'}`}>
                    {calculation.pnl >= 0n ? '+' : '-'}${formatUsdc(calculation.pnl >= 0n ? calculation.pnl : -calculation.pnl)}
                  </p>
                </div>
                <div>
                  <p className="text-gray-400">Margin Ratio</p>
                  <p className={`font-medium ${calculation.marginRatio < 1 ? 'text-red-400' : 'text-white'}`}>
                    {calculation.marginRatio.toFixed(2)}%
                    <span className="text-gray-500 text-xs ml-1">(threshold: 1%)</span>
                  </p>
                </div>
                <div>
                  <p className="text-gray-400">Liquidator Reward</p>
                  <p className="text-zkperp-accent font-medium">${formatUsdc(calculation.reward)}</p>
                </div>
              </div>
            </div>
          )}

          {/* Liquidate Button */}
          <button
            onClick={handleLiquidate}
            disabled={!connected || !calculation?.isLiquidatable || loading || !position}
            className={`w-full py-4 rounded-lg font-semibold text-lg transition-colors ${
              calculation?.isLiquidatable
                ? 'bg-zkperp-red hover:bg-zkperp-red/80 text-white'
                : 'bg-gray-600 text-gray-400 cursor-not-allowed'
            }`}
          >
            {loading ? 'Liquidating...' : 
             !connected ? 'Connect Wallet' :
             !position ? 'Enter Transaction ID' :
             !calculation?.isLiquidatable ? 'Position Not Liquidatable' :
             `Liquidate & Earn $${formatUsdc(calculation.reward)}`}
          </button>
        </div>
      </div>

      {/* Manual Override Section */}
      <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6 mt-6">
        <h3 className="font-semibold text-white mb-2">Manual Override</h3>
        <p className="text-gray-500 text-sm mb-4">
          If auto-fetch doesn't parse correctly, manually enter the exact values from the transaction:
        </p>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Position ID</label>
            <input
              type="text"
              placeholder="123...field"
              className="w-full bg-zkperp-dark border border-zkperp-border rounded px-3 py-2 text-white text-sm font-mono"
              onChange={(e) => {
                setPosition(prev => ({
                  positionId: e.target.value,
                  isLong: prev?.isLong ?? true,
                  sizeUsdc: prev?.sizeUsdc ?? 0n,
                  collateralUsdc: prev?.collateralUsdc ?? 0n,
                  entryPrice: prev?.entryPrice ?? 0n,
                }));
              }}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Size (USDC)</label>
            <input
              type="number"
              placeholder="50"
              className="w-full bg-zkperp-dark border border-zkperp-border rounded px-3 py-2 text-white text-sm"
              onChange={(e) => {
                const val = BigInt(Math.floor(parseFloat(e.target.value || '0') * 1_000_000));
                setPosition(prev => prev ? { ...prev, sizeUsdc: val } : null);
              }}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Collateral</label>
            <input
              type="number"
              placeholder="4.95"
              className="w-full bg-zkperp-dark border border-zkperp-border rounded px-3 py-2 text-white text-sm"
              onChange={(e) => {
                const val = BigInt(Math.floor(parseFloat(e.target.value || '0') * 1_000_000));
                setPosition(prev => prev ? { ...prev, collateralUsdc: val } : null);
              }}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Entry Price</label>
            <input
              type="number"
              placeholder="100000"
              className="w-full bg-zkperp-dark border border-zkperp-border rounded px-3 py-2 text-white text-sm"
              onChange={(e) => {
                const val = BigInt(Math.floor(parseFloat(e.target.value || '0') * 100_000_000));
                setPosition(prev => prev ? { ...prev, entryPrice: val } : null);
              }}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Direction</label>
            <select
              className="w-full bg-zkperp-dark border border-zkperp-border rounded px-3 py-2 text-white text-sm"
              onChange={(e) => {
                setPosition(prev => prev ? { ...prev, isLong: e.target.value === 'true' } : null);
              }}
            >
              <option value="true">LONG</option>
              <option value="false">SHORT</option>
            </select>
          </div>
        </div>
      </div>

      {/* Info Cards */}
      <div className="grid md:grid-cols-2 gap-6 mt-6">
        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
          <h3 className="font-semibold text-white mb-4">How It Works</h3>
          <ul className="space-y-3 text-sm text-gray-400">
            <li className="flex gap-2">
              <span className="text-zkperp-accent">1.</span>
              Find an open_position transaction ID from the explorer
            </li>
            <li className="flex gap-2">
              <span className="text-zkperp-accent">2.</span>
              Paste the TX ID to automatically load position details
            </li>
            <li className="flex gap-2">
              <span className="text-zkperp-accent">3.</span>
              If margin ratio is below 1%, you can liquidate
            </li>
            <li className="flex gap-2">
              <span className="text-zkperp-accent">4.</span>
              Earn 0.5% of position size as reward
            </li>
          </ul>
        </div>

        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
          <h3 className="font-semibold text-white mb-4">Where to Find TX IDs</h3>
          <ul className="space-y-3 text-sm text-gray-400">
            <li className="flex gap-2">
              <span className="text-zkperp-accent">•</span>
              <a 
                href="https://explorer.provable.com" 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-zkperp-accent hover:underline"
              >
                Provable Explorer
              </a>
              {' '}- Search for zkperp transactions
            </li>
            <li className="flex gap-2">
              <span className="text-zkperp-accent">•</span>
              Your wallet's transaction history
            </li>
            <li className="flex gap-2">
              <span className="text-zkperp-accent">•</span>
              Monitor the program's recent executions
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
