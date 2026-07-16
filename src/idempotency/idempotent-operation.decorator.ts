import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_OPERATION = 'mavula.idempotent-operation';
export const IdempotentOperation = (operation: string) => SetMetadata(IDEMPOTENT_OPERATION, operation);
