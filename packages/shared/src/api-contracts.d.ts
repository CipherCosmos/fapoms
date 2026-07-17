export interface ApiResponse<T> {
    success: boolean;
    data: T;
    meta?: ApiMeta;
}
export interface ApiErrorResponse {
    success: false;
    error: ApiError;
}
export interface ApiError {
    code: string;
    message: string;
    details?: ApiErrorDetail[];
    traceId?: string;
}
export interface ApiErrorDetail {
    field?: string;
    constraint?: string;
    message?: string;
}
export interface PaginationParams {
    page?: number;
    limit?: number;
    cursor?: string;
}
export interface PaginatedResponse<T> {
    success: boolean;
    data: T[];
    meta: PaginationMeta;
}
export interface PaginationMeta {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrevious: boolean;
    nextCursor?: string;
}
export interface ApiMeta {
    pagination?: PaginationMeta;
    timestamp?: string;
}
export interface SortParams {
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
}
export interface FilterParams {
    [key: string]: string | string[] | number | boolean | undefined;
}
export interface BulkOperationRequest<T = Record<string, unknown>> {
    action: string;
    ids: string[];
    data?: T;
    remarks?: string;
}
export interface BulkOperationResponse {
    success: boolean;
    totalRequested: number;
    totalSucceeded: number;
    totalFailed: number;
    results: BulkOperationResult[];
}
export interface BulkOperationResult {
    id: string;
    status: 'success' | 'error';
    error?: string;
}
export interface LoginRequest {
    username: string;
    password: string;
}
export interface LoginResponse {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    user: AuthenticatedUser;
}
export interface RefreshTokenRequest {
    refreshToken: string;
}
export interface AuthenticatedUser {
    id: string;
    username: string;
    email: string;
    displayName: string;
    roles: string[];
    permissions: string[];
}
export interface SearchRequest {
    query: string;
    entityTypes?: string[];
    limit?: number;
}
export interface SearchResult {
    entityType: string;
    entityId: string;
    title: string;
    subtitle?: string;
    status?: string;
    matchField?: string;
}
export interface SearchResponse {
    success: boolean;
    data: SearchResult[];
    meta: {
        total: number;
        query: string;
    };
}
