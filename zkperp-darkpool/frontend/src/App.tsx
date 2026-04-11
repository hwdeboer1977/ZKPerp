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

const OPERATOR_ADDRESS = import.meta.env.VITE_OPERATOR_ADDRESS ?? ''
const BATCH_BLOCKS     = parseInt(import.meta.env.VITE_BATCH_BLOCKS ?? '30')

function norm(pt: string): string { return normalize(pt) }

// ── Background decor (matches ZKPerp Core) ────────────────────
function BackgroundDecor() {
  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden z-0">
      <div className="absolute left-0 top-0 h-full w-1/3" style={{ backgroundImage: 'url(/zkperp-banner.png)', backgroundSize: '280% auto', backgroundPosition: 'left center', maskImage: 'linear-gradient(to right, rgba(0,0,0,0.18) 0%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to right, rgba(0,0,0,0.18) 0%, transparent 100%)' }} />
      <div className="absolute right-0 top-0 h-full w-1/3" style={{ backgroundImage: 'url(/zkperp-banner.png)', backgroundSize: '280% auto', backgroundPosition: 'right center', maskImage: 'linear-gradient(to left, rgba(0,0,0,0.18) 0%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to left, rgba(0,0,0,0.18) 0%, transparent 100%)' }} />
      <div className="absolute left-[8%] top-[10%] h-72 w-72 rounded-full bg-cyan-400/10 blur-3xl" />
      <div className="absolute right-[10%] top-[18%] h-80 w-80 rounded-full bg-violet-500/10 blur-3xl" />
      <div className="absolute bottom-[8%] left-[24%] h-72 w-72 rounded-full bg-cyan-500/8 blur-3xl" />
      <div className="absolute inset-0 opacity-[0.04] [background-image:linear-gradient(to_right,white_1px,transparent_1px),linear-gradient(to_bottom,white_1px,transparent_1px)] [background-size:80px_80px]" />
      <div className="absolute left-[6%] top-[20%] text-7xl text-white/5 select-none">🔒</div>
      <div className="absolute right-[12%] top-[38%] text-6xl text-white/5 select-none">🔒</div>
      <div className="absolute bottom-[12%] left-[14%] text-8xl text-white/5 select-none">🔒</div>
    </div>
  )
}

// ── Header ────────────────────────────────────────────────────
function Header() {
  return (
    <header className="border-b border-cyan-400/10 bg-white/[0.02] backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-cyan-400 to-violet-500 flex items-center justify-center font-bold text-slate-950 shadow-[0_0_24px_rgba(34,211,238,0.4)]">Z</div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-white">ZKPerp</h1>
              <p className="text-xs text-slate-400">Privacy-First Perpetuals</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-cyan-400/15 bg-cyan-400/5">
              <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
              <span className="text-xs text-slate-300">Testnet</span>
            </div>
            <div className="hidden sm:flex items-center gap-1">
              <a href="https://github.com/hwdeboer1977/ZKPerp" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-slate-400 hover:text-white border border-transparent hover:border-slate-600 transition-all">
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58v-2.03c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 013.01-.4c1.02 0 2.05.13 3.01.4 2.28-1.55 3.29-1.23 3.29-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58C20.57 21.8 24 17.3 24 12c0-6.63-5.37-12-12-12z"/></svg>
                GitHub
              </a>
              <a href="https://hwdeboer1977.github.io/ZKPerp/zkperp-whitepaper-v4.html" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-slate-400 hover:text-white border border-transparent hover:border-slate-600 transition-all">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                Whitepaper
              </a>
              <a href="https://github.com/hwdeboer1977/ZKPerp/blob/main/README.md" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-slate-400 hover:text-white border border-transparent hover:border-slate-600 transition-all">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
                Docs
              </a>
            </div>
            <WalletMultiButton />
          </div>
        </div>
      </div>
    </header>
  )
}

// ── Navigation (Darkpool active) ──────────────────────────────
function Navigation() {
  const ext    = 'px-5 py-4 text-sm font-medium transition-all border-b-2 text-slate-400 border-transparent hover:text-white hover:border-slate-600'
  const active = 'px-5 py-4 text-sm font-medium transition-all border-b-2 text-cyan-300 border-cyan-400'
  return (
    <nav className="border-b border-cyan-400/10 bg-white/[0.02] backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex gap-1">
          <a href="https://zk-perp.vercel.app/trade/btc"    target="_blank" rel="noopener noreferrer" className={ext}><span className="mr-1.5">📈</span>Trade</a>
          <a href="https://zk-perp.vercel.app/liquidity/btc" target="_blank" rel="noopener noreferrer" className={ext}><span className="mr-1.5">💧</span>Liquidity</a>
          <a href="https://zk-perp-amm.vercel.app/"          target="_blank" rel="noopener noreferrer" className={ext}><span className="mr-1.5">🔄</span>AMM</a>
          <span className={active}><span className="mr-1.5">🌑</span>ZK Darkpool</span>
          <a href="https://zk-perp.vercel.app/status"      target="_blank" rel="noopener noreferrer" className={ext}><span className="mr-1.5">📡</span>System Status</a>
          <a href="https://zk-perp.vercel.app/portfolio"   target="_blank" rel="noopener noreferrer" className={ext}><span className="mr-1.5">📊</span>Portfolio</a>
          <a href="https://zk-perp.vercel.app/compliance"  target="_blank" rel="noopener noreferrer" className={ext}><span className="mr-1.5">🛡️</span>Compliance</a>
        </div>
      </div>
    </nav>
  )
}

// ── Shared UI helpers ─────────────────────────────────────────
function LoadBtn({ onLoad, loading, label }: { onLoad: () => void; loading: boolean; label: string }) {
  return (
    <button onClick={onLoad} disabled={loading}
      className="w-full text-xs text-slate-500 border border-cyan-400/15 rounded-xl px-4 py-2 text-left hover:border-cyan-400/40 hover:text-cyan-300 transition-all disabled:opacity-40">
      {loading ? '⟳ Loading…' : `↓ ${label}`}
    </button>
  )
}

function InputRow({ label, value, onChange, token, readOnly, placeholder }: { label: string; value: string; onChange?: (v: string) => void; token: string; readOnly?: boolean; placeholder?: string }) {
  return (
    <div>
      <label className="text-slate-500 text-xs uppercase tracking-widest block mb-1">{label}</label>
      <div className="flex bg-black/30 border border-cyan-400/15 rounded-xl focus-within:border-cyan-400/50 transition-colors overflow-hidden">
        <input type="number" value={value} onChange={e => onChange?.(e.target.value)} readOnly={readOnly}
          placeholder={placeholder ?? '0.00'}
          className="flex-1 bg-transparent text-white text-xl font-light px-4 py-3 outline-none" />
        <span className="px-4 flex items-center text-slate-500 text-xs font-bold border-l border-cyan-400/10">{token}</span>
      </div>
    </div>
  )
}

// ── Hooks ─────────────────────────────────────────────────────
function useUSDCxTokens() {
  const { requestRecords, decrypt } = useWallet() as any
  const [tokens, setTokens]   = useState<USDCxToken[]>([])
  const [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    if (!requestRecords || !decrypt) return
    setLoading(true)
    try {
      const raw = await requestRecords(USDCX_ID, true) as any[]
      const parsed = await Promise.all(raw.filter((r: any) => r.recordName === 'Token' && !r.spent).map(async (r: any) => {
        try { return parseUSDCxToken(await decrypt(r.recordCiphertext)) } catch { return null }
      }))
      setTokens(parsed.filter((t): t is USDCxToken => t !== null).sort((a, b) => (b.amount > a.amount ? 1 : -1)))
    } finally { setLoading(false) }
  }, [requestRecords, decrypt])
  return { tokens, loading, load }
}

function useCredentials() {
  const { requestRecords, decrypt } = useWallet() as any
  const [creds, setCreds]     = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    if (!requestRecords || !decrypt) return
    setLoading(true)
    try {
      const raw = await requestRecords(USDCX_ID, true) as any[]
      const pts = await Promise.all(raw.filter((r: any) => r.recordName === 'Credentials' && !r.spent).map(async (r: any) => {
        try { return await decrypt(r.recordCiphertext) } catch { return null }
      }))
      setCreds(pts.filter((p): p is string => p !== null))
    } finally { setLoading(false) }
  }, [requestRecords, decrypt])
  return { creds, loading, load }
}

function useAssetRecords() {
  const { requestRecords, decrypt } = useWallet() as any
  const [records, setRecords] = useState<AssetRecord[]>([])
  const [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    if (!requestRecords || !decrypt) return
    setLoading(true)
    try {
      const raw = await requestRecords(PROGRAM_ID, true) as any[]
      const parsed = await Promise.all(raw.filter((r: any) => r.recordName === 'AssetRecord' && !r.spent).map(async (r: any) => {
        try { return parseAssetRecord(await decrypt(r.recordCiphertext)) } catch { return null }
      }))
      setRecords(parsed.filter((r): r is AssetRecord => r !== null))
    } finally { setLoading(false) }
  }, [requestRecords, decrypt])
  return { records, loading, load }
}

function useFillReceipts() {
  const { requestRecords, decrypt } = useWallet() as any
  const [receipts, setReceipts] = useState<FillReceipt[]>([])
  const [loading, setLoading]   = useState(false)
  const load = useCallback(async () => {
    if (!requestRecords || !decrypt) return
    setLoading(true)
    try {
      const raw = await requestRecords(PROGRAM_ID, true) as any[]
      const parsed = await Promise.all(raw.filter((r: any) => r.recordName === 'FillReceipt' && !r.spent).map(async (r: any) => {
        try { return parseFillReceipt(await decrypt(r.recordCiphertext)) } catch { return null }
      }))
      setReceipts(parsed.filter((r): r is FillReceipt => r !== null))
    } finally { setLoading(false) }
  }, [requestRecords, decrypt])
  return { receipts, loading, load }
}

// ── Order Tab ─────────────────────────────────────────────────
function OrderTab() {
  const wallet = useWallet() as any
  const { connected } = wallet
  const userAddress: string = wallet.address ?? wallet.publicKey ?? ''
  const { tokens, loading: tokLoading, load: loadTok } = useUSDCxTokens()
  const { creds,  loading: crdLoading, load: loadCrd } = useCredentials()
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
  const isBuy = direction === 'buy'

  useEffect(() => {
    if (isBuy || !userAddress) return
    setLoadingDeps(true)
    const BOT = import.meta.env.VITE_BOT_API ?? 'http://localhost:3001'
    fetch(`${BOT}/deposits?address=${encodeURIComponent(userAddress)}`)
      .then(r => r.json()).then(d => { const deps = d.deposits ?? []; setPendingDeps(deps); if (deps.length > 0) setSellNonce(deps[deps.length-1].nonce) })
      .catch(() => setPendingDeps([])).finally(() => setLoadingDeps(false))
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
    await tx.execute({ program: PROGRAM_ID, function: 'submit_order', inputs: buildSubmitOrderInputs({ recipient: userAddress, operatorAddress: OPERATOR_ADDRESS, assetId, direction: isBuy, size: sizeNum, limitPrice: priceNum, salt, expiry, nonce }), fee: 3_000_000, privateFee: false })
  }

  const selectClass = "w-full bg-black/30 border border-cyan-400/15 text-white text-xs rounded-xl px-3 py-2 font-mono"

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2">
        {(['buy', 'sell'] as const).map(d => (
          <button key={d} onClick={() => { setDirection(d); tx.reset() }}
            className={`py-2 rounded-xl text-xs font-bold uppercase tracking-widest transition-all ${direction===d ? (d==='buy' ? 'bg-cyan-400/10 text-cyan-300 border border-cyan-400/50' : 'bg-red-400/10 text-red-400 border border-red-400/50') : 'bg-white/[0.03] border border-cyan-400/10 text-slate-400 hover:text-white'}`}>
            {d === 'buy' ? '▲ Buy' : '▼ Sell'}
          </button>
        ))}
      </div>

      {tx.status === 'submitting' && <div className="bg-white/[0.03] border border-cyan-400/10 rounded-xl p-3 text-xs text-slate-400 animate-pulse">⟳ Waiting for Shield approval…</div>}

      <div>
        <label className="text-slate-500 text-xs uppercase tracking-widest block mb-1">Asset</label>
        <select value={assetId} onChange={e => setAssetId(parseInt(e.target.value))} className={selectClass}>
          {Object.entries(ASSETS).map(([id, sym]) => <option key={id} value={id}>{sym}</option>)}
        </select>
      </div>

      <InputRow label={`Size (${ASSETS[assetId]})`} value={size} onChange={setSize} token={ASSETS[assetId]} placeholder="0.000000" />
      <InputRow label={isBuy ? 'Max price (USDCx)' : 'Min price (USDCx)'} value={limitPrice} onChange={setLimitPrice} token="USDCx" />

      {sizeNum > 0n && priceNum > 0n && (
        <div className="bg-white/[0.03] border border-cyan-400/10 rounded-xl p-3 text-xs flex flex-col gap-2">
          {[['Gross cost', `${fmtUsdc(grossCost)} USDCx`], ['Protocol fee (0.10%)', `${fmtUsdc(fee)} USDCx`], ['Settlement', 'Automatic when matched'], ['Privacy', 'ZK-encrypted on-chain']].map(([k,v]) => (
            <div key={k} className="flex justify-between"><span className="text-slate-500">{k}</span><span className="text-white">{v}</span></div>
          ))}
        </div>
      )}

      {isBuy && (
        <>
          <div>
            <label className="text-slate-500 text-xs uppercase tracking-widest block mb-1">USDCx Token</label>
            {tokens.length === 0 ? <LoadBtn onLoad={loadTok} loading={tokLoading} label="Load from Shield wallet" />
              : <select value={selectedTok} onChange={e => setSelectedTok(e.target.value)} className={selectClass}><option value="">— select token —</option>{tokens.map((t,i) => <option key={i} value={t.plaintext}>{t.label}</option>)}</select>}
          </div>
          <div>
            <label className="text-slate-500 text-xs uppercase tracking-widest block mb-1">Credentials</label>
            {creds.length === 0 ? <LoadBtn onLoad={loadCrd} loading={crdLoading} label="Load Credentials from Shield" />
              : <select value={selectedCred} onChange={e => setSelectedCred(e.target.value)} className={selectClass}><option value="">— select credentials —</option>{creds.map((c,i) => <option key={i} value={c}>Credentials #{i+1}</option>)}</select>}
          </div>
        </>
      )}

      {!isBuy && (
        <>
          <div className="bg-white/[0.03] border border-cyan-400/10 rounded-xl p-3 text-xs text-slate-400 leading-relaxed">
            <span className="text-cyan-300 font-bold">Before selling:</span> go to <span className="text-cyan-300">Tools</span> → Claim Test Asset → Deposit Asset. Your deposits appear below automatically once the bot scans them.
          </div>
          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-slate-500 text-xs uppercase tracking-widest">Your Deposits</label>
              <button onClick={() => {
                setLoadingDeps(true)
                const BOT = import.meta.env.VITE_BOT_API ?? 'http://localhost:3001'
                fetch(`${BOT}/deposits?address=${encodeURIComponent(userAddress)}`).then(r => r.json()).then(d => { setPendingDeps(d.deposits ?? []); const deps2 = d.deposits ?? []; if (deps2.length > 0) setSellNonce(deps2[deps2.length-1].nonce) }).catch(() => setPendingDeps([])).finally(() => setLoadingDeps(false))
              }} className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors">{loadingDeps ? '⟳' : '↻ Refresh'}</button>
            </div>
            {loadingDeps ? <div className="text-slate-500 text-xs py-2 animate-pulse">Loading…</div>
              : pendingDeps.length === 0 ? <div className="text-slate-500 text-xs py-2 border border-cyan-400/10 rounded-xl text-center">No deposits found — deposit first, then refresh</div>
              : <select value={sellNonce} onChange={e => setSellNonce(e.target.value)} className={selectClass}><option value="">— select deposit —</option>{pendingDeps.map((d: any, i: number) => <option key={i} value={d.nonce}>{ASSETS[d.assetId] ?? `asset_${d.assetId}`} — {Number(d.amount)/1e6} units — {d.nonce.slice(0,12)}…</option>)}</select>}
          </div>
        </>
      )}

      <button onClick={submit} disabled={!canSubmit}
        className={`w-full py-4 rounded-xl text-xs font-bold uppercase tracking-widest transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-lg ${isBuy ? 'bg-gradient-to-r from-cyan-400 to-cyan-500 text-slate-950 hover:from-cyan-300' : 'bg-gradient-to-r from-red-500 to-red-600 text-white hover:from-red-400'}`}>
        {tx.status === 'submitting' ? '⟳ Submitting…' : isBuy ? '▲ Place Buy Order' : '▼ Place Sell Order'}
      </button>
      <TransactionStatus status={tx.status} tempTxId={tx.tempTxId} onChainTxId={tx.onChainTxId} error={tx.error} onDismiss={tx.reset} />
    </div>
  )
}

// ── Receipts Tab ──────────────────────────────────────────────
function ReceiptsTab() {
  const { connected } = useWallet() as any
  const { receipts, loading, load } = useFillReceipts()
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-between items-center">
        <span className="text-slate-500 text-xs uppercase tracking-widest">Fill receipts</span>
        <button onClick={load} disabled={!connected || loading} className="text-xs text-cyan-400 hover:text-cyan-300 disabled:opacity-40 transition-colors">{loading ? '⟳ Loading…' : '↓ Load'}</button>
      </div>
      {receipts.length === 0
        ? <div className="text-slate-500 text-xs text-center py-8 border border-cyan-400/10 rounded-xl">{loading ? 'Scanning records…' : 'No fill receipts found. Load from Shield wallet.'}</div>
        : <div className="flex flex-col gap-3">
            {receipts.map((r, i) => (
              <div key={i} className="bg-white/[0.03] border border-cyan-400/10 rounded-xl p-3 text-xs flex flex-col gap-2">
                <div className="flex justify-between items-center">
                  <span className={`font-bold text-sm ${r.direction ? 'text-cyan-300' : 'text-red-400'}`}>{r.direction ? '▲ BOUGHT' : '▼ SOLD'} {ASSETS[r.assetId] ?? `asset_${r.assetId}`}</span>
                  <span className="text-slate-500 text-xs font-mono">batch #{r.batchRoot.slice(0,8)}…</span>
                </div>
                {[['Filled size', `${fmtAsset(r.filledSize)} ${ASSETS[r.assetId]}`], ['Clearing price', `${fmtPrice(r.clearingPrice)} USDCx`], ['Notional', `${fmtUsdc(r.filledSize * r.clearingPrice / 1_000_000n)} USDCx`], ['Fee paid', r.feePaid > 0n ? `${fmtUsdc(r.feePaid)} USDCx` : '—']].map(([k,v]) => (
                  <div key={k} className="flex justify-between"><span className="text-slate-500">{k}</span><span className="text-white">{v}</span></div>
                ))}
              </div>
            ))}
          </div>
      }
    </div>
  )
}

// ── Operator Tab ──────────────────────────────────────────────
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
  const [matchResult, setMatchResult] = useState('')

  const loadFeeVault  = useCallback(async () => { setFeeLoading(true); setFeeVault(await fetchFeeVault()); setFeeLoading(false) }, [])
  const loadBotStatus = useCallback(async () => { try { const res = await fetch(`${BOT_API}/status`); if (res.ok) setBookStatus(await res.json()); else setBookStatus(null) } catch { setBookStatus(null) } }, [])

  useEffect(() => { loadFeeVault(); loadBotStatus(); const t = setInterval(loadBotStatus, 30_000); return () => clearInterval(t) }, [loadFeeVault, loadBotStatus])

  const forceMatch = async () => {
    setMatching(true); setMatchResult('')
    try { const res = await fetch(`${BOT_API}/force-match`, { method: 'POST' }); const data = await res.json(); setMatchResult(`${data.matches} match(es) found.`); await loadBotStatus() }
    catch (e: any) { setMatchResult(`Bot API error: ${e.message}`) }
    finally { setMatching(false) }
  }

  const claimFees = async () => {
    if (!isOperator || !claimAmount) return
    const amount = BigInt(Math.floor(parseFloat(claimAmount) * 1_000_000))
    if (amount <= 0n) return
    await tx.execute({ program: PROGRAM_ID, function: 'withdraw_fees', inputs: buildWithdrawFeesInputs(amount), fee: 2_000_000, privateFee: false })
    await loadFeeVault()
  }

  const panelClass = "bg-white/[0.03] border border-cyan-400/10 rounded-xl p-4 flex flex-col gap-3"

  return (
    <div className="flex flex-col gap-4">
      <div className={panelClass}>
        <div className="flex justify-between items-center">
          <span className="text-slate-500 text-xs uppercase tracking-widest">Live order book</span>
          <button onClick={loadBotStatus} className="text-xs text-cyan-400 hover:text-cyan-300">↻</button>
        </div>
        {bookStatus
          ? <><div className="text-xs text-slate-500">Block #{bookStatus.block}</div>{Object.entries(bookStatus.book ?? {}).map(([id, counts]: any) => <div key={id} className="flex justify-between text-xs"><span className="text-white">BTC</span><span className="text-cyan-300">{counts.buys} buys</span><span className="text-red-400">{counts.sells} sells</span></div>)}{Object.keys(bookStatus.book ?? {}).length === 0 && <div className="text-slate-500 text-xs">Order book empty</div>}</>
          : <div className="text-slate-500 text-xs">Bot offline — start darkpool-bot first</div>}
      </div>

      <button onClick={forceMatch} disabled={matching || !bookStatus}
        className="w-full py-3 rounded-xl text-xs font-bold uppercase tracking-widest bg-cyan-400/10 text-cyan-300 border border-cyan-400/40 hover:bg-cyan-400/20 transition-all disabled:opacity-40">
        {matching ? '⟳ Matching…' : '⚡ Force Settle Now'}
      </button>
      {matchResult && <div className="text-xs text-slate-400 border border-cyan-400/10 rounded-xl p-3">{matchResult}</div>}

      <div className={panelClass}>
        <div className="flex justify-between items-center">
          <span className="text-slate-500 text-xs uppercase tracking-widest">Protocol fee vault</span>
          <button onClick={loadFeeVault} disabled={feeLoading} className="text-xs text-cyan-400 hover:text-cyan-300 disabled:opacity-40">{feeLoading ? '⟳' : '↻ Refresh'}</button>
        </div>
        <div className="text-2xl font-light text-cyan-300">{feeVault !== null ? `${fmtUsdc(feeVault)} USDCx` : '—'}</div>
        <p className="text-slate-500 text-xs leading-relaxed">Accumulated protocol fees (0.10% on all settlements).</p>
      </div>

      {!isOperator && connected && <div className="text-xs text-red-400 border border-red-500/30 rounded-xl p-3">Connected wallet is not the operator address.</div>}
      {!connected && <div className="text-xs text-slate-500 border border-cyan-400/10 rounded-xl p-3">Connect your operator Shield wallet to claim fees.</div>}

      {isOperator && (
        <>
          <div>
            <label className="text-slate-500 text-xs uppercase tracking-widest block mb-1">Amount to claim (USDCx)</label>
            <div className="flex bg-black/30 border border-cyan-400/15 rounded-xl focus-within:border-cyan-400/50 transition-colors overflow-hidden">
              <input type="number" value={claimAmount} onChange={e => setClaimAmount(e.target.value)} placeholder="0.00" className="flex-1 bg-transparent text-white text-xl font-light px-4 py-3 outline-none" />
              <button onClick={() => feeVault !== null && setClaimAmount(fmtUsdc(feeVault))} className="px-4 text-xs text-cyan-400 border-l border-cyan-400/10 hover:bg-cyan-400/5 transition-colors">MAX</button>
            </div>
          </div>
          <button onClick={claimFees} disabled={!claimAmount || parseFloat(claimAmount) <= 0 || tx.status === 'submitting' || tx.status === 'pending'}
            className="w-full py-4 rounded-xl text-xs font-bold uppercase tracking-widest bg-gradient-to-r from-cyan-400 to-cyan-500 text-slate-950 hover:from-cyan-300 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-lg">
            {tx.status === 'submitting' ? '⟳ Submitting…' : tx.status === 'pending' ? '⟳ Confirming…' : '↓ Claim Fees'}
          </button>
          <TransactionStatus status={tx.status} tempTxId={tx.tempTxId} onChainTxId={tx.onChainTxId} error={tx.error} onDismiss={tx.reset} />
        </>
      )}

      <div className="bg-white/[0.02] border border-cyan-400/8 rounded-xl p-3 text-xs flex flex-col gap-1">
        {[['Operator address', OPERATOR_ADDRESS ? `${OPERATOR_ADDRESS.slice(0,12)}…` : 'not configured'], ['Fee rate', '0.10% (buyer only)'], ['Batch window', `~${BATCH_BLOCKS} blocks`], ['Settlement', 'Uniform clearing price']].map(([k,v]) => (
          <div key={k} className="flex justify-between py-1 border-b border-cyan-400/5 last:border-0"><span className="text-slate-500">{k}</span><span className="text-white font-mono text-xs">{v}</span></div>
        ))}
      </div>
    </div>
  )
}

// ── Tools Tab ─────────────────────────────────────────────────
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
    await mintTx.execute({ program: PROGRAM_ID, function: 'claim_test_asset', inputs: [`${mintAssetId}u8`], fee: 3_000_000, privateFee: false })
  }

  const depositAsset = async () => {
    if (!connected || !depSelected || !depAmount || !depNonce) return
    const amountNum = BigInt(Math.floor(parseFloat(depAmount) * 1_000_000))
    await depTx.execute({ program: PROGRAM_ID, function: 'deposit_asset', inputs: buildDepositAssetInputs({ assetRecord: norm(depSelected), amount: amountNum, orderNonce: depNonce, operatorAddress: OPERATOR_ADDRESS }), fee: 3_000_000, privateFee: false })
  }

  const sectionClass = "flex flex-col gap-3"
  const headerClass  = "text-slate-500 text-xs uppercase tracking-widest border-b border-cyan-400/10 pb-2"
  const selectClass  = "w-full bg-black/30 border border-cyan-400/15 text-white text-xs rounded-xl px-3 py-2 font-mono"
  const outlineBtn   = "w-full py-3 rounded-xl text-xs font-bold uppercase tracking-widest bg-cyan-400/10 text-cyan-300 border border-cyan-400/40 hover:bg-cyan-400/20 transition-all disabled:opacity-40"

  return (
    <div className="flex flex-col gap-6">
      <div className={sectionClass}>
        <div className={headerClass}>Claim Test Asset <span className="text-cyan-400 ml-2">10 units free · once per asset</span></div>
        <div>
          <label className="text-slate-500 text-xs uppercase tracking-widest block mb-1">Asset</label>
          <select value={mintAssetId} onChange={e => setMintAssetId(parseInt(e.target.value))} className={selectClass}>
            {Object.entries(ASSETS).map(([id, sym]) => <option key={id} value={id}>{sym}</option>)}
          </select>
        </div>
        <button onClick={claimAsset} disabled={!connected || mintTx.status === 'submitting' || mintTx.status === 'pending'} className={outlineBtn}>
          {mintTx.status === 'submitting' ? '⟳ Claiming…' : mintTx.status === 'pending' ? '⟳ Confirming…' : `⚡ Claim 10 ${ASSETS[mintAssetId]}`}
        </button>
        <TransactionStatus status={mintTx.status} tempTxId={mintTx.tempTxId} onChainTxId={mintTx.onChainTxId} error={mintTx.error} onDismiss={mintTx.reset} />
      </div>

      <div className={sectionClass}>
        <div className={headerClass}>Deposit Asset <span className="text-slate-500 ml-2">escrow for sell order</span></div>
        <div>
          <label className="text-slate-500 text-xs uppercase tracking-widest block mb-1">Your Asset Records</label>
          {records.length === 0 ? <LoadBtn onLoad={loadRec} loading={recLoading} label="Load from Shield wallet" />
            : <select value={depSelected} onChange={e => setDepSelected(e.target.value)} className={selectClass}><option value="">— select record —</option>{records.filter(r => r.amount > 0n).map((r,i) => <option key={i} value={r.plaintext}>{r.label}</option>)}</select>}
        </div>
        <InputRow label="Amount to escrow" value={depAmount} onChange={setDepAmount} token="units" placeholder="1.000000" />
        <div>
          <label className="text-slate-500 text-xs uppercase tracking-widest block mb-1">Order nonce <span className="normal-case text-slate-600">(auto-linked to sell order via bot)</span></label>
          <div className="flex gap-2">
            <input type="text" value={depNonce} onChange={e => setDepNonce(e.target.value)} placeholder="click Generate →"
              className="flex-1 bg-black/30 border border-cyan-400/15 text-white text-xs rounded-xl px-3 py-2 font-mono outline-none focus:border-cyan-400/50" />
            <button onClick={() => setDepNonce(randomField())} className="px-3 py-2 text-xs text-cyan-400 border border-cyan-400/40 rounded-xl hover:bg-cyan-400/10 transition-colors whitespace-nowrap">Generate</button>
          </div>
        </div>
        <button onClick={depositAsset} disabled={!connected || !depSelected || !depAmount || !depNonce || depTx.status === 'submitting' || depTx.status === 'pending'} className={outlineBtn}>
          {depTx.status === 'submitting' ? '⟳ Depositing…' : depTx.status === 'pending' ? '⟳ Confirming…' : '↓ Deposit Asset'}
        </button>
        <TransactionStatus status={depTx.status} tempTxId={depTx.tempTxId} onChainTxId={depTx.onChainTxId} error={depTx.error} onDismiss={depTx.reset} />
      </div>

      <div className={sectionClass}>
        <div className={headerClass}>USDCx Credentials <span className="text-slate-500 ml-2">refresh for settlement</span></div>
        <p className="text-xs text-slate-400 leading-relaxed">Credentials must match the current on-chain freeze list root. If settlement fails, refresh here.</p>
        <button onClick={() => credTx.execute({ program: 'test_usdcx_stablecoin.aleo', function: 'get_credentials', inputs: [], fee: 3_000_000, privateFee: false })}
          disabled={!connected || credTx.status === 'submitting' || credTx.status === 'pending'} className={outlineBtn}>
          {credTx.status === 'submitting' ? '⟳ Submitting…' : credTx.status === 'pending' ? '⟳ Confirming…' : '🔑 Get Fresh Credentials'}
        </button>
        <TransactionStatus status={credTx.status} tempTxId={credTx.tempTxId} onChainTxId={credTx.onChainTxId} error={credTx.error} onDismiss={credTx.reset} />
      </div>
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState<DarkpoolTab>('order')
  const [blockHeight, setBlockHeight] = useState<number | null>(null)

  useEffect(() => {
    const poll = async () => setBlockHeight(await getCurrentBlock())
    poll(); const t = setInterval(poll, 15_000); return () => clearInterval(t)
  }, [])

  const TABS: { id: DarkpoolTab; label: string }[] = [
    { id: 'order',    label: 'Order'    },
    { id: 'receipts', label: 'Receipts' },
    { id: 'tools',    label: 'Tools'    },
    { id: 'operator', label: 'Operator' },
  ]

  return (
    <div className="min-h-screen bg-zkperp-dark text-[#e6f1ff] relative">
      <BackgroundDecor />
      <div className="relative z-10">
        <Header />
        <Navigation />

        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="mb-8">
            <h2 className="text-2xl font-bold text-white tracking-tight">ZK <span className="text-cyan-400">Darkpool</span></h2>
            <p className="text-slate-400 text-sm mt-1">Uniform clearing price batch auction · ZK-encrypted orders · 0.10% fee</p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

            {/* Stats sidebar */}
            <div className="lg:col-span-1 flex flex-col gap-4">
              <div className="bg-white/[0.04] border border-cyan-400/10 rounded-2xl p-5 backdrop-blur-xl">
                <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-4">Pool Stats</h3>
                <div className="flex flex-col gap-0">
                  {[
                    { label: 'Block',       value: blockHeight !== null ? `#${blockHeight.toLocaleString()}` : '—', hi: true },
                    { label: 'Batch window', value: `~${BATCH_BLOCKS} blocks` },
                    { label: 'Fee',          value: '0.10%' },
                    { label: 'Settlement',   value: 'Uniform clearing' },
                    { label: 'Privacy',      value: 'ZK-encrypted' },
                  ].map(({ label, value, hi }) => (
                    <div key={label} className="flex justify-between items-center py-2 border-b border-cyan-400/5 last:border-0">
                      <span className="text-slate-500 text-xs uppercase tracking-widest">{label}</span>
                      <span className={`text-sm font-medium ${hi ? 'text-cyan-300' : 'text-white'}`}>{value}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Privacy model note */}
              <div className="bg-white/[0.02] border border-cyan-400/8 rounded-2xl p-5 backdrop-blur-xl">
                <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-3">Privacy Model</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Order contents are ZK-encrypted on Aleo. Settlement amounts leak as finalize arguments — expiry and fee are visible on-chain. Counterparty identity is never revealed.
                </p>
                <a href="https://zk-perp.vercel.app" target="_blank" rel="noopener noreferrer"
                  className="mt-3 block text-xs text-cyan-400/70 hover:text-cyan-300 transition-colors">
                  ← Return to ZKPerp Core
                </a>
              </div>
            </div>

            {/* Main card */}
            <div className="lg:col-span-2">
              <div className="bg-white/[0.04] border border-cyan-400/10 rounded-2xl overflow-hidden backdrop-blur-xl">
                <div className="grid grid-cols-4 border-b border-cyan-400/10">
                  {TABS.map(({ id, label }) => (
                    <button key={id} onClick={() => setTab(id)}
                      className={`py-4 text-xs font-bold uppercase tracking-widest transition-all ${tab===id ? 'text-cyan-300 border-b-2 border-cyan-400 bg-cyan-400/5' : 'text-slate-500 hover:text-white hover:bg-white/[0.02]'}`}>
                      {label}
                    </button>
                  ))}
                </div>
                <div className="p-6">
                  {tab === 'order'    && <OrderTab    />}
                  {tab === 'receipts' && <ReceiptsTab />}
                  {tab === 'tools'    && <ToolsTab    />}
                  {tab === 'operator' && <OperatorTab />}
                </div>
              </div>
            </div>

          </div>
        </main>

        <footer className="border-t border-cyan-400/10 mt-16">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex flex-col md:flex-row justify-between items-center gap-4">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 bg-gradient-to-br from-cyan-400 to-violet-500 rounded flex items-center justify-center"><span className="text-white font-bold text-xs">ZK</span></div>
              <span className="text-slate-500 text-sm">ZKPerp Darkpool — Built on Aleo</span>
            </div>
            <span className="text-slate-600 text-xs">Contract: {PROGRAM_ID}</span>
          </div>
        </footer>
      </div>
    </div>
  )
}
