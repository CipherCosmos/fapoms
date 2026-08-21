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
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { SecurityModule } from '../../infrastructure/security/security.module';

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
    // Provides the 'StorageEngine' token the attachment routes inject, and the malware
    // scanner behind FileScanInterceptor. Attachments go to object storage, never to disk.
    StorageModule,
    SecurityModule,
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
