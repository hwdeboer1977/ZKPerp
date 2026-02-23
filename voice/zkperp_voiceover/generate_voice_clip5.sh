#!/bin/bash
# ZKPerp Clip 5 — Liquidation Flow Voiceover
# Duration: ~72 seconds
# Requires: pip install edge-tts

VOICE="en-US-GuyNeural"
OUTPUT_DIR="./zkperp_voiceover/clip5"

mkdir -p "$OUTPUT_DIR"

echo "🎙️  Generating Clip 5 — Liquidation voiceover..."


echo "→ Generating segment 1: Liquidation overview (0:00-0:08)..."
edge-tts \
  --text "Now let's see the liquidation system in action. BTC has crashed to 4,999 dollars, and there are underwater positions to liquidate. Liquidators earn rewards for this." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/01_overview.mp3"

echo "→ Generating segment 2: Explorer view (0:08-0:20)..."
edge-tts \
  --text "First we check the position's transaction on the Provable Explorer. You can see the open position function call on the zkperp contract." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/02_explorer.mp3"

echo "→ Generating segment 3: Fetch position (0:20-0:32)..."
edge-tts \
  --text "Back on the Liquidate page, we paste the transaction ID and hit Fetch. The system loads the position details" \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/03_fetch_position.mp3"

echo "→ Generating segment 4: Liquidatable warning (0:32-0:42)..."
edge-tts \
  --text "The position is flagged as liquidatable." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/04_liquidatable.mp3"

echo "→ Generating segment 5: Execute + confirm (0:42-0:58)..."
edge-tts \
  --text "We execute the liquidation. The proof is generated and broadcast. Once confirmed, the position is closed." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/05_execute.mp3"

echo "→ Generating segment 6: Result (0:58-0:72)..."
edge-tts \
  --text "The pool liquidity adjusts to 389 dollars and the long open interest drops from 39 to 14. The liquidation keeps the protocol solvent while rewarding anyone who helps maintain it." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/06_result.mp3"

echo ""
echo "✅ Done! Files saved to $OUTPUT_DIR/"
echo ""
echo "📂 Generated files:"
ls -la "$OUTPUT_DIR/"