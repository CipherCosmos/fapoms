import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BillingRecord } from './billing-record.entity';
import { BillingService } from './billing.service';

@Module({
  imports: [TypeOrmModule.forFeature([BillingRecord])],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
