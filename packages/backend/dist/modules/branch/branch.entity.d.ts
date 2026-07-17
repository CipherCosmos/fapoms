import { BaseEntity } from '../../core/entities/base.entity';
import { ClientEntity } from '../client/client.entity';
export declare class BranchEntity extends BaseEntity {
    branchCode: string;
    solId: string | null;
    name: string;
    address: string;
    state: string;
    district: string;
    city: string;
    pincode: string | null;
    latitude: number | null;
    longitude: number | null;
    location: any | null;
    clientId: string | null;
    client: ClientEntity | null;
}
