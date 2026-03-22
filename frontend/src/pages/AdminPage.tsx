import { useState, useCallback } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import type { TransactionOptions } from '@provablehq/aleo-types';
import { formatPrice, formatUsdc } from '@/utils/aleo';
import { ADDRESS_LIST } from '../utils/config';
import { useTransaction } from '@/hooks/useTransaction';
import { TransactionStatus } from '@/components/TransactionStatus';
import { useOnChainData } from '@/hooks/useOnChainData';
import { getPair, PAIR_IDS } from '@/config/pairs';
import type { PairId } from '@/config/pairs';

const ADMIN_ADDRESS = ADDRESS_LIST.ADMIN_ADDRESS;

// AdminPage manages its own on-chain data per selected pair
// so each pair shows its own oracle price and pool stats.
export function AdminPage() {
  const { address, connected } = useWallet();
  const tx = useTransaction();

  const [selectedPair, setSelectedPair] = useState<PairId>('btc');
  const [priceInput, setPriceInput] = useState('100000');

  const pairConfig = getPair(selectedPair);
  const PROGRAM_ID = pairConfig.programId;

  const { poolState, priceData, refresh } = useOnChainData(selectedPair);

  const currentPrice = priceData?.price ?? pairConfig.defaultPrice;
  const oracleSet = priceData !== null;
  const poolLiquidity = poolState?.total_liquidity ?? 0n;
  const longOI = poolState?.long_open_interest ?? 0n;
  const shortOI = poolState?.short_open_interest ?? 0n;

  const isAdmin = address === ADMIN_ADDRESS;

  const handleUpdatePrice = useCallback(async () => {
    if (!address) return;
    try {
      const priceValue = parseFloat(priceInput);
      if (isNaN(priceValue) || priceValue <= 0) throw new Error('Invalid price');

      const priceU64 = BigInt(Math.floor(priceValue * 100000000));

      const inputs = [
        '0field',                     // asset_id — always 0field per program
        priceU64.toString() + 'u64',  // price
        '1u32',                       // timestamp (placeholder)
      ];

      console.log(`Update price [${selectedPair}] inputs:`, inputs);

      const options: TransactionOptions = {
        program: PROGRAM_ID,
        function: 'update_price',
        inputs,
        fee: 1_000_000,
        privateFee: false,
      };

      await tx.execute(options);
      setTimeout(refresh, 10000);
    } catch (err) {
      console.error('Update price failed:', err);
    }
  }, [address, priceInput, tx, PROGRAM_ID, selectedPair, refresh]);

  const quickPrices = selectedPair === 'btc'
    ? [
        { label: '$90,000',  value: '90000' },
        { label: '$95,000',  value: '95000' },
        { label: '$100,000', value: '100000' },
        { label: '$105,000', value: '105000' },
        { label: '$110,000', value: '110000' },
      ]
    : selectedPair === 'eth'
    ? [
        { label: '$2,500', value: '2500' },
        { label: '$3,000', value: '3000' },
        { label: '$3,500', value: '3500' },
        { label: '$4,000', value: '4000' },
        { label: '$4,500', value: '4500' },
      ]
    : [
        { label: '$100', value: '100' },
        { label: '$130', value: '130' },
        { label: '$150', value: '150' },
        { label: '$180', value: '180' },
        { label: '$200', value: '200' },
      ];

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-2">Admin Panel</h1>
        <p className="text-gray-400">
          Manage oracle prices and protocol settings. Admin functions are restricted.
        </p>
      </div>

      {/* Pair selector */}
      <div className="flex items-center gap-1 mb-6 p-1 bg-zkperp-card border border-zkperp-border rounded-xl w-fit">
        {PAIR_IDS.map((pid) => {
          const p = getPair(pid);
          return (
            <button
              key={pid}
              onClick={() => setSelectedPair(pid)}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                pid === selectedPair
                  ? 'bg-zkperp-dark text-white'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {/* Admin Status */}
      <div className={`rounded-xl border p-6 mb-8 ${isAdmin ? 'bg-zkperp-green/10 border-zkperp-green/30' : 'bg-yellow-500/10 border-yellow-500/30'}`}>
        <div className="flex items-center gap-3 mb-2">
          <div className={`w-3 h-3 rounded-full ${isAdmin ? 'bg-zkperp-green' : 'bg-yellow-500'}`} />
          <h2 className="font-semibold text-white">
            {isAdmin ? '✓ Admin Access Granted' : '⚠ Limited Access'}
          </h2>
        </div>
        <p className="text-gray-400 text-sm">
          {isAdmin ? (
            'Your wallet is the designated admin/orchestrator. You can update oracle prices and manage the protocol.'
          ) : (
            <>
              Admin functions require the orchestrator wallet.
              <br />
              <code className="text-xs text-zkperp-accent">{ADMIN_ADDRESS}</code>
            </>
          )}
        </p>
      </div>

      {/* Current State */}
      <div className="grid md:grid-cols-4 gap-4 mb-8">
        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
          <p className="text-gray-400 text-sm mb-1">Oracle Price</p>
          <p className="text-2xl font-bold text-white">${formatPrice(currentPrice)}</p>
          <p className={`text-xs mt-1 ${oracleSet ? 'text-zkperp-green' : 'text-yellow-500'}`}>
            {oracleSet ? '● Set' : '○ Not Set'}
          </p>
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

      {/* Oracle Price Control */}
      <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6 mb-6">
        <h3 className="text-lg font-semibold text-white mb-4">🔮 Oracle Price Control</h3>
        <div className="space-y-4">
          <div>
            <label className="text-sm text-gray-400 mb-2 block">
              Set {pairConfig.label} Price
            </label>
            <div className="flex gap-3">
              <div className="relative flex-1">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                <input
                  type="number"
                  value={priceInput}
                  onChange={(e) => setPriceInput(e.target.value)}
                  placeholder="100000"
                  className="w-full bg-zkperp-dark border border-zkperp-border rounded-lg pl-8 pr-4 py-3 text-white placeholder-gray-600 focus:outline-none focus:border-zkperp-accent"
                />
              </div>
              <button
                onClick={handleUpdatePrice}
                disabled={!connected || tx.status === 'submitting' || tx.status === 'pending'}
                className="px-6 py-3 bg-zkperp-accent hover:bg-zkperp-accent/80 disabled:bg-zkperp-accent/30 rounded-lg font-medium text-white transition-colors whitespace-nowrap"
              >
                {tx.status === 'submitting' ? 'Submitting...' : tx.status === 'pending' ? 'Pending...' : 'Update Price'}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {quickPrices.map((p) => (
              <button
                key={p.value}
                onClick={() => setPriceInput(p.value)}
                className="px-4 py-2 text-sm bg-zkperp-dark border border-zkperp-border rounded-lg text-gray-400 hover:text-white hover:border-zkperp-accent transition-colors"
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="bg-zkperp-dark rounded-lg p-4">
            <p className="text-sm text-gray-400 mb-2">Price Impact Preview</p>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-500">Current:</span>
                <span className="text-white ml-2">${formatPrice(currentPrice)}</span>
              </div>
              <div>
                <span className="text-gray-500">New:</span>
                <span className="text-zkperp-accent ml-2">
                  ${parseFloat(priceInput || '0').toLocaleString()}
                </span>
              </div>
              <div>
                <span className="text-gray-500">Change:</span>
                <span className={`ml-2 ${
                  parseFloat(priceInput) > Number(currentPrice) / 100000000
                    ? 'text-zkperp-green'
                    : parseFloat(priceInput) < Number(currentPrice) / 100000000
                      ? 'text-zkperp-red'
                      : 'text-gray-400'
                }`}>
                  {currentPrice > 0
                    ? (((parseFloat(priceInput) * 100000000 - Number(currentPrice)) / Number(currentPrice)) * 100).toFixed(2) + '%'
                    : 'N/A'
                  }
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <TransactionStatus
        status={tx.status}
        tempTxId={tx.tempTxId}
        onChainTxId={tx.onChainTxId}
        error={tx.error}
        onDismiss={tx.reset}
      />

      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
          <h3 className="font-semibold text-white mb-4">Protocol Parameters</h3>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-400">Max Leverage</span>
              <span className="text-white">20x</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Opening Fee</span>
              <span className="text-white">0.1%</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Liquidation Threshold</span>
              <span className="text-white">1% margin</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Liquidation Reward</span>
              <span className="text-white">0.5%</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Max OI Ratio</span>
              <span className="text-white">80% of liquidity</span>
            </div>
          </div>
        </div>

        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
          <h3 className="font-semibold text-white mb-4">Contract Addresses</h3>
          <div className="space-y-3 text-sm">
            {PAIR_IDS.map(pid => (
              <div key={pid}>
                <p className="text-gray-400 mb-1">{getPair(pid).label}</p>
                <code className="text-xs text-zkperp-accent break-all">{getPair(pid).programId}</code>
              </div>
            ))}
            <div>
              <p className="text-gray-400 mb-1">Mock USDC</p>
              <code className="text-xs text-zkperp-accent break-all">test_usdcx_stablecoin.aleo</code>
            </div>
            <div>
              <p className="text-gray-400 mb-1">Admin/Orchestrator</p>
              <code className="text-xs text-zkperp-accent break-all">{ADMIN_ADDRESS}</code>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6 mt-6">
        <h3 className="font-semibold text-white mb-4">📋 CLI Commands Reference</h3>
        <div className="space-y-4 text-sm">
          <div>
            <p className="text-gray-400 mb-2">Update Oracle Price — {pairConfig.label}</p>
            <pre className="bg-zkperp-dark rounded-lg p-3 overflow-x-auto">
              <code className="text-gray-300">
{`leo execute update_price 0field ${priceInput ? BigInt(Math.floor(parseFloat(priceInput) * 100000000)).toString() : '10000000000000'}u64 1u32 --program ${PROGRAM_ID} --network testnet --broadcast`}
              </code>
            </pre>
          </div>
          <div>
            <p className="text-gray-400 mb-2">Mint Test USDC (CLI)</p>
            <pre className="bg-zkperp-dark rounded-lg p-3 overflow-x-auto">
              <code className="text-gray-300">
leo execute mint_public &lt;ADDRESS&gt; 1000000000u128 --network testnet --broadcast
              </code>
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
