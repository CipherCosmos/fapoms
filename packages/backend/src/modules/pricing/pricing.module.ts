import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ClientConfigurationEntity } from '../client/client-configuration.entity';
import { AssayerCommercialProfileEntity } from '../assayer/assayer-commercial-profile.entity';
import { ProjectEntity } from '../project/project.entity';
import { FeePolicyService } from './fee-policy.service';
import { PricingController } from './pricing.controller';

/**
 * Owns the one fee calculation the whole platform quotes from. Deliberately depends only
 * on the two entities it reads, so any module that prices work can import it without
 * dragging in assignment/planning wiring.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ClientConfigurationEntity, AssayerCommercialProfileEntity, ProjectEntity])],
  controllers: [PricingController],
  providers: [FeePolicyService],
  exports: [FeePolicyService],
})
export class PricingModule {}
