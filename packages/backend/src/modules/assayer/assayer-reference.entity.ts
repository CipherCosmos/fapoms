import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { AssayerEntity } from './assayer.entity';

/**
 * A person who vouched for an assayer when they joined.
 *
 * The roster keeps two, as four columns — "Refference 1 Name", "Contact", "Refference 2 Name",
 * "Contact" — which is a repeating group written sideways. Two is not a rule anybody chose; it
 * is how many fitted. As rows a third costs nothing, each can carry when it was actually
 * checked, and "who has an unchecked reference" becomes a query rather than a read-through.
 */
@Entity('assayer_references')
@Index(['assayerId'])
export class AssayerReferenceEntity extends BaseEntity {
  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assayer_id' })
  assayer: AssayerEntity;

  @Column({ name: 'full_name', type: 'varchar', length: 200 })
  fullName: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string | null;

  /** What they are to the assayer — former employer, colleague — when the roster says. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  relationship: string | null;

  /**
   * When somebody actually spoke to them.
   *
   * Separate from having the name: the roster's "Refference Check" column says the check was
   * done, but not for which of the two, and not when. Null means recorded but not yet verified.
   */
  @Column({ name: 'checked_at', type: 'timestamptz', nullable: true })
  checkedAt: Date | null;

  @Column({ name: 'checked_by', type: 'uuid', nullable: true })
  checkedBy: string | null;

  @Column({ type: 'text', nullable: true })
  remarks: string | null;
}
