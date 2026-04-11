import { useState, useEffect, useCallback } from 'react'
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react'
import { WalletMultiButton } from '@provablehq/aleo-wallet-adaptor-react-ui'
import { getMerkleProof } from './merkleProof'
import { useTransaction } from './useTransaction'
import {
  fetchPoolState, computeQuote, computeMintQuote,
  buildSwapBuyInputs, buildSwapSellInputs, buildMintInputs, buildBurnInputs,
  parseLPPosition, sqrtToPrice, tickToPrice, alignTick, priceToTick, tickToSqrtX64,
  formatUsdc, formatAleo,
  PROGRAM_ID, USDCX_ID, TICK_SPACING, Q64,
  type PoolState, type SwapQuote, type MintQuote, type LPPosition,
} from './amm'

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

function Navigation() {
  const ext    = 'px-5 py-4 text-sm font-medium transition-all border-b-2 text-slate-400 border-transparent hover:text-white hover:border-slate-600'
  const active = 'px-5 py-4 text-sm font-medium transition-all border-b-2 text-cyan-300 border-cyan-400'
  return (
    <nav className="border-b border-cyan-400/10 bg-white/[0.02] backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex gap-1">
          <a href="https://zk-perp.vercel.app/trade/btc"     target="_blank" rel="noopener noreferrer" className={ext}><span className="mr-1.5">📈</span>Trade</a>
          <a href="https://zk-perp.vercel.app/liquidity/btc" target="_blank" rel="noopener noreferrer" className={ext}><span className="mr-1.5">💧</span>Liquidity</a>
          <span className={active}><span className="mr-1.5">🔄</span>AMM</span>
          <a href="https://zk-perp-darkpool.vercel.app/"      target="_blank" rel="noopener noreferrer" className={ext}><span className="mr-1.5">🌑</span>ZK Darkpool</a>
          <a href="https://zk-perp.vercel.app/status"         target="_blank" rel="noopener noreferrer" className={ext}><span className="mr-1.5">📡</span>System Status</a>
          <a href="https://zk-perp.vercel.app/portfolio"      target="_blank" rel="noopener noreferrer" className={ext}><span className="mr-1.5">📊</span>Portfolio</a>
          <a href="https://zk-perp.vercel.app/compliance"     target="_blank" rel="noopener noreferrer" className={ext}><span className="mr-1.5">🛡️</span>Compliance</a>
        </div>
      </div>
    </nav>
  )
}

function normalize(plaintext: string): string {
  return plaintext.replace(/\s+/g, ' ').replace(/{ /g, '{').replace(/ }/g, '}').replace(/,\s+/g, ',').replace(/:\s+/g, ':').trim()
}

interface USDCxRecord { amount: bigint; plaintext: string; label: string }
type Tab = 'swap' | 'liquidity' | 'burn'

// ── Transaction status panel ──────────────────────────────────
// Uses useTransaction hook states: submitting → pending → accepted/rejected/error
function TxPanel({ tx }: { tx: ReturnType<typeof useTransaction> }) {
  if (tx.status === 'idle') return null

  if (tx.status === 'submitting') return (
    <div className="mt-4 p-4 bg-white/[0.03] border border-cyan-400/10 rounded-xl text-xs text-slate-400 animate-pulse">
      ⟳ Waiting for Shield approval…
    </div>
  )

  if (tx.status === 'pending') return (
    <div className="mt-4 p-4 bg-white/[0.03] border border-cyan-400/20 rounded-xl text-xs">
      <div className="flex items-center gap-2 text-cyan-300 font-bold mb-2">
        <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
        </svg>
        Waiting for on-chain confirmation…
      </div>
      {tx.tempTxId && (
        <div className="text-slate-500 text-xs font-mono break-all">{tx.tempTxId}</div>
      )}
    </div>
  )

  if (tx.status === 'accepted') return (
    <div className="mt-4 p-4 bg-white/[0.03] border border-emerald-400/30 rounded-xl text-xs">
      <div className="text-emerald-400 font-bold mb-1">✓ Confirmed on-chain</div>
      <div className="text-slate-400 break-all mb-2">{tx.onChainTxId ?? tx.tempTxId}</div>
      <a href={`https://explorer.provable.com/transaction/${tx.onChainTxId ?? tx.tempTxId}`}
        target="_blank" rel="noreferrer" className="text-violet-400 underline">
        View on explorer →
      </a>
    </div>
  )

  if (tx.status === 'rejected' || tx.status === 'failed') return (
    <div className="mt-4 p-4 bg-white/[0.03] border border-red-400/20 rounded-xl text-xs">
      <div className="text-red-400 font-bold mb-1">✗ Transaction {tx.status}</div>
      <div className="text-slate-400">{tx.error}</div>
      {(tx.onChainTxId ?? tx.tempTxId) && (
        <a href={`https://explorer.provable.com/transaction/${tx.onChainTxId ?? tx.tempTxId}`}
          target="_blank" rel="noreferrer" className="text-violet-400 underline mt-1 block">
          View on explorer →
        </a>
      )}
    </div>
  )

  // error state
  return (
    <div className="mt-4 p-4 bg-white/[0.03] border border-red-400/20 rounded-xl text-xs">
      <div className="text-red-400 font-bold mb-1">✗ Error</div>
      <div className="text-slate-400">{tx.error}</div>
    </div>
  )
}

function inputRow(label: string, value: string, onChange: (v: string) => void, token: string, readOnly = false) {
  return (
    <div>
      <label className="text-slate-500 text-xs uppercase tracking-widest block mb-1">{label}</label>
      <div className="flex bg-black/30 border border-cyan-400/15 rounded-xl focus-within:border-cyan-400/50 transition-colors overflow-hidden">
        <input type="number" value={value} onChange={e => onChange(e.target.value)} readOnly={readOnly} placeholder="0.00"
          className="flex-1 bg-transparent text-white text-xl font-light px-4 py-3 outline-none" />
        <span className="px-4 flex items-center text-slate-500 text-xs font-bold border-l border-cyan-400/10">{token}</span>
      </div>
    </div>
  )
}

// ── Hooks ─────────────────────────────────────────────────────
function useUSDCxRecords() {
  const { requestRecords, decrypt } = useWallet()
  const [records, setRecords] = useState<USDCxRecord[]>([])
  const [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    if (!requestRecords || !decrypt) return
    setLoading(true)
    try {
      const raw = await requestRecords(USDCX_ID, true) as any[]
      const tokens = raw.filter((r: any) => r.recordName === 'Token' && !r.spent)
      const parsed = await Promise.all(tokens.map(async (r: any) => {
        try {
          const pt = await decrypt(r.recordCiphertext)
          const m = pt.match(/amount:\s*(\d+)u128/)
          const amt = BigInt(m?.[1] ?? '0')
          return { amount: amt, plaintext: pt, label: `${(Number(amt)/1e6).toFixed(2)} USDCx` }
        } catch { return null }
      }))
      setRecords(parsed.filter((r): r is USDCxRecord => r !== null).sort((a,b) => b.amount > a.amount ? 1 : -1))
    } finally { setLoading(false) }
  }, [requestRecords, decrypt])
  return { records, loading, load }
}

function useLPPositions() {
  const { requestRecords, decrypt } = useWallet()
  const [positions, setPositions] = useState<LPPosition[]>([])
  const [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    if (!requestRecords || !decrypt) return
    setLoading(true)
    try {
      const raw = await requestRecords(PROGRAM_ID, true) as any[]
      const lps = raw.filter((r: any) => r.recordName === 'LPPosition' && !r.spent)
      const parsed = await Promise.all(lps.map(async (r: any) => {
        try { const pt = await decrypt(r.recordCiphertext); return parseLPPosition(pt) } catch { return null }
      }))
      setPositions(parsed.filter((r): r is LPPosition => r !== null))
    } finally { setLoading(false) }
  }, [requestRecords, decrypt])
  return { positions, loading, load }
}

// ── Swap tab ──────────────────────────────────────────────────
function SwapTab({ pool }: { pool: PoolState | null }) {
  const { connected } = useWallet()
  const tx = useTransaction()
  const { records, loading: recLoading, load: loadRecs } = useUSDCxRecords()
  const [direction, setDirection] = useState<'buy'|'sell'>('buy')
  const [amountIn, setAmountIn] = useState('')
  const [quote, setQuote] = useState<SwapQuote | null>(null)
  const [selected, setSelected] = useState('')
  const isBuy = direction === 'buy'
  const busy = tx.status === 'submitting' || tx.status === 'pending'

  useEffect(() => { if (records.length > 0 && !selected) setSelected(records[0].plaintext) }, [records])
  useEffect(() => {
    if (!pool || !amountIn || parseFloat(amountIn) <= 0) { setQuote(null); return }
    setQuote(computeQuote(pool, BigInt(Math.floor(parseFloat(amountIn) * 1e6)), isBuy))
  }, [pool, amountIn, isBuy])

  const swap = async () => {
    if (!quote) return
    const mp = await getMerkleProof(USDCX_ID, '')
    const inputs = isBuy ? buildSwapBuyInputs(quote, normalize(selected), mp) : buildSwapSellInputs(quote)
    await tx.execute({ program: PROGRAM_ID, function: isBuy ? 'swap_buy' : 'swap_sell', inputs, fee: 5_000_000, privateFee: false })
  }

  const outAmt = quote ? (isBuy ? formatAleo(quote.amountOut) : formatUsdc(quote.amountOut)) : ''

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2">
        {(['buy','sell'] as const).map(d => (
          <button key={d} onClick={() => { setDirection(d); setAmountIn(''); setQuote(null); tx.reset() }}
            className={`py-2 rounded-xl text-xs font-bold uppercase tracking-widest transition-all ${direction===d ? (d==='buy' ? 'bg-cyan-400/10 text-cyan-300 border border-cyan-400/50' : 'bg-red-400/10 text-red-400 border border-red-400/50') : 'bg-white/[0.03] border border-cyan-400/10 text-slate-400 hover:text-white'}`}>
            {d === 'buy' ? '▲ Buy ALEO' : '▼ Sell ALEO'}
          </button>
        ))}
      </div>
      {inputRow(isBuy ? 'Pay (USDCx)' : 'Pay (ALEO)', amountIn, setAmountIn, isBuy ? 'USDCx' : 'ALEO')}
      <div className="flex justify-center"><div className="w-8 h-8 rounded-full bg-cyan-400/10 border border-cyan-400/20 flex items-center justify-center text-cyan-400">↓</div></div>
      {inputRow(isBuy ? 'Receive (ALEO)' : 'Receive (USDCx)', outAmt, () => {}, isBuy ? 'ALEO' : 'USDCx', true)}
      {quote && (
        <div className="bg-white/[0.03] border border-cyan-400/10 rounded-xl p-3 text-xs flex flex-col gap-2">
          {[['Fee (0.3%)', `${formatUsdc(quote.fee)} ${isBuy?'USDCx':'ALEO'}`], ['Price impact', `${quote.impactBps.toFixed(2)} bps`], ['New tick', `${quote.tickAfter}`]].map(([k,v]) => (
            <div key={k} className="flex justify-between"><span className="text-slate-500">{k}</span><span className="text-white font-medium">{v}</span></div>
          ))}
        </div>
      )}
      {isBuy && (
        <div>
          <label className="text-slate-500 text-xs uppercase tracking-widest block mb-1">USDCx Token Record</label>
          {records.length === 0
            ? <button onClick={loadRecs} disabled={!connected || recLoading} className="w-full text-xs text-slate-500 border border-cyan-400/15 rounded-xl px-4 py-2 text-left hover:border-cyan-400/40 hover:text-cyan-300 transition-all disabled:opacity-40">{recLoading ? '⟳ Loading…' : '↓ Load from Shield wallet'}</button>
            : <select value={selected} onChange={e => setSelected(e.target.value)} className="w-full bg-black/30 border border-cyan-400/15 text-white text-xs rounded-xl px-3 py-2 font-mono"><option value="">— select —</option>{records.map((r,i) => <option key={i} value={r.plaintext}>{r.label}</option>)}</select>
          }
        </div>
      )}
      <button onClick={swap} disabled={!quote || !connected || (isBuy && !selected) || busy}
        className={`w-full py-4 rounded-xl text-xs font-bold uppercase tracking-widest transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-lg ${isBuy ? 'bg-gradient-to-r from-cyan-400 to-cyan-500 text-slate-950 hover:from-cyan-300' : 'bg-gradient-to-r from-red-500 to-red-600 text-white hover:from-red-400'}`}>
        {tx.status === 'submitting' ? '⟳ Approving…' : tx.status === 'pending' ? '⟳ Confirming on-chain…' : isBuy ? 'Buy ALEO' : 'Sell ALEO'}
      </button>
      <TxPanel tx={tx} />
    </div>
  )
}

// ── Liquidity tab ─────────────────────────────────────────────
function LiquidityTab({ pool }: { pool: PoolState | null }) {
  const { connected } = useWallet()
  const tx = useTransaction()
  const { records, loading: recLoading, load: loadRecs } = useUSDCxRecords()
  const [priceLo, setPriceLo] = useState('')
  const [priceHi, setPriceHi] = useState('')
  const [liqInput, setLiqInput] = useState('')
  const [selected, setSelected] = useState('')
  const [quote, setQuote] = useState<MintQuote | null>(null)
  const busy = tx.status === 'submitting' || tx.status === 'pending'

  useEffect(() => { if (records.length > 0 && !selected) setSelected(records[0].plaintext) }, [records])
  const currentPrice = pool ? sqrtToPrice(pool.sqrtPriceX64) : null

  useEffect(() => {
    if (!pool || !priceLo || !priceHi || !liqInput) { setQuote(null); return }
    const lo = parseFloat(priceLo), hi = parseFloat(priceHi), ua = parseFloat(liqInput)
    if (lo <= 0 || hi <= lo || ua <= 0) { setQuote(null); return }
    const tickLo = alignTick(priceToTick(lo)), tickHi = alignTick(priceToTick(hi))
    if (tickLo >= tickHi) { setQuote(null); return }
    const sqC = pool.sqrtPriceX64, sqL = tickToSqrtX64(tickLo), sqH = tickToSqrtX64(tickHi)
    const a0 = BigInt(Math.floor(ua * 1_000_000)), S = 4294967296
    const LS = Number(sqL/4294967296n), HS = Number(sqH/4294967296n), CS = Number(sqC/4294967296n), a0F = Number(a0)
    let lf: number
    if (CS <= LS) lf = a0F*HS*LS/((HS-LS)*S)
    else if (CS < HS) lf = a0F*HS*CS/((HS-CS)*S)
    else lf = a0F*S/(HS-LS)
    const liq = BigInt(Math.floor(lf))
    if (liq <= 0n) { setQuote(null); return }
    setQuote(computeMintQuote(pool, tickLo, tickHi, liq))
  }, [pool, priceLo, priceHi, liqInput])

  const mint = async () => {
    if (!quote || !selected) return
    const mp = await getMerkleProof(USDCX_ID, '')
    const inputs = buildMintInputs(quote, normalize(selected), pool!, mp)
    await tx.execute({ program: PROGRAM_ID, function: 'mint_position', inputs, fee: 5_000_000, privateFee: false })
  }

  return (
    <div className="flex flex-col gap-4">
      {currentPrice && <div className="bg-white/[0.03] border border-cyan-400/10 rounded-xl px-4 py-3 text-xs flex justify-between"><span className="text-slate-500">Current price</span><span className="text-cyan-300 font-medium">{currentPrice.toFixed(6)} ALEO/USDCx</span></div>}
      <div>
        <label className="text-slate-500 text-xs uppercase tracking-widest block mb-2">Price Range (ALEO per USDCx)</label>
        <div className="grid grid-cols-2 gap-2">
          {([['Min price', priceLo, setPriceLo],['Max price', priceHi, setPriceHi]] as [string,string,(v:string)=>void][]).map(([label,val,setter]) => (
            <div key={label}>
              <div className="text-slate-500 text-xs mb-1">{label}</div>
              <div className="flex bg-black/30 border border-cyan-400/15 rounded-xl focus-within:border-cyan-400/50 transition-colors overflow-hidden">
                <input type="number" value={val as string} onChange={e => setter(e.target.value)} placeholder="0.00" className="flex-1 bg-transparent text-white text-sm font-light px-3 py-2 outline-none w-0" />
              </div>
            </div>
          ))}
        </div>
        {quote && <div className="mt-2 text-xs text-slate-500">Ticks: [{quote.tickLower}, {quote.tickUpper}] · spacing {TICK_SPACING}</div>}
      </div>
      {inputRow('USDCx amount to deposit', liqInput, setLiqInput, 'USDCx')}
      {quote && (
        <div className="bg-white/[0.03] border border-cyan-400/10 rounded-xl p-3 text-xs flex flex-col gap-2">
          <div className="text-slate-500 text-xs uppercase tracking-widest mb-1">Deposit amounts</div>
          {[['USDCx needed',`${formatUsdc(quote.amount0)} USDCx`],['ALEO needed',`${formatAleo(quote.amount1)} ALEO`],['Price lower',`${quote.priceLower.toFixed(6)}`],['Price upper',`${quote.priceUpper.toFixed(6)}`]].map(([k,v]) => (
            <div key={k} className="flex justify-between"><span className="text-slate-500">{k}</span><span className="text-white font-medium">{v}</span></div>
          ))}
        </div>
      )}
      <div>
        <label className="text-slate-500 text-xs uppercase tracking-widest block mb-1">USDCx Token Record</label>
        {records.length === 0
          ? <button onClick={loadRecs} disabled={!connected || recLoading} className="w-full text-xs text-slate-500 border border-cyan-400/15 rounded-xl px-4 py-2 text-left hover:border-cyan-400/40 hover:text-cyan-300 transition-all disabled:opacity-40">{recLoading ? '⟳ Loading…' : '↓ Load from Shield wallet'}</button>
          : <select value={selected} onChange={e => setSelected(e.target.value)} className="w-full bg-black/30 border border-cyan-400/15 text-white text-xs rounded-xl px-3 py-2 font-mono"><option value="">— select —</option>{records.map((r,i) => <option key={i} value={r.plaintext}>{r.label}</option>)}</select>
        }
      </div>
      <button onClick={mint} disabled={!quote||!selected||!connected||busy||!pool}
        className="w-full py-4 rounded-xl text-xs font-bold uppercase tracking-widest bg-gradient-to-r from-violet-500 to-violet-600 text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:from-violet-400 shadow-lg">
        {tx.status === 'submitting' ? '⟳ Approving…' : tx.status === 'pending' ? '⟳ Confirming on-chain…' : 'Add Liquidity'}
      </button>
      <TxPanel tx={tx} />
    </div>
  )
}

// ── Burn tab ──────────────────────────────────────────────────
function BurnTab({ pool }: { pool: PoolState | null }) {
  const { connected } = useWallet()
  const tx = useTransaction()
  const { positions, loading: posLoading, load: loadPos } = useLPPositions()
  const [selected, setSelected] = useState<LPPosition | null>(null)
  const busy = tx.status === 'submitting' || tx.status === 'pending'

  const burn = async () => {
    if (!selected || !pool) return
    const inputs = buildBurnInputs({ ...selected, plaintext: normalize(selected.plaintext) }, pool, 0n, 0n)
    await tx.execute({ program: PROGRAM_ID, function: 'burn_position', inputs, fee: 5_000_000, privateFee: false })
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="text-slate-500 text-xs uppercase tracking-widest block mb-1">Your LP Positions</label>
        {positions.length === 0
          ? <button onClick={loadPos} disabled={!connected||posLoading} className="w-full text-xs text-slate-500 border border-cyan-400/15 rounded-xl px-4 py-2 text-left hover:border-cyan-400/40 hover:text-cyan-300 transition-all disabled:opacity-40">{posLoading ? '⟳ Loading…' : '↓ Load positions from Shield wallet'}</button>
          : <select onChange={e => setSelected(positions[parseInt(e.target.value)] ?? null)} className="w-full bg-black/30 border border-cyan-400/15 text-white text-xs rounded-xl px-3 py-2 font-mono"><option value="">— select position —</option>{positions.map((p,i) => <option key={i} value={i}>{p.label}</option>)}</select>
        }
      </div>
      {selected && (
        <div className="bg-white/[0.03] border border-cyan-400/10 rounded-xl p-3 text-xs flex flex-col gap-2">
          {[['Tick lower',selected.tickLower],['Tick upper',selected.tickUpper],['Liquidity',selected.liquidity.toString()],['Price lower',tickToPrice(selected.tickLower).toFixed(6)],['Price upper',tickToPrice(selected.tickUpper).toFixed(6)],['Fees owed USDCx',formatUsdc(selected.tokensOwed0)],['Fees owed ALEO',formatAleo(selected.tokensOwed1)]].map(([k,v]) => (
            <div key={k} className="flex justify-between"><span className="text-slate-500">{k}</span><span className="text-white font-medium">{v}</span></div>
          ))}
        </div>
      )}
      <button onClick={burn} disabled={!selected||!connected||!pool||busy}
        className="w-full py-4 rounded-xl text-xs font-bold uppercase tracking-widest bg-gradient-to-r from-red-500/80 to-red-600/80 text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:from-red-500 shadow-lg">
        {tx.status === 'submitting' ? '⟳ Approving…' : tx.status === 'pending' ? '⟳ Confirming on-chain…' : 'Remove Liquidity'}
      </button>
      <TxPanel tx={tx} />
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────
export default function App() {
  const [pool, setPool] = useState<PoolState | null>(null)
  const [poolLoading, setPL] = useState(false)
  const [tab, setTab] = useState<Tab>('swap')

  const refreshPool = useCallback(async () => { setPL(true); setPool(await fetchPoolState()); setPL(false) }, [])
  useEffect(() => { refreshPool(); const t = setInterval(refreshPool, 30_000); return () => clearInterval(t) }, [refreshPool])

  const price = pool ? sqrtToPrice(pool.sqrtPriceX64) : null
  const TABS: { id: Tab; label: string }[] = [{ id: 'swap', label: 'Swap' }, { id: 'liquidity', label: 'Liquidity' }, { id: 'burn', label: 'Burn' }]

  return (
    <div className="min-h-screen bg-zkperp-dark text-[#e6f1ff] relative">
      <BackgroundDecor />
      <div className="relative z-10">
        <Header />
        <Navigation />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="mb-8">
            <h2 className="text-2xl font-bold text-white tracking-tight">AMM <span className="text-cyan-400">Pool</span></h2>
            <p className="text-slate-400 text-sm mt-1">USDCx / ALEO · Uniswap v3-style concentrated liquidity · 0.3% fee</p>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-1 flex flex-col gap-4">
              <div className="bg-white/[0.04] border border-cyan-400/10 rounded-2xl p-5 backdrop-blur-xl">
                <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-4">Pool Stats</h3>
                <div className="flex flex-col gap-0">
                  {[{ label: 'Price', value: price ? `${price.toFixed(5)} ALEO` : '—', hi: true }, { label: 'Tick', value: pool ? pool.currentTick.toString() : '—' }, { label: 'Liquidity', value: pool ? (pool.liquidity > 0n ? 'Active' : 'Empty') : '—' }, { label: 'Fee tier', value: '0.30%' }, { label: 'Pair', value: 'USDCx / ALEO' }].map(({ label, value, hi }) => (
                    <div key={label} className="flex justify-between items-center py-2 border-b border-cyan-400/5 last:border-0">
                      <span className="text-slate-500 text-xs uppercase tracking-widest">{label}</span>
                      <span className={`text-sm font-medium ${hi ? 'text-cyan-300' : 'text-white'}`}>{poolLoading ? '…' : value}</span>
                    </div>
                  ))}
                </div>
                <button onClick={refreshPool} disabled={poolLoading} className="mt-4 w-full text-xs text-slate-500 hover:text-cyan-300 transition-colors py-2 border border-cyan-400/10 rounded-xl hover:border-cyan-400/30 disabled:opacity-40">
                  {poolLoading ? '⟳ Refreshing…' : '↻ Refresh pool'}
                </button>
              </div>
              <div className="bg-white/[0.02] border border-cyan-400/8 rounded-2xl p-5 backdrop-blur-xl">
                <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-3">About AMM</h3>
                <p className="text-xs text-slate-400 leading-relaxed">Concentrated liquidity AMM for USDCx/ALEO on Aleo testnet. Provide liquidity in a custom price range and earn 0.3% fees on every swap.</p>
                <a href="https://zk-perp.vercel.app" target="_blank" rel="noopener noreferrer" className="mt-3 block text-xs text-cyan-400/70 hover:text-cyan-300 transition-colors">← Return to ZKPerp Core</a>
              </div>
            </div>
            <div className="lg:col-span-2">
              <div className="bg-white/[0.04] border border-cyan-400/10 rounded-2xl overflow-hidden backdrop-blur-xl">
                <div className="grid grid-cols-3 border-b border-cyan-400/10">
                  {TABS.map(({ id, label }) => (
                    <button key={id} onClick={() => setTab(id)}
                      className={`py-4 text-xs font-bold uppercase tracking-widest transition-all ${tab===id ? 'text-cyan-300 border-b-2 border-cyan-400 bg-cyan-400/5' : 'text-slate-500 hover:text-white hover:bg-white/[0.02]'}`}>
                      {label}
                    </button>
                  ))}
                </div>
                <div className="p-6">
                  {tab === 'swap'      && <SwapTab      pool={pool} />}
                  {tab === 'liquidity' && <LiquidityTab pool={pool} />}
                  {tab === 'burn'      && <BurnTab      pool={pool} />}
                </div>
              </div>
            </div>
          </div>
        </main>
        <footer className="border-t border-cyan-400/10 mt-16">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex flex-col md:flex-row justify-between items-center gap-4">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 bg-gradient-to-br from-cyan-400 to-violet-500 rounded flex items-center justify-center"><span className="text-white font-bold text-xs">ZK</span></div>
              <span className="text-slate-500 text-sm">ZKPerp AMM — Built on Aleo</span>
            </div>
            <span className="text-slate-600 text-xs">Contract: {PROGRAM_ID}</span>
          </div>
        </footer>
      </div>
    </div>
  )
}
