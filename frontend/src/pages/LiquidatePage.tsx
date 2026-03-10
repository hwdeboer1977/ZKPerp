import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import type { TransactionOptions } from '@provablehq/aleo-types';
import { useTransaction } from '@/hooks/useTransaction';
import { TransactionStatus } from '@/components/TransactionStatus';
import { formatUsdc, formatPrice, PROGRAM_ID } from '@/utils/aleo';

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
  // proxied from bot /health when running
  currentPrice?: string;
  positionCount?: number;
  lastScanAt?: string | null;
}

export function LiquidatePage({ currentPrice, poolLiquidity, longOI, shortOI }: Props) {
  const { connected } = useWallet();
  const MANAGER_API = import.meta.env.VITE_MANAGER_API_URL || 'http://localhost:3000';
  const liquidateTx = useTransaction();

  const [activeTab, setActiveTab] = useState<'txid' | 'orchestrator'>('orchestrator');
  const [txId, setTxId] = useState('');
  const [position, setPosition] = useState<PositionData | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calculation, setCalculation] = useState<{
    pnl: bigint;
    marginRatio: number;
    isLiquidatable: boolean;
    reward: bigint;
  } | null>(null);

  const [liqAuths, setLiqAuths] = useState<LiqAuthWithCalc[]>([]);
  const [orchLoading, setOrchLoading] = useState(false);
  const [orchError, setOrchError] = useState<string | null>(null);
  const [liquidatingId, setLiquidatingId] = useState<string | null>(null);

  const [botStatus, setBotStatus] = useState<BotStatus | null>(null);
  const [botActionBusy, setBotActionBusy] = useState(false);

  // Poll manager /health every 10s, also fetch bot /bot-health when running
  useEffect(() => {
    const fetchBotStatus = async () => {
      try {
        const res = await fetch(`${MANAGER_API}/health`);
        if (!res.ok) throw new Error('non-200');
        const managerData = await res.json();
        let extra: Partial<BotStatus> = {};

        // If bot is running, also fetch bot-level stats via manager proxy
        if (managerData.botRunning) {
          try {
            const botRes = await fetch(`${MANAGER_API}/bot-health`);
            if (botRes.ok) {
              const botData = await botRes.json();
              extra = {
                currentPrice: botData.currentPrice,
                positionCount: botData.positionCount,
                lastScanAt: botData.lastScanAt,
              };
            }
          } catch { /* bot might not be ready yet */ }
        }

        setBotStatus({
          status: 'ok',
          running: managerData.botRunning,
          pid: managerData.botPid,
          startedAt: managerData.botStartedAt,
          stoppedAt: managerData.botStoppedAt,
          restartCount: managerData.restartCount,
          ...extra,
        });
      } catch {
        setBotStatus(prev => prev
          ? { ...prev, status: 'unreachable' }
          : { status: 'unreachable', running: false, pid: null, startedAt: null, stoppedAt: null, restartCount: 0 }
        );
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
      // Re-poll after 2s to get updated status
      setTimeout(async () => {
        try {
          const r = await fetch(`${MANAGER_API}/health`);
          const d = await r.json();
          setBotStatus(prev => prev ? { ...prev, running: d.botRunning, pid: d.botPid } : prev);
        } catch { /* ignore */ }
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

  // ═══════════════════════════════════════════════════════════════
  // ORCHESTRATOR MODE: Fetch pre-decrypted positions from bot API
  // No wallet prompts — bot decrypts server-side using orchestrator view key
  // ═══════════════════════════════════════════════════════════════

  const fetchLiqAuths = useCallback(async () => {
    setOrchLoading(true);
    setOrchError(null);

    try {
      const res = await fetch(`${MANAGER_API}/api/liq-auths`);
      if (!res.ok) throw new Error(`Bot API error: ${res.status}`);

      const data = await res.json();
      const results: LiqAuthWithCalc[] = (data.positions || []).map((p: any) => ({
        positionId: p.positionId,
        trader: p.trader,
        isLong: p.isLong,
        sizeUsdc: BigInt(p.sizeUsdc),
        collateralUsdc: BigInt(p.collateralUsdc),
        entryPrice: BigInt(p.entryPrice),
        pnl: BigInt(p.pnl),
        marginRatio: p.marginRatio,
        isLiquidatable: p.isLiquidatable,
        reward: BigInt(p.reward),
      }));

      console.log(`Bot API: ${results.length} position(s), last scan: ${data.lastScanAt}`);
      setLiqAuths(results);
    } catch (err: any) {
      console.error('Failed to fetch from bot API:', err);
      setOrchError(err.message.includes('fetch')
        ? 'Bot API unreachable — is zkperp-bot-manager running? (port 3000)'
        : err.message);
    } finally {
      setOrchLoading(false);
    }
  }, [MANAGER_API]);

  // Recalculate when price changes
  useEffect(() => {
    if (liqAuths.length > 0 && currentPrice > 0n) {
      setLiqAuths(prev => prev.map(auth => ({
        ...auth,
        ...calcLiquidation(auth, currentPrice),
      })));
    }
  }, [currentPrice]);

  const executeLiquidation = async (pos: PositionData) => {
    if (!connected) return;

    setError(null);
    setLiquidatingId(pos.positionId);

    try {
      let reward = (pos.sizeUsdc * LIQUIDATION_REWARD_BPS) / 1_000_000n;
      if (reward < 1n) reward = 1n;

      const inputs = [
        pos.positionId,
        `${pos.isLong}`,
        `${pos.sizeUsdc}u64`,
        `${pos.collateralUsdc}u64`,
        `${pos.entryPrice}u64`,
        `${reward}u128`,
        pos.trader,
      ];

      console.log('Liquidation inputs:', inputs);

      const options: TransactionOptions = {
        program: PROGRAM_ID,
        function: 'liquidate',
        inputs,
        fee: 5_000_000,
        privateFee: false,
      };

      await liquidateTx.execute(options);
      setLiqAuths(prev => prev.filter(a => a.positionId !== pos.positionId));
      setPosition(null);
      setCalculation(null);
      setTxId('');
    } catch (err: any) {
      console.error('Liquidation failed:', err);
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
      const cleanTxId = transactionId.trim();
      const response = await fetch(`${ALEO_API}/transaction/${cleanTxId}`);
      if (!response.ok) throw new Error(`Transaction not found (${response.status})`);

      const data = await response.json();
      const transitions = data.execution?.transitions || [];
      const openPositionTransition = transitions.find(
        (t: any) => t.function === 'open_position' && t.program?.includes('zkperp')
      );

      if (!openPositionTransition) {
        throw new Error('This transaction does not contain an open_position call from zkperp');
      }

      const positionData = parsePositionFromTransition(openPositionTransition);
      if (!positionData) {
        throw new Error('Could not parse position data from transaction. Try manual override.');
      }

      setPosition(positionData);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch transaction');
    } finally {
      setFetching(false);
    }
  };

  const parsePositionFromTransition = (transition: any): PositionData | null => {
    try {
      const futureOutput = (transition.outputs || []).find((o: any) => o.type === 'future');
      if (futureOutput?.value) {
        const futureStr = String(futureOutput.value);
        let positionId = '';
        let trader = '';

        const innerBlockEnd = futureStr.indexOf('},');
        if (innerBlockEnd > -1) {
          const afterInnerBlock = futureStr.substring(innerBlockEnd + 2);
          const posIdMatch = afterInnerBlock.match(/(\d{30,})field/);
          if (posIdMatch) positionId = posIdMatch[0];
          const traderMatch = afterInnerBlock.match(/(aleo1[a-z0-9]+)/);
          if (traderMatch) trader = traderMatch[1];
        }

        const afterBlock = innerBlockEnd > -1 ? futureStr.substring(innerBlockEnd + 2) : '';
        const outerU64Matches = afterBlock.match(/(\d+)u64/g) || [];
        const outerU64Values = outerU64Matches.map((m: string) => BigInt(m.replace('u64', '')));

        let entryPrice = 0n, sizeUsdc = 0n, collateralUsdc = 0n;
        if (outerU64Values.length >= 3) {
          sizeUsdc = outerU64Values[1];
          entryPrice = outerU64Values[2];
          collateralUsdc = outerU64Values.length >= 6 ? outerU64Values[5] : outerU64Values[0];
        }

        const isLong = !afterBlock.includes('\n    false') && !afterBlock.match(/,\s*false\s*,/);

        if (positionId && sizeUsdc > 0n && entryPrice > 0n) {
          if (collateralUsdc === 0n) collateralUsdc = sizeUsdc / 10n - sizeUsdc / 10000n;
          return { positionId, trader, isLong, sizeUsdc, collateralUsdc, entryPrice };
        }
      }
      return null;
    } catch (err) {
      console.error('Parse error:', err);
      return null;
    }
  };

  useEffect(() => {
    if (!position || currentPrice === 0n) { setCalculation(null); return; }
    setCalculation(calcLiquidation(position, currentPrice));
  }, [position, currentPrice]);

  const handleFetch = () => { if (txId.trim()) fetchTransaction(txId); };
  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && txId.trim()) fetchTransaction(txId); };

  const formatUsdcDisplay = (value: bigint) => (Number(value) / 1_000_000).toFixed(2);
  const formatPriceDisplay = (value: bigint) => (Number(value) / 100_000_000).toLocaleString();
  const isLiquidateBusy = liquidateTx.status === 'submitting' || liquidateTx.status === 'pending';

  const Spinner = ({ size = 4 }: { size?: number }) => (
    <svg className={`animate-spin h-${size} w-${size}`} viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-2">Liquidations</h1>
        <p className="text-gray-400">
          Liquidate underwater positions to earn 0.5% rewards. Anyone can liquidate.
        </p>
      </div>

      {/* Bot Control Panel */}
      <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5 mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-2.5 h-2.5 rounded-full ${
              botStatus?.status === 'unreachable' ? 'bg-gray-500' :
              botStatus?.running ? 'bg-zkperp-green animate-pulse' : 'bg-red-500'
            }`} />
            <div>
              <p className="text-sm font-medium text-white">Oracle &amp; Liquidation Bot</p>
              <p className="text-xs text-gray-500">
                {botStatus?.status === 'unreachable'
                  ? 'Manager unreachable — is zkperp-bot-manager running on port 3000?'
                  : !botStatus?.running
                  ? `Stopped${botStatus?.stoppedAt ? ` · last ran ${new Date(botStatus.stoppedAt).toLocaleTimeString()}` : ''}`
                  : botStatus?.currentPrice
                  ? `Running · BTC $${(Number(botStatus.currentPrice) / 1e8).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · ${botStatus.positionCount ?? 0} position(s) tracked`
                  : `Running · PID ${botStatus.pid} · starting up...`}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
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
        </div>
        {botStatus?.lastScanAt && botStatus.running && (
          <p className="text-xs text-gray-600 mt-3">
            Last scan: {new Date(botStatus.lastScanAt).toLocaleTimeString()} · Updates on-chain when price moves &gt;1% · Restarts: {botStatus.restartCount}
          </p>
        )}
      </div>

      <div className="grid md:grid-cols-4 gap-4 mb-8">
        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
          <p className="text-gray-400 text-sm mb-1">BTC Price</p>
          <p className="text-2xl font-bold text-white">${formatPrice(currentPrice)}</p>
        </div>
        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
          <p className="text-gray-400 text-sm mb-1">Pool Liquidity</p>
          <p className="text-2xl font-bold text-white">${formatUsdc(poolLiquidity)}</p>
        </div>
        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
          <p className="text-gray-400 text-sm mb-1">Long OI</p>
          <p className="text-2xl font-bold text-zkperp-green">${formatUsdc(longOI)}</p>
        </div>
        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-5">
          <p className="text-gray-400 text-sm mb-1">Short OI</p>
          <p className="text-2xl font-bold text-zkperp-red">${formatUsdc(shortOI)}</p>
        </div>
      </div>

      {(error || orchError) && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 mb-6">
          <p className="text-red-400 text-sm">{error || orchError}</p>
        </div>
      )}

      {/* Tab Selector */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setActiveTab('orchestrator')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            activeTab === 'orchestrator'
              ? 'bg-zkperp-accent text-white'
              : 'bg-zkperp-card border border-zkperp-border text-gray-400 hover:text-white'
          }`}
        >
          🔑 Orchestrator Mode
        </button>
        <button
          onClick={() => setActiveTab('txid')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            activeTab === 'txid'
              ? 'bg-zkperp-accent text-white'
              : 'bg-zkperp-card border border-zkperp-border text-gray-400 hover:text-white'
          }`}
        >
          🔍 TX ID Lookup
        </button>
      </div>

      {/* ORCHESTRATOR MODE */}
      {activeTab === 'orchestrator' && (
        <div className="bg-zkperp-card rounded-xl border border-zkperp-border overflow-hidden">
          <div className="p-5 border-b border-zkperp-border flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-white">Orchestrator Dashboard</h2>
              <p className="text-gray-500 text-sm mt-1">
                Decrypt your LiquidationAuth records to monitor all positions
              </p>
            </div>
            <button
              onClick={fetchLiqAuths}
              disabled={orchLoading || !connected}
              className="px-4 py-2 bg-zkperp-accent hover:bg-zkperp-accent/80 disabled:bg-zkperp-accent/30 rounded-lg text-sm font-medium text-white transition-colors"
            >
              {orchLoading ? (
                <span className="flex items-center gap-2">
                  <Spinner />
                  Decrypting...
                </span>
              ) : (
                '🔓 Scan Positions'
              )}
            </button>
          </div>

          {/* Progress hint while loading */}
          {orchLoading && (
            <div className="px-5 py-3 bg-zkperp-accent/5 border-b border-zkperp-border">
              <p className="text-sm text-zkperp-accent flex items-center gap-2">
                <Spinner />
                Fetching positions from bot API...
              </p>
            </div>
          )}

          {liqAuths.length > 0 ? (
            <div className="divide-y divide-zkperp-border">
              {liqAuths.map((auth) => (
                <div key={auth.positionId} className="p-5 hover:bg-zkperp-dark/50 transition-colors">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        auth.isLong ? 'bg-zkperp-green/20 text-zkperp-green' : 'bg-zkperp-red/20 text-zkperp-red'
                      }`}>
                        {auth.isLong ? 'LONG' : 'SHORT'}
                      </span>
                      <span className="text-white font-medium">BTC/USD</span>
                      <span className={`ml-2 px-2 py-0.5 rounded text-xs font-bold ${
                        auth.isLiquidatable ? 'bg-red-500/20 text-red-400' : 'bg-green-500/20 text-green-400'
                      }`}>
                        {auth.isLiquidatable ? '⚠️ LIQUIDATABLE' : '✓ HEALTHY'}
                      </span>
                    </div>
                    <span className={`font-medium text-sm ${
                      auth.marginRatio < 1 ? 'text-red-400' : auth.marginRatio < 5 ? 'text-yellow-400' : 'text-green-400'
                    }`}>
                      {auth.marginRatio.toFixed(2)}% margin
                    </span>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-3">
                    <div>
                      <p className="text-gray-500">Size</p>
                      <p className="text-white">${formatUsdcDisplay(auth.sizeUsdc)}</p>
                    </div>
                    <div>
                      <p className="text-gray-500">Collateral</p>
                      <p className="text-white">${formatUsdcDisplay(auth.collateralUsdc)}</p>
                    </div>
                    <div>
                      <p className="text-gray-500">Entry Price</p>
                      <p className="text-white">${formatPriceDisplay(auth.entryPrice)}</p>
                    </div>
                    <div>
                      <p className="text-gray-500">PnL</p>
                      <p className={auth.pnl >= 0n ? 'text-zkperp-green' : 'text-zkperp-red'}>
                        {auth.pnl >= 0n ? '+' : '-'}${formatUsdc(auth.pnl >= 0n ? auth.pnl : -auth.pnl)}
                      </p>
                    </div>
                  </div>

                  <div className="text-xs text-gray-600 mb-3 font-mono truncate">
                    Trader: {auth.trader}
                  </div>

                  {auth.isLiquidatable && (
                    <button
                      onClick={() => executeLiquidation(auth)}
                      disabled={isLiquidateBusy || liquidatingId === auth.positionId}
                      className="w-full py-2 bg-zkperp-red hover:bg-zkperp-red/80 disabled:bg-zkperp-red/30 rounded-lg text-sm font-semibold text-white transition-colors"
                    >
                      {liquidatingId === auth.positionId ? (
                        <span className="flex items-center justify-center gap-2">
                          <Spinner />
                          Liquidating...
                        </span>
                      ) : (
                        `Liquidate & Earn $${formatUsdc(auth.reward)}`
                      )}
                    </button>
                  )}

                  {liquidatingId === auth.positionId && (
                    <div className="mt-2">
                      <TransactionStatus
                        status={liquidateTx.status}
                        tempTxId={liquidateTx.tempTxId}
                        onChainTxId={liquidateTx.onChainTxId}
                        error={liquidateTx.error}
                        onDismiss={liquidateTx.reset}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : !orchLoading ? (
            <div className="p-8 text-center">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-zkperp-dark flex items-center justify-center">
                <span className="text-2xl">🔑</span>
              </div>
              <p className="text-gray-500">No LiquidationAuth records found</p>
              <p className="text-sm text-gray-600 mt-1">Click "Scan Positions" to decrypt your orchestrator records</p>
            </div>
          ) : null}
        </div>
      )}

      {/* TX ID LOOKUP */}
      {activeTab === 'txid' && (
        <>
          <div className="bg-zkperp-card rounded-xl border border-zkperp-border overflow-hidden">
            <div className="p-5 border-b border-zkperp-border">
              <h2 className="font-semibold text-white">Liquidate by Transaction ID</h2>
              <p className="text-gray-500 text-sm mt-1">
                Paste the open_position transaction ID to load position details
              </p>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-2">Transaction ID</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={txId}
                    onChange={(e) => setTxId(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="at1mlv2xx0l9zkm6ta0tndhsnnvf3x3zq7us4amvrh2tv3mlc73dsyq3cashq"
                    className="flex-1 bg-zkperp-dark border border-zkperp-border rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:outline-none focus:border-zkperp-accent font-mono text-sm"
                  />
                  <button
                    onClick={handleFetch}
                    disabled={!txId.trim() || fetching}
                    className="px-6 py-3 bg-zkperp-accent hover:bg-zkperp-accent/80 disabled:bg-zkperp-accent/30 rounded-lg font-medium text-white transition-colors"
                  >
                    {fetching ? 'Loading...' : 'Fetch'}
                  </button>
                </div>
              </div>

              {position && (
                <div className="bg-zkperp-dark rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-gray-400 text-sm font-medium">Position Details</p>
                    <span className={`px-2 py-1 rounded text-xs font-medium ${
                      position.isLong ? 'bg-zkperp-green/20 text-zkperp-green' : 'bg-zkperp-red/20 text-zkperp-red'
                    }`}>
                      {position.isLong ? 'LONG' : 'SHORT'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-gray-500">Position ID</p>
                      <p className="text-white font-mono text-xs truncate" title={position.positionId}>
                        {position.positionId.slice(0, 20)}...{position.positionId.slice(-10)}
                      </p>
                    </div>
                    <div>
                      <p className="text-gray-500">Size</p>
                      <p className="text-white">${formatUsdcDisplay(position.sizeUsdc)} USDC</p>
                    </div>
                    <div>
                      <p className="text-gray-500">Collateral</p>
                      <p className="text-white">${formatUsdcDisplay(position.collateralUsdc)} USDC</p>
                    </div>
                    <div>
                      <p className="text-gray-500">Entry Price</p>
                      <p className="text-white">${formatPriceDisplay(position.entryPrice)}</p>
                    </div>
                  </div>
                </div>
              )}

              {calculation && (
                <div className={`rounded-lg p-4 ${
                  calculation.isLiquidatable ? 'bg-red-500/10 border border-red-500/30' : 'bg-green-500/10 border border-green-500/30'
                }`}>
                  <div className="flex items-center gap-2 mb-3">
                    <span className={`text-lg font-semibold ${calculation.isLiquidatable ? 'text-red-400' : 'text-green-400'}`}>
                      {calculation.isLiquidatable ? '⚠️ LIQUIDATABLE' : '✓ HEALTHY'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-gray-400">Current Price</p>
                      <p className="text-white font-medium">${formatPrice(currentPrice)}</p>
                    </div>
                    <div>
                      <p className="text-gray-400">PnL</p>
                      <p className={`font-medium ${calculation.pnl >= 0n ? 'text-zkperp-green' : 'text-zkperp-red'}`}>
                        {calculation.pnl >= 0n ? '+' : '-'}${formatUsdc(calculation.pnl >= 0n ? calculation.pnl : -calculation.pnl)}
                      </p>
                    </div>
                    <div>
                      <p className="text-gray-400">Margin Ratio</p>
                      <p className={`font-medium ${calculation.marginRatio < 1 ? 'text-red-400' : 'text-white'}`}>
                        {calculation.marginRatio.toFixed(2)}%
                        <span className="text-gray-500 text-xs ml-1">(threshold: 1%)</span>
                      </p>
                    </div>
                    <div>
                      <p className="text-gray-400">Liquidator Reward</p>
                      <p className="text-zkperp-accent font-medium">${formatUsdc(calculation.reward)}</p>
                    </div>
                  </div>
                </div>
              )}

              <TransactionStatus
                status={liquidateTx.status}
                tempTxId={liquidateTx.tempTxId}
                onChainTxId={liquidateTx.onChainTxId}
                error={liquidateTx.error}
                onDismiss={liquidateTx.reset}
              />

              <button
                onClick={() => position && executeLiquidation(position)}
                disabled={!connected || !calculation?.isLiquidatable || isLiquidateBusy || !position}
                className={`w-full py-4 rounded-lg font-semibold text-lg transition-colors ${
                  calculation?.isLiquidatable ? 'bg-zkperp-red hover:bg-zkperp-red/80 text-white' : 'bg-gray-600 text-gray-400 cursor-not-allowed'
                }`}
              >
                {isLiquidateBusy ? (
                  <span className="flex items-center justify-center gap-2">
                    <Spinner size={5} />
                    {liquidateTx.status === 'submitting' ? 'Submitting...' : 'Confirming on-chain...'}
                  </span>
                ) : !connected ? 'Connect Wallet'
                  : !position ? 'Enter Transaction ID'
                  : !calculation?.isLiquidatable ? 'Position Not Liquidatable'
                  : `Liquidate & Earn $${formatUsdc(calculation.reward)}`}
              </button>
            </div>
          </div>

          {/* Manual Override */}
          <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6 mt-6">
            <h3 className="font-semibold text-white mb-2">Manual Override</h3>
            <p className="text-gray-500 text-sm mb-4">If auto-fetch doesn't parse correctly, manually enter the exact values:</p>
            <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Position ID</label>
                <input type="text" placeholder="123...field"
                  className="w-full bg-zkperp-dark border border-zkperp-border rounded px-3 py-2 text-white text-sm font-mono"
                  onChange={(e) => setPosition(prev => ({
                    positionId: e.target.value, trader: prev?.trader ?? '', isLong: prev?.isLong ?? true,
                    sizeUsdc: prev?.sizeUsdc ?? 0n, collateralUsdc: prev?.collateralUsdc ?? 0n, entryPrice: prev?.entryPrice ?? 0n,
                  }))}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Size (USDC)</label>
                <input type="number" placeholder="50" className="w-full bg-zkperp-dark border border-zkperp-border rounded px-3 py-2 text-white text-sm"
                  onChange={(e) => { const val = BigInt(Math.floor(parseFloat(e.target.value || '0') * 1_000_000)); setPosition(prev => prev ? { ...prev, sizeUsdc: val } : null); }} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Collateral</label>
                <input type="number" placeholder="4.95" className="w-full bg-zkperp-dark border border-zkperp-border rounded px-3 py-2 text-white text-sm"
                  onChange={(e) => { const val = BigInt(Math.floor(parseFloat(e.target.value || '0') * 1_000_000)); setPosition(prev => prev ? { ...prev, collateralUsdc: val } : null); }} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Entry Price</label>
                <input type="number" placeholder="100000" className="w-full bg-zkperp-dark border border-zkperp-border rounded px-3 py-2 text-white text-sm"
                  onChange={(e) => { const val = BigInt(Math.floor(parseFloat(e.target.value || '0') * 100_000_000)); setPosition(prev => prev ? { ...prev, entryPrice: val } : null); }} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Direction</label>
                <select className="w-full bg-zkperp-dark border border-zkperp-border rounded px-3 py-2 text-white text-sm"
                  onChange={(e) => setPosition(prev => prev ? { ...prev, isLong: e.target.value === 'true' } : null)}>
                  <option value="true">LONG</option>
                  <option value="false">SHORT</option>
                </select>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Info Cards */}
      <div className="grid md:grid-cols-2 gap-6 mt-6">
        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
          <h3 className="font-semibold text-white mb-4">How It Works</h3>
          <ul className="space-y-3 text-sm text-gray-400">
            <li className="flex gap-2">
              <span className="text-zkperp-accent">1.</span>
              <span><strong>Orchestrator Mode:</strong> Fetches pre-decrypted positions from the bot API — no wallet prompts</span>
            </li>
            <li className="flex gap-2">
              <span className="text-zkperp-accent">2.</span>
              <span><strong>TX ID Mode:</strong> Paste any open_position TX ID to check a specific position</span>
            </li>
            <li className="flex gap-2">
              <span className="text-zkperp-accent">3.</span>
              If margin ratio is below 1%, you can liquidate
            </li>
            <li className="flex gap-2">
              <span className="text-zkperp-accent">4.</span>
              Earn 0.5% of position size as reward
            </li>
          </ul>
        </div>

        <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
          <h3 className="font-semibold text-white mb-4">Dual-Record Architecture</h3>
          <ul className="space-y-3 text-sm text-gray-400">
            <li className="flex gap-2">
              <span className="text-zkperp-accent">•</span>
              <span><strong>PositionSlot</strong> record → owned by trader (for closing)</span>
            </li>
            <li className="flex gap-2">
              <span className="text-zkperp-accent">•</span>
              <span><strong>LiquidationAuth</strong> record → owned by orchestrator (for liquidating)</span>
            </li>
            <li className="flex gap-2">
              <span className="text-zkperp-accent">•</span>
              Position details stay private — only record owners can decrypt
            </li>
            <li className="flex gap-2">
              <span className="text-zkperp-accent">•</span>
              Anyone can call liquidate, but only orchestrator knows position details
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
