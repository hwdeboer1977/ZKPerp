#!/bin/bash
# leo deploy --network testnet --broadcast


source .env && snarkos developer execute zkperp_amm_v3.aleo initialize_pool \
  --private-key $PRIVATE_KEY \
  --query https://api.explorer.provable.com/v1 \
  --broadcast https://api.explorer.provable.com/v1/testnet/transaction/broadcast \
  --network 1 \
  -- 5833372668713516032u128 -23040i32

  source .env && snarkos developer execute test_usdcx_stablecoin.aleo transfer_public_to_private \
  $ADDRESS \
  1000000000u128 \
  --private-key $PRIVATE_KEY \
  --query https://api.explorer.provable.com/v1 \
  --broadcast https://api.explorer.provable.com/v1/testnet/transaction/broadcast \
  --network 1

  source .env && snarkos developer scan \
  --view-key $VIEW_KEY \
  --start 0 \
  --end 999999 \
  --endpoint https://api.explorer.provable.com/v1