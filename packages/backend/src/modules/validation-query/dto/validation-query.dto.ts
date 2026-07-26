import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID, IsString, MinLength, IsOptional, IsInt, Min } from 'class-validator';

export class CreateValidationQueryDto {
  @ApiProperty({ description: 'ID of the validation case' })
  @IsUUID()
  validationCaseId: string;

  @ApiProperty({ description: 'ID of the target assayer' })
  @IsUUID()
  assayerId: string;

  @ApiProperty({ description: 'Clarification query text' })
  @IsString()
  @MinLength(5)
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
}

export class RespondValidationQueryDto {
  @ApiProperty({ description: 'Assayer response text' })
  @IsString()
  @MinLength(2)
  response: string;
}
