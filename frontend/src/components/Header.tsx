import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import { WalletMultiButton } from '@provablehq/aleo-wallet-adaptor-react-ui';
import { truncateAddress } from '@/utils/aleo';
import { useBalance, formatAleo, formatMockUsdc } from '@/hooks/useBalance';

export function Header() {
  const { connected, address } = useWallet();
  const { publicBalance, usdcBalance, loading: balanceLoading, refresh } = useBalance();

  return (
    <header className="border-b border-cyan-400/10 bg-white/[0.02] backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">

          {/* Logo */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-cyan-400 to-violet-500 flex items-center justify-center font-bold text-slate-950 shadow-[0_0_24px_rgba(34,211,238,0.4)]">
              Z
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-white">ZKPerp</h1>
              <p className="text-xs text-slate-400">Privacy-First Perpetuals</p>
            </div>
          </div>

          {/* Network + Links + Wallet */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-cyan-400/15 bg-cyan-400/5">
              <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
              <span className="text-xs text-slate-300">Testnet</span>
            </div>
            <div className="hidden sm:flex items-center gap-1">
              <a href="https://github.com/hwdeboer1977/ZKPerp" target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-slate-400 hover:text-white border border-transparent hover:border-slate-600 transition-all">
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58v-2.03c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 013.01-.4c1.02 0 2.05.13 3.01.4 2.28-1.55 3.29-1.23 3.29-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58C20.57 21.8 24 17.3 24 12c0-6.63-5.37-12-12-12z"/>
                </svg>
                GitHub
              </a>
              <a href="/whitepaper" target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-slate-400 hover:text-white border border-transparent hover:border-slate-600 transition-all">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Whitepaper
              </a>
              <a href="https://github.com/hwdeboer1977/ZKPerp/blob/main/README.md" target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-slate-400 hover:text-white border border-transparent hover:border-slate-600 transition-all">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                </svg>
                Docs
              </a>
            </div>
            <WalletMultiButton />
          </div>
        </div>
      </div>

      {/* Balances bar */}
      {connected && address && (
        <div className="border-t border-cyan-400/8 bg-black/20 py-2">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-slate-500">Connected:</span>
                <code className="text-cyan-300 font-mono text-xs bg-cyan-400/5 border border-cyan-400/15 px-2 py-1 rounded-lg">
                  {truncateAddress(address)}
                </code>
              </div>

              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 px-3 py-1 rounded-xl border border-cyan-400/10 bg-white/[0.03]">
                  <div className="w-5 h-5 rounded-full bg-gradient-to-br from-blue-400 to-cyan-500 flex items-center justify-center">
                    <span className="text-white text-xs font-bold">$</span>
                  </div>
                  <span className="text-sm text-white font-medium">{balanceLoading ? '...' : formatMockUsdc(usdcBalance)}</span>
                  <span className="text-xs text-slate-500">USDC</span>
                </div>

                <div className="flex items-center gap-2 px-3 py-1 rounded-xl border border-cyan-400/10 bg-white/[0.03]">
                  <div className="w-5 h-5 rounded-full bg-gradient-to-br from-cyan-400 to-violet-500 flex items-center justify-center">
                    <span className="text-white text-xs font-bold">A</span>
                  </div>
                  <span className="text-sm text-white font-medium">{balanceLoading ? '...' : formatAleo(publicBalance)}</span>
                  <span className="text-xs text-slate-500">ALEO</span>
                </div>

                <button onClick={refresh} disabled={balanceLoading}
                  className="text-slate-500 hover:text-cyan-300 disabled:opacity-40 transition-colors"
                  title="Refresh balances">
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
