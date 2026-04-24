import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'changeme';
const EXPIRES = process.env.JWT_EXPIRES_IN || '7d';

export function generateTokens(userId: string) {
  const access_token = jwt.sign({ sub: userId }, SECRET, { expiresIn: EXPIRES } as jwt.SignOptions);
  return { access_token };
}

export function verifyToken(token: string): { sub: string } {
  return jwt.verify(token, SECRET) as { sub: string };
}
