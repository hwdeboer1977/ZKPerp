export function AMMPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
      {/* Header */}
      <div className="text-center mb-12">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-zkperp-accent/10 border border-zkperp-accent/20 mb-6">
          <span className="text-4xl">🔄</span>
        </div>
        <h1 className="text-3xl font-bold text-white mb-3">ZKPerp AMM</h1>
        <p className="text-gray-400 text-lg max-w-xl mx-auto">
          Concentrated liquidity market making for USDCx/ALEO on Aleo testnet — capital-efficient swaps with private LP positions.
        </p>
      </div>

      {/* CTA button */}
      <div className="flex justify-center mb-10">
        <a
          href="https://zk-perp-amm.vercel.app/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-8 py-4 rounded-xl bg-gradient-to-r from-cyan-400 to-violet-500 text-slate-950 font-bold text-sm uppercase tracking-widest shadow-[0_0_30px_rgba(34,211,238,0.3)] hover:shadow-[0_0_40px_rgba(34,211,238,0.5)] hover:scale-105 transition-all"
        >
          🔄 Launch AMM
        </a>
      </div>

      {/* Feature cards */}
      <div className="grid md:grid-cols-3 gap-5 mb-12">
        {[
          {
            icon: '💎',
            title: 'Concentrated Liquidity',
            body: 'Inspired by Uniswap v3, LPs deploy capital within a custom price range instead of across the full curve — earning the same fees with far less capital at risk.',
          },
          {
            icon: '⚡',
            title: 'Capital Efficiency',
            body: 'A position covering a narrow price band can be up to 4000× more capital-efficient than a traditional x·y=k pool, meaning deeper liquidity for the same TVL.',
          },
          {
            icon: '🔒',
            title: 'Private LP Positions',
            body: 'LP positions are stored as encrypted Aleo records. Your tick range, liquidity size, and accrued fees are visible only to you — never exposed on-chain.',
          },
        ].map(({ icon, title, body }) => (
          <div key={title} className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
            <div className="w-10 h-10 rounded-lg bg-zkperp-accent/10 flex items-center justify-center mb-4 text-xl">
              {icon}
            </div>
            <h3 className="font-semibold text-white mb-2">{title}</h3>
            <p className="text-sm text-gray-400">{body}</p>
          </div>
        ))}
      </div>

      {/* How it works */}
      <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6 mb-6">
        <h3 className="font-semibold text-white mb-4">How Concentrated Liquidity Works</h3>
        <div className="space-y-4">
          {[
            { step: '1', title: 'Choose a price range', body: 'LPs select a lower and upper tick defining the price band where their liquidity is active. Tighter ranges earn more fees but require active management.' },
            { step: '2', title: 'Deposit USDCx and ALEO', body: 'The AMM calculates the required token amounts based on the current price and chosen range. Both tokens are deposited in the correct ratio.' },
            { step: '3', title: 'Earn 0.3% swap fees', body: 'Every swap that passes through your active range pays a 0.3% fee, split proportionally among all in-range LPs by their liquidity share.' },
            { step: '4', title: 'Withdraw anytime', body: 'Burn your LP position record to reclaim your tokens plus any accrued fees. Positions are fully non-custodial — the contract holds no admin keys.' },
          ].map(({ step, title, body }) => (
            <div key={step} className="flex gap-4">
              <div className="w-7 h-7 rounded-full bg-zkperp-accent/20 border border-zkperp-accent/40 flex items-center justify-center flex-shrink-0 text-xs font-bold text-zkperp-accent">
                {step}
              </div>
              <div>
                <p className="text-sm font-medium text-white">{title}</p>
                <p className="text-sm text-gray-400 mt-0.5">{body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Vs traditional AMM */}
      <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6 mb-6">
        <h3 className="font-semibold text-white mb-4">Concentrated vs Traditional AMM</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zkperp-border">
                <th className="text-left text-gray-400 font-medium pb-3 pr-4">Feature</th>
                <th className="text-left text-zkperp-accent font-medium pb-3 pr-4">ZKPerp AMM</th>
                <th className="text-left text-gray-500 font-medium pb-3">Traditional x·y=k</th>
              </tr>
            </thead>
            <tbody className="space-y-2">
              {[
                ['Capital efficiency', 'Up to 4000×', '1×'],
                ['Price range',        'Custom per LP',  'Full curve (0 → ∞)'],
                ['LP position',        'Private record', 'Public ERC-721'],
                ['Fee tier',           '0.3%',           'Fixed'],
                ['Chain',              'Aleo testnet',   'EVM'],
              ].map(([feat, ours, theirs]) => (
                <tr key={feat} className="border-b border-zkperp-border/40 last:border-0">
                  <td className="py-2 pr-4 text-gray-400">{feat}</td>
                  <td className="py-2 pr-4 text-white font-medium">{ours}</td>
                  <td className="py-2 text-gray-500">{theirs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Testnet reference */}
      <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6 mb-6">
        <h3 className="font-semibold text-white mb-2">Live on Aleo Testnet</h3>
        <p className="text-sm text-gray-400 mb-3">
          The AMM contract (<code className="text-zkperp-accent text-xs px-1 bg-zkperp-dark rounded">zkperp_amm_v3.aleo</code>) is deployed and active on Aleo testnet. Swap USDCx for ALEO, provide liquidity in a custom range, and burn positions to withdraw.
        </p>
        <a
          href="https://github.com/hwdeboer1977/ZKPerp"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 text-sm text-zkperp-accent hover:text-white transition-colors"
        >
          View on GitHub →
        </a>
      </div>

      {/* Bottom CTA */}
      <div className="flex justify-center">
        <a
          href="https://zk-perp-amm.vercel.app/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-8 py-4 rounded-xl bg-gradient-to-r from-cyan-400 to-violet-500 text-slate-950 font-bold text-sm uppercase tracking-widest shadow-[0_0_30px_rgba(34,211,238,0.3)] hover:shadow-[0_0_40px_rgba(34,211,238,0.5)] hover:scale-105 transition-all"
        >
          🔄 Launch AMM
        </a>
      </div>
    </div>
  );
}
