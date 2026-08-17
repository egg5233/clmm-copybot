import assert from 'assert';

process.env.RPC_URL ||= 'http://127.0.0.1:8899';
process.env.WS_URL ||= 'ws://127.0.0.1:8900';
process.env.BOT2_WALLET ||= '11111111111111111111111111111111';

const { applyByrealMaxOpenPositionsConfig } = require('../src/dashboard/server') as typeof import('../src/dashboard/server');

const invalidConfig = { byrealMaxOpenPositions: 415 };
const invalidEnvUpdates: Record<string, string> = {};
applyByrealMaxOpenPositionsConfig({ byrealMaxOpenPositions: 'bad' }, invalidConfig, invalidEnvUpdates);
assert.strictEqual(invalidConfig.byrealMaxOpenPositions, 0);
assert.deepStrictEqual(invalidEnvUpdates, { BYREAL_MAX_OPEN_POSITIONS: '0' });

const validConfig = { byrealMaxOpenPositions: 0 };
const validEnvUpdates: Record<string, string> = {};
applyByrealMaxOpenPositionsConfig({ byrealMaxOpenPositions: '415' }, validConfig, validEnvUpdates);
assert.strictEqual(validConfig.byrealMaxOpenPositions, 415);
assert.deepStrictEqual(validEnvUpdates, { BYREAL_MAX_OPEN_POSITIONS: '415' });

const absentConfig = { byrealMaxOpenPositions: 123 };
const absentEnvUpdates: Record<string, string> = {};
applyByrealMaxOpenPositionsConfig({}, absentConfig, absentEnvUpdates);
assert.strictEqual(absentConfig.byrealMaxOpenPositions, 123);
assert.deepStrictEqual(absentEnvUpdates, {});
