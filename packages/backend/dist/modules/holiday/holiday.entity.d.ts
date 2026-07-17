import { BaseEntity } from '../../core/entities/base.entity';
export declare class HolidayEntity extends BaseEntity {
    name: string;
    date: Date;
    type: string;
    applicableStates: string[] | null;
    year: number;
}
