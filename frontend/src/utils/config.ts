/**
 * ZKPerp Frontend Configuration
 * Central location for all program IDs, addresses, and constants
 */

// ============================================================================
// PROGRAM IDS
// ============================================================================

export const PROGRAM_IDS = {
  ZKPERP: 'zkperp_v4.aleo',
  USDC: 'mock_usdc_0128.aleo',
} as const;

// ============================================================================
// NETWORK CONFIGURATION
// ============================================================================

export const NETWORK_CONFIG = {
  // Use 'testnet' for Aleo testnet, 'mainnet' for production
  NETWORK: 'testnet' as const,
  
  // API endpoints
  EXPLORER_API: 'https://api.explorer.provable.com/v1/testnet',
  
  // Alternative explorers (if needed)
  ALEO_EXPLORER_API: 'https://api.explorer.aleo.org/v1',

    // Change this to localhost for local testing
  // EXPLORER_API: 'http://localhost:3030/testnet',
  
  
  // // Local development endpoint (when running local devnet)
  // LOCAL_ENDPOINT: 'http://localhost:3030',
} as const;


export const ADDRESS_LIST = {
  ADMIN_ADDRESS: 'aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0',
  ZK_PERP_ADDRESS: 'aleo1nxzhwc6y2cw6ymlaq80xaqem25mkltn37lpzr9mjf6gplmjcjq8qnrefmc',
  MOCK_USDC_ADDRESS: '',
} as const;