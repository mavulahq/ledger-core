import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { AccountsController } from './controllers/accounts.controller';
import { AccountsService } from './services/accounts.service';
import { PrismaService } from './services/prisma.service';

@Module({
  imports: [AuthModule],
  controllers: [AppController, AccountsController],
  providers: [AppService, AccountsService, PrismaService]
})
export class AppModule {}
