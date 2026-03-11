#!/bin/bash
# ============================================================
# ZKPerp Bot — Vultr VM Setup Script
# Ubuntu 24.04 LTS, run as root
# Usage: bash setup-zkperp.sh
# ============================================================

set -e

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║       ZKPerp Vultr VM Setup                ║"
echo "╚════════════════════════════════════════════╝"
echo ""

# ── 1. System update ────────────────────────────────────────
echo "[1/7] Updating system..."
apt-get update -qq && apt-get upgrade -y -qq

# ── 2. Node.js 20 ───────────────────────────────────────────
echo "[2/7] Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null
apt-get install -y nodejs -qq
echo "      Node: $(node -v) | npm: $(npm -v)"

# ── 3. Git + Git LFS (required for snarkos binary) ──────────
echo "[3/7] Installing git + git-lfs..."
apt-get install -y git git-lfs -qq
git lfs install > /dev/null
echo "      Git: $(git --version)"

# ── 4. Clone repo ───────────────────────────────────────────
echo "[4/7] Cloning ZKPerp repo..."
cd /opt
if [ -d "ZKPerp" ]; then
  echo "      /opt/ZKPerp already exists — pulling latest..."
  cd ZKPerp && git pull && git lfs pull
else
  git clone https://github.com/hwdeboer1977/ZKPerp
  cd ZKPerp
  echo "      Running git lfs pull for snarkos binary..."
  git lfs pull
fi

# Verify snarkos binary
if [ ! -f "./snarkos" ]; then
  echo "      ⚠️  snarkos binary not found after lfs pull"
  echo "      Check: git lfs ls-files | grep snarkos"
else
  chmod +x ./snarkos
  echo "      ✅ snarkos binary ready"
fi

# ── 5. npm install ──────────────────────────────────────────
echo "[5/7] Installing npm dependencies..."
npm install --silent

# ── 6. .env setup ───────────────────────────────────────────
echo "[6/7] Setting up .env..."
if [ ! -f ".env" ]; then
  cat > .env << 'EOF'


# ── snarkos path ─────────────────────────────────
SNARKOS_PATH=./snarkos
EOF
  echo "      ✅ .env created — FILL IN your keys before starting!"
else
  echo "      .env already exists — skipping"
fi

# ── 7. PM2 ──────────────────────────────────────────────────
echo "[7/7] Installing pm2..."
npm install -g pm2 --silent
echo "      PM2: $(pm2 -v)"

# ── Firewall: open port 3000 for frontend ───────────────────
if command -v ufw &> /dev/null; then
  ufw allow 22/tcp   > /dev/null 2>&1 || true
  ufw allow 3000/tcp > /dev/null 2>&1 || true
  ufw allow 3001/tcp > /dev/null 2>&1 || true
  echo "      Firewall: ports 22, 3000, 3001 opened"
fi

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║   Setup complete! Next steps:              ║"
echo "╠════════════════════════════════════════════╣"
echo "║                                            ║"
echo "║  1. Fill in your keys:                     ║"
echo "║     nano /opt/ZKPerp/.env                  ║"
echo "║                                            ║"
echo "║  2. Start the bot:                         ║"
echo "║     cd /opt/ZKPerp                         ║"
echo "║     pm2 start zkperp-bot-manager.mjs       ║"
echo "║       --name zkperp                        ║"
echo "║     pm2 save                               ║"
echo "║     pm2 startup                            ║"
echo "║                                            ║"
echo "║  3. Update Vercel env var:                 ║"
echo "║     VITE_BOT_URL=http://<YOUR_IP>:3000     ║"
echo "║                                            ║"
echo "║  4. Monitor:                               ║"
echo "║     pm2 logs zkperp                        ║"
echo "║     pm2 monit                              ║"
echo "╚════════════════════════════════════════════╝"
echo ""
