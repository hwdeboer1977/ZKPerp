#!/bin/bash
# ZKPerp Clip 2 — Liquidity Flow Voiceover
# Duration: ~90 seconds
# Requires: pip install edge-tts

VOICE="en-US-GuyNeural"
OUTPUT_DIR="./zkperp_voiceover/clip2/"

mkdir -p "$OUTPUT_DIR"

echo "🎙️  Generating Clip 2 — Liquidity voiceover..."

echo "→ Generating full voiceover..."
edge-tts \
  --text "Let's start with adding liquidity. Here's the Liquidity Pool page. LPs act as the counterparty to all traders on ZKPerp. The dashboard shows total liquidity at around 290 dollars, with 14 dollars in long open interest and pool utilization at 4 percent. The long-short balance bar shows current market exposure. To provide liquidity, we first approve USDCx. This triggers a zero-knowledge proof through the Shield wallet. The transaction is now being proved and broadcast to the Aleo network. Once confirmed, the approval is complete and we can see it on the explorer. Now we deposit 100 USDC into the pool. Another transaction is submitted and confirmed on-chain. The pool liquidity has updated to 390 dollars, reflecting our deposit. Now let's check our LP position. We click Refresh and decrypt through Shield wallet. This decrypts our private LP record directly in the browser. And there it is — our position shows 100 LP tokens worth 100 dollars, representing a 25 percent share of the pool. We can withdraw anytime by burning our LP tokens." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/full_voiceover.mp3"

echo "→ Generating segment 1: Pool overview (0:00-0:16)..."
edge-tts \
  --text "Let's start with adding liquidity.  Let's connect our shield wallet. Here's the Liquidity Pool page. LPs act as the counterparty to all traders on ZKPerp. The dashboard shows total liquidity at around 290 dollars, with 14 dollars in long open interest." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/01_pool_overview.mp3"

echo "→ Generating segment 2: Approve USDCx (0:16-0:20)..."
edge-tts \
  --text "To provide liquidity, we first approve USDCx. This triggers a zero-knowledge proof through the Shield wallet." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/02_approve.mp3"

echo "→ Generating segment 3: Proving + broadcast (0:20-0:35)..."
edge-tts \
  --text "The transaction is now being proved and broadcast to the Aleo network. Once confirmed, the approval is complete and we can see it on the explorer." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/03_proving.mp3"

echo "→ Generating segment 4: Deposit (0:25-0:54)..."
edge-tts \
  --text "Now we deposit 100 USDC into the pool. Another transaction is submitted and confirmed on-chain." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/04_deposit.mp3"

echo "→ Generating segment 5: Stats (0:54-0:67)..."
edge-tts \
  --text "Now we can see the stats are being updated. The pool liquidity has updated to 390 dollars, reflecting our deposit." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/05_stats.mp3"  

echo "→ Generating segment 6: LP position + decrypt (0.67-0:73)..."
edge-tts \
  --text "Now let's check our LP position. We click Refresh and decrypt through Shield wallet.." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/06_decrypt.mp3"

echo "→ Generating segment 7: Result (0:73-0:90)..."
edge-tts \
  --text "And there it is — our position shows 100 LP tokens worth 100 dollars, representing a 25 percent share of the pool. We can withdraw anytime by burning our LP tokens." \
  --voice "$VOICE" \
  --rate=+5% \
  --write-media "$OUTPUT_DIR/07_result.mp3"

echo ""
echo "✅ Done! Files saved to $OUTPUT_DIR/"
echo ""
echo "📂 Generated files:"
ls -la "$OUTPUT_DIR/"
