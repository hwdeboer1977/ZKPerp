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
// 9. in /mock_usdc:    leo execute approve zkperp_v4.aleo 5000000000000u128 --network testnet --broadcast


// Opening a position on testnet
// in /zkperp: leo execute open_position \
  10000000u128 \
  100000000u64 \
  true \
  11000000000000u64 \
  55000000000u64 \
  1field \
  aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0 \
  --network testnet \
  --broadcast

// Check a position ==> use view key: AViewKey1is8iPit9ftsVVkxPe5AAXWbSXbTWCkPRVZZ7v1PAjBFE

// Method 1: Use records
snarkos developer decrypt --view-key AViewKey1is8iPit9ftsVVkxPe5AAXWbSXbTWCkPRVZZ7v1PAjBFE --ciphertext "record1qvqspc6m60rqhqzyaw5ecdewc6mufl4zjwca0f9d9ucshay0qe6k0fq2qc9hqmmnd96xjmmwta5kgscqqgpqqs4cjdgptvl47c98up6xznzkwz0u5uhdjfj7j6jf5xpv0j7s5zs3u3vljzve6r0mrmfwsgrgu4dz82uyj4eexfyce7akj35g70dfnsqsw6tntakx7mn8yvqqyqgqn94a60wk89twg7d4f2qnmp24kln75ff05zh9ygx8ffyqdardks8sjumf0fj47atnv33jxqqzqyqr6avesx93edc5y4ddl39hq8vagzltwwunarxfcsp3kdmzxe99gzg0vdhkcmrpw3jhyctvta6hxerryvqqyqgqg829hgpwxxneh0w30jczy0g6qjchjz34x3cv7v2p06jqxmv9vvzsketww3e8jhmswf5kxefrqqpqzq8r99vxp2znl9r40llr65ct07fqewz4wxcs58x9nr393rtez2cwpc9x7ur9de0kymr0vd4jxqqzqyqdeqd37ppdukka2e82xrhe49xlhlu56f7lzzafq3m6kcfett2s7r0y6ez3svvsq06y7mfgtlqjl08vhg8l69e65yy4y8cvl0w0k92hput0pvks"

// Method 2: Scan from chain is very slow so not a good alternative here!


// Closing a position on testnet needs an expected payout as input!!

// in /zkperp: leo execute close_position \