cd ~/ZKPerp/leo/zkperp

// TESTNET - ZKPerp v6 with USDCx (test_usdcx_stablecoin.aleo)
// ============================================================

// 1. Build zkperp_v6
// in /zkperp:       leo build

// 2. Deploy zkperp_v6
// in /zkperp:       leo deploy --network testnet --broadcast

// 3. Initialize roles (sets you as oracle admin + orchestrator)
// in /zkperp:       leo execute initialize_roles --network testnet --broadcast

// 4. Set BTC price (e.g. $97,000 with 8 decimals = 9700000000000)
// in /zkperp:       leo execute update_price 0field 9700000000000u64 1739283600u32 --network testnet --broadcast

// 5. Check roles are set:
//    curl "https://api.explorer.provable.com/v1/testnet/program/zkperp_v6.aleo/mapping/roles/0u8"

// 6. Check oracle price is set:
//    curl "https://api.explorer.provable.com/v1/testnet/program/zkperp_v6.aleo/mapping/oracle_prices/0field"


// ============================================================
// GET USDCx (replaces mock_usdc minting)
// ============================================================

// Bridge USDC from Sepolia → Aleo testnet at: https://usdcx.aleo.dev/
// USDCx token program: test_usdcx_stablecoin.aleo
// USDCx bridge program: test_usdcx_bridge.aleo
// Decimals: 6 (1 USDCx = 1000000u128)

// Check your USDCx balance:
//    curl "https://api.explorer.provable.com/v1/testnet/program/test_usdcx_stablecoin.aleo/mapping/balances/aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0"


// ============================================================
// APPROVE USDCx FOR ZKPERP (replaces mock_usdc approve)
// ============================================================

// NOTE: Function is now approve_public (not approve)
// NOTE: Replace <ZKPERP_V6_ADDRESS> with actual program address from explorer
// in /zkperp:       snarkos developer execute test_usdcx_stablecoin.aleo approve_public <ZKPERP_V6_ADDRESS> 5000000000000u128 --private-key <YOUR_KEY> --query https://api.explorer.provable.com/v1 --broadcast https://api.explorer.provable.com/v1/testnet/transaction/broadcast --fee 1000000

// Or via Shield wallet frontend (LiquidityPage has approve button)


// ============================================================
// ADD LIQUIDITY
// ============================================================

// in /zkperp:       leo execute add_liquidity 100000000u128 aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0 --network testnet --broadcast


// ============================================================
// OPEN POSITION
// ============================================================

// Open 10 USDCx collateral, 100 USDCx size (10x long BTC)
// in /zkperp:
leo execute open_position \
  10000000u128 \
  100000000u64 \
  true \
  9700000000000u64 \
  50000000000u64 \
  1field \
  aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0 \
  --network testnet \
  --broadcast


// ============================================================
// CHECK POSITION (use view key to decrypt record)
// ============================================================

// snarkos developer decrypt --view-key AViewKey1is8iPit9ftsVVkxPe5AAXWbSXbTWCkPRVZZ7v1PAjBFE --ciphertext "<CIPHERTEXT>"


// ============================================================
// CLOSE POSITION
// ============================================================

// in /zkperp:
// leo execute close_position <POSITION_RECORD> <MIN_PRICE> <MAX_PRICE> <EXPECTED_PAYOUT> --network testnet --broadcast


// ============================================================
// LIQUIDATE (permissionless - anyone can call)
// ============================================================

// in /zkperp:
// leo execute liquidate <POSITION_ID> <IS_LONG> <SIZE> <COLLATERAL> <ENTRY_PRICE> <REWARD> --network testnet --broadcast


// ============================================================
// KEY DIFFERENCES FROM V4 (mock_usdc)
// ============================================================
// - No more mock_usdc minting — bridge USDCx at usdcx.aleo.dev
// - approve → approve_public
// - transfer_from → transfer_from_public (internal, handled by contract)
// - transfer_public stays the same (internal, handled by contract)
// - Program name: zkperp_v6.aleo
// - Token program: test_usdcx_stablecoin.aleo
