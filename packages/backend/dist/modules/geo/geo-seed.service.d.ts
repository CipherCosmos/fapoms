import { OnModuleInit } from '@nestjs/common';
import { Repository } from 'typeorm';
import { GeoStateEntity, GeoDistrictEntity, GeoCityEntity } from './geo.entities';
export declare class GeoSeedService implements OnModuleInit {
    private readonly stateRepo;
    private readonly districtRepo;
    private readonly cityRepo;
    constructor(stateRepo: Repository<GeoStateEntity>, districtRepo: Repository<GeoDistrictEntity>, cityRepo: Repository<GeoCityEntity>);
    onModuleInit(): Promise<void>;
}
