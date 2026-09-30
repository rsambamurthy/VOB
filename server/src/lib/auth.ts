import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import type { Role } from '../db/schema.js';
import { env } from './env.js';
import { HttpError } from './http.js';

export type Principal =
  | { kind: 'staff'; userId: string; role: Role; name: string; email: string }
  | { kind: 'vendor'; vendorId: string; email: string };

declare global {
  namespace Express {
    interface Request { principal?: Principal }
  }
}

export function signToken(p: Principal, ttl = '12h'): string {
  return jwt.sign(p, env.jwtSecret, { expiresIn: ttl } as jwt.SignOptions);
}

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  const token = h?.startsWith('Bearer ') ? h.slice(7) : (req.query.token as string | undefined);
  if (token) {
    try {
      req.principal = jwt.verify(token, env.jwtSecret) as Principal;
    } catch { /* invalid token -> treated as anonymous */ }
  }
  next();
}

export function requireStaff(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const p = req.principal;
    if (!p || p.kind !== 'staff') return next(new HttpError(401, 'Staff login required'));
    if (roles.length && !roles.includes(p.role)) return next(new HttpError(403, 'Your role cannot perform this action'));
    next();
  };
}

export function requireVendor(req: Request, _res: Response, next: NextFunction) {
  const p = req.principal;
  if (!p || p.kind !== 'vendor') return next(new HttpError(401, 'Vendor login required'));
  next();
}

export function staff(req: Request) {
  const p = req.principal;
  if (!p || p.kind !== 'staff') throw new HttpError(401, 'Staff login required');
  return p;
}

export function vendorPrincipal(req: Request) {
  const p = req.principal;
  if (!p || p.kind !== 'vendor') throw new HttpError(401, 'Vendor login required');
  return p;
}
