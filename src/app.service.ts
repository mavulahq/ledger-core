/*
 * getfluxo.io - Core Finance Engine
 * Copyright (c) 2026 getfluxo.io
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello from fengine';
  }
}
