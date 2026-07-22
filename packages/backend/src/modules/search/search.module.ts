import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BranchEntity } from '../branch/branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { ProjectEntity } from '../project/project.entity';
import { ClientEntity } from '../client/client.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      BranchEntity,
      AssayerEntity,
      ProjectEntity,
      ClientEntity,
      AssignmentEntity,
    ]),
  ],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
