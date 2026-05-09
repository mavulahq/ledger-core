import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { TenantMiddleware } from './middleware/tenant.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.use((req, res, next) => new TenantMiddleware().use(req, res, next));
  await app.listen(process.env.PORT ? Number(process.env.PORT) : 3000);
  console.log(`fengine listening on ${await app.getUrl()}`);
}
bootstrap();
