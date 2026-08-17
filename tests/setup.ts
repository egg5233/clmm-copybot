// Runs before every test file. src/config.ts validates required env vars at
// import time, so stubs must be in place before any test imports src modules.
process.env.RPC_URL ||= 'http://127.0.0.1:8899';
process.env.WS_URL ||= 'ws://127.0.0.1:8900';
process.env.BOT2_WALLET ||= '11111111111111111111111111111111';
