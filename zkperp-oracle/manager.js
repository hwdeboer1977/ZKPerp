/**
 * Aleo Oracle Process Manager
 *
 * Spawns coordinator + relayers A/B/C as child processes.
 * Mirrors the zkperp-bot-manager.mjs pattern.
 *
 * Usage:  node manager.js
 *         npm start
 */

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROCESSES = [
  { name: "Coordinator", cmd: "node", args: ["coordinator/coordinator.js"] },
  { name: "Relayer-A",   cmd: "node", args: ["relayer/relayer.js", "A"] },
  { name: "Relayer-B",   cmd: "node", args: ["relayer/relayer.js", "B"] },
  { name: "Relayer-C",   cmd: "node", args: ["relayer/relayer.js", "C"] }
];

const RESTART_DELAY_MS = 3000;

function spawnProcess({ name, cmd, args }) {
  function start() {
    console.log(`[Manager] Starting ${name}...`);

    const child = spawn(cmd, args, {
      cwd: __dirname,
      stdio: "inherit",
      env: { ...process.env }
    });

    child.on("exit", (code, signal) => {
      console.warn(`[Manager] ${name} exited (code=${code} signal=${signal}) — restarting in ${RESTART_DELAY_MS}ms`);
      setTimeout(start, RESTART_DELAY_MS);
    });

    child.on("error", (err) => {
      console.error(`[Manager] ${name} spawn error:`, err.message);
    });

    return child;
  }

  // Stagger startup: coordinator first, then relayers 1s apart
  const index = PROCESSES.findIndex((p) => p.name === name);
  setTimeout(start, index * 1000);
}

console.log("[Manager] Aleo Oracle starting...");
PROCESSES.forEach(spawnProcess);

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[Manager] SIGINT received — shutting down");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("[Manager] SIGTERM received — shutting down");
  process.exit(0);
});
