import { BaseEntity } from '../../core/entities/base.entity';
export declare class GeoStateEntity extends BaseEntity {
    name: string;
    code: string;
}
export declare class GeoDistrictEntity extends BaseEntity {
    name: string;
    stateId: string;
    state: GeoStateEntity;
}
export declare class GeoCityEntity extends BaseEntity {
    name: string;
    districtId: string;
    pincode: string | null;
    district: GeoDistrictEntity;
}
