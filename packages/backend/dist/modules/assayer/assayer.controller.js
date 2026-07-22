"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AssayerController = exports.UpdateAssayerDocumentRequestDto = exports.UpdateRemarkRequestDto = exports.CreateRemarkRequestDto = exports.CreateAssayerDocumentRequestDto = exports.UpdateGovernmentDocumentRequestDto = exports.CreateGovernmentDocumentRequestDto = exports.TransitionLifecycleDto = exports.UpdateCommercialProfileRequestDto = exports.CreateCommercialProfileRequestDto = exports.UpdateWorkforceAttributeRequestDto = exports.CreateWorkforceAttributeRequestDto = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const class_validator_1 = require("class-validator");
const assayer_service_1 = require("./assayer.service");
const guards_1 = require("../auth/guards");
const shared_1 = require("@fapoms/shared");
class CreateAssayerRequestDto {
    assayerCode;
    firstName;
    lastName;
    email;
    phone;
    alternatePhone;
    address;
    state;
    district;
    city;
    pincode;
    latitude;
    longitude;
    panNumber;
    bankAccountNumber;
    ifscCode;
    notes;
    employmentType;
    joiningDate;
    managerId;
    department;
    region;
    emergencyContactName;
    emergencyContactPhone;
    emergencyContactRelation;
    employeeId;
    employeeCode;
    photograph;
    skills;
    certifications;
    languages;
    preferredRegions;
    specializations;
    experienceYears;
    performanceRating;
    leaves;
    workingHours;
    maxDailyWorkload;
    maxWeeklyWorkload;
    eligibleClients;
}
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "assayerCode", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "firstName", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "lastName", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEmail)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "email", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "phone", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "alternatePhone", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "address", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "state", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "district", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "city", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "pincode", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata("design:type", Number)
], CreateAssayerRequestDto.prototype, "latitude", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata("design:type", Number)
], CreateAssayerRequestDto.prototype, "longitude", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "panNumber", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "bankAccountNumber", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "ifscCode", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "notes", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "employmentType", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "joiningDate", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "managerId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "department", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "region", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "emergencyContactName", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "emergencyContactPhone", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "emergencyContactRelation", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "employeeId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "employeeCode", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAssayerRequestDto.prototype, "photograph", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], CreateAssayerRequestDto.prototype, "skills", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], CreateAssayerRequestDto.prototype, "certifications", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], CreateAssayerRequestDto.prototype, "languages", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], CreateAssayerRequestDto.prototype, "preferredRegions", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], CreateAssayerRequestDto.prototype, "specializations", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    __metadata("design:type", Number)
], CreateAssayerRequestDto.prototype, "experienceYears", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata("design:type", Number)
], CreateAssayerRequestDto.prototype, "performanceRating", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], CreateAssayerRequestDto.prototype, "leaves", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], CreateAssayerRequestDto.prototype, "workingHours", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    __metadata("design:type", Number)
], CreateAssayerRequestDto.prototype, "maxDailyWorkload", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    __metadata("design:type", Number)
], CreateAssayerRequestDto.prototype, "maxWeeklyWorkload", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], CreateAssayerRequestDto.prototype, "eligibleClients", void 0);
class UpdateAssayerRequestDto {
    firstName;
    lastName;
    email;
    phone;
    alternatePhone;
    address;
    state;
    district;
    city;
    pincode;
    latitude;
    longitude;
    panNumber;
    bankAccountNumber;
    ifscCode;
    notes;
    employmentType;
    joiningDate;
    exitDate;
    terminationDate;
    managerId;
    department;
    region;
    emergencyContactName;
    emergencyContactPhone;
    emergencyContactRelation;
    employeeId;
    employeeCode;
    photograph;
    skills;
    certifications;
    languages;
    preferredRegions;
    specializations;
    experienceYears;
    performanceRating;
    leaves;
    workingHours;
    maxDailyWorkload;
    maxWeeklyWorkload;
    eligibleClients;
}
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "firstName", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "lastName", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEmail)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "email", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "phone", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "alternatePhone", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "address", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "state", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "district", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "city", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "pincode", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata("design:type", Number)
], UpdateAssayerRequestDto.prototype, "latitude", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata("design:type", Number)
], UpdateAssayerRequestDto.prototype, "longitude", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "panNumber", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "bankAccountNumber", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "ifscCode", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "notes", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "employmentType", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "joiningDate", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "exitDate", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "terminationDate", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "managerId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "department", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "region", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "emergencyContactName", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "emergencyContactPhone", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "emergencyContactRelation", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "employeeId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "employeeCode", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerRequestDto.prototype, "photograph", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], UpdateAssayerRequestDto.prototype, "skills", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], UpdateAssayerRequestDto.prototype, "certifications", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], UpdateAssayerRequestDto.prototype, "languages", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], UpdateAssayerRequestDto.prototype, "preferredRegions", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], UpdateAssayerRequestDto.prototype, "specializations", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    __metadata("design:type", Number)
], UpdateAssayerRequestDto.prototype, "experienceYears", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata("design:type", Number)
], UpdateAssayerRequestDto.prototype, "performanceRating", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], UpdateAssayerRequestDto.prototype, "leaves", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], UpdateAssayerRequestDto.prototype, "workingHours", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    __metadata("design:type", Number)
], UpdateAssayerRequestDto.prototype, "maxDailyWorkload", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    __metadata("design:type", Number)
], UpdateAssayerRequestDto.prototype, "maxWeeklyWorkload", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], UpdateAssayerRequestDto.prototype, "eligibleClients", void 0);
class CreateWorkforceAttributeRequestDto {
    type;
    name;
    level;
    expiryDate;
    metadata;
}
exports.CreateWorkforceAttributeRequestDto = CreateWorkforceAttributeRequestDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateWorkforceAttributeRequestDto.prototype, "type", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateWorkforceAttributeRequestDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateWorkforceAttributeRequestDto.prototype, "level", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateWorkforceAttributeRequestDto.prototype, "expiryDate", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], CreateWorkforceAttributeRequestDto.prototype, "metadata", void 0);
class UpdateWorkforceAttributeRequestDto {
    name;
    level;
    expiryDate;
    metadata;
}
exports.UpdateWorkforceAttributeRequestDto = UpdateWorkforceAttributeRequestDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateWorkforceAttributeRequestDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateWorkforceAttributeRequestDto.prototype, "level", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", Object)
], UpdateWorkforceAttributeRequestDto.prototype, "expiryDate", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], UpdateWorkforceAttributeRequestDto.prototype, "metadata", void 0);
class CreateCommercialProfileRequestDto {
    baseFee;
    hourlyRate;
    dailyRate;
    travelReimbursement;
    accommodationAllowance;
    mealAllowance;
    currency;
    effectiveStartDate;
    effectiveEndDate;
}
exports.CreateCommercialProfileRequestDto = CreateCommercialProfileRequestDto;
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", Number)
], CreateCommercialProfileRequestDto.prototype, "baseFee", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", Number)
], CreateCommercialProfileRequestDto.prototype, "hourlyRate", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", Number)
], CreateCommercialProfileRequestDto.prototype, "dailyRate", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", Number)
], CreateCommercialProfileRequestDto.prototype, "travelReimbursement", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", Number)
], CreateCommercialProfileRequestDto.prototype, "accommodationAllowance", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", Number)
], CreateCommercialProfileRequestDto.prototype, "mealAllowance", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateCommercialProfileRequestDto.prototype, "currency", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateCommercialProfileRequestDto.prototype, "effectiveStartDate", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", Object)
], CreateCommercialProfileRequestDto.prototype, "effectiveEndDate", void 0);
class UpdateCommercialProfileRequestDto {
    baseFee;
    hourlyRate;
    dailyRate;
    travelReimbursement;
    accommodationAllowance;
    mealAllowance;
    currency;
    effectiveStartDate;
    effectiveEndDate;
}
exports.UpdateCommercialProfileRequestDto = UpdateCommercialProfileRequestDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata("design:type", Number)
], UpdateCommercialProfileRequestDto.prototype, "baseFee", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata("design:type", Number)
], UpdateCommercialProfileRequestDto.prototype, "hourlyRate", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata("design:type", Number)
], UpdateCommercialProfileRequestDto.prototype, "dailyRate", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata("design:type", Number)
], UpdateCommercialProfileRequestDto.prototype, "travelReimbursement", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata("design:type", Number)
], UpdateCommercialProfileRequestDto.prototype, "accommodationAllowance", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata("design:type", Number)
], UpdateCommercialProfileRequestDto.prototype, "mealAllowance", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateCommercialProfileRequestDto.prototype, "currency", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateCommercialProfileRequestDto.prototype, "effectiveStartDate", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", Object)
], UpdateCommercialProfileRequestDto.prototype, "effectiveEndDate", void 0);
class TransitionLifecycleDto {
    targetStatus;
    reason;
}
exports.TransitionLifecycleDto = TransitionLifecycleDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], TransitionLifecycleDto.prototype, "targetStatus", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], TransitionLifecycleDto.prototype, "reason", void 0);
class CreateGovernmentDocumentRequestDto {
    documentType;
    documentNumber;
    expiryDate;
    filePaths;
    remarks;
}
exports.CreateGovernmentDocumentRequestDto = CreateGovernmentDocumentRequestDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateGovernmentDocumentRequestDto.prototype, "documentType", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateGovernmentDocumentRequestDto.prototype, "documentNumber", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], CreateGovernmentDocumentRequestDto.prototype, "expiryDate", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], CreateGovernmentDocumentRequestDto.prototype, "filePaths", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateGovernmentDocumentRequestDto.prototype, "remarks", void 0);
class UpdateGovernmentDocumentRequestDto {
    documentNumber;
    expiryDate;
    verificationStatus;
    verifiedBy;
    filePaths;
    remarks;
}
exports.UpdateGovernmentDocumentRequestDto = UpdateGovernmentDocumentRequestDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateGovernmentDocumentRequestDto.prototype, "documentNumber", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", Object)
], UpdateGovernmentDocumentRequestDto.prototype, "expiryDate", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateGovernmentDocumentRequestDto.prototype, "verificationStatus", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateGovernmentDocumentRequestDto.prototype, "verifiedBy", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], UpdateGovernmentDocumentRequestDto.prototype, "filePaths", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateGovernmentDocumentRequestDto.prototype, "remarks", void 0);
class CreateAssayerDocumentRequestDto {
    documentType;
    fileName;
    filePath;
    fileSize;
    mimeType;
    parentDocumentId;
    remarks;
}
exports.CreateAssayerDocumentRequestDto = CreateAssayerDocumentRequestDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateAssayerDocumentRequestDto.prototype, "documentType", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateAssayerDocumentRequestDto.prototype, "fileName", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateAssayerDocumentRequestDto.prototype, "filePath", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", Number)
], CreateAssayerDocumentRequestDto.prototype, "fileSize", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAssayerDocumentRequestDto.prototype, "mimeType", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAssayerDocumentRequestDto.prototype, "parentDocumentId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAssayerDocumentRequestDto.prototype, "remarks", void 0);
class CreateRemarkRequestDto {
    content;
    category;
    visibility;
    attachmentPaths;
    rating;
}
exports.CreateRemarkRequestDto = CreateRemarkRequestDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateRemarkRequestDto.prototype, "content", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateRemarkRequestDto.prototype, "category", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateRemarkRequestDto.prototype, "visibility", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], CreateRemarkRequestDto.prototype, "attachmentPaths", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata("design:type", Number)
], CreateRemarkRequestDto.prototype, "rating", void 0);
class UpdateRemarkRequestDto {
    content;
    category;
    visibility;
    attachmentPaths;
    rating;
}
exports.UpdateRemarkRequestDto = UpdateRemarkRequestDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateRemarkRequestDto.prototype, "content", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateRemarkRequestDto.prototype, "category", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateRemarkRequestDto.prototype, "visibility", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], UpdateRemarkRequestDto.prototype, "attachmentPaths", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata("design:type", Number)
], UpdateRemarkRequestDto.prototype, "rating", void 0);
class UpdateAssayerDocumentRequestDto {
    documentType;
    fileName;
    filePath;
    fileSize;
    mimeType;
    remarks;
}
exports.UpdateAssayerDocumentRequestDto = UpdateAssayerDocumentRequestDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerDocumentRequestDto.prototype, "documentType", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerDocumentRequestDto.prototype, "fileName", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerDocumentRequestDto.prototype, "filePath", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata("design:type", Number)
], UpdateAssayerDocumentRequestDto.prototype, "fileSize", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerDocumentRequestDto.prototype, "mimeType", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateAssayerDocumentRequestDto.prototype, "remarks", void 0);
let AssayerController = class AssayerController {
    assayerService;
    constructor(assayerService) {
        this.assayerService = assayerService;
    }
    async create(dto, req) {
        const assayer = await this.assayerService.create(dto, req.user.id);
        return {
            success: true,
            data: assayer,
        };
    }
    async findAll(page = 1, limit = 20) {
        const { assayers, total } = await this.assayerService.findAll(page, limit);
        return {
            success: true,
            data: assayers,
            meta: {
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                    hasNext: page * limit < total,
                    hasPrevious: page > 1,
                },
            },
        };
    }
    async findOne(id) {
        const assayer = await this.assayerService.findOne(id);
        return {
            success: true,
            data: assayer,
        };
    }
    async getProfile(assayerId) {
        const assayer = await this.assayerService.getProfile(assayerId);
        return {
            success: true,
            data: assayer,
        };
    }
    async update(id, dto, req) {
        const assayer = await this.assayerService.update(id, dto, req.user.id);
        return {
            success: true,
            data: assayer,
        };
    }
    async remove(id, req) {
        await this.assayerService.remove(id, req.user.id);
    }
    async createCommercial(assayerId, dto, req) {
        const profile = await this.assayerService.createCommercialProfile(assayerId, dto, req.user.id);
        return {
            success: true,
            data: profile,
        };
    }
    async updateCommercial(id, dto, req) {
        const profile = await this.assayerService.updateCommercialProfile(id, dto, req.user.id);
        return {
            success: true,
            data: profile,
        };
    }
    async getCommercials(assayerId) {
        const profiles = await this.assayerService.getCommercialProfiles(assayerId);
        return {
            success: true,
            data: profiles,
        };
    }
    async getActiveCommercial(assayerId, dateStr) {
        const date = dateStr ? new Date(dateStr) : new Date();
        const profile = await this.assayerService.getActiveCommercialProfile(assayerId, date);
        return {
            success: true,
            data: profile,
        };
    }
    async addWorkforceAttribute(assayerId, dto, req) {
        const attr = await this.assayerService.addWorkforceAttribute(assayerId, dto, req.user.id);
        return {
            success: true,
            data: attr,
        };
    }
    async updateWorkforceAttribute(id, dto, req) {
        const attr = await this.assayerService.updateWorkforceAttribute(id, dto, req.user.id);
        return {
            success: true,
            data: attr,
        };
    }
    async removeWorkforceAttribute(id, req) {
        await this.assayerService.removeWorkforceAttribute(id, req.user.id);
        return {
            success: true,
            data: { message: 'Workforce attribute removed successfully' },
        };
    }
    async getWorkforceAttributes(assayerId, type) {
        const attrs = await this.assayerService.getWorkforceAttributes(assayerId, type);
        return {
            success: true,
            data: attrs,
        };
    }
    async transitionLifecycle(id, dto, req) {
        const assayer = await this.assayerService.transitionLifecycle(id, dto.targetStatus, req.user.id, dto.reason);
        return { success: true, data: assayer };
    }
    async addGovernmentDocument(assayerId, dto, req) {
        const doc = await this.assayerService.addGovernmentDocument(assayerId, dto, req.user.id);
        return { success: true, data: doc };
    }
    async updateGovernmentDocument(id, dto, req) {
        const doc = await this.assayerService.updateGovernmentDocument(id, dto, req.user.id);
        return { success: true, data: doc };
    }
    async getGovernmentDocuments(assayerId) {
        const docs = await this.assayerService.getGovernmentDocuments(assayerId);
        return { success: true, data: docs };
    }
    async removeGovernmentDocument(id, req) {
        await this.assayerService.removeGovernmentDocument(id, req.user.id);
    }
    async addAssayerDocument(assayerId, dto, req) {
        const doc = await this.assayerService.addAssayerDocument(assayerId, dto, req.user.id);
        return { success: true, data: doc };
    }
    async updateAssayerDocument(assayerId, docId, dto, req) {
        const doc = await this.assayerService.updateAssayerDocument(docId, dto, req.user.id);
        return { success: true, data: doc };
    }
    async getAssayerDocuments(assayerId) {
        const docs = await this.assayerService.getAssayerDocuments(assayerId);
        return { success: true, data: docs };
    }
    async removeAssayerDocument(id, req) {
        await this.assayerService.removeAssayerDocument(id, req.user.id);
    }
    async addRemark(assayerId, dto, req) {
        const remark = await this.assayerService.addRemark(assayerId, dto, req.user.id, req.user.name || req.user.email);
        return { success: true, data: remark };
    }
    async updateRemark(assayerId, remarkId, dto, req) {
        const remark = await this.assayerService.updateRemark(remarkId, dto, req.user.id);
        return { success: true, data: remark };
    }
    async removeRemark(assayerId, remarkId, req) {
        await this.assayerService.removeRemark(remarkId, req.user.id);
    }
    async getRemarks(assayerId, visibility, page = 1, limit = 20) {
        const { remarks, total } = await this.assayerService.getRemarks(assayerId, visibility, page, limit);
        return {
            success: true,
            data: remarks,
            meta: {
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                    hasNext: page * limit < total,
                    hasPrevious: page > 1,
                },
            },
        };
    }
    async getActivityTimeline(assayerId, page = 1, limit = 20) {
        const { activities, total } = await this.assayerService.getActivityTimeline(assayerId, page, limit);
        return {
            success: true,
            data: activities,
            meta: {
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                    hasNext: page * limit < total,
                    hasPrevious: page > 1,
                },
            },
        };
    }
};
exports.AssayerController = AssayerController;
__decorate([
    (0, common_1.Post)(),
    (0, common_1.HttpCode)(201),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, swagger_1.ApiOperation)({ summary: 'Register a new field assayer' }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [CreateAssayerRequestDto, Object]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'List all registered assayers' }),
    __param(0, (0, common_1.Query)('page')),
    __param(1, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)(':id'),
    (0, swagger_1.ApiOperation)({ summary: 'Get details for a single assayer by ID' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "findOne", null);
__decorate([
    (0, common_1.Get)(':assayerId/profile'),
    (0, swagger_1.ApiOperation)({ summary: 'Get detailed profile with stats for an assayer' }),
    __param(0, (0, common_1.Param)('assayerId', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "getProfile", null);
__decorate([
    (0, common_1.Put)(':id'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, swagger_1.ApiOperation)({ summary: 'Update assayer contact, banking, or operational details' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, UpdateAssayerRequestDto, Object]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, common_1.HttpCode)(204),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR),
    (0, swagger_1.ApiOperation)({ summary: 'Soft delete assayer profile' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "remove", null);
__decorate([
    (0, common_1.Post)(':assayerId/commercial'),
    (0, common_1.HttpCode)(201),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, swagger_1.ApiOperation)({ summary: 'Create a commercial profile for an assayer' }),
    __param(0, (0, common_1.Param)('assayerId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, CreateCommercialProfileRequestDto, Object]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "createCommercial", null);
__decorate([
    (0, common_1.Put)('commercial/:id'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, swagger_1.ApiOperation)({ summary: 'Update a commercial profile by ID' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, UpdateCommercialProfileRequestDto, Object]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "updateCommercial", null);
__decorate([
    (0, common_1.Get)(':assayerId/commercial'),
    (0, swagger_1.ApiOperation)({ summary: 'Get all commercial profiles for an assayer' }),
    __param(0, (0, common_1.Param)('assayerId', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "getCommercials", null);
__decorate([
    (0, common_1.Get)(':assayerId/commercial/active'),
    (0, swagger_1.ApiOperation)({ summary: 'Get currently active commercial profile for an assayer' }),
    __param(0, (0, common_1.Param)('assayerId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Query)('date')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "getActiveCommercial", null);
__decorate([
    (0, common_1.Post)(':assayerId/workforce-attribute'),
    (0, common_1.HttpCode)(201),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, swagger_1.ApiOperation)({ summary: 'Add a skill, certification, or language to an assayer profile' }),
    __param(0, (0, common_1.Param)('assayerId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, CreateWorkforceAttributeRequestDto, Object]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "addWorkforceAttribute", null);
__decorate([
    (0, common_1.Put)('workforce-attribute/:id'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, swagger_1.ApiOperation)({ summary: 'Update a workforce attribute by ID' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, UpdateWorkforceAttributeRequestDto, Object]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "updateWorkforceAttribute", null);
__decorate([
    (0, common_1.Delete)('workforce-attribute/:id'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR),
    (0, swagger_1.ApiOperation)({ summary: 'Remove a workforce attribute by ID' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "removeWorkforceAttribute", null);
__decorate([
    (0, common_1.Get)(':assayerId/workforce-attribute'),
    (0, swagger_1.ApiOperation)({ summary: 'Get workforce attributes for an assayer' }),
    __param(0, (0, common_1.Param)('assayerId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Query)('type')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "getWorkforceAttributes", null);
__decorate([
    (0, common_1.Post)(':id/lifecycle'),
    (0, common_1.HttpCode)(201),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, swagger_1.ApiOperation)({ summary: 'Transition assayer lifecycle status' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, TransitionLifecycleDto, Object]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "transitionLifecycle", null);
__decorate([
    (0, common_1.Post)(':assayerId/government-document'),
    (0, common_1.HttpCode)(201),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, swagger_1.ApiOperation)({ summary: 'Add a government document to an assayer' }),
    __param(0, (0, common_1.Param)('assayerId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, CreateGovernmentDocumentRequestDto, Object]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "addGovernmentDocument", null);
__decorate([
    (0, common_1.Put)('government-document/:id'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, swagger_1.ApiOperation)({ summary: 'Update a government document verification status' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, UpdateGovernmentDocumentRequestDto, Object]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "updateGovernmentDocument", null);
__decorate([
    (0, common_1.Get)(':assayerId/government-document'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, swagger_1.ApiOperation)({ summary: 'List government documents for an assayer' }),
    __param(0, (0, common_1.Param)('assayerId', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "getGovernmentDocuments", null);
__decorate([
    (0, common_1.Delete)('government-document/:id'),
    (0, common_1.HttpCode)(204),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR),
    (0, swagger_1.ApiOperation)({ summary: 'Soft delete a government document' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "removeGovernmentDocument", null);
__decorate([
    (0, common_1.Post)(':assayerId/document'),
    (0, common_1.HttpCode)(201),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, swagger_1.ApiOperation)({ summary: 'Upload a new versioned document for an assayer' }),
    __param(0, (0, common_1.Param)('assayerId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, CreateAssayerDocumentRequestDto, Object]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "addAssayerDocument", null);
__decorate([
    (0, common_1.Put)(':assayerId/document/:docId'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, swagger_1.ApiOperation)({ summary: 'Update document metadata' }),
    __param(0, (0, common_1.Param)('assayerId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Param)('docId', common_1.ParseUUIDPipe)),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, UpdateAssayerDocumentRequestDto, Object]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "updateAssayerDocument", null);
__decorate([
    (0, common_1.Get)(':assayerId/document'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, swagger_1.ApiOperation)({ summary: 'List documents for an assayer' }),
    __param(0, (0, common_1.Param)('assayerId', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "getAssayerDocuments", null);
__decorate([
    (0, common_1.Delete)('document/:id'),
    (0, common_1.HttpCode)(204),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR),
    (0, swagger_1.ApiOperation)({ summary: 'Soft delete an assayer document' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "removeAssayerDocument", null);
__decorate([
    (0, common_1.Post)(':assayerId/remark'),
    (0, common_1.HttpCode)(201),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, swagger_1.ApiOperation)({ summary: 'Add a remark to an assayer profile' }),
    __param(0, (0, common_1.Param)('assayerId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, CreateRemarkRequestDto, Object]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "addRemark", null);
__decorate([
    (0, common_1.Put)(':assayerId/remark/:remarkId'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, swagger_1.ApiOperation)({ summary: 'Update a remark' }),
    __param(0, (0, common_1.Param)('assayerId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Param)('remarkId', common_1.ParseUUIDPipe)),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, UpdateRemarkRequestDto, Object]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "updateRemark", null);
__decorate([
    (0, common_1.Delete)(':assayerId/remark/:remarkId'),
    (0, common_1.HttpCode)(204),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR),
    (0, swagger_1.ApiOperation)({ summary: 'Delete a remark' }),
    __param(0, (0, common_1.Param)('assayerId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Param)('remarkId', common_1.ParseUUIDPipe)),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "removeRemark", null);
__decorate([
    (0, common_1.Get)(':assayerId/remark'),
    (0, swagger_1.ApiOperation)({ summary: 'List remarks for an assayer' }),
    __param(0, (0, common_1.Param)('assayerId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Query)('visibility')),
    __param(2, (0, common_1.Query)('page')),
    __param(3, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "getRemarks", null);
__decorate([
    (0, common_1.Get)(':assayerId/activity'),
    (0, swagger_1.ApiOperation)({ summary: 'Get activity timeline for an assayer' }),
    __param(0, (0, common_1.Param)('assayerId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Query)('page')),
    __param(2, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], AssayerController.prototype, "getActivityTimeline", null);
exports.AssayerController = AssayerController = __decorate([
    (0, swagger_1.ApiTags)('Assayers'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.UseGuards)(guards_1.JwtAuthGuard, guards_1.RolesGuard),
    (0, common_1.Controller)('assayers'),
    __metadata("design:paramtypes", [assayer_service_1.AssayerService])
], AssayerController);
//# sourceMappingURL=assayer.controller.js.map