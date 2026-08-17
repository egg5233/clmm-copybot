/**
 * One-time setup: encrypt private key with a password.
 * Run: npx ts-node setup.ts
 * Reads private key and password from stdin, writes encrypted key to keyfile.json
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { encryptKey } from './crypto';

const KEYFILE = path.resolve(__dirname, 'keyfile.enc.json');

function ask(prompt: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  if (fs.existsSync(KEYFILE)) {
    const overwrite = await ask(`${KEYFILE} already exists. Overwrite? (y/N): `);
    if (overwrite.toLowerCase() !== 'y') {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  const privateKey = await ask('Enter private key (base58): ');
  if (!privateKey) {
    console.error('No key provided.');
    process.exit(1);
  }

  // Validate key
  try {
    const kp = Keypair.fromSecretKey(bs58.decode(privateKey));
    console.log(`Wallet: ${kp.publicKey.toBase58()}`);
  } catch (err: any) {
    console.error(`Invalid private key: ${err.message}`);
    process.exit(1);
  }

  const password = await ask('Set password: ');
  if (!password) {
    console.error('No password provided.');
    process.exit(1);
  }

  const confirm = await ask('Confirm password: ');
  if (password !== confirm) {
    console.error('Passwords do not match.');
    process.exit(1);
  }

  const encrypted = encryptKey(privateKey, password);
  fs.writeFileSync(KEYFILE, JSON.stringify(encrypted, null, 2));
  console.log(`Encrypted key saved to ${KEYFILE}`);
  console.log('You can now delete any plaintext key files.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
