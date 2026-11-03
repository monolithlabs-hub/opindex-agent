# opindex-agent

An agent's own Solana wallet, token risk answers it pays for over x402, and
swaps it signs itself.

Two ways in. `src/` is a library for an agent that does not speak MCP; `mcp/`
is the same library behind eleven tools for a host that does.

## Install (as an MCP server)

No configuration is required. Add it to your agent host's MCP config:

```json
{
  "mcpServers": {
    "opindex": {
      "command": "npx",
      "args": ["-y", "opindex-agent"]
    }
  }
}
```

That is the whole installation — `npx` fetches the package on first run. To work
from a clone instead, point `command` at `node` and `args` at
`/absolute/path/to/opindex-agent/mcp/server.mjs`, and run `npm install` here first.

Then ask your agent to call `agent_wallet`. The key is created on first use, and
the answer carries the address to fund.

The skill in `skills/opindex-trading/SKILL.md` teaches an agent the order to
use the tools in. Load it the way your host loads skills; without it the tool
descriptions still say what each one does, but the acknowledgement contract and
the funding order are easier to get wrong.

### Optional: your own RPC

With no configuration the plugin reads the chain through
`https://api.mainnet-beta.solana.com`. That is enough for balances, the return
address lookup, and paying for answers. It is weak for **submitting**
transactions under load, which is what `submit_swap` does, so set
`OPINDEX_RPC_URL` to a provider of your own if trades start failing:

```json
"env": { "OPINDEX_RPC_URL": "https://your-provider/?api-key=..." }
```

`agent_wallet` reports which of the two it is using, without revealing a keyed
URL.

## The agent's key

Created on first use at `~/.opindex/agent/agent.json`, mode 600 in a 700
directory, **outside any repository**. Nothing imports a key: the agent makes
its own, which is the point — it is the agent's wallet, not yours lent to it.

`agent_wallet` prints the address. Fund it with **USDC first, then SOL**: a USDC
transfer creates the token account the payment scheme needs, and the scheme
cannot create it. Funding only SOL leaves an agent holding money it cannot
spend.

The agent needs **no SOL to pay for answers** — the service's facilitator is the
fee payer on an x402 settlement. SOL is only for the swaps the agent signs.

## What this key can and cannot sign

Two constraints, about the kind of action rather than its size. There is no
spending policy here on purpose: a default limit would be a guess about your
risk appetite, and you have already stated yours by choosing how much to fund
the wallet with.

One check is made on the bill, and it is not a limit on what the agent does:
each paid tool pays **at most the price it states**. A 402 asking more — a
mispriced route, or anything that is not our service — is refused before
anything is signed, and the agent is told why (`price_above_stated`). Without
it, the x402 library's own default would have paid up to $1 for a half-cent
answer.

1. **The agent can only swap.** There is no transfer tool.
2. **Funds return only to whoever funded the agent first**, read from chain
   history on every call.

Both reduce to one invariant, which `npm test` checks mechanically: **no tool
takes a destination address as a parameter.** An agent carrying an injected
"send it to this address" has nowhere to put the address.

What this does **not** prevent, stated plainly: an injected agent can still swap
into a worthless token. The risk gate stands against that, not these rules.

### If you funded from an exchange

`return_address` is then the exchange's hot wallet, and sending funds there can
lose them. We cannot tell an exchange address from a personal one, so
`agent_wallet` shows the derived address from the first call — check it before
the balance is worth worrying about.

### Never copy your address out of the agent's history

Within a minute of funding, someone may send the agent dust from an address
made to look like yours: the same first and last characters. It cannot change
where `return_funds` pays — that is the first funder, read from the chain — but
it is waiting for you to copy "your" address from the agent's transaction list.
`agent_wallet` names such senders under `lookalike_senders`.

## Tools

| | cost | |
|---|---|---|
| `agent_wallet` | free | address, balances, the tokens it holds, and the one return address |
| `token_identity` | free | the full answer, possibly a day stale |
| `assess_token` | $0.005 | within the service's TTL window |
| `assess_token_live` | $0.03 | read from the chain on this request |
| `build_swap` | $0.05 | a verdict and a transaction, or a refusal naming the risk — **a refusal is charged** |
| `submit_swap` | free | signs and sends a swap this server built, and reports what actually arrived; you pay the network fee |
| `return_funds` | free | USDC back to the funder; no destination parameter |
| `close_empty_token_accounts` | free | returns the rent of token accounts a sale left empty, to the agent itself; no parameters |

## Tests

`npm test` is free and offline: it talks to the server over stdio, reads the
tool list, and asserts the invariants — the destination rule, that
`acknowledge_risk` is a string and not a boolean, that the money-moving tools
are annotated, that the paid ones say so, and that the skill's prices still
match the tools'. Then it answers a few 402s itself, with a throwaway key and
no network, and reads back what the agent signed: exactly the quoted amount of
USDC to the payee, the facilitator as fee payer, one payment per request, and a
refusal for devnet, an unknown asset, more than the x402 library's default of
$1 a payment, or more than the tool's own stated price. Last, it reads balances
back out of transactions shaped like a real buy and sell, and checks that an
address imitating the funder's is caught. It costs nothing, which is the only
reason it gets run.

It ships with the package deliberately. This library holds a wallet, and the
useful form of that claim is not "trust us" but "run the check yourself":

```
npm test
```

## Using the library directly

```js
import { identity, wallet, payingFetch, resolvePointer } from 'opindex-agent';

const me = identity();                    // creates the key on first call
const held = await wallet();              // balances, and whether it can pay
const pointer = await resolvePointer('assess_token', { mint });
const pay = await payingFetch();
const answer = await (await pay(pointer.url)).json();
```
