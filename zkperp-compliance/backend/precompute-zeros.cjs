const { spawnSync } = require('child_process');
const fs = require('fs');

const LEO_HASHER_DIR = process.env.LEO_HASHER_DIR || '/tmp/test_hashes';
const LEO_BIN = '/home/lupo1977/.cargo/bin/leo';
const DEPTH = 10;
const ZERO_FIELD = '0field';
const CACHE_PATH = './zero-hashes.json';

function leoRun(fnName, ...args) {
  const result = spawnSync(LEO_BIN, ['run', fnName, ...args], {
    cwd: LEO_HASHER_DIR, encoding: 'utf8'
  });
  const match = (result.stdout || '').match(/•\s*([^\n]+field)/);
  if (!match) throw new Error(`Failed: ${result.stderr}`);
  return match[1].trim();
}

const zeros = [ZERO_FIELD];
for (let i = 1; i <= DEPTH; i++) {
  zeros.push(leoRun('get_node', zeros[i-1], zeros[i-1]));
  console.log(`level ${i}: ${zeros[i]}`);
}

fs.writeFileSync(CACHE_PATH, JSON.stringify(zeros, null, 2));
console.log('Saved to', CACHE_PATH);
