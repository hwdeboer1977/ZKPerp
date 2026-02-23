#!/bin/bash
# ZKPerp Clip 3 — Opening a Position Voiceover
# Duration: ~90 seconds
# Requires: pip install edge-tts

VOICE="en-US-GuyNeural"
OUTPUT_DIR="./zkperp_voiceover/clip3"

mkdir -p "$OUTPUT_DIR"

echo "🎙️  Generating Clip 3 — Position voiceover..."



echo "→ Generating segment 1: Trade page overview (0:00-0:10)..."
edge-tts \
  --text "Now let's open a leveraged position. ZKPerp is using USDCx from the Aleo network. Here we can bridge USDC from Ethereum to Aleo. We're on the Trade page with our wallet connected. BTC is currently at 80,000 dollars." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/01_trade_overview.mp3"

echo "→ Generating segment 2: Enter trade params (0:10-0:25)..."
edge-tts \
  --text "We'll go long on BTC. We enter 5 USDC as collateral and set the position size to 25 USDC — that's 5x leverage. The order summary shows our entry price, leverage, and a liquidation price of around 64,000 dollars." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/02_enter_params.mp3"

echo "→ Generating segment 3: Shield wallet approval (0:25-0:35)..."
edge-tts \
  --text "We submit the trade. Shield wallet pops up to approve the execution" \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/03_shield_approve.mp3"

echo "→ Generating segment 4: ZK proof + confirming (0:35-0:65)..."
edge-tts \
  --text "The zero-knowledge proof is now being generated and broadcast to the network. This keeps our position details completely private on-chain. While we wait for confirmation, notice the feature cards at the bottom — private positions, up to 20x leverage, and no front-running." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/04_proving.mp3"

echo "→ Generating segment 5: Confirmed + decrypt (0:65-0:80)..."
edge-tts \
  --text "The transaction is confirmed. We hit Refresh and the balance has changed. The next step is to decrypt our private position using Shield wallet to reveal the details." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/05_confirmed.mp3"

echo "→ Generating segment 6: Position result (0:80-0:90)..."
edge-tts \
  --text "And here's our position — long BTC at 5x leverage, 25 dollar size, about 5 dollars collateral, entry at 80,000, and current PnL at zero." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/06_position_result.mp3"

echo ""
echo "✅ Done! Files saved to $OUTPUT_DIR/"
echo ""
echo "📂 Generated files:"
ls -la "$OUTPUT_DIR/"
