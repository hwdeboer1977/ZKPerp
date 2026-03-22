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

          {/* Network + Wallet */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-cyan-400/15 bg-cyan-400/5">
              <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
              <span className="text-xs text-slate-300">Testnet</span>
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
