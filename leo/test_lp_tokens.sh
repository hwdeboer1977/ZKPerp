#!/bin/bash

# chmod +x test_lp_tokens.sh
# ./test_lp_tokens.sh

# Your address
ADDRESS="aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0"
PROGRAM="zkperp_v2.aleo"

echo "Checking LP token records for: $ADDRESS"
echo ""

# Get your view key from wallet
echo "You need your VIEW KEY to decrypt records."
echo "Get it from: leo account --network testnet"
echo ""
echo -n "Enter your view key: "
read VIEW_KEY

echo ""
echo "Fetching all records from $PROGRAM..."
echo ""

# Query the API for all records
curl -s "https://api.explorer.provable.com/v1/testnet/program/$PROGRAM/transitions?page=0&size=100" | jq -r '.transitions[] | select(.function_name == "add_liquidity") | .outputs[] | select(.type == "record") | .value' > /tmp/lp_ciphertexts.txt

# Check if we found any
if [ ! -s /tmp/lp_ciphertexts.txt ]; then
    echo "No LP token records found in add_liquidity transitions"
    exit 0
fi

echo "Found $(wc -l < /tmp/lp_ciphertexts.txt) LP token record(s)"
echo ""
echo "Attempting to decrypt with your view key..."
echo ""

# Try to decrypt each one
counter=1
while IFS= read -r ciphertext; do
    echo "=== Record $counter ==="
    snarkos developer decrypt --ciphertext "$ciphertext" --view-key "$VIEW_KEY" 2>&1 || echo "Not yours or invalid"
    echo ""
    counter=$((counter + 1))
done < /tmp/lp_ciphertexts.txt

