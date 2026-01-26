import { useWallet } from '@demox-labs/aleo-wallet-adapter-react';
import { WalletMultiButton } from '@demox-labs/aleo-wallet-adapter-reactui';
import { truncateAddress } from '@/utils/aleo';
import { useBalance, formatAleo, formatMockUsdc } from '@/hooks/useBalance';

export function Header() {
  const { connected, publicKey } = useWallet();
  const { publicBalance, usdcBalance, loading: balanceLoading, refresh } = useBalance();

  return (
    <header className="border-b border-zkperp-border bg-zkperp-card">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          {/* Logo */}
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-gradient-to-br from-zkperp-accent to-purple-500 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-sm">ZK</span>
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">ZKPerp</h1>
              <p className="text-xs text-gray-500">Privacy-First Perpetuals</p>
            </div>
          </div>

          {/* Network indicator + Balance + Wallet */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-zkperp-dark rounded-full border border-zkperp-border">
              <div className="w-2 h-2 bg-zkperp-green rounded-full animate-pulse" />
              <span className="text-xs text-gray-400">Testnet</span>
            </div>

            <WalletMultiButton />
          </div>
        </div>
      </div>

      {/* Connected address & balances bar */}
      {connected && publicKey && (
        <div className="border-t border-zkperp-border bg-zkperp-dark/50 py-2">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between flex-wrap gap-2">
              {/* Address */}
              <div className="flex items-center gap-2 text-sm">
                <span className="text-gray-500">Connected:</span>
                <code className="text-zkperp-accent font-mono text-xs bg-zkperp-dark px-2 py-1 rounded">
                  {truncateAddress(publicKey)}
                </code>
              </div>
              
              {/* Balances */}
              <div className="flex items-center gap-4">
                {/* USDC Balance */}
                <div className="flex items-center gap-2 px-3 py-1 bg-zkperp-dark rounded-lg border border-zkperp-border">
                  <div className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center">
                    <span className="text-white text-xs font-bold">$</span>
                  </div>
                  <div className="text-sm">
                    <span className="text-white font-medium">
                      {balanceLoading ? '...' : formatMockUsdc(usdcBalance)}
                    </span>
                    <span className="text-gray-500 ml-1">USDC</span>
                  </div>
                </div>

                {/* ALEO Balance */}
                <div className="flex items-center gap-2 px-3 py-1 bg-zkperp-dark rounded-lg border border-zkperp-border">
                  <div className="w-5 h-5 rounded-full bg-zkperp-accent flex items-center justify-center">
                    <span className="text-white text-xs font-bold">A</span>
                  </div>
                  <div className="text-sm">
                    <span className="text-white font-medium">
                      {balanceLoading ? '...' : formatAleo(publicBalance)}
                    </span>
                    <span className="text-gray-500 ml-1">ALEO</span>
                  </div>
                </div>

                {/* Refresh button */}
                <button
                  onClick={refresh}
                  disabled={balanceLoading}
                  className="text-gray-500 hover:text-white disabled:opacity-50 transition-colors"
                  title="Refresh balances"
                >
                  <svg className={`w-4 h-4 ${balanceLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
