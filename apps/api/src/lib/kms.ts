import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import type { KeyWrapper } from './vault.js';

/**
 * Production key wrapper: data keys are encrypted by an AWS KMS key, so the key-encryption key
 * never leaves KMS. The encryption context binds wrapped keys to SAILES. Values sealed earlier
 * with the local master key stay readable through `fallback` (decrypt only).
 */
export class KmsKeyWrapper implements KeyWrapper {
  private client: KMSClient;
  constructor(
    private keyId: string,
    private fallback?: KeyWrapper,
    client?: KMSClient,
  ) {
    this.client = client ?? new KMSClient({});
  }
  private context = { app: 'sailes', purpose: 'ai-credential' };

  async wrap(dataKey: Buffer) {
    const r = await this.client.send(new EncryptCommand({ KeyId: this.keyId, Plaintext: dataKey, EncryptionContext: this.context }));
    if (!r.CiphertextBlob) throw new Error('KMS returned no ciphertext');
    return 'kms:' + Buffer.from(r.CiphertextBlob).toString('base64');
  }

  async unwrap(wrapped: string) {
    if (wrapped.startsWith('kms:')) {
      const r = await this.client.send(new DecryptCommand({ CiphertextBlob: Buffer.from(wrapped.slice(4), 'base64'), EncryptionContext: this.context, KeyId: this.keyId }));
      if (!r.Plaintext) throw new Error('KMS returned no plaintext');
      return Buffer.from(r.Plaintext);
    }
    if (this.fallback) return this.fallback.unwrap(wrapped);
    throw new Error('Unsupported key wrapper');
  }
}
