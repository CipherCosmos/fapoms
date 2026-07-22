import { SearchService } from './search.service';
export declare class SearchController {
    private readonly searchService;
    constructor(searchService: SearchService);
    search(q: string): Promise<{
        success: boolean;
        data: {
            branches: {
                id: string;
                name: string;
                code: string;
                city: string;
                state: string;
            }[];
            assayers: {
                id: string;
                name: string;
                code: string;
                phone: string;
            }[];
            projects: {
                id: string;
                name: string;
                projectNumber: string;
            }[];
            clients: {
                id: string;
                name: string;
                code: string;
            }[];
            assignments: {
                id: string;
                assignmentNumber: string;
                branchName: string;
                assayerName: string;
            }[];
        };
    }>;
}
