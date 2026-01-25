import { useMemo, useState } from 'react';
import { WalletProvider } from '@demox-labs/aleo-wallet-adapter-react';
import { WalletModalProvider } from '@demox-labs/aleo-wallet-adapter-reactui';
import { LeoWalletAdapter } from '@demox-labs/aleo-wallet-adapter-leo';
import {
  DecryptPermission,
  WalletAdapterNetwork,
} from '@demox-labs/aleo-wallet-adapter-base';

import '@demox-labs/aleo-wallet-adapter-reactui/styles.css';

import { Header } from '@/components/Header';
import { TradingWidget } from '@/components/TradingWidget';
import { PositionDisplay } from '@/components/PositionDisplay';
import { MarketInfo } from '@/components/MarketInfo';

function AppContent() {
  // Simulated state for devnet testing
  const [currentPrice, setCurrentPrice] = useState<bigint>(BigInt(10000000000000)); // $100,000
  const [poolLiquidity] = useState<bigint>(BigInt(100000000000)); // $100,000
  const [longOI] = useState<bigint>(BigInt(25000000000)); // $25,000
  const [shortOI] = useState<bigint>(BigInt(15000000000)); // $15,000

  return (
    <div className="min-h-screen bg-zkperp-dark">
      <Header />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Hero Section */}
        <div className="text-center mb-8">
          <h2 className="text-2xl font-bold text-white mb-2">
            Private Perpetual Trading
          </h2>
          <p className="text-gray-400">
            Trade BTC with up to 20x leverage. Your positions stay private.
          </p>
        </div>

        {/* Main Grid */}
        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1">
            <MarketInfo
              currentPrice={currentPrice}
              poolLiquidity={poolLiquidity}
              longOI={longOI}
              shortOI={shortOI}
              onPriceChange={setCurrentPrice}
            />
          </div>

          <div className="lg:col-span-1">
            <TradingWidget currentPrice={currentPrice} />
          </div>

          <div className="lg:col-span-1">
            <PositionDisplay currentPrice={currentPrice} />
          </div>
        </div>

        {/* Info Cards */}
        <div className="grid md:grid-cols-3 gap-4 mt-8">
          <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-zkperp-accent/20 flex items-center justify-center">
                <svg className="w-5 h-5 text-zkperp-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <h3 className="font-semibold text-white">Private Positions</h3>
            </div>
            <p className="text-sm text-gray-400">
              Your position size, entry price, and PnL are encrypted using Aleo's zero-knowledge proofs.
            </p>
          </div>

          <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-zkperp-green/20 flex items-center justify-center">
                <svg className="w-5 h-5 text-zkperp-green" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                </svg>
              </div>
              <h3 className="font-semibold text-white">Up to 20x Leverage</h3>
            </div>
            <p className="text-sm text-gray-400">
              Trade with capital efficiency. Open positions with as little as 5% margin.
            </p>
          </div>

          <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-purple-500/20 flex items-center justify-center">
                <svg className="w-5 h-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
              </div>
              <h3 className="font-semibold text-white">No Front-Running</h3>
            </div>
            <p className="text-sm text-gray-400">
              Your trade intent is hidden until executed. No MEV, no sandwich attacks.
            </p>
          </div>
        </div>

        {/* Devnet Notice */}
        <div className="mt-8 bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-yellow-500 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div>
              <h4 className="font-medium text-yellow-500">Local Development Mode</h4>
              <p className="text-sm text-gray-400 mt-1">
                This app is connected to a local Aleo devnet. Make sure you have the devnet running 
                and the ZKPerp contract deployed. Pool stats are simulated for testing.
              </p>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-zkperp-border mt-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex flex-col md:flex-row justify-between items-center gap-4">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 bg-gradient-to-br from-zkperp-accent to-purple-500 rounded flex items-center justify-center">
                <span className="text-white font-bold text-xs">ZK</span>
              </div>
              <span className="text-gray-500 text-sm">ZKPerp - Built on Aleo</span>
            </div>
            <div className="flex gap-6 text-sm text-gray-500">
              <a href="#" className="hover:text-white transition-colors">Docs</a>
              <a href="https://github.com/hwdeboer1977/ZKPerp" className="hover:text-white transition-colors">GitHub</a>
              <a href="#" className="hover:text-white transition-colors">Discord</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

function App() {
  const wallets = useMemo(
    () => [
      new LeoWalletAdapter({
        appName: 'ZKPerp',
      }),
    ],
    []
  );

  return (
    <WalletProvider
      wallets={wallets}
      decryptPermission={DecryptPermission.UponRequest}
      network={WalletAdapterNetwork.Localnet}
      autoConnect
    >
      <WalletModalProvider>
        <AppContent />
      </WalletModalProvider>
    </WalletProvider>
  );
}

export default App;
