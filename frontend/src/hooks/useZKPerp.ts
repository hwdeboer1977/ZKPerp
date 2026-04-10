import { useCallback, useState } from 'react';
import { useWallet } from '@provablehq/aleo-wallet-adaptor-react';
import type { TransactionOptions } from '@provablehq/aleo-types';
import { PROGRAM_ID, generateNonce } from '@/utils/aleo';
import { PROGRAM_IDS, NETWORK_CONFIG } from '../utils/config';
import type { PositionSlotRecord } from '@/hooks/useSlots';

export interface Position {
  owner: string;
  position_id: string;
  is_long: boolean;
  size_usdc: bigint;
  collateral_usdc: bigint;
  entry_price: bigint;
  open_block: number;
  rawRecord?: any;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function fetchCurrentPrice(): Promise<bigint> {
  try {
    const url = `${NETWORK_CONFIG.EXPLORER_API}/program/${PROGRAM_IDS.ZKPERP}/mapping/oracle_prices/0field`;
    console.log('Fetching price from:', url);

    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

    const text = await response.text();
    console.log('Price data received (raw):', text);

    const priceMatch = text.match(/price:\s*(\d+)u64/);
    if (priceMatch?.[1]) {
      const price = BigInt(priceMatch[1]);
      console.log('Parsed price:', price.toString());
      return price;
    }

    const data = JSON.parse(text);
    if (data.price) {
      const price = BigInt(data.price.toString().replace('u64', ''));
      console.log('Parsed price:', price.toString());
      return price;
    }

    throw new Error('Could not parse price');
  } catch (error) {
    console.error('Error fetching current price:', error);
    return BigInt(12000000000000); // $120,000 fallback
  }
}

async function fetchCurrentBlockHeight(): Promise<number> {
  try {
    const url = `${NETWORK_CONFIG.EXPLORER_API}/transactions?limit=1`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

    const data = await response.json();
    if (data?.transactions?.[0]?.block_height) {
      return data.transactions[0].block_height;
    }
    throw new Error('No transaction data');
  } catch (error) {
    console.error('Error fetching block height:', error);
    return 14047700;
  }
}

async function fetchPositionOpenBlock(positionId: string): Promise<number> {
  try {
    const cleanId = positionId.replace('.private', '').replace('.public', '');
    const url = `${NETWORK_CONFIG.EXPLORER_API}/program/${PROGRAM_IDS.ZKPERP}/mapping/position_open_blocks/${cleanId}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

    const text = await response.text();
    const blockMatch = text.match(/(\d+)u32/);
    if (blockMatch?.[1]) return parseInt(blockMatch[1]);

    throw new Error('Could not parse open block');
  } catch (error) {
    console.error('Error fetching position open block:', error);
    return 14046700;
  }
}

function calculateBorrowFee(size: bigint, blocksOpen: number): bigint {
  return (size * BigInt(blocksOpen)) / BigInt(100_000_000);
}

function calculatePnL(
  size: bigint,
  entryPrice: bigint,
  currentPrice: bigint,
  isLong: boolean
): { pnlAbs: bigint; isProfit: boolean } {
  const safeEntryPrice = entryPrice + 1n;
  const higherPrice = currentPrice > entryPrice ? currentPrice : entryPrice;
  const lowerPrice  = currentPrice > entryPrice ? entryPrice : currentPrice;
  const priceDiff   = higherPrice - lowerPrice;
  const pnlAbs      = (size * priceDiff) / safeEntryPrice;
  const isProfit    = (isLong && currentPrice > entryPrice) ||
                      (!isLong && currentPrice < entryPrice);
  return { pnlAbs, isProfit };
}

function calculateExpectedPayout(
  collateral: bigint,
  size: bigint,
  entryPrice: bigint,
  currentPrice: bigint,
  isLong: boolean,
  blocksOpen: number,
  safetyBufferPercent: number = 95
): bigint {
  const { pnlAbs, isProfit } = calculatePnL(size, entryPrice, currentPrice, isLong);
  const borrowFee = calculateBorrowFee(size, blocksOpen);

  let payout: bigint;
  if (isProfit) {
    payout = collateral + pnlAbs - borrowFee;
  } else {
    const loss = pnlAbs + borrowFee;
    payout = collateral > loss ? collateral - loss : 0n;
  }

  return (payout * BigInt(safetyBufferPercent)) / 100n;
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

// ============================================================================
// MAIN HOOK
// ============================================================================

export function useZKPerp() {
  const { address, executeTransaction, requestRecords } = useWallet();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ─── open position ──────────────────────────────────────────────────────────

  const openPosition = useCallback(
    async (
      collateral: bigint,
      size: bigint,
      isLong: boolean,
      entryPrice: bigint,
      _maxSlippage: bigint  // kept in signature for API compat, not passed to v22
    ) => {
      if (!address || !executeTransaction) throw new Error('Wallet not connected');

      setLoading(true);
      setError(null);

      try {
        const nonce = generateNonce();

        const inputs = [
          collateral.toString() + 'u128',
          size.toString() + 'u64',
          isLong.toString(),
          entryPrice.toString() + 'u64',
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

        const result = await executeTransaction(options);
        const txId = result?.transactionId;
        console.log('Transaction submitted:', txId);
        return txId;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to open position';
        console.error('Open position error:', err);
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [address, executeTransaction]
  );

  // ─── close position ─────────────────────────────────────────────────────────

  const closePosition = useCallback(
    async (position: Position, minPrice: bigint, maxPrice: bigint) => {
      if (!address || !executeTransaction) throw new Error('Wallet not connected');
      if (!position.rawRecord) throw new Error('Raw record not available — please refresh positions');

      setLoading(true);
      setError(null);

      try {
        const collateral  = BigInt(position.collateral_usdc);
        const size        = BigInt(position.size_usdc);
        const entryPrice  = BigInt(position.entry_price);

        const currentPrice    = await fetchCurrentPrice();
        const actualOpenBlock = await fetchPositionOpenBlock(position.position_id);
        const currentBlock    = await fetchCurrentBlockHeight();
        const actualBlocksOpen = currentBlock - actualOpenBlock + 5;

        const expectedPayout = calculateExpectedPayout(
          collateral, size, entryPrice, currentPrice,
          position.is_long, actualBlocksOpen, 95
        );

        const { pnlAbs, isProfit } = calculatePnL(size, entryPrice, currentPrice, position.is_long);
        const borrowFee = calculateBorrowFee(size, actualBlocksOpen);

        console.log('Close position calculation:', {
          actualOpenBlock, currentBlock, actualBlocksOpen,
          currentPrice: currentPrice.toString(),
          entryPrice: entryPrice.toString(),
          pnlAbs: pnlAbs.toString(),
          isProfit,
          borrowFee: borrowFee.toString(),
          expectedPayout: expectedPayout.toString(),
        });

        const inputs = [
          position.rawRecord,
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

        const result = await executeTransaction(options);
        return { txId: result?.transactionId ?? 'debug-mode', expectedPayout };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to close position';
        console.error('Close position error:', err);
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [address, executeTransaction]
  );

  // ─── burn stale slot ────────────────────────────────────────────────────────
  // Called after liquidation. Consumes the stale filled PositionSlot and
  // returns a fresh empty slot so the trader can open new positions.

  const burnStaleSlot = useCallback(
    async (slot: PositionSlotRecord, programId: string) => {
      if (!address || !executeTransaction) throw new Error('Wallet not connected');

      setLoading(true);
      setError(null);

      try {
        const inputs = [
          normalizeRecordPlaintext(slot.plaintext),
        ];

        console.log('burn_stale_slot inputs:', inputs);

        const options: TransactionOptions = {
          program: programId,
          function: 'burn_stale_slot',
          inputs,
          fee: 1_000_000,
          privateFee: false,
        };

        const result = await executeTransaction(options);
        const txId = result?.transactionId;
        console.log('burn_stale_slot submitted:', txId);
        return txId;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to reclaim slot';
        console.error('burn_stale_slot error:', err);
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [address, executeTransaction]
  );

  // ─── add liquidity ──────────────────────────────────────────────────────────

  const addLiquidity = useCallback(
    async (amount: bigint) => {
      if (!address || !executeTransaction) throw new Error('Wallet not connected');

      setLoading(true);
      setError(null);

      try {
        const inputs = [amount.toString() + 'u128', address];

        const options: TransactionOptions = {
          program: PROGRAM_ID,
          function: 'add_liquidity',
          inputs,
          fee: 5_000_000,
          privateFee: false,
        };

        const result = await executeTransaction(options);
        console.log('Add liquidity submitted:', result?.transactionId);
        return result?.transactionId;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to add liquidity';
        console.error('Add liquidity error:', err);
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [address, executeTransaction]
  );

  // ─── remove liquidity ───────────────────────────────────────────────────────

  const removeLiquidity = useCallback(
    async (
      lpToken: { id: string; amount: bigint; rawRecord?: any },
      lpAmountToWithdraw: bigint,
      expectedUsdc: bigint
    ) => {
      if (!address || !executeTransaction) throw new Error('Wallet not connected');

      setLoading(true);
      setError(null);

      try {
        const inputs = [
          lpToken.rawRecord,
          lpAmountToWithdraw.toString() + 'u64',
          expectedUsdc.toString() + 'u128',
        ];

        const options: TransactionOptions = {
          program: PROGRAM_ID,
          function: 'remove_liquidity',
          inputs,
          fee: 5_000_000,
          privateFee: false,
        };

        const result = await executeTransaction(options);
        console.log('Remove liquidity submitted:', result?.transactionId);
        return result?.transactionId;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to remove liquidity';
        console.error('Remove liquidity error:', err);
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [address, executeTransaction]
  );

  // ─── fetch positions (legacy) ───────────────────────────────────────────────

  const fetchPositions = useCallback(async (): Promise<Position[]> => {
    if (!address || !requestRecords) return [];

    try {
      const records = await requestRecords(PROGRAM_ID);
      console.log('All records from zkperp:', records);

      return records
        .filter((r: any) => r.recordName === 'Position' && !r.spent)
        .map((r: any) => {
          const isLongStr = String(r.data.is_long)
            .replace('.private', '').replace('.public', '');
          return {
            owner: r.owner,
            position_id: r.data.position_id,
            is_long: isLongStr.trim().toLowerCase() === 'true',
            size_usdc: BigInt(String(r.data.size_usdc).replace('u64', '').replace('.private', '')),
            collateral_usdc: BigInt(String(r.data.collateral_usdc).replace('u64', '').replace('.private', '')),
            entry_price: BigInt(String(r.data.entry_price).replace('u64', '').replace('.private', '')),
            open_block: parseInt(String(r.data.open_block).replace('u32', '').replace('.private', '')),
            rawRecord: r,
          };
        });
    } catch (err) {
      console.error('Fetch positions error:', err);
      return [];
    }
  }, [address, requestRecords]);

  return {
    openPosition,
    closePosition,
    burnStaleSlot,
    addLiquidity,
    removeLiquidity,
    fetchPositions,
    loading,
    error,
    clearError: () => setError(null),
  };
}
