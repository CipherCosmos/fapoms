export interface CommunicationProvider {
    sendWhatsAppMessage(to: string, template: string, params: string[]): Promise<boolean>;
}
export interface OCRProvider {
    extractDocumentData(fileUri: string): Promise<Record<string, any>>;
}
export interface BillingProvider {
    createInvoiceDraft(customerId: string, amount: number, items: string[]): Promise<string>;
}
export interface StorageProvider {
    uploadFile(bucketName: string, path: string, fileBuffer: Buffer): Promise<string>;
}
