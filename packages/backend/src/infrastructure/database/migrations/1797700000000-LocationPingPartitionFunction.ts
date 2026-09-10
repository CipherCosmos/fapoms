import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * THE ONE PIECE OF DDL THE RUNNING APPLICATION NEEDS, HANDED OVER WITHOUT THE PRIVILEGE.
 *
 * `assayer_location_pings` is partitioned by month. `RetentionService` runs hourly in the API
 * process and creates next month's partition (`CREATE TABLE … PARTITION OF`) and drops expired
 * ones (`DROP TABLE`). Both are schema changes, made by the running process.
 *
 * That is exactly the privilege the runtime role is losing (see
 * `infrastructure/database/roles/role-model.ts`): a runtime identity that may alter schema objects
 * can alter the audit tables' triggers, and the audit boundary is then only as strong as the
 * application credential. But a missing partition is not a slow query — it is an INSERT failing at
 * the moment an assayer is recording a fix — so the maintenance cannot simply stop.
 *
 * So the runtime borrows the privilege through one function instead of holding it. `SECURITY
 * DEFINER` runs the body as the function's owner (the migration role), and the body accepts only
 * a name matching `assayer_location_pings_yYYYYmMM` and only ever attaches it to that one parent.
 * The runtime therefore gains "manage one month of location pings" and nothing else — it cannot
 * name `audit_events`, cannot create a table that is not a partition of this one, and cannot drop
 * anything the pattern does not match.
 *
 * ## The two things that make a SECURITY DEFINER function safe
 *
 *  - `SET search_path = pg_catalog, pg_temp`. Without it, a caller can put a schema of their own
 *    ahead of `public` and have the body resolve `format()` or an operator to a function they
 *    wrote, which then runs as the owner. Every object the body touches is therefore schema
 *    qualified or a keyword.
 *  - `REVOKE ALL … FROM PUBLIC` before the grant. `CREATE FUNCTION` grants EXECUTE to PUBLIC by
 *    default, which on a `SECURITY DEFINER` function means every role in the cluster.
 *
 * ## Why the name is validated rather than the arguments being an enum
 *
 * The partition name is computed by `location-ping-partitions.ts` from a date, so it is never
 * caller-controlled in practice. The check is here because "in practice" is not a property of the
 * database: this function is reachable by anything holding the runtime credential, and its whole
 * purpose is to be the narrow place where that credential's DDL stops.
 */
export class LocationPingPartitionFunction1797700000000 implements MigrationInterface {
  name = 'LocationPingPartitionFunction1797700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE OR REPLACE FUNCTION fapoms_manage_location_ping_partition(
        op text,
        partition_name text,
        range_from timestamptz DEFAULT NULL,
        range_to timestamptz DEFAULT NULL
      ) RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      BEGIN
        IF partition_name !~ '^assayer_location_pings_y[0-9]{4}m[0-9]{2}$' THEN
          RAISE EXCEPTION 'not a location-ping partition name: %', partition_name
            USING ERRCODE = 'invalid_parameter_value';
        END IF;

        IF op = 'create' THEN
          IF range_from IS NULL OR range_to IS NULL OR range_to <= range_from THEN
            RAISE EXCEPTION 'a partition needs a half-open range, got % .. %', range_from, range_to
              USING ERRCODE = 'invalid_parameter_value';
          END IF;
          EXECUTE pg_catalog.format(
            'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.assayer_location_pings FOR VALUES FROM (%L) TO (%L)',
            partition_name, range_from, range_to
          );

        ELSIF op = 'drop' THEN
          -- Only a real, attached partition of that one parent. A table that merely matches the
          -- name pattern but hangs off something else is not this function's to remove.
          IF NOT EXISTS (
            SELECT 1
              FROM pg_catalog.pg_inherits i
              JOIN pg_catalog.pg_class child ON child.oid = i.inhrelid
              JOIN pg_catalog.pg_class parent ON parent.oid = i.inhparent
              JOIN pg_catalog.pg_namespace n ON n.oid = child.relnamespace
             WHERE child.relname = partition_name
               AND parent.relname = 'assayer_location_pings'
               AND n.nspname = 'public'
          ) THEN
            RETURN; -- already gone, or never ours: the caller's loop treats this as done
          END IF;
          EXECUTE pg_catalog.format('DROP TABLE IF EXISTS public.%I', partition_name);

        ELSE
          RAISE EXCEPTION 'unknown operation: %', op USING ERRCODE = 'invalid_parameter_value';
        END IF;
      END;
      $fn$;
    `);

    // CREATE FUNCTION grants EXECUTE to PUBLIC. On a SECURITY DEFINER function that is every role
    // in the cluster running this body as the owner, which is not a default to leave standing.
    await q.query(`REVOKE ALL ON FUNCTION fapoms_manage_location_ping_partition(text, text, timestamptz, timestamptz) FROM PUBLIC`);

    // The runtime role may not exist yet — a database provisioned before the role split, or a
    // developer's own machine running as a single user. The grant is then made by the harden
    // step instead, which runs after every migration.
    await q.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fapoms_runtime') THEN
          EXECUTE 'GRANT EXECUTE ON FUNCTION fapoms_manage_location_ping_partition(text, text, timestamptz, timestamptz) TO fapoms_runtime';
        END IF;
      END $$;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP FUNCTION IF EXISTS fapoms_manage_location_ping_partition(text, text, timestamptz, timestamptz)`);
  }
}
