import { BaseEntity } from '../../core/entities/base.entity';
import { ClientEntity } from '../client/client.entity';
export declare class ZoneEntity extends BaseEntity {
    name: string;
    description: string | null;
    clientId: string | null;
    client: ClientEntity | null;
    states: string[] | null;
    districts: string[] | null;
}
