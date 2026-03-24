import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import type { TransactionOptions } from '@provablehq/aleo-types';
import { useTransaction } from '@/hooks/useTransaction';
import { TransactionStatus } from '@/components/TransactionStatus';
import { formatUsdc, formatPrice, PROGRAM_ID } from '@/utils/aleo';

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

const LIQUIDATION_THRESHOLD_PERCENT = 1;
const LIQUIDATION_REWARD_BPS = 5000n;
const ALEO_API = 'https://api.explorer.provable.com/v1/testnet';

interface PositionData {
  positionId: string;
  trader: string;
  isLong: boolean;
  sizeUsdc: bigint;
  collateralUsdc: bigint;
  entryPrice: bigint;
}

interface LiqAuthWithCalc extends PositionData {
  pnl: bigint;
  marginRatio: number;
  isLiquidatable: boolean;
  reward: bigint;
}

interface BotStatus {
  status: 'ok' | 'unreachable';
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  stoppedAt: string | null;
  restartCount: number;
  currentPrice?: string;
  positionCount?: number;
  lastScanAt?: string | null;
}

export function SystemStatusPage({ currentPrice, poolLiquidity, longOI, shortOI }: Props) {
  const { connected } = useWallet();
  const MANAGER_API = import.meta.env.VITE_MANAGER_API_URL || 'http://localhost:3000';
  const liquidateTx = useTransaction();

  const [activeTab, setActiveTab] = useState<'status' | 'liquidate' | 'oracle'>('status');
  const [txId, setTxId] = useState('');
  const [position, setPosition] = useState<PositionData | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calculation, setCalculation] = useState<{
    pnl: bigint; marginRatio: number; isLiquidatable: boolean; reward: bigint;
  } | null>(null);

  const [liqAuths, setLiqAuths] = useState<LiqAuthWithCalc[]>([]);
  const [orchLoading, setOrchLoading] = useState(false);
  const [orchError, setOrchError] = useState<string | null>(null);
  const [liquidatingId, setLiquidatingId] = useState<string | null>(null);
  const [botStatus, setBotStatus] = useState<BotStatus | null>(null);
  const [botActionBusy, setBotActionBusy] = useState(false);

  useEffect(() => {
    const fetchBotStatus = async () => {
      try {
        const res = await fetch(`${MANAGER_API}/health`);
        if (!res.ok) throw new Error('non-200');
        const managerData = await res.json();
        let extra: Partial<BotStatus> = {};
        if (managerData.botRunning) {
          try {
            const botRes = await fetch(`${MANAGER_API}/bot-health`);
            if (botRes.ok) {
              const botData = await botRes.json();
              extra = { currentPrice: botData.currentPrice, positionCount: botData.positionCount, lastScanAt: botData.lastScanAt };
            }
          } catch { }
        }
        setBotStatus({ status: 'ok', running: managerData.botRunning, pid: managerData.botPid, startedAt: managerData.botStartedAt, stoppedAt: managerData.botStoppedAt, restartCount: managerData.restartCount, ...extra });
      } catch {
        setBotStatus(prev => prev
          ? { ...prev, status: 'unreachable' }
          : { status: 'unreachable', running: false, pid: null, startedAt: null, stoppedAt: null, restartCount: 0 });
      }
    };
    fetchBotStatus();
    const interval = setInterval(fetchBotStatus, 10000);
    return () => clearInterval(interval);
  }, [MANAGER_API]);

  const handleBotToggle = useCallback(async () => {
    if (!botStatus || botStatus.status === 'unreachable') return;
    setBotActionBusy(true);
    try {
      const action = botStatus.running ? 'stop' : 'start';
      const res = await fetch(`${MANAGER_API}/${action}`, { method: 'POST' });
      const data = await res.json();
      setBotStatus(prev => prev ? { ...prev, running: data.running } : prev);
      setTimeout(async () => {
        try {
          const r = await fetch(`${MANAGER_API}/health`);
          const d = await r.json();
          setBotStatus(prev => prev ? { ...prev, running: d.botRunning, pid: d.botPid } : prev);
        } catch { }
      }, 2000);
    } catch (err) {
      console.error('Bot toggle failed:', err);
    } finally {
      setBotActionBusy(false);
    }
  }, [botStatus, MANAGER_API]);

  const calcLiquidation = (pos: PositionData, price: bigint) => {
    const priceDiff = price > pos.entryPrice ? price - pos.entryPrice : pos.entryPrice - price;
    const pnlAbs = (pos.sizeUsdc * priceDiff) / (pos.entryPrice + 1n);
    const traderProfits = (pos.isLong && price > pos.entryPrice) || (!pos.isLong && price < pos.entryPrice);
    const pnl = traderProfits ? pnlAbs : -pnlAbs;
    const remainingMargin = pos.collateralUsdc + pnl;
    const marginRatio = Number(remainingMargin * 100n * 10000n / pos.sizeUsdc) / 10000;
    const isLiquidatable = marginRatio < LIQUIDATION_THRESHOLD_PERCENT;
    const reward = (pos.sizeUsdc * LIQUIDATION_REWARD_BPS) / 1_000_000n;
    return { pnl, marginRatio, isLiquidatable, reward };
  };

  const fetchLiqAuths = useCallback(async () => {
    setOrchLoading(true);
    setOrchError(null);
    try {
      const res = await fetch(`${MANAGER_API}/api/liq-auths`);
      if (!res.ok) throw new Error(`Bot API error: ${res.status}`);
      const data = await res.json();
      const results: LiqAuthWithCalc[] = (data.positions || []).map((p: any) => ({
        positionId: p.positionId, trader: p.trader, isLong: p.isLong,
        sizeUsdc: BigInt(p.sizeUsdc), collateralUsdc: BigInt(p.collateralUsdc), entryPrice: BigInt(p.entryPrice),
        pnl: BigInt(p.pnl), marginRatio: p.marginRatio, isLiquidatable: p.isLiquidatable, reward: BigInt(p.reward),
      }));
      setLiqAuths(results);
    } catch (err: any) {
      setOrchError(err.message.includes('fetch') ? 'Bot API unreachable' : err.message);
    } finally {
      setOrchLoading(false);
    }
  }, [MANAGER_API]);

  useEffect(() => {
    if (liqAuths.length > 0 && currentPrice > 0n) {
      setLiqAuths(prev => prev.map(auth => ({ ...auth, ...calcLiquidation(auth, currentPrice) })));
    }
  }, [currentPrice]);

  const executeLiquidation = async (pos: PositionData) => {
    if (!connected) return;
    setError(null);
    setLiquidatingId(pos.positionId);
    try {
      let reward = (pos.sizeUsdc * LIQUIDATION_REWARD_BPS) / 1_000_000n;
      if (reward < 1n) reward = 1n;
      const options: TransactionOptions = {
        program: PROGRAM_ID, function: 'liquidate',
        inputs: [pos.positionId, `${pos.isLong}`, `${pos.sizeUsdc}u64`, `${pos.collateralUsdc}u64`, `${pos.entryPrice}u64`, `${reward}u128`, pos.trader],
        fee: 5_000_000, privateFee: false,
      };
      await liquidateTx.execute(options);
      setLiqAuths(prev => prev.filter(a => a.positionId !== pos.positionId));
    } catch (err: any) {
      setError(err.message || 'Liquidation failed');
    } finally {
      setLiquidatingId(null);
    }
  };

  const fetchTransaction = async (transactionId: string) => {
    setFetching(true);
    setError(null);
    setPosition(null);
    setCalculation(null);
    try {
      const response = await fetch(`${ALEO_API}/transaction/${transactionId.trim()}`);
      if (!response.ok) throw new Error(`Transaction not found (${response.status})`);
      const data = await response.json();
      const transitions = data.execution?.transitions || [];
      const t = transitions.find((t: any) => t.function === 'open_position' && t.program?.includes('zkperp'));
      if (!t) throw new Error('No open_position call found in this transaction');
      const pos = parsePositionFromTransition(t);
      if (!pos) throw new Error('Could not parse position data');
      setPosition(pos);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setFetching(false);
    }
  };

  const parsePositionFromTransition = (transition: any): PositionData | null => {
    try {
      const futureOutput = (transition.outputs || []).find((o: any) => o.type === 'future');
      if (!futureOutput?.value) return null;
      const futureStr = String(futureOutput.value);
      const innerBlockEnd = futureStr.indexOf('},');
      const afterBlock = innerBlockEnd > -1 ? futureStr.substring(innerBlockEnd + 2) : '';
      const posIdMatch = afterBlock.match(/(\d{30,})field/);
      const traderMatch = afterBlock.match(/(aleo1[a-z0-9]+)/);
      const u64Matches = afterBlock.match(/(\d+)u64/g) || [];
      const u64Values = u64Matches.map((m: string) => BigInt(m.replace('u64', '')));
      if (!posIdMatch || u64Values.length < 3) return null;
      const sizeUsdc = u64Values[1], entryPrice = u64Values[2];
      const collateralUsdc = u64Values.length >= 6 ? u64Values[5] : sizeUsdc / 10n;
      const isLong = !afterBlock.includes('\n    false') && !afterBlock.match(/,\s*false\s*,/);
      return { positionId: posIdMatch[0], trader: traderMatch?.[1] || '', isLong, sizeUsdc, collateralUsdc, entryPrice };
    } catch { return null; }
  };

  useEffect(() => {
    if (!position || currentPrice === 0n) { setCalculation(null); return; }
    setCalculation(calcLiquidation(position, currentPrice));
  }, [position, currentPrice]);

  const isLiquidateBusy = liquidateTx.status === 'submitting' || liquidateTx.status === 'pending';
  const fmtUsdc = (v: bigint) => (Number(v) / 1_000_000).toFixed(2);
  const fmtPrice = (v: bigint) => (Number(v) / 100_000_000).toLocaleString();

  const Spinner = ({ size = 4 }: { size?: number }) => (
    <svg className={`animate-spin h-${size} w-${size}`} viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );

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

          {/* Bot status */}
          <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-2.5 h-2.5 rounded-full ${
                  botStatus?.status === 'unreachable' ? 'bg-gray-500' :
                  botStatus?.running ? 'bg-zkperp-green animate-pulse' : 'bg-red-500'
                }`} />
                <div>
                  <p className="text-sm font-medium text-white">Oracle &amp; Liquidation Bot</p>
                  <p className="text-xs text-gray-500">
                    {botStatus?.status === 'unreachable' ? 'Manager unreachable (port 3000)'
                      : !botStatus?.running ? `Stopped${botStatus?.stoppedAt ? ` · stopped ${new Date(botStatus.stoppedAt).toLocaleTimeString()}` : ''}`
                      : botStatus?.currentPrice
                      ? `Running · BTC $${(Number(botStatus.currentPrice) / 1e8).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · ${botStatus.positionCount ?? 0} position(s) monitored`
                      : `Running · PID ${botStatus.pid} · starting up...`}
                  </p>
                </div>
              </div>
              <button
                onClick={handleBotToggle}
                disabled={botStatus?.status === 'unreachable' || botActionBusy}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 ${
                  botStatus?.running
                    ? 'bg-red-500/20 hover:bg-red-500/30 border border-red-500/50 text-red-400'
                    : 'bg-zkperp-green/20 hover:bg-zkperp-green/30 border border-zkperp-green/50 text-zkperp-green'
                }`}
              >
                {botActionBusy ? '...' : botStatus?.running ? '⏹ Stop Bot' : '▶ Start Bot'}
              </button>
            </div>
            {botStatus?.lastScanAt && botStatus.running && (
              <p className="text-xs text-gray-600 mt-3">
                Last scan: {new Date(botStatus.lastScanAt).toLocaleTimeString()} · Pushes price on-chain when deviation &gt;1% · Restarts: {botStatus.restartCount}
              </p>
            )}
          </div>

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

            <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
              <h3 className="font-semibold text-white mb-3">⚡ Liquidation Design</h3>
              <div className="space-y-2 text-sm text-gray-400">
                <p><span className="text-zkperp-accent font-medium">Threshold</span> — a position becomes liquidatable when margin ratio falls below 1% of position size.</p>
                <p><span className="text-zkperp-accent font-medium">Reward</span> — liquidator earns 0.5% of the position size. Anyone can liquidate, not just the bot.</p>
                <p><span className="text-zkperp-accent font-medium">Automation</span> — the orchestrator bot scans all LiquidationAuth records on every oracle tick and submits liquidations automatically.</p>
                <p><span className="text-zkperp-accent font-medium">Privacy preserved</span> — position data is never exposed publicly. The bot decrypts its own LiquidationAuth records server-side using the orchestrator view key.</p>
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
          <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold text-white">Orchestrator Dashboard</h3>
                <p className="text-sm text-gray-500 mt-0.5">Positions fetched from bot API — no wallet prompts needed</p>
              </div>
              <button
                onClick={fetchLiqAuths}
                disabled={orchLoading}
                className="flex items-center gap-2 px-4 py-2 bg-zkperp-accent/20 hover:bg-zkperp-accent/30 border border-zkperp-accent/50 rounded-lg text-sm font-medium text-zkperp-accent disabled:opacity-50 transition-colors"
              >
                {orchLoading ? <><Spinner />Scanning...</> : '🔍 Scan Positions'}
              </button>
            </div>

            {orchError && <p className="text-sm text-red-400 mb-4">{orchError}</p>}

            {liqAuths.length === 0 && !orchLoading && !orchError && (
              <div className="text-center py-8 text-gray-500">
                <p className="text-4xl mb-3">🔑</p>
                <p className="text-sm">No LiquidationAuth records found</p>
                <p className="text-xs mt-1">Click "Scan Positions" to load positions from the bot</p>
              </div>
            )}

            {liqAuths.length > 0 && (
              <div className="space-y-3">
                {liqAuths.map(auth => (
                  <div key={auth.positionId} className={`rounded-lg p-4 border ${
                    auth.isLiquidatable ? 'border-red-500/40 bg-red-500/5' : 'border-zkperp-border bg-zkperp-dark'
                  }`}>
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${auth.isLong ? 'bg-zkperp-green/20 text-zkperp-green' : 'bg-zkperp-red/20 text-zkperp-red'}`}>
                          {auth.isLong ? 'LONG' : 'SHORT'}
                        </span>
                        <span className={`text-xs font-medium ${auth.isLiquidatable ? 'text-red-400' : 'text-gray-400'}`}>
                          {auth.isLiquidatable ? '⚠ LIQUIDATABLE' : `Margin: ${auth.marginRatio.toFixed(2)}%`}
                        </span>
                      </div>
                      {auth.isLiquidatable && (
                        <button
                          onClick={() => executeLiquidation(auth)}
                          disabled={!connected || isLiquidateBusy || liquidatingId === auth.positionId}
                          className="px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 border border-red-500/50 rounded-lg text-xs font-medium text-red-400 disabled:opacity-50 transition-colors"
                        >
                          {liquidatingId === auth.positionId ? <Spinner size={3} /> : `Liquidate · Earn $${fmtUsdc(auth.reward)}`}
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-3 text-xs">
                      <div><p className="text-gray-500">Size</p><p className="text-white">${fmtUsdc(auth.sizeUsdc)}</p></div>
                      <div><p className="text-gray-500">Entry</p><p className="text-white">${fmtPrice(auth.entryPrice)}</p></div>
                      <div><p className="text-gray-500">PnL</p><p className={auth.pnl >= 0n ? 'text-zkperp-green' : 'text-zkperp-red'}>{auth.pnl >= 0n ? '+' : '-'}${fmtUsdc(auth.pnl >= 0n ? auth.pnl : -auth.pnl)}</p></div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* TX ID lookup */}
          <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
            <h3 className="font-semibold text-white mb-1">Manual TX Lookup</h3>
            <p className="text-sm text-gray-500 mb-4">Check any position by pasting its open_position transaction ID</p>
            <div className="flex gap-3">
              <input
                type="text"
                value={txId}
                onChange={e => setTxId(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && txId.trim() && fetchTransaction(txId)}
                placeholder="at1..."
                className="flex-1 bg-zkperp-dark border border-zkperp-border rounded-lg px-4 py-2.5 text-white text-sm font-mono placeholder-gray-600 focus:outline-none focus:border-zkperp-accent"
              />
              <button
                onClick={() => txId.trim() && fetchTransaction(txId)}
                disabled={fetching || !txId.trim()}
                className="px-4 py-2.5 bg-zkperp-accent/20 hover:bg-zkperp-accent/30 border border-zkperp-accent/50 rounded-lg text-sm font-medium text-zkperp-accent disabled:opacity-50 transition-colors"
              >
                {fetching ? <Spinner /> : 'Fetch'}
              </button>
            </div>

            {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

            {position && calculation && (
              <div className={`mt-4 rounded-lg p-4 border ${calculation.isLiquidatable ? 'border-red-500/40 bg-red-500/5' : 'border-zkperp-green/30 bg-zkperp-green/5'}`}>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-4">
                  <div><p className="text-gray-500">Size</p><p className="text-white">${fmtUsdc(position.sizeUsdc)}</p></div>
                  <div><p className="text-gray-500">Entry Price</p><p className="text-white">${fmtPrice(position.entryPrice)}</p></div>
                  <div><p className="text-gray-500">Margin Ratio</p><p className={calculation.marginRatio < 1 ? 'text-red-400' : 'text-white'}>{calculation.marginRatio.toFixed(2)}%</p></div>
                  <div><p className="text-gray-500">Reward</p><p className="text-zkperp-accent">${fmtUsdc(calculation.reward)}</p></div>
                </div>
                <TransactionStatus status={liquidateTx.status} tempTxId={liquidateTx.tempTxId} onChainTxId={liquidateTx.onChainTxId} error={liquidateTx.error} onDismiss={liquidateTx.reset} />
                <button
                  onClick={() => position && executeLiquidation(position)}
                  disabled={!connected || !calculation.isLiquidatable || isLiquidateBusy}
                  className={`mt-3 w-full py-3 rounded-lg font-semibold text-sm transition-colors ${
                    calculation.isLiquidatable ? 'bg-red-500/20 hover:bg-red-500/30 border border-red-500/50 text-red-400' : 'bg-zkperp-dark border border-zkperp-border text-gray-500 cursor-not-allowed'
                  }`}
                >
                  {!connected ? 'Connect Wallet' : !calculation.isLiquidatable ? 'Position is Healthy' : `Liquidate · Earn $${fmtUsdc(calculation.reward)}`}
                </button>
              </div>
            )}
          </div>

          {/* Liquidation explainer */}
          <div className="grid md:grid-cols-2 gap-4">
            <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
              <h3 className="font-semibold text-white mb-3">How Liquidations Work</h3>
              <div className="space-y-2 text-sm text-gray-400">
                <p>A position is liquidatable when its <strong className="text-white">margin ratio drops below 1%</strong> — meaning remaining collateral is less than 1% of position size.</p>
                <p>Formula: <code className="text-zkperp-accent text-xs bg-zkperp-dark px-1 rounded">remaining = collateral + unrealised_PnL</code>, then <code className="text-zkperp-accent text-xs bg-zkperp-dark px-1 rounded">margin_ratio = remaining / size × 100</code>.</p>
                <p>The liquidator earns <strong className="text-white">0.5%</strong> of position size as reward. Anyone can liquidate — the bot does it automatically, but the dashboard above lets you do it manually too.</p>
              </div>
            </div>
            <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
              <h3 className="font-semibold text-white mb-3">Keeper Bot</h3>
              <div className="space-y-2 text-sm text-gray-400">
                <p>The orchestrator bot runs continuously and handles three automated tasks:</p>
                <p><span className="text-zkperp-accent font-medium">Oracle updates</span> — fetches BTC/ETH/SOL prices from Binance and pushes on-chain when deviation exceeds 1%.</p>
                <p><span className="text-zkperp-accent font-medium">Liquidations</span> — decrypts LiquidationAuth records and submits <code className="text-xs">liquidate()</code> when margin ratio &lt; 1%.</p>
                <p><span className="text-zkperp-accent font-medium">TP/SL &amp; limit orders</span> — monitors PendingOrder records and executes when trigger conditions are met.</p>
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
