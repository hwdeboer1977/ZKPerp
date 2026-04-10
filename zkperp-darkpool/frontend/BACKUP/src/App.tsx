import { useState, useEffect, useCallback } from 'react'
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react'
import { WalletMultiButton } from '@provablehq/aleo-wallet-adaptor-react-ui'
import { useTransaction } from './useTransaction'
import { TransactionStatus } from './TransactionStatus'
import {
  PROGRAM_ID, USDCX_ID, ASSETS, MIN_FILL, BOT_API,
  fmtUsdc, fmtAsset, fmtPrice, normalize, randomField,
  getCurrentBlock, fetchFeeVault,
  buildSubmitOrderInputs, buildClaimTestAssetInputs,
  buildDepositAssetInputs, buildWithdrawFeesInputs,
  encryptForOperator, submitOrderToBotApi,
  scanForDepositOutput,
  parseFillReceipt, parseUSDCxToken, parseAssetRecord,
  type USDCxToken, type AssetRecord, type FillReceipt, type DarkpoolTab,
} from './darkpool'

// Operator address — set in .env after deployment
const OPERATOR_ADDRESS = import.meta.env.VITE_OPERATOR_ADDRESS ?? ''
const BATCH_BLOCKS     = parseInt(import.meta.env.VITE_BATCH_BLOCKS ?? '30')

// ── Normalize helper ───────────────────────────────────────────
function norm(pt: string): string { return normalize(pt) }

// ── Stat pill ──────────────────────────────────────────────────
function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-panel px-4 py-3">
      <div className="text-muted text-xs uppercase tracking-widest mb-1">{label}</div>
      <div className={`text-sm font-medium ${accent ? 'text-accent' : 'text-[#c8d8e8]'}`}>{value}</div>
    </div>
  )
}

// ── Record loader button ───────────────────────────────────────
function LoadBtn({ onLoad, loading, label }: { onLoad: () => void; loading: boolean; label: string }) {
  return (
    <button onClick={onLoad} disabled={loading}
      className="w-full text-xs text-muted border border-border rounded-lg px-4 py-2 text-left hover:border-accent hover:text-accent transition-colors disabled:opacity-40">
      {loading ? '⟳ Loading…' : `↓ ${label}`}
    </button>
  )
}

// ── Hook: load USDCx Token records ────────────────────────────
function useUSDCxTokens() {
  const { requestRecords, decrypt } = useWallet() as any
  const [tokens, setTokens]   = useState<USDCxToken[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!requestRecords || !decrypt) return
    setLoading(true)
    try {
      const raw = await requestRecords(USDCX_ID, true) as any[]
      const parsed = await Promise.all(
        raw.filter((r: any) => r.recordName === 'Token' && !r.spent)
           .map(async (r: any) => {
             try { return parseUSDCxToken(await decrypt(r.recordCiphertext)) }
             catch { return null }
           })
      )
      setTokens(
        parsed.filter((t): t is USDCxToken => t !== null)
              .sort((a, b) => (b.amount > a.amount ? 1 : -1))
      )
    } finally { setLoading(false) }
  }, [requestRecords, decrypt])

  return { tokens, loading, load }
}

// ── Hook: load Credentials records ────────────────────────────
function useCredentials() {
  const { requestRecords, decrypt } = useWallet() as any
  const [creds, setCreds]     = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!requestRecords || !decrypt) return
    setLoading(true)
    try {
      const raw = await requestRecords(USDCX_ID, true) as any[]
      const credRecs = raw.filter((r: any) => r.recordName === 'Credentials' && !r.spent)
      const pts = await Promise.all(
        credRecs.map(async (r: any) => {
          try { return await decrypt(r.recordCiphertext) }
          catch { return null }
        })
      )
      setCreds(pts.filter((p): p is string => p !== null))
    } finally { setLoading(false) }
  }, [requestRecords, decrypt])

  return { creds, loading, load }
}

// ── Hook: load AssetRecords ────────────────────────────────────
function useAssetRecords() {
  const { requestRecords, decrypt } = useWallet() as any
  const [records, setRecords] = useState<AssetRecord[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!requestRecords || !decrypt) return
    setLoading(true)
    try {
      const raw = await requestRecords(PROGRAM_ID, true) as any[]
      const parsed = await Promise.all(
        raw.filter((r: any) => r.recordName === 'AssetRecord' && !r.spent)
           .map(async (r: any) => {
             try { return parseAssetRecord(await decrypt(r.recordCiphertext)) }
             catch { return null }
           })
      )
      setRecords(parsed.filter((r): r is AssetRecord => r !== null))
    } finally { setLoading(false) }
  }, [requestRecords, decrypt])

  return { records, loading, load }
}

// ── Hook: load FillReceipts ────────────────────────────────────
function useFillReceipts() {
  const { requestRecords, decrypt } = useWallet() as any
  const [receipts, setReceipts] = useState<FillReceipt[]>([])
  const [loading, setLoading]   = useState(false)

  const load = useCallback(async () => {
    if (!requestRecords || !decrypt) return
    setLoading(true)
    try {
      const raw = await requestRecords(PROGRAM_ID, true) as any[]
      const parsed = await Promise.all(
        raw.filter((r: any) => r.recordName === 'FillReceipt' && !r.spent)
           .map(async (r: any) => {
             try { return parseFillReceipt(await decrypt(r.recordCiphertext)) }
             catch { return null }
           })
      )
      setReceipts(parsed.filter((r): r is FillReceipt => r !== null))
    } finally { setLoading(false) }
  }, [requestRecords, decrypt])

  return { receipts, loading, load }
}

// ── Step indicator ─────────────────────────────────────────────
function Steps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="flex items-center gap-1 text-xs">
      {steps.map((s, i) => (
        <div key={i} className="flex items-center gap-1">
          <div className={`w-5 h-5 rounded-full flex items-center justify-center font-bold text-xs ${
            i < current  ? 'bg-accent text-[#001a14]' :
            i === current? 'bg-accent/20 text-accent border border-accent animate-pulse' :
                           'bg-panel text-muted border border-border'
          }`}>{i < current ? '✓' : i+1}</div>
          <span className={i === current ? 'text-accent' : 'text-muted'}>{s}</span>
          {i < steps.length-1 && <span className="text-border mx-1">→</span>}
        </div>
      ))}
    </div>
  )
}

// ── Order Tab (buy and sell) ───────────────────────────────────
function OrderTab() {
  const wallet = useWallet() as any
  const { connected } = wallet
  const userAddress: string = wallet.address ?? wallet.publicKey ?? ''
  const { tokens,  loading: tokLoading, load: loadTok } = useUSDCxTokens()
  const { creds,   loading: crdLoading, load: loadCrd } = useCredentials()
  const tx = useTransaction()

  const [direction,    setDirection]    = useState<'buy' | 'sell'>('buy')
  const [assetId,      setAssetId]      = useState(0)
  const [size,         setSize]         = useState('')
  const [limitPrice,   setLimitPrice]   = useState('')
  const [selectedTok,  setSelectedTok]  = useState('')
  const [selectedCred, setSelectedCred] = useState('')
  const [sellNonce,    setSellNonce]    = useState('')
  const [pendingDeps,  setPendingDeps]  = useState<{nonce:string;assetId:number;amount:string}[]>([])
  const [loadingDeps,  setLoadingDeps]  = useState(false)

  const isBuy    = direction === 'buy'

  // Auto-load deposits from bot when switching to sell
  useEffect(() => {
    if (isBuy || !userAddress) return
    setLoadingDeps(true)
    const BOT = import.meta.env.VITE_BOT_API ?? 'http://localhost:3001'
    fetch(`${BOT}/deposits?address=${encodeURIComponent(userAddress)}`)
      .then(r => r.json())
      .then(d => {
        const deps = d.deposits ?? []
        setPendingDeps(deps)
        if (deps.length === 1 && !sellNonce) setSellNonce(deps[0].nonce)
      })
      .catch(() => setPendingDeps([]))
      .finally(() => setLoadingDeps(false))
  }, [isBuy, userAddress])
  const sizeNum  = size       ? BigInt(Math.floor(parseFloat(size)       * 1_000_000)) : 0n
  const priceNum = limitPrice ? BigInt(Math.floor(parseFloat(limitPrice) * 1_000_000)) : 0n
  const grossCost = sizeNum > 0n && priceNum > 0n ? sizeNum * priceNum / 1_000_000n : 0n
  const fee       = grossCost > 0n ? (grossCost * 10n) / 10_000n : 0n

  const canSubmit = connected && !!userAddress && sizeNum >= MIN_FILL && priceNum > 0n &&
    (isBuy ? (selectedTok && selectedCred) : !!sellNonce) &&
    tx.status !== 'submitting' && tx.status !== 'pending'

  const submit = async () => {
    if (!canSubmit) return
    const block  = await getCurrentBlock()
    const expiry = block > 0 ? block + 50_000 : 99_999_999
    const nonce  = isBuy ? randomField() : (sellNonce.endsWith('field') ? sellNonce : `${sellNonce}field`)
    const salt   = randomField()
    await tx.execute({
      program:    PROGRAM_ID,
      function:   'submit_order',
      inputs:     buildSubmitOrderInputs({
        recipient:       userAddress,
        operatorAddress: OPERATOR_ADDRESS,
        assetId,
        direction:       isBuy,
        size:            sizeNum,
        limitPrice:      priceNum,
        salt,
        expiry,
        nonce,
      }),
      fee:        3_000_000,
      privateFee: false,
    })
  }

  return (
    <div className="flex flex-col gap-4">

      {/* Direction toggle */}
      <div className="grid grid-cols-2 gap-2">
        {(['buy', 'sell'] as const).map(d => (
          <button key={d} onClick={() => { setDirection(d); tx.reset() }}
            className={`py-2 rounded-lg text-xs font-bold uppercase tracking-widest transition-colors ${
              direction === d
                ? d === 'buy'
                  ? 'bg-accent/10 text-accent border border-accent'
                  : 'bg-red-500/10 text-red-400 border border-red-500'
                : 'bg-panel border border-border text-muted hover:text-[#c8d8e8]'
            }`}>
            {d === 'buy' ? '▲ Buy' : '▼ Sell'}
          </button>
        ))}
      </div>

      {/* Step indicator */}
      {tx.status === 'submitting' && (
        <div className="bg-bg border border-border/50 rounded-lg p-3 text-xs text-muted animate-pulse">
          ⟳ Waiting for Shield approval…
        </div>
      )}

      {/* Asset selector */}
      <div>
        <label className="text-muted text-xs uppercase tracking-widest block mb-1">Asset</label>
        <select value={assetId} onChange={e => setAssetId(parseInt(e.target.value))}
          className="w-full bg-bg border border-border text-[#c8d8e8] text-xs rounded-lg px-3 py-2 font-mono">
          {Object.entries(ASSETS).map(([id, sym]) => (
            <option key={id} value={id}>{sym}</option>
          ))}
        </select>
      </div>

      {/* Size */}
      <div>
        <label className="text-muted text-xs uppercase tracking-widest block mb-1">
          Size ({ASSETS[assetId]})
        </label>
        <div className="flex bg-bg border border-border rounded-lg focus-within:border-accent transition-colors overflow-hidden">
          <input type="number" value={size} onChange={e => setSize(e.target.value)}
            placeholder="0.000000"
            className="flex-1 bg-transparent text-[#c8d8e8] text-xl font-light px-4 py-3 outline-none" />
          <span className="px-4 flex items-center text-muted text-xs font-bold border-l border-border">
            {ASSETS[assetId]}
          </span>
        </div>
      </div>

      {/* Limit price */}
      <div>
        <label className="text-muted text-xs uppercase tracking-widest block mb-1">
          {isBuy ? 'Max price (USDCx)' : 'Min price (USDCx)'}
        </label>
        <div className="flex bg-bg border border-border rounded-lg focus-within:border-accent transition-colors overflow-hidden">
          <input type="number" value={limitPrice} onChange={e => setLimitPrice(e.target.value)}
            placeholder="0.00"
            className="flex-1 bg-transparent text-[#c8d8e8] text-xl font-light px-4 py-3 outline-none" />
          <span className="px-4 flex items-center text-muted text-xs font-bold border-l border-border">USDCx</span>
        </div>
      </div>

      {/* Order summary */}
      {sizeNum > 0n && priceNum > 0n && (
        <div className="bg-bg border border-border rounded-lg p-3 text-xs flex flex-col gap-2">
          {[
            ['Gross cost',         `${fmtUsdc(grossCost)} USDCx`],
            ['Protocol fee (0.10%)', `${fmtUsdc(fee)} USDCx`],
            ['Settlement',         'Automatic when matched'],
            ['Privacy',            'ZK-encrypted on-chain'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <span className="text-muted">{k}</span>
              <span className="text-[#c8d8e8]">{v}</span>
            </div>
          ))}
        </div>
      )}

      {/* Buy side records */}
      {isBuy && (
        <>
          <div>
            <label className="text-muted text-xs uppercase tracking-widest block mb-1">USDCx Token</label>
            {tokens.length === 0
              ? <LoadBtn onLoad={loadTok} loading={tokLoading} label="Load from Shield wallet" />
              : <select value={selectedTok} onChange={e => setSelectedTok(e.target.value)}
                  className="w-full bg-bg border border-border text-[#c8d8e8] text-xs rounded-lg px-3 py-2 font-mono">
                  <option value="">— select token —</option>
                  {tokens.map((t, i) => <option key={i} value={t.plaintext}>{t.label}</option>)}
                </select>
            }
          </div>
          <div>
            <label className="text-muted text-xs uppercase tracking-widest block mb-1">Credentials</label>
            {creds.length === 0
              ? <LoadBtn onLoad={loadCrd} loading={crdLoading} label="Load Credentials from Shield" />
              : <select value={selectedCred} onChange={e => setSelectedCred(e.target.value)}
                  className="w-full bg-bg border border-border text-[#c8d8e8] text-xs rounded-lg px-3 py-2 font-mono">
                  <option value="">— select credentials —</option>
                  {creds.map((c, i) => <option key={i} value={c}>Credentials #{i+1}</option>)}
                </select>
            }
          </div>
        </>
      )}

      {/* Sell side: deposits from bot (v5) */}
      {!isBuy && (
        <>
          <div className="bg-bg border border-border/50 rounded-lg p-3 text-xs text-muted leading-relaxed">
            <span className="text-accent font-bold">Before selling:</span> go to{' '}
            <span className="text-accent">Tools</span> → Claim Test Asset → Deposit Asset.
            Your deposits appear below automatically once the bot scans them.
          </div>
          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-muted text-xs uppercase tracking-widest">Your Deposits</label>
              <button onClick={() => {
                setLoadingDeps(true)
                const BOT = import.meta.env.VITE_BOT_API ?? 'http://localhost:3001'
                fetch(`${BOT}/deposits?address=${encodeURIComponent(userAddress)}`)
                  .then(r => r.json())
                  .then(d => {
                    setPendingDeps(d.deposits ?? [])
                    if ((d.deposits ?? []).length === 1) setSellNonce(d.deposits[0].nonce)
                  })
                  .catch(() => setPendingDeps([]))
                  .finally(() => setLoadingDeps(false))
              }} className="text-xs text-accent hover:text-accent/80 transition-colors">
                {loadingDeps ? '⟳' : '↻ Refresh'}
              </button>
            </div>
            {loadingDeps ? (
              <div className="text-muted text-xs py-2 animate-pulse">Loading…</div>
            ) : pendingDeps.length === 0 ? (
              <div className="text-muted text-xs py-2 border border-border/40 rounded-lg text-center">
                No deposits found — deposit first, then refresh
              </div>
            ) : (
              <select value={sellNonce} onChange={e => setSellNonce(e.target.value)}
                className="w-full bg-bg border border-border text-[#c8d8e8] text-xs rounded-lg px-3 py-2 font-mono">
                <option value="">— select deposit —</option>
                {pendingDeps.map((d: any, i: number) => (
                  <option key={i} value={d.nonce}>
                    {ASSETS[d.assetId] ?? `asset_${d.assetId}`} — {Number(d.amount)/1e6} units — {d.nonce.slice(0,12)}…
                  </option>
                ))}
              </select>
            )}
          </div>
        </>
      )}

      <button onClick={submit} disabled={!canSubmit}
        className={`w-full py-4 rounded-lg text-xs font-bold uppercase tracking-widest transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
          isBuy
            ? 'bg-accent text-[#001a14] hover:bg-accent/90'
            : 'bg-red-500/80 text-white hover:bg-red-500'
        }`}>
        {tx.status === 'submitting' ? '⟳ Submitting…' : isBuy ? '▲ Place Buy Order' : '▼ Place Sell Order'}
      </button>

      <TransactionStatus status={tx.status} tempTxId={tx.tempTxId} onChainTxId={tx.onChainTxId} error={tx.error} onDismiss={tx.reset} />
    </div>
  )
}


// ── Receipts Tab ───────────────────────────────────────────────
function ReceiptsTab() {
  const { connected } = useWallet() as any
  const { receipts, loading, load } = useFillReceipts()

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-between items-center">
        <span className="text-muted text-xs uppercase tracking-widest">Fill receipts</span>
        <button onClick={load} disabled={!connected || loading}
          className="text-xs text-accent hover:text-accent/80 disabled:opacity-40 transition-colors">
          {loading ? '⟳ Loading…' : '↓ Load'}
        </button>
      </div>

      {receipts.length === 0 ? (
        <div className="text-muted text-xs text-center py-8 border border-border/40 rounded-lg">
          {loading ? 'Scanning records…' : 'No fill receipts found. Load from Shield wallet.'}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {receipts.map((r, i) => (
            <div key={i} className="bg-bg border border-border rounded-lg p-3 text-xs flex flex-col gap-2">
              <div className="flex justify-between items-center">
                <span className={`font-bold text-sm ${r.direction ? 'text-accent' : 'text-red-400'}`}>
                  {r.direction ? '▲ BOUGHT' : '▼ SOLD'} {ASSETS[r.assetId] ?? `asset_${r.assetId}`}
                </span>
                <span className="text-muted text-xs font-mono">batch #{r.batchRoot.slice(0, 8)}…</span>
              </div>
              {[
                ['Filled size',    `${fmtAsset(r.filledSize)} ${ASSETS[r.assetId]}`],
                ['Clearing price', `${fmtPrice(r.clearingPrice)} USDCx`],
                ['Notional',       `${fmtUsdc(r.filledSize * r.clearingPrice / 1_000_000n)} USDCx`],
                ['Fee paid',       r.feePaid > 0n ? `${fmtUsdc(r.feePaid)} USDCx` : '—'],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="text-muted">{k}</span>
                  <span className="text-[#c8d8e8]">{v}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Operator Tab ───────────────────────────────────────────────
function OperatorTab() {
  const wallet = useWallet() as any
  const { connected } = wallet
  const userAddress: string = wallet.address ?? wallet.publicKey ?? ''
  const isOperator = connected && !!userAddress && userAddress === OPERATOR_ADDRESS
  const tx = useTransaction()
  const [feeVault,    setFeeVault]    = useState<bigint | null>(null)
  const [claimAmount, setClaimAmount] = useState('')
  const [feeLoading,  setFeeLoading]  = useState(false)
  const [bookStatus,  setBookStatus]  = useState<any>(null)
  const [matching,    setMatching]    = useState(false)
  const [matchResult, setMatchResult] = useState<string>('')

  const loadFeeVault = useCallback(async () => {
    setFeeLoading(true)
    setFeeVault(await fetchFeeVault())
    setFeeLoading(false)
  }, [])

  const loadBotStatus = useCallback(async () => {
    try {
      const res = await fetch(`${BOT_API}/status`)
      if (res.ok) setBookStatus(await res.json())
      else setBookStatus(null)
    } catch { setBookStatus(null) }
  }, [])

  useEffect(() => {
    loadFeeVault()
    loadBotStatus()
    const t = setInterval(loadBotStatus, 30_000)
    return () => clearInterval(t)
  }, [loadFeeVault, loadBotStatus])

  const forceMatch = async () => {
    setMatching(true); setMatchResult('')
    try {
      const res = await fetch(`${BOT_API}/force-match`, { method: 'POST' })
      const data = await res.json()
      setMatchResult(`${data.matches} match(es) found. Check bot terminal for settle commands.`)
      await loadBotStatus()
    } catch (e: any) {
      setMatchResult(`Bot API error: ${e.message}. Is the bot running?`)
    } finally { setMatching(false) }
  }

  const claimFees = async () => {
    if (!isOperator || !claimAmount) return
    const amount = BigInt(Math.floor(parseFloat(claimAmount) * 1_000_000))
    if (amount <= 0n) return
    await tx.execute({
      program:   PROGRAM_ID,
      function:  'withdraw_fees',
      inputs:    buildWithdrawFeesInputs(amount),
      fee:       2_000_000,
      privateFee: false,
    })
    await loadFeeVault()
  }

  return (
    <div className="flex flex-col gap-4">

      {/* Live order book from bot */}
      <div className="bg-bg border border-border rounded-lg p-4 flex flex-col gap-3">
        <div className="flex justify-between items-center">
          <span className="text-muted text-xs uppercase tracking-widest">Live order book</span>
          <button onClick={loadBotStatus} className="text-xs text-accent hover:text-accent/80">↻</button>
        </div>
        {bookStatus ? (
          <>
            <div className="text-xs text-muted">Block #{bookStatus.block}</div>
            {Object.entries(bookStatus.book ?? {}).map(([id, counts]: any) => (
              <div key={id} className="flex justify-between text-xs">
                <span className="text-[#c8d8e8]">BTC</span>
                <span className="text-accent">{counts.buys} buys</span>
                <span className="text-red-400">{counts.sells} sells</span>
              </div>
            ))}
            {Object.keys(bookStatus.book ?? {}).length === 0 && (
              <div className="text-muted text-xs">Order book empty</div>
            )}
          </>
        ) : (
          <div className="text-muted text-xs">Bot offline — start darkpool-bot first</div>
        )}
      </div>

      {/* Force match button */}
      <button onClick={forceMatch} disabled={matching || !bookStatus}
        className="w-full py-3 rounded-lg text-xs font-bold uppercase tracking-widest bg-accent/10 text-accent border border-accent hover:bg-accent/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
        {matching ? '⟳ Matching…' : '⚡ Force Settle Now'}
      </button>
      {matchResult && (
        <div className="text-xs text-muted border border-border/50 rounded-lg p-3">{matchResult}</div>
      )}


      <div className="bg-bg border border-border rounded-lg p-4 flex flex-col gap-3">
        <div className="flex justify-between items-center">
          <span className="text-muted text-xs uppercase tracking-widest">Protocol fee vault</span>
          <button onClick={loadFeeVault} disabled={feeLoading}
            className="text-xs text-accent hover:text-accent/80 disabled:opacity-40">
            {feeLoading ? '⟳' : '↻ Refresh'}
          </button>
        </div>
        <div className="text-2xl font-light text-accent">
          {feeVault !== null ? `${fmtUsdc(feeVault)} USDCx` : '—'}
        </div>
        <p className="text-muted text-xs leading-relaxed">
          Accumulated protocol fees (0.10% on all settlements).
          Clicking "Claim" updates the on-chain accounting record.
          Real USDCx accrues in buyer change records — reconcile off-chain.
        </p>
      </div>

      {!isOperator && connected && (
        <div className="text-xs text-red-400 border border-red-500/30 rounded-lg p-3">
          Connected wallet is not the operator address. Only the operator can claim fees.
        </div>
      )}

      {!connected && (
        <div className="text-xs text-muted border border-border/50 rounded-lg p-3">
          Connect your operator Shield wallet to claim fees.
        </div>
      )}

      {isOperator && (
        <>
          <div>
            <label className="text-muted text-xs uppercase tracking-widest block mb-1">
              Amount to claim (USDCx)
            </label>
            <div className="flex bg-bg border border-border rounded-lg focus-within:border-accent transition-colors overflow-hidden">
              <input type="number" value={claimAmount} onChange={e => setClaimAmount(e.target.value)}
                placeholder="0.00"
                className="flex-1 bg-transparent text-[#c8d8e8] text-xl font-light px-4 py-3 outline-none" />
              <button onClick={() => feeVault !== null && setClaimAmount(fmtUsdc(feeVault))}
                className="px-4 text-xs text-accent border-l border-border hover:bg-accent/5 transition-colors">
                MAX
              </button>
            </div>
          </div>

          <button onClick={claimFees}
            disabled={!claimAmount || parseFloat(claimAmount) <= 0 || tx.status === 'submitting' || tx.status === 'pending'}
            className="w-full py-4 rounded-lg text-xs font-bold uppercase tracking-widest bg-accent text-[#001a14] hover:bg-accent/90 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
            {tx.status === 'submitting' ? '⟳ Submitting…' : tx.status === 'pending' ? '⟳ Confirming…' : '↓ Claim Fees'}
          </button>

          <TransactionStatus status={tx.status} tempTxId={tx.tempTxId} onChainTxId={tx.onChainTxId} error={tx.error} onDismiss={tx.reset} />
        </>
      )}

      {/* Operator info */}
      <div className="bg-bg border border-border/40 rounded-lg p-3 text-xs flex flex-col gap-1">
        <div className="flex justify-between">
          <span className="text-muted">Operator address</span>
          <span className="text-[#c8d8e8] font-mono text-xs truncate max-w-[160px]">
            {OPERATOR_ADDRESS ? `${OPERATOR_ADDRESS.slice(0, 12)}…` : 'not configured'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">Fee rate</span>
          <span className="text-[#c8d8e8]">0.10% (buyer only)</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">Batch window</span>
          <span className="text-[#c8d8e8]">~{BATCH_BLOCKS} blocks</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">Settlement</span>
          <span className="text-[#c8d8e8]">Uniform clearing price</span>
        </div>
      </div>
    </div>
  )
}

// ── Tools Tab — Mint + Deposit ─────────────────────────────────
function ToolsTab() {
  const wallet = useWallet() as any
  const { connected } = wallet
  const { records, loading: recLoading, load: loadRec } = useAssetRecords()
  const mintTx = useTransaction()
  const depTx  = useTransaction()
  const credTx = useTransaction()

  const [mintAssetId, setMintAssetId] = useState(0)
  const [depAmount,   setDepAmount]   = useState('')
  const [depNonce,    setDepNonce]    = useState('')
  const [depSelected, setDepSelected] = useState('')

  const claimAsset = async () => {
    if (!connected) return
    await mintTx.execute({
      program:    PROGRAM_ID,
      function:   'claim_test_asset',
      inputs:     [`${mintAssetId}u8`],
      fee:        3_000_000,
      privateFee: false,
    })
  }

  const depositAsset = async () => {
    if (!connected || !depSelected || !depAmount || !depNonce) return
    const amountNum = BigInt(Math.floor(parseFloat(depAmount) * 1_000_000))
    await depTx.execute({
      program:    PROGRAM_ID,
      function:   'deposit_asset',
      inputs:     buildDepositAssetInputs({
        assetRecord:     norm(depSelected),
        amount:          amountNum,
        orderNonce:      depNonce,
        operatorAddress: OPERATOR_ADDRESS,
      }),
      fee:        3_000_000,
      privateFee: false,
    })
  }

  return (
    <div className="flex flex-col gap-6">

      {/* ── Claim test asset ── */}
      <div className="flex flex-col gap-3">
        <div className="text-muted text-xs uppercase tracking-widest border-b border-border pb-2">
          Claim Test Asset <span className="text-accent ml-2">10 units free · once per asset</span>
        </div>
        <div>
          <label className="text-muted text-xs uppercase tracking-widest block mb-1">Asset</label>
          <select value={mintAssetId} onChange={e => setMintAssetId(parseInt(e.target.value))}
            className="w-full bg-bg border border-border text-[#c8d8e8] text-xs rounded-lg px-3 py-2 font-mono">
            {Object.entries(ASSETS).map(([id, sym]) => (
              <option key={id} value={id}>{sym}</option>
            ))}
          </select>
        </div>
        <button onClick={claimAsset} disabled={!connected || mintTx.status === 'submitting' || mintTx.status === 'pending'}
          className="w-full py-3 rounded-lg text-xs font-bold uppercase tracking-widest bg-accent/10 text-accent border border-accent hover:bg-accent/20 transition-all disabled:opacity-40">
          {mintTx.status === 'submitting' ? '⟳ Claiming…' : mintTx.status === 'pending' ? '⟳ Confirming…' : `⚡ Claim 10 ${ASSETS[mintAssetId]}`}
        </button>
        <TransactionStatus status={mintTx.status} tempTxId={mintTx.tempTxId} onChainTxId={mintTx.onChainTxId} error={mintTx.error} onDismiss={mintTx.reset} />
      </div>

      {/* ── Deposit asset ── */}
      <div className="flex flex-col gap-3">
        <div className="text-muted text-xs uppercase tracking-widest border-b border-border pb-2">
          Deposit Asset <span className="text-muted ml-2">escrow for sell order</span>
        </div>

        <div>
          <label className="text-muted text-xs uppercase tracking-widest block mb-1">Your Asset Records</label>
          {records.length === 0
            ? <LoadBtn onLoad={loadRec} loading={recLoading} label="Load from Shield wallet" />
            : <select value={depSelected} onChange={e => setDepSelected(e.target.value)}
                className="w-full bg-bg border border-border text-[#c8d8e8] text-xs rounded-lg px-3 py-2 font-mono">
                <option value="">— select record —</option>
                {records.filter(r => r.amount > 0n).map((r, i) => (
                  <option key={i} value={r.plaintext}>{r.label}</option>
                ))}
              </select>
          }
        </div>

        <div>
          <label className="text-muted text-xs uppercase tracking-widest block mb-1">Amount to escrow</label>
          <div className="flex bg-bg border border-border rounded-lg focus-within:border-accent overflow-hidden">
            <input type="number" value={depAmount} onChange={e => setDepAmount(e.target.value)}
              placeholder="1.000000"
              className="flex-1 bg-transparent text-[#c8d8e8] text-lg font-light px-4 py-2 outline-none" />
            <span className="px-3 flex items-center text-muted text-xs border-l border-border">units</span>
          </div>
        </div>

        <div>
          <label className="text-muted text-xs uppercase tracking-widest block mb-1">
            Order nonce <span className="text-muted normal-case">(auto-linked to sell order via bot)</span>
          </label>
          <div className="flex gap-2">
            <input type="text" value={depNonce} onChange={e => setDepNonce(e.target.value)}
              placeholder="click Generate →"
              className="flex-1 bg-bg border border-border text-[#c8d8e8] text-xs rounded-lg px-3 py-2 font-mono outline-none focus:border-accent" />
            <button onClick={() => setDepNonce(randomField())}
              className="px-3 py-2 text-xs text-accent border border-accent rounded-lg hover:bg-accent/10 transition-colors whitespace-nowrap">
              Generate
            </button>
          </div>
        </div>

        <button onClick={depositAsset}
          disabled={!connected || !depSelected || !depAmount || !depNonce || depTx.status === 'submitting' || depTx.status === 'pending'}
          className="w-full py-3 rounded-lg text-xs font-bold uppercase tracking-widest bg-accent/10 text-accent border border-accent hover:bg-accent/20 transition-all disabled:opacity-40">
          {depTx.status === 'submitting' ? '⟳ Depositing…' : depTx.status === 'pending' ? '⟳ Confirming…' : '↓ Deposit Asset'}
        </button>
        <TransactionStatus status={depTx.status} tempTxId={depTx.tempTxId} onChainTxId={depTx.onChainTxId} error={depTx.error} onDismiss={depTx.reset} />
      </div>

      {/* ── Get fresh credentials ── */}
      <div className="flex flex-col gap-3">
        <div className="text-muted text-xs uppercase tracking-widest border-b border-border pb-2">
          USDCx Credentials <span className="text-muted ml-2">refresh for settlement</span>
        </div>
        <p className="text-xs text-muted leading-relaxed">
          Credentials must match the current on-chain freeze list root.
          If settlement fails, refresh here.
        </p>
        <button onClick={() => credTx.execute({
          program:    'test_usdcx_stablecoin.aleo',
          function:   'get_credentials',
          inputs:     [],
          fee:        3_000_000,
          privateFee: false,
        })} disabled={!connected || credTx.status === 'submitting' || credTx.status === 'pending'}
          className="w-full py-3 rounded-lg text-xs font-bold uppercase tracking-widest bg-accent/10 text-accent border border-accent hover:bg-accent/20 transition-all disabled:opacity-40">
          {credTx.status === 'submitting' ? '⟳ Submitting…' : credTx.status === 'pending' ? '⟳ Confirming…' : '🔑 Get Fresh Credentials'}
        </button>
        <TransactionStatus status={credTx.status} tempTxId={credTx.tempTxId} onChainTxId={credTx.onChainTxId} error={credTx.error} onDismiss={credTx.reset} />
      </div>

    </div>
  )
}

// ── App ────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState<DarkpoolTab>('order')
  const [blockHeight, setBlockHeight] = useState<number | null>(null)

  useEffect(() => {
    const poll = async () => setBlockHeight(await getCurrentBlock())
    poll()
    const t = setInterval(poll, 15_000)
    return () => clearInterval(t)
  }, [])

  const TABS: { id: DarkpoolTab; label: string }[] = [
    { id: 'order',    label: 'Order'    },
    { id: 'receipts', label: 'Receipts' },
    { id: 'tools',    label: 'Tools'    },
    { id: 'operator', label: 'Operator' },
  ]

  return (
    <div className="min-h-screen bg-bg flex flex-col items-center py-10 px-4 font-mono">

      {/* Header */}
      <div className="w-full max-w-md flex justify-between items-center mb-8">
        <div>
          <div className="text-accent text-sm font-bold tracking-widest uppercase">ZK Darkpool</div>
          <div className="text-muted text-xs">{PROGRAM_ID} · testnet</div>
        </div>
        <WalletMultiButton />
      </div>

      {/* Stats bar */}
      <div className="w-full max-w-md grid grid-cols-3 gap-px bg-border rounded-xl overflow-hidden mb-5">
        <Stat label="Block"    value={blockHeight !== null ? `#${blockHeight.toLocaleString()}` : '—'} />
        <Stat label="Batch"    value={`~${BATCH_BLOCKS} blocks`} accent />
        <Stat label="Fee"      value="0.10%" />
      </div>

      {/* Card */}
      <div className="w-full max-w-md bg-panel border border-border rounded-xl overflow-hidden">

        {/* Tabs */}
        <div className="grid grid-cols-4 border-b border-border">
          {TABS.map(({ id, label }) => (
            <button key={id} onClick={() => setTab(id)}
              className={`py-3 text-xs font-bold uppercase tracking-widest transition-colors ${
                tab === id
                  ? 'text-accent border-b-2 border-accent bg-accent/5'
                  : 'text-muted hover:text-[#c8d8e8]'
              }`}>
              {label}
            </button>
          ))}
        </div>

        <div className="p-5">
          {tab === 'order'    && <OrderTab    />}
          {tab === 'receipts' && <ReceiptsTab />}
          {tab === 'tools'    && <ToolsTab    />}
          {tab === 'operator' && <OperatorTab />}
        </div>
      </div>

      {/* Privacy model note */}
      <div className="w-full max-w-md mt-5 text-xs text-muted border border-border/30 rounded-xl p-4 leading-relaxed">
        <span className="text-accent font-bold">Privacy model:</span> order contents are ZK-encrypted on Aleo.
        Settlement amounts leak as finalize arguments — expiry and fee are visible on-chain.
        Counterparty identity is never revealed. Operator sees direction and asset but not size or price.
      </div>
    </div>
  )
}
