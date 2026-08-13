import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FeedbackThreadEntity } from './feedback-thread.entity';
import { FeedbackMessageEntity } from './feedback-message.entity';
import { FeedbackVoteEntity } from './feedback-vote.entity';
import { UserEntity } from '../user/user.entity';
import { FeedbackService } from './feedback.service';
import { FeedbackThreadService } from './feedback-thread.service';
import { FeedbackEscalationService } from './feedback-escalation.service';
import { FeedbackController } from './feedback.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { FEEDBACK_INTELLIGENCE, HeuristicFeedbackIntelligence } from './feedback-intelligence';

/**
 * The feedback & collaboration channel between every FAPOMS user and the
 * product/support team.
 *
 * The intelligence layer is bound to the heuristic implementation through the
 * {@link FEEDBACK_INTELLIGENCE} token — swap `useClass` here for an LLM-backed one
 * and nothing else in the module changes.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([FeedbackThreadEntity, FeedbackMessageEntity, FeedbackVoteEntity, UserEntity]),
    NotificationsModule,
  ],
  controllers: [FeedbackController],
  providers: [
    FeedbackService,
    FeedbackThreadService,
    FeedbackEscalationService,
    { provide: FEEDBACK_INTELLIGENCE, useClass: HeuristicFeedbackIntelligence },
  ],
  exports: [FeedbackService, FeedbackEscalationService],
})
export class FeedbackModule {}
