/*
 * mavula.io - Core Finance Engine
 * Copyright (c) 2026 mavula.io
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Request, Response } from 'express';
import * as csurf from 'csurf';

// Wrapper to initialize csurf middleware only when cookies are used
export function csrfMiddleware() {
  return csurf({
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    },
  });
}

// Helper to expose token (for SPA clients to read)
export function exposeCsrfToken(req: Request) {
  // csurf stores token on req.csrfToken
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tokenFn: any = (req as any).csrfToken;
    if (typeof tokenFn === 'function') {
      return tokenFn();
    }
  } catch (e) {
    return null;
  }
  return null;
}
