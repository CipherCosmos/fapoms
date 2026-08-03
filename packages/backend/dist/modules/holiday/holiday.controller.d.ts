import { HolidayService, CreateHolidayDto } from './holiday.service';
declare class CreateHolidayRequestDto implements CreateHolidayDto {
    name: string;
    date: string | Date;
    type: string;
    applicableStates?: string[];
    clientId?: string;
}
declare class UpdateHolidayRequestDto {
    name?: string;
    date?: string | Date;
    type?: string;
    applicableStates?: string[];
    clientId?: string;
}
export declare class HolidayController {
    private readonly holidayService;
    constructor(holidayService: HolidayService);
    create(dto: CreateHolidayRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./holiday.entity").HolidayEntity;
    }>;
    findAll(page?: number, limit?: number, year?: number, clientId?: string): Promise<{
        success: boolean;
        data: import("./holiday.entity").HolidayEntity[];
        meta: {
            pagination: {
                page: number;
                limit: number;
                total: number;
                totalPages: number;
                hasNext: boolean;
                hasPrevious: boolean;
            };
        };
    }>;
    checkHoliday(dateString: string, stateCode?: string, clientId?: string): Promise<{
        success: boolean;
        error: string;
        data?: undefined;
    } | {
        success: boolean;
        data: {
            isHoliday: boolean;
        };
        error?: undefined;
    }>;
    update(id: string, dto: UpdateHolidayRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./holiday.entity").HolidayEntity;
    }>;
    remove(id: string, req: any): Promise<{
        success: boolean;
        data: {
            message: string;
        };
    }>;
}
export {};
