import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RuleBypassWindowEntity } from './rule-bypass.entity';
import { RuleBypassService } from './rule-bypass.service';
import { RuleBypassController } from './rule-bypass.controller';

/**
 * Global, because the rules it governs are enforced in a dozen services across planning,
 * assignment, scheduling and the recommendation engine.
 *
 * The alternative — importing this module into each of those — means the day someone adds a
 * new enforcement point in a module that does not import it, the honest options are to wire up
 * another import or to skip the check. The second is what actually happens, and it produces a
 * rule that silently ignores the bypass: an administrator turns the geofence off, one screen
 * still rejects, and nobody can explain why. Global availability removes that choice.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([RuleBypassWindowEntity])],
  controllers: [RuleBypassController],
  providers: [RuleBypassService],
  exports: [RuleBypassService],
})
export class RuleBypassModule {}
