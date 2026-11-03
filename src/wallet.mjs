// What the agent holds, and whether it can pay at all.
//
// Facts rather than a verdict on sufficiency: whether a balance is "enough"
// depends on what the agent intends to do, which this module does not know.
//
// SOL is not needed to pay the service — its facilitator is the fee payer on an
// x402 settlement — but it IS needed for transactions the agent signs itself.
//
// The fact that matters most is that the USDC account EXISTS, separately from
// having a balance in it. The payment scheme only ever emits
// `transfer_checked`, which cannot create an account, so this is the
// precondition that fails silently: an agent sent only SOL holds money it
// cannot spend, with nothing in any error message pointing at the missing
// account. A USDC transfer creates the account on its way in, which is why the
// funding order matters.

import { PublicKey } from '@solana/web3.js';
import {
  getAccount,
  getAssociatedTokenAddress,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
} from '@solana/spl-token';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { identity, keyPath } from './agent.mjs';
import { connection } from './returns.mjs';

export { connection };

/** Mainnet USDC, six decimals — the asset every quote on this service names. */
export const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

/** Where payments land. Taken from the 402's `payTo`, repeated here only to check it exists. */
const PAY_TO = new PublicKey('8F7ZYVoPEmJrcJ5zVECRkKv8Yz4MeeLrtPzmGxNLx55X');

/** Base units to a human string, without ever passing through a float. */
export function units(amount, decimals) {
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const frac = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** The balance of an associated token account, or null when it does not exist. */
async function tokenBalance(conn, owner, mint) {
  const ata = await getAssociatedTokenAddress(mint, owner);
  try {
    const account = await getAccount(conn, ata, 'confirmed');
    return { ata: ata.toBase58(), exists: true, amount: account.amount };
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError) {
      return { ata: ata.toBase58(), exists: false, amount: 0n };
    }
    throw err;
  }
}

/**
 * The agent's holdings, read from the chain.
 *
 * `canPay` is the one judgement made here, and it is a narrow one: the USDC
 * account exists and holds something. It says nothing about whether the amount
 * suits the trade in mind.
 */
export async function wallet() {
  const conn = connection();
  const owner = new PublicKey(identity().address);

  const [lamports, agentUsdc, payToUsdc] = await Promise.all([
    conn.getBalance(owner, 'confirmed'),
    tokenBalance(conn, owner, USDC),
    tokenBalance(conn, PAY_TO, USDC),
  ]);

  return {
    address: owner.toBase58(),
    lamports: BigInt(lamports),
    sol: units(BigInt(lamports), 9),
    usdcBase: agentUsdc.amount,
    usdc: units(agentUsdc.amount, 6),
    usdcAccount: agentUsdc.ata,
    usdcAccountExists: agentUsdc.exists,
    canPay: agentUsdc.exists && agentUsdc.amount > 0n,
    // The service's own account. If this is missing a payment cannot settle,
    // and that failure would be the service's, not the agent's.
    recipientAccountExists: payToUsdc.exists,
  };
}

/**
 * Every token account the agent owns other than its USDC one, both token
 * programs, read from the chain.
 *
 * This is what a position IS. A swap quote's `out_amount` is an estimate: on
 * 2026-11-03 a quote said 7871923 and the wallet received 7870941. An agent
 * that sells the quoted amount sells more than it holds, and the sale fails at
 * the moment its stop was hit. Empty accounts are listed too, because each one
 * holds rent that `close_empty_token_accounts` can return.
 */
export async function holdings(conn = connection()) {
  const owner = new PublicKey(identity().address);
  const usdcAta = (await getAssociatedTokenAddress(USDC, owner)).toBase58();
  const pages = await Promise.all(
    [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) =>
      conn.getParsedTokenAccountsByOwner(owner, { programId }, 'confirmed'),
    ),
  );
  return pages
    .flatMap((page) => page.value)
    .filter(({ pubkey }) => pubkey.toBase58() !== usdcAta)
    .map(({ pubkey, account }) => {
      const info = account.data.parsed.info;
      return {
        mint: info.mint,
        account: pubkey.toBase58(),
        program: account.owner.toBase58(),
        balance_base_units: info.tokenAmount.amount,
        balance: info.tokenAmount.uiAmountString,
        decimals: info.tokenAmount.decimals,
        empty: info.tokenAmount.amount === '0',
        rent_lamports: account.lamports,
      };
    });
}

/**
 * What one confirmed transaction actually moved in and out of `owner`'s
 * wallet: lamports (fee included) and every token it holds an account for.
 * Pure: `tx` is a `getParsedTransaction` result.
 */
export function ownerBalanceChanges(tx, owner) {
  const keys = tx.transaction.message.accountKeys.map((k) => (k.pubkey ?? k).toString());
  const i = keys.indexOf(owner);
  const byMint = (list) =>
    new Map((list ?? []).filter((b) => b.owner === owner).map((b) => [b.mint, b.uiTokenAmount]));
  const pre = byMint(tx.meta.preTokenBalances);
  const post = byMint(tx.meta.postTokenBalances);
  const tokens = [...new Set([...pre.keys(), ...post.keys()])]
    .map((m) => {
      const before = BigInt(pre.get(m)?.amount ?? '0');
      const after = BigInt(post.get(m)?.amount ?? '0');
      return {
        mint: m,
        change_base_units: (after - before).toString(),
        balance_base_units: after.toString(),
        decimals: (post.get(m) ?? pre.get(m)).decimals,
      };
    })
    .filter((t) => t.change_base_units !== '0');
  return {
    sol_lamports: i < 0 ? '0' : String(tx.meta.postBalances[i] - tx.meta.preBalances[i]),
    fee_lamports: i === 0 ? String(tx.meta.fee) : '0',
    tokens,
  };
}

/**
 * Whether `a` looks like `b` without being it: the same first three and last
 * three characters, which is all most people compare. Address poisoning sends
 * dust from such an address right after a wallet is funded, so that a person
 * copying "their" address out of the history copies the attacker's. Seen on
 * this agent on 2026-11-03: `8F7ZYVoP…Lx55X` funded it, and 34 seconds later
 * `8F7Zg8WA…sMj55X` sent 1000 lamports and 0.0001 USDC. By chance two
 * addresses share six fixed characters about once in 38 billion.
 */
export const lookalike = (a, b) => a !== b && a.slice(0, 3) === b.slice(0, 3) && a.slice(-3) === b.slice(-3);

/**
 * Senders of recent transactions into this wallet that imitate `returnAddress`.
 *
 * Read from the newest signatures of the agent's address and of its USDC
 * account (a token transfer into an existing account does not name the owner),
 * counting as a sender every signer of a transaction the agent did not sign.
 * It cannot change where `return_funds` pays — that is the FIRST USDC transfer
 * in, and dust arrives later — so this protects the person, not the agent.
 *
 * Why it reads the whole history, a little at a time: the dust lands right
 * after a funding, and the agent's own payments and swaps bury it within the
 * hour — on 2026-11-03 it was already past the newest ten signatures. So the
 * scan keeps its place in a file beside the key, reads oldest-first from
 * there, at most `perCall` transactions a call, and remembers what it found.
 * One transaction at a time: the public endpoint refuses a batch outright (429
 * "Too many requests for a specific RPC call"). A failed read ends this call's
 * scan where it stood, and `unread` says how much is left, so a partial scan
 * cannot read as a clean one. The file holds no secret: losing it only means
 * reading the history again.
 */
const scanPath = () => join(dirname(keyPath()), 'lookalike-scan.json');

/** What earlier scans found, without reading the chain: instant, possibly behind. */
export function lookalikesSoFar(statePath = scanPath()) {
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    return { senders: state.senders ?? [], read: 0, unread: null, truncated: Boolean(state.truncated) };
  } catch {
    return { senders: [], read: 0, unread: null, truncated: false };
  }
}

export async function lookalikeSenders(
  conn,
  returnAddress,
  { perCall = 20, firstScan = 200, statePath = scanPath() } = {},
) {
  const owner = new PublicKey(identity().address);
  const usdcAta = await getAssociatedTokenAddress(USDC, owner);
  let state = { until: {}, senders: [] };
  try {
    state = { ...state, ...JSON.parse(readFileSync(statePath, 'utf8')) };
  } catch {
    // No scan yet, or an unreadable one: start over.
  }
  const save = () => writeFileSync(statePath, JSON.stringify(state, null, 1), { mode: 0o600 });

  let read = 0;
  let unread = 0;
  for (const address of [owner, usdcAta].map((a) => a.toBase58())) {
    // Newest first from the chain, back to where the last scan stopped.
    const pending = [];
    let before;
    while (pending.length < firstScan) {
      const page = await conn.getSignaturesForAddress(
        new PublicKey(address),
        { until: state.until[address], before, limit: 100 },
        'confirmed',
      );
      pending.push(...page);
      if (page.length < 100) break;
      before = page.at(-1).signature;
    }
    // A first scan of a long history reaches back `firstScan` signatures and
    // no further; say so rather than call it whole.
    if (!state.until[address] && pending.length >= firstScan) state.truncated = true;
    pending.reverse();
    for (const { signature, err } of pending) {
      if (read >= perCall) {
        unread += 1;
        continue;
      }
      let tx = null;
      if (!err) {
        try {
          tx = await conn.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        } catch {
          read = perCall;
          unread += 1;
          continue;
        }
      }
      read += 1;
      const signers = (tx?.transaction.message.accountKeys ?? []).filter((k) => k.signer).map((k) => k.pubkey.toBase58());
      if (!signers.includes(owner.toBase58())) {
        for (const s of signers) {
          if (lookalike(s, returnAddress) && !state.senders.some((x) => x.address === s)) {
            state.senders.push({ address: s, signature });
          }
        }
      }
      state.until[address] = signature;
      save();
    }
  }
  save();
  return { senders: state.senders, read, unread, truncated: Boolean(state.truncated) };
}
