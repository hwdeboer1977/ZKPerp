#!/bin/bash
# ZKPerp Clip 4 — Admin Panel Voiceover
# Duration: ~49 seconds
# Requires: pip install edge-tts

VOICE="en-US-GuyNeural"
OUTPUT_DIR="./zkperp_voiceover/clip4"

mkdir -p "$OUTPUT_DIR"

echo "🎙️  Generating Clip 4 — Admin voiceover..."


echo "→ Generating segment 1: Admin overview (0:00-0:16)..."
edge-tts \
  --text "This is the Admin Panel. It starts with limited access — only the orchestrator wallet can manage the protocol. We switch to the admin wallet and access is granted." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/01_admin_overview.mp3"

echo "→ Generating segment 2: Dashboard stats (0:16-0:21)..."
edge-tts \
  --text "The dashboard shows the current oracle price, pool liquidity, and open interest." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/02_dashboard.mp3"

echo "→ Generating segment 3: Update oracle price (0:21-0:28)..."
edge-tts \
  --text "Now we'll update the oracle price. We enter a new price of 4,999 dollars — simulating a major crash. The price impact preview shows a 93 percent drop from the current 80,000." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/03_update_price.mp3"

echo "→ Generating segment 4: Transaction confirm (0:28-0:47)..."
edge-tts \
  --text "We submit the update and the transaction is proved on-chain. Once confirmed, the oracle price is now 4,999 dollars." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/04_confirmed.mp3"


echo ""
echo "✅ Done! Files saved to $OUTPUT_DIR/"
echo ""
echo "📂 Generated files:"
ls -la "$OUTPUT_DIR/"
