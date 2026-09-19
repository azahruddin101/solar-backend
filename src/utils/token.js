import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/** `by` is set when a super admin is signed in as a company (impersonation). */
export const signToken = (user, by = null) =>
  jwt.sign({ sub: String(user.id), role: user.role, ...(by ? { by: String(by) } : {}) }, env.jwtSecret, { expiresIn: by ? '2h' : env.jwtExpires });

export const verifyToken = (token) => jwt.verify(token, env.jwtSecret);
