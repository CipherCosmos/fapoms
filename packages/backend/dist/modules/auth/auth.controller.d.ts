import { AuthService } from './auth.service';
declare class LoginDto {
    username: string;
    password: string;
}
declare class RefreshDto {
    refreshToken: string;
}
export declare class AuthController {
    private readonly authService;
    constructor(authService: AuthService);
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
            user: {
                id: string | undefined;
                username: string | undefined;
                email: string | undefined;
                displayName: string | undefined;
                roles: any[];
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
