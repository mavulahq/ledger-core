import { InternalApiKeyGuard } from '../../src/worker/internal-api-key.guard';
import { EngineEventService } from '../../src/worker/engine-event.service';
import { WorkerQueueService } from '../../src/worker/worker-queue.service';

describe('fengine worker communication', () => {
  beforeEach(() => {
    process.env.FENGINE_QUEUE_BACKEND = 'memory';
    process.env.INTERNAL_API_KEY = 'test-internal-key';
  });

  afterEach(() => {
    delete process.env.FENGINE_QUEUE_BACKEND;
    delete process.env.INTERNAL_API_KEY;
  });

  it('publishes idempotent BullMQ-compatible engine jobs', async () => {
    const queue = new WorkerQueueService();
    const first = await queue.enqueue({
      tenant_id: 'tenant_001',
      event_type: 'LOAN_APPROVED',
      payload: { loan_id: 'loan_001' },
      idempotency_key: 'loan-approved-001',
    });

    expect(first).toMatchObject({
      id: 'fengine-loan-approved-001',
      queue: 'platform',
      type: 'FENGINE_EVENT',
      status: 'QUEUED',
      payload: { loan_id: 'loan_001', event_type: 'LOAN_APPROVED' },
    });
    await expect(queue.get(first.id)).resolves.toEqual(first);
  });

  it('executes workflows for callbacks and replays completed jobs safely', async () => {
    const schemas = {
      getWorkflowsByTrigger: jest.fn().mockResolvedValue([{ workflow_id: 'wf_001' }]),
      executeWorkflow: jest.fn().mockResolvedValue({ success: true, results: [] }),
    };
    const audit = { record: jest.fn() };
    const service = new EngineEventService(schemas as any, audit as any);
    const event = {
      job_id: 'job_001',
      tenant_id: 'tenant_001',
      event_type: 'LOAN_APPROVED',
      payload: { loan_id: 'loan_001' },
    };

    await expect(service.handle(event)).resolves.toMatchObject({ accepted: true, executed_workflows: 1 });
    await expect(service.handle(event)).resolves.toMatchObject({ accepted: true, idempotent: true });
    expect(schemas.executeWorkflow).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('rejects missing or invalid internal API keys', () => {
    const guard = new InternalApiKeyGuard();
    const context = (key?: string) => ({
      switchToHttp: () => ({ getRequest: () => ({ headers: key ? { 'x-internal-api-key': key } : {} }) }),
    }) as any;

    expect(() => guard.canActivate(context())).toThrow('Internal API key is required');
    expect(() => guard.canActivate(context('invalid-key'))).toThrow('Invalid internal API key');
    expect(guard.canActivate(context('test-internal-key'))).toBe(true);
  });
});
