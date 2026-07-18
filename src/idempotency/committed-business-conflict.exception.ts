import { ConflictException } from '@nestjs/common';

/**
 * Signals a business conflict whose state transition must commit before the
 * HTTP conflict is returned by the idempotency boundary.
 */
export class CommittedBusinessConflictException extends ConflictException {}
