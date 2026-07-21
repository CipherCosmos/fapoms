import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunicationService } from './communication.service';
import { CommunicationController } from './communication.controller';
import { CommunicationEntity } from './communication.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([CommunicationEntity, AssignmentEntity]),
  ],
  controllers: [CommunicationController],
  providers: [CommunicationService],
  exports: [CommunicationService],
})
export class CommunicationModule {}
