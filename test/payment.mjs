// What the agent signs when a server asks to be paid.
//
// Free and offline, like `invariants.mjs`. `fetch` is replaced before the
// paying fetch is built, so the "service" and the Solana RPC the payment
// scheme reads (the USDC mint, a recent blockhash) are both answered from
// here: nothing leaves the machine, and the key is a throwaway one in a
// temporary directory, never the agent's own.
//
// `pay.mjs` sets no spending policy of its own — `mcp/server.mjs` says why.
// What it does carry are the x402 library's defaults, and those are what an
// upgrade could change without anyone noticing, so they are pinned here:
//
//   * it signs exactly the quote — that amount of USDC to that payee, with the
//     service's facilitator paying the fee — and nothing besides;
//   * it pays at most once per request: a second 402 is handed back, not paid;
//   * it pays only on Solana mainnet, only in an asset the library knows, and
//     only up to the library's default of $1 a payment.
//
// What it does NOT check, stated plainly: that the amount is the price the
// tool's description names. A 402 asking $0.90 for a $0.005 answer is paid.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { MintLayout, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';

const keyDir = mkdtempSync(join(tmpdir(), 'opindex-payment-test-'));
process.env.OPINDEX_AGENT_KEY = join(keyDir, 'agent.json');

const { payingFetch } = await import('../src/pay.mjs');
const { loadOrCreateKey } = await import('../src/agent.mjs');

const MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const TRANSFER_CHECKED = 12;

const SERVICE = 'http://service.test';
const ROUTE = `${SERVICE}/agent/v1/assess/So11111111111111111111111111111111111111112`;
const PAY_TO = Keypair.generate().publicKey;
const FEE_PAYER = Keypair.generate().publicKey;
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const agent = loadOrCreateKey().keypair.publicKey;

/** What the service quotes for `assess_token`, with whatever `overrides` change. */
const quote = (overrides = {}) => ({
  scheme: 'exact',
  network: MAINNET,
  amount: '5000',
  asset: USDC.toBase58(),
  payTo: PAY_TO.toBase58(),
  maxTimeoutSeconds: 60,
  extra: { feePayer: FEE_PAYER.toBase58() },
  ...overrides,
});

const b64json = (value) => Buffer.from(JSON.stringify(value)).toString('base64');
const unb64json = (text) => JSON.parse(Buffer.from(text, 'base64').toString('utf8'));

const paymentRequired = (accepts) =>
  new Response(null, {
    status: 402,
    headers: {
      'PAYMENT-REQUIRED': b64json({
        x402Version: 2,
        error: 'Payment required',
        resource: { url: ROUTE, description: '', mimeType: 'application/json' },
        accepts,
      }),
    },
  });

const settled = () =>
  Response.json(
    { mint: 'So11111111111111111111111111111111111111112' },
    {
      headers: {
        'PAYMENT-RESPONSE': b64json({ success: true, transaction: '5'.repeat(88), network: MAINNET }),
      },
    },
  );

// --- the chain, as much of it as paying reads ---------------------------------

const mintAccount = Buffer.alloc(MintLayout.span);
MintLayout.encode(
  {
    mintAuthorityOption: 0,
    mintAuthority: PublicKey.default,
    supply: 0n,
    decimals: 6,
    isInitialized: true,
    freezeAuthorityOption: 0,
    freezeAuthority: PublicKey.default,
  },
  mintAccount,
);

async function rpc(request) {
  const { id, method } = await request.json();
  const results = {
    getAccountInfo: {
      context: { slot: 1 },
      value: {
        data: [mintAccount.toString('base64'), 'base64'],
        executable: false,
        lamports: 1461600,
        owner: TOKEN_PROGRAM_ID.toBase58(),
        rentEpoch: 0,
        space: MintLayout.span,
      },
    },
    getLatestBlockhash: { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 } },
  };
  if (!(method in results)) {
    throw new Error(`the payment scheme made an RPC call this test does not answer: ${method}`);
  }
  return Response.json({ jsonrpc: '2.0', id, result: results[method] });
}

// --- the network ---------------------------------------------------------------

let seen = [];
let serve = () => {
  throw new Error('no scenario is running');
};
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).origin === SERVICE) {
    seen.push(request);
    return serve(request, seen.length);
  }
  return rpc(request);
};

/**
 * One paid GET, with `respond` playing the service.
 *
 * Returns what came back (or what was thrown) and every request the service
 * saw, because the question each check asks is about those requests: how many
 * there were, and what the signed one carried.
 */
async function run(respond) {
  seen = [];
  serve = respond;
  const payingGet = await payingFetch();
  try {
    return { response: await payingGet(ROUTE), requests: seen };
  } catch (error) {
    return { error, requests: seen };
  }
}

const signed = (requests) => requests.filter((r) => r.headers.has('payment-signature'));

/** The transfer a signed request carries, read back out of its transaction. */
function transferIn(request) {
  const payment = unb64json(request.headers.get('payment-signature'));
  const tx = VersionedTransaction.deserialize(Buffer.from(payment.payload.transaction, 'base64'));
  const keys = tx.message.staticAccountKeys;
  const programs = tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex].toBase58());
  const transfers = tx.message.compiledInstructions.filter(
    (ix) => keys[ix.programIdIndex].equals(TOKEN_PROGRAM_ID) && ix.data[0] === TRANSFER_CHECKED,
  );
  const signatureOf = (key) => tx.signatures[keys.findIndex((k) => k.equals(key))];
  const data = transfers[0] && Buffer.from(transfers[0].data);
  const account = (i) => transfers[0] && keys[transfers[0].accountKeyIndexes[i]];
  return {
    payment,
    programs,
    transfers: transfers.length,
    amount: data?.readBigUInt64LE(1),
    decimals: data?.[9],
    mint: account(1),
    destination: account(2),
    authority: account(3),
    feePayer: keys[0],
    agentSigned: signatureOf(agent)?.some((b) => b !== 0) ?? false,
    feePayerSigned: signatureOf(FEE_PAYER)?.some((b) => b !== 0) ?? false,
  };
}

const checks = [];
const check = (name, ok, saw) => checks.push({ name, ok, saw });

// --- it signs exactly the quote ------------------------------------------------

{
  const offered = quote();
  const { response, error, requests } = await run((_req, n) => (n === 1 ? paymentRequired([offered]) : settled()));
  check('a quoted call is paid and answered', response?.status === 200, error ?? response?.status);
  check('one unsigned request, then one signed one', requests.length === 2 && signed(requests).length === 1, requests.length);

  const t = signed(requests)[0] && transferIn(signed(requests)[0]);
  check('the payment echoes the quote verbatim', isDeepStrictEqual(t?.payment.accepted, offered), JSON.stringify(t?.payment.accepted));
  check('it signs exactly one transfer', t?.transfers === 1, t?.transfers);
  check('of exactly the quoted amount', t?.amount === 5000n, t?.amount);
  check('in USDC, at its own decimals', t?.mint?.equals(USDC) && t?.decimals === 6, `${t?.mint} / ${t?.decimals}`);
  check(
    "to the payee's USDC account, and nobody else's",
    t?.destination?.equals(getAssociatedTokenAddressSync(USDC, PAY_TO)),
    t?.destination?.toBase58(),
  );
  check('from the agent, which signs it', t?.authority?.equals(agent) && t?.agentSigned, `${t?.authority} / ${t?.agentSigned}`);
  check(
    "with the facilitator as fee payer, left for it to sign — the agent's SOL is untouched",
    t?.feePayer?.equals(FEE_PAYER) && t?.feePayerSigned === false,
    `${t?.feePayer} / ${t?.feePayerSigned}`,
  );
  const extra = (t?.programs ?? []).filter((p) => ![COMPUTE_BUDGET, TOKEN_PROGRAM_ID.toBase58(), MEMO].includes(p));
  check('and nothing besides: compute budget, the transfer, a memo', t && extra.length === 0, extra.join(', ') || 'none');
}

// --- it pays at most once per request ------------------------------------------

{
  const { response, error, requests } = await run(() => paymentRequired([quote()]));
  check('a second 402 is handed back, not paid again', response?.status === 402, error ?? response?.status);
  check('one payment was signed for it, not two', signed(requests).length === 1, signed(requests).length);
  check('and the request was sent twice in all', requests.length === 2, requests.length);
}

// --- it refuses what it should not pay -----------------------------------------

// Each with the reason it must be refused FOR: a refusal that came from
// somewhere else — an RPC call this file does not answer, say — would pass a
// check that only looked for an error.
for (const [name, offered, reason] of [
  ['a quote on devnet', quote({ network: DEVNET }), /No network\/scheme registered/],
  [
    'a quote in an asset the library does not know',
    quote({ asset: Keypair.generate().publicKey.toBase58() }),
    /only default assets/,
  ],
  ["a quote over the library's $1 default", quote({ amount: '1000001' }), /maxAmountPerPayment \(\$1/],
]) {
  const { response, error, requests } = await run(() => paymentRequired([offered]));
  check(
    `${name} is refused, not paid`,
    reason.test(error?.message ?? '') && signed(requests).length === 0,
    error?.message?.slice(0, 200) ?? response?.status,
  );
}

{
  // The boundary of that default, so a cap that moved either way is seen.
  const { response, error } = await run((_req, n) => (n === 1 ? paymentRequired([quote({ amount: '1000000' })]) : settled()));
  check('exactly $1 is still paid', response?.status === 200, error?.message ?? response?.status);
}

rmSync(keyDir, { recursive: true, force: true });

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : ` — saw ${c.saw}`}`);
}
console.log(failed === 0 ? `\n${checks.length} payment checks hold.` : `\n${failed} of ${checks.length} FAILED.`);
process.exit(failed === 0 ? 0 : 1);
