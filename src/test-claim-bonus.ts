/**
 * Test script: Claim type=2 (copy bonus) rewards via Byreal API
 * Usage: npx ts-node src/test-claim-bonus.ts
 *
 * ONLY claims type=2 (copy bonus). Does NOT touch LP fees or type=1 rewards.
 */

import { Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';

dotenv.config();

const BYREAL_API = 'https://api2.byreal.io/byreal/api/dex/v2';
const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const WALLET = keypair.publicKey.toBase58();

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${BYREAL_API}/${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function apiPost(path: string, body: any): Promise<any> {
  const res = await fetch(`${BYREAL_API}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function main() {
  console.log(`=== Claim Type=2 Copy Bonus ===`);
  console.log(`Wallet: ${WALLET}`);
  console.log(`Time: ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}\n`);

  // Step 1: Check epoch-bonus to see current state
  console.log('--- Step 1: Check epoch-bonus type=2 ---');
  const epochData = await apiGet(`copyfarmer/epoch-bonus?walletAddress=${WALLET}&type=2`);
  const epoch2 = epochData?.result?.data?.['2'];
  console.log('epoch-bonus type=2:', JSON.stringify(epoch2, null, 2));

  await sleep(2000);

  // Step 2: Call encode-v3 with type=2, empty positions (claims all)
  console.log('\n--- Step 2: encode-v3 type=2 (empty positions = all) ---');
  const encodeRes = await apiPost('incentive/encode-v3', {
    walletAddress: WALLET,
    positionAddresses: [],
    type: 2,
  });

  const encodeData = encodeRes?.result?.data;
  const orderCode = encodeData?.orderCode;
  const items = encodeData?.rewardEncodeItems || [];

  console.log(`orderCode: ${orderCode}`);
  console.log(`rewardEncodeItems count: ${items.length}`);

  if (items.length === 0) {
    console.log('\nNo rewards available to claim yet. Exiting.');
    return;
  }

  // Show reward details
  for (const item of items) {
    console.log(`\nPool: ${item.poolAddress}`);
    console.log(`  txCode: ${item.txCode}`);
    if (item.rewardClaimInfo) {
      for (const info of item.rewardClaimInfo) {
        const amount = Number(info.tokenAmount) / Math.pow(10, info.tokenDecimals);
        console.log(`  ${info.tokenSymbol}: ${amount} (raw: ${info.tokenAmount}, decimals: ${info.tokenDecimals})`);
      }
    }
  }

  await sleep(2000);

  // Step 3: Sign each txPayload
  console.log('\n--- Step 3: Sign transactions ---');
  const signedPayloads: { poolAddress: string; signedTx: string; txCode: string }[] = [];

  for (const item of items) {
    try {
      const txBuf = Buffer.from(item.txPayload, 'base64');
      const tx = VersionedTransaction.deserialize(txBuf);
      tx.sign([keypair]);
      const signedBase64 = Buffer.from(tx.serialize()).toString('base64');

      signedPayloads.push({
        poolAddress: item.poolAddress,
        signedTx: signedBase64,
        txCode: item.txCode,
      });
      console.log(`Signed tx for pool ${item.poolAddress} (txCode: ${item.txCode})`);
    } catch (err) {
      console.error(`Failed to sign tx for pool ${item.poolAddress}:`, err);
    }
  }

  if (signedPayloads.length === 0) {
    console.log('No transactions signed successfully. Exiting.');
    return;
  }

  await sleep(2000);

  // Step 4: Submit via order-v3
  console.log('\n--- Step 4: Submit via order-v3 ---');
  const orderRes = await apiPost('incentive/order-v3', {
    orderCode,
    walletAddress: WALLET,
    signedTxPayload: signedPayloads,
  });

  console.log('order-v3 response:', JSON.stringify(orderRes?.result?.data, null, 2));

  const txList = orderRes?.result?.data?.txList || [];
  const claimTokens = orderRes?.result?.data?.claimTokenList || [];

  console.log(`\n=== Results ===`);
  console.log(`Transactions submitted: ${txList.length}`);
  for (const tx of txList) {
    console.log(`  Pool: ${tx.poolAddress}`);
    console.log(`  TX: ${tx.txSignature}`);
    console.log(`  Status: ${tx.status}`);
  }

  if (claimTokens.length > 0) {
    console.log(`\nClaimed tokens:`);
    for (const t of claimTokens) {
      console.log(`  ${t.tokenSymbol}: ${t.tokenAmount}`);
    }
  }

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
