#!/bin/bash
set -e

# ═══════════════════════════════════════════════════════════════════════════════
# ZKPerp v2 Test Script - Devnet
# ═══════════════════════════════════════════════════════════════════════════════
#
# Updated for v2 contracts with mapping-based admin (no hardcoded addresses)
#
# ╔════════════════════════════════════════════════════════════════╗
# ║                    TEST SCENARIO SELECTOR                       ║
# ╠════════════════════════════════════════════════════════════════╣
# ║  TEST_SCENARIO=1  →  Price UP, Trader closes with PROFIT       ║
# ║  TEST_SCENARIO=2  →  Price DOWN, Anyone LIQUIDATES             ║
# ╚════════════════════════════════════════════════════════════════╝
#
# HOW TO RUN:
#
# Terminal 1: Start devnet
#   leo devnet --snarkos $(which snarkos) --snarkos-features test_network \
#     --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11 --clear-storage 
#
# Terminal 2: Run test
#   chmod +x test_zkperp.sh
#   ./test_zkperp.sh
#
# ═══════════════════════════════════════════════════════════════════════════════

TEST_SCENARIO=1  # <-- CHANGE THIS: 1 = trader profit, 2 = liquidation

# ══════════════════════════════════════════════════════════════════
# CONFIGURATION
# ══════════════════════════════════════════════════════════════════

ENDPOINT="http://localhost:3030"
CONSENSUS="--consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11"
NETWORK="--network testnet --broadcast"

# Programs (update names as needed)
USDC_PROGRAM="mock_usdc_0128.aleo"
PERP_PROGRAM="zkperp_v3.aleo"

# User address (default devnet address)
USER="aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px"

# Project paths - UPDATE THESE
MOCK_USDC_DIR=~/ZKPerp/leo/mock_usdc
ZKPERP_DIR=~/ZKPerp/leo/zkperp

# ══════════════════════════════════════════════════════════════════
# HELPER FUNCTIONS
# ══════════════════════════════════════════════════════════════════

get_block() {
    curl -s "$ENDPOINT/testnet/block/height/latest"
}

wait_for_devnet() {
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
}

# ══════════════════════════════════════════════════════════════════
# MAIN SCRIPT
# ══════════════════════════════════════════════════════════════════

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║       ZKPerp v2 Test Suite - Mapping-Based Admin               ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

if [ "$TEST_SCENARIO" -eq 1 ]; then
    echo "🟢 TEST SCENARIO 1: Price UP → Trader closes with PROFIT"
    echo ""
    echo "  Entry price:  \$100,000"
    echo "  Exit price:   \$105,000 (+5%)"
    echo "  Position:     Long \$50 (5x leverage on \$10 collateral)"
    echo "  Expected PnL: +\$2.50 profit"
elif [ "$TEST_SCENARIO" -eq 2 ]; then
    echo "🔴 TEST SCENARIO 2: Price DOWN → Position LIQUIDATED"
    echo ""
    echo "  Entry price:       \$100,000"
    echo "  Exit price:        \$60,000 (-40%)"
    echo "  Position:          Long \$50 (5x leverage on \$10 collateral)"
    echo "  Result:            Position liquidated, liquidator gets reward"
else
    echo "❌ Invalid TEST_SCENARIO: $TEST_SCENARIO"
    exit 1
fi
echo ""

wait_for_devnet

# ══════════════════════════════════════════════════════════════════
# STEP 1: Deploy mock_usdc
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 1: Deploying mock_usdc ==="
cd $MOCK_USDC_DIR
leo deploy $NETWORK $CONSENSUS --yes
sleep 5

# ══════════════════════════════════════════════════════════════════
# STEP 2: Initialize USDC Admin
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 2: Initialize USDC Admin (first caller becomes admin) ==="
leo execute initialize_admin $NETWORK $CONSENSUS --yes
sleep 5

echo "Checking admin..."
curl -s "$ENDPOINT/testnet/program/$USDC_PROGRAM/mapping/admin/0u8"
echo ""

# ══════════════════════════════════════════════════════════════════
# STEP 3: Deploy ZKPerp
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 3: Deploying ZKPerp v2 ==="
cd $ZKPERP_DIR
leo deploy $NETWORK $CONSENSUS --yes
sleep 5

# ══════════════════════════════════════════════════════════════════
# STEP 4: Initialize ZKPerp Roles
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 4: Initialize ZKPerp Roles (first caller becomes admin & orchestrator) ==="
leo execute initialize_roles $NETWORK $CONSENSUS --yes
sleep 5

echo "Checking roles..."
echo "  Oracle Admin:"
curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM/mapping/roles/0u8"
echo ""
echo "  Orchestrator:"
curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM/mapping/roles/1u8"
echo ""

# ══════════════════════════════════════════════════════════════════
# STEP 5: Mint USDC to user
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 5: Minting 10,000 USDC to user ==="
cd $MOCK_USDC_DIR
leo execute mint_public $USER 10000000000u128 $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/mint.log
sleep 5

echo "Checking user USDC balance..."
curl -s "$ENDPOINT/testnet/program/$USDC_PROGRAM/mapping/balances/$USER"
echo ""

# ══════════════════════════════════════════════════════════════════
# STEP 6: Approve ZKPerp to spend USDC
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 6: Approving ZKPerp to spend USDC ==="

# Get program address
cd $ZKPERP_DIR
PROGRAM_ADDR=$(leo run add_liquidity 100u128 $USER 2>&1 | grep -oP 'aleo1[a-z0-9]{58}' | head -4 | tail -1)
echo "ZKPerp program address: $PROGRAM_ADDR"

cd $MOCK_USDC_DIR
leo execute approve $PROGRAM_ADDR 10000000000u128 $NETWORK $CONSENSUS --yes
sleep 5

# ══════════════════════════════════════════════════════════════════
# STEP 7: Set Oracle Price
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 7: Setting Oracle Price (BTC = \$100,000) ==="
cd $ZKPERP_DIR

# Price: $100,000 with 8 decimals = 10000000000u64
leo execute update_price 0field 10000000000u64 1u32 $NETWORK $CONSENSUS --yes
sleep 5

echo "Checking oracle price..."
curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM/mapping/oracle_prices/0field"
echo ""

# ══════════════════════════════════════════════════════════════════
# STEP 8: Add Liquidity
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 8: Adding Liquidity (\$100 USDC) ==="
leo execute add_liquidity 100000000u128 $USER $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/add_liquidity.log
sleep 5

echo "Checking pool state..."
curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM/mapping/pool_state/0field"
echo ""

# ══════════════════════════════════════════════════════════════════
# STEP 9: Open Long Position
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 9: Opening Long Position (5x leverage) ==="
echo "  Collateral: \$10 USDC"
echo "  Size: \$50"
echo "  Direction: Long BTC"

# open_position(collateral, size, is_long, entry_price, max_slippage, nonce, recipient)
leo execute open_position 10000000u128 50000000u64 true 10000000000u64 100000000u64 1field $USER $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/open_position.log
sleep 5

echo "Checking pool state after position..."
curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM/mapping/pool_state/0field"
echo ""

# Check position_open_blocks mapping
echo "Checking position_open_blocks..."
python3 << 'PYEOF'
import re
with open('/tmp/open_position.log', 'r') as f:
    content = f.read()
match = re.search(r'position_id:\s*(\d+field)', content)
if match:
    position_id = match.group(1)
    print(f"Position ID: {position_id}")
    with open('/tmp/position_id.txt', 'w') as f:
        f.write(position_id)
PYEOF

if [ -f "/tmp/position_id.txt" ]; then
    POSITION_ID=$(cat /tmp/position_id.txt)
    echo "Checking open_block for position..."
    curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM/mapping/position_open_blocks/$POSITION_ID"
    echo ""
fi

# Extract Position record
if grep -q "Transaction accepted" /tmp/open_position.log; then
    echo "✅ open_position SUCCESS"
    
    mkdir -p $ZKPERP_DIR/records
    python3 << 'PYEOF'
import re
with open('/tmp/open_position.log', 'r') as f:
    content = f.read()

pattern = r'\{[^{}]+\}'
matches = re.findall(pattern, content, re.DOTALL)

for m in matches:
    record = m.strip()
    # Position record has position_id but NOT trader field
    if 'position_id:' in m and 'size_usdc:' in m and 'trader:' not in m:
        with open('records/position.txt', 'w') as f:
            f.write(record)
        print("✅ Position record saved")
        print(f"   {record[:100]}...")
        break
PYEOF
else
    echo "❌ open_position FAILED"
    exit 1
fi



# ══════════════════════════════════════════════════════════════════
# STEP 10: Price Movement
# ══════════════════════════════════════════════════════════════════

if [ "$TEST_SCENARIO" -eq 1 ]; then
    echo ""
    echo "=== STEP 10: Price UP to \$105,000 (+5%) ==="
    leo execute update_price 0field 10500000000u64 2u32 $NETWORK $CONSENSUS --yes
    sleep 5
    
elif [ "$TEST_SCENARIO" -eq 2 ]; then
    echo ""
    echo "=== STEP 10: Price DOWN to \$60,000 (-40%) ==="
    leo execute update_price 0field 6000000000u64 2u32 $NETWORK $CONSENSUS --yes
    sleep 5
fi

echo "Checking new oracle price..."
curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM/mapping/oracle_prices/0field"
echo ""

# ══════════════════════════════════════════════════════════════════
# STEP 11: Close or Liquidate
# ══════════════════════════════════════════════════════════════════

if [ "$TEST_SCENARIO" -eq 1 ]; then
    echo ""
    echo "=== STEP 11: TRADER Closes Position (with profit) ==="
    
    if [ -f "$ZKPERP_DIR/records/position.txt" ]; then
        POSITION_RECORD=$(cat $ZKPERP_DIR/records/position.txt)
        echo "Position record loaded"
        
        # close_position(position, min_price, max_price, expected_payout)
        # Expected payout: ~$12 ($10 collateral - fee + $2.50 profit - borrow fee)
        leo execute close_position "$POSITION_RECORD" 10400000000u64 10600000000u64 12000000u128 $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/close_position.log
        sleep 5
        
        if grep -q "Transaction accepted" /tmp/close_position.log; then
            echo "✅ close_position SUCCESS - Trader closed with profit!"
            echo "Waiting for mapping updates to finalize..."
            sleep 3
        else
            echo "❌ close_position FAILED"
            echo "Note: Borrow fee might be higher than expected. Try lower expected_payout."
        fi
    else
        echo "❌ Position record not found"
    fi

elif [ "$TEST_SCENARIO" -eq 2 ]; then
    echo ""
    echo "=== STEP 11: LIQUIDATE Position (permissionless) ==="
    echo ""
    echo "  In v2, anyone can liquidate unhealthy positions"
    echo "  No LiquidationAuth record needed!"
    
    if [ -f "/tmp/position_id.txt" ]; then
        POSITION_ID=$(cat /tmp/position_id.txt)
        
        # liquidate(position_id, is_long, size, collateral, entry_price, liquidator_reward)
        # Reward: 0.5% of $50 = $0.25 = 250000u128
        leo execute liquidate "$POSITION_ID" true 50000000u64 9950000u64 10000000000u64 250000u128 $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/liquidate.log
        sleep 5
        
        if grep -q "Transaction accepted" /tmp/liquidate.log; then
            echo "✅ liquidate SUCCESS - Position liquidated!"
        else
            echo "❌ liquidate FAILED"
        fi
    else
        echo "❌ Position ID not found"
    fi
fi

# ══════════════════════════════════════════════════════════════════
# SUMMARY
# ══════════════════════════════════════════════════════════════════

echo ""
echo "Waiting for all state updates to finalize..."
sleep 3

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

if [ "$TEST_SCENARIO" -eq 1 ]; then
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    echo "SCENARIO 1 COMPLETE: Trader Closed with Profit"
    echo "═══════════════════════════════════════════════════════════════"
elif [ "$TEST_SCENARIO" -eq 2 ]; then
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    echo "SCENARIO 2 COMPLETE: Position Liquidated"
    echo "═══════════════════════════════════════════════════════════════"
fi

echo ""
echo "v2 Features:"
echo "  ✅ Mapping-based admin (no hardcoded addresses)"
echo "  ✅ initialize_roles() sets admin on first call"
echo "  ✅ open_block stored in mapping (correct borrow fee)"
echo "  ✅ Permissionless liquidation (anyone can liquidate)"
echo ""
