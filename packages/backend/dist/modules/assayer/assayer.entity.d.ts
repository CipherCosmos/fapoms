import { BaseEntity } from '../../core/entities/base.entity';
export declare class AssayerEntity extends BaseEntity {
    assayerCode: string;
    firstName: string;
    lastName: string;
    displayName: string;
    email: string | null;
    phone: string;
    alternatePhone: string | null;
    address: string;
    state: string;
    district: string;
    city: string;
    pincode: string | null;
    latitude: number | null;
    longitude: number | null;
    location: any | null;
    status: string;
    panNumber: string | null;
    bankAccountNumber: string | null;
    ifscCode: string | null;
    notes: string | null;
    employmentType: string;
    skills: string[] | null;
    certifications: {
        name: string;
        expiryDate: string;
    }[] | null;
    languages: string[] | null;
    preferredRegions: string[] | null;
    specializations: string[] | null;
    experienceYears: number;
    performanceRating: number;
    leaves: {
        startDate: string;
        endDate: string;
    }[] | null;
    workingHours: {
        start: string;
        end: string;
    } | null;
    maxDailyWorkload: number;
    maxWeeklyWorkload: number;
}
