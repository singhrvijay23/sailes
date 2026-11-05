import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * Envelope encryption for merchant AI keys.
 * Each secret gets its own random data key (AES-256-GCM). The data key is wrapped by a
 * key-encryption key. Locally the KEK is SAILES_MASTER_KEY; in production `KeyWrapper`
 * is swapped for AWS KMS (Encrypt/Decrypt on the data key) without changing the stored format.
 */
export interface KeyWrapper {
  wrap(dataKey: Buffer): Promise<string>;
  unwrap(wrapped: string): Promise<Buffer>;
}

function aesEncrypt(key: Buffer, plaintext: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function aesDecrypt(key: Buffer, blob: string) {
  const buf = Buffer.from(blob, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
}

export class LocalKeyWrapper implements KeyWrapper {
  private kek: Buffer;
  constructor(masterKeyB64: string) {
    this.kek = Buffer.from(masterKeyB64, 'base64');
    if (this.kek.length !== 32) throw new Error('SAILES_MASTER_KEY must be 32 bytes, base64-encoded');
  }
  async wrap(dataKey: Buffer) {
    return 'local:' + aesEncrypt(this.kek, dataKey);
  }
  async unwrap(wrapped: string) {
    if (!wrapped.startsWith('local:')) throw new Error('Unsupported key wrapper');
    return aesDecrypt(this.kek, wrapped.slice(6));
  }
}

let wrapper: KeyWrapper = new LocalKeyWrapper(config.masterKey);
export function setKeyWrapper(w: KeyWrapper) {
  wrapper = w;
}

/** Returns "v1.<wrappedDataKey>.<ciphertext>" */
export async function sealSecret(secret: string): Promise<string> {
  const dataKey = randomBytes(32);
  const ct = aesEncrypt(dataKey, Buffer.from(secret, 'utf8'));
  const wrapped = await wrapper.wrap(dataKey);
  dataKey.fill(0);
  return `v1.${Buffer.from(wrapped).toString('base64')}.${ct}`;
}

export async function openSecret(sealed: string): Promise<string> {
  const [v, wrappedB64, ct] = sealed.split('.');
  if (v !== 'v1' || !wrappedB64 || !ct) throw new Error('Malformed sealed secret');
  const dataKey = await wrapper.unwrap(Buffer.from(wrappedB64, 'base64').toString());
  try {
    return aesDecrypt(dataKey, ct).toString('utf8');
  } finally {
    dataKey.fill(0);
  }
}

export function last4(secret: string) {
  return secret.slice(-4);
}
