// A `fetch` that pays.
//
// Wraps the x402 client with the agent's own key, so a request that comes back
// `402 Payment Required` is answered with a signed payment and retried once.
//
// No RPC is configured here on purpose. `ExactSvmScheme` takes an optional
// `rpcUrl` and falls back to the public Solana endpoint, which is enough for
// what paying needs: one recent blockhash. An agent that wants its own provider
// sets `OPINDEX_RPC_URL`, and nothing here requires it.
//
// The agent needs an RPC at all because it must sign a `transfer_checked`
// against a recent blockhash. It needs no SOL: the service's facilitator is the
// fee payer on an x402 settlement, so the agent's lamport balance is untouched
// by paying. SOL is only for transactions the agent signs itself.
//
// # What a payment may cost
//
// Not a spending limit — those belong to whoever funds the agent — but a check
// that the bill is the one we published. Given `maxAmountPerPayment`, a 402
// asking more than that is refused before anything is signed. The MCP server
// passes each tool's own stated price, so a 402 asking $0.90 for a $0.005
// answer, from a mispriced route or from anything that is not our service, is
// not paid. It uses the x402 library's own spend control, so the refusal names
// `maxAmountPerPayment` in its message. Without the option the library's
// default applies: $1 a payment, in assets it knows.

import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from '@x402/fetch';
import { ExactSvmScheme, SOLANA_MAINNET_CAIP2 } from '@x402/svm';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { loadOrCreateKey } from './agent.mjs';
import { resolvePointer } from './discover.mjs';

/**
 * A paying fetch, built from the agent's own key.
 *
 * `maxAmountPerPayment` is a dollar string such as `"$0.005"`: the most one
 * payment through this fetch may ask. Omitted, the library's default stands.
 */
export async function payingFetch({ maxAmountPerPayment } = {}) {
  const { keypair } = loadOrCreateKey();
  const signer = await createKeyPairSignerFromBytes(keypair.secretKey);
  return wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [
      {
        network: SOLANA_MAINNET_CAIP2,
        // No `rpcUrl`: the library's public default, deliberately.
        client: new ExactSvmScheme(signer),
        x402Version: 2,
      },
    ],
    ...(maxAmountPerPayment ? { spendControls: { maxAmountPerPayment } } : {}),
  });
}

/** Whether `error` is the x402 library refusing a 402 over its spend cap. */
export const isOverPrice = (error) => /spendControls\.maxAmountPerPayment/.test(String(error?.message ?? error));

/**
 * Buy one assessment, through the pointer discovery gave us.
 *
 * Returns the answer and the receipt separately, because "we were charged" and
 * "we got an assessment" are different facts and a caller should not be able to
 * infer one from the other.
 */
export async function buyAssessment(mint) {
  const pointer = await resolvePointer('assess_token', { mint });
  if (!pointer.paymentRequired) {
    throw new Error('assess_token says payment is not required; this phase has nothing to measure');
  }

  const payingGet = await payingFetch();
  const started = Date.now();
  const response = await payingGet(pointer.url, { method: pointer.method });
  const elapsedMs = Date.now() - started;
  const body = await response.json();

  // The receipt the facilitator settled, if the server sent one back.
  let receipt = null;
  const header = response.headers.get('payment-response');
  if (header) {
    try {
      receipt = decodePaymentResponseHeader(header);
    } catch (err) {
      receipt = { undecodable: String(err) };
    }
  }

  return { pointer, status: response.status, elapsedMs, body, receipt };
}
