import { SchedulingService, CreateScheduleDto } from './scheduling.service';
import { ScheduleStatus } from '@fapoms/shared';
declare class CreateScheduleRequestDto implements CreateScheduleDto {
    assignmentId: string;
    scheduledDate: string;
    remarks?: string;
}
declare class TransitionScheduleRequestDto {
    targetStatus: ScheduleStatus;
    remarks?: string;
    scheduledDate?: string;
}
export declare class SchedulingController {
    private readonly schedulingService;
    constructor(schedulingService: SchedulingService);
    create(dto: CreateScheduleRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./schedule.entity").ScheduleEntity;
    }>;
    findAll(page?: number, limit?: number): Promise<{
        success: boolean;
        data: import("./schedule.entity").ScheduleEntity[];
        meta: {
            pagination: {
                page: number;
                limit: number;
                total: number;
            };
        };
    }>;
    findOne(id: string): Promise<{
        success: boolean;
        data: import("./schedule.entity").ScheduleEntity;
    }>;
    transition(id: string, dto: TransitionScheduleRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./schedule.entity").ScheduleEntity;
    }>;
    getTimeline(id: string): Promise<{
        success: boolean;
        data: any[];
    }>;
}
export {};
