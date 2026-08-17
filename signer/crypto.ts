import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 32;
const IV_LEN = 16;

interface EncryptedData {
  salt: string; // hex
  iv: string; // hex
  tag: string; // hex (GCM auth tag)
  data: string; // hex (ciphertext)
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

/** Encrypt a private key with a password. Returns JSON-serializable object. */
export function encryptKey(privateKey: string, password: string): EncryptedData {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(password, salt);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(privateKey, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex'),
  };
}

/** Decrypt a private key with a password. Throws on wrong password. */
export function decryptKey(encrypted: EncryptedData, password: string): string {
  const salt = Buffer.from(encrypted.salt, 'hex');
  const iv = Buffer.from(encrypted.iv, 'hex');
  const tag = Buffer.from(encrypted.tag, 'hex');
  const data = Buffer.from(encrypted.data, 'hex');
  const key = deriveKey(password, salt);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  try {
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf-8');
  } catch {
    throw new Error('Wrong password');
  }
}
