#!/bin/bash
set -e

# ZKPerp Setup & Test Script for Local Devnet
#
# HOW TO RUN?
#
# Terminal 1: Start devnet
# leo devnet --snarkos $(which snarkos) --snarkos-features test_network --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11 --clear-storage 
#
# Terminal 2: Run setup
# chmod +x test_zkperp.sh
# ./test_zkperp.sh

ENDPOINT="http://localhost:3030"
CONSENSUS="--consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11"
NETWORK="--network testnet --broadcast"

# Program name
PROGRAM="zkperp_v1.aleo"

# Addresses
ADMIN="aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px"
TRADER="aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px"
LP="aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px"

# Project path
ZKPERP_DIR=~/ZKPerp

# Get current block
get_block() {
    curl -s "$ENDPOINT/testnet/block/height/latest"
}

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                    ZKPerp Test Suite                           ║"
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
# STEP 1: Deploy ZKPerp
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 1: Deploying ZKPerp ==="
cd $ZKPERP_DIR
leo deploy $NETWORK $CONSENSUS --yes
sleep 5

echo ""
echo "Checking deployment..."
curl -s "$ENDPOINT/testnet/program/$PROGRAM" | head -c 200
echo ""
echo ""

# ══════════════════════════════════════════════════════════════════
# STEP 2: Set Oracle Price
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 2: Setting Oracle Price (BTC = \$100,000) ==="
leo execute update_price 0field 10000000000u64 1u32 $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/update_price.log
sleep 5

echo ""
echo "Checking oracle price..."
curl -s "$ENDPOINT/testnet/program/$PROGRAM/mapping/oracle_prices/0field"
echo ""

# ══════════════════════════════════════════════════════════════════
# STEP 3: Add Liquidity
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 3: Adding Liquidity (\$100 USDC) ==="
leo execute add_liquidity 100000000u64 $LP $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/add_liquidity.log
sleep 5

echo ""
echo "Checking pool state..."
curl -s "$ENDPOINT/testnet/program/$PROGRAM/mapping/pool_state/0field"
echo ""

# Check if add_liquidity succeeded
if grep -q "Transaction accepted" /tmp/add_liquidity.log; then
    echo "✅ add_liquidity SUCCESS"
else
    echo "❌ add_liquidity FAILED"
    echo "Check /tmp/add_liquidity.log for details"
    exit 1
fi

# ══════════════════════════════════════════════════════════════════
# STEP 4: Open Long Position
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 4: Opening Long Position (5x leverage) ==="
echo "  Collateral: \$10"
echo "  Size: \$50"
echo "  Direction: Long BTC"
echo "  Entry Price: \$100,000"
echo "  Max Slippage: \$1,000 (1%)"

# New signature: open_position(collateral, size, is_long, entry_price, max_slippage, nonce, recipient)
leo execute open_position 10000000u64 50000000u64 true 10000000000u64 100000000u64 1field $TRADER $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/open_position.log
sleep 5

echo ""
echo "Checking pool state after position..."
curl -s "$ENDPOINT/testnet/program/$PROGRAM/mapping/pool_state/0field"
echo ""

# Check if open_position succeeded
if grep -q "Transaction accepted" /tmp/open_position.log; then
    echo "✅ open_position SUCCESS"
    
    # Extract position record
    echo ""
    echo "Extracting position record..."
    mkdir -p $ZKPERP_DIR/records
    
    python3 << 'PYEOF'
import re
with open('/tmp/open_position.log', 'r') as f:
    content = f.read()

# Find Position record (has position_id, is_long, size_usdc, etc.)
pattern = r'\{[^{}]+\}'
matches = re.findall(pattern, content, re.DOTALL)

for m in matches:
    if 'position_id:' in m and 'size_usdc:' in m and 'collateral_usdc:' in m:
        record = m.replace('\n', ' ').replace('  ', ' ')
        with open('records/position.txt', 'w') as f:
            f.write(record)
        print("Position record saved to records/position.txt")
        print(record[:200] + "...")
        break
PYEOF

else
    echo "❌ open_position FAILED"
    echo "Check /tmp/open_position.log for details"
    exit 1
fi

# ══════════════════════════════════════════════════════════════════
# STEP 5: Update Price (simulate price movement)
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 5: Simulating Price Movement (BTC = \$105,000) ==="
leo execute update_price 0field 10500000000u64 2u32 $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/update_price2.log
sleep 5

echo ""
echo "Checking new oracle price..."
curl -s "$ENDPOINT/testnet/program/$PROGRAM/mapping/oracle_prices/0field"
echo ""

# ══════════════════════════════════════════════════════════════════
# STEP 6: Close Position (with profit)
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 6: Closing Position (should have profit) ==="

if [ -f "$ZKPERP_DIR/records/position.txt" ]; then
    POSITION_RECORD=$(cat $ZKPERP_DIR/records/position.txt)
    echo "Position record loaded"
    echo "Record: ${POSITION_RECORD:0:100}..."
    
    # Close position with slippage protection
    # min_price for longs closing (want price >= min)
    # max_price for shorts closing (want price <= max)
    leo execute close_position "$POSITION_RECORD" 10400000000u64 10600000000u64 $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/close_position.log
    sleep 5
    
    if grep -q "Transaction accepted" /tmp/close_position.log; then
        echo "✅ close_position SUCCESS"
    else
        echo "❌ close_position FAILED"
        echo "Check /tmp/close_position.log for details"
    fi
else
    echo "❌ Position record not found, skipping close_position"
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
curl -s "$ENDPOINT/testnet/program/$PROGRAM/mapping/pool_state/0field"
echo ""
echo ""
echo "Oracle price:"
curl -s "$ENDPOINT/testnet/program/$PROGRAM/mapping/oracle_prices/0field"
echo ""
echo ""
echo "Test complete!"
echo ""
echo "Expected results:"
echo "  - Long position opened at \$100,000 with entry_price stored"
echo "  - Price moved to \$105,000 (+5%)"
echo "  - Position closed with ~\$2.50 profit (5% of \$50 size)"
echo "  - Pool liquidity decreased by profit amount"
echo "  - Open interest returned to 0"