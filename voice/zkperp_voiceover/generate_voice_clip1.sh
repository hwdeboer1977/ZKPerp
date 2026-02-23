#!/bin/bash
# ZKPerp Intro Voiceover Generator — Short Version (fits 31s video)
# Requires: pip install edge-tts

VOICE="en-US-GuyNeural"
OUTPUT_DIR="./zkperp_voiceover/clip1/"

mkdir -p "$OUTPUT_DIR"

echo "🎙️  Generating ZKPerp voiceover segments..."

echo "→ Generating full voiceover..."
edge-tts \
  --text "Welcome to this ZKPerp Demo. ZK Perp is the first privacy perpetual DEX on Aleo. Trade BTC long or short with up to twenty-x leverage. Every position is fully private, secured by zero-knowledge proofs. USDCx collateral, bridged from Ethereum, with live oracle pricing. LPs earn fees by depositing into the liquidity pool. Anyone can liquidate underwater positions for a reward. The admin panel controls oracle prices and protocol settings." \
  --voice "$VOICE" \
  --rate=+10% \
  --write-media "$OUTPUT_DIR/full_voiceover.mp3"

echo "→ Generating segment 1: Intro (0:00-0:06)..."
edge-tts \
  --text "Welcome to this ZKPerp Demo. ZK Perp is the first privacy perpetual DEX on Aleo." \
  --voice "$VOICE" \
  --rate=+10% \
  --write-media "$OUTPUT_DIR/01_intro.mp3"

echo "→ Generating segment 2: Trade (0:06-0:14)..."
edge-tts \
  --text "Trade BTC long or short with up to twenty-x leverage. Every position is fully private, secured by zero-knowledge proofs." \
  --voice "$VOICE" \
  --rate=+10% \
  --write-media "$OUTPUT_DIR/02_trade.mp3"

echo "→ Generating segment 3: USDCx (0:14-0:21)..."
edge-tts \
  --text "We use USDCx, bridged from Ethereum, with live oracle pricing." \
  --voice "$VOICE" \
  --rate=+10% \
  --write-media "$OUTPUT_DIR/03_usdcx.mp3"

echo "→ Generating segment 4: Liquidity (0:21-0:23)..."
edge-tts \
  --text "LPs earn fees by depositing into the liquidity pool." \
  --voice "$VOICE" \
  --rate=+10% \
  --write-media "$OUTPUT_DIR/04_liquidity.mp3"

echo "→ Generating segment 5: Liquidate (0:23-0:27)..."
edge-tts \
  --text "Anyone can liquidate underwater positions for a reward." \
  --voice "$VOICE" \
  --rate=+10% \
  --write-media "$OUTPUT_DIR/05_liquidate.mp3"

echo "→ Generating segment 6: Admin (0:27-0:31)..."
edge-tts \
  --text "The admin panel controls oracle prices and protocol settings." \
  --voice "$VOICE" \
  --rate=+10% \
  --write-media "$OUTPUT_DIR/06_admin.mp3"

echo ""
echo "✅ Done! Files saved to $OUTPUT_DIR/"
echo ""
echo "📂 Generated files:"
ls -la "$OUTPUT_DIR/"
