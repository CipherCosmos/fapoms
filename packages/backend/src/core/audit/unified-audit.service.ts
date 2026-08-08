import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * One chronological trail for one record, assembled from every place this system writes
 * history.
 *
 * The problem this solves is a compliance problem, not a convenience one. History is written
 * to four separate tables with four different schemas:
 *
 *   audit_events        general business events           (~1,586 rows)
 *   workflow_history    state-machine transitions         (~328)
 *   assayer_activities  workforce lifecycle and remarks   (~286)
 *   billing_history     money movement, with amounts      (~22)
 *
 * `GET /audit-log/entity` — the endpoint whose stated purpose is "audit history for one
 * entity" — reads only the first of those. So an auditor asking what happened to an
 * assignment got a confident, chronological, *incomplete* answer, with no indication that
 * three other trails existed. Silently partial evidence is worse than none: it looks
 * authoritative.
 *
 * The four are deliberately NOT merged into one table. Each carries columns the others cannot
 * (billing_history holds amounts and client/project attribution; workflow_history holds the
 * command and correlation id), and collapsing them would lose exactly the detail an audit
 * needs. They are unified at read time instead, into one shape, ordered by time.
 */

/** One event, whichever trail it came from. */
export interface UnifiedAuditEntry {
  /** Which underlying trail this row came from — kept so a finding can be traced to source. */
  source: 'audit_events' | 'workflow_history' | 'assayer_activities' | 'billing_history';
  occurredAt: string;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  previousState: string | null;
  newState: string | null;
  /** Whoever performed it, as an id. Display name where the source recorded one. */
  actorId: string | null;
  actorName: string | null;
  remarks: string | null;
  /** Source-specific extras (amounts, correlation ids) rather than a flattened subset. */
  metadata: Record<string, any> | null;
}

@Injectable()
export class UnifiedAuditService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Every recorded event for one entity, newest first.
   *
   * `entityId` is matched across all four trails. `entityType` narrows the general and billing
   * trails, which store one; the workflow and assayer trails are keyed by id alone.
   */
  async getTrail(
    entityId: string,
    entityType?: string,
    limit = 200,
  ): Promise<{ entries: UnifiedAuditEntry[]; countsBySource: Record<string, number> }> {
    // Parameterised throughout — entityType reaches the query as a bound value, never as
    // interpolated SQL.
    const [general, workflow, assayer, billing] = await Promise.all([
      this.dataSource.query(
        `SELECT event_type, entity_type, entity_id, previous_state, new_state,
                user_id, user_display_name, remarks, metadata, occurred_at
           FROM audit_events
          WHERE entity_id = $1 AND ($2::text IS NULL OR entity_type = $2)
          ORDER BY occurred_at DESC LIMIT $3`,
        [entityId, entityType ?? null, limit],
      ).catch(() => []),

      this.dataSource.query(
        `SELECT "workflowKey", "entityId", "previousState", "newState", command,
                "userId", "timestamp", "correlationId"
           FROM workflow_history
          WHERE "entityId" = $1
          ORDER BY "timestamp" DESC LIMIT $2`,
        [entityId, limit],
      ).catch(() => []),

      this.dataSource.query(
        `SELECT event_type, assayer_id, previous_state, new_state,
                performed_by, performed_by_name, remarks, metadata, occurred_at
           FROM assayer_activities
          WHERE assayer_id = $1 AND is_active = true
          ORDER BY occurred_at DESC LIMIT $2`,
        [entityId, limit],
      ).catch(() => []),

      this.dataSource.query(
        `SELECT entity_type, entity_id, action, from_state, to_state,
                previous_value, new_value, reason, user_name, created_by, created_at,
                client_id, project_id, assignment_id, assayer_id
           FROM billing_history
          WHERE entity_id = $1 OR assignment_id = $1 OR assayer_id = $1
          ORDER BY created_at DESC LIMIT $2`,
        [entityId, limit],
      ).catch(() => []),
    ]);

    const entries: UnifiedAuditEntry[] = [
      ...general.map((r: any) => ({
        source: 'audit_events' as const,
        occurredAt: r.occurred_at,
        eventType: r.event_type,
        entityType: r.entity_type ?? null,
        entityId: r.entity_id ?? null,
        previousState: r.previous_state ?? null,
        newState: r.new_state ?? null,
        actorId: r.user_id ?? null,
        actorName: r.user_display_name ?? null,
        remarks: r.remarks ?? null,
        metadata: r.metadata ?? null,
      })),

      ...workflow.map((r: any) => ({
        source: 'workflow_history' as const,
        occurredAt: r.timestamp,
        // The command is the meaningful label here; the workflow key alone says little.
        eventType: r.command ?? r.workflowKey,
        entityType: r.workflowKey ?? null,
        entityId: r.entityId ?? null,
        previousState: r.previousState ?? null,
        newState: r.newState ?? null,
        actorId: r.userId ?? null,
        actorName: null,
        remarks: null,
        metadata: r.correlationId ? { correlationId: r.correlationId } : null,
      })),

      ...assayer.map((r: any) => ({
        source: 'assayer_activities' as const,
        occurredAt: r.occurred_at,
        eventType: r.event_type,
        entityType: 'ASSAYER',
        entityId: r.assayer_id ?? null,
        previousState: r.previous_state ?? null,
        newState: r.new_state ?? null,
        actorId: r.performed_by ?? null,
        actorName: r.performed_by_name ?? null,
        remarks: r.remarks ?? null,
        metadata: r.metadata ?? null,
      })),

      ...billing.map((r: any) => ({
        source: 'billing_history' as const,
        occurredAt: r.created_at,
        eventType: r.action,
        entityType: r.entity_type ?? null,
        entityId: r.entity_id ?? null,
        previousState: r.from_state ?? null,
        newState: r.to_state ?? null,
        actorId: r.created_by ?? null,
        actorName: r.user_name ?? null,
        remarks: r.reason ?? null,
        // The money detail is the point of this trail, so it is carried rather than dropped.
        metadata: {
          previousValue: r.previous_value ?? null,
          newValue: r.new_value ?? null,
          clientId: r.client_id ?? null,
          projectId: r.project_id ?? null,
          assignmentId: r.assignment_id ?? null,
          assayerId: r.assayer_id ?? null,
        },
      })),
    ];

    entries.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());

    const countsBySource = entries.reduce<Record<string, number>>((acc, e) => {
      acc[e.source] = (acc[e.source] ?? 0) + 1;
      return acc;
    }, {});

    return { entries: entries.slice(0, limit), countsBySource };
  }
}
