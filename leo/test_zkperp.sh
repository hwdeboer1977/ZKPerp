#!/bin/bash
set -e

# ═══════════════════════════════════════════════════════════════════════════════
# ZKPerp v6 Test Script - Devnet
# ═══════════════════════════════════════════════════════════════════════════════
#
# Updated for v6: USDCx (test_usdcx_stablecoin.aleo), constructor-based admin
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
# PREREQUISITES:
#   - USDCx (test_usdcx_stablecoin.aleo) must be deployed on devnet
#     OR you deploy it as part of the devnet genesis
#   - User must have USDCx balance (bridge from Sepolia or mint on devnet)
#
# ═══════════════════════════════════════════════════════════════════════════════

TEST_SCENARIO=1  # <-- CHANGE THIS: 1 = trader profit, 2 = liquidation

# ══════════════════════════════════════════════════════════════════
# CONFIGURATION
# ══════════════════════════════════════════════════════════════════

ENDPOINT="http://localhost:3030"
CONSENSUS="--consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11"
NETWORK="--network testnet --broadcast"

# Programs
USDC_PROGRAM="test_usdcx_stablecoin.aleo"
PERP_PROGRAM="zkperp_v6.aleo"

# User address (default devnet address)
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

# ══════════════════════════════════════════════════════════════════
# MAIN SCRIPT
# ══════════════════════════════════════════════════════════════════

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║       ZKPerp v6 Test Suite - USDCx + Constructor Admin         ║"
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
# STEP 1: Deploy ZKPerp v6
# ══════════════════════════════════════════════════════════════════
#
# NOTE: USDCx (test_usdcx_stablecoin.aleo) must already be deployed.
# On devnet, either include it in genesis or deploy it separately first.
# The constructor automatically sets deployer as oracle admin + orchestrator.

echo ""
echo "=== STEP 1: Deploying ZKPerp v6 ==="
echo "  (Constructor sets deployer as oracle admin & orchestrator)"
cd $ZKPERP_DIR
leo deploy $NETWORK $CONSENSUS --yes
sleep 5

echo "Checking roles (set by constructor)..."
echo "  Oracle Admin:"
curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM/mapping/roles/0u8"
echo ""
echo "  Orchestrator:"
curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM/mapping/roles/1u8"
echo ""

# ══════════════════════════════════════════════════════════════════
# STEP 2: Ensure user has USDCx balance
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 2: Checking USDCx balance ==="
echo "  (On testnet, bridge USDCx at https://usdcx.aleo.dev/)"
echo "  (On devnet, ensure USDCx is deployed and user has balance)"
BALANCE=$(curl -s "$ENDPOINT/testnet/program/$USDC_PROGRAM/mapping/balances/$USER")
echo "  User USDCx balance: $BALANCE"
echo ""

# ══════════════════════════════════════════════════════════════════
# STEP 3: Approve ZKPerp to spend USDCx
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 3: Approving ZKPerp v6 to spend USDCx ==="
echo "  (USDCx uses approve_public, not approve)"

# Get program address by doing a dry run
cd $ZKPERP_DIR
PROGRAM_ADDR=$(leo run add_liquidity 100u128 $USER 2>&1 | grep -oP 'aleo1[a-z0-9]{58}' | head -4 | tail -1)
echo "  ZKPerp program address: $PROGRAM_ADDR"

# NOTE: On devnet you need the USDCx program available locally or use snarkos developer execute
# approve_public(spender, amount)
snarkos developer execute $USDC_PROGRAM approve_public $PROGRAM_ADDR 10000000000u128 \
    --query $ENDPOINT \
    --broadcast "$ENDPOINT/testnet/transaction/broadcast" \
    --private-key APrivateKey1zkp8CZNn3yeCBJ49HG... \
    $CONSENSUS --yes 2>&1 || echo "  ⚠️  approve_public failed - you may need to set the correct private key or deploy USDCx first"
sleep 5

# ══════════════════════════════════════════════════════════════════
# STEP 4: Set Oracle Price
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 4: Setting Oracle Price (BTC = \$100,000) ==="
cd $ZKPERP_DIR

# Price: $100,000 with 8 decimals = 10000000000u64
leo execute update_price 0field 10000000000u64 1u32 $NETWORK $CONSENSUS --yes
sleep 5

echo "Checking oracle price..."
curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM/mapping/oracle_prices/0field"
echo ""

# ══════════════════════════════════════════════════════════════════
# STEP 5: Add Liquidity
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 5: Adding Liquidity (\$100 USDCx) ==="
leo execute add_liquidity 100000000u128 $USER $NETWORK $CONSENSUS --yes 2>&1 | tee /tmp/add_liquidity.log
sleep 5

echo "Checking pool state..."
curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM/mapping/pool_state/0field"
echo ""

# ══════════════════════════════════════════════════════════════════
# STEP 6: Open Long Position
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 6: Opening Long Position (5x leverage) ==="
echo "  Collateral: \$10 USDCx"
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
        print(f"   {record}")
        break
PYEOF
else
    echo "❌ open_position FAILED"
    exit 1
fi

# ══════════════════════════════════════════════════════════════════
# STEP 7: Price Movement
# ══════════════════════════════════════════════════════════════════

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

echo "Checking new oracle price..."
curl -s "$ENDPOINT/testnet/program/$PERP_PROGRAM/mapping/oracle_prices/0field"
echo ""

# ══════════════════════════════════════════════════════════════════
# STEP 8: Close or Liquidate
# ══════════════════════════════════════════════════════════════════

if [ "$TEST_SCENARIO" -eq 1 ]; then
    echo ""
    echo "=== STEP 8: TRADER Closes Position (with profit) ==="
    
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
    echo "=== STEP 8: LIQUIDATE Position (permissionless) ==="
    echo ""
    echo "  Anyone can liquidate unhealthy positions"
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
echo "User USDCx balance:"
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
echo "v6 Features:"
echo "  ✅ USDCx (test_usdcx_stablecoin.aleo) - Circle's official stablecoin"
echo "  ✅ Constructor-based admin (set at deploy time)"
echo "  ✅ initialize_roles() as fallback if constructor didn't set"
echo "  ✅ open_block stored in mapping (correct borrow fee)"
echo "  ✅ Permissionless liquidation (anyone can liquidate)"
echo "  ✅ approve_public / transfer_from_public (USDCx API)"
echo ""
