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

~/snarkOS/target/release/snarkos developer deploy zkperp_v24_minimal.aleo \
  --path ./build \
  --private-key PRIVATE_KEY \
  --endpoint https://api.explorer.provable.com/v2 \
  --network 1 \
  --priority-fee 1000000 \
  --broadcast

~/snarkOS/target/release/snarkos developer scan \
  --private-key  \
  --network 1 \
  --endpoint https://api.explorer.provable.com/v1 \
  --last 50

  ~/snarkOS/target/release/snarkos developer execute zkperp_v22b_test_orders.aleo liquidate '{owner:aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0.private,trader:aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0.private,slot_id:0u8.private,position_id:5139876599640182855381513466057987190173456250621356554724685718622461583473field.private,is_long:true.private,size_usdc:5000000u64.private,collateral_usdc:995000u64.private,entry_price:6400000000000u64.private,_nonce:175770973995735440537930102551410524451571732522873821190073130848670536443group.public,_version:1u8.public}' '25000u128' --private-key <PRIVATE_KEY> --endpoint https://api.explorer.provable.com/v2 --network 1 --broadcast

  leo execute  liquidate(
        auth: LiquidationAuth,
        public liquidator_reward: u128,

# Deploy zkperp_v24_minimal (constructor sets deployer as oracle admin + orchestrator)
# leo deploy --network testnet --broadcast

# Verify roles were set by constructor:
#   curl "https://api.explorer.provable.com/v1/testnet/program/zkperp_v6.aleo/mapping/roles/0u8"
#   curl "https://api.explorer.provable.com/v1/testnet/program/zkperp_v6.aleo/mapping/roles/1u8"

# (Optional fallback) If constructor didn't set roles:
# leo execute initialize_roles --network testnet --broadcast


# ============================================================
# 2. SET ORACLE PRICE
# ============================================================

# BTC price $97,000 with 8 decimals = 6700000000000u64
# leo execute update_price 0field 6700000000000u64 1739283600u32 --network testnet --broadcast

# Verify:
#   curl "https://api.explorer.provable.com/v1/testnet/program/zkperp_v6.aleo/mapping/oracle_prices/0field"


# ============================================================
# 3. GET USDCx (replaces mock_usdc minting)
# ============================================================


# Check your USDCx balance:
#   curl "https://api.explorer.provable.com/v1/testnet/program/test_usdcx_stablecoin.aleo/mapping/balances/aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0"


# ============================================================
# 4. Initialize Slots (create empty slot records on-chain for position ids)
# ============================================================
leo execute initialize_slots aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0 --network testnet --broadcast

# ============================================================
# 4. ADD LIQUIDITY
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
