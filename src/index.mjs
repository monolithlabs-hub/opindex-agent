// The library: an agent's wallet, discovery, and a `fetch` that pays.
//
// Use this directly when your agent does not speak MCP. When it does, run
// `mcp/server.mjs` instead — it is this library behind seven tools.

export { identity, keyPath, loadOrCreateKey } from './agent.mjs';
export { baseUrl, listTools, mcp, resolvePointer } from './discover.mjs';
export { buyAssessment, payingFetch } from './pay.mjs';
export { PUBLIC_RPC, connection, returnAddress, rpcSource } from './returns.mjs';
export { USDC, units, wallet } from './wallet.mjs';
