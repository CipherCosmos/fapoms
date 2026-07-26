export declare class BillingRecord {
    id: string;
    auditId?: string;
    assayerId: string;
    baseFee: number;
    travelAllowance: number;
    penalties: number;
    gst: number;
    tds: number;
    netPayable: number;
    invoiceStatus: string;
    createdAt: Date;
}
