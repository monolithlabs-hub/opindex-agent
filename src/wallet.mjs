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
import { getAccount, getAssociatedTokenAddress, TokenAccountNotFoundError } from '@solana/spl-token';
import { identity } from './agent.mjs';
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
