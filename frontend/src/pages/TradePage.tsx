import { useState, useCallback } from 'react';
import { useWallet } from '@demox-labs/aleo-wallet-adapter-react';
import { Transaction, WalletAdapterNetwork } from '@demox-labs/aleo-wallet-adapter-base';
import { TradingWidget } from '@/components/TradingWidget';
import { PositionDisplay } from '@/components/PositionDisplay';
import { formatPrice } from '@/utils/aleo';

const MOCK_USDC_PROGRAM = 'mock_usdc_0126.aleo';

interface Props {
  currentPrice: bigint;
  oracleSet: boolean;
  onPriceChange: (price: bigint) => void;
}

export function TradePage({ currentPrice, oracleSet, onPriceChange }: Props) {
  const { publicKey, requestTransaction, connected } = useWallet();
  const [manualPriceInput, setManualPriceInput] = useState('100000');
  const [mintLoading, setMintLoading] = useState(false);
  const [mintSuccess, setMintSuccess] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);

  const handlePriceChange = (value: string) => {
    setManualPriceInput(value);
    const num = parseFloat(value);
    if (!isNaN(num) && num > 0) {
      // Convert to 8 decimal format
      onPriceChange(BigInt(Math.floor(num * 100000000)));
    }
  };

  const handleMintUsdc = useCallback(async () => {
    if (!publicKey || !requestTransaction) return;

    setMintLoading(true);
    setMintError(null);
    setMintSuccess(false);

    try {
      // Mint 1000 USDC (with 6 decimals = 1000000000)
      const mintAmount = '1000000000u128';

      const inputs = [
        publicKey,    // recipient address
        mintAmount,   // amount to mint
      ];

      console.log('Minting USDC:', inputs);

      const aleoTransaction = Transaction.createTransaction(
        publicKey,
        WalletAdapterNetwork.TestnetBeta,
        MOCK_USDC_PROGRAM,
        'mint_public',
        inputs,
        1_000_000, // fee
        false
      );

      const txId = await requestTransaction(aleoTransaction);
      console.log('Mint USDC submitted:', txId);
      setMintSuccess(true);
      
      // Clear success message after 5 seconds
      setTimeout(() => setMintSuccess(false), 5000);
    } catch (err) {
      console.error('Mint USDC failed:', err);
      setMintError(err instanceof Error ? err.message : 'Failed to mint USDC');
    } finally {
      setMintLoading(false);
    }
  }, [publicKey, requestTransaction]);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Page Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-2">Trade</h1>
        <p className="text-gray-400">
          Open leveraged long or short positions on BTC with up to 20x leverage.
          Your positions stay completely private.
        </p>
      </div>

      {/* Testnet Faucet Banner */}
      <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-4 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h3 className="font-semibold text-blue-400 mb-1">🚰 Testnet Faucet</h3>
            <p className="text-sm text-gray-400">
              Need test USDC? Mint 1,000 mock USDC to your wallet for free.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleMintUsdc}
              disabled={!connected || mintLoading}
              className="px-6 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-blue-500/30 rounded-lg font-medium text-white transition-colors whitespace-nowrap"
            >
              {mintLoading ? 'Minting...' : 'Mint 1,000 USDC'}
            </button>
            {mintSuccess && (
              <span className="text-zkperp-green text-sm">✓ Minted!</span>
            )}
            {mintError && (
              <span className="text-red-400 text-sm">✗ Failed</span>
            )}
          </div>
        </div>
      </div>

      {/* Price Banner */}
      <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-gray-400 text-sm">BTC/USD</span>
              <span className={`text-xs px-2 py-0.5 rounded ${oracleSet ? 'bg-zkperp-green/20 text-zkperp-green' : 'bg-yellow-500/20 text-yellow-500'}`}>
                {oracleSet ? '● Oracle' : '○ Simulated'}
              </span>
            </div>
            <span className="text-4xl font-bold text-white">
              ${formatPrice(currentPrice)}
            </span>
          </div>

          {!oracleSet && (
            <div className="flex items-center gap-3">
              <label className="text-sm text-gray-400">Test Price:</label>
              <input
                type="number"
                value={manualPriceInput}
                onChange={(e) => handlePriceChange(e.target.value)}
                className="w-32 bg-zkperp-dark border border-zkperp-border rounded-lg px-3 py-2 text-white text-right"
              />
            </div>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Trading Widget */}
        <div>
          <TradingWidget currentPrice={currentPrice} />
        </div>

        {/* Positions */}
        <div>
          <PositionDisplay currentPrice={currentPrice} />
        </div>
      </div>

      {/* Info Cards */}
      <div className="grid md:grid-cols-3 gap-4 mt-8">
        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 rounded-lg bg-zkperp-accent/20 flex items-center justify-center">
              🔒
            </div>
            <h3 className="font-semibold text-white">Private Positions</h3>
          </div>
          <p className="text-sm text-gray-400">
            Position size, entry price, and PnL are encrypted using zero-knowledge proofs.
          </p>
        </div>

        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 rounded-lg bg-zkperp-green/20 flex items-center justify-center">
              📊
            </div>
            <h3 className="font-semibold text-white">Up to 20x Leverage</h3>
          </div>
          <p className="text-sm text-gray-400">
            Trade with capital efficiency. Open positions with as little as 5% margin.
          </p>
        </div>

        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center">
              🛡️
            </div>
            <h3 className="font-semibold text-white">No Front-Running</h3>
          </div>
          <p className="text-sm text-gray-400">
            Your trade intent is hidden until executed. No MEV, no sandwich attacks.
          </p>
        </div>
      </div>
    </div>
  );
}
