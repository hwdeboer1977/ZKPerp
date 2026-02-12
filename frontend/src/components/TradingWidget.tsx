import { useState, useCallback } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import type { TransactionOptions } from '@provablehq/aleo-types';
import { useTransaction } from '@/hooks/useTransaction';
import { TransactionStatus } from '@/components/TransactionStatus';
import {
  parseUsdc,
  formatUsdc,
  formatPrice,
  calculateLeverage,
  calculateLiquidationPrice,
  generateNonce,
  PROGRAM_ID,
  SCALE,
} from '@/utils/aleo';

interface Props {
  currentPrice: bigint;
}

export function TradingWidget({ currentPrice }: Props) {
  const { address, connected } = useWallet();
  const openTx = useTransaction();

  const [isLong, setIsLong] = useState(true);
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
  const canTrade = connected && isValidLeverage && isValidSize && collateral > 0;
  const isBusy = openTx.status === 'submitting' || openTx.status === 'pending';

  const handleSubmit = useCallback(async () => {
    if (!canTrade || !address) return;

    try {
      const nonce = generateNonce();
      
      const inputs = [
        collateral.toString() + 'u128',
        size.toString() + 'u64',
        isLong.toString(),
        currentPrice.toString() + 'u64',
        maxSlippage.toString() + 'u64',
        nonce,
        address,
      ];

      console.log('Open position inputs:', inputs);
      console.log('PROGRAM_ID:', PROGRAM_ID);

      const options: TransactionOptions = {
        program: PROGRAM_ID,
        function: 'open_position',
        inputs,
        fee: 5_000_000,
        privateFee: false,
      };

      await openTx.execute(options);
      setCollateralInput('');
      setSizeInput('');
    } catch (err) {
      console.error('Trade failed:', err);
    }
  }, [canTrade, address, collateral, size, isLong, currentPrice, maxSlippage, openTx]);

  const setLeverageQuick = (targetLeverage: number) => {
    if (collateral > BigInt(0)) {
      const newSize = (Number(collateral) / SCALE) * targetLeverage;
      setSizeInput(newSize.toString());
    }
  };

  return (
    <div className="bg-zkperp-card rounded-xl border border-zkperp-border overflow-hidden">
      {/* Long/Short tabs */}
      <div className="flex border-b border-zkperp-border">
        <button
          onClick={() => setIsLong(true)}
          className={`flex-1 py-4 font-semibold transition-colors ${
            isLong
              ? 'bg-zkperp-green/10 text-zkperp-green border-b-2 border-zkperp-green'
              : 'text-gray-400 hover:text-white'
          }`}
        >
          Long
        </button>
        <button
          onClick={() => setIsLong(false)}
          className={`flex-1 py-4 font-semibold transition-colors ${
            !isLong
              ? 'bg-zkperp-red/10 text-zkperp-red border-b-2 border-zkperp-red'
              : 'text-gray-400 hover:text-white'
          }`}
        >
          Short
        </button>
      </div>

      <div className="p-6 space-y-6">
        {/* Collateral Input */}
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
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500">
              USDC
            </span>
          </div>
        </div>

        {/* Size Input */}
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
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500">
              USDC
            </span>
          </div>
        </div>

        {/* Quick leverage buttons */}
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

        {/* Slippage */}
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

        {/* Trade Summary */}
        <div className="bg-zkperp-dark rounded-lg p-4 space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Entry Price</span>
            <span className="text-white">${formatPrice(currentPrice)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Leverage</span>
            <span className={`font-medium ${
              !isValidLeverage && leverage > 0 ? 'text-zkperp-red' : 'text-white'
            }`}>
              {leverage.toFixed(2)}x
              {leverage > 20 && ' (max 20x)'}
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
        </div>

        {/* Transaction Status */}
        <TransactionStatus
          status={openTx.status}
          tempTxId={openTx.tempTxId}
          onChainTxId={openTx.onChainTxId}
          error={openTx.error}
          onDismiss={openTx.reset}
        />

        {/* Submit Button */}
        <button
          onClick={handleSubmit}
          disabled={!canTrade || isBusy}
          className={`w-full py-4 rounded-lg font-semibold text-white transition-all ${
            isLong
              ? 'bg-zkperp-green hover:bg-zkperp-green/80 disabled:bg-zkperp-green/30'
              : 'bg-zkperp-red hover:bg-zkperp-red/80 disabled:bg-zkperp-red/30'
          } disabled:cursor-not-allowed`}
        >
          {openTx.status === 'submitting' ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Submitting...
            </span>
          ) : openTx.status === 'pending' ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Confirming on-chain...
            </span>
          ) : !connected ? (
            'Connect Wallet'
          ) : !isValidLeverage && leverage > 0 ? (
            'Leverage exceeds 20x'
          ) : (
            `${isLong ? 'Long' : 'Short'} BTC`
          )}
        </button>
      </div>
    </div>
  );
}
