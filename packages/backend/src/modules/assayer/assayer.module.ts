import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssayerEntity } from './assayer.entity';
import { AssayerCommercialProfileEntity } from './assayer-commercial-profile.entity';
import { WorkforceAttributeEntity } from './workforce-attribute.entity';
import { AssayerGovernmentDocumentEntity } from './assayer-government-document.entity';
import { AssayerDocumentEntity } from './assayer-document.entity';
import { AssayerRemarkEntity } from './assayer-remark.entity';
import { AssayerActivityEntity } from './assayer-activity.entity';
import { AssayerService } from './assayer.service';
import { AssayerController } from './assayer.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AssayerEntity,
      AssayerCommercialProfileEntity,
      WorkforceAttributeEntity,
      AssayerGovernmentDocumentEntity,
      AssayerDocumentEntity,
      AssayerRemarkEntity,
      AssayerActivityEntity,
    ]),
  ],
  controllers: [AssayerController],
  providers: [AssayerService],
  exports: [AssayerService, TypeOrmModule],
})
export class AssayerModule {}
