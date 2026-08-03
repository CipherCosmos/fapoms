import { AuthService } from './auth.service';
declare class LoginDto {
    username: string;
    password: string;
}
declare class VerifyAssayerDto {
    identifier: string;
}
declare class RefreshDto {
    refreshToken: string;
}
declare class BiometricLoginDto {
    refreshToken: string;
}
export declare class AuthController {
    private readonly authService;
    constructor(authService: AuthService);
    verifyAssayer(dto: VerifyAssayerDto): Promise<{
        success: boolean;
        data: {
            verified: boolean;
            displayName: string;
            assayerCode: string;
        } | {
            verified: boolean;
            displayName?: undefined;
            assayerCode?: undefined;
        };
    }>;
    status(): Promise<{
        success: boolean;
        data: {
            status: string;
            database: string;
            timestamp: string;
        };
    }>;
    login(dto: LoginDto, req: any): Promise<{
        success: boolean;
        data: {
            accessToken: string;
            refreshToken: string;
            expiresIn: number;
            user: any;
        };
    }>;
    biometricLogin(dto: BiometricLoginDto, req: any): Promise<{
        success: boolean;
        data: {
            accessToken: string;
            refreshToken: string;
            expiresIn: number;
            user: {
                id: any;
                username: any;
                name: any;
                email: any;
                phone: any;
                status: any;
            };
        };
    }>;
    refresh(dto: RefreshDto, req: any): Promise<{
        success: boolean;
        data: import("./auth.service").TokenPair;
    }>;
    logout(req: any): Promise<{
        success: boolean;
        data: {
            message: string;
        };
    }>;
}
export {};
