#!/bin/bash
# ZKPerp Clip 6 — Conclusion Voiceover
# Duration: ~49 seconds
# Requires: pip install edge-tts

VOICE="en-US-GuyNeural"
OUTPUT_DIR="./zkperp_voiceover/clip6"

mkdir -p "$OUTPUT_DIR"

echo "🎙️  Generating Clip 6 — Conclusion voiceover..."

echo "→ Generating full voiceover..."
edge-tts \
  --text "That's ZKPerp — a fully functional privacy-first perpetual futures exchange on Aleo. Let's recap what we just demonstrated. Leveraged trading with up to 20x on BTC, where every position is encrypted using zero-knowledge proofs. A liquidity pool where LPs earn fees as counterparty to all traders. A trustless liquidation system that anyone can participate in and earn rewards. And admin controls for oracle pricing and protocol management. Everything runs on-chain through Leo smart contracts on the Aleo network, with Shield Wallet handling transaction signing and record decryption. Position sizes, entry prices, and PnL are all kept private — no front-running, no MEV, no data leaks. ZKPerp proves that DeFi can be both powerful and private. Built for the Aleo ecosystem. Built for the future of finance." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/full_voiceover.mp3"

echo "→ Generating segment 1: Opening (0:00-0:05)..."
edge-tts \
  --text "That's ZKPerp — a fully functional privacy-first perpetual futures exchange on Aleo. Let's recap what we just demonstrated." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/01_opening.mp3"

echo "→ Generating segment 2: Feature recap (0:05-0:22)..."
edge-tts \
  --text "Leveraged trading with up to 20x on BTC, where every position is encrypted using zero-knowledge proofs. A liquidity pool where LPs earn fees as counterparty to all traders. A trustless liquidation system that anyone can participate in and earn rewards. And admin controls for oracle pricing and protocol management." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/02_feature_recap.mp3"

echo "→ Generating segment 3: Tech stack (0:22-0:35)..."
edge-tts \
  --text "Everything runs on-chain through Leo smart contracts on the Aleo network, with Shield Wallet handling transaction signing and record decryption. Position sizes, entry prices, and PnL are all kept private — no front-running, no MEV, no data leaks." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/03_tech_stack.mp3"

echo "→ Generating segment 4: Closing (0:35-0:49)..."
edge-tts \
  --text "ZKPerp proves that DeFi can be both powerful and private. Built for the Aleo ecosystem. Built for the future of finance." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/04_closing.mp3"

echo ""
echo "✅ Done! Files saved to $OUTPUT_DIR/"
echo ""
echo "📂 Generated files:"
ls -la "$OUTPUT_DIR/"
