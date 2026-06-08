source .env

leo execute set_oracle --private-key $PRIVATE_KEY --broadcast \
  --endpoint https://api.explorer.provable.com/v1 --network testnet --yes \
  -- '0u8' "$ALEO_ADDRESS_A"


leo execute set_oracle --private-key $PRIVATE_KEY --broadcast \
  --endpoint https://api.explorer.provable.com/v1 --network testnet --yes \
  -- '1u8' "$ALEO_ADDRESS_B"

leo execute set_oracle --private-key $PRIVATE_KEY --broadcast \
  --endpoint https://api.explorer.provable.com/v1 --network testnet --yes \
  -- '2u8' "$ALEO_ADDRESS_C"

leo execute set_oracle --private-key $PRIVATE_KEY --broadcast \
  --endpoint https://api.explorer.provable.com/v1 --network testnet --yes \
  -- '3u8' "$ADMIN_ADDRESS"