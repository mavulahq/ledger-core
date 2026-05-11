/*
 * getfluxo.io - Core Finance Engine
 * Copyright (c) 2026 getfluxo.io
 * License: PROPRIETARY
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { TenantMiddleware } from './middleware/tenant.middleware';
import * as cookieParser from 'cookie-parser';
import { csrfMiddleware, exposeCsrfToken } from './middleware/csrf.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const expressApp = app.getHttpAdapter().getInstance();
  app.setGlobalPrefix('api');

  // cookie parser for CSRF and cookie-based auth
  app.use(cookieParser());

  app.use((req, res, next) => new TenantMiddleware().use(req, res, next));

  // Enable CSRF when cookie-based auth is enabled
  if (process.env.USE_HTTP_ONLY_COOKIE === 'true') {
    app.use(csrfMiddleware());

    // expose token endpoint
    expressApp.get('/api/csrf-token', (req: any, res: any) => {
      const token = exposeCsrfToken(req as any);
      res.json({ csrfToken: token });
    });
  }

  await app.listen(process.env.PORT ? Number(process.env.PORT) : 3000);
  console.log(`fengine listening on ${await app.getUrl()}`);
}
bootstrap();
