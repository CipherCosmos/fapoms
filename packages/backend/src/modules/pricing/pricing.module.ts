import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ClientConfigurationEntity } from '../client/client-configuration.entity';
import { AssayerCommercialProfileEntity } from '../assayer/assayer-commercial-profile.entity';
import { ProjectEntity } from '../project/project.entity';
import { BranchEntity } from '../branch/branch.entity';
import { FeePolicyService } from './fee-policy.service';
import { PricingController } from './pricing.controller';
import { TransportRateEntity } from './transport-rate.entity';
import { TransportRateService } from './transport-rate.service';
import { TransportRateController } from './transport-rate.controller';

/**
 * Owns the one fee calculation the whole platform quotes from. Deliberately depends only
 * on the entities it reads, so any module that prices work can import it without
 * dragging in assignment/planning wiring.
 *
 * Also owns the transport rate card — the desk-managed table of what a kilometre costs by
 * each mode of travel, per place. It lives here rather than in its own module precisely so
 * there is no second calculator: `FeePolicyService.quote()` consumes it, and everything that
 * prices work keeps flowing through that one method.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ClientConfigurationEntity,
      AssayerCommercialProfileEntity,
      ProjectEntity,
      BranchEntity,
      TransportRateEntity,
    ]),
  ],
  controllers: [PricingController, TransportRateController],
  providers: [FeePolicyService, TransportRateService],
  exports: [FeePolicyService, TransportRateService],
})
export class PricingModule {}
