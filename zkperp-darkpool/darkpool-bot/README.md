# ZK Darkpool Operator Bot

## Quick start

```bash
cp .env.example .env
# Fill in OPERATOR_PRIVATE_KEY, OPERATOR_VIEW_KEY, OPERATOR_ADDRESS
npm install
npm start
```

## What it does

1. **Scanner** — polls Provable API every 15s for new `submit_order` transitions, decrypts `OperatorOrderRef` records using operator view key
2. **Order book** — groups orders by asset_id + direction, prunes expired/consumed orders each batch
3. **Matcher** — runs uniform clearing price algorithm at the end of each batch window (~30 blocks)
4. **Settler** — builds and submits `settle_match` transactions

## Testnet limitation — the token record problem

`settle_match` requires the **buyer's USDCx Token record** as an input. The operator can see the order exists (via `OperatorOrderRef`) but cannot access the buyer's private Token record.

**Production solution:** Buyers submit their Token record ciphertext + Credentials record ciphertext to the operator via a secure off-chain channel (encrypted API endpoint) when placing an order. The operator decrypts with the buyer's view key permission.

**Testnet workaround:** The bot prints the exact `leo execute` command needed for manual settlement. Run it in your `ZK_Darkpool` folder with your actual record plaintexts.

## Manual settlement (testnet)

After the bot prints a match, run:

```bash
cd ~/ZK_Darkpool

# Set your record plaintexts as variables
BUY_ORDER="{owner:aleo1...,asset_id:0u8,...}"
SELL_ORDER="{owner:aleo1...,asset_id:0u8,...}"
BUYER_TOKEN="{owner:aleo1...,amount:315183000u128,...}"
BUYER_CREDS="{owner:aleo1...,...}"
SELLER_ASSET="{owner:aleo1...,asset_id:0u8,amount:1000000u64,...}"

# Write to temp file (avoids shell escaping issues)
printf '%s' "$BUY_ORDER" > /tmp/buy_order.txt
printf '%s' "$SELL_ORDER" > /tmp/sell_order.txt
# etc.

leo execute settle_match \
  "$(cat /tmp/buy_order.txt)" \
  "$(cat /tmp/sell_order.txt)" \
  "$(cat /tmp/buyer_token.txt)" \
  "$(cat /tmp/buyer_creds.txt)" \
  "$(cat /tmp/seller_asset.txt)" \
  95000u64 \
  1000000u64 \
  1744900000field \
  --program-id zkdarkpool_v3.aleo \
  --network testnet \
  --broadcast
```

## Architecture

```
index.mjs          orchestrator — runs the tick loop
├── scanner.mjs    decrypts OperatorOrderRef records from chain
├── orderbook.mjs  in-memory book + uniform clearing price algo
├── settler.mjs    builds settle_match inputs, submits via SDK
├── api.mjs        all Provable REST API calls
└── config.mjs     env vars + constants
```
