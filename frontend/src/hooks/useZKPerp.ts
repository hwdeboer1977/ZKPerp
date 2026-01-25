import { useCallback, useState } from 'react';
import { useWallet } from '@demox-labs/aleo-wallet-adapter-react';
import { Transaction, WalletAdapterNetwork } from '@demox-labs/aleo-wallet-adapter-base';
import { PROGRAM_ID, generateNonce } from '@/utils/aleo';

export interface Position {
  owner: string;
  position_id: string;
  is_long: boolean;
  size_usdc: bigint;
  collateral_usdc: bigint;
  entry_price: bigint;
  open_block: number;
}

export function useZKPerp() {
  const { publicKey, requestTransaction, requestRecords } = useWallet();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Open a new position
  const openPosition = useCallback(
    async (
      collateral: bigint,
      size: bigint,
      isLong: boolean,
      entryPrice: bigint,
      maxSlippage: bigint
    ) => {
      if (!publicKey || !requestTransaction) {
        throw new Error('Wallet not connected');
      }

      setLoading(true);
      setError(null);

      try {
        const nonce = generateNonce();
        
        const inputs = [
          `${collateral}u64`,
          `${size}u64`,
          isLong.toString(),
          `${entryPrice}u64`,
          `${maxSlippage}u64`,
          nonce,
          publicKey,
        ];

        const aleoTransaction = Transaction.createTransaction(
          publicKey,
          WalletAdapterNetwork.Localnet,
          PROGRAM_ID,
          'open_position',
          inputs,
          5_000_000,
          false
        );

        const txId = await requestTransaction(aleoTransaction);
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
    [publicKey, requestTransaction]
  );

  // Close an existing position
  const closePosition = useCallback(
    async (position: Position, minPrice: bigint, maxPrice: bigint) => {
      if (!publicKey || !requestTransaction) {
        throw new Error('Wallet not connected');
      }

      setLoading(true);
      setError(null);

      try {
        const positionRecord = {
          owner: position.owner,
          position_id: position.position_id,
          is_long: position.is_long,
          size_usdc: `${position.size_usdc}u64`,
          collateral_usdc: `${position.collateral_usdc}u64`,
          entry_price: `${position.entry_price}u64`,
          open_block: `${position.open_block}u32`,
        };

        const inputs = [
          JSON.stringify(positionRecord),
          `${minPrice}u64`,
          `${maxPrice}u64`,
        ];

        const aleoTransaction = Transaction.createTransaction(
          publicKey,
          WalletAdapterNetwork.Localnet,
          PROGRAM_ID,
          'close_position',
          inputs,
          5_000_000,
          false
        );

        const txId = await requestTransaction(aleoTransaction);
        console.log('Close position submitted:', txId);
        return txId;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to close position';
        console.error('Close position error:', err);
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [publicKey, requestTransaction]
  );

  // Add liquidity to the pool
  const addLiquidity = useCallback(
    async (amount: bigint) => {
      if (!publicKey || !requestTransaction) {
        throw new Error('Wallet not connected');
      }

      setLoading(true);
      setError(null);

      try {
        const inputs = [
          `${amount}u64`,
          publicKey,
        ];

        const aleoTransaction = Transaction.createTransaction(
          publicKey,
          WalletAdapterNetwork.Localnet,
          PROGRAM_ID,
          'add_liquidity',
          inputs,
          5_000_000,
          false
        );

        const txId = await requestTransaction(aleoTransaction);
        console.log('Add liquidity submitted:', txId);
        return txId;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to add liquidity';
        console.error('Add liquidity error:', err);
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [publicKey, requestTransaction]
  );

  // Fetch user's position records
  const fetchPositions = useCallback(async (): Promise<Position[]> => {
    if (!publicKey || !requestRecords) {
      return [];
    }

    try {
      const records = await requestRecords(PROGRAM_ID);
      
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const positions: Position[] = records
        .filter((r: any) => r.recordName === 'Position' && !r.spent)
        .map((r: any) => ({
          owner: r.owner,
          position_id: r.data.position_id,
          is_long: r.data.is_long === 'true',
          size_usdc: BigInt(r.data.size_usdc.replace('u64', '')),
          collateral_usdc: BigInt(r.data.collateral_usdc.replace('u64', '')),
          entry_price: BigInt(r.data.entry_price.replace('u64', '')),
          open_block: parseInt(r.data.open_block.replace('u32', '')),
        }));

      return positions;
    } catch (err) {
      console.error('Fetch positions error:', err);
      return [];
    }
  }, [publicKey, requestRecords]);

  return {
    openPosition,
    closePosition,
    addLiquidity,
    fetchPositions,
    loading,
    error,
    clearError: () => setError(null),
  };
}
