// What the agent is told it holds, read back from transactions shaped like the
// ones it really signed.
//
// Free and offline, like the other two. Both functions here are pure, so the
// fixtures are enough: they carry the numbers of openclaw's first round trip on
// 2026-11-03, where a quote said 7871923 base units and the wallet received
// 7870941. A position recorded from the quote could not be sold.

import { lookalike, ownerBalanceChanges } from '../src/wallet.mjs';

const AGENT = 'A1tx32bQaYLtn6Sm9p5j7TYC1vdjBwJT6kuMnLfcVZtT';
const POOL = 'Bzc9NZfMqkXR6fz1DBph7BDf9BroyEf6pnzESP7v5iiw';
const FART = '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump';
const WSOL = 'So11111111111111111111111111111111111111112';
const FUNDER = '8F7ZYVoPEmJrcJ5zVECRkKv8Yz4MeeLrtPzmGxNLx55X';
const POISONER = '8F7Zg8WAHuthAPNhJ2s14CCMqfTn4DrRQTWxpsyMj55X';

const balance = (owner, mint, amount, decimals = 6) => ({
  owner,
  mint,
  accountIndex: 0,
  uiTokenAmount: { amount, decimals, uiAmountString: String(Number(amount) / 10 ** decimals) },
});

/** A parsed transaction with only the fields the reader looks at. */
const parsed = ({ keys, fee, pre, post, preTokens, postTokens }) => ({
  transaction: { message: { accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0 })) } },
  meta: { fee, preBalances: pre, postBalances: post, preTokenBalances: preTokens, postTokenBalances: postTokens },
});

const checks = [];
const check = (name, ok, saw) => checks.push({ name, ok, saw });

// --- the buy: SOL in, a token account created, the token out of the pool -------

{
  const buy = parsed({
    keys: [AGENT, POOL],
    fee: 7581,
    pre: [120001000, 5_000_000_000],
    post: [108505000, 5_010_000_000],
    preTokens: [balance(POOL, FART, '27101956082153')],
    postTokens: [balance(POOL, FART, '27101948211212'), balance(AGENT, FART, '7870941')],
  });
  const c = ownerBalanceChanges(buy, AGENT);
  const fart = c.tokens.find((t) => t.mint === FART);
  check('the buy reports what arrived, not what was quoted', fart?.change_base_units === '7870941', JSON.stringify(fart));
  check('and the balance to sell later', fart?.balance_base_units === '7870941', fart?.balance_base_units);
  check('a token account that did not exist before counts from zero', fart?.decimals === 6, JSON.stringify(fart));
  check('the pool\'s own balances are not the agent\'s', c.tokens.length === 1, JSON.stringify(c.tokens));
  check('lamports out include the fee and the new account\'s rent', c.sol_lamports === '-11496000', c.sol_lamports);
  check('the fee is named when the agent paid it', c.fee_lamports === '7581', c.fee_lamports);
}

// --- the sell: all of it, the account left empty -------------------------------

{
  const sell = parsed({
    keys: [AGENT, POOL],
    fee: 6644,
    pre: [108505000, 5_010_000_000],
    post: [118505719, 5_000_000_000],
    preTokens: [balance(AGENT, FART, '7870941'), balance(POOL, WSOL, '34573260522939', 9)],
    postTokens: [balance(AGENT, FART, '0'), balance(POOL, WSOL, '34573250522220', 9)],
  });
  const c = ownerBalanceChanges(sell, AGENT);
  const fart = c.tokens.find((t) => t.mint === FART);
  check('the sell reports the whole position leaving', fart?.change_base_units === '-7870941', JSON.stringify(fart));
  check('and nothing left to sell', fart?.balance_base_units === '0', fart?.balance_base_units);
  check('SOL in is net of the fee', c.sol_lamports === '10000719', c.sol_lamports);
}

// --- a transaction the agent did not pay for -----------------------------------

{
  const dust = parsed({
    keys: [POISONER, AGENT],
    fee: 5000,
    pre: [1_000_000, 108505000],
    post: [994_000, 108506000],
    preTokens: [],
    postTokens: [],
  });
  const c = ownerBalanceChanges(dust, AGENT);
  check('a fee someone else paid is not the agent\'s', c.fee_lamports === '0', c.fee_lamports);
  check('the dust is still counted in', c.sol_lamports === '1000', c.sol_lamports);
}

// --- lookalikes ----------------------------------------------------------------

check('the address that poisoned this agent is caught', lookalike(POISONER, FUNDER), `${POISONER} vs ${FUNDER}`);
check('the real funder is not its own lookalike', !lookalike(FUNDER, FUNDER), FUNDER);
check('an unrelated address is not a lookalike', !lookalike(AGENT, FUNDER), AGENT);
check(
  'a shared beginning alone is not enough',
  !lookalike('8F7Z' + AGENT.slice(4), FUNDER),
  '8F7Z…',
);

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : ` — saw ${c.saw}`}`);
}
console.log(failed === 0 ? `\n${checks.length} wallet checks hold.` : `\n${failed} of ${checks.length} FAILED.`);
process.exit(failed === 0 ? 0 : 1);
