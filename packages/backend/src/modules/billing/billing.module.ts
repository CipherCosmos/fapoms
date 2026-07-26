import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BillingRecord } from './billing-record.entity';
import { BillingService } from './billing.service';

import { BillingController } from './billing.controller';

@Module({
  imports: [TypeOrmModule.forFeature([BillingRecord])],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
