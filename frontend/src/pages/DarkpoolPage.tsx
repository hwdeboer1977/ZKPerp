export function DarkpoolPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
      {/* Header */}
      <div className="text-center mb-12">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-zkperp-accent/10 border border-zkperp-accent/20 mb-6">
          <span className="text-4xl">🌑</span>
        </div>
        <h1 className="text-3xl font-bold text-white mb-3">ZK Dark Pool</h1>
        <p className="text-gray-400 text-lg max-w-xl mx-auto">
          A privacy-first batch auction exchange built on Aleo. Institutional-grade dark pool trading with zero-knowledge proofs.
        </p>
      </div>

      {/* Coming Soon badge */}
      <div className="flex justify-center mb-12">
        <span className="px-4 py-2 rounded-full text-sm font-semibold bg-zkperp-accent/10 border border-zkperp-accent/30 text-zkperp-accent">
          🚧 Coming Soon in Wave 5!
        </span>
      </div>

      {/* Feature cards */}
      <div className="grid md:grid-cols-3 gap-5 mb-12">
        {[
          {
            icon: '🔒',
            title: 'Hidden Order Book',
            body: 'All bids and asks are encrypted on-chain. No one can see your order size or price until settlement — eliminating front-running entirely.',
          },
          {
            icon: '⚖️',
            title: 'Uniform Clearing Price',
            body: 'Batch auctions settle at a single clearing price for all matched orders, ensuring fair execution without price impact for large trades.',
          },
          {
            icon: '✅',
            title: 'ZK Settlement Proofs',
            body: 'Every match is verified by a zero-knowledge proof. The settlement is trustless — no operator can manipulate the outcome.',
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
        <h3 className="font-semibold text-white mb-4">How Batch Auction Settlement Works</h3>
        <div className="space-y-4">
          {[
            { step: '1', title: 'Submit encrypted orders', body: 'Buyers and sellers submit sealed bids and asks. Orders are recorded on Aleo as encrypted records — only the submitter can decrypt them.' },
            { step: '2', title: 'Batch window closes', body: 'After a fixed interval, the batch closes. No new orders are accepted. The order book state is frozen.' },
            { step: '3', title: 'Off-chain matching', body: 'The ZK Dark Pool matcher computes the uniform clearing price — the price at which the maximum volume of buy and sell orders can be filled.' },
            { step: '4', title: 'ZK proof of settlement', body: 'The matcher generates a zero-knowledge proof that the clearing price is valid and all matched orders are correctly settled, then posts it on-chain.' },
            { step: '5', title: 'On-chain settlement', body: 'Aleo verifies the proof and executes settlement atomically. Unmatched orders are refunded. No operator can front-run or manipulate the outcome.' },
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

      {/* Testnet reference */}
      <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
        <h3 className="font-semibold text-white mb-2">Proof of Concept — Aleo Testnet</h3>
        <p className="text-sm text-gray-400 mb-3">
          A working proof of concept (<code className="text-zkperp-accent text-xs px-1 bg-zkperp-dark rounded">zkdarkpool_v2.aleo</code>) is already deployed on Aleo testnet with live batch auction settlement confirmed. The full UI integration is in progress.
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
    </div>
  );
}
