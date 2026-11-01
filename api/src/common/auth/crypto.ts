import { createHash, randomBytes } from 'node:crypto';

/** Token opaco (refresh, convite, reset). Só o hash vai para o banco. */
export function newOpaqueToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
