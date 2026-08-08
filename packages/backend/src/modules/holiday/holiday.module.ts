/**
 * FAPOMS — Holiday Module
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { HolidayEntity } from './holiday.entity';
import { HolidayService } from './holiday.service';
import { HolidayController } from './holiday.controller';
import { ClientConfigurationEntity } from '../client/client-configuration.entity';

@Module({
  imports: [TypeOrmModule.forFeature([HolidayEntity, ClientConfigurationEntity])],
  controllers: [HolidayController],
  providers: [HolidayService],
  exports: [HolidayService],
})
export class HolidayModule {}
