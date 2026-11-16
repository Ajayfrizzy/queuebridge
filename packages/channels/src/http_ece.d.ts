/** Minimal types for `http_ece` (MIT; RFC 8188 / RFC 8291), covering what QueueBridge uses. */
declare module 'http_ece' {
  import type { ECDH } from 'node:crypto';
  interface EceParams {
    version: 'aes128gcm' | 'aesgcm' | 'aesgcm128';
    dh?: string;
    privateKey?: ECDH;
    authSecret?: string;
    salt?: string;
    keyid?: string;
    rs?: number;
    key?: string;
  }
  const ece: {
    encrypt(buffer: Buffer, params: EceParams): Buffer;
    decrypt(buffer: Buffer, params: EceParams): Buffer;
  };
  export default ece;
}
