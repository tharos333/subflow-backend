import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwt';
import { AppError } from '../utils/AppError';

declare global {
  namespace Express {
    interface Request {
      user?: { id: string };
    }
  }
}

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(new AppError('Unauthorized', 401));
  try {
    const payload = verifyToken(header.slice(7));
    req.user = { id: payload.sub };
    next();
  } catch {
    next(new AppError('Invalid token', 401));
  }
}
