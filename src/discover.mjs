// How an agent finds out what the service sells.
//
// Discovery is two steps, and the catalogue is the less useful one.
// `tools/list` names the tools and marks the paid ones, but carries no URL: the
// endpoint, the method and the payment protocol arrive only from `tools/call`,
// which answers with a pointer rather than the service. That is deliberate on
// the server's side — paying for an MCP tool call is not part of the MCP
// specification, so instead of pretending to charge over MCP it names the HTTP
// route where the paywall actually is.
//
// So an agent that reads only the catalogue learns that `assess_token` exists
// and nothing about how to buy it. This module does both steps.

const DEFAULT_BASE_URL = 'https://agents.opindex.io';

export function baseUrl() {
  return (process.env.OPINDEX_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/**
 * The tools whose pointer this module resolves, with arguments good enough to
 * get one.
 *
 * Arguments are needed because a pointer is route-specific: `assess_token`
 * answers with a URL containing the mint, so asking without one is a `400`
 * rather than a generic pointer. The mint here is USDC -- used only to make
 * the question well-formed, never assessed as part of discovery.
 */
const PROBES = [
  { name: 'assess_token', arguments: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } },
  { name: 'assess_token_live', arguments: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } },
  { name: 'build_swap', arguments: {} },
];

let nextId = 1;

/** One JSON-RPC call against the MCP endpoint. */
export async function mcp(method, params) {
  const url = `${baseUrl()}/agent/v1/mcp`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  if (!response.ok) {
    throw new Error(`MCP ${method} -> HTTP ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  if (body.error) {
    throw new Error(`MCP ${method} -> JSON-RPC error ${JSON.stringify(body.error)}`);
  }
  return body.result;
}

/** What the service says it can do. */
export async function listTools() {
  const { tools } = await mcp('tools/list', {});
  return tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    // The paid tools say so in the first words of their description, which is
    // the only place the catalogue carries it -- there is no `paid: true`
    // field to read.
    paid: tool.description.startsWith('PAID'),
    readOnly: tool.annotations?.readOnlyHint === true,
  }));
}

/**
 * The pointer a paid tool answers with: where to go and how to pay.
 *
 * Throws on `isError`, because a pointer that did not arrive is not a pointer
 * the agent can fall back from -- it means the route is unknown to us and
 * anything built on a guess would be a guess with money attached.
 */
export async function resolvePointer(name, args) {
  const result = await mcp('tools/call', { name, arguments: args });
  const text = result.content?.[0]?.text;
  if (!text) {
    throw new Error(`${name}: the tool answered with no text content`);
  }
  const pointer = JSON.parse(text);
  if (result.isError) {
    throw new Error(`${name}: ${pointer.error ?? text}`);
  }
  return {
    tool: name,
    result: pointer.result,
    url: pointer.http_endpoint?.url,
    method: pointer.http_endpoint?.method,
    paymentRequired: pointer.payment?.required === true,
    protocol: pointer.payment?.protocol,
    paymentMode: pointer.meta?.payment_mode,
  };
}

/** The catalogue and every paid route's pointer, in one object. */
export async function discover() {
  const tools = await listTools();
  const pointers = [];
  for (const probe of PROBES) {
    pointers.push(await resolvePointer(probe.name, probe.arguments));
  }
  return { base: baseUrl(), tools, pointers };
}

if (import.meta.filename === process.argv[1]) {
  const { base, tools, pointers } = await discover();
  console.log(`The agent asked ${base} what it sells.\n`);

  console.log('Catalogue:');
  for (const t of tools) {
    console.log(`  ${t.paid ? 'PAID' : 'free'}  ${t.name.padEnd(18)} ${t.title}`);
  }

  console.log('\nWhere the paid ones actually live:');
  for (const p of pointers) {
    console.log(`  ${p.tool}`);
    console.log(`    ${p.method} ${p.url}`);
    console.log(`    payment: ${p.paymentRequired ? 'required' : 'NOT required'} — ${p.protocol}`);
    console.log(`    network: ${p.paymentMode}`);
  }

  // The one thing worth asserting out loud: a paid tool that forgot to say so
  // would read as free, and an agent would call it expecting no cost.
  const quiet = pointers.filter((p) => !p.paymentRequired);
  console.log(
    quiet.length === 0
      ? '\nEvery paid pointer declares its payment. Nothing claims to be free that is not.'
      : `\nWARNING: ${quiet.map((p) => p.tool).join(', ')} returned a pointer that does not declare payment.`,
  );
}
