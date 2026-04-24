import crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY || '0'.repeat(64);
  return Buffer.from(hex, 'hex');
}

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

export function decrypt(encrypted: string): string {
  const [ivHex, dataHex] = encrypted.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
