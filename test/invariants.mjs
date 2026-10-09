// The invariants that make this plugin safe to hand a wallet to.
//
// Free and offline: it speaks to the server over stdio and reads only the tool
// list, so it costs nothing and needs no network. That matters — an invariant
// check that costs money to run is an invariant check nobody runs.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const child = spawn('node', [fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
let buf = '';
const waiting = new Map();
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  }
});
let nextId = 0;
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(new Error(`${method} did not answer in 15s`)), 15_000);
    waiting.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

const checks = [];
const check = (name, ok, saw) => checks.push({ name, ok, saw });

await call('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'invariants', version: '0' },
});
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

const { result } = await call('tools/list', {});
const tools = result?.tools ?? [];
const byName = new Map(tools.map((t) => [t.name, t]));
const params = (name) => Object.keys(byName.get(name)?.inputSchema?.properties ?? {});

const EXPECTED = [
  'agent_wallet',
  'token_identity',
  'assess_token',
  'assess_token_live',
  'build_swap',
  'submit_swap',
  'return_funds',
];
check('every tool is present', EXPECTED.every((n) => byName.has(n)), tools.map((t) => t.name).join(', '));

/**
 * THE invariant. Both of the plugin's constraints -- the agent can only swap,
 * and funds return only to whoever funded it -- reduce to this: the agent
 * cannot say where money goes. If a parameter ever appears that names a
 * destination, an injected instruction has somewhere to put an address and both
 * constraints are gone at once.
 *
 * Matched on the parameter NAME, which is deliberately blunt. A false positive
 * here costs someone a rename; a false negative costs a wallet.
 */
const DESTINATION_LIKE = /(^|_)(to|dest|destination|recipient|address|payee|payto|wallet|owner|target)(_|$)/i;
const offenders = tools.flatMap((t) =>
  Object.keys(t.inputSchema?.properties ?? {})
    .filter((p) => DESTINATION_LIKE.test(p))
    .map((p) => `${t.name}.${p}`),
);
check('no tool takes a destination address', offenders.length === 0, offenders.join(', ') || 'none');

check('return_funds takes an amount and nothing else', JSON.stringify(params('return_funds')) === '["amount"]', params('return_funds').join(', '));
check('submit_swap takes a swap_id and nothing else', JSON.stringify(params('submit_swap')) === '["swap_id"]', params('submit_swap').join(', '));

// `taker` is the agent itself and is filled in by the server. If it became a
// parameter, the agent could build a swap that pays out to someone else.
check('build_swap does not take a taker', !params('build_swap').includes('taker'), params('build_swap').join(', '));

// The acknowledgement must be the level by name. A boolean parameter would
// turn "I accept this specific finding" into "yes, whatever it was".
const ack = byName.get('build_swap')?.inputSchema?.properties?.acknowledge_risk;
check('acknowledge_risk is a string, not a boolean', ack?.type === 'string', JSON.stringify(ack?.type));

// The two tools that move money must be marked, so a host can require consent.
for (const name of ['submit_swap', 'return_funds']) {
  check(`${name} is annotated as not read-only`, byName.get(name)?.annotations?.readOnlyHint === false, JSON.stringify(byName.get(name)?.annotations));
}

// The paid tools have to say so in words a model will read, because being
// charged without warning is the complaint that ends an integration.
for (const name of ['assess_token', 'assess_token_live', 'build_swap']) {
  check(`${name} says it is paid`, (byName.get(name)?.description ?? '').includes('PAID'), 'description');
}

// ------------------------------------------------- the skill must not drift
//
// The skill teaches prices and tool names. If either moves in the tools and not
// in the skill, an agent is told one thing and charged another -- and the
// complaint lands on the price, not on the documentation. So the agreement is
// checked rather than remembered.
const skill = await readFile(new URL('../skills/opindex-trading/SKILL.md', import.meta.url), 'utf8');

const namesInSkill = [...skill.matchAll(/`([a-z_]+)\(/g)].map((m) => m[1]);
const unknownInSkill = [...new Set(namesInSkill)].filter((n) => !byName.has(n));
check('every tool the skill names exists', unknownInSkill.length === 0, unknownInSkill.join(', ') || 'none');

const missingFromSkill = EXPECTED.filter((n) => !skill.includes(n));
check('the skill mentions every tool', missingFromSkill.length === 0, missingFromSkill.join(', ') || 'none');

// Comparing SETS, not membership. Asking whether a price appears somewhere in
// the skill proves nothing about a document that mentions prices in several
// places: a wrong price in the table passes while the right one still stands
// in a worked example below.
const PRICES = { assess_token: '$0.005', assess_token_live: '$0.03', build_swap: '$0.05' };
const expectedPrices = new Set(Object.values(PRICES));

for (const [tool, price] of Object.entries(PRICES)) {
  check(`${tool}'s own description states ${price}`, (byName.get(tool)?.description ?? '').includes(price), 'description');
}

const pricesInSkill = new Set([...skill.matchAll(/\$\d+\.\d+/g)].map((m) => m[0]));
const stray = [...pricesInSkill].filter((p) => !expectedPrices.has(p));
const absent = [...expectedPrices].filter((p) => !pricesInSkill.has(p));
check(
  'the skill names every real price and no other',
  stray.length === 0 && absent.length === 0,
  `unexpected: ${stray.join(', ') || 'none'}; missing: ${absent.join(', ') || 'none'}`,
);

// The one sentence an agent must not be left to infer: being refused costs
// money.
check(
  'the skill says a refusal is charged',
  /refusal is charged|needs_acknowledgement\*\* refusal|The refusal is charged/i.test(skill),
  'skill text',
);

child.kill();

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : ` — saw ${c.saw}`}`);
}
console.log(failed === 0 ? `\n${checks.length} invariants hold.` : `\n${failed} of ${checks.length} FAILED.`);
process.exit(failed === 0 ? 0 : 1);
