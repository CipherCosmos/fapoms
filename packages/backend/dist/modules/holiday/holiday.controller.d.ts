import { HolidayService, CreateHolidayDto } from './holiday.service';
declare class CreateHolidayRequestDto implements CreateHolidayDto {
    name: string;
    date: Date;
    type: string;
    applicableStates?: string[];
}
export declare class HolidayController {
    private readonly holidayService;
    constructor(holidayService: HolidayService);
    create(dto: CreateHolidayRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./holiday.entity").HolidayEntity;
    }>;
    findAll(page?: number, limit?: number, year?: number): Promise<{
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
    checkHoliday(dateString: string, stateCode?: string): Promise<{
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
    remove(id: string, req: any): Promise<{
        success: boolean;
        data: {
            message: string;
        };
    }>;
}
export {};
