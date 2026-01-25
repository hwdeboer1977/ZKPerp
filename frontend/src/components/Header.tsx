import { useWallet } from '@demox-labs/aleo-wallet-adapter-react';
import { WalletMultiButton } from '@demox-labs/aleo-wallet-adapter-reactui';
import { truncateAddress } from '@/utils/aleo';

export function Header() {
  const { connected, publicKey } = useWallet();

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

          {/* Network indicator + Wallet */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-zkperp-dark rounded-full border border-zkperp-border">
              <div className="w-2 h-2 bg-yellow-400 rounded-full animate-pulse" />
              <span className="text-xs text-gray-400">Localnet</span>
            </div>

            <WalletMultiButton />
          </div>
        </div>
      </div>

      {/* Connected address bar */}
      {connected && publicKey && (
        <div className="border-t border-zkperp-border bg-zkperp-dark/50 py-2">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-gray-500">Connected:</span>
              <code className="text-zkperp-accent font-mono text-xs bg-zkperp-dark px-2 py-1 rounded">
                {truncateAddress(publicKey)}
              </code>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
