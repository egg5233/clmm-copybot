/**
 * A JSON-RPC endpoint the e2e run can lie to.
 *
 * The policy engine's last pass asks the chain two questions — "who owns this
 * account" and "what does this transaction invoke" — and the interesting answers
 * are the ones a real endpoint cannot be made to give on demand: a transaction
 * that CPIs into a program nobody has heard of, an endpoint that returns 500.
 * This serves those answers over real HTTP, so what is under test is the whole
 * daemon including its RPC client, not a Rust mock standing in for one.
 *
 * Node's `http` and nothing else: adding a dependency to fake three methods
 * would be a strange trade for a file this size.
 *
 * The responses are shaped like a validator's, because `solana-client` parses
 * them: an account is `{ lamports, data: [base64, "base64"], owner, executable,
 * rentEpoch }` inside a `{ context, value }` envelope, and a mis-shaped reply
 * surfaces as a deserialization error rather than as the answer the test meant
 * to give.
 */
import http from 'http';
import { AddressInfo } from 'net';

/** An account as the policy engine reads it: the owner is the only field it uses. */
export interface MockAccount {
  owner: string;
  lamports?: number;
  /** Raw account data; base64-encoded on the way out. */
  data?: Buffer;
  executable?: boolean;
}

/** What `simulateTransaction` should report. */
export interface SimulateOutcome {
  /** A transaction error, or `null` for a simulation that succeeded. */
  err: unknown;
  /** Program logs, or `null` for the reply shape that carries none. */
  logs: string[] | null;
}

export interface MockRpcState {
  /** Address → account. A missing entry answers `null`, as a real node does. */
  accounts: Map<string, MockAccount>;
  simulate: SimulateOutcome;
  /**
   * HTTP status to answer `simulateTransaction` with instead of a JSON-RPC
   * reply. `null` serves [`MockRpcState.simulate`] normally.
   */
  simulateHttpStatus: number | null;
}

export interface MockRpc {
  /** What to pass as `SIGNER_RPC_URL`. */
  url: string;
  state: MockRpcState;
  /** JSON-RPC method names received, in order, since the last `reset`. */
  methods: () => string[];
  reset: () => void;
  close: () => Promise<void>;
}

/** Slot and version reported in every `{ context, value }` envelope. */
const CONTEXT = { slot: 1, apiVersion: '2.3.13' };

function encodeAccount(account: MockAccount | undefined): unknown {
  if (!account) return null;
  return {
    lamports: account.lamports ?? 1_000_000,
    data: [(account.data ?? Buffer.alloc(0)).toString('base64'), 'base64'],
    owner: account.owner,
    executable: account.executable ?? false,
    rentEpoch: 0,
    space: (account.data ?? Buffer.alloc(0)).length,
  };
}

/**
 * Starts the server on an ephemeral loopback port.
 *
 * Loopback only: this answers whatever it is asked without authentication, and
 * it exists for the length of one test run.
 */
export function startMockRpc(): Promise<MockRpc> {
  const state: MockRpcState = {
    accounts: new Map(),
    simulate: { err: null, logs: [] },
    simulateHttpStatus: null,
  };
  let methods: string[] = [];

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let parsed: { id?: unknown; method?: string; params?: unknown[] };
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        response.writeHead(400, { 'content-type': 'text/plain' });
        response.end('mock RPC: request body was not JSON');
        return;
      }

      const method = parsed.method ?? '';
      const params = parsed.params ?? [];
      methods.push(method);

      if (method === 'simulateTransaction' && state.simulateHttpStatus !== null) {
        response.writeHead(state.simulateHttpStatus, { 'content-type': 'text/plain' });
        response.end('mock RPC: simulation is unavailable');
        return;
      }

      const result = dispatch(state, method, params);
      const body =
        result === undefined
          ? {
              jsonrpc: '2.0',
              id: parsed.id ?? null,
              error: { code: -32601, message: `mock RPC: unhandled method ${method}` },
            }
          : { jsonrpc: '2.0', id: parsed.id ?? null, result };

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        methods: () => [...methods],
        reset: () => {
          methods = [];
        },
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

/** `undefined` for a method this mock does not implement. */
function dispatch(state: MockRpcState, method: string, params: unknown[]): unknown {
  switch (method) {
    case 'getAccountInfo':
      return { context: CONTEXT, value: encodeAccount(state.accounts.get(params[0] as string)) };

    case 'getMultipleAccounts':
      return {
        context: CONTEXT,
        value: (params[0] as string[]).map((key) => encodeAccount(state.accounts.get(key))),
      };

    case 'simulateTransaction':
      return {
        context: CONTEXT,
        value: {
          err: state.simulate.err,
          logs: state.simulate.logs,
          accounts: null,
          unitsConsumed: 0,
          returnData: null,
        },
      };

    // Not used by the signer, but a client that probes the node version should
    // get an answer rather than an error that looks like a test failure.
    case 'getVersion':
      return { 'solana-core': '2.3.13', 'feature-set': 0 };

    default:
      return undefined;
  }
}
