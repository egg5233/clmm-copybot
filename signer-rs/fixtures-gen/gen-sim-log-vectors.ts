/**
 * Generates `sim_log_vectors.json` — golden vectors for the Rust port of
 * `extractInvokedPrograms` in `signer/policy.ts`.
 *
 * The log arrays are hand-written in the shape `simulateTransaction` returns, so the
 * generator needs neither RPC nor a real transaction. The `expected_invoked_program_ids`
 * are produced by running the ACTUAL regex from the TypeScript implementation over those
 * logs, so the fixture cannot drift from the behaviour it documents.
 *
 * The regex literal below is copied verbatim from signer/policy.ts:321 (inside
 * `extractInvokedPrograms`). Nothing is imported from policy.ts: that module pulls in
 * signer/config.ts, which reads the signer .env at import time.
 *
 * Deterministic: same bytes on every run.
 *
 * Run: npm run generate:sim
 */
import fs from 'fs';
import path from 'path';

const OUT_PATH = path.resolve(
  __dirname,
  '../crates/signer-core/tests/fixtures/sim_log_vectors.json',
);

/** Verbatim from signer/policy.ts:321 — `const invokeRegex = /Program (\w{32,44}) invoke/;` */
const INVOKE_REGEX = /Program (\w{32,44}) invoke/;
const INVOKE_REGEX_SOURCE = 'signer/policy.ts:321 (extractInvokedPrograms)';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const RAYDIUM_CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const BYREAL_PROGRAM = 'REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2';
/** Magic Eden v2 — a real, valid program id that is deliberately NOT on the signer allowlist. */
const OFF_ALLOWLIST_PROGRAM = 'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K';

/** Exactly the body of `extractInvokedPrograms` in signer/policy.ts. */
function extractInvokedPrograms(logs: string[]): string[] {
  const programs = new Set<string>();
  for (const line of logs) {
    const match = line.match(INVOKE_REGEX);
    if (match) {
      programs.add(match[1]);
    }
  }
  return Array.from(programs);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`fixture sanity check failed: ${message}`);
}

interface RawVector {
  name: string;
  description: string;
  logs: string[];
  /** Hand-declared cross-check: a typo in a log line would otherwise silently shrink the output. */
  must_extract: string[];
  extra: Record<string, unknown>;
}

const RAW_VECTORS: RawVector[] = [
  {
    name: 'simple_two_programs',
    description:
      'A plain SPL token move: System program then Token program, no CPI nesting. Both ids ' +
      'appear on the allowlist, so the policy check passes.',
    logs: [
      `Program ${SYSTEM_PROGRAM} invoke [1]`,
      `Program ${SYSTEM_PROGRAM} success`,
      `Program ${TOKEN_PROGRAM} invoke [1]`,
      'Program log: Instruction: Transfer',
      `Program ${TOKEN_PROGRAM} consumed 4645 of 200000 compute units`,
      `Program ${TOKEN_PROGRAM} success`,
    ],
    must_extract: [SYSTEM_PROGRAM, TOKEN_PROGRAM],
    extra: {
      contains_off_allowlist_program: false,
      jupiter_present: false,
    },
  },
  {
    name: 'jupiter_routed_swap',
    description:
      'A Jupiter v6 route that CPIs into two AMM programs. Note that policy.ts SKIPS the ' +
      'invoked-program check entirely when Jupiter is among the static program ids, because a ' +
      'route can touch dozens of AMMs. The Rust port must reproduce that skip, so this vector ' +
      'documents what the extractor WOULD return rather than a set that gets enforced.',
    logs: [
      `Program ${JUPITER_PROGRAM} invoke [1]`,
      'Program log: Instruction: Route',
      `Program ${WHIRLPOOL_PROGRAM} invoke [2]`,
      'Program log: Instruction: Swap',
      `Program ${TOKEN_PROGRAM} invoke [3]`,
      'Program log: Instruction: Transfer',
      `Program ${TOKEN_PROGRAM} success`,
      `Program ${WHIRLPOOL_PROGRAM} consumed 38291 of 986543 compute units`,
      `Program ${WHIRLPOOL_PROGRAM} success`,
      `Program ${RAYDIUM_CLMM_PROGRAM} invoke [2]`,
      'Program log: Instruction: SwapV2',
      `Program ${TOKEN_PROGRAM} invoke [3]`,
      'Program log: Instruction: TransferChecked',
      `Program ${TOKEN_PROGRAM} success`,
      `Program ${RAYDIUM_CLMM_PROGRAM} consumed 51204 of 941122 compute units`,
      `Program ${RAYDIUM_CLMM_PROGRAM} success`,
      'Program log: Route complete',
      `Program ${JUPITER_PROGRAM} consumed 142887 of 1000000 compute units`,
      `Program ${JUPITER_PROGRAM} success`,
    ],
    must_extract: [JUPITER_PROGRAM, WHIRLPOOL_PROGRAM, TOKEN_PROGRAM, RAYDIUM_CLMM_PROGRAM],
    extra: {
      contains_off_allowlist_program: false,
      jupiter_present: true,
      jupiter_program_id: JUPITER_PROGRAM,
      policy_note:
        'hasJupiter === true in signer/policy.ts, so extractInvokedPrograms is never called ' +
        'for this transaction and the CPI targets are not checked against the allowlist.',
    },
  },
  {
    name: 'off_allowlist_cpi',
    description:
      'An allowlisted DEX program (Byreal) that CPIs into a program which is NOT on the ' +
      'allowlist. Nothing in the static instruction list reveals it — only the simulation logs ' +
      'do. The policy engine must reject this transaction.',
    logs: [
      `Program ${BYREAL_PROGRAM} invoke [1]`,
      'Program log: Instruction: IncreaseLiquidityV2',
      `Program ${TOKEN_PROGRAM} invoke [2]`,
      'Program log: Instruction: TransferChecked',
      `Program ${TOKEN_PROGRAM} success`,
      `Program ${OFF_ALLOWLIST_PROGRAM} invoke [2]`,
      'Program log: Instruction: Deposit',
      `Program ${OFF_ALLOWLIST_PROGRAM} consumed 12043 of 780000 compute units`,
      `Program ${OFF_ALLOWLIST_PROGRAM} success`,
      `Program ${BYREAL_PROGRAM} consumed 96412 of 1000000 compute units`,
      `Program ${BYREAL_PROGRAM} success`,
    ],
    must_extract: [BYREAL_PROGRAM, TOKEN_PROGRAM, OFF_ALLOWLIST_PROGRAM],
    extra: {
      contains_off_allowlist_program: true,
      off_allowlist_program_id: OFF_ALLOWLIST_PROGRAM,
      jupiter_present: false,
      policy_note:
        'Expected policy result: rejected with "Simulation revealed unknown invoked program: ' +
        `${OFF_ALLOWLIST_PROGRAM}".`,
    },
  },
];

function main(): void {
  const vectors = RAW_VECTORS.map((raw) => {
    const extracted = extractInvokedPrograms(raw.logs);

    // Cross-check the regex output against the hand-declared list. A mistyped program id in a
    // log line would fail \w{32,44} and silently vanish from the fixture otherwise.
    assert(
      JSON.stringify(extracted) === JSON.stringify(raw.must_extract),
      `${raw.name}: regex extracted [${extracted.join(', ')}] but the vector declares ` +
        `[${raw.must_extract.join(', ')}] — check for a typo or a wrong-length program id`,
    );

    return {
      name: raw.name,
      description: raw.description,
      logs: raw.logs,
      expected_invoked_program_ids: extracted,
      ...raw.extra,
    };
  });

  const output = {
    _generator: 'signer-rs/fixtures-gen/gen-sim-log-vectors.ts',
    _source_of_truth: INVOKE_REGEX_SOURCE,
    _deterministic: true,
    _regex: INVOKE_REGEX.source,
    _regex_notes: [
      'Matched per line with String.match (no /g flag), so only the first program id on a line ' +
        'is captured; the capture group is added to a Set, so the result is unique and in ' +
        'first-seen order.',
      'Lines such as "Program log: …", "Program … success" and "Program … consumed …" do not ' +
        'contain " invoke" and never match.',
      '\\w{32,44} is greedy and also matches "_", which base58 never produces. A pubkey whose ' +
        'base58 form is shorter than 32 characters (leading zero bytes) would NOT be captured — ' +
        'the Rust port should reproduce this bound rather than fix it, or the two ' +
        'implementations will disagree on such a transaction.',
      'The invocation depth suffix ("[1]", "[2]", …) is not captured; nesting depth is ignored.',
    ],
    vectors,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(output, null, 2)}\n`);

  console.log(`wrote ${OUT_PATH}`);
  for (const v of vectors) {
    console.log(
      `  ${v.name.padEnd(22)} ${String(v.logs.length).padStart(2)} log lines → ` +
        `${v.expected_invoked_program_ids.length} program ids`,
    );
  }
}

main();
