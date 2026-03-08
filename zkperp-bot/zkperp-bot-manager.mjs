#!/usr/bin/env node

/**
 * ZKPerp Bot Manager
 * ==================
 * A lightweight always-on process manager for zkperp-bot_v3.mjs.
 * Runs on a separate port and can start/stop/restart the bot process.
 *
 * API endpoints:
 *   GET  /status        - Bot running state + last stdout lines
 *   POST /start         - Start the bot (no-op if already running)
 *   POST /stop          - Stop the bot (no-op if already stopped)
 *   POST /restart       - Stop then start
 *   GET  /health        - Manager health (always 200 if manager is up)
 *
 * Environment variables:
 *   MANAGER_PORT        - Port for this manager (default: 3000)
 *   BOT_PORT            - Port the bot listens on (default: 3001)
 *   FRONTEND_ORIGIN     - CORS origin (default: http://localhost:5173)
 *   BOT_SCRIPT          - Path to bot script (default: ./zkperp-bot_v3.mjs)
 */

import 'dotenv/config';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  managerPort: parseInt(process.env.MANAGER_PORT || '3000'),
  botPort:     parseInt(process.env.BOT_PORT     || '3001'),
  frontendOrigin: process.env.FRONTEND_ORIGIN   || 'http://localhost:5173',
  botScript:   process.env.BOT_SCRIPT            || path.join(__dirname, 'zkperp-bot.mjs'),
  logLines:    100, // how many recent stdout/stderr lines to keep
};

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════

let botProcess   = null;
let botStartedAt = null;
let botStoppedAt = null;
let recentLogs   = [];   // circular buffer of last N log lines
let restartCount = 0;
let autoRestart  = true; // restart bot if it crashes unexpectedly

function log(msg) {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`[${ts}] [MGR] ${msg}`);
}

function pushLog(line) {
  recentLogs.push({ ts: new Date().toISOString(), line });
  if (recentLogs.length > CONFIG.logLines) recentLogs.shift();
}

// ═══════════════════════════════════════════════════════════════
// BOT LIFECYCLE
// ═══════════════════════════════════════════════════════════════

function isRunning() {
  return botProcess !== null && !botProcess.killed;
}

function startBot() {
  if (isRunning()) { log('Bot already running, ignoring start'); return { ok: false, reason: 'already_running' }; }

  log(`Starting bot: node ${CONFIG.botScript}`);
  botProcess = spawn('node', [CONFIG.botScript], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  botStartedAt = new Date().toISOString();
  restartCount++;

  botProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    lines.forEach(l => { process.stdout.write(`[BOT] ${l}\n`); pushLog(l); });
  });

  botProcess.stderr.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    lines.forEach(l => { process.stderr.write(`[BOT:ERR] ${l}\n`); pushLog(`[ERR] ${l}`); });
  });

  botProcess.on('exit', (code, signal) => {
    botStoppedAt = new Date().toISOString();
    log(`Bot exited — code: ${code}, signal: ${signal}`);
    botProcess = null;

    // Auto-restart on unexpected crash (not when stopped via API)
    if (autoRestart && code !== 0 && signal !== 'SIGTERM') {
      log('Bot crashed — auto-restarting in 5s...');
      setTimeout(() => { if (!isRunning()) startBot(); }, 5000);
    }
  });

  botProcess.on('error', (err) => {
    log(`Failed to spawn bot: ${err.message}`);
    botProcess = null;
  });

  log(`✅ Bot started (PID ${botProcess.pid})`);
  return { ok: true };
}

function stopBot() {
  if (!isRunning()) { log('Bot not running, ignoring stop'); return { ok: false, reason: 'not_running' }; }
  autoRestart = false; // prevent auto-restart when stopped deliberately
  botProcess.kill('SIGTERM');
  log(`⏹ Bot stopped (PID ${botProcess.pid})`);
  // Reset after a moment so future manual starts re-enable auto-restart
  setTimeout(() => { autoRestart = true; }, 3000);
  return { ok: true };
}

async function restartBot() {
  stopBot();
  await new Promise(r => setTimeout(r, 2000));
  return startBot();
}

// ═══════════════════════════════════════════════════════════════
// PROXY: forward /api/* and /health to the bot
// ═══════════════════════════════════════════════════════════════

function proxyToBotRaw(req, res) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'localhost',
      port: CONFIG.botPort,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `localhost:${CONFIG.botPort}` },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
      proxyRes.on('end', resolve);
    });

    proxyReq.on('error', () => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bot not responding', running: isRunning() }));
      resolve();
    });

    if (req.method !== 'GET') {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// HTTP SERVER
// ═══════════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', CONFIG.frontendOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${CONFIG.managerPort}`);
  const json = (data, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // ── Manager health ──────────────────────────────────────────
  if (url.pathname === '/health' && req.method === 'GET') {
    return json({
      manager: 'ok',
      botRunning: isRunning(),
      botPid: botProcess?.pid ?? null,
      botStartedAt,
      botStoppedAt,
      restartCount,
      upSince: managerStartedAt,
    });
  }

  // ── Manager status (with logs) ──────────────────────────────
  if (url.pathname === '/status' && req.method === 'GET') {
    return json({
      running: isRunning(),
      pid: botProcess?.pid ?? null,
      startedAt: botStartedAt,
      stoppedAt: botStoppedAt,
      restartCount,
      recentLogs: recentLogs.slice(-30),
    });
  }

  // ── Start ───────────────────────────────────────────────────
  if (url.pathname === '/start' && req.method === 'POST') {
    const result = startBot();
    return json({ running: isRunning(), ...result });
  }

  // ── Stop ────────────────────────────────────────────────────
  if (url.pathname === '/stop' && req.method === 'POST') {
    const result = stopBot();
    return json({ running: isRunning(), ...result });
  }

  // ── Restart ─────────────────────────────────────────────────
  if (url.pathname === '/restart' && req.method === 'POST') {
    const result = await restartBot();
    return json({ running: isRunning(), ...result });
  }

  // ── Proxy everything else to bot (/api/*, /health on bot port)
  if (url.pathname.startsWith('/api/') || url.pathname === '/bot-health') {
    if (!isRunning()) {
      return json({ error: 'Bot is not running', running: false }, 503);
    }
    // Remap /bot-health → /health on the bot
    if (url.pathname === '/bot-health') req.url = '/health';
    return proxyToBotRaw(req, res);
  }

  res.writeHead(404); res.end();
});

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

const managerStartedAt = new Date().toISOString();

server.listen(CONFIG.managerPort, () => {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║              ZKPerp Bot Manager                            ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  log(`Manager listening on port ${CONFIG.managerPort}`);
  log(`Bot script: ${CONFIG.botScript}`);
  log(`Bot port:   ${CONFIG.botPort}`);
  log('');
  log('Endpoints:');
  log(`  GET  http://localhost:${CONFIG.managerPort}/health`);
  log(`  GET  http://localhost:${CONFIG.managerPort}/status`);
  log(`  POST http://localhost:${CONFIG.managerPort}/start`);
  log(`  POST http://localhost:${CONFIG.managerPort}/stop`);
  log(`  POST http://localhost:${CONFIG.managerPort}/restart`);
  log(`  GET  http://localhost:${CONFIG.managerPort}/api/liq-auths   (proxied to bot)`);
  log(`  GET  http://localhost:${CONFIG.managerPort}/bot-health       (proxied to bot)`);
  console.log('');

  // Auto-start bot on manager launch
  log('Auto-starting bot...');
  startBot();
});

server.on('error', (err) => log(`Server error: ${err.message}`));

// Graceful shutdown
process.on('SIGTERM', () => {
  log('Manager shutting down...');
  autoRestart = false;
  if (isRunning()) botProcess.kill('SIGTERM');
  server.close(() => process.exit(0));
});
