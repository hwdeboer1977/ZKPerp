// CompliancePage.tsx
// Shows compliance status and lets users get their ZKPerpComplianceRecord
// by going through the KYC flow (register → Merkle proof → issue_compliance).

import { useState, useCallback } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import { useTransaction } from '@/hooks/useTransaction';
import { TransactionStatus } from '@/components/TransactionStatus';
import { useCompliance } from '@/hooks/useCompliance';

const COMPLIANCE_API = (import.meta as any).env?.VITE_COMPLIANCE_API || '';
const COMPLIANCE_PROGRAM_ID = 'zkperp_compliance_v7.aleo';
const EXPIRY_BLOCKS = 7_776_000; // ~90 days
const ALEO_API = 'https://api.explorer.provable.com/v1/testnet';

type StepState = 'idle' | 'active' | 'done' | 'error';

interface Step {
  id: string;
  label: string;
  sub: string;
  state: StepState;
}

async function getCurrentBlock(): Promise<number> {
  try {
    const res = await fetch(`${ALEO_API}/block/height/latest`);
    const d = await res.json();
    return typeof d === 'number' ? d : (d.height || 0);
  } catch { return 0; }
}

function StepRow({ step, num }: { step: Step; num: number }) {
  const colors = {
    idle:   { border: 'border-zkperp-border',    bg: 'bg-zkperp-dark',        text: 'text-gray-500',       icon: 'text-gray-600' },
    active: { border: 'border-blue-500/50',       bg: 'bg-blue-500/5',         text: 'text-blue-400',       icon: 'text-blue-400' },
    done:   { border: 'border-zkperp-green/50',  bg: 'bg-zkperp-green/5',     text: 'text-zkperp-green',   icon: 'text-zkperp-green' },
    error:  { border: 'border-red-500/50',        bg: 'bg-red-500/5',          text: 'text-red-400',        icon: 'text-red-400' },
  }[step.state];

  const icon = step.state === 'active'
    ? <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
    : step.state === 'done' ? '✓'
    : step.state === 'error' ? '✕'
    : num;

  return (
    <div className={`flex items-start gap-3 p-3 rounded-lg border ${colors.border} ${colors.bg} transition-all duration-300`}>
      <div className={`w-7 h-7 rounded-full border ${colors.border} flex items-center justify-center text-xs font-bold flex-shrink-0 ${colors.icon}`}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium ${colors.text}`}>{step.label}</p>
        <p className="text-xs text-gray-500 mt-0.5 break-all">{step.sub}</p>
      </div>
    </div>
  );
}

export function CompliancePage() {
  const { address, connected } = useWallet();
  const { hasRecord, complianceRecord, loading: crLoading, refetch } = useCompliance();

  const [steps, setSteps] = useState<Step[] | null>(null);
  const [running, setRunning] = useState(false);
  const issueTx = useTransaction();

  function initSteps(): Step[] {
    return [
      { id: 'register', label: 'Register in KYC allowlist',     sub: 'Waiting...', state: 'idle' },
      { id: 'proof',    label: 'Build Merkle proof',             sub: 'Waiting...', state: 'idle' },
      { id: 'issue',    label: 'Issue ZK compliance record',     sub: 'Waiting...', state: 'idle' },
    ];
  }

  function updateStep(id: string, patch: Partial<Step>) {
    setSteps(prev => prev?.map(s => s.id === id ? { ...s, ...patch } : s) ?? null);
  }

  const handleGetVerified = useCallback(async () => {
    if (!connected || !address) return;
    setRunning(true);
    const fresh = initSteps();
    setSteps(fresh);

    try {
      // Step 1: Register
      updateStep('register', { state: 'active', sub: 'Submitting address to allowlist...' });
      const regRes = await fetch(`${COMPLIANCE_API}/api/compliance/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, signature: 'zkperp-frontend-' + Date.now() }),
      });
      const regData = await regRes.json();
      if (regData.error) throw new Error(regData.error);
      updateStep('register', {
        state: 'done',
        sub: regData.status === 'already_registered'
          ? 'Already in allowlist — fetching proof'
          : `Registered · tx: ${regData.tx_id?.slice(0, 20) ?? 'pending'}...`,
      });

      // Step 2: Merkle proof + block height
      updateStep('proof', { state: 'active', sub: 'Computing Merkle proof...' });
      const [proofRes, currentBlock] = await Promise.all([
        fetch(`${COMPLIANCE_API}/api/compliance/proof/${address}`),
        getCurrentBlock(),
      ]);
      const proofData = await proofRes.json();
      if (proofData.error) throw new Error(proofData.error);
      const expiry = currentBlock + EXPIRY_BLOCKS;
      updateStep('proof', {
        state: 'done',
        sub: `Root: ${proofData.root.slice(0, 18)}... · Expiry block ${expiry.toLocaleString()}`,
      });

      // Step 3: Submit issue_compliance via Shield wallet
      updateStep('issue', { state: 'active', sub: 'Submitting to Shield wallet...' });
      await issueTx.execute({
        program: COMPLIANCE_PROGRAM_ID,
        function: 'issue_compliance',
        inputs: [
          proofData.leo_proof,
          `${expiry}u32`,
        ],
        fee: 3_000_000,
        privateFee: false,
      });
      updateStep('issue', {
        state: 'done',
        sub: 'ZKPerpComplianceRecord issued to your wallet · Valid ~90 days',
      });

      // Refresh compliance record — poll a few times as record may take time to appear
      setTimeout(() => refetch(), 3000);
      setTimeout(() => refetch(), 8000);
      setTimeout(() => refetch(), 15000);

    } catch (e: any) {
      setSteps(prev => prev?.map(s =>
        s.state === 'active' ? { ...s, state: 'error', sub: e.message } : s
      ) ?? null);
    } finally {
      setRunning(false);
    }
  }, [connected, address, refetch]);

  const daysLeft = complianceRecord?.expiresAt
    ? Math.max(0, Math.floor((complianceRecord.expiresAt - Date.now() / 1000) / 86400))
    : null;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-2">Compliance</h1>
        <p className="text-gray-400 max-w-2xl">
          ZKPerp enforces KYC at the circuit level. Only wallets with a valid{' '}
          <code className="text-zkperp-accent text-xs bg-zkperp-dark px-1.5 py-0.5 rounded">ZKPerpComplianceRecord</code>{' '}
          can open positions, add liquidity, or place orders. Records expire after ~90 days.
        </p>
      </div>

      {/* Status + Get Verified card */}
      <div className="grid md:grid-cols-2 gap-6 mb-6">

        {/* Status */}
        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
          <h2 className="font-semibold text-white mb-4">Your Compliance Status</h2>
          {!connected ? (
            <div className="text-center py-6">
              <p className="text-gray-400 text-sm mb-1">Connect your wallet to check</p>
              <p className="text-gray-600 text-xs">Shield wallet required</p>
            </div>
          ) : crLoading ? (
            <div className="flex items-center gap-2 text-gray-400 py-4">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
              <span className="text-sm">Checking wallet...</span>
            </div>
          ) : hasRecord ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-4 rounded-lg bg-zkperp-green/5 border border-zkperp-green/30">
                <span className="text-2xl">✓</span>
                <div>
                  <p className="text-zkperp-green font-semibold">Verified Trader</p>
                  <p className="text-gray-400 text-xs mt-0.5">Active compliance record found in wallet</p>
                </div>
              </div>
              {complianceRecord ? (
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Issued under root</span>
                    <span className="text-white font-mono text-xs">{complianceRecord.issuedUnder.slice(0, 16)}...</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Expires at block</span>
                    <span className="text-white">{complianceRecord.expiresAt.toLocaleString()}</span>
                  </div>
                  {daysLeft !== null && (
                    <div className="flex justify-between">
                      <span className="text-gray-400">Estimated days left</span>
                      <span className={daysLeft < 14 ? 'text-yellow-400' : 'text-zkperp-green'}>
                        ~{daysLeft} days
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-gray-500">Record found · click Refresh to decrypt details.</p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={async () => { await refetch(); }}
                  disabled={crLoading}
                  className="flex-1 py-2 rounded-lg border border-zkperp-border bg-zkperp-dark text-gray-400 text-sm hover:border-gray-500 hover:text-white transition-colors disabled:opacity-50"
                >
                  {crLoading ? 'Checking...' : '↻ Refresh'}
                </button>
                <button
                  onClick={handleGetVerified}
                  disabled={running}
                  className="flex-1 py-2 rounded-lg border border-zkperp-border bg-zkperp-dark text-gray-400 text-sm hover:border-gray-500 hover:text-white transition-colors disabled:opacity-50"
                >
                  Renew
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-4 rounded-lg bg-zkperp-dark border border-zkperp-border">
                <span className="text-2xl text-gray-600">○</span>
                <div>
                  <p className="text-gray-300 font-semibold">Not Verified</p>
                  <p className="text-gray-500 text-xs mt-0.5">No active compliance record in wallet</p>
                </div>
              </div>
              <p className="text-xs text-gray-500 leading-relaxed mb-3">
                You need a <code className="text-zkperp-accent">ZKPerpComplianceRecord</code> to trade.
                Get verified by completing the KYC flow on the right.
              </p>
              <button
                onClick={async () => { await refetch(); }}
                disabled={crLoading}
                className="w-full py-2 rounded-lg border border-zkperp-border bg-zkperp-dark text-gray-400 text-xs hover:border-gray-500 hover:text-white transition-colors disabled:opacity-50"
              >
                {crLoading ? 'Checking...' : '↻ Check Status'}
              </button>
            </div>
          )}
        </div>

        {/* Get Verified flow */}
        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
          <h2 className="font-semibold text-white mb-1">Get Your Trading Passport</h2>
          <p className="text-xs text-gray-500 mb-4">
            3-step flow · ~2 minutes · Valid for 90 days
          </p>

          {steps ? (
            <div className="space-y-2 mb-4">
              {steps.map((s, i) => <StepRow key={s.id} step={s} num={i + 1} />)}
            </div>
          ) : (
            <div className="space-y-3 mb-4">
              {[
                { num: 1, label: 'Register address in KYC allowlist' },
                { num: 2, label: 'Compute Merkle membership proof' },
                { num: 3, label: 'Issue ZKPerpComplianceRecord on-chain' },
              ].map(({ num, label }) => (
                <div key={num} className="flex items-center gap-3 p-3 rounded-lg bg-zkperp-dark border border-zkperp-border">
                  <div className="w-7 h-7 rounded-full border border-zkperp-border flex items-center justify-center text-xs font-bold text-gray-600">
                    {num}
                  </div>
                  <p className="text-sm text-gray-400">{label}</p>
                </div>
              ))}
            </div>
          )}

          {/* Transaction status */}
          {issueTx.status !== 'idle' && (
            <div className="mb-4">
              <TransactionStatus
                status={issueTx.status}
                tempTxId={issueTx.tempTxId}
                onChainTxId={issueTx.onChainTxId}
                error={issueTx.error}
                onDismiss={issueTx.reset}
              />
            </div>
          )}

          <button
            onClick={handleGetVerified}
            disabled={!connected || running}
            className="w-full py-3 rounded-lg font-semibold text-sm transition-all disabled:cursor-not-allowed bg-zkperp-accent hover:bg-zkperp-accent/80 disabled:bg-zkperp-accent/30 text-white"
          >
            {!connected ? 'Connect Wallet First'
              : running ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                  Processing...
                </span>
              )
              : complianceRecord ? 'Renew Compliance Record'
              : 'Get Compliance Record'}
          </button>
        </div>
      </div>

      {/* How it works */}
      <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6 mb-6">
        <h2 className="font-semibold text-white mb-4">How It Works</h2>
        <div className="grid md:grid-cols-3 gap-4">
          {[
            {
              step: '1', icon: '🌿', title: 'Merkle Allowlist',
              body: 'Your wallet address is added to a depth-10 BHP256 Merkle tree. Only the root is published on-chain — your address is never revealed publicly.',
            },
            {
              step: '2', icon: '📋', title: 'ZKPerpComplianceRecord',
              body: 'Calling issue_compliance with your Merkle proof mints a private record to your wallet. It contains the root epoch and expiry block — both verifiable on-chain.',
            },
            {
              step: '3', icon: '🔍', title: 'Gated Trading',
              body: 'Every trade, deposit, and order checks your record in-circuit. If revoked or expired, the transaction fails. No identity is ever revealed on-chain.',
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

      {/* Record structure */}
      <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6 mb-6">
        <h2 className="font-semibold text-white mb-3">What is a ZKPerpComplianceRecord?</h2>
        <p className="text-sm text-gray-400 mb-4 leading-relaxed">
          A private Aleo record issued by{' '}
          <code className="text-zkperp-accent text-xs bg-zkperp-dark px-1.5 py-0.5 rounded">{COMPLIANCE_PROGRAM_ID}</code>{' '}
          after successful KYC verification. Passed as an input to every gated trading function in{' '}
          <code className="text-zkperp-accent text-xs bg-zkperp-dark px-1.5 py-0.5 rounded">zkperp_core_v26.aleo</code>.
        </p>
        <div className="bg-zkperp-dark rounded-lg border border-zkperp-border p-4 text-xs font-mono mb-4">
          <p className="text-gray-500 mb-3">record ZKPerpComplianceRecord {'{'}</p>
          <div className="pl-4 space-y-1.5">
            <p><span className="text-zkperp-accent">owner</span><span className="text-gray-500">: address,</span><span className="text-gray-600 ml-4">// private — only holder can spend</span></p>
            <p><span className="text-zkperp-accent">issued_under</span><span className="text-gray-500">: field,</span><span className="text-gray-600 ml-4">// Merkle root at issuance</span></p>
            <p><span className="text-zkperp-accent">expires_at</span><span className="text-gray-500">: u32,</span><span className="text-gray-600 ml-4">// block height expiry (~90 days)</span></p>
          </div>
          <p className="text-gray-500 mt-2">{'}'}</p>
        </div>
        <p className="text-sm text-gray-400 leading-relaxed">
          The core program reads <code className="text-zkperp-accent text-xs">issued_under</code> and <code className="text-zkperp-accent text-xs">expires_at</code> directly from the record in every gated function,
          then asserts them against on-chain mappings in <code className="text-zkperp-accent text-xs">
zkperp_compliance_v7.aleo</code>.
          Three conditions must pass: root matches, not revoked, not expired.
        </p>
      </div>

      {/* Privacy callout */}
      <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-6">
        <div className="flex items-start gap-4">
          <span className="text-2xl">⚖️</span>
          <div>
            <h3 className="font-semibold text-white mb-2">Privacy and Compliance Are Not Opposites</h3>
            <p className="text-sm text-gray-400 leading-relaxed mb-3">
              Most DEXes offer one or the other: full transparency or full anonymity.
              ZKPerp offers a third option —{' '}
              <span className="text-white font-medium">KYC enforcement at the circuit level</span>.
            </p>
            <p className="text-sm text-gray-400 leading-relaxed mb-3">
              The blockchain reveals nothing about user identity — only the admin knows the
              wallet → identity mapping, producible under legal order. Meanwhile, every trade
              is cryptographically proven to originate from a verified wallet.
            </p>
            <p className="text-sm text-gray-400 leading-relaxed">
              This satisfies FATF/MiCA KYC requirements without public identity disclosure.
            </p>
          </div>
        </div>
      </div>

    </div>
  );
}
