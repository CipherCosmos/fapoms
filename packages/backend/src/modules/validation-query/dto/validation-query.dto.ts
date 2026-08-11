import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID, IsString, MinLength, IsOptional, IsInt, Min, IsArray } from 'class-validator';

export class CreateValidationQueryDto {
  @ApiProperty({ description: 'ID of the validation case' })
  @IsUUID()
  validationCaseId: string;

  @ApiPropertyOptional({ description: 'ID of the target assayer' })
  @IsUUID()
  @IsOptional()
  assayerId?: string;

  @ApiProperty({ description: 'Clarification query text' })
  @IsString()
  @MinLength(1)
  queryText: string;

  @ApiPropertyOptional({ description: 'Target field name in document' })
  @IsOptional()
  @IsString()
  targetField?: string;

  @ApiPropertyOptional({ description: 'SLA turnaround hours (default: 4)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  slaHours?: number;

  @ApiPropertyOptional({ description: 'Array of attachment references (lightweight URLs)' })
  @IsOptional()
  @IsArray()
  attachments?: any[];
}

export class RespondValidationQueryDto {
  @ApiPropertyOptional({ description: 'Response text (message)' })
  @IsOptional()
  @IsString()
  response?: string;

  @ApiPropertyOptional({ description: 'Array of attachment references (lightweight URLs)' })
  @IsOptional()
  @IsArray()
  attachments?: any[];
}
