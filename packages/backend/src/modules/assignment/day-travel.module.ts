import { Module } from '@nestjs/common';
import { PricingModule } from '../pricing/pricing.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { DayTravelService } from './assignment-day-travel';

/**
 * Travel once per assayer per day, as a service every writer that can change a day can reach.
 *
 * Its own leaf module rather than a provider of AssignmentModule because the branch and project
 * closures cancel work too, and AssignmentModule already imports ProjectModule (which imports
 * BranchModule) — so they cannot import it back. This depends only on PricingModule and
 * NotificationsModule, neither of which imports any of the three, so there is no cycle.
 * UnitOfWork and AuditService are global.
 */
@Module({
  imports: [PricingModule, NotificationsModule],
  providers: [DayTravelService],
  exports: [DayTravelService],
})
export class DayTravelModule {}
