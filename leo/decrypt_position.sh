#!/bin/bash
# decrypt_position.sh - Fetch and decrypt a position record from a transaction
#
# Usage:
#    chmod +x decrypt_position.sh
#   ./decrypt_position.sh <transaction_id>
#
# Example:
#   ./decrypt_position.sh at17c4f3qp2fw6en5rr7x26th29fhs2ha3tysjnfzphk9hnngyfccpqvm0fte

set -e

# Configuration
ENDPOINT="https://api.explorer.provable.com/v1/testnet"
VIEW_KEY="AViewKey1is8iPit9ftsVVkxPe5AAXWbSXbTWCkPRVZZ7v1PAjBFE"

TX_ID=${1:-""}

if [ -z "$TX_ID" ]; then
    echo "Usage: ./decrypt_position.sh <transaction_id>"
    echo ""
    echo "Example:"
    echo "  ./decrypt_position.sh at17c4f3qp2fw6en5rr7x26th29fhs2ha3tysjnfzphk9hnngyfccpqvm0fte"
    exit 1
fi

echo "═══════════════════════════════════════════════════════════════"
echo "  ZKPerp Position Decryptor"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  Transaction: $TX_ID"
echo ""

# Fetch transaction
echo "Fetching transaction..."
TX_DATA=$(curl -s "$ENDPOINT/transaction/$TX_ID")

# Check if transaction exists
if echo "$TX_DATA" | grep -q "error\|not found"; then
    echo "Error: Transaction not found"
    exit 1
fi

# Extract record ciphertext (starts with "record1")
CIPHERTEXT=$(echo "$TX_DATA" | grep -oP 'record1[a-z0-9]+' | head -1)

if [ -z "$CIPHERTEXT" ]; then
    echo "Error: No record found in transaction"
    echo ""
    echo "Raw transaction data:"
    echo "$TX_DATA" | head -100
    exit 1
fi

echo "Found record ciphertext: ${CIPHERTEXT:0:50}..."
echo ""

# Decrypt the record
echo "Decrypting with view key..."
echo ""

DECRYPTED=$(snarkos developer decrypt --view-key "$VIEW_KEY" --ciphertext "$CIPHERTEXT" 2>&1)

if [ $? -eq 0 ]; then
    echo "═══════════════════════════════════════════════════════════════"
    echo "  Decrypted Position Record"
    echo "═══════════════════════════════════════════════════════════════"
    echo ""
    echo "$DECRYPTED"
    echo ""
    
    # Also output as a single line for use in CLI commands
    echo "═══════════════════════════════════════════════════════════════"
    echo "  Record for CLI use (single line)"
    echo "═══════════════════════════════════════════════════════════════"
    echo ""
    # Remove newlines and extra spaces
    SINGLE_LINE=$(echo "$DECRYPTED" | tr '\n' ' ' | sed 's/  */ /g' | sed 's/^ *//' | sed 's/ *$//')
    echo "$SINGLE_LINE"
    echo ""
else
    echo "Error decrypting record:"
    echo "$DECRYPTED"
    exit 1
fi
