import { useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AleoWalletProvider } from '@provablehq/aleo-wallet-adaptor-react';
import { WalletModalProvider } from '@provablehq/aleo-wallet-adaptor-react-ui';
import { ShieldWalletAdapter } from '@provablehq/aleo-wallet-adaptor-shield';
import { Network } from '@provablehq/aleo-types';
import { DecryptPermission } from '@provablehq/aleo-wallet-adaptor-core';

import '@provablehq/aleo-wallet-adaptor-react-ui/dist/styles.css';

import { Header } from '@/components/Header';
import { Navigation } from '@/components/Navigation';
import { TradePage } from '@/pages/TradePage';
import { LiquidityPage } from '@/pages/LiquidityPage';
import { LiquidatePage } from '@/pages/LiquidatePage';
import { AdminPage } from '@/pages/AdminPage';
import { useOnChainData } from '@/hooks/useOnChainData';

function AppContent() {
  const { poolState, priceData, loading: dataLoading, refresh } = useOnChainData();

  const [manualPrice, setManualPrice] = useState<bigint | null>(null);

  const currentPrice = priceData?.price ?? manualPrice ?? BigInt(10000000000000);
  const poolLiquidity = poolState?.total_liquidity ?? BigInt(0);
  const longOI = poolState?.long_open_interest ?? BigInt(0);
  const shortOI = poolState?.short_open_interest ?? BigInt(0);

  return (
    <div className="min-h-screen bg-zkperp-dark">
      <Header />
      <Navigation />

      <Routes>
        <Route
          path="/"
          element={
            <TradePage
              currentPrice={currentPrice}
              oracleSet={priceData !== null}
              onPriceChange={setManualPrice}
            />
          }
        />
        <Route
          path="/liquidity"
          element={
            <LiquidityPage
              poolLiquidity={poolLiquidity}
              longOI={longOI}
              shortOI={shortOI}
              onRefresh={refresh}
            />
          }
        />
        <Route
          path="/liquidate"
          element={
            <LiquidatePage
              currentPrice={currentPrice}
              poolLiquidity={poolLiquidity}
              longOI={longOI}
              shortOI={shortOI}
            />
          }
        />
        <Route
          path="/admin"
          element={
            <AdminPage
              currentPrice={currentPrice}
              oracleSet={priceData !== null}
              poolLiquidity={poolLiquidity}
              longOI={longOI}
              shortOI={shortOI}
              onRefresh={refresh}
            />
          }
        />
      </Routes>

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
            <div className="flex items-center gap-4">
              <button
                onClick={refresh}
                disabled={dataLoading}
                className="text-sm text-gray-500 hover:text-white transition-colors disabled:opacity-50"
              >
                {dataLoading ? 'Refreshing...' : '↻ Refresh Data'}
              </button>
              <span className="text-gray-600">|</span>
              <a href="https://github.com/hwdeboer1977/ZKPerp" className="text-sm text-gray-500 hover:text-white transition-colors">
                GitHub
              </a>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t border-zkperp-border">
            <p className="text-center text-xs text-gray-600">
              Aleo Testnet Beta • Contract: zkperp_v6.aleo
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AleoWalletProvider
        wallets={[new ShieldWalletAdapter()]}
        autoConnect={false}
        network={Network.TESTNET}
        decryptPermission={DecryptPermission.UponRequest}
        programs={['zkperp_v6.aleo', 'test_usdcx_stablecoin.aleo', 'credits.aleo']}
        onError={(error) => console.error(error.message)}
      >
        <WalletModalProvider>
          <AppContent />
        </WalletModalProvider>
      </AleoWalletProvider>
    </BrowserRouter>
  );
}

export default App;
