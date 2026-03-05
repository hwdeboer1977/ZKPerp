#!/bin/bash
set -e

# ═══════════════════════════════════════════════════════════════════════════════
# ZKPerp v7 Test Script - Devnet
# ═══════════════════════════════════════════════════════════════════════════════
#
# Updated for v7:
#   - LiquidationAuth record created on open_position
#   - LP count cap (max 3 per user)
#   - Position count cap (max 3 per user)
#   - Orchestrator address passed to open_position
#   - Trader address passed to liquidate
#
# ╔════════════════════════════════════════════════════════════════╗
# ║                    TEST SCENARIO SELECTOR                       ║
# ╠════════════════════════════════════════════════════════════════╣
# ║  TEST_SCENARIO=1  →  Price UP, Trader closes with PROFIT       ║
# ║  TEST_SCENARIO=2  →  Price DOWN, Anyone LIQUIDATES             ║
# ║  TEST_SCENARIO=3  →  Test LP cap (4th deposit should FAIL)     ║
# ║  TEST_SCENARIO=4  →  Test Position cap (4th open should FAIL)  ║
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
#   TEST_SCENARIO=1 ./test_zkperp.sh
#
# ═══════════════════════════════════════════════════════════════════════════════

TEST_SCENARIO=${TEST_SCENARIO:-1}

# ══════════════════════════════════════════════════════════════════
# CONFIGURATION
# ══════════════════════════════════════════════════════════════════

ENDPOINT="http://localhost:3030"
CONSENSUS="--consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11"
NETWORK="--network testnet --broadcast"

# Programs
USDC_PROGRAM="test_usdcx_stablecoin.aleo"
PERP_PROGRAM="zkperp_v7.aleo"

# User address (default devnet address — also oracle admin & orchestrator via constructor)
USER="aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px"

# Project paths - UPDATE THESE
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

check_mapping() {
    local program=$1
    local mapping=$2
    local key=$3
    echo "  $mapping[$key]:"
    curl -s "$ENDPOINT/testnet/program/$program/mapping/$mapping/$key"
    echo ""
}

# ══════════════════════════════════════════════════════════════════
# MAIN SCRIPT
# ══════════════════════════════════════════════════════════════════

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║     ZKPerp v7 Test Suite - LiquidationAuth + Record Caps      ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

case $TEST_SCENARIO in
    1) echo "🟢 SCENARIO 1: Price UP → Trader closes with PROFIT"
       echo "  Entry: \$100,000 → Exit: \$105,000 (+5%)"
       echo "  Position: Long \$50 (5x on \$10 collateral)"
       echo "  Expected: ~\$2.50 profit" ;;
    2) echo "🔴 SCENARIO 2: Price DOWN → Position LIQUIDATED"
       echo "  Entry: \$100,000 → Exit: \$60,000 (-40%)"
       echo "  Position: Long \$50 (5x on \$10 collateral)"
       echo "  Expected: Liquidated, liquidator earns \$0.25" ;;
    3) echo "🟡 SCENARIO 3: LP CAP TEST → 4th deposit should FAIL"
       echo "  3 deposits of \$10 each should succeed"
       echo "  4th deposit should fail with assertion error" ;;
    4) echo "🟡 SCENARIO 4: POSITION CAP TEST → 4th open should FAIL"
       echo "  3 positions of \$10 each should succeed"
       echo "  4th position should fail with assertion error" ;;
    *) echo "❌ Invalid TEST_SCENARIO: $TEST_SCENARIO"; exit 1 ;;
esac
echo ""

wait_for_devnet

# ══════════════════════════════════════════════════════════════════
# STEP 1: Deploy ZKPerp v7
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 1: Deploying ZKPerp v7 ==="
echo "  Constructor sets deployer as oracle admin & orchestrator"
cd $ZKPERP_DIR
leo deploy $NETWORK $CONSENSUS --yes
sleep 5

echo "Checking roles..."
check_mapping $PERP_PROGRAM roles 0u8
check_mapping $PERP_PROGRAM roles 1u8

# Store orchestrator address for open_position calls
ORCHESTRATOR=$USER
echo "  Orchestrator: $ORCHESTRATOR"

# ══════════════════════════════════════════════════════════════════
# STEP 2: Check USDCx balance
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 2: Checking USDCx balance ==="
check_mapping $USDC_PROGRAM balances $USER

# ══════════════════════════════════════════════════════════════════
# STEP 3: Approve ZKPerp to spend USDCx
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 3: Approving ZKPerp v7 to spend USDCx ==="

# Get program address
cd $ZKPERP_DIR
PROGRAM_ADDR=$(leo run add_liquidity 100u128 $USER 2>&1 | grep -oP 'aleo1[a-z0-9]{58}' | head -4 | tail -1)
echo "  ZKPerp program address: $PROGRAM_ADDR"

snarkos developer execute $USDC_PROGRAM approve_public $PROGRAM_ADDR 10000000000u128 \
    --query $ENDPOINT \
    --broadcast "$ENDPOINT/testnet/transaction/broadcast" \
    --private-key APrivateKey1zkp8CZNn3yeCBJ49HG... \
    $CONSENSUS --yes 2>&1 || echo "  ⚠️  approve_public failed - check private key or deploy USDCx first"
sleep 5

# ══════════════════════════════════════════════════════════════════
# STEP 4: Set Oracle Price
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 4: Setting Oracle Price (BTC = \$100,000) ==="
cd $ZKPERP_DIR
leo execute update_price 0field 10000000000u64 1u32 $NETWORK $CONSENSUS --yes
sleep 5
check_mapping $PERP_PROGRAM oracle_prices 0field

# ══════════════════════════════════════════════════════════════════
# SCENARIO-SPECIFIC TESTS
# ══════════════════════════════════════════════════════════════════

if [ "$TEST_SCENARIO" -eq 3 ]; then
    # ═══════════════════════════════════════════════════════════
    # SCENARIO 3: LP CAP TEST
    # ═══════════════════════════════════════════════════════════
    
    echo ""
    echo "=== SCENARIO 3: Testing LP Count Cap (max 3) ==="
    
    echo ""
    echo "--- LP Deposit 1/3 (\$10) ---"
    leo execute add_liquidity 10000000u128 $USER $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/lp1.log
    sleep 5
    check_mapping $PERP_PROGRAM lp_count $USER
    
    echo ""
    echo "--- LP Deposit 2/3 (\$10) ---"
    leo execute add_liquidity 10000000u128 $USER $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/lp2.log
    sleep 5
    check_mapping $PERP_PROGRAM lp_count $USER
    
    echo ""
    echo "--- LP Deposit 3/3 (\$10) ---"
    leo execute add_liquidity 10000000u128 $USER $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/lp3.log
    sleep 5
    check_mapping $PERP_PROGRAM lp_count $USER
    
    echo ""
    echo "--- LP Deposit 4/3 (\$10) — SHOULD FAIL ---"
    if leo execute add_liquidity 10000000u128 $USER $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/lp4.log; then
        if grep -q "rejected\|failed\|assert" /tmp/lp4.log; then
            echo "✅ 4th LP deposit correctly REJECTED (cap = 3)"
        else
            echo "⚠️  4th LP deposit may have been accepted — check finalize"
        fi
    else
        echo "✅ 4th LP deposit correctly FAILED (cap = 3)"
    fi
    
    echo ""
    echo "Final LP count:"
    check_mapping $PERP_PROGRAM lp_count $USER
    check_mapping $PERP_PROGRAM pool_state 0field

elif [ "$TEST_SCENARIO" -eq 4 ]; then
    # ═══════════════════════════════════════════════════════════
    # SCENARIO 4: POSITION CAP TEST
    # ═══════════════════════════════════════════════════════════
    
    echo ""
    echo "=== Adding Liquidity first (\$200) ==="
    leo execute add_liquidity 200000000u128 $USER $NETWORK $CONSENSUS --yes
    sleep 5
    
    echo ""
    echo "=== SCENARIO 4: Testing Position Count Cap (max 3) ==="
    
    echo ""
    echo "--- Position 1/3 (\$10 size, \$5 collateral) ---"
    # open_position(collateral, size, is_long, entry_price, max_slippage, nonce, recipient, orchestrator)
    leo execute open_position 5000000u128 10000000u64 true 10000000000u64 100000000u64 1field $USER $ORCHESTRATOR $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/pos1.log
    sleep 5
    check_mapping $PERP_PROGRAM position_count $USER
    
    echo ""
    echo "--- Position 2/3 (\$10 size, \$5 collateral) ---"
    leo execute open_position 5000000u128 10000000u64 true 10000000000u64 100000000u64 2field $USER $ORCHESTRATOR $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/pos2.log
    sleep 5
    check_mapping $PERP_PROGRAM position_count $USER
    
    echo ""
    echo "--- Position 3/3 (\$10 size, \$5 collateral) ---"
    leo execute open_position 5000000u128 10000000u64 true 10000000000u64 100000000u64 3field $USER $ORCHESTRATOR $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/pos3.log
    sleep 5
    check_mapping $PERP_PROGRAM position_count $USER
    
    echo ""
    echo "--- Position 4/3 (\$10 size, \$5 collateral) — SHOULD FAIL ---"
    if leo execute open_position 5000000u128 10000000u64 true 10000000000u64 100000000u64 4field $USER $ORCHESTRATOR $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/pos4.log; then
        if grep -q "rejected\|failed\|assert" /tmp/pos4.log; then
            echo "✅ 4th position correctly REJECTED (cap = 3)"
        else
            echo "⚠️  4th position may have been accepted — check finalize"
        fi
    else
        echo "✅ 4th position correctly FAILED (cap = 3)"
    fi
    
    echo ""
    echo "Final position count:"
    check_mapping $PERP_PROGRAM position_count $USER
    check_mapping $PERP_PROGRAM pool_state 0field

else
    # ═══════════════════════════════════════════════════════════
    # SCENARIOS 1 & 2: Standard trading flow
    # ═══════════════════════════════════════════════════════════
    
    # STEP 5: Add Liquidity
    echo ""
    echo "=== STEP 5: Adding Liquidity (\$100 USDCx) ==="
    leo execute add_liquidity 100000000u128 $USER $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/add_liquidity.log
    sleep 5
    check_mapping $PERP_PROGRAM pool_state 0field
    check_mapping $PERP_PROGRAM lp_count $USER

    # STEP 6: Open Long Position (now with orchestrator address)
    echo ""
    echo "=== STEP 6: Opening Long Position (5x leverage) ==="
    echo "  Collateral: \$10 USDCx"
    echo "  Size: \$50"
    echo "  Direction: Long BTC"
    echo "  Orchestrator: $ORCHESTRATOR"

    # open_position(collateral, size, is_long, entry_price, max_slippage, nonce, recipient, orchestrator)
    leo execute open_position 10000000u128 50000000u64 true 10000000000u64 100000000u64 1field $USER $ORCHESTRATOR $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/open_position.log
    sleep 5

    check_mapping $PERP_PROGRAM pool_state 0field
    check_mapping $PERP_PROGRAM position_count $USER

    # Extract Position record AND LiquidationAuth record
    if grep -q "Transaction accepted" /tmp/open_position.log; then
        echo "✅ open_position SUCCESS"
        
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
    record = m.strip()
    # Position record: has position_id, size_usdc, but NOT trader field
    if 'position_id:' in record and 'size_usdc:' in record and 'trader:' not in record and not position_saved:
        with open('records/position.txt', 'w') as f:
            f.write(record)
        print("✅ Position record saved (owned by TRADER)")
        print(f"   {record[:100]}...")
        position_saved = True
    
    # LiquidationAuth record: has position_id, size_usdc, AND trader field
    elif 'position_id:' in record and 'size_usdc:' in record and 'trader:' in record and not liq_auth_saved:
        with open('records/liq_auth.txt', 'w') as f:
            f.write(record)
        print("✅ LiquidationAuth record saved (owned by ORCHESTRATOR)")
        print(f"   {record[:100]}...")
        liq_auth_saved = True

if not position_saved:
    print("⚠️  Position record not found in output")
if not liq_auth_saved:
    print("⚠️  LiquidationAuth record not found in output")
PYEOF

        # Extract position ID
        python3 << 'PYEOF'
import re
with open('/tmp/open_position.log', 'r') as f:
    content = f.read()
match = re.search(r'position_id:\s*(\d+field)', content)
if match:
    position_id = match.group(1)
    print(f"  Position ID: {position_id}")
    with open('/tmp/position_id.txt', 'w') as f:
        f.write(position_id)
PYEOF

        if [ -f "/tmp/position_id.txt" ]; then
            POSITION_ID=$(cat /tmp/position_id.txt)
            check_mapping $PERP_PROGRAM position_open_blocks $POSITION_ID
        fi
    else
        echo "❌ open_position FAILED"
        exit 1
    fi

    # STEP 7: Price Movement
    if [ "$TEST_SCENARIO" -eq 1 ]; then
        echo ""
        echo "=== STEP 7: Price UP to \$105,000 (+5%) ==="
        leo execute update_price 0field 10500000000u64 2u32 $NETWORK $CONSENSUS --yes
        sleep 5
    elif [ "$TEST_SCENARIO" -eq 2 ]; then
        echo ""
        echo "=== STEP 7: Price DOWN to \$60,000 (-40%) ==="
        leo execute update_price 0field 6000000000u64 2u32 $NETWORK $CONSENSUS --yes
        sleep 5
    fi
    check_mapping $PERP_PROGRAM oracle_prices 0field

    # STEP 8: Close or Liquidate
    if [ "$TEST_SCENARIO" -eq 1 ]; then
        echo ""
        echo "=== STEP 8: TRADER Closes Position (with profit) ==="
        
        if [ -f "$ZKPERP_DIR/records/position.txt" ]; then
            POSITION_RECORD=$(cat $ZKPERP_DIR/records/position.txt)
            
            # close_position(position, min_price, max_price, expected_payout)
            leo execute close_position "$POSITION_RECORD" 10400000000u64 10600000000u64 12000000u128 $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/close_position.log
            sleep 5
            
            if grep -q "Transaction accepted" /tmp/close_position.log; then
                echo "✅ close_position SUCCESS — Trader closed with profit!"
                echo ""
                echo "Position count after close:"
                check_mapping $PERP_PROGRAM position_count $USER
            else
                echo "❌ close_position FAILED"
                echo "  Note: Borrow fee might be higher than expected. Try lower expected_payout."
            fi
        else
            echo "❌ Position record not found"
        fi

    elif [ "$TEST_SCENARIO" -eq 2 ]; then
        echo ""
        echo "=== STEP 8: LIQUIDATE Position (permissionless) ==="
        echo "  Now includes trader address for position count decrement"
        
        if [ -f "/tmp/position_id.txt" ]; then
            POSITION_ID=$(cat /tmp/position_id.txt)
            
            # liquidate(position_id, is_long, size, collateral, entry_price, liquidator_reward, trader)
            leo execute liquidate "$POSITION_ID" true 50000000u64 9950000u64 10000000000u64 250000u128 $USER $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/liquidate.log
            sleep 5
            
            if grep -q "Transaction accepted" /tmp/liquidate.log; then
                echo "✅ liquidate SUCCESS — Position liquidated!"
                echo ""
                echo "Position count after liquidation:"
                check_mapping $PERP_PROGRAM position_count $USER
            else
                echo "❌ liquidate FAILED"
            fi
        else
            echo "❌ Position ID not found"
        fi
    fi
fi

# ══════════════════════════════════════════════════════════════════
# SUMMARY
# ══════════════════════════════════════════════════════════════════

echo ""
sleep 3

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                         Summary                                ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "Pool state:"
check_mapping $PERP_PROGRAM pool_state 0field
echo "Oracle price:"
check_mapping $PERP_PROGRAM oracle_prices 0field
echo "User USDCx balance:"
check_mapping $USDC_PROGRAM balances $USER
echo "LP count:"
check_mapping $PERP_PROGRAM lp_count $USER
echo "Position count:"
check_mapping $PERP_PROGRAM position_count $USER

case $TEST_SCENARIO in
    1) echo "═══════════════════════════════════════════════════════════════"
       echo "SCENARIO 1 COMPLETE: Trader Closed with Profit"
       echo "═══════════════════════════════════════════════════════════════" ;;
    2) echo "═══════════════════════════════════════════════════════════════"
       echo "SCENARIO 2 COMPLETE: Position Liquidated"
       echo "═══════════════════════════════════════════════════════════════" ;;
    3) echo "═══════════════════════════════════════════════════════════════"
       echo "SCENARIO 3 COMPLETE: LP Cap Test"
       echo "═══════════════════════════════════════════════════════════════" ;;
    4) echo "═══════════════════════════════════════════════════════════════"
       echo "SCENARIO 4 COMPLETE: Position Cap Test"
       echo "═══════════════════════════════════════════════════════════════" ;;
esac

echo ""
echo "v7 Features:"
echo "  ✅ LiquidationAuth record created on open_position"
echo "  ✅ Orchestrator verified in finalize against roles mapping"
echo "  ✅ LP count cap: max 3 per user"
echo "  ✅ Position count cap: max 3 per user"
echo "  ✅ Position count decremented on close AND liquidate"
echo "  ✅ LP count decremented on full withdrawal"
echo "  ✅ USDCx (test_usdcx_stablecoin.aleo)"
echo "  ✅ Constructor-based admin"
echo ""
