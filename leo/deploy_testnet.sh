cd ~/ZKPerp/leo/mock_usdc

// TESTNET
// 1. in /mock_usdc:    leo build
// 2. in /mock_usdc:    leo deploy --network testnet --broadcast
// 3. in /mock_usdc:    leo execute initialize_admin --network testnet --broadcast
// 4. in /mock_usdc:    leo execute mint_public aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0 1000000000u128 --network testnet --broadcast --priority-fees 10000
// 5. in /mock_usdc:    check balance: curl "https://api.explorer.provable.com/v1/testnet/program/mock_usdc_0128.aleo/mapping/balances/aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0"
// 6. in /zkperp:       leo build
// 7. in /zkperp:       leo deploy --network testnet --broadcast
// 8. in /zkperp:       leo execute initialize_roles --network testnet --broadcast
// 9. in /mock_usdc:    leo execute approve zkperp_v4.aleo 500000000u128 --network testnet --broadcast
