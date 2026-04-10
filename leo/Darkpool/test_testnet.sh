leo deploy --network testnet --broadcast

cd ~/ZK_Darkpool
leo execute submit_order \
  aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0 \
  aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0 \
  0u8 true 1000000u64 1u64 123457field 99999999u32 111222444field \
  --network testnet \
  --endpoint https://api.explorer.provable.com/v1 \
  --broadcast --yes

 leo execute submit_order \
  aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0 \
  aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0 \
  0u8 false 1000000u64 1u64 789013field 99999999u32 444555777field \
  --network testnet \
  --endpoint https://api.explorer.provable.com/v1 \
  --broadcast --yes 

leo execute mint_test_asset \
  aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0 \
  0u8 1000000u64 \
  --network testnet \
  --endpoint https://api.explorer.provable.com/v1 \
  --broadcast --yes