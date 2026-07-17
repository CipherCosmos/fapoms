export declare abstract class BaseEntity {
    id: string;
    createdBy: string;
    createdAt: Date;
    updatedBy: string;
    updatedAt: Date;
    version: number;
    isActive: boolean;
}
export declare abstract class StatefulEntity extends BaseEntity {
    previousState: string;
    changeReason: string;
}
