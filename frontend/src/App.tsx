import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom';
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
import { SystemStatusPage } from '@/pages/SystemStatusPage';
import { DarkpoolPage } from '@/pages/DarkpoolPage';
import { AdminPage } from '@/pages/AdminPage';
import { useOnChainData } from '@/hooks/useOnChainData';
import { AppLayout } from '@/components/AppLayout';
import { LandingPage } from '@/pages/LandingPage';
import { PAIR_IDS, getPair } from '@/config/pairs';
import type { PairId } from '@/config/pairs';
import { PrivateDataProvider } from '@/contexts/PrivateDataContext';

// ── TradeRoute ────────────────────────────────────────────────────────────────
// Reads :pair, fetches that pair's oracle price, passes typed prop to TradePage.

function TradeRoute() {
  const { pair } = useParams<{ pair: string }>();
  const [manualPrice, setManualPrice] = useState<bigint | null>(null);

  if (!PAIR_IDS.includes(pair as PairId)) {
    return <Navigate to="/trade/btc" replace />;
  }
  const pairId = pair as PairId;
  const { priceData } = useOnChainData(pairId);
  const currentPrice = priceData?.price ?? manualPrice ?? getPair(pairId).defaultPrice;

  return (
    <TradePage
      pair={pairId}
      currentPrice={currentPrice}
      oracleSet={priceData !== null}
      onPriceChange={setManualPrice}
    />
  );
}

// ── LiquidityRoute ────────────────────────────────────────────────────────────
// Reads :pair, fetches that pair's pool state, passes typed prop to LiquidityPage.

function LiquidityRoute() {
  const { pair } = useParams<{ pair: string }>();

  if (!PAIR_IDS.includes(pair as PairId)) {
    return <Navigate to="/liquidity/btc" replace />;
  }
  const pairId = pair as PairId;
  const { poolState, refresh } = useOnChainData(pairId);

  return (
    <LiquidityPage
      pair={pairId}
      poolLiquidity={poolState?.total_liquidity ?? 0n}
      totalLPTokens={poolState?.total_lp_tokens ?? 0n}
      longOI={poolState?.long_open_interest ?? 0n}
      shortOI={poolState?.short_open_interest ?? 0n}
      onRefresh={refresh}
    />
  );
}

// ── AppContent ────────────────────────────────────────────────────────────────
// Liquidate and Admin still use BTC pool state — wire them up the same way later.

function AppContent() {
  const { poolState, priceData, loading: dataLoading, refresh } = useOnChainData('btc');
  const [manualPrice] = useState<bigint | null>(null);

  const currentPrice = priceData?.price ?? manualPrice ?? BigInt(10000000000000);
  const poolLiquidity = poolState?.total_liquidity ?? 0n;
  const longOI = poolState?.long_open_interest ?? 0n;
  const shortOI = poolState?.short_open_interest ?? 0n;

  const location = useLocation();
  if (location.pathname === '/') return <LandingPage />;

  return (
    <PrivateDataProvider>
    <AppLayout>
      <Header />
      <Navigation />
      <Routes>
        {/* Trade — redirect bare /trade, dynamic pair route */}
        <Route path="/trade" element={<Navigate to="/trade/btc" replace />} />
        <Route path="/trade/:pair" element={<TradeRoute />} />

        {/* Liquidity — redirect bare /liquidity, dynamic pair route */}
        <Route path="/liquidity" element={<Navigate to="/liquidity/btc" replace />} />
        <Route path="/liquidity/:pair" element={<LiquidityRoute />} />

        <Route path="/darkpool" element={<DarkpoolPage />} />
        <Route
          path="/status"
          element={
            <SystemStatusPage
              currentPrice={currentPrice}
              poolLiquidity={poolLiquidity}
              longOI={longOI}
              shortOI={shortOI}
            />
          }
        />
        {/* Whitepaper — full page, no app chrome */}
        <Route path="/whitepaper" element={
          <iframe
            src="/whitepaper.html"
            style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', border: 'none', zIndex: 9999, background: '#fafaf8' }}
            title="ZKPerp Technical Whitepaper"
          />
        } />

        {/* Admin — unlisted from nav, still accessible at /admin */}
        <Route path="/admin" element={<AdminPage />} />
      </Routes>

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
              <button onClick={refresh} disabled={dataLoading}
                className="text-sm text-gray-500 hover:text-white transition-colors disabled:opacity-50">
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
              Aleo Testnet Beta • Contracts: zkperp_btc_v21.aleo · zkperp_eth_v21.aleo · zkperp_sol_v21.aleo
            </p>
          </div>
        </div>
      </footer>
    </AppLayout>
    </PrivateDataProvider>
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
        // All three pair programs registered so Shield Wallet can decrypt their records
        programs={['zkperp_btc_v21.aleo', 'zkperp_eth_v21.aleo', 'zkperp_sol_v21.aleo', 'test_usdcx_stablecoin.aleo', 'credits.aleo']}
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
