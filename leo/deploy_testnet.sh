#!/bin/bash
# ============================================================
# ZKPerp v6 Testnet Deployment Cheatsheet
# Uses USDCx (test_usdcx_stablecoin.aleo)
# ============================================================
#
# This is a reference guide, not a fully automated script.
# Run commands manually step by step.

cd ~/ZKPerp/leo/zkperp

# ============================================================
# 1. BUILD & DEPLOY
# ============================================================

# Build zkperp_v6
# leo build

# Deploy zkperp_v6 (constructor sets deployer as oracle admin + orchestrator)
# leo deploy --network testnet --broadcast

# Verify roles were set by constructor:
#   curl "https://api.explorer.provable.com/v1/testnet/program/zkperp_v6.aleo/mapping/roles/0u8"
#   curl "https://api.explorer.provable.com/v1/testnet/program/zkperp_v6.aleo/mapping/roles/1u8"

# (Optional fallback) If constructor didn't set roles:
# leo execute initialize_roles --network testnet --broadcast


# ============================================================
# 2. SET ORACLE PRICE
# ============================================================

# BTC price $97,000 with 8 decimals = 9700000000000u64
# leo execute update_price 0field 9700000000000u64 1739283600u32 --network testnet --broadcast

# Verify:
#   curl "https://api.explorer.provable.com/v1/testnet/program/zkperp_v6.aleo/mapping/oracle_prices/0field"


# ============================================================
# 3. GET USDCx (replaces mock_usdc minting)
# ============================================================

# Bridge USDC from Sepolia -> Aleo testnet at: https://usdcx.aleo.dev/
# USDCx token program: test_usdcx_stablecoin.aleo
# USDCx bridge program: test_usdcx_bridge.aleo
# Decimals: 6 (1 USDCx = 1000000u128)

# Check your USDCx balance:
#   curl "https://api.explorer.provable.com/v1/testnet/program/test_usdcx_stablecoin.aleo/mapping/balances/aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0"


# ============================================================
# 4. APPROVE USDCx FOR ZKPERP
# ============================================================

# NOTE: Function is approve_public (not approve)
# Replace <ZKPERP_V6_ADDRESS> with actual program address from explorer
#
# snarkos developer execute test_usdcx_stablecoin.aleo approve_public \
#   <ZKPERP_V6_ADDRESS> 5000000000000u128 \
#   --private-key <YOUR_KEY> \
#   --query https://api.explorer.provable.com/v1 \
#   --broadcast https://api.explorer.provable.com/v1/testnet/transaction/broadcast \
#   --fee 1000000

# Or via Shield wallet frontend (LiquidityPage has approve button)


# ============================================================
# 5. ADD LIQUIDITY
# ============================================================

# leo execute add_liquidity 100000000u128 aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0 --network testnet --broadcast


# ============================================================
# 6. OPEN POSITION
# ============================================================

# Open 10 USDCx collateral, 100 USDCx size (10x long BTC)
# leo execute open_position \
#   10000000u128 \
#   100000000u64 \
#   true \
#   9700000000000u64 \
#   50000000000u64 \
#   1field \
#   aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0 \
#   --network testnet \
#   --broadcast


# ============================================================
# 7. CHECK POSITION (decrypt record with view key)
# ============================================================

# snarkos developer decrypt \
#   --view-key AViewKey1is8iPit9ftsVVkxPe5AAXWbSXbTWCkPRVZZ7v1PAjBFE \
#   --ciphertext "<CIPHERTEXT>"


# ============================================================
# 8. CLOSE POSITION
# ============================================================

# leo execute close_position \
#   <POSITION_RECORD> \
#   <MIN_PRICE> \
#   <MAX_PRICE> \
#   <EXPECTED_PAYOUT> \
#   --network testnet --broadcast


# ============================================================
# 9. LIQUIDATE (permissionless - anyone can call)
# ============================================================

# leo execute liquidate \
#   <POSITION_ID> \
#   <IS_LONG> \
#   <SIZE> \
#   <COLLATERAL> \
#   <ENTRY_PRICE> \
#   <REWARD> \
#   --network testnet --broadcast


# ============================================================
# KEY DIFFERENCES FROM V4 (mock_usdc)
# ============================================================
# - No more mock_usdc minting -- bridge USDCx at usdcx.aleo.dev
# - approve -> approve_public
# - transfer_from -> transfer_from_public (internal, handled by contract)
# - transfer_public stays the same (internal, handled by contract)
# - Constructor sets admin at deploy (no separate initialize_roles needed)
# - Program name: zkperp_v6.aleo
# - Token program: test_usdcx_stablecoin.aleo
