import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientEntity } from './client.entity';
import { ClientConfigurationEntity } from './client-configuration.entity';
import { ClientContactEntity } from './client-contact.entity';
import { ClientContractEntity } from './client-contract.entity';
import { ClientBillingEntity } from './client-billing.entity';
import { ClientService } from './client.service';
import { ClientController } from './client.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ClientEntity,
      ClientConfigurationEntity,
      ClientContactEntity,
      ClientContractEntity,
      ClientBillingEntity,
    ]),
  ],
  controllers: [ClientController],
  providers: [ClientService],
  exports: [ClientService],
})
export class ClientModule {}
