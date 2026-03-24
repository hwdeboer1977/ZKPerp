import { useState, useCallback, useEffect } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import type { TransactionOptions } from '@provablehq/aleo-types';
import { useTransaction } from '@/hooks/useTransaction';
import { TransactionStatus } from '@/components/TransactionStatus';
import { useSlots, type PositionSlotRecord } from '@/hooks/useSlots';
import { getPair } from '@/config/pairs';
import type { PairId } from '@/config/pairs';
import { useOrderReceipts } from '@/hooks/useOrderReceipts';
import {
  formatUsdc,
  formatPrice,
  calculatePnL,
  calculateLeverage,
  generateNonce,
  parsePrice,
} from '@/utils/aleo';

interface Props {
  pair: PairId;
  currentPrice: bigint;
  // Shared state from TradePage
  positionSlots: ReturnType<typeof useSlots>['positionSlots'];
  recordCount: ReturnType<typeof useSlots>['recordCount'];
  loading: ReturnType<typeof useSlots>['loading'];
  decrypting: ReturnType<typeof useSlots>['decrypting'];
  decrypted: ReturnType<typeof useSlots>['decrypted'];
  error: ReturnType<typeof useSlots>['error'];
  markSpent: ReturnType<typeof useSlots>['markSpent'];
  needsInitialization: ReturnType<typeof useSlots>['needsInitialization'];
  // Unshield button callback
  onUnshield: () => void;
  unshieldBusy: boolean;
  unshieldLabel: string;
  allDecrypted: boolean;
  unshieldError: string | null;
}

const ALEO_API = 'https://api.explorer.provable.com/v1/testnet';
const BOT_API = (import.meta as any).env?.VITE_BOT_API || 'http://localhost:3001';

export function PositionDisplay({
  pair, currentPrice,
  positionSlots, recordCount, loading, decrypted, error,
  markSpent, needsInitialization,
  onUnshield, unshieldBusy, unshieldLabel, allDecrypted, unshieldError,
}: Props) {
  const pairConfig = getPair(pair);
  const PROGRAM_ID = pairConfig.programId;
  const { connected, address } = useWallet();
  const closeTx = useTransaction();
  const tpTx = useTransaction();
  const slTx = useTransaction();
  const cancelTx = useTransaction();

  // Receipts needed for TP/SL cancel
  const { receipts: orderReceipts } = useOrderReceipts();



  const [closingId, setClosingId] = useState<string | null>(null);
  const [tpSlotId, setTpSlotId] = useState<string | null>(null);
  const [slSlotId, setSlSlotId] = useState<string | null>(null);
  const [cancellingOrderKey, setCancellingOrderKey] = useState<string | null>(null);
  const [_pendingCancelData, setPendingCancelData] = useState<{positionId: string, orderType: 'tp'|'sl'} | null>(null);
  // Per-position TP/SL price inputs (keyed by slot.id)
  const [tpInputs, setTpInputs] = useState<Record<string, string>>({});
  const [slInputs, setSlInputs] = useState<Record<string, string>>({});
  // Pending confirmations — saved to localStorage only after chain confirms
  const [pendingTp, setPendingTp] = useState<{positionId: string; triggerInput: string; nonce: string} | null>(null);
  const [pendingSl, setPendingSl] = useState<{positionId: string; triggerInput: string; nonce: string} | null>(null);
  // Active orders stored in localStorage: positionId → {tp?: price, sl?: price, tpOrderId?, slOrderId?}
  const [activeOrders, setActiveOrders] = useState<Record<string, {
    tp?: string; sl?: string; tpOrderId?: string; slOrderId?: string;
    tpNonce?: string; slNonce?: string;
  }>>(() => {
    try { return JSON.parse(localStorage.getItem('zkperp_orders') || '{}'); }
    catch { return {}; }
  });


  // Save TP to localStorage only after chain confirms, then fetch orderId from bot
  useEffect(() => {
    if (tpTx.status === 'accepted' && pendingTp) {
      const { positionId, triggerInput, nonce } = pendingTp;
      // Save TP price immediately on accepted
      const updated = {
        ...activeOrders,
        [positionId]: { ...activeOrders[positionId], tp: triggerInput },
      };
      saveOrders(updated);
      setPendingTp(null);
      // Poll bot for orderId using nonce (bot scans PendingOrder which has nonce field)
      if (nonce) {
        (async () => {
          for (let i = 0; i < 12; i++) {
            await new Promise(r => setTimeout(r, 10000));
            try {
              const r = await fetch(`${BOT_API}/api/order-by-nonce/${nonce}`);
              const data = await r.json();
              if (data.orderId) {
                const withId = {
                  ...activeOrders,
                  [positionId]: { ...activeOrders[positionId], tp: triggerInput, tpOrderId: data.orderId },
                };
                saveOrders(withId);
                console.log('TP orderId stored:', data.orderId.slice(0, 20));
                break;
              }
            } catch {}
          }
        })();
      }
    }
    if (tpTx.status === 'error' && pendingTp) {
      setPendingTp(null);
    }
  }, [tpTx.status, pendingTp]);

  // Save SL to localStorage only after chain confirms, then fetch orderId from bot
  useEffect(() => {
    if (slTx.status === 'accepted' && pendingSl) {
      const { positionId, triggerInput, nonce } = pendingSl;
      const updated = {
        ...activeOrders,
        [positionId]: { ...activeOrders[positionId], sl: triggerInput },
      };
      saveOrders(updated);
      setPendingSl(null);
      if (nonce) {
        (async () => {
          for (let i = 0; i < 12; i++) {
            await new Promise(r => setTimeout(r, 10000));
            try {
              const r = await fetch(`${BOT_API}/api/order-by-nonce/${nonce}`);
              const data = await r.json();
              if (data.orderId) {
                const withId = {
                  ...activeOrders,
                  [positionId]: { ...activeOrders[positionId], sl: triggerInput, slOrderId: data.orderId },
                };
                saveOrders(withId);
                console.log('SL orderId stored:', data.orderId.slice(0, 20));
                break;
              }
            } catch {}
          }
        })();
      }
    }
    if (slTx.status === 'error' && pendingSl) {
      setPendingSl(null);
    }
  }, [slTx.status, pendingSl]);

  const saveOrders = (updated: typeof activeOrders) => {
    setActiveOrders(updated);
    localStorage.setItem('zkperp_orders', JSON.stringify(updated));
  };

  const [manualPositions] = useState<PositionSlotRecord[]>([]);

  // Only show open slots (is_open === true)
  const openSlots = positionSlots.filter(s => s.isOpen);

  // Cancel TP or SL
  const handleCancelOrder = useCallback(async (
    positionId: string,
    orderType: 'tp' | 'sl',
  ) => {
    if (!connected || !address) return;
    const order = activeOrders[positionId];
    if (!order) return;

    const slot = positionSlots.find(s => s.positionId === positionId && s.isOpen);
    if (!slot?.plaintext) {
      alert('Cancel failed: PositionSlot not available — try refreshing positions');
      return;
    }

    const orderId = orderType === 'tp' ? order.tpOrderId : order.slOrderId;
    const receipt = orderId
      ? orderReceipts.find(r => r.orderId === orderId)
      : orderReceipts.find(r => r.positionId === positionId && r.orderType === (orderType === 'tp' ? 1 : 2));

    if (!receipt?.plaintext) {
      alert('Cancel failed: OrderReceipt not found — try refreshing the page');
      return;
    }

    const compact = (pt: string) => pt.substring(pt.indexOf('{'))
      .replace(/:\s+/g, ':').replace(/,\s+/g, ',')
      .replace(/\s*{\s*/g, '{').replace(/\s*}\s*/g, '}').trim();

    const key = `${positionId}-${orderType}`;
    setCancellingOrderKey(key);

    try {
      await cancelTx.execute({
        program: PROGRAM_ID,
        function: 'cancel_tp_sl',
        inputs: [compact(slot.plaintext), compact(receipt.plaintext)],
        fee: 3_000_000,
        privateFee: false,
      });

      setPendingCancelData({ positionId, orderType });
      const pollCancel = async () => {
        const checkId = receipt.orderId;
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 5000));
          try {
            const check = await fetch(`${ALEO_API}/program/${PROGRAM_ID}/mapping/pending_orders/${checkId}`);
            const val = await check.text();
            if (!val || val.includes('null') || val.includes('false')) {
              const updated = { ...activeOrders, [positionId]: { ...order } };
              if (orderType === 'tp') { delete updated[positionId].tp; delete updated[positionId].tpOrderId; }
              else { delete updated[positionId].sl; delete updated[positionId].slOrderId; }
              saveOrders(updated);
              setPendingCancelData(null);
              setCancellingOrderKey(null);
              return;
            }
          } catch {}
        }
        setPendingCancelData(null);
        setCancellingOrderKey(null);
      };
      pollCancel();
    } catch (err) {
      console.error('Cancel failed:', err);
      setCancellingOrderKey(null);
    }
  }, [connected, address, activeOrders, positionSlots, orderReceipts, cancelTx]);

  // Place Take Profit
  const handlePlaceTp = useCallback(async (slot: PositionSlotRecord) => {
    if (!connected || !address) return;
    const triggerInput = tpInputs[slot.id];
    if (!triggerInput) return;
    const triggerPrice = parsePrice(triggerInput);
    if (triggerPrice <= 0n) return;

    setTpSlotId(slot.id);
    try {
      const orchestratorRes = await fetch(
        `https://api.explorer.provable.com/v1/testnet/program/${PROGRAM_ID}/mapping/roles/1u8`
      );
      const orchestrator = (await orchestratorRes.json()).replace(/"/g, '');
      const nonce = generateNonce();

      const inputs = [
        slot.plaintext,                    // slot: PositionSlot
        `${triggerPrice}u64`,              // trigger_price: u64
        orchestrator,                      // orchestrator: address
        nonce,                             // nonce: field
      ];

      console.log('place_take_profit inputs:', inputs);

      await tpTx.execute({
        program: PROGRAM_ID,
        function: 'place_take_profit',
        inputs,
        fee: 4_000_000,
        privateFee: false,
      });


      // Queue for localStorage save — only persisted after chain confirms
      setPendingTp({ positionId: slot.positionId, triggerInput, nonce });
      setTpInputs(prev => ({ ...prev, [slot.id]: '' }));
    } catch (err) {
      console.error('place_take_profit failed:', err);
    } finally {
      setTpSlotId(null);
    }
  }, [connected, address, tpInputs, tpTx, activeOrders]);

  // Place Stop Loss
  const handlePlaceSl = useCallback(async (slot: PositionSlotRecord) => {
    if (!connected || !address) return;
    const triggerInput = slInputs[slot.id];
    if (!triggerInput) return;
    const triggerPrice = parsePrice(triggerInput);
    if (triggerPrice <= 0n) return;

    setSlSlotId(slot.id);
    try {
      const orchestratorRes = await fetch(
        `https://api.explorer.provable.com/v1/testnet/program/${PROGRAM_ID}/mapping/roles/1u8`
      );
      const orchestrator = (await orchestratorRes.json()).replace(/"/g, '');
      const nonce = generateNonce();

      const inputs = [
        slot.plaintext,                    // slot: PositionSlot
        `${triggerPrice}u64`,              // trigger_price: u64
        orchestrator,                      // orchestrator: address
        nonce,                             // nonce: field
      ];

      console.log('place_stop_loss inputs:', inputs);

      await slTx.execute({
        program: PROGRAM_ID,
        function: 'place_stop_loss',
        inputs,
        fee: 4_000_000,
        privateFee: false,
      });


      // Queue for localStorage save — only persisted after chain confirms
      setPendingSl({ positionId: slot.positionId, triggerInput, nonce });
      setSlInputs(prev => ({ ...prev, [slot.id]: '' }));
    } catch (err) {
      console.error('place_stop_loss failed:', err);
    } finally {
      setSlSlotId(null);
    }
  }, [connected, address, slInputs, slTx, activeOrders]);

  // Close position using the slot's plaintext
  const handleClose = useCallback(async (slot: PositionSlotRecord) => {
    if (!connected) return;

    setClosingId(slot.id);
    try {
      const slippageAmount = (currentPrice * 1n) / 100n;
      const minPrice = currentPrice - slippageAmount;
      const maxPrice = currentPrice + slippageAmount;

      const priceDiff = currentPrice > slot.entryPrice
        ? currentPrice - slot.entryPrice
        : slot.entryPrice - currentPrice;
      const safeEntryPrice = slot.entryPrice + 1n;
      const pnlAbs = (slot.sizeUsdc * priceDiff) / safeEntryPrice;
      const isProfit = slot.isLong
        ? currentPrice > slot.entryPrice
        : currentPrice < slot.entryPrice;

      let expectedPayout: bigint;
      if (isProfit) {
        expectedPayout = slot.collateralUsdc + pnlAbs;
      } else {
        expectedPayout = pnlAbs >= slot.collateralUsdc
          ? BigInt(0)
          : slot.collateralUsdc - pnlAbs;
      }

      // 10% safety buffer
      expectedPayout = (expectedPayout * BigInt(90)) / BigInt(100);
      if (expectedPayout < BigInt(1)) expectedPayout = BigInt(1);

      console.log('=== CLOSE POSITION (slot-based) ===');
      console.log('Slot ID:', slot.slotId);
      console.log('Position ID:', slot.positionId);
      console.log('Plaintext:', slot.plaintext);
      console.log('Min price:', minPrice.toString());
      console.log('Max price:', maxPrice.toString());
      console.log('Expected payout:', expectedPayout.toString());

      const inputs = [
        slot.plaintext,
        `${minPrice}u64`,
        `${maxPrice}u64`,
        `${expectedPayout}u128`,
      ];

      const options: TransactionOptions = {
        program: PROGRAM_ID,
        function: 'close_position',
        inputs,
        fee: 5_000_000,
        privateFee: false,
      };

      await closeTx.execute(options);

      // Mark slot as spent so it disappears from UI immediately
      markSpent(slot.id);
    } catch (err) {
      console.error('Close failed:', err);
    } finally {
      setClosingId(null);
    }
  }, [connected, currentPrice, closeTx, markSpent]);

  if (!connected) {
    return (
      <div className="bg-zkperp-card rounded-xl border border-zkperp-border p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Your Positions</h2>
        <p className="text-gray-500 text-center py-8">Connect your wallet to view positions</p>
      </div>
    );
  }

  const isCloseBusy = closeTx.status === 'submitting' || closeTx.status === 'pending';
  const isTpBusy = tpTx.status === 'submitting' || tpTx.status === 'pending';
  const isSlBusy = slTx.status === 'submitting' || slTx.status === 'pending';
  const isCancelBusy = cancelTx.status === 'submitting' || cancelTx.status === 'pending';

  // All positions to display: open slots from wallet + any manual additions
  const allOpenPositions = [
    ...openSlots,
    ...manualPositions.filter(m => !openSlots.some(s => s.positionId === m.positionId)),
  ];

  return (
    <>
    <div className="bg-zkperp-card rounded-xl border border-zkperp-border overflow-hidden">
      <div className="p-4 border-b border-zkperp-border">
        <h2 className="text-lg font-semibold text-white">Your Positions</h2>
      </div>

      {/* Needs initialization */}
      {needsInitialization && !loading && (
        <div className="p-4 text-center text-sm text-gray-500">
          No slots found. Initialize your position slots first.
        </div>
      )}

      {/* ── Unshield All button ── */}
      {!allDecrypted && !needsInitialization && (
        <div className="p-4">
          <button
            onClick={onUnshield}
            disabled={unshieldBusy || loading}
            className="w-full py-4 rounded-xl font-semibold text-base transition-all border-2
              bg-zkperp-accent/10 hover:bg-zkperp-accent/20
              border-zkperp-accent/60 hover:border-zkperp-accent
              text-zkperp-accent disabled:opacity-50 disabled:cursor-not-allowed
              whitespace-pre-line leading-snug"
          >
            {(unshieldBusy || loading) ? (
              <span className="flex items-center justify-center gap-3">
                <svg className="animate-spin h-5 w-5 flex-shrink-0" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                {unshieldLabel}
              </span>
            ) : unshieldLabel}
          </button>
          {unshieldError && (
            <p className="mt-2 text-xs text-zkperp-red text-center">{unshieldError}</p>
          )}
        </div>
      )}

      {/* Open positions */}
      {decrypted && allOpenPositions.length > 0 && (
        <div className="divide-y divide-zkperp-border">
          {allOpenPositions.map((slot) => {
            const pnl = calculatePnL(
              slot.entryPrice,
              currentPrice,
              slot.sizeUsdc,
              slot.isLong
            );
            const leverage = calculateLeverage(slot.collateralUsdc, slot.sizeUsdc);
            const isClosing = closingId === slot.id;

            return (
              <div key={slot.id} className="p-4 hover:bg-zkperp-dark/50 transition-colors">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      slot.isLong
                        ? 'bg-zkperp-green/20 text-zkperp-green'
                        : 'bg-zkperp-red/20 text-zkperp-red'
                    }`}>
                      {slot.isLong ? 'LONG' : 'SHORT'}
                    </span>
                    <span className="text-white font-medium">{pairConfig.label}</span>
                    <span className="text-gray-500 text-sm">{leverage.toFixed(1)}x</span>
                    <span className="text-gray-600 text-xs">Slot {slot.slotId}</span>
                  </div>
                  <span className={`font-medium ${pnl.isProfit ? 'text-zkperp-green' : 'text-zkperp-red'}`}>
                    {pnl.isProfit ? '+' : ''}{pnl.pnlPercent.toFixed(2)}%
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-4 text-sm mb-4">
                  <div>
                    <span className="text-gray-500">Size</span>
                    <p className="text-white">${formatUsdc(slot.sizeUsdc)}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">Collateral</span>
                    <p className="text-white">${formatUsdc(slot.collateralUsdc)}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">Entry Price</span>
                    <p className="text-white">${formatPrice(slot.entryPrice)}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">PnL (USDC)</span>
                    <p className={pnl.isProfit ? 'text-zkperp-green' : 'text-zkperp-red'}>
                      {pnl.isProfit ? '+' : ''}${pnl.pnl.toFixed(2)}
                    </p>
                  </div>
                </div>

                {/* ── Take Profit / Stop Loss ───────────────────────── */}
                {(() => {
                  const order = activeOrders[slot.positionId] || {};
                  const isTpActive = !!order.tp;
                  const isSlActive = !!order.sl;
                  const isPlacingTp = tpSlotId === slot.id;
                  const isPlacingSl = slSlotId === slot.id;

                  return (
                    <>
                    <div className="mb-3 space-y-2">
                      {/* Active order badges */}
                      {/* Pending confirmation badges */}
                      {(pendingTp?.positionId === slot.positionId || pendingSl?.positionId === slot.positionId) && (
                        <div className="flex gap-2 text-xs mb-1">
                          {pendingTp?.positionId === slot.positionId && (
                            <span className="flex items-center gap-1 px-2 py-1 rounded bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 animate-pulse">
                              ⏳ TP confirming...
                            </span>
                          )}
                          {pendingSl?.positionId === slot.positionId && (
                            <span className="flex items-center gap-1 px-2 py-1 rounded bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 animate-pulse">
                              ⏳ SL confirming...
                            </span>
                          )}
                        </div>
                      )}
                      {(isTpActive || isSlActive) && (
                        <div className="flex gap-2 text-xs">
                          {isTpActive && (
                            <span className="flex items-center gap-1 px-2 py-1 rounded bg-zkperp-green/10 border border-zkperp-green/30 text-zkperp-green">
                              {cancellingOrderKey === `${slot.positionId}-tp` ? (
                                <span className="text-xs opacity-60">Cancelling...</span>
                              ) : (
                                <>✓ TP ${order.tp}</>
                              )}
                              <button
                                onClick={() => handleCancelOrder(slot.positionId, 'tp')}
                                disabled={isCancelBusy}
                                className="ml-1 opacity-60 hover:opacity-100 disabled:opacity-20"
                                title="Cancel TP on-chain"
                              >×</button>
                            </span>
                          )}
                          {isSlActive && (
                            <span className="flex items-center gap-1 px-2 py-1 rounded bg-zkperp-red/10 border border-zkperp-red/30 text-zkperp-red">
                              {cancellingOrderKey === `${slot.positionId}-sl` ? (
                                <span className="text-xs opacity-60">Cancelling...</span>
                              ) : (
                                <>✓ SL ${order.sl}</>
                              )}
                              <button
                                onClick={() => handleCancelOrder(slot.positionId, 'sl')}
                                disabled={isCancelBusy}
                                className="ml-1 opacity-60 hover:opacity-100 disabled:opacity-20"
                                title="Cancel SL on-chain"
                              >×</button>
                            </span>
                          )}
                        </div>
                      )}

                      {/* TP input row */}
                      {!isTpActive && (
                        <div className="flex gap-2 items-center">
                          <div className="relative flex-1">
                            <input
                              type="number"
                              placeholder={`TP price (${slot.isLong ? 'above' : 'below'} entry)`}
                              value={tpInputs[slot.id] || ''}
                              onChange={e => setTpInputs(prev => ({ ...prev, [slot.id]: e.target.value }))}
                              disabled={isPlacingTp || isTpBusy}
                              className="w-full bg-zkperp-dark border border-zkperp-green/30 focus:border-zkperp-green rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none disabled:opacity-40"
                            />
                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zkperp-green">TP</span>
                          </div>
                          <button
                            onClick={() => handlePlaceTp(slot)}
                            disabled={!tpInputs[slot.id] || isPlacingTp || isTpBusy || isClosing}
                            className="px-3 py-1.5 bg-zkperp-green/20 hover:bg-zkperp-green/30 border border-zkperp-green/40 disabled:opacity-40 rounded-lg text-xs font-medium text-zkperp-green transition-colors whitespace-nowrap"
                          >
                            {isPlacingTp ? '...' : 'Set TP'}
                          </button>
                        </div>
                      )}

                      {/* SL input row */}
                      {!isSlActive && (
                        <div className="flex gap-2 items-center">
                          <div className="relative flex-1">
                            <input
                              type="number"
                              placeholder={`SL price (${slot.isLong ? 'below' : 'above'} entry)`}
                              value={slInputs[slot.id] || ''}
                              onChange={e => setSlInputs(prev => ({ ...prev, [slot.id]: e.target.value }))}
                              disabled={isPlacingSl || isSlBusy}
                              className="w-full bg-zkperp-dark border border-zkperp-red/30 focus:border-zkperp-red rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none disabled:opacity-40"
                            />
                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zkperp-red">SL</span>
                          </div>
                          <button
                            onClick={() => handlePlaceSl(slot)}
                            disabled={!slInputs[slot.id] || isPlacingSl || isSlBusy || isClosing}
                            className="px-3 py-1.5 bg-zkperp-red/20 hover:bg-zkperp-red/30 border border-zkperp-red/40 disabled:opacity-40 rounded-lg text-xs font-medium text-zkperp-red transition-colors whitespace-nowrap"
                          >
                            {isPlacingSl ? '...' : 'Set SL'}
                          </button>
                        </div>
                      )}

                      {/* TP/SL/Cancel tx status */}
                      {tpTx.status !== 'idle' && (
                        <TransactionStatus status={tpTx.status} tempTxId={tpTx.tempTxId} onChainTxId={tpTx.onChainTxId} error={tpTx.error} onDismiss={tpTx.reset} />
                      )}
                      {slTx.status !== 'idle' && (
                        <TransactionStatus status={slTx.status} tempTxId={slTx.tempTxId} onChainTxId={slTx.onChainTxId} error={slTx.error} onDismiss={slTx.reset} />
                      )}
                      {cancelTx.status !== 'idle' && cancellingOrderKey?.startsWith(slot.positionId) && (
                        <TransactionStatus status={cancelTx.status} tempTxId={cancelTx.tempTxId} onChainTxId={cancelTx.onChainTxId} error={cancelTx.error} onDismiss={cancelTx.reset} />
                      )}
                    </div>

                    {(isTpActive || isSlActive) && (
                      <p className="text-xs text-yellow-400 text-center py-1">
                        ⚠ Cancel {isTpActive && isSlActive ? 'TP & SL' : isTpActive ? 'TP' : 'SL'} first to close position
                      </p>
                    )}
                    <button
                      onClick={() => handleClose(slot)}
                      disabled={isClosing || isCloseBusy || isTpActive || isSlActive}
                      title={isTpActive || isSlActive ? 'Cancel TP/SL before closing' : undefined}
                      className="w-full py-2 bg-zkperp-dark border border-zkperp-border rounded-lg text-sm text-white hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {isClosing ? (
                        <span className="flex items-center justify-center gap-2">
                          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                          </svg>
                          Closing...
                        </span>
                      ) : (isTpActive || isSlActive) ? (
                        'Cancel TP/SL to close'
                      ) : (
                        'Close Position'
                      )}
                    </button>
                    </>
                  );
                })()}

                {isClosing && (
                  <div className="mt-2">
                    <TransactionStatus
                      status={closeTx.status}
                      tempTxId={closeTx.tempTxId}
                      onChainTxId={closeTx.onChainTxId}
                      error={closeTx.error}
                      onDismiss={closeTx.reset}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* No open positions after decrypt */}
      {decrypted && allOpenPositions.length === 0 && (
        <div className="p-8 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-zkperp-dark flex items-center justify-center">
            <svg className="w-8 h-8 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <p className="text-gray-500">No open positions</p>
          <p className="text-sm text-gray-600 mt-1">Open a trade to get started</p>
        </div>
      )}

      {/* Empty state before any fetch */}
      {recordCount === null && !loading && (
        <div className="p-8 text-center">
          <p className="text-gray-500">No open positions</p>
          <p className="text-sm text-gray-600 mt-1">Open a trade to get started</p>
        </div>
      )}

      {/* Close transaction status */}
      {closeTx.status !== 'idle' && !closingId && (
        <div className="p-4 border-t border-zkperp-border">
          <TransactionStatus
            status={closeTx.status}
            tempTxId={closeTx.tempTxId}
            onChainTxId={closeTx.onChainTxId}
            error={closeTx.error}
            onDismiss={closeTx.reset}
          />
        </div>
      )}

      {error && (
        <div className="p-4 bg-zkperp-red/10 border-t border-zkperp-red/30">
          <p className="text-zkperp-red text-sm">{error}</p>
        </div>
      )}
    </div>
    </>
  );
}


