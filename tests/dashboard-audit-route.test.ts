import assert from 'assert';
import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'server.ts'), 'utf-8');
const routeStart = source.indexOf("if (method === 'POST' && pathname === '/api/actions/audit-byreal-nfts')");
const nextRouteStart = source.indexOf("if (method === 'PATCH' && pathname === '/api/config')", routeStart);
assert.ok(routeStart >= 0 && nextRouteStart > routeStart, 'audit-byreal-nfts route should be found');

const routeBody = source.slice(routeStart, nextRouteStart);

assert.ok(
  routeBody.includes('ctx.executor.auditByrealNftsOnChainAndQueueClose(ctx.opQueue)'),
  'audit route should call auditByrealNftsOnChainAndQueueClose(ctx.opQueue)',
);
assert.ok(
  !routeBody.includes('ctx.executor.auditByrealNftsOnChain()'),
  'audit route should not call legacy non-closing auditByrealNftsOnChain()',
);
