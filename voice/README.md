# ZKPerp Voiceover Generator

Generate AI voiceover audio for ZKPerp demo videos using Microsoft Edge TTS (free, no limits).

## Setup

```bash
# Create virtual environment
python3 -m venv venv

# Activate it
source venv/bin/activate

# Install edge-tts
pip install edge-tts
```

## Run

```bash
# Make sure venv is active
source venv/bin/activate

# Clip 1 — Intro (31s)
chmod +x zkperp_voiceover/generate_voice_clip1.sh
./zkperp_voiceover/generate_voice_clip1.sh

# Clip 2 — Liquidity Flow (90s)
chmod +x zkperp_voiceover/generate_voice_clip2.sh
./zkperp_voiceover/generate_voice_clip2.sh
```

## Output

### Clip 1 — Intro (`./zkperp_voiceover/clip1/`)

| File | Description | Timeline |
|------|-------------|----------|
| `full_voiceover.mp3` | Complete voiceover (single track) | 0:00 - end |
| `01_intro.mp3` | ZKPerp intro | 0:00 - 0:04 |
| `02_trade.mp3` | Trade page | 0:04 - 0:10 |
| `03_usdcx.mp3` | USDCx + Oracle | 0:10 - 0:15 |
| `04_liquidity.mp3` | Liquidity tab | 0:15 - 0:21 |
| `05_liquidate.mp3` | Liquidate page | 0:21 - 0:27 |
| `06_admin.mp3` | Admin panel | 0:27 - 0:31 |

### Clip 2 — Liquidity Flow (`./zkperp_voiceover/clip2/`)

| File | Description | Timeline |
|------|-------------|----------|
| `full_voiceover.mp3` | Complete voiceover (single track) | 0:00 - end |
| `01_pool_overview.mp3` | Pool dashboard stats | 0:00 - 0:10 |
| `02_approve.mp3` | Approve USDCx | 0:10 - 0:20 |
| `03_proving.mp3` | ZK proof + broadcast | 0:20 - 0:40 |
| `04_deposit.mp3` | Deposit liquidity | 0:40 - 0:55 |
| `05_decrypt.mp3` | Decrypt LP records via Shield | 0:55 - 1:15 |
| `06_result.mp3` | LP position result | 1:15 - 1:30 |

## Import into DaVinci Resolve

1. Open your project in DaVinci Resolve
2. Go to the **Edit** page
3. Drag audio files from Media Pool onto the **A1** audio track
4. Align segments to their matching timestamps
5. Use **Fairlight** tab for fine-tuning volume and fades

## Change Voice

```bash
# List all available English voices
edge-tts --list-voices | grep en-US

# Good alternatives:
# en-US-AndrewMultilingualNeural  (deeper male)
# en-US-AriaNeural                (female)
# en-US-DavisNeural               (casual male)
```

Edit the `VOICE` variable at the top of each `.sh` script to change.

## Quick Test

```bash
edge-tts --text "This is ZKPerp" --voice en-US-GuyNeural --write-media test.mp3
```