import net from 'net';
import http from 'http';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { Connection, Keypair, VersionedTransaction, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { signerConfig, setPrivateKey } from './config';
import { decryptKey } from './crypto';
import { checkPolicy } from './policy';

// ── Logger ──────────────────────────────────────────────────────────────────
const log = {
  info: (...args: any[]) => console.log(`[${new Date().toISOString()}] [Signer:INFO]`, ...args),
  warn: (...args: any[]) => console.warn(`[${new Date().toISOString()}] [Signer:WARN]`, ...args),
  error: (...args: any[]) => console.error(`[${new Date().toISOString()}] [Signer:ERROR]`, ...args),
};

const KEYFILE = path.resolve(__dirname, 'keyfile.enc.json');

// ── Unlock via stdin ────────────────────────────────────────────────────────
function askPasswordStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write('Enter password to unlock signer: ');
  }
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  return new Promise((resolve) => {
    rl.once('line', (line) => {
      rl.close();
      resolve(line.trim());
    });
  });
}

// ── Unlock via browser ──────────────────────────────────────────────────────
const UNLOCK_HTML = `<!DOCTYPE html>
<html lang="zh-TW"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Byreal Signer — Unlock</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,system-ui,sans-serif;background:#0f172a;color:#e2e8f0;
    display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#1e293b;border-radius:12px;padding:2.5rem;width:100%;max-width:380px;
    box-shadow:0 4px 24px rgba(0,0,0,.4)}
  h1{font-size:1.25rem;margin-bottom:.5rem;color:#f8fafc}
  .sub{font-size:.85rem;color:#94a3b8;margin-bottom:1.5rem}
  label{font-size:.85rem;color:#94a3b8;display:block;margin-bottom:.4rem}
  input[type=password]{width:100%;padding:.7rem .9rem;border:1px solid #334155;border-radius:8px;
    background:#0f172a;color:#f8fafc;font-size:1rem;outline:none;margin-bottom:1rem}
  input[type=password]:focus{border-color:#3b82f6}
  button{width:100%;padding:.7rem;border:none;border-radius:8px;background:#3b82f6;color:#fff;
    font-size:1rem;font-weight:600;cursor:pointer}
  button:hover{background:#2563eb}
  button:disabled{background:#475569;cursor:wait}
  .msg{margin-top:1rem;padding:.7rem;border-radius:8px;font-size:.85rem;text-align:center}
  .err{background:#7f1d1d;color:#fca5a5}
  .ok{background:#14532d;color:#86efac}
  .lock{font-size:2rem;margin-bottom:.5rem}
</style></head><body>
<div class="card">
  <div class="lock">&#128274;</div>
  <h1>Byreal Signer</h1>
  <div class="sub">輸入密碼以解鎖簽名服務</div>
  <form id="f">
    <label for="pw">密碼</label>
    <input type="password" id="pw" autofocus placeholder="Enter password">
    <button type="submit" id="btn">解鎖 Unlock</button>
  </form>
  <div id="msg"></div>
</div>
<script>
const f=document.getElementById('f'),pw=document.getElementById('pw'),
  btn=document.getElementById('btn'),msg=document.getElementById('msg');
f.onsubmit=async e=>{
  e.preventDefault();btn.disabled=true;btn.textContent='解鎖中...';msg.innerHTML='';
  try{
    const r=await fetch('/unlock',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:pw.value})});
    const d=await r.json();
    if(d.ok){
      msg.innerHTML='<div class="msg ok">&#9989; 已解鎖 — 簽名服務已啟動</div>';
      btn.textContent='已解鎖';
    }else{
      msg.innerHTML='<div class="msg err">&#10060; '+d.error+'</div>';
      btn.disabled=false;btn.textContent='解鎖 Unlock';pw.value='';pw.focus();
    }
  }catch(err){
    msg.innerHTML='<div class="msg err">&#10060; '+err.message+'</div>';
    btn.disabled=false;btn.textContent='解鎖 Unlock';
  }
};
</script></body></html>`;

function askPasswordWeb(encrypted: any): Promise<string> {
  const port = signerConfig.unlockPort;
  const ip = '127.0.0.1'; // localhost only — accessed via dashboard proxy

  return new Promise((resolve) => {
    const httpServer = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/unlock')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(UNLOCK_HTML);
        return;
      }

      if (req.method === 'POST' && req.url === '/unlock') {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const { password } = JSON.parse(body);
            if (!password) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: '請輸入密碼' }));
              return;
            }

            // Try decrypt
            try {
              const key = decryptKey(encrypted, password);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));

              // Shutdown unlock server, resolve with password
              log.info('Unlocked via browser');
              httpServer.close();
              resolve(key);
            } catch {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: '密碼錯誤 Wrong password' }));
            }
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Invalid request' }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    httpServer.listen(port, ip, () => {
      log.info(`Unlock page: http://${ip}:${port}`);
      log.info('Waiting for password...');
    });
  });
}

// ── Init ────────────────────────────────────────────────────────────────────
async function init() {
  if (!fs.existsSync(KEYFILE)) {
    log.error(`Encrypted keyfile not found: ${KEYFILE}`);
    log.error('Run: bash update-wallet.sh');
    process.exit(1);
  }

  const encrypted = JSON.parse(fs.readFileSync(KEYFILE, 'utf-8'));
  let privateKey: string;

  const hasWebUnlock = signerConfig.unlockPort > 0;
  const hasTTY = process.stdin.isTTY;

  if (hasWebUnlock && !hasTTY) {
    // Systemd / background mode — web unlock only (no stdin)
    log.info('Unlock mode: browser only (no TTY)');
    privateKey = await askPasswordWeb(encrypted);
  } else if (hasWebUnlock && hasTTY) {
    // Terminal with web unlock — race both
    log.info('Unlock mode: browser + stdin');
    privateKey = await Promise.race([
      askPasswordWeb(encrypted),
      (async () => {
        const pw = await askPasswordStdin();
        try {
          return decryptKey(encrypted, pw);
        } catch {
          log.error('Wrong password (stdin).');
          return new Promise<string>(() => {});
        }
      })(),
    ]);
  } else {
    // Stdin only (no web unlock)
    const password = await askPasswordStdin();
    try {
      privateKey = decryptKey(encrypted, password);
    } catch {
      log.error('Wrong password.');
      process.exit(1);
    }
  }

  setPrivateKey(privateKey);
  const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
  log.info(`Wallet: ${keypair.publicKey.toBase58()}`);

  startServer(keypair);
}

// ── Server startup (called after password decryption) ───────────────────────
function startServer(keypair: Keypair) {
  const connection = new Connection(signerConfig.rpcUrl, { commitment: 'confirmed' });

  function signTransaction(txBytes: Uint8Array, type: 'versioned' | 'legacy'): Uint8Array {
    if (type === 'versioned') {
      const tx = VersionedTransaction.deserialize(txBytes);
      tx.sign([keypair]);
      return tx.serialize();
    } else {
      const tx = Transaction.from(txBytes);
      tx.partialSign(keypair);
      return tx.serialize();
    }
  }

  let requestCount = 0;

  async function handleRequest(data: Buffer): Promise<Buffer> {
    const reqId = ++requestCount;
    const startTime = Date.now();

    try {
      const request = JSON.parse(data.toString('utf-8'));

      if (!request.type || !request.tx) {
        return toResponse({ ok: false, error: 'Invalid request: missing type or tx' });
      }
      if (request.type !== 'versioned' && request.type !== 'legacy') {
        return toResponse({ ok: false, error: `Invalid type: ${request.type}` });
      }

      const txBytes = Buffer.from(request.tx, 'base64');
      log.info(`[#${reqId}] ${request.type} TX (${txBytes.length} bytes)`);

      const policyResult = await checkPolicy(connection, txBytes, request.type);
      if (!policyResult.allowed) {
        log.warn(`[#${reqId}] REJECTED: ${policyResult.reason}`);
        return toResponse({ ok: false, error: policyResult.reason });
      }

      const signedBytes = signTransaction(txBytes, request.type);
      const elapsed = Date.now() - startTime;
      log.info(`[#${reqId}] SIGNED (${elapsed}ms)`);

      return toResponse({ ok: true, tx: Buffer.from(signedBytes).toString('base64') });
    } catch (err: any) {
      log.error(`[#${reqId}] Error: ${err.message}`);
      return toResponse({ ok: false, error: err.message });
    }
  }

  function toResponse(response: { ok: boolean; tx?: string; error?: string }): Buffer {
    return Buffer.from(JSON.stringify(response), 'utf-8');
  }

  // ── Unix socket server ──────────────────────────────────────────────────
  const socketPath = signerConfig.socketPath;

  if (fs.existsSync(socketPath)) {
    try {
      fs.unlinkSync(socketPath);
      log.info(`Removed stale socket: ${socketPath}`);
    } catch (err: any) {
      log.error(`Cannot remove stale socket ${socketPath}: ${err.message}`);
      process.exit(1);
    }
  }

  const server = net.createServer((sock) => {
    let buffer = Buffer.alloc(0);
    let expectedLen = -1;

    sock.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (expectedLen < 0 && buffer.length >= 4) {
        expectedLen = buffer.readUInt32BE(0);
        buffer = buffer.slice(4);
      }

      if (expectedLen >= 0 && buffer.length >= expectedLen) {
        const payload = buffer.slice(0, expectedLen);
        buffer = buffer.slice(expectedLen);
        expectedLen = -1;

        handleRequest(payload)
          .then((response) => {
            const lenBuf = Buffer.alloc(4);
            lenBuf.writeUInt32BE(response.length, 0);
            sock.write(lenBuf);
            sock.write(response);
          })
          .catch((err) => {
            log.error(`Handler error: ${err.message}`);
            const errResp = toResponse({ ok: false, error: 'Internal signer error' });
            const lenBuf = Buffer.alloc(4);
            lenBuf.writeUInt32BE(errResp.length, 0);
            sock.write(lenBuf);
            sock.write(errResp);
          });
      }
    });

    sock.on('error', (err) => {
      log.warn(`Socket error: ${err.message}`);
    });
  });

  server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, 0o660);
    } catch {
      /* ignore */
    }
    log.info(`Signer service listening on ${socketPath}`);
    log.info(`Program allowlist: ${signerConfig.programAllowlist.size} programs`);
    log.info(`Destination whitelist: ${signerConfig.destinationWhitelist.size} addresses`);
  });

  function shutdown() {
    log.info('Shutting down...');
    server.close();
    try {
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    } catch {
      /* ignore */
    }
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (err) => {
    log.error(`Uncaught exception: ${err.message}`);
    shutdown();
  });
}

// ── Start ─────────────────────────────────────────────────────────────────
init();
