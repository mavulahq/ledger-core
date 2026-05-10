/*
 * getfluxo.io - Core Finance Engine
 * Copyright (c) 2025 getfluxo.io
 * 
 * Author: Estandar Mustaq <estandarmustaq@getfluxo.io>
 * License: Proprietary - See LICENSE file
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
