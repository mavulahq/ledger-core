import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(root, 'contracts/openapi/ledger-core.public.v1.yaml'), 'utf8');
const paths = new Set([...source.matchAll(/^  (\/[^:]+):$/gm)].map((match) => match[1]));
const expected = [
  '/api/accounts', '/api/accounts/{accountId}', '/api/accounts/{accountId}/balance',
  '/api/accounts/{accountId}/statement', '/api/accounts/{accountId}/status-transitions',
  '/api/account-lifecycle-requests', '/api/account-lifecycle-requests/{requestId}',
  '/api/account-lifecycle-requests/{requestId}/approve', '/api/account-lifecycle-requests/{requestId}/reject',
  '/api/financial-adjustment-requests', '/api/financial-adjustment-requests/{requestId}',
  '/api/financial-adjustment-requests/{requestId}/approve', '/api/financial-adjustment-requests/{requestId}/reject',
  '/api/products', '/api/products/config', '/api/products/config/generate', '/api/products/{productId}',
  '/api/products/{productId}/rules', '/api/products/{productId}/rules/defaults',
  '/api/products/{productId}/rules/{ruleId}', '/api/schemas', '/api/schemas/import',
  '/api/schemas/presets/business-registration', '/api/schemas/{schemaId}', '/api/schemas/{schemaId}/export',
  '/api/workflows', '/api/workflows/trigger/{trigger}', '/api/workflows/presets/loan-approval-notification',
  '/api/workflows/presets/monthly-fee-charge', '/api/workflows/{workflowId}', '/api/workflows/{workflowId}/execute',
  '/api/projections/status', '/api/projections/loan-activity', '/api/projections/loan-activity/{loanId}',
  '/api/projections/ledger-activity', '/api/projections/ledger-activity/{journalEntryId}',
  '/api/projections/product-publications', '/api/projections/product-publications/{productId}',
];
for (const route of expected) if (!paths.has(route)) throw new Error(`OpenAPI route missing: ${route}`);
for (const route of paths) if (/\/internal\/|\/health$|\/metrics$|\/auth\//.test(route)) throw new Error(`Internal route exposed: ${route}`);

const operationIds = [...source.matchAll(/operationId: (\S+)/g)].map((match) => match[1]);
const summaries = [...source.matchAll(/summary: ([^,}\n]+)/g)];
const permissions = [...source.matchAll(/x-mavula-permissions:/g)];
if (new Set(operationIds).size !== operationIds.length || operationIds.length !== expected.length + 7) {
  throw new Error('Ledger Core OpenAPI operationId coverage is incomplete or duplicated');
}
if (summaries.length !== operationIds.length || permissions.length !== operationIds.length) {
  throw new Error('Every Ledger Core operation must declare summary and permission metadata');
}
for (const schema of ['Account', 'AccountStatementPage', 'AccountLifecycleRequest', 'FinancialAdjustmentRequest', 'Product', 'Rule', 'EntitySchema', 'Workflow', 'Projection']) {
  if (!source.includes(`    ${schema}:`)) throw new Error(`OpenAPI schema missing: ${schema}`);
}

const controllers = [
  'accounts', 'account-lifecycle', 'financial-adjustments', 'products', 'rules', 'schemas', 'workflows',
];
for (const controller of controllers) {
  const controllerSource = readFileSync(path.join(root, 'src/controllers', `${controller}.controller.ts`), 'utf8');
  const writes = [...controllerSource.matchAll(/@(Post|Put|Patch|Delete)\b/g)].length;
  const operations = [...controllerSource.matchAll(/@IdempotentOperation\('/g)].length;
  if (writes !== operations) throw new Error(`${controller}.controller.ts has ${writes} writes but ${operations} idempotency policies`);
}
console.log(`ledger-core OpenAPI covers ${paths.size} public routes and all public writes declare idempotency`);
