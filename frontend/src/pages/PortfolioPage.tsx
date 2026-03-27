// PortfolioPage.tsx
// Combined Portfolio + Trade History page.
// All data is client-side only — reconstructed from decrypted private records.

import { useState } from 'react';

type Tab = 'portfolio' | 'history';

// ── Placeholder history rows (Wave 5 — real data from decrypted records) ──
const MOCK_HISTORY = [
  { id: '1', pair: 'BTC/USDC', direction: 'LONG',  size: 1000, entry: 67420, exit: 71200, pnl: 56.12,  duration: '2h 14m', date: '2025-03-26' },
  { id: '2', pair: 'SOL/USDC', direction: 'SHORT', size: 500,  entry: 89.10, exit: 84.20, pnl: 27.50,  duration: '45m',    date: '2025-03-25' },
  { id: '3', pair: 'ETH/USDC', direction: 'LONG',  size: 800,  entry: 2060,  exit: 1980,  pnl: -31.00, duration: '5h 02m', date: '2025-03-24' },
];



export function PortfolioPage() {
  const [activeTab, setActiveTab] = useState<Tab>('portfolio');
 

  const tabClass = (active: boolean) =>
    `px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
      active ? 'bg-zkperp-dark text-white' : 'text-gray-400 hover:text-white'
    }`;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-2">Portfolio</h1>
        <p className="text-gray-400">
          Your private trading summary — reconstructed locally from your decrypted records.{' '}
          <span className="text-zkperp-accent">🔒 Never stored on a server.</span>
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-zkperp-card border border-zkperp-border rounded-xl w-fit mb-6">
        <button onClick={() => setActiveTab('portfolio')} className={tabClass(activeTab === 'portfolio')}>
          📊 Portfolio
        </button>
        <button onClick={() => setActiveTab('history')} className={tabClass(activeTab === 'history')}>
          📜 History
        </button>
      </div>

      {/* ── Portfolio Tab ──────────────────────────────────────────── */}
      {activeTab === 'portfolio' && (
        <div className="space-y-6">

          {/* Stats row — blurred until Wave 5 */}
          <div className="relative">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 blur-sm pointer-events-none select-none">
              {[
                { label: 'Realised PnL', value: '+$—', sub: 'This session' },
                { label: 'Total Volume', value: '$—', sub: '— trades' },
                { label: 'Win Rate', value: '—%', sub: '— of — trades' },
                { label: 'Open Positions', value: '—', sub: 'Across all pairs' },
              ].map(({ label, value, sub }) => (
                <div key={label} className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
                  <p className="text-xs text-gray-500 mb-1">{label}</p>
                  <p className="text-2xl font-bold text-white">{value}</p>
                  <p className="text-xs text-gray-600 mt-1">{sub}</p>
                </div>
              ))}
            </div>
            <div className="absolute inset-0 flex items-center justify-center rounded-xl">
              <div className="text-center">
                <div className="text-4xl mb-2">🔒</div>
                <p className="text-sm font-semibold text-white mb-1">Coming in Wave 5</p>
                <p className="text-xs text-gray-400">Portfolio analytics from your decrypted records</p>
              </div>
            </div>
          </div>

          {/* Privacy note */}
          <div className="rounded-xl border border-zkperp-accent/20 bg-zkperp-accent/5 p-5">
            <div className="flex items-start gap-3">
              <span className="text-xl">🔒</span>
              <div>
                <p className="text-sm font-medium text-white mb-1">How your portfolio stays private</p>
                <p className="text-sm text-gray-400 leading-relaxed">
                  Positions on Aleo are <strong className="text-white">private records</strong> — encrypted on-chain and only decryptable with your view key.
                  This page reconstructs your summary entirely in-browser from records you decrypt yourself.
                  No wallet address, position size, or PnL figure is ever sent to a server or visible on-chain to anyone else.
                </p>
              </div>
            </div>
          </div>

          {/* Performance proof — Wave 5 */}
          <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <span className="text-xl">🧮</span>
                <div>
                  <h3 className="font-semibold text-white">Performance Proof</h3>
                  <p className="text-xs text-gray-500">Prove your returns without revealing your positions</p>
                </div>
              </div>
              <span className="px-2 py-0.5 rounded text-xs font-medium bg-zkperp-accent/10 text-zkperp-accent border border-zkperp-accent/20">
                Wave 5
              </span>
            </div>
            <p className="text-sm text-gray-400 mb-4">
              Generate a ZK proof that your trading returns exceed a threshold — e.g.{' '}
              <em>"I made &gt;15% over the last 30 days"</em> — without revealing individual trades,
              entry prices, or total capital. The proof is a verifiable Aleo execution anyone can check on-chain.
            </p>
            <button disabled
              className="px-4 py-2 rounded-lg bg-zkperp-dark border border-zkperp-border text-gray-500 text-sm cursor-not-allowed">
              Generate Proof — Coming in Wave 5
            </button>
          </div>

        </div>
      )}

      {/* ── History Tab ────────────────────────────────────────────── */}
      {activeTab === 'history' && (
        <div className="space-y-6">

          {/* Coming soon overlay card */}
          <div className="rounded-xl border border-zkperp-accent/20 bg-zkperp-accent/5 p-5 flex items-start gap-3">
            <span className="text-xl">🚀</span>
            <div>
              <p className="text-sm font-medium text-white mb-1">
                Full trade history coming in Wave 5
                <span className="ml-2 px-2 py-0.5 rounded text-xs font-medium bg-zkperp-accent/10 text-zkperp-accent border border-zkperp-accent/20">Wave 5</span>
              </p>
              <p className="text-sm text-gray-400">
                History will be reconstructed client-side from your decrypted{' '}
                <code className="text-xs bg-zkperp-dark px-1 rounded text-zkperp-accent">PositionSlot</code> records — entry price, exit price, PnL, and duration per trade.
                Exportable as CSV. Never stored on a server.
              </p>
            </div>
          </div>

          {/* Preview table (blurred) */}
          <div className="relative">
            <div className="bg-zkperp-card rounded-xl border border-zkperp-border overflow-hidden select-none pointer-events-none blur-sm">
              {/* Table header */}
              <div className="grid grid-cols-7 gap-0 px-4 py-2 border-b border-zkperp-border text-xs text-gray-500 font-medium">
                <span>Date</span>
                <span>Pair</span>
                <span>Direction</span>
                <span className="text-right">Size</span>
                <span className="text-right">Entry</span>
                <span className="text-right">Exit</span>
                <span className="text-right">PnL</span>
              </div>
              {MOCK_HISTORY.map((row) => (
                <div key={row.id} className="grid grid-cols-7 gap-0 px-4 py-3 border-b last:border-0 border-zkperp-border text-sm">
                  <span className="text-gray-400">{row.date}</span>
                  <span className="text-white font-medium">{row.pair}</span>
                  <span className={row.direction === 'LONG' ? 'text-zkperp-green' : 'text-zkperp-red'}>{row.direction}</span>
                  <span className="text-right text-white">${row.size.toLocaleString()}</span>
                  <span className="text-right text-gray-400">${row.entry.toLocaleString()}</span>
                  <span className="text-right text-gray-400">${row.exit.toLocaleString()}</span>
                  <span className={`text-right font-medium ${row.pnl >= 0 ? 'text-zkperp-green' : 'text-zkperp-red'}`}>
                    {row.pnl >= 0 ? '+' : ''}${row.pnl.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
            {/* Overlay */}
            <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-zkperp-dark/60">
              <div className="text-center">
                <p className="text-lg font-semibold text-white mb-1">🔒 Private</p>
                <p className="text-sm text-gray-400">Unlock in Wave 5</p>
              </div>
            </div>
          </div>

        </div>
      )}

    </div>
  );
}
