import { useState, useCallback, useEffect } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import type { TransactionOptions } from '@provablehq/aleo-types';
import { useTransaction } from '@/hooks/useTransaction';
import { useSlots } from '@/hooks/useSlots';
import { useUSDCx } from '@/hooks/useUSDCx';
import { InitializeSlotsPrompt } from '@/components/InitializeSlotsPrompt';
import { TransactionStatus } from '@/components/TransactionStatus';
import {
  parseUsdc,
  parsePrice,
  formatUsdc,
  formatPrice,
  calculateLeverage,
  calculateLiquidationPrice,
  generateNonce,
  USDCX_PROGRAM_ID,
  SCALE,
} from '@/utils/aleo';
import { getMerkleProof } from '@/utils/merkleProof';
import { getPair } from '@/config/pairs';
import type { PairId } from '@/config/pairs';

interface Props {
  pair: PairId;
  currentPrice: bigint;
  // Shared state passed from TradePage — avoids duplicate hook instances
  positionSlots: ReturnType<typeof useSlots>['positionSlots'];
  recordCount: ReturnType<typeof useSlots>['recordCount'];
  slotsLoading: ReturnType<typeof useSlots>['loading'];
  decrypting: ReturnType<typeof useSlots>['decrypting'];
  decrypted: ReturnType<typeof useSlots>['decrypted'];
  initializeSlots: ReturnType<typeof useSlots>['initializeSlots'];
  getEmptyPositionSlot: ReturnType<typeof useSlots>['getEmptyPositionSlot'];
  isInitializing: ReturnType<typeof useSlots>['isInitializing'];
  initTx: ReturnType<typeof useSlots>['initTx'];
  markSpent: ReturnType<typeof useSlots>['markSpent'];
  usdcTokens: ReturnType<typeof useUSDCx>['tokens'];
  usdcTotal: ReturnType<typeof useUSDCx>['total'];
  usdcLoading: ReturnType<typeof useUSDCx>['loading'];
  usdcDecrypted: ReturnType<typeof useUSDCx>['decrypted'];
  fetchUSDCx: ReturnType<typeof useUSDCx>['fetchAndDecrypt'];
  markUSDCxSpent: ReturnType<typeof useUSDCx>['markSpent'];
}

function normalizeRecordPlaintext(plaintext: string): string {
  return plaintext
    .replace(/\s+/g, ' ')
    .replace(/{ /g, '{')
    .replace(/ }/g, '}')
    .replace(/,\s+/g, ',')
    .replace(/:\s+/g, ':')
    .trim();
}

export function TradingWidget({
  pair, currentPrice,
  positionSlots, recordCount, slotsLoading, decrypting, decrypted,
  initializeSlots, getEmptyPositionSlot, isInitializing, initTx, markSpent,
  usdcTokens, usdcTotal, usdcLoading, usdcDecrypted, markUSDCxSpent,
}: Props) {
  const pairConfig = getPair(pair);
  const PROGRAM_ID = pairConfig.programId;

  const { address, connected } = useWallet();
  const openTx = useTransaction();
  const limitTx = useTransaction();

  const [orderMode, setOrderMode] = useState<'market' | 'limit'>('market');
  const [isLong, setIsLong] = useState(true);
  const [limitIsLong, setLimitIsLong] = useState(true);
  const [triggerPriceInput, setTriggerPriceInput] = useState('');
  const [collateralInput, setCollateralInput] = useState('');
  const [sizeInput, setSizeInput] = useState('');
  const [slippagePercent, setSlippagePercent] = useState('0.5');

  const collateral = parseUsdc(collateralInput);
  const size = parseUsdc(sizeInput);
  const leverage = calculateLeverage(collateral, size);

  const slippage = parseFloat(slippagePercent) / 100;
  const maxSlippage = BigInt(Math.floor(Number(currentPrice) * slippage));

  const liquidationPrice = collateral > 0 && size > 0
    ? calculateLiquidationPrice(currentPrice, isLong, leverage)
    : BigInt(0);

  const openingFee = Number(size) * 0.001;

  const isValidLeverage = leverage > 0 && leverage <= 20;
  const isValidSize = size >= BigInt(100);
  const hasEmptySlot = decrypted && getEmptyPositionSlot(isLong) !== null;
  const positionSlotsAvailable = decrypted
    ? positionSlots.filter(s => !s.isOpen).length
    : 0;
  const bestUsdcToken = usdcTokens.find(t => t.amount >= collateral);
  const usdcReady = usdcDecrypted && bestUsdcToken !== undefined;

  const triggerPrice = parsePrice(triggerPriceInput);
  const limitSlot = decrypted ? getEmptyPositionSlot(limitIsLong) : null;
  const canLimitOrder = connected && isValidLeverage && isValidSize && collateral > 0
    && limitSlot !== null && usdcReady && triggerPrice > 0n;
  const isLimitBusy = limitTx.status === 'submitting' || limitTx.status === 'pending';

  const canTrade = connected && isValidLeverage && isValidSize && collateral > 0 && hasEmptySlot && usdcReady;
  const isBusy = openTx.status === 'submitting' || openTx.status === 'pending';

  // Reset form when switching pairs
  useEffect(() => {
    setCollateralInput('');
    setSizeInput('');
    setTriggerPriceInput('');
  }, [pair]);

  const handleSubmit = useCallback(async () => {
    if (!canTrade || !address) return;

    const slot = getEmptyPositionSlot(isLong);
    if (!slot) {
      console.error('No empty PositionSlot available');
      return;
    }

    try {
      const nonce = generateNonce();

      const orchestratorRes = await fetch(
        `https://api.explorer.provable.com/v1/testnet/program/${PROGRAM_ID}/mapping/roles/1u8`
      );
      const orchestrator = (await orchestratorRes.json()).replace(/"/g, '');

      const usdcToken = usdcTokens.find(t => t.amount >= collateral);
      if (!usdcToken) {
        console.error('No USDCx Token record covers collateral — scan USDCx records first');
        return;
      }

      console.log('USDCx token amount:', usdcToken.amount.toString());
      console.log('USDCx token plaintext:', usdcToken.plaintext.slice(0, 200));
      console.log('Collateral being passed:', collateral.toString() + 'u128');

      const merkleProof = await getMerkleProof(USDCX_PROGRAM_ID, address);

      const inputs = [
        normalizeRecordPlaintext(slot.plaintext),
        normalizeRecordPlaintext(usdcToken.plaintext),
        collateral.toString() + 'u128',
        size.toString() + 'u64',
        isLong.toString(),
        currentPrice.toString() + 'u64',
        maxSlippage.toString() + 'u64',
        nonce,
        address,
        orchestrator,
        merkleProof,
      ];

      console.log('Open position inputs:', inputs);

      const options: TransactionOptions = {
        program: PROGRAM_ID,
        function: 'open_position',
        inputs,
        fee: 5_000_000,
        privateFee: false,
      };

      await openTx.execute(options);
      markSpent(slot.id);
      markUSDCxSpent(usdcToken.id);
      setCollateralInput('');
      setSizeInput('');
    } catch (err) {
      console.error('Trade failed:', err);
    }
  }, [canTrade, address, collateral, size, isLong, currentPrice, maxSlippage,
      openTx, getEmptyPositionSlot, usdcTokens, markUSDCxSpent, PROGRAM_ID]);

  const handleLimitOrder = useCallback(async () => {
    if (!canLimitOrder || !address || !limitSlot) return;

    const usdcToken = usdcTokens.find(t => t.amount >= collateral);
    if (!usdcToken) { console.error('No USDCx Token covers collateral'); return; }

    try {
      const nonce = generateNonce();
      const orchestratorRes = await fetch(
        `https://api.explorer.provable.com/v1/testnet/program/${PROGRAM_ID}/mapping/roles/1u8`
      );
      const orchestrator = (await orchestratorRes.json()).replace(/"/g, '');
      const merkleProof = await getMerkleProof(USDCX_PROGRAM_ID, address);

      const inputs = [
        normalizeRecordPlaintext(limitSlot.plaintext),
        normalizeRecordPlaintext(usdcToken.plaintext),
        collateral.toString() + 'u128',
        size.toString() + 'u64',
        limitIsLong.toString(),
        triggerPrice.toString() + 'u64',
        orchestrator,
        nonce,
        merkleProof,
      ];

      console.log('place_limit_order inputs:', inputs);

      await limitTx.execute({
        program: PROGRAM_ID,
        function: 'place_limit_order',
        inputs,
        fee: 5_000_000,
        privateFee: false,
      });

      markSpent(limitSlot.id);
      markUSDCxSpent(usdcToken.id);
      setCollateralInput('');
      setSizeInput('');
      setTriggerPriceInput('');
    } catch (err) {
      console.error('place_limit_order failed:', err);
    }
  }, [canLimitOrder, address, limitSlot, collateral, size, limitIsLong, triggerPrice,
      limitTx, usdcTokens, markSpent, markUSDCxSpent, PROGRAM_ID]);

  const setLeverageQuick = (targetLeverage: number) => {
    if (collateral > BigInt(0)) {
      const newSize = (Number(collateral) / SCALE) * targetLeverage;
      setSizeInput(newSize.toString());
    }
  };

  const Spinner = () => (
    <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );

  return (
    <div>
      {connected && recordCount === 0 && !slotsLoading && (
        <InitializeSlotsPrompt
          onInitialize={initializeSlots}
          isInitializing={isInitializing}
          initTx={initTx}
        />
      )}

      <div className="bg-zkperp-card rounded-xl border border-zkperp-border overflow-hidden">
        <div className="flex border-b border-zkperp-border">
          <button
            onClick={() => { setOrderMode('market'); setIsLong(true); }}
            className={`flex-1 py-4 font-semibold transition-colors ${
              orderMode === 'market' && isLong
                ? 'bg-zkperp-green/10 text-zkperp-green border-b-2 border-zkperp-green'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            Long
          </button>
          <button
            onClick={() => { setOrderMode('market'); setIsLong(false); }}
            className={`flex-1 py-4 font-semibold transition-colors ${
              orderMode === 'market' && !isLong
                ? 'bg-zkperp-red/10 text-zkperp-red border-b-2 border-zkperp-red'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            Short
          </button>
          <button
            onClick={() => setOrderMode('limit')}
            className={`flex-1 py-4 font-semibold transition-colors ${
              orderMode === 'limit'
                ? 'bg-zkperp-accent/10 text-zkperp-accent border-b-2 border-zkperp-accent'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            Limit
          </button>
        </div>

        <div className="p-6 space-y-6">
          {orderMode === 'market' && (<>
          <div className="space-y-2">
            <label className="flex justify-between text-sm">
              <span className="text-gray-400">Collateral (USDC)</span>
              <span className="text-gray-500">Min: $0.0001</span>
            </label>
            <div className="relative">
              <input
                type="number"
                value={collateralInput}
                onChange={(e) => setCollateralInput(e.target.value)}
                placeholder="0.00"
                className="w-full bg-zkperp-dark border border-zkperp-border rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:outline-none focus:border-zkperp-accent"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500">USDC</span>
            </div>
          </div>

          <div className="space-y-2">
            <label className="flex justify-between text-sm">
              <span className="text-gray-400">Position Size (USDC)</span>
              <span className="text-gray-500">Max 20x leverage</span>
            </label>
            <div className="relative">
              <input
                type="number"
                value={sizeInput}
                onChange={(e) => setSizeInput(e.target.value)}
                placeholder="0.00"
                className="w-full bg-zkperp-dark border border-zkperp-border rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:outline-none focus:border-zkperp-accent"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500">USDC</span>
            </div>
          </div>

          <div className="flex gap-2">
            {[2, 5, 10, 20].map((lev) => (
              <button
                key={lev}
                onClick={() => setLeverageQuick(lev)}
                disabled={collateral <= BigInt(0)}
                className="flex-1 py-2 text-sm bg-zkperp-dark border border-zkperp-border rounded-lg text-gray-400 hover:text-white hover:border-zkperp-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {lev}x
              </button>
            ))}
          </div>

          <div className="space-y-2">
            <label className="text-sm text-gray-400">Slippage Tolerance</label>
            <div className="flex gap-2">
              {['0.1', '0.5', '1.0'].map((val) => (
                <button
                  key={val}
                  onClick={() => setSlippagePercent(val)}
                  className={`flex-1 py-2 text-sm rounded-lg border transition-colors ${
                    slippagePercent === val
                      ? 'bg-zkperp-accent/20 border-zkperp-accent text-zkperp-accent'
                      : 'bg-zkperp-dark border-zkperp-border text-gray-400 hover:border-gray-500'
                  }`}
                >
                  {val}%
                </button>
              ))}
              <input
                type="number"
                value={slippagePercent}
                onChange={(e) => setSlippagePercent(e.target.value)}
                className="w-20 bg-zkperp-dark border border-zkperp-border rounded-lg px-2 py-2 text-sm text-white text-center focus:outline-none focus:border-zkperp-accent"
              />
            </div>
          </div>

          <div className="bg-zkperp-dark rounded-lg p-4 space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Entry Price</span>
              <span className="text-white">${formatPrice(currentPrice)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Leverage</span>
              <span className={`font-medium ${!isValidLeverage && leverage > 0 ? 'text-zkperp-red' : 'text-white'}`}>
                {leverage.toFixed(2)}x{leverage > 20 && ' (max 20x)'}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Liquidation Price</span>
              <span className={isLong ? 'text-zkperp-red' : 'text-zkperp-green'}>
                ${formatPrice(liquidationPrice)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Opening Fee (0.1%)</span>
              <span className="text-gray-300">${formatUsdc(BigInt(Math.floor(openingFee)))}</span>
            </div>
            {decrypted && (
              <div className="flex justify-between text-sm pt-2 border-t border-zkperp-border">
                <span className="text-gray-400">Available Slots</span>
                <span className={hasEmptySlot ? 'text-zkperp-green' : 'text-zkperp-red'}>
                  {hasEmptySlot ? `${positionSlotsAvailable} / 2 free` : 'No slots available'}
                </span>
              </div>
            )}
          </div>

          <div className={`rounded-lg p-3 border text-sm ${
            usdcDecrypted && usdcTokens.length > 0
              ? 'bg-zkperp-green/5 border-zkperp-green/30'
              : 'bg-zkperp-dark border-zkperp-border'
          }`}>
            <div className="flex items-center justify-between">
              <div>
                <span className="text-gray-400">USDCx Balance</span>
                {usdcDecrypted
                  ? <span className="ml-2 text-white">${formatUsdc(usdcTotal)}</span>
                  : <span className="ml-2 text-gray-500 text-xs">Unshield to view</span>
                }
                {usdcDecrypted && !bestUsdcToken && collateral > 0n && (
                  <span className="ml-2 text-yellow-400 text-xs">
                    (largest record: ${formatUsdc(usdcTokens[0]?.amount ?? 0n)})
                  </span>
                )}
              </div>
            </div>
            {usdcDecrypted && !bestUsdcToken && collateral > 0n && (
              <p className="text-xs text-yellow-400 mt-1">
                Enter a collateral amount ≤ your largest record, or consolidate USDCx first
              </p>
            )}
          </div>

          <TransactionStatus
            status={openTx.status}
            tempTxId={openTx.tempTxId}
            onChainTxId={openTx.onChainTxId}
            error={openTx.error}
            onDismiss={openTx.reset}
          />

          <button
            onClick={handleSubmit}
            disabled={decrypting || usdcLoading || isBusy || !canTrade}
            className={`w-full py-4 rounded-lg font-semibold text-white transition-all disabled:cursor-not-allowed ${
              !decrypted
                ? 'bg-zkperp-accent hover:bg-zkperp-accent/80 disabled:bg-zkperp-accent/30'
                : isLong
                ? 'bg-zkperp-green hover:bg-zkperp-green/80 disabled:bg-zkperp-green/30'
                : 'bg-zkperp-red hover:bg-zkperp-red/80 disabled:bg-zkperp-red/30'
            }`}
          >
            {decrypting ? (
              <span className="flex items-center justify-center gap-2"><Spinner />Decrypting...</span>
            ) : openTx.status === 'submitting' ? (
              <span className="flex items-center justify-center gap-2"><Spinner />Submitting...</span>
            ) : openTx.status === 'pending' ? (
              <span className="flex items-center justify-center gap-2"><Spinner />Confirming on-chain...</span>
            ) : !connected ? 'Connect Wallet'
            : recordCount === 0 ? 'Initialize account first'
            : !decrypted ? '🛡️ Unshield to Trade'
            : !hasEmptySlot ? `No ${isLong ? 'Long' : 'Short'} slot available`
            : !usdcDecrypted ? '🛡️ Unshield to Trade'
            : !bestUsdcToken && collateral > 0n ? `Collateral exceeds record — max $${formatUsdc(usdcTokens[0]?.amount ?? 0n)}`
            : !isValidLeverage && leverage > 0 ? 'Leverage exceeds 20x'
            : `${isLong ? 'Long' : 'Short'} ${pairConfig.baseAsset}`}
          </button>
          </>)}
        </div>

        {orderMode === 'limit' && (
          <div className="p-6 space-y-6">
            <div className="flex gap-2">
              <button
                onClick={() => setLimitIsLong(true)}
                className={`flex-1 py-2.5 rounded-lg font-semibold text-sm transition-colors ${
                  limitIsLong
                    ? 'bg-zkperp-green/20 border border-zkperp-green text-zkperp-green'
                    : 'bg-zkperp-dark border border-zkperp-border text-gray-400 hover:text-white'
                }`}
              >
                Long
              </button>
              <button
                onClick={() => setLimitIsLong(false)}
                className={`flex-1 py-2.5 rounded-lg font-semibold text-sm transition-colors ${
                  !limitIsLong
                    ? 'bg-zkperp-red/20 border border-zkperp-red text-zkperp-red'
                    : 'bg-zkperp-dark border border-zkperp-border text-gray-400 hover:text-white'
                }`}
              >
                Short
              </button>
            </div>

            <div className="space-y-2">
              <label className="flex justify-between text-sm">
                <span className="text-gray-400">Trigger Price (USD)</span>
                <span className="text-gray-500">
                  {limitIsLong ? 'Below market' : 'Above market'}
                </span>
              </label>
              <div className="relative">
                <input
                  type="number"
                  value={triggerPriceInput}
                  onChange={e => setTriggerPriceInput(e.target.value)}
                  placeholder={limitIsLong
                    ? `< $${formatPrice(currentPrice)}`
                    : `> $${formatPrice(currentPrice)}`}
                  className="w-full bg-zkperp-dark border border-zkperp-accent/40 focus:border-zkperp-accent rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:outline-none"
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500">USD</span>
              </div>
              {triggerPrice > 0n && (
                <p className="text-xs text-gray-500">
                  {limitIsLong
                    ? triggerPrice < currentPrice
                      ? `✓ $${formatPrice(triggerPrice)} is below current price — valid long limit`
                      : `⚠ Trigger must be below $${formatPrice(currentPrice)} for a long limit`
                    : triggerPrice > currentPrice
                      ? `✓ $${formatPrice(triggerPrice)} is above current price — valid short limit`
                      : `⚠ Trigger must be above $${formatPrice(currentPrice)} for a short limit`
                  }
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label className="flex justify-between text-sm">
                <span className="text-gray-400">Collateral (USDC)</span>
                <span className="text-gray-500">Min: $0.0001</span>
              </label>
              <div className="relative">
                <input
                  type="number"
                  value={collateralInput}
                  onChange={e => setCollateralInput(e.target.value)}
                  placeholder="0.00"
                  className="w-full bg-zkperp-dark border border-zkperp-border rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:outline-none focus:border-zkperp-accent"
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500">USDC</span>
              </div>
            </div>

            <div className="space-y-2">
              <label className="flex justify-between text-sm">
                <span className="text-gray-400">Position Size (USDC)</span>
                <span className="text-gray-500">Max 20x leverage</span>
              </label>
              <div className="relative">
                <input
                  type="number"
                  value={sizeInput}
                  onChange={e => setSizeInput(e.target.value)}
                  placeholder="0.00"
                  className="w-full bg-zkperp-dark border border-zkperp-border rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:outline-none focus:border-zkperp-accent"
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500">USDC</span>
              </div>
            </div>

            <div className="flex gap-2">
              {[2, 5, 10, 20].map(lev => (
                <button key={lev} onClick={() => setLeverageQuick(lev)}
                  disabled={collateral <= 0n}
                  className="flex-1 py-2 text-sm bg-zkperp-dark border border-zkperp-border rounded-lg text-gray-400 hover:text-white hover:border-zkperp-accent disabled:opacity-50 transition-colors">
                  {lev}x
                </button>
              ))}
            </div>

            <div className="bg-zkperp-dark rounded-lg p-4 space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Trigger Price</span>
                <span className={triggerPrice > 0n ? 'text-zkperp-accent' : 'text-gray-600'}>
                  {triggerPrice > 0n ? `$${formatPrice(triggerPrice)}` : '—'}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Direction</span>
                <span className={limitIsLong ? 'text-zkperp-green' : 'text-zkperp-red'}>
                  {limitIsLong ? 'Long' : 'Short'}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Leverage</span>
                <span className={!isValidLeverage && leverage > 0 ? 'text-zkperp-red' : 'text-white'}>
                  {leverage.toFixed(2)}x{leverage > 20 && ' (max 20x)'}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Opening Fee (0.1%)</span>
                <span className="text-gray-300">${formatUsdc(BigInt(Math.floor(openingFee)))}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Margin locked</span>
                <span className="text-white">immediately (private)</span>
              </div>
            </div>

            <div className={`rounded-lg p-3 border text-sm ${
              usdcDecrypted && usdcTokens.length > 0
                ? 'bg-zkperp-green/5 border-zkperp-green/30'
                : 'bg-zkperp-dark border-zkperp-border'
            }`}>
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-gray-400">USDCx Balance</span>
                  {usdcDecrypted
                    ? <span className="ml-2 text-white">${formatUsdc(usdcTotal)}</span>
                    : <span className="ml-2 text-gray-500 text-xs">Unshield to view</span>
                  }
                </div>
              </div>
            </div>

            <TransactionStatus
              status={limitTx.status}
              tempTxId={limitTx.tempTxId}
              onChainTxId={limitTx.onChainTxId}
              error={limitTx.error}
              onDismiss={limitTx.reset}
            />

            <button
              onClick={handleLimitOrder}
              disabled={decrypting || usdcLoading || isLimitBusy || !canLimitOrder}
              className="w-full py-4 rounded-lg font-semibold text-white transition-all disabled:cursor-not-allowed bg-zkperp-accent hover:bg-zkperp-accent/80 disabled:bg-zkperp-accent/30"
            >
              {decrypting ? <span className="flex items-center justify-center gap-2"><Spinner />Decrypting...</span>
              : isLimitBusy ? <span className="flex items-center justify-center gap-2"><Spinner />Placing order...</span>
              : !decrypted ? '🛡️ Unshield to Trade'
              : !limitSlot ? `No ${limitIsLong ? 'Long' : 'Short'} slot available`
              : !usdcDecrypted ? '🛡️ Unshield to Trade'
              : !canLimitOrder && triggerPrice === 0n ? 'Enter trigger price'
              : !canLimitOrder && !isValidLeverage ? 'Invalid leverage'
              : `Place ${limitIsLong ? 'Long' : 'Short'} ${pairConfig.baseAsset} Limit @ $${triggerPrice > 0n ? formatPrice(triggerPrice) : '—'}`
              }
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
