import { useState, useCallback } from 'react';
import { useWallet } from '@demox-labs/aleo-wallet-adapter-react';
import { PROGRAM_IDS, NETWORK_CONFIG } from '../utils/config';


const PROGRAM_ID = PROGRAM_IDS.ZKPERP;

const API_URL = NETWORK_CONFIG.EXPLORER_API;

export interface ScannedPosition {
  owner: string;
  position_id: string;
  is_long: boolean;
  size_usdc: bigint;
  collateral_usdc: bigint;
  entry_price: bigint;
  open_block: number;
  ciphertext: string;
}

// Parse a decrypted record plaintext string into Position data
function parsePositionPlaintext(plaintext: string): Omit<ScannedPosition, 'ciphertext'> | null {
  try {
    // Record plaintext looks like:
    // {
    //   owner: aleo1...,
    //   position_id: 12345field,
    //   is_long: true,
    //   size_usdc: 50000000u64,
    //   collateral_usdc: 4950000u64,
    //   entry_price: 10000000000000u64,
    //   open_block: 0u32
    // }
    
    const ownerMatch = plaintext.match(/owner:\s*(aleo1[a-z0-9]+)/);
    const positionIdMatch = plaintext.match(/position_id:\s*(\d+)field/);
    const isLongMatch = plaintext.match(/is_long:\s*(true|false)/);
    const sizeMatch = plaintext.match(/size_usdc:\s*(\d+)u64/);
    const collateralMatch = plaintext.match(/collateral_usdc:\s*(\d+)u64/);
    const entryPriceMatch = plaintext.match(/entry_price:\s*(\d+)u64/);
    const openBlockMatch = plaintext.match(/open_block:\s*(\d+)u32/);
    
    if (!ownerMatch || !positionIdMatch || !isLongMatch || !sizeMatch || 
        !collateralMatch || !entryPriceMatch || !openBlockMatch) {
      console.log('Failed to parse position plaintext:', plaintext);
      return null;
    }
    
    return {
      owner: ownerMatch[1],
      position_id: positionIdMatch[1] + 'field',
      is_long: isLongMatch[1] === 'true',
      size_usdc: BigInt(sizeMatch[1]),
      collateral_usdc: BigInt(collateralMatch[1]),
      entry_price: BigInt(entryPriceMatch[1]),
      open_block: parseInt(openBlockMatch[1]),
    };
  } catch (err) {
    console.error('Error parsing position plaintext:', err);
    return null;
  }
}

export function usePositionScanner() {
  const { publicKey, decrypt } = useWallet();
  const [positions, setPositions] = useState<ScannedPosition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Scan for Position records by looking at recent transactions
  const scanPositions = useCallback(async () => {
    if (!publicKey || !decrypt) {
      setError('Wallet not connected or decrypt not available');
      return [];
    }

    setLoading(true);
    setError(null);

    try {
      // Get recent transactions for the program
      const response = await fetch(
        `${API_URL}/program/${PROGRAM_ID}/mappings`
      );
      
      if (!response.ok) {
        throw new Error('Failed to fetch program data');
      }

      // For now, we'll try to get the transaction history for the user's address
      // and look for open_position transactions
      const txResponse = await fetch(
        `${API_URL}/address/${publicKey}/transactions?page=0&limit=50`
      );

      if (!txResponse.ok) {
        console.log('Could not fetch transaction history');
        // Fallback: return empty, will need manual ciphertext input
        setPositions([]);
        return [];
      }

      const transactions = await txResponse.json();
      console.log('Found transactions:', transactions);

      const foundPositions: ScannedPosition[] = [];

      // Look for open_position transactions and extract record ciphertexts
      for (const tx of transactions) {
        if (tx.type === 'execute') {
          // Look for zkperp_v3.aleo/open_position transitions
          for (const transition of tx.execution?.transitions || []) {
            if (transition.program === PROGRAM_ID && 
                transition.function === 'open_position') {
              // Get the output records (ciphertexts)
              for (const output of transition.outputs || []) {
                if (output.type === 'record' && output.value) {
                  try {
                    // Try to decrypt
                    const decrypted = await decrypt(output.value);
                    console.log('Decrypted record:', decrypted);
                    
                    // Check if it's a Position record (has position_id field)
                    if (decrypted && decrypted.includes('position_id')) {
                      const parsed = parsePositionPlaintext(decrypted);
                      if (parsed && parsed.owner === publicKey) {
                        foundPositions.push({
                          ...parsed,
                          ciphertext: output.value,
                        });
                      }
                    }
                  } catch (decryptErr) {
                    // Not our record or decryption failed
                    console.log('Could not decrypt record:', decryptErr);
                  }
                }
              }
            }
          }
        }
      }

      console.log('Found positions:', foundPositions);
      setPositions(foundPositions);
      return foundPositions;
    } catch (err) {
      console.error('Scan positions error:', err);
      setError(err instanceof Error ? err.message : 'Failed to scan positions');
      return [];
    } finally {
      setLoading(false);
    }
  }, [publicKey, decrypt]);

  // Manual decrypt function for a specific ciphertext
  const decryptPosition = useCallback(async (ciphertext: string): Promise<ScannedPosition | null> => {
    if (!decrypt || !publicKey) {
      setError('Wallet not connected');
      return null;
    }

    try {
      const decrypted = await decrypt(ciphertext);
      console.log('Manually decrypted:', decrypted);
      
      if (decrypted && decrypted.includes('position_id')) {
        const parsed = parsePositionPlaintext(decrypted);
        if (parsed) {
          return {
            ...parsed,
            ciphertext,
          };
        }
      }
      return null;
    } catch (err) {
      console.error('Decrypt position error:', err);
      setError(err instanceof Error ? err.message : 'Failed to decrypt');
      return null;
    }
  }, [decrypt, publicKey]);

  return {
    positions,
    loading,
    error,
    scanPositions,
    decryptPosition,
  };
}
