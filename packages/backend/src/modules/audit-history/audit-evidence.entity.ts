import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('audit_evidence')
export class AuditEvidence {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  auditId: string;

  @Column()
  fileType: string;

  @Column()
  filePath: string;

  @Column('jsonb', { nullable: true })
  gpsCoordinates: { lat: number; lng: number };

  @Column('jsonb', { nullable: true })
  ocrResult: any;

  @CreateDateColumn()
  createdAt: Date;
}
