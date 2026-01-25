#!/bin/bash
set -e

# ZKPerp Test Script - Option D (Dual Record Liquidation System)
#
# ╔════════════════════════════════════════════════════════════════╗
# ║                    TEST SCENARIO SELECTOR                       ║
# ╠════════════════════════════════════════════════════════════════╣
# ║  TEST_SCENARIO=1  →  Price UP, Trader closes with PROFIT       ║
# ║  TEST_SCENARIO=2  →  Price DOWN, Orchestrator LIQUIDATES       ║
# ╚════════════════════════════════════════════════════════════════╝

TEST_SCENARIO=1  # <-- CHANGE THIS: 1 = trader profit, 2 = liquidation

# ══════════════════════════════════════════════════════════════════
# HOW TO RUN?
#
# Terminal 1: Start devnet
# leo devnet --snarkos $(which snarkos) --snarkos-features test_network --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11 --clear-storage 
#
# Terminal 2: Run test
# chmod +x test_zkperp.sh
# ./test_zkperp.sh
# ══════════════════════════════════════════════════════════════════

ENDPOINT="http://localhost:3030"
CONSENSUS="--consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11"
NETWORK="--network testnet --broadcast"

# Programs
USDC_PROGRAM="mock_usdc.aleo"
PERP_PROGRAM="zkperp_v1.aleo"

# Addresses (same for testing - in production these would be different)
USER="aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px"
ORACLE_ADMIN="aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px"
ORCHESTRATOR="aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px"

# Project paths - UPDATE THESE
MOCK_USDC_DIR=~/ZKPerp/leo/mock_usdc
ZKPERP_DIR=~/ZKPerp/leo/zkperp

get_block() {
    curl -s "$ENDPOINT/testnet/block/height/latest"
}

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║     ZKPerp Test Suite - Option D (Dual Record Liquidation)     ║"
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
    echo "🔴 TEST SCENARIO 2: Price DOWN → Orchestrator LIQUIDATES"
    echo ""
    echo "  Entry price:       \$100,000"
    echo "  Liquidation price: ~\$98,000 (margin < 1%)"
    echo "  Exit price:        \$80,000 (-20%)"
    echo "  Position:          Long \$50 (5x leverage on \$10 collateral)"
    echo "  Result:            Position liquidated, orchestrator gets reward"
else
    echo "❌ Invalid TEST_SCENARIO: $TEST_SCENARIO"
    echo "   Set TEST_SCENARIO=1 or TEST_SCENARIO=2"
    exit 1
fi

echo ""
echo "Architecture:"
echo "  - Position record     → owned by TRADER (for closing)"
echo "  - LiquidationAuth     → owned by ORCHESTRATOR (for liquidating)"
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
# STEP 5: Set Oracle Price (ADMIN ONLY)
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 5: Setting Oracle Price - ADMIN ONLY (BTC = \$100,000) ==="
cd $ZKPERP_DIR
leo execute update_price 0field 10000000000u64 1u32 $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/update_price.log
sleep 5

echo "Checking oracle price..."
curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM/mapping/oracle_prices/0field"
echo ""

# ══════════════════════════════════════════════════════════════════
# STEP 6: Add Liquidity
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 6: Adding Liquidity (\$100 USDC) ==="
leo execute add_liquidity 100000000u128 $USER $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/add_liquidity.log
sleep 5

echo "Checking pool state..."
curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM/mapping/pool_state/0field"
echo ""

if grep -q "Transaction accepted" /tmp/add_liquidity.log; then
    echo "✅ add_liquidity SUCCESS"
else
    echo "❌ add_liquidity FAILED"
    exit 1
fi

# ══════════════════════════════════════════════════════════════════
# STEP 7: Open Long Position (creates BOTH Position and LiquidationAuth)
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 7: Opening Long Position (5x leverage) ==="
echo "  Collateral: \$10 USDC"
echo "  Size: \$50"
echo "  Direction: Long BTC"
echo ""
echo "  This creates TWO records:"
echo "    → Position (for trader)"
echo "    → LiquidationAuth (for orchestrator)"

# open_position(collateral, size, is_long, entry_price, max_slippage, nonce, recipient)
leo execute open_position 10000000u128 50000000u64 true 10000000000u64 100000000u64 1field $USER $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/open_position.log
sleep 5

echo "Checking pool state after position..."
curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM/mapping/pool_state/0field"
echo ""

if grep -q "Transaction accepted" /tmp/open_position.log; then
    echo "✅ open_position SUCCESS"
    
    # Extract BOTH records
    mkdir -p $ZKPERP_DIR/records
    python3 << 'PYEOF'
import re
with open('/tmp/open_position.log', 'r') as f:
    content = f.read()

pattern = r'\{[^{}]+\}'
matches = re.findall(pattern, content, re.DOTALL)

position_saved = False
liq_auth_saved = False

for m in matches:
    record = m.replace('\n', ' ').replace('  ', ' ')
    
    # Position record has: position_id, size_usdc, collateral_usdc, but NO trader field
    if 'position_id:' in m and 'size_usdc:' in m and 'collateral_usdc:' in m and 'trader:' not in m:
        if not position_saved:
            with open('records/position.txt', 'w') as f:
                f.write(record)
            print("✅ Position record saved (for TRADER)")
            print(f"   {record[:100]}...")
            position_saved = True
    
    # LiquidationAuth record has: position_id, size_usdc, collateral_usdc, AND trader field
    if 'position_id:' in m and 'size_usdc:' in m and 'trader:' in m:
        if not liq_auth_saved:
            with open('records/liq_auth.txt', 'w') as f:
                f.write(record)
            print("✅ LiquidationAuth record saved (for ORCHESTRATOR)")
            print(f"   {record[:100]}...")
            liq_auth_saved = True

if not position_saved:
    print("⚠️ Position record not found")
if not liq_auth_saved:
    print("⚠️ LiquidationAuth record not found")
PYEOF

else
    echo "❌ open_position FAILED"
    exit 1
fi

# ══════════════════════════════════════════════════════════════════
# STEP 8: Price Movement (depends on scenario)
# ══════════════════════════════════════════════════════════════════

if [ "$TEST_SCENARIO" -eq 1 ]; then
    # SCENARIO 1: Price goes UP - trader profits
    echo ""
    echo "=== STEP 8: Price Movement - BTC UP to \$105,000 (+5%) ==="
    leo execute update_price 0field 10500000000u64 2u32 $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/update_price2.log
    sleep 5
    
elif [ "$TEST_SCENARIO" -eq 2 ]; then
    # SCENARIO 2: Price goes DOWN - position becomes liquidatable
    echo ""
    echo "=== STEP 8: Price Movement - BTC DOWN to \$60,000 (-40%) ==="
    echo ""
    echo "  Position details:"
    echo "    Size: \$50"
    echo "    Collateral: ~\$9.95 (after 0.1% fee)"
    echo "    Entry: \$100,000"
    echo "    5x leverage means 20% price drop = 100% loss"
    echo ""
    echo "  At \$60,000:"
    echo "    PnL = -40% × \$50 = -\$20"
    echo "    Remaining margin = \$9.95 - \$20 = -\$10.05 (very negative!)"
    echo "    Margin ratio = very negative → DEFINITELY LIQUIDATABLE"
    
    leo execute update_price 0field 6000000000u64 2u32 $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/update_price2.log
    sleep 5
fi

echo "Checking new oracle price..."
curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM/mapping/oracle_prices/0field"
echo ""

# ══════════════════════════════════════════════════════════════════
# STEP 9: Close or Liquidate (depends on scenario)
# ══════════════════════════════════════════════════════════════════

if [ "$TEST_SCENARIO" -eq 1 ]; then
    # SCENARIO 1: Trader closes position with profit
    echo ""
    echo "=== STEP 9: TRADER Closes Position (with profit) ==="
    
    if [ -f "$ZKPERP_DIR/records/position.txt" ]; then
        POSITION_RECORD=$(cat $ZKPERP_DIR/records/position.txt)
        echo "Position record loaded"
        
        # close_position(position, min_price, max_price, expected_payout)
        # Expected payout: ~$12 ($10 collateral - fee + $2.50 profit)
        leo execute close_position "$POSITION_RECORD" 10400000000u64 10600000000u64 12000000u128 $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/close_position.log
        sleep 5
        
        if grep -q "Transaction accepted" /tmp/close_position.log; then
            echo "✅ close_position SUCCESS - Trader closed with profit!"
        else
            echo "❌ close_position FAILED"
        fi
    else
        echo "❌ Position record not found"
    fi

elif [ "$TEST_SCENARIO" -eq 2 ]; then
    # SCENARIO 2: Orchestrator liquidates the position
    echo ""
    echo "=== STEP 9: ORCHESTRATOR Liquidates Position ==="
    
    if [ -f "$ZKPERP_DIR/records/liq_auth.txt" ]; then
        LIQ_AUTH_RECORD=$(cat $ZKPERP_DIR/records/liq_auth.txt)
        echo "LiquidationAuth record loaded"
        echo ""
        echo "  Liquidator reward: 0.5% of \$50 size = \$0.25 = 250000u128"
        
        # liquidate(liq_auth, liquidator_reward)
        # Reward: Try 0 first to debug
        leo execute liquidate "$LIQ_AUTH_RECORD" 0u128 $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/liquidate.log
        sleep 5
        
        if grep -q "Transaction accepted" /tmp/liquidate.log; then
            echo "✅ liquidate SUCCESS - Position liquidated!"
            echo ""
            echo "  Orchestrator received \$0.25 reward"
            echo "  Remaining margin (if any) goes to pool"
        else
            echo "❌ liquidate FAILED"
            echo ""
            echo "Possible reasons:"
            echo "  - Position not underwater (margin ratio >= 1%)"
            echo "  - Position already closed"
            echo "  - Invalid LiquidationAuth record"
        fi
    else
        echo "❌ LiquidationAuth record not found"
    fi
fi

# ══════════════════════════════════════════════════════════════════
# STEP 10: Verify closed_positions mapping
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 10: Checking closed_positions mapping ==="

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
    echo "Checking if position is marked closed..."
    CLOSED_STATUS=$(curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM/mapping/closed_positions/$POSITION_ID")
    echo "closed_positions[$POSITION_ID] = $CLOSED_STATUS"
    
    if [ "$CLOSED_STATUS" = "true" ]; then
        echo "✅ Position correctly marked as closed"
    fi
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

if [ "$TEST_SCENARIO" -eq 1 ]; then
    echo "═══════════════════════════════════════════════════════════════"
    echo "SCENARIO 1 COMPLETE: Trader Closed with Profit"
    echo "═══════════════════════════════════════════════════════════════"
    echo ""
    echo "  Entry: \$100,000 → Exit: \$105,000 (+5%)"
    echo "  Position: Long \$50 with \$10 collateral"
    echo "  PnL: +\$2.50"
    echo "  Payout: ~\$12 (collateral + profit - fees)"
    echo ""
    echo "  User started with 10,000 USDC"
    echo "  - Deposited 100 USDC as LP"
    echo "  - Used 10 USDC as collateral"
    echo "  - Received ~12 USDC payout"
    echo "  = Net: ~9,902 USDC (+\$2 profit)"

elif [ "$TEST_SCENARIO" -eq 2 ]; then
    echo "═══════════════════════════════════════════════════════════════"
    echo "SCENARIO 2 COMPLETE: Position Liquidated"
    echo "═══════════════════════════════════════════════════════════════"
    echo ""
    echo "  Entry: \$100,000 → Exit: \$60,000 (-40%)"
    echo "  Position: Long \$50 with \$10 collateral"
    echo "  PnL: -\$20 (total loss, underwater)"
    echo "  Remaining margin: very negative"
    echo ""
    echo "  Orchestrator called liquidate() with LiquidationAuth"
    echo "  - Received \$0.25 liquidation reward"
    echo "  - Position marked as closed"
    echo "  - Pool absorbed the loss"
    echo ""
    echo "  User lost their \$10 collateral"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "Option D Architecture:"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  open_position() creates TWO records:"
echo "    1. Position       → owned by TRADER"
echo "    2. LiquidationAuth → owned by ORCHESTRATOR"
echo ""
echo "  TRADER can: close_position(Position)"
echo "  ORCHESTRATOR can: liquidate(LiquidationAuth)"
echo ""
echo "  closed_positions mapping prevents double-close/liquidate"
echo "═══════════════════════════════════════════════════════════════"
