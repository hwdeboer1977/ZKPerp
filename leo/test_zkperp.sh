#!/bin/bash
set -e

# ZKPerp Test Script with mock_usdc Integration
#
# HOW TO RUN?
#
# Terminal 1: Start devnet
# leo devnet --snarkos $(which snarkos) --snarkos-features test_network --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11 --clear-storage 
#
# Terminal 2: Run test
# chmod +x test_zkperp.sh
# ./test_zkperp.sh

ENDPOINT="http://localhost:3030"
CONSENSUS="--consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11"
NETWORK="--network testnet --broadcast"

# Programs
USDC_PROGRAM="mock_usdc.aleo"
PERP_PROGRAM="zkperp_v1.aleo"

# Addresses
USER="aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px"

# Project paths - UPDATE THESE
MOCK_USDC_DIR=~/ZKPerp/leo/mock_usdc
ZKPERP_DIR=~/ZKPerp/leo/zkperp

get_block() {
    curl -s "$ENDPOINT/testnet/block/height/latest"
}

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║         ZKPerp Test Suite (with mock_usdc)                     ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

echo "Waiting for devnet..."
until curl -s "$ENDPOINT/testnet/block/height/latest" 2>/dev/null | grep -qE '^[0-9]+$'; do
    sleep 2
    echo "  Waiting for devnet to start..."
done

height=$(get_block)
while [ "$height" -lt 12 ]; do
    echo "  Block height: $height (waiting for 12)"
    sleep 2
    height=$(get_block)
done
echo "Devnet ready! Height: $height"

# ══════════════════════════════════════════════════════════════════
# STEP 1: Deploy mock_usdc
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 1: Deploying mock_usdc ==="
cd $MOCK_USDC_DIR
leo deploy $NETWORK $CONSENSUS --yes
sleep 5

echo "Checking mock_usdc deployment..."
curl -s "$ENDPOINT/testnet/program/$USDC_PROGRAM" | head -c 100
echo ""

# ══════════════════════════════════════════════════════════════════
# STEP 2: Deploy ZKPerp
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 2: Deploying ZKPerp ==="
cd $ZKPERP_DIR
leo deploy $NETWORK $CONSENSUS --yes
sleep 5

echo "Checking ZKPerp deployment..."
curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM" | head -c 100
echo ""

# ══════════════════════════════════════════════════════════════════
# STEP 3: Mint USDC to user
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 3: Minting 10,000 USDC to user ==="
cd $MOCK_USDC_DIR
leo execute mint_public $USER 10000000000u128 $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/mint.log
sleep 5

echo "Checking user USDC balance..."
curl -s "$ENDPOINT/testnet/program/$USDC_PROGRAM/mapping/balances/$USER"
echo ""

# ══════════════════════════════════════════════════════════════════
# STEP 4: Get ZKPerp program address and approve
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 4: Approving ZKPerp to spend USDC ==="

# Get program address by doing a dry run
cd $ZKPERP_DIR
PROGRAM_ADDR=$(leo run add_liquidity 100u128 $USER 2>&1 | grep -oP 'aleo1[a-z0-9]{58}' | head -4 | tail -1)
echo "ZKPerp program address: $PROGRAM_ADDR"

# Approve zkperp to spend user's USDC
cd $MOCK_USDC_DIR
leo execute approve $PROGRAM_ADDR 10000000000u128 $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/approve.log
sleep 5

echo "Approval complete"

# ══════════════════════════════════════════════════════════════════
# STEP 5: Set Oracle Price
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 5: Setting Oracle Price (BTC = \$100,000) ==="
cd $ZKPERP_DIR
leo execute update_price 0field 10000000000u64 1u32 $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/update_price.log
sleep 5

echo "Checking oracle price..."
curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM/mapping/oracle_prices/0field"
echo ""

# ══════════════════════════════════════════════════════════════════
# STEP 6: Add Liquidity (with USDC transfer)
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 6: Adding Liquidity (\$100 USDC) ==="
leo execute add_liquidity 100000000u128 $USER $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/add_liquidity.log
sleep 5

echo "Checking pool state..."
curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM/mapping/pool_state/0field"
echo ""

echo "Checking user USDC balance after deposit..."
curl -s "$ENDPOINT/testnet/program/$USDC_PROGRAM/mapping/balances/$USER"
echo ""

if grep -q "Transaction accepted" /tmp/add_liquidity.log; then
    echo "✅ add_liquidity SUCCESS"
else
    echo "❌ add_liquidity FAILED"
    exit 1
fi

# ══════════════════════════════════════════════════════════════════
# STEP 7: Open Long Position (with USDC collateral)
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 7: Opening Long Position (5x leverage) ==="
echo "  Collateral: \$10 USDC"
echo "  Size: \$50"
echo "  Direction: Long BTC"

# open_position(collateral, size, is_long, entry_price, max_slippage, nonce, recipient)
leo execute open_position 10000000u128 50000000u64 true 10000000000u64 100000000u64 1field $USER $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/open_position.log
sleep 5

echo "Checking pool state after position..."
curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM/mapping/pool_state/0field"
echo ""

echo "Checking user USDC balance after opening position..."
curl -s "$ENDPOINT/testnet/program/$USDC_PROGRAM/mapping/balances/$USER"
echo ""

if grep -q "Transaction accepted" /tmp/open_position.log; then
    echo "✅ open_position SUCCESS"
    
    # Extract position record
    mkdir -p $ZKPERP_DIR/records
    python3 << 'PYEOF'
import re
with open('/tmp/open_position.log', 'r') as f:
    content = f.read()

pattern = r'\{[^{}]+\}'
matches = re.findall(pattern, content, re.DOTALL)

for m in matches:
    if 'position_id:' in m and 'size_usdc:' in m and 'collateral_usdc:' in m:
        record = m.replace('\n', ' ').replace('  ', ' ')
        with open('records/position.txt', 'w') as f:
            f.write(record)
        print("Position record saved")
        print(record[:150] + "...")
        break
PYEOF

else
    echo "❌ open_position FAILED"
    exit 1
fi

# ══════════════════════════════════════════════════════════════════
# STEP 8: Update Price (simulate profit)
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 8: Simulating Price Movement (BTC = \$105,000) ==="
leo execute update_price 0field 10500000000u64 2u32 $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/update_price2.log
sleep 5

echo "Checking new oracle price..."
curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM/mapping/oracle_prices/0field"
echo ""

# ══════════════════════════════════════════════════════════════════
# STEP 9: Close Position (receive USDC payout)
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 9: Closing Position (should have profit) ==="

if [ -f "$ZKPERP_DIR/records/position.txt" ]; then
    POSITION_RECORD=$(cat $ZKPERP_DIR/records/position.txt)
    echo "Position record loaded"
    
    # Calculate expected payout:
    # Entry: $100,000, Exit: $105,000 = +5%
    # Position size: $50, so PnL = $2.50
    # Collateral: ~$9.95 (after 0.1% fee)
    # Expected payout: ~$12.45
    # Using 12000000u128 ($12) to be safe
    
    # close_position(position, min_price, max_price, expected_payout)
    leo execute close_position "$POSITION_RECORD" 10400000000u64 10600000000u64 12000000u128 $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/close_position.log
    sleep 5
    
    if grep -q "Transaction accepted" /tmp/close_position.log; then
        echo "✅ close_position SUCCESS"
    else
        echo "❌ close_position FAILED"
    fi
else
    echo "❌ Position record not found"
fi

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                         Summary                                ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "Pool state:"
curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM/mapping/pool_state/0field"
echo ""
echo ""
echo "Oracle price:"
curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM/mapping/oracle_prices/0field"
echo ""
echo ""
echo "User USDC balance:"
curl -s "$ENDPOINT/testnet/program/$USDC_PROGRAM/mapping/balances/$USER"
echo ""
echo ""
echo "Pool USDC balance:"
curl -s "$ENDPOINT/testnet/program/$USDC_PROGRAM/mapping/balances/$PROGRAM_ADDR"
echo ""
echo ""
echo "Test complete!"
echo ""
echo "Expected flow:"
echo "  1. User starts with 10,000 USDC"
echo "  2. Deposits 100 USDC as LP → User has 9,900 USDC"
echo "  3. Opens position with 10 USDC collateral → User has 9,890 USDC"
echo "  4. Price goes up 5%"
echo "  5. Closes position, receives ~12 USDC → User has ~9,902 USDC"
echo "  6. Net profit: ~\$2 from trading"
