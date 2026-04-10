import { useState, useEffect, useCallback } from 'react'
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react'
import { WalletMultiButton } from '@provablehq/aleo-wallet-adaptor-react-ui'
import { getMerkleProof } from './merkleProof'
import {
  fetchPoolState, computeQuote, computeMintQuote,
  buildSwapBuyInputs, buildSwapSellInputs, buildMintInputs, buildBurnInputs,
  parseLPPosition, sqrtToPrice, tickToPrice, alignTick, priceToTick, tickToSqrtX64,
  formatUsdc, formatAleo,
  PROGRAM_ID, USDCX_ID, TICK_SPACING, Q64,
  type PoolState, type SwapQuote, type MintQuote, type LPPosition,
} from './amm'

// ── Normalize record plaintext (matches ZKPerp working pattern) ──
function normalize(plaintext: string): string {
  return plaintext
    .replace(/\s+/g, ' ')
    .replace(/{ /g, '{')
    .replace(/ }/g, '}')
    .replace(/,\s+/g, ',')
    .replace(/:\s+/g, ':')
    .trim()
}

// ── Shared types ──────────────────────────────────────────────
interface USDCxRecord { amount: bigint; plaintext: string; label: string }
type Tab      = 'swap' | 'liquidity' | 'burn'
type TxStatus = 'idle' | 'submitting' | 'done' | 'error'

// ── Shared hook: load USDCx records ──────────────────────────
function useUSDCxRecords() {
  const { requestRecords, decrypt } = useWallet()
  const [records, setRecords]   = useState<USDCxRecord[]>([])
  const [loading, setLoading]   = useState(false)

  const load = useCallback(async () => {
    if (!requestRecords || !decrypt) return
    setLoading(true)
    try {
      const raw = await requestRecords(USDCX_ID, true) as any[]
      const tokens = raw.filter((r: any) => r.recordName === 'Token' && !r.spent)
      const parsed = await Promise.all(tokens.map(async (r: any) => {
        try {
          const pt = await decrypt(r.recordCiphertext)
          const m  = pt.match(/amount:\s*(\d+)u128/)
          const amt = BigInt(m?.[1] ?? '0')
          return { amount: amt, plaintext: pt, label: `${(Number(amt)/1e6).toFixed(2)} USDCx` }
        } catch { return null }
      }))
      setRecords(parsed.filter((r): r is USDCxRecord => r !== null).sort((a,b) => b.amount > a.amount ? 1 : -1))
    } finally { setLoading(false) }
  }, [requestRecords, decrypt])

  return { records, loading, load }
}

// ── Shared hook: load LP positions ────────────────────────────
function useLPPositions() {
  const { requestRecords, decrypt } = useWallet()
  const [positions, setPositions] = useState<LPPosition[]>([])
  const [loading, setLoading]     = useState(false)

  const load = useCallback(async () => {
    if (!requestRecords || !decrypt) return
    setLoading(true)
    try {
      const raw = await requestRecords(PROGRAM_ID, true) as any[]
      const lps  = raw.filter((r: any) => r.recordName === 'LPPosition' && !r.spent)
      const parsed = await Promise.all(lps.map(async (r: any) => {
        try {
          const pt  = await decrypt(r.recordCiphertext)
          return parseLPPosition(pt)
        } catch { return null }
      }))
      setPositions(parsed.filter((r): r is LPPosition => r !== null))
    } finally { setLoading(false) }
  }, [requestRecords, decrypt])

  return { positions, loading, load }
}

// ── Tx panel ──────────────────────────────────────────────────
function TxPanel({ status, txId, error }: { status: TxStatus; txId: string; error: string }) {
  if (status === 'idle') return null
  if (status === 'submitting') return (
    <div className="mt-4 p-4 bg-panel border border-border rounded-xl text-xs text-muted animate-pulse">
      ⟳ Waiting for Shield approval…
    </div>
  )
  if (status === 'done') return (
    <div className="mt-4 p-4 bg-panel border border-accent/30 rounded-xl text-xs">
      <div className="text-accent font-bold mb-1">✓ Submitted</div>
      <div className="text-muted break-all mb-2">{txId}</div>
      <a href={`https://explorer.provable.com/transaction/${txId}`} target="_blank" rel="noreferrer"
         className="text-accent2 underline">View on explorer →</a>
    </div>
  )
  return (
    <div className="mt-4 p-4 bg-panel border border-red/30 rounded-xl text-xs">
      <div className="text-red font-bold mb-1">✗ Error</div>
      <div className="text-muted">{error}</div>
    </div>
  )
}

// ── Swap tab ──────────────────────────────────────────────────
function SwapTab({ pool }: { pool: PoolState | null }) {
  const { connected, executeTransaction } = useWallet() as any
  const { records, loading: recLoading, load: loadRecs } = useUSDCxRecords()
  const [direction, setDirection]   = useState<'buy'|'sell'>('buy')
  const [amountIn,  setAmountIn]    = useState('')
  const [quote,     setQuote]       = useState<SwapQuote | null>(null)
  const [selected,  setSelected]    = useState('')

  // Auto-select first record when records load
  useEffect(() => {
    if (records.length > 0 && !selected) setSelected(records[0].plaintext)
  }, [records])
  const [status,    setStatus]      = useState<TxStatus>('idle')
  const [txId,      setTxId]        = useState('')
  const [txError,   setTxError]     = useState('')
  const isBuy = direction === 'buy'

  useEffect(() => {
    if (!pool || !amountIn || parseFloat(amountIn) <= 0) { setQuote(null); return }
    const raw = BigInt(Math.floor(parseFloat(amountIn) * 1e6))
    setQuote(computeQuote(pool, raw, isBuy))
  }, [pool, amountIn, isBuy])

  const swap = async () => {
    if (!quote) return
    setStatus('submitting'); setTxError('')
    try {
      const merkleProof = await getMerkleProof(USDCX_ID, '')
      const inputs = isBuy ? buildSwapBuyInputs(quote, normalize(selected), merkleProof) : buildSwapSellInputs(quote)
      const result = await executeTransaction({ program: PROGRAM_ID, function: isBuy ? 'swap_buy' : 'swap_sell', inputs, fee: 5_000_000, privateFee: false })
      const id = result?.transactionId || 'submitted'
      setTxId(id as string); setStatus('done')
    } catch (e: any) { setTxError(e.message); setStatus('error') }
  }

  const outAmt = quote ? (isBuy ? formatAleo(quote.amountOut) : formatUsdc(quote.amountOut)) : ''

  return (
    <div className="flex flex-col gap-4">
      {/* Direction */}
      <div className="grid grid-cols-2 gap-2">
        {(['buy','sell'] as const).map(d => (
          <button key={d} onClick={() => { setDirection(d); setAmountIn(''); setQuote(null) }}
            className={`py-2 rounded-lg text-xs font-bold uppercase tracking-widest transition-colors ${
              direction===d ? (d==='buy' ? 'bg-accent/10 text-accent border border-accent' : 'bg-red/10 text-red border border-red')
                           : 'bg-panel border border-border text-muted hover:text-[#c8d8e8]'}`}>
            {d === 'buy' ? '▲ Buy ALEO' : '▼ Sell ALEO'}
          </button>
        ))}
      </div>

      {/* Amount in */}
      <div>
        <label className="text-muted text-xs uppercase tracking-widest block mb-1">{isBuy ? 'Pay (USDCx)' : 'Pay (ALEO)'}</label>
        <div className="flex bg-bg border border-border rounded-lg focus-within:border-accent transition-colors overflow-hidden">
          <input type="number" value={amountIn} onChange={e => setAmountIn(e.target.value)} placeholder="0.00"
            className="flex-1 bg-transparent text-[#c8d8e8] text-xl font-light px-4 py-3 outline-none" />
          <span className="px-4 flex items-center text-muted text-xs font-bold border-l border-border">{isBuy ? 'USDCx' : 'ALEO'}</span>
        </div>
      </div>

      <div className="flex justify-center"><div className="w-7 h-7 rounded-full bg-border flex items-center justify-center text-muted">↓</div></div>

      {/* Amount out */}
      <div>
        <label className="text-muted text-xs uppercase tracking-widest block mb-1">{isBuy ? 'Receive (ALEO)' : 'Receive (USDCx)'}</label>
        <div className="flex bg-bg border border-border rounded-lg overflow-hidden">
          <input readOnly value={outAmt} placeholder="—"
            className="flex-1 bg-transparent text-[#c8d8e8] text-xl font-light px-4 py-3 outline-none" />
          <span className="px-4 flex items-center text-muted text-xs font-bold border-l border-border">{isBuy ? 'ALEO' : 'USDCx'}</span>
        </div>
      </div>

      {/* Quote details */}
      {quote && (
        <div className="bg-bg border border-border rounded-lg p-3 text-xs flex flex-col gap-2">
          {[['Fee (0.3%)', `${formatUsdc(quote.fee)} ${isBuy?'USDCx':'ALEO'}`],
            ['Price impact', `${quote.impactBps.toFixed(2)} bps`],
            ['New tick', `${quote.tickAfter}`]].map(([k,v]) => (
            <div key={k} className="flex justify-between"><span className="text-muted">{k}</span><span className="text-[#c8d8e8] font-medium">{v}</span></div>
          ))}
        </div>
      )}

      {/* Record selector (buy only) */}
      {isBuy && (
        <div>
          <label className="text-muted text-xs uppercase tracking-widest block mb-1">USDCx Token Record</label>
          {records.length === 0
            ? <button onClick={loadRecs} disabled={!connected || recLoading}
                className="w-full text-xs text-muted border border-border rounded-lg px-4 py-2 text-left hover:border-accent hover:text-accent transition-colors disabled:opacity-40">
                {recLoading ? '⟳ Loading…' : '↓ Load from Shield wallet'}
              </button>
            : <select value={selected} onChange={e => setSelected(e.target.value)}
                className="w-full bg-bg border border-border text-[#c8d8e8] text-xs rounded-lg px-3 py-2 font-mono">
                <option value="">— select —</option>
                {records.map((r,i) => <option key={i} value={r.plaintext}>{r.label}</option>)}
              </select>
          }
        </div>
      )}

      <button onClick={swap} disabled={!quote || !connected || (isBuy && !selected) || status==='submitting'}
        className={`w-full py-4 rounded-lg text-xs font-bold uppercase tracking-widest transition-all disabled:opacity-40 disabled:cursor-not-allowed ${isBuy ? 'bg-accent text-[#001a14]' : 'bg-red text-white'}`}>
        {status==='submitting' ? '⟳ Confirming…' : isBuy ? 'Buy ALEO' : 'Sell ALEO'}
      </button>

      <TxPanel status={status} txId={txId} error={txError} />
    </div>
  )
}

// ── Liquidity tab ─────────────────────────────────────────────
function LiquidityTab({ pool }: { pool: PoolState | null }) {
  const { connected, executeTransaction } = useWallet() as any
  const { records, loading: recLoading, load: loadRecs } = useUSDCxRecords()
  const [priceLo,   setPriceLo]   = useState('')
  const [priceHi,   setPriceHi]   = useState('')
  const [liqInput,  setLiqInput]  = useState('')
  const [selected,  setSelected]  = useState('')

  // Auto-select first record when records load
  useEffect(() => {
    if (records.length > 0 && !selected) setSelected(records[0].plaintext)
  }, [records])
  const [quote,     setQuote]     = useState<MintQuote | null>(null)
  const [status,    setStatus]    = useState<TxStatus>('idle')
  const [txId,      setTxId]      = useState('')
  const [txError,   setTxError]   = useState('')

  const currentPrice = pool ? sqrtToPrice(pool.sqrtPriceX64) : null

  // Recompute quote when inputs change
  // liqInput = USDCx amount to deposit (user-friendly)
  // We derive liquidity units from USDCx amount + price range
  useEffect(() => {
    if (!pool || !priceLo || !priceHi || !liqInput) { setQuote(null); return }
    const lo = parseFloat(priceLo)
    const hi = parseFloat(priceHi)
    const usdcxAmount = parseFloat(liqInput)
    if (lo <= 0 || hi <= lo || usdcxAmount <= 0) { setQuote(null); return }
    const tickLo = alignTick(priceToTick(lo))
    const tickHi = alignTick(priceToTick(hi))
    if (tickLo >= tickHi) { setQuote(null); return }

    // Derive liquidity from desired USDCx amount:
    // For price in range: amount0 = L * Q64 * (sqrtHi - sqrtCurrent) / (sqrtHi * sqrtCurrent)
    // → L = amount0 * sqrtHi * sqrtCurrent / (Q64 * (sqrtHi - sqrtCurrent))
    const sqrtCurrent = pool.sqrtPriceX64
    const sqrtLo = tickToSqrtX64(tickLo)
    const sqrtHi = tickToSqrtX64(tickHi)
    const amount0Raw = BigInt(Math.floor(usdcxAmount * 1_000_000))

    // Derive liquidity using S=2^32 units for float precision
    // Inverse of getLiquidityAmounts formulas:
    //   amount0 = L * (sqrtHiS - sqrtCurS) * S / (sqrtHiS * sqrtCurS)
    //   → L = amount0 * sqrtHiS * sqrtCurS / ((sqrtHiS - sqrtCurS) * S)
    const S32 = 4294967296
    const sqrtLS  = Number(sqrtLo  / 4294967296n)
    const sqrtHS  = Number(sqrtHi  / 4294967296n)
    const sqrtCS  = Number(sqrtCurrent / 4294967296n)
    const amount0F = Number(amount0Raw)

    let liqFloat: number
    if (sqrtCS <= sqrtLS) {
      // Price below range — only token0 needed
      // L = amount0 * sqrtHiS * sqrtLoS / ((sqrtHiS - sqrtLoS) * S)
      liqFloat = amount0F * sqrtHS * sqrtLS / ((sqrtHS - sqrtLS) * S32)
    } else if (sqrtCS < sqrtHS) {
      // Price in range — derive from token0
      // L = amount0 * sqrtHiS * sqrtCurS / ((sqrtHiS - sqrtCurS) * S)
      liqFloat = amount0F * sqrtHS * sqrtCS / ((sqrtHS - sqrtCS) * S32)
    } else {
      // Price above range — only token1, derive from ALEO amount treated as token1
      // L = amount0 * S / (sqrtHiS - sqrtLoS)
      liqFloat = amount0F * S32 / (sqrtHS - sqrtLS)
    }
    const liq = BigInt(Math.floor(liqFloat))

    if (liq <= 0n) { setQuote(null); return }
    setQuote(computeMintQuote(pool, tickLo, tickHi, liq))
  }, [pool, priceLo, priceHi, liqInput])

  const mint = async () => {
    console.log('[mint] executeTransaction:', !!executeTransaction, 'quote:', !!quote, 'selected:', !!selected, 'connected:', connected)
    if (!quote || !selected) {
      console.log('[mint] BLOCKED')
      return
    }
    setStatus('submitting'); setTxError('')
    try {
      const merkleProof = await getMerkleProof(USDCX_ID, '')
      const inputs = buildMintInputs(quote, normalize(selected), pool!, merkleProof)
      console.log('[mint_position] inputs:')
      inputs.forEach((inp, i) => console.log(`  [${i}]`, typeof inp === 'string' && inp.length > 100 ? inp.slice(0, 80) + '...' : inp))
      const result = await executeTransaction({ program: PROGRAM_ID, function: 'mint_position', inputs, fee: 5_000_000, privateFee: false })
      const id = result?.transactionId || 'submitted'
      setTxId(id as string); setStatus('done')
    } catch (e: any) { setTxError(e.message); setStatus('error') }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Current price */}
      {currentPrice && (
        <div className="bg-bg border border-border rounded-lg px-4 py-3 text-xs flex justify-between">
          <span className="text-muted">Current price</span>
          <span className="text-accent font-medium">{currentPrice.toFixed(6)} ALEO/USDCx</span>
        </div>
      )}

      {/* Price range */}
      <div>
        <label className="text-muted text-xs uppercase tracking-widest block mb-2">Price Range (ALEO per USDCx)</label>
        <div className="grid grid-cols-2 gap-2">
          {([['Min price', priceLo, setPriceLo], ['Max price', priceHi, setPriceHi]] as [string, string, (v: string) => void][]).map(([label, val, setter]) => (
            <div key={label}>
              <div className="text-muted text-xs mb-1">{label}</div>
              <div className="flex bg-bg border border-border rounded-lg focus-within:border-accent transition-colors overflow-hidden">
                <input type="number" value={val as string} onChange={e => setter(e.target.value)} placeholder="0.00"
                  className="flex-1 bg-transparent text-[#c8d8e8] text-sm font-light px-3 py-2 outline-none w-0" />
              </div>
            </div>
          ))}
        </div>
        {quote && (
          <div className="mt-2 text-xs text-muted">
            Ticks: [{quote.tickLower}, {quote.tickUpper}] · spacing {TICK_SPACING}
          </div>
        )}
      </div>

      {/* Liquidity */}
      <div>
        <label className="text-muted text-xs uppercase tracking-widest block mb-1">USDCx amount to deposit</label>
        <div className="flex bg-bg border border-border rounded-lg focus-within:border-accent transition-colors overflow-hidden">
          <input type="number" value={liqInput} onChange={e => setLiqInput(e.target.value)} placeholder="100"
            className="flex-1 bg-transparent text-[#c8d8e8] text-xl font-light px-4 py-3 outline-none" />
          <span className="px-4 flex items-center text-muted text-xs border-l border-border">USDCx</span>
        </div>
      </div>

      {/* Quote */}
      {quote && (
        <div className="bg-bg border border-border rounded-lg p-3 text-xs flex flex-col gap-2">
          <div className="text-muted text-xs uppercase tracking-widest mb-1">Deposit amounts</div>
          {[['USDCx needed', `${formatUsdc(quote.amount0)} USDCx`],
            ['ALEO needed',  `${formatAleo(quote.amount1)} ALEO`],
            ['Price lower',  `${quote.priceLower.toFixed(6)}`],
            ['Price upper',  `${quote.priceUpper.toFixed(6)}`]].map(([k,v]) => (
            <div key={k} className="flex justify-between">
              <span className="text-muted">{k}</span>
              <span className="text-[#c8d8e8] font-medium">{v}</span>
            </div>
          ))}
        </div>
      )}

      {/* Record selector */}
      <div>
        <label className="text-muted text-xs uppercase tracking-widest block mb-1">USDCx Token Record</label>
        {records.length === 0
          ? <button onClick={loadRecs} disabled={!connected || recLoading}
              className="w-full text-xs text-muted border border-border rounded-lg px-4 py-2 text-left hover:border-accent hover:text-accent transition-colors disabled:opacity-40">
              {recLoading ? '⟳ Loading…' : '↓ Load from Shield wallet'}
            </button>
          : <select value={selected} onChange={e => setSelected(e.target.value)}
              className="w-full bg-bg border border-border text-[#c8d8e8] text-xs rounded-lg px-3 py-2 font-mono">
              <option value="">— select —</option>
              {records.map((r,i) => <option key={i} value={r.plaintext}>{r.label}</option>)}
            </select>
        }
      </div>

      <button onClick={() => { console.log('[btn] disabled?', { quote: !!quote, selected: !!selected, connected, pool: !!pool, status }); mint(); }} disabled={!quote || !selected || !connected || status==='submitting' || !pool}
        className="w-full py-4 rounded-lg text-xs font-bold uppercase tracking-widest bg-accent2 text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent2/90">
        {status==='submitting' ? '⟳ Confirming…' : 'Add Liquidity'}
      </button>

      <TxPanel status={status} txId={txId} error={txError} />
    </div>
  )
}

// ── Burn tab ──────────────────────────────────────────────────
function BurnTab({ pool }: { pool: PoolState | null }) {
  const { connected, executeTransaction } = useWallet() as any
  const { positions, loading: posLoading, load: loadPos } = useLPPositions()
  const [selected,  setSelected]  = useState<LPPosition | null>(null)
  const [status,    setStatus]    = useState<TxStatus>('idle')
  const [txId,      setTxId]      = useState('')
  const [txError,   setTxError]   = useState('')

  const burn = async () => {
    if (!selected || !pool) return
    setStatus('submitting'); setTxError('')
    try {
      // Estimate amounts from liquidity + current price
      // For simplicity pass 0 — contract will calculate the correct payout
      const inputs = buildBurnInputs({ ...selected, plaintext: normalize(selected.plaintext) }, pool, 0n, 0n)
      const result = await executeTransaction({ program: PROGRAM_ID, function: 'burn_position', inputs, fee: 5_000_000, privateFee: false })
      const id = result?.transactionId || 'submitted'
      setTxId(id as string); setStatus('done')
    } catch (e: any) { setTxError(e.message); setStatus('error') }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="text-muted text-xs uppercase tracking-widest block mb-1">Your LP Positions</label>
        {positions.length === 0
          ? <button onClick={loadPos} disabled={!connected || posLoading}
              className="w-full text-xs text-muted border border-border rounded-lg px-4 py-2 text-left hover:border-accent hover:text-accent transition-colors disabled:opacity-40">
              {posLoading ? '⟳ Loading…' : '↓ Load positions from Shield wallet'}
            </button>
          : <select onChange={e => setSelected(positions[parseInt(e.target.value)] ?? null)}
              className="w-full bg-bg border border-border text-[#c8d8e8] text-xs rounded-lg px-3 py-2 font-mono">
              <option value="">— select position —</option>
              {positions.map((p,i) => <option key={i} value={i}>{p.label}</option>)}
            </select>
        }
      </div>

      {/* Position details */}
      {selected && (
        <div className="bg-bg border border-border rounded-lg p-3 text-xs flex flex-col gap-2">
          {[['Tick lower',  selected.tickLower],
            ['Tick upper',  selected.tickUpper],
            ['Liquidity',   selected.liquidity.toString()],
            ['Price lower', tickToPrice(selected.tickLower).toFixed(6)],
            ['Price upper', tickToPrice(selected.tickUpper).toFixed(6)],
            ['Fees owed USDCx', formatUsdc(selected.tokensOwed0)],
            ['Fees owed ALEO',  formatAleo(selected.tokensOwed1)],
          ].map(([k,v]) => (
            <div key={k} className="flex justify-between">
              <span className="text-muted">{k}</span>
              <span className="text-[#c8d8e8] font-medium">{v}</span>
            </div>
          ))}
        </div>
      )}

      <button onClick={burn} disabled={!selected || !connected || !pool || status==='submitting'}
        className="w-full py-4 rounded-lg text-xs font-bold uppercase tracking-widest bg-red/80 text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:bg-red">
        {status==='submitting' ? '⟳ Confirming…' : 'Remove Liquidity'}
      </button>

      <TxPanel status={status} txId={txId} error={txError} />
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────
export default function App() {
  const [pool,   setPool]   = useState<PoolState | null>(null)
  const [poolLoading, setPL] = useState(false)
  const [tab,    setTab]    = useState<Tab>('swap')

  const refreshPool = useCallback(async () => {
    setPL(true)
    setPool(await fetchPoolState())
    setPL(false)
  }, [])

  useEffect(() => {
    refreshPool()
    const t = setInterval(refreshPool, 30_000)
    return () => clearInterval(t)
  }, [refreshPool])

  const price = pool ? sqrtToPrice(pool.sqrtPriceX64) : null

  const TABS: { id: Tab; label: string }[] = [
    { id: 'swap',      label: 'Swap'      },
    { id: 'liquidity', label: 'Liquidity' },
    { id: 'burn',      label: 'Burn'      },
  ]

  return (
    <div className="min-h-screen bg-bg flex flex-col items-center py-10 px-4 font-mono">

      {/* Header */}
      <div className="w-full max-w-md flex justify-between items-center mb-8">
        <div>
          <div className="text-accent text-sm font-bold tracking-widest uppercase">zkperp_amm</div>
          <div className="text-muted text-xs">USDCx / ALEO · 0.3% fee · testnet</div>
        </div>
        <WalletMultiButton />
      </div>

      {/* Pool stats */}
      <div className="w-full max-w-md grid grid-cols-3 gap-px bg-border rounded-xl overflow-hidden mb-5">
        {[
          { label: 'Price',     value: price ? `${price.toFixed(5)} ALEO` : '—', accent: true },
          { label: 'Tick',      value: pool  ? pool.currentTick.toString() : '—' },
          { label: 'Liquidity', value: pool  ? (pool.liquidity > 0n ? 'Active' : 'Empty') : '—' },
        ].map(({ label, value, accent }) => (
          <div key={label} className="bg-panel px-4 py-3">
            <div className="text-muted text-xs uppercase tracking-widest mb-1">{label}</div>
            <div className={`text-sm font-medium ${accent ? 'text-accent' : 'text-[#c8d8e8]'}`}>
              {poolLoading ? '…' : value}
            </div>
          </div>
        ))}
      </div>

      {/* Card */}
      <div className="w-full max-w-md bg-panel border border-border rounded-xl overflow-hidden">

        {/* Tabs */}
        <div className="grid grid-cols-3 border-b border-border">
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
          {tab === 'swap'      && <SwapTab      pool={pool} />}
          {tab === 'liquidity' && <LiquidityTab pool={pool} />}
          {tab === 'burn'      && <BurnTab       pool={pool} />}
        </div>
      </div>

      <button onClick={refreshPool} className="mt-6 text-xs text-muted hover:text-accent transition-colors">
        ↻ Refresh pool
      </button>
    </div>
  )
}
