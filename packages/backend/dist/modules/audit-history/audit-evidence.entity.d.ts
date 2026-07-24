export declare class AuditEvidence {
    id: string;
    auditId: string;
    fileType: string;
    filePath: string;
    gpsCoordinates: {
        lat: number;
        lng: number;
    };
    ocrResult: any;
    createdAt: Date;
}
