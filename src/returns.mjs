// Where the agent is allowed to send money back.
//
// The agent can return funds to exactly one address: whoever funded it first.
// That address is not configuration and is not stored anywhere — it is read
// from chain history on every call, because a first transaction stays first
// forever. So the answer is immutable by construction and there is nothing
// local to tamper with; a config file holding a "return address" would be the
// first thing an attacker edits.
//
// This is what makes a return safe to offer without a destination parameter:
// the agent cannot name where money goes, so an injected instruction has
// nowhere to send it.
//
// Residual risk, stated because the interface has to carry it: if the wallet
// was funded from an exchange, the derived address is the exchange's hot wallet
// and returning there can lose the money. An exchange address cannot be told
// from a personal one, so every surface that shows the agent's wallet shows
// this address too — early, while being wrong is still cheap.

import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';

const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

/**
 * The owner that first sent USDC to this agent.
 *
 * Reads the oldest transaction on the agent's USDC account -- which is the one
 * that created it, since the account comes into existence with its first
 * transfer -- and returns the authority that signed the transfer in.
 *
 * Returns `{ address, signature, fundedAt }`, or `{ address: null, why }` when
 * it cannot be established. Never guesses: a return address we are unsure of is
 * worse than no return address, because the agent would act on it.
 */
export async function returnAddress(conn, ownerAddress) {
  const owner = new PublicKey(ownerAddress);
  const ata = await getAssociatedTokenAddress(USDC, owner);

  let signatures;
  try {
    signatures = await conn.getSignaturesForAddress(ata, { limit: 1000 });
  } catch (err) {
    return { address: null, why: `could not read the account's history: ${err}` };
  }
  if (signatures.length === 0) {
    return { address: null, why: 'this agent has never been funded with USDC' };
  }
  if (signatures.length === 1000) {
    // Paging backwards would work, but a wrong answer here sends money to the
    // wrong place. Refusing is the cheap failure.
    return {
      address: null,
      why: 'the account has more history than one page; the first funder cannot be established cheaply',
    };
  }

  const oldest = signatures[signatures.length - 1];
  const tx = await conn.getParsedTransaction(oldest.signature, { maxSupportedTransactionVersion: 255 });
  if (!tx) {
    return { address: null, why: `the funding transaction ${oldest.signature} could not be read` };
  }

  const instructions = [
    ...tx.transaction.message.instructions,
    ...(tx.meta?.innerInstructions ?? []).flatMap((inner) => inner.instructions),
  ];
  const transferIn = instructions.find(
    (ix) =>
      ix.parsed &&
      (ix.parsed.type === 'transferChecked' || ix.parsed.type === 'transfer') &&
      ix.parsed.info?.destination === ata.toBase58(),
  );
  if (!transferIn) {
    return {
      address: null,
      why: `the oldest transaction on this account is not an incoming transfer (${oldest.signature})`,
    };
  }

  // `authority` on transferChecked is the sending owner; `source` is their
  // token account, which is not where a return should go.
  const address = transferIn.parsed.info.authority ?? transferIn.parsed.info.owner ?? null;
  if (!address) {
    return { address: null, why: 'the funding transfer names no authority to return to' };
  }

  return {
    address,
    signature: oldest.signature,
    fundedAt: oldest.blockTime ? new Date(oldest.blockTime * 1000).toISOString() : null,
  };
}

/** The public endpoint, named because it is the default and that is a fact worth stating. */
export const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

/**
 * An RPC connection, falling back to the public endpoint rather than refusing.
 *
 * The plugin has to be installable with no configuration at all, because the
 * promise it makes -- that paying for an answer needs no setup -- would be
 * false if reading a balance required an API key first. The public endpoint is
 * enough for what this does: balances, one history lookup, a blockhash.
 *
 * Where it is NOT enough is submitting transactions under load, which is why
 * `rpcSource()` exists: a caller can say which one it got, and an operator who
 * sees failures knows whether to configure a provider before investigating
 * anything else.
 */
export function connection() {
  return new Connection(process.env.OPINDEX_RPC_URL ?? process.env.TOKEN_RPC_URL ?? PUBLIC_RPC, 'confirmed');
}

/** Which endpoint `connection()` will use, named without revealing a keyed URL. */
export function rpcSource() {
  return process.env.OPINDEX_RPC_URL || process.env.TOKEN_RPC_URL
    ? 'a configured provider'
    : `the public endpoint (${PUBLIC_RPC}) — fine for reads, weak for submitting under load`;
}

if (import.meta.filename === process.argv[1]) {
  const { identity } = await import('./agent.mjs');
  const me = identity();
  const result = await returnAddress(connection(), me.address);
  console.log(`agent  ${me.address}`);
  console.log(
    result.address
      ? `return ${result.address}\n       funded ${result.fundedAt} by ${result.signature}`
      : `return UNAVAILABLE — ${result.why}`,
  );
}
