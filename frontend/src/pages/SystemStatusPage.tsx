import { useState, useEffect } from 'react';
import { formatUsdc, formatPrice } from '@/utils/aleo';

const EXPLORER = 'https://api.explorer.provable.com/v1/testnet';

const PAIRS = [
  { id: 'BTC/USDC', program: 'zkperp_v19.aleo',  emoji: '₿' },
  { id: 'ETH/USDC', program: 'zkperp_v19b.aleo', emoji: 'Ξ' },
  { id: 'SOL/USDC', program: 'zkperp_v19c.aleo', emoji: '◎' },
];

function parseMapping(responseText: string): string {
  try {
    const inner = JSON.parse(responseText);
    return typeof inner === 'string' ? inner.replace(/\s+/g, '') : responseText.replace(/\s+/g, '');
  } catch {
    return responseText.replace(/\s+/g, '');
  }
}

function extractU64(cleaned: string, key: string): bigint {
  const m = cleaned.match(new RegExp(`${key}:(\\d+)u64`));
  return m ? BigInt(m[1]) : 0n;
}

interface PairState {
  price: bigint;
  liquidity: bigint;
  longOI: bigint;
  shortOI: bigint;
  loading: boolean;
}

function PairStatusGrid({ btcPrice, btcLiquidity, btcLongOI, btcShortOI }: {
  btcPrice: bigint; btcLiquidity: bigint; btcLongOI: bigint; btcShortOI: bigint;
}) {
  const [pairStates, setPairStates] = useState<Record<string, PairState>>({
    'BTC/USDC': { price: btcPrice, liquidity: btcLiquidity, longOI: btcLongOI, shortOI: btcShortOI, loading: false },
    'ETH/USDC': { price: 0n, liquidity: 0n, longOI: 0n, shortOI: 0n, loading: true },
    'SOL/USDC': { price: 0n, liquidity: 0n, longOI: 0n, shortOI: 0n, loading: true },
  });

  useEffect(() => {
    setPairStates(prev => ({ ...prev, 'BTC/USDC': { ...prev['BTC/USDC'], price: btcPrice, liquidity: btcLiquidity, longOI: btcLongOI, shortOI: btcShortOI } }));
  }, [btcPrice, btcLiquidity, btcLongOI, btcShortOI]);

  useEffect(() => {
    const fetchPair = async (pairId: string, program: string) => {
      try {
        const [priceRes, poolRes] = await Promise.all([
          fetch(`${EXPLORER}/program/${program}/mapping/oracle_prices/0field`),
          fetch(`${EXPLORER}/program/${program}/mapping/pool_state/0field`),
        ]);
        const priceCleaned = parseMapping(await priceRes.text());
        const poolCleaned  = parseMapping(await poolRes.text());
        setPairStates(prev => ({
          ...prev,
          [pairId]: {
            price:     extractU64(priceCleaned, 'price'),
            liquidity: extractU64(poolCleaned,  'total_liquidity'),
            longOI:    extractU64(poolCleaned,  'long_open_interest'),
            shortOI:   extractU64(poolCleaned,  'short_open_interest'),
            loading:   false,
          },
        }));
      } catch {
        setPairStates(prev => ({ ...prev, [pairId]: { ...prev[pairId], loading: false } }));
      }
    };
    fetchPair('ETH/USDC', 'zkperp_v19b.aleo');
    fetchPair('SOL/USDC', 'zkperp_v19c.aleo');
  }, []);

  return (
    <div className="bg-zkperp-card rounded-xl border border-zkperp-border overflow-hidden">
      <div className="grid grid-cols-5 gap-0 px-4 py-2 border-b border-zkperp-border text-xs text-gray-500 font-medium">
        <span>Pair</span>
        <span className="text-right">Oracle Price</span>
        <span className="text-right">Pool Liquidity</span>
        <span className="text-right text-zkperp-green">Long OI</span>
        <span className="text-right text-zkperp-red">Short OI</span>
      </div>
      {PAIRS.map(({ id, emoji }) => {
        const s = pairStates[id];
        return (
          <div key={id} className="grid grid-cols-5 gap-0 px-4 py-3 border-b last:border-0 border-zkperp-border hover:bg-zkperp-dark/50 transition-colors">
            <div className="flex items-center gap-2">
              <span className="text-lg">{emoji}</span>
              <span className="text-sm font-medium text-white">{id}</span>
            </div>
            {s.loading ? (
              <span className="col-span-4 text-xs text-gray-600 self-center">Loading...</span>
            ) : (
              <>
                <span className="text-right text-sm text-white self-center">${formatPrice(s.price)}</span>
                <span className="text-right text-sm text-white self-center">${formatUsdc(s.liquidity)}</span>
                <span className="text-right text-sm text-zkperp-green self-center">${formatUsdc(s.longOI)}</span>
                <span className="text-right text-sm text-zkperp-red self-center">${formatUsdc(s.shortOI)}</span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface Props {
  currentPrice: bigint;
  poolLiquidity: bigint;
  longOI: bigint;
  shortOI: bigint;
}


export function SystemStatusPage({ currentPrice, poolLiquidity, longOI, shortOI }: Props) {
  const [activeTab, setActiveTab] = useState<'status' | 'liquidate' | 'oracle'>('status');

  const tabClass = (active: boolean) =>
    `px-4 py-2 rounded-lg text-sm font-medium transition-colors ${active
      ? 'bg-zkperp-dark text-white'
      : 'text-gray-400 hover:text-white'}`;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-2">System Status</h1>
        <p className="text-gray-400">Protocol health, oracle infrastructure, and liquidation management.</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-zkperp-card border border-zkperp-border rounded-xl w-fit mb-6">
        {(['status', 'liquidate', 'oracle'] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} className={tabClass(activeTab === tab)}>
            {tab === 'status' ? '📊 Protocol' : tab === 'liquidate' ? '⚡ Liquidations' : '🔮 Oracle'}
          </button>
        ))}
      </div>

      {/* ── Protocol Status Tab ─────────────────────────────────── */}
      {activeTab === 'status' && (
        <div className="space-y-6">
          {/* Per-pair status */}
          <PairStatusGrid btcPrice={currentPrice} btcLiquidity={poolLiquidity} btcLongOI={longOI} btcShortOI={shortOI} />

          {/* Architecture summary */}
          <div className="grid md:grid-cols-2 gap-4">
            <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
              <h3 className="font-semibold text-white mb-3">🔒 Privacy Architecture</h3>
              <div className="space-y-2 text-sm text-gray-400">
                <p><span className="text-zkperp-accent font-medium">PositionSlot</span> — private record owned by the trader. Holds entry price, size, direction, and collateral. Only the trader can decrypt it.</p>
                <p><span className="text-zkperp-accent font-medium">LiquidationAuth</span> — private record owned by the orchestrator. Contains the same position data so the bot can monitor and liquidate without the trader being online.</p>
                <p><span className="text-zkperp-accent font-medium">Slot model</span> — each trader has exactly 2 slots (long + short), issued once. Slots are mutated in place — no record accumulation regardless of trading frequency.</p>
              </div>
            </div>

            <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
              <h3 className="font-semibold text-white mb-3">📋 Advanced Order Types</h3>
              <div className="space-y-2 text-sm text-gray-400">
                <p><span className="text-zkperp-accent font-medium">Limit order</span> — open a position at a target price. Slot is reserved until execution or cancellation. Triggers when oracle ≤ trigger (long) or ≥ trigger (short).</p>
                <p><span className="text-zkperp-accent font-medium">Take profit</span> — close a profitable position at a target. Bot monitors and executes automatically. Triggers when oracle ≥ trigger (long) or ≤ trigger (short).</p>
                <p><span className="text-zkperp-accent font-medium">Stop loss</span> — cap downside by closing at a set price. Runs 24/7 without the trader being online. Triggers when oracle ≤ trigger (long) or ≥ trigger (short).</p>
                <p className="text-xs text-gray-600 mt-1">Order details (trigger price, size) are never public on-chain before execution — only a BHP256 commitment hash is stored.</p>
              </div>
            </div>

            <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
              <h3 className="font-semibold text-white mb-3">💧 LP Pool Design</h3>
              <div className="space-y-2 text-sm text-gray-400">
                <p>Single-sided USDC pool. LPs deposit USDC and receive LP tokens. The pool acts as direct counterparty to all traders.</p>
                <p><span className="text-zkperp-accent font-medium">Withdrawal guard</span> — available liquidity = total − long OI − short OI − unrealised PnL liability − 10% safety buffer. Enforced on-chain.</p>
                <p><span className="text-zkperp-accent font-medium">Asymmetric PnL</span> — when traders are profitable the pool reserves their unrealised gains. When traders are losing, the pool does <em>not</em> count paper gains — mirrors GMX V2 design.</p>
                <p><span className="text-zkperp-accent font-medium">OI locking</span> — long and short OI are locked independently (no netting), ensuring the pool can always pay out both sides.</p>
              </div>
            </div>

          </div>
        </div>
      )}

      {/* ── Liquidations Tab ────────────────────────────────────── */}
      {activeTab === 'liquidate' && (
        <div className="space-y-6">

          {/* How liquidations work */}
          <div className="grid md:grid-cols-2 gap-4">
            <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
              <h3 className="font-semibold text-white mb-3">⚡ How Liquidations Work</h3>
              <div className="space-y-2 text-sm text-gray-400">
                <p><span className="text-zkperp-accent font-medium">Dual-record design</span> — every <code className="text-xs bg-zkperp-dark px-1 rounded">open_position</code> creates two private records: a <span className="text-white">PositionSlot</span> owned by the trader, and a <span className="text-white">LiquidationAuth</span> owned by the orchestrator. This lets the bot liquidate without the trader being online — and without ever seeing the trader's private key.</p>
                <p><span className="text-zkperp-accent font-medium">Threshold</span> — a position is liquidatable when its margin ratio falls below 1% of position size. The on-chain program verifies this; the bot cannot liquidate healthy positions.</p>
                <p><span className="text-zkperp-accent font-medium">Reward</span> — the liquidator earns 0.5% of position size. Anyone can liquidate using the manual lookup below — not just the bot.</p>
              </div>
            </div>
            <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
              <h3 className="font-semibold text-white mb-3">🤖 Liquidation Bot</h3>
              <div className="space-y-2 text-sm text-gray-400">
                <p>The bot runs on Render and polls the oracle price every ~30 seconds. On each tick it:</p>
                <ol className="space-y-1 list-none">
                  {[
                    'Decrypts all LiquidationAuth records using the orchestrator view key',
                    'Computes margin ratio for each position at the current oracle price',
                    'Submits on-chain liquidations for any position below 1% margin',
                    'Updates net_unrealised_pnl so the LP pool withdrawal guard stays accurate',
                  ].map((s, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-zkperp-accent font-medium">{i + 1}.</span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </div>
          {/* Liquidation explainer */}
          <div className="grid md:grid-cols-2 gap-4">
            <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
              <h3 className="font-semibold text-white mb-3">Keeper Bot</h3>
              <div className="space-y-2 text-sm text-gray-400">
                <p>The orchestrator bot runs continuously and handles three automated tasks:</p>
                <p><span className="text-zkperp-accent font-medium">Oracle updates</span> — fetches BTC/ETH/SOL prices from Binance and pushes on-chain when deviation exceeds 1%.</p>
                <p><span className="text-zkperp-accent font-medium">Liquidations</span> — decrypts LiquidationAuth records and submits <code className="text-xs">liquidate()</code> when margin ratio &lt; 1%.</p>
                <p><span className="text-zkperp-accent font-medium">TP/SL &amp; limit orders</span> — monitors PendingOrder records and executes when trigger conditions are met.</p>
              </div>
            </div>
            <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
              <h3 className="font-semibold text-white mb-3">📐 Formula</h3>
              <div className="space-y-2 text-sm text-gray-400">
                <p>A position is liquidatable when its <strong className="text-white">margin ratio drops below 1%</strong> of position size.</p>
                <p><code className="text-zkperp-accent text-xs bg-zkperp-dark px-1 rounded block mt-1 mb-1">remaining = collateral + unrealised_PnL</code></p>
                <p><code className="text-zkperp-accent text-xs bg-zkperp-dark px-1 rounded block mb-1">margin_ratio = remaining / size × 100</code></p>
                <p>The liquidator earns <strong className="text-white">0.5%</strong> of position size as reward.</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Oracle Architecture Tab ─────────────────────────────── */}
      {activeTab === 'oracle' && (
        <div className="space-y-6">
          <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
            <h3 className="font-semibold text-white mb-1">How the Oracle Works</h3>
            <p className="text-sm text-gray-500 mb-6">ZKPerp uses a trusted orchestrator oracle — a single bot that pushes prices on-chain and aggregates unrealised PnL. Below is the current design and a roadmap toward a decentralized 2/3 quorum model.</p>

            {/* PnL aggregation */}
            <div className="rounded-lg border border-zkperp-border bg-zkperp-dark p-4 mb-4">
              <p className="text-sm font-medium text-white mb-2">Why the bot also submits PnL</p>
              <p className="text-sm text-gray-400 mb-2">Because positions on Aleo are <strong className="text-white">private records</strong>, the Leo contract cannot compute unrealised PnL on-chain by itself — position data is never visible to the contract unless the owner presents the record in a transaction.</p>
              <p className="text-sm text-gray-400">The orchestrator holds <code className="text-zkperp-accent text-xs px-1 bg-zkperp-dark/50 rounded">LiquidationAuth</code> records for every open position and uses them to compute net PnL off-chain on every oracle tick, then posts it via <code className="text-zkperp-accent text-xs px-1 bg-zkperp-dark/50 rounded">update_net_pnl(net_pnl: i64)</code>. This is a trusted aggregator — not a trustless proof — and is openly documented as a known limitation.</p>
            </div>

            <div className="space-y-4">
              {/* Current */}
              <div className="rounded-lg border border-zkperp-border bg-zkperp-dark p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="px-2 py-0.5 rounded text-xs font-medium bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">Current — Testnet</span>
                  <span className="text-sm font-medium text-white">Single Trusted Oracle</span>
                </div>
                <div className="space-y-2 text-sm text-gray-400">
                  <p>The orchestrator bot fetches the BTC price from a public API (e.g. CoinGecko or Binance) every ~30 seconds and calls <code className="text-zkperp-accent text-xs bg-zkperp-dark/50 px-1 rounded">set_price</code> on-chain when the deviation exceeds 1%.</p>
                  <p>This is sufficient for testnet but introduces a single point of trust — if the bot is compromised, it can post a false price.</p>
                </div>
              </div>

              {/* Roadmap */}
              <div className="rounded-lg border border-zkperp-accent/30 bg-zkperp-accent/5 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="px-2 py-0.5 rounded text-xs font-medium bg-zkperp-accent/20 text-zkperp-accent border border-zkperp-accent/30">Roadmap — Mainnet</span>
                  <span className="text-sm font-medium text-white">2/3 Quorum Oracle</span>
                </div>
                <div className="space-y-3 text-sm text-gray-400">
                  <p>Rather than one bot, <strong className="text-white">N independent oracles</strong> each sign a price submission. The on-chain program only accepts a price update when at least <strong className="text-white">⌈2N/3⌉ signatures agree</strong> within a tolerance band (e.g. ±0.5%).</p>

                  <div className="grid md:grid-cols-3 gap-3 mt-4">
                    {[
                      { icon: '📡', title: 'Price Sources', body: 'Each oracle pulls from a different data source — Chainlink Data Streams, Pyth Network, Binance, Coinbase — so no single feed can corrupt the price.' },
                      { icon: '✍️', title: 'Ed25519 Signatures', body: 'Oracles sign their price + timestamp off-chain. The Leo program verifies all signatures on-chain and checks the median price falls within the tolerance band.' },
                      { icon: '🔐', title: 'ZK Proof of Consensus', body: 'Aleo\'s ZK execution means the quorum check itself is a verifiable proof — anyone can verify that exactly 2/3 oracles agreed, without seeing their private keys.' },
                    ].map(({ icon, title, body }) => (
                      <div key={title} className="bg-zkperp-dark rounded-lg p-3 border border-zkperp-border">
                        <p className="text-lg mb-1">{icon}</p>
                        <p className="text-white text-xs font-medium mb-1">{title}</p>
                        <p className="text-gray-500 text-xs">{body}</p>
                      </div>
                    ))}
                  </div>

                  <div className="mt-4 pt-4 border-t border-zkperp-border">
                    <p className="text-xs text-gray-500 font-medium mb-2">Example flow (3-of-5 quorum):</p>
                    <div className="flex items-center gap-2 flex-wrap text-xs">
                      {['Chainlink', 'Pyth', 'Binance', 'Coinbase', 'Kraken'].map((src, i) => (
                        <span key={src} className="flex items-center gap-1">
                          <span className="px-2 py-0.5 bg-zkperp-dark border border-zkperp-border rounded text-gray-300">{src}</span>
                          {i < 4 && <span className="text-gray-600">→</span>}
                        </span>
                      ))}
                      <span className="text-gray-600">→</span>
                      <span className="px-2 py-0.5 bg-zkperp-accent/10 border border-zkperp-accent/30 rounded text-zkperp-accent">3/5 agree</span>
                      <span className="text-gray-600">→</span>
                      <span className="px-2 py-0.5 bg-zkperp-green/10 border border-zkperp-green/30 rounded text-zkperp-green">on-chain update ✓</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Chainlink reference */}
              <div className="rounded-lg border border-zkperp-border bg-zkperp-dark p-4">
                <p className="text-sm font-medium text-white mb-2">Why not just use Chainlink directly?</p>
                <p className="text-sm text-gray-400">Chainlink doesn't natively support Aleo — it runs on EVM chains. The roadmap approach emulates Chainlink's aggregation model but verifies it inside Aleo's ZK VM, so the proof of consensus is part of the transaction itself rather than trusted off-chain.</p>
              </div>

              {/* PnL trust model */}
              <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="px-2 py-0.5 rounded text-xs font-medium bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">Honest Limitation</span>
                  <span className="text-sm font-medium text-white">Trusted PnL Aggregation</span>
                </div>
                <div className="space-y-2 text-sm text-gray-400">
                  <p>Because positions are private records, the Leo contract cannot compute unrealised PnL by itself. The orchestrator reads all <span className="text-white">LiquidationAuth</span> records, sums the net PnL across all open positions, and submits it on-chain via <code className="text-xs bg-zkperp-dark px-1 rounded text-zkperp-accent">update_net_pnl</code>. The contract verifies only that the caller is the registered orchestrator — not that the math is correct.</p>
                  <p><span className="text-white">Failure mode:</span> if the bot is offline and no PnL update is submitted, the mapping defaults to <code className="text-xs bg-zkperp-dark px-1 rounded text-zkperp-accent">0i64</code> — the conservative baseline. LPs can never over-withdraw even without orchestrator input.</p>
                  <p><span className="text-white">Future direction:</span> a ZK proof that the submitted PnL is consistent with the public open interest figures — proving "I know a set of private positions whose sizes sum to the on-chain long/short OI, and whose net PnL at the current oracle price equals the submitted value". This would make PnL reporting trustless while keeping position details private.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
