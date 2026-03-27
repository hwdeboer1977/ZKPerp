// CompliancePage.tsx
// Explains ZKPerp's compliance architecture and surfaces ComplianceRecords
// from the user's wallet. All data is client-side only.

export function CompliancePage() {
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-2">Compliance</h1>
        <p className="text-gray-400 max-w-2xl">
          ZKPerp is built for privacy — but privacy and compliance are not opposites.
          Every transaction generates a cryptographic receipt that proves regulatory requirements
          were met, without revealing your identity or trade details to anyone else.
        </p>
      </div>

      {/* How it works */}
      <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6 mb-6">
        <h2 className="font-semibold text-white mb-4">How Compliance Works on ZKPerp</h2>
        <div className="grid md:grid-cols-3 gap-4">
          {[
            {
              step: '1',
              icon: '🌿',
              title: 'Merkle Allowlist',
              body: 'Before depositing, your wallet address is verified against a Merkle tree of compliant addresses. The proof of inclusion is computed locally — your address is never sent to a server.',
            },
            {
              step: '2',
              icon: '📋',
              title: 'ComplianceRecord',
              body: 'Every deposit mints a private ComplianceRecord to your wallet — a ZK receipt proving the transaction was linked to a verified Merkle proof at the time of execution.',
            },
            {
              step: '3',
              icon: '🔍',
              title: 'Selective Disclosure',
              body: 'You hold your ComplianceRecords. Share them with an auditor on request. The record proves compliance without revealing position size, entry price, or any trade detail.',
            },
          ].map(({ step, icon, title, body }) => (
            <div key={step} className="bg-zkperp-dark rounded-xl border border-zkperp-border p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="w-6 h-6 rounded-full bg-zkperp-accent/20 text-zkperp-accent text-xs font-bold flex items-center justify-center">{step}</span>
                <span className="text-lg">{icon}</span>
                <span className="text-sm font-semibold text-white">{title}</span>
              </div>
              <p className="text-xs text-gray-400 leading-relaxed">{body}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ComplianceRecord explainer */}
      <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6 mb-6">
        <h2 className="font-semibold text-white mb-3">What is a ComplianceRecord?</h2>
        <p className="text-sm text-gray-400 mb-4 leading-relaxed">
          A <code className="text-zkperp-accent text-xs bg-zkperp-dark px-1.5 py-0.5 rounded">ComplianceRecord</code> is
          a private Aleo record minted to your wallet on every deposit or withdrawal. It is defined and issued
          by <code className="text-zkperp-accent text-xs bg-zkperp-dark px-1.5 py-0.5 rounded">test_usdcx_stablecoin.aleo</code> —
          the underlying token standard that ZKPerp is built on. This means compliance is not a ZKPerp-specific feature:
          every protocol that integrates USDCx inherits it automatically.
        </p>
        <div className="bg-zkperp-dark rounded-lg border border-zkperp-border p-4 text-xs text-gray-400 mb-4 leading-relaxed">
          <p className="text-gray-500 mb-2">Issued by <span className="text-zkperp-accent">test_usdcx_stablecoin.aleo</span> on every <span className="text-white">transfer_private_to_public</span> and <span className="text-white">transfer_public_to_private</span> call:</p>
          <ul className="space-y-1 list-none">
            <li>🔒 <span className="text-white">owner</span> — your wallet address (private)</li>
            <li>🔒 <span className="text-white">amount</span> — transaction amount (private)</li>
            <li>🔒 <span className="text-white">merkle proof fields</span> — your position in the Sealance allowlist tree (private)</li>
            <li>🌐 <span className="text-white">merkle root</span> — the on-chain root at time of execution (public — anyone can verify)</li>
          </ul>
        </div>
        <p className="text-sm text-gray-400 leading-relaxed">
          The public merkle root lets any auditor verify that your transaction was linked to a valid allowlist
          entry at that block height — without seeing your address, amount, or any position detail.
        </p>
      </div>

      {/* Your records — Wave 5 */}
      <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="font-semibold text-white">Your Compliance Records</h2>
            <p className="text-xs text-gray-500 mt-0.5">Decrypted locally from your wallet — never sent to a server</p>
          </div>
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-zkperp-accent/10 text-zkperp-accent border border-zkperp-accent/20">
            Wave 5
          </span>
        </div>

        {/* Blurred preview */}
        <div className="relative">
          <div className="blur-sm pointer-events-none select-none space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="bg-zkperp-dark rounded-lg border border-zkperp-border p-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-zkperp-green text-xs font-medium">✓ Verified</span>
                  <span className="text-gray-400 text-xs font-mono">0x{Math.random().toString(16).slice(2, 18).toUpperCase()}</span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-gray-500 text-xs">2025-03-2{i}</span>
                  <button className="px-3 py-1 rounded bg-zkperp-accent/10 border border-zkperp-accent/20 text-zkperp-accent text-xs">
                    Export
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-zkperp-dark/60">
            <div className="text-center">
              <p className="text-sm font-semibold text-white mb-1">🔒 Coming in Wave 5</p>
              <p className="text-xs text-gray-400">Decrypt and view your ComplianceRecords</p>
            </div>
          </div>
        </div>
      </div>

      {/* Audit proof — Wave 5 */}
      <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6 mb-6">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <span className="text-xl">🔍</span>
            <div>
              <h2 className="font-semibold text-white">Audit Proof Generator</h2>
              <p className="text-xs text-gray-500">Generate a ZK proof covering a date range — share with an auditor on request</p>
            </div>
          </div>
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-zkperp-accent/10 text-zkperp-accent border border-zkperp-accent/20">
            Wave 5
          </span>
        </div>
        <p className="text-sm text-gray-400 mb-4 leading-relaxed">
          Select a date range and generate a single ZK proof that covers all your ComplianceRecords
          within that period. The proof attests that every transaction was linked to a valid Merkle
          allowlist entry — without revealing amounts, counterparties, or trade details.
          Share the proof with a regulator or auditor; they can verify it on-chain independently.
        </p>
        <button disabled
          className="px-4 py-2 rounded-lg bg-zkperp-dark border border-zkperp-border text-gray-500 text-sm cursor-not-allowed">
          Generate Audit Proof — Coming in Wave 5
        </button>
      </div>

      {/* Privacy vs compliance callout */}
      <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-6">
        <div className="flex items-start gap-4">
          <span className="text-2xl">⚖️</span>
          <div>
            <h3 className="font-semibold text-white mb-2">Privacy and Compliance Are Not Opposites</h3>
            <p className="text-sm text-gray-400 leading-relaxed mb-3">
              Most DEXes offer one or the other: full transparency (no privacy) or full anonymity
              (no compliance path). ZKPerp offers a third option — <span className="text-white font-medium">selective
              disclosure via ZK proofs</span>.
            </p>
            <p className="text-sm text-gray-400 leading-relaxed mb-3">
              Your positions remain encrypted on-chain. Your compliance records remain in your wallet.
              You decide what to reveal and to whom — and every disclosure is cryptographically
              verifiable, not just a screenshot or a spreadsheet export.
            </p>
            <p className="text-sm text-gray-400 leading-relaxed">
              This is the core value proposition of building a perpetuals DEX on Aleo:
              the ZK VM makes compliance proofs as cheap and verifiable as any other transaction.
            </p>
          </div>
        </div>
      </div>

    </div>
  );
}
