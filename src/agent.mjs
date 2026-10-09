// The agent's identity: its own key, made by itself, kept outside this package.
//
// There is no import path for a key here, only creation and reuse. The wallet
// belongs to the agent; it is not yours lent to it.
//
// Where the key lives is a safety property rather than a preference. It
// defaults to the user's home directory, and `keyPath` REFUSES a path inside
// this package even when asked — a key sitting next to source code is one
// careless `git add -f` from being published, and publishing a key cannot be
// undone by deleting the file.

import { Keypair } from '@solana/web3.js';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

/** This package's own directory, so a key cannot be kept inside it. */
const PACKAGE_ROOT = resolve(import.meta.dirname, '..');

const DEFAULT_KEY_PATH = resolve(homedir(), '.opindex/agent/agent.json');

/**
 * The file the agent's key lives in.
 *
 * `OPINDEX_AGENT_KEY` overrides the default, but not into this package.
 */
export function keyPath() {
  const path = resolve(process.env.OPINDEX_AGENT_KEY ?? DEFAULT_KEY_PATH);
  if (path === PACKAGE_ROOT || path.startsWith(`${PACKAGE_ROOT}/`)) {
    throw new Error(
      `refusing to keep a private key inside the package (${path}).\n` +
        `Keys live outside the source tree so that version control cannot publish them.\n` +
        `Unset OPINDEX_AGENT_KEY to use ${DEFAULT_KEY_PATH}.`,
    );
  }
  return path;
}

/**
 * The agent's keypair: loaded if it has one, created on first run.
 *
 * Returns `{ keypair, created }` rather than the keypair alone, because "a new
 * agent was born" and "the agent you funded earlier is back" are different
 * events to a caller and must not look alike.
 */
export function loadOrCreateKey() {
  const path = keyPath();

  if (existsSync(path)) {
    const secret = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')));
    if (secret.length !== 64) {
      throw new Error(`${path} holds ${secret.length} bytes, not the 64 a keypair has`);
    }
    // A mode that has drifted to group- or world-readable is worth a refusal
    // rather than a shrug.
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      throw new Error(
        `${path} is mode ${mode.toString(8)}; a private key must not be readable by anyone else. ` +
          `Run: chmod 600 ${path}`,
      );
    }
    return { keypair: Keypair.fromSecretKey(secret), created: false };
  }

  const keypair = Keypair.generate();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Write first, then narrow: `writeFileSync`'s mode is subject to the process
  // umask, so it cannot be trusted to have produced 600 on its own.
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  chmodSync(path, 0o600);
  return { keypair, created: true };
}

/**
 * What the agent says about itself.
 *
 * The secret key is not in the return value at all — not redacted, absent — so
 * that no caller can print it by being careless with an object and no log line
 * can contain it by accident.
 */
export function identity() {
  const { keypair, created } = loadOrCreateKey();
  return {
    address: keypair.publicKey.toBase58(),
    keyFile: keyPath(),
    keyMode: (statSync(keyPath()).mode & 0o777).toString(8),
    created,
  };
}

if (import.meta.filename === process.argv[1]) {
  const me = identity();
  console.log(me.created ? 'A new agent was born.' : 'This agent already existed.');
  console.log(`  address:  ${me.address}`);
  console.log(`  key file: ${me.keyFile} (mode ${me.keyMode})`);
}
