import type { DataSource } from 'typeorm';
import type { StorageEngine } from '../storage/storage-engine.interface';

/**
 * WHAT IS IN THE BUCKET THAT NOTHING POINTS AT.
 *
 * An upload that failed half way, a document row deleted without its file, a candidate erased while
 * storage was unreachable — each leaves an object nobody can see and nobody deletes. A storage
 * audit found 90 of them, every one a readable identity document with no screen and no retention
 * rule attached to it.
 *
 * ## Why this reports rather than deletes
 *
 * Answering "is this object referenced?" means knowing EVERY column that can hold a storage key.
 * Miss one, and the sweep deletes live documents — an irreversible mistake made silently, at
 * machine speed, against exactly the files that matter most. So this returns a list and a count,
 * and deleting is a separate, deliberate act (`delete-orphan-objects.ts`) taken by a person who has
 * read the report.
 *
 * ## Why the list below cannot be trusted on its own
 *
 * A registry of columns is a rule written down as the instances that existed the day it was
 * written — the failure mode this codebase has been bitten by before. `orphan-objects.spec.ts`
 * therefore re-derives the candidate columns from the entity sources and fails if one appears that
 * is neither listed here nor explicitly excluded.
 */

export interface StorageKeySource {
  table: string;
  column: string;
  /**
   * `jsonb-array` — a jsonb array of key strings.
   * `jsonb-objects` — a jsonb array of objects, each carrying the key in `keyField`.
   * `text` — a single key in a text column.
   */
  kind: 'jsonb-array' | 'jsonb-objects' | 'text';
  /** For `jsonb-objects`: which property of each element holds the key. */
  keyField?: string;
  why: string;
}

/** Every column in the database that can hold a key into object storage. */
export const STORAGE_KEY_SOURCES: readonly StorageKeySource[] = [
  { table: 'assayer_documents', column: 'file_paths', kind: 'jsonb-array', why: "A roster member's identity and qualification scans." },
  { table: 'assayer_application_documents', column: 'file_paths', kind: 'jsonb-array', why: "A candidate's scans, before they are on the roster." },
  { table: 'assayer_document_versions', column: 'file_path', kind: 'text', why: 'Superseded versions of a scan, kept for the audit trail.' },
  { table: 'assayer_interviews', column: 'attachments', kind: 'jsonb-objects', keyField: 'storageKey', why: 'The test papers an interview decision rested on — kept with it for good.' },
  { table: 'assayer_background_checks', column: 'report_files', kind: 'jsonb-objects', keyField: 'path', why: 'The report each background check was read from — kept with the check for good.' },
  { table: 'assayers', column: 'photograph', kind: 'text', why: 'The photograph on the identity card.' },
  { table: 'branch_documents', column: 'file_path', kind: 'text', why: 'Branch paperwork.' },
  { table: 'customer_master_versions', column: 'file_path', kind: 'text', why: 'Uploaded customer master sheets.' },
  { table: 'documents', column: 'file_path', kind: 'text', why: 'The general document store (assignment evidence, reports).' },
  /*
    The three below were found by this file's own guard spec, not by reading the schema: all three
    hold live attachments, and a sweep built on the hand-written list above would have called every
    one of them an orphan. They are the reason the guard exists.
  */
  { table: 'assayer_remarks', column: 'attachment_paths', kind: 'jsonb-array', why: 'Evidence attached to a remark about somebody.' },
  { table: 'feedback_messages', column: 'attachments', kind: 'jsonb-objects', keyField: 'storageKey', why: 'Screenshots and files on a feedback thread.' },
  { table: 'validation_query_messages', column: 'attachments', kind: 'jsonb-objects', keyField: 's3Key', why: 'Files exchanged on a validation query.' },
  { table: 'background_jobs', column: 'input_object_key', kind: 'text', why: 'The file a background job (an import) was uploaded with — kept 30 days, then retention deletes it.' },
  { table: 'background_jobs', column: 'result_object_key', kind: 'text', why: "A background job's downloadable report — kept 30 days with its job." },
  { table: 'background_jobs', column: 'input_objects', kind: 'jsonb-objects', keyField: 'key', why: 'The files of a several-file background job (a batch of audit packets) — kept 30 days, then retention deletes them.' },
];

/**
 * Columns that LOOK like storage keys and are not, with the reason. Anything matching the guard's
 * heuristic must appear here or in `STORAGE_KEY_SOURCES`, so a new one cannot be added silently.
 */
export const NOT_STORAGE_KEYS: ReadonlyArray<{ table: string; column: string; why: string }> = [
  { table: 'assayer_document_versions', column: 'storage_object_id', why: 'The id of the version row, not a key into the bucket.' },
  { table: 'assayer_document_versions', column: 'uploaded_by', why: 'The user who uploaded it — a person, not a place.' },
  { table: 'assayer_document_versions', column: 'document_id', why: 'A foreign key to assayer_documents.' },
  { table: 'assayer_document_versions', column: 'file_checksum', why: 'A hash of the contents.' },
  { table: 'assayer_document_versions', column: 'file_size', why: 'A byte count.' },
  { table: 'assayer_documents', column: 'document_number', why: 'The number printed ON the document (a PAN, a licence number).' },
  { table: 'assayer_documents', column: 'reupload_note', why: "HR's sentence asking for the document again — text, not a key." },
  { table: 'assayer_client_empanelments', column: 'documents_outstanding', why: 'A list of document TYPES still to be collected.' },
  { table: 'assayers', column: 'documents_link', why: 'A link to an external folder, not an object in our bucket.' },
  { table: 'branch_documents', column: 'file_name', why: 'The name the uploader gave it.' },
  { table: 'branch_documents', column: 'file_size', why: 'A byte count.' },
  { table: 'client_contracts', column: 'document_url', why: 'An external URL, not a key.' },
  { table: 'customer_master_versions', column: 'file_name', why: 'The name the uploader gave it.' },
  { table: 'documents', column: 'file_name', why: 'The name the uploader gave it.' },
  { table: 'documents', column: 'file_size', why: 'A byte count.' },
  { table: 'ocr_jobs', column: 'document_id', why: 'A foreign key to documents.' },
  { table: 'validation_queries', column: 'document_id', why: 'A foreign key to documents.' },
  { table: 'notifications', column: 'dedupe_key', why: 'A de-duplication key for notifications.' },
  { table: 'notifications', column: 'group_key', why: 'A grouping key for notifications.' },
  { table: 'assayer_applications', column: 'extended_profile', why: "The candidate's typed answers; their scans live in assayer_application_documents." },
  { table: 'background_jobs', column: 'input_file_name', why: 'The name the uploader gave the file.' },
  { table: 'background_jobs', column: 'input_mime_type', why: 'The declared type of the uploaded file.' },
  { table: 'background_jobs', column: 'result_file_name', why: 'The name the report is downloaded as.' },
  { table: 'background_jobs', column: 'result_mime_type', why: 'The type the report is downloaded as.' },
  { table: 'background_jobs', column: 'runner_queue', why: 'The name of the Bull queue that runs a tracked job.' },
];

export interface OrphanReport {
  /** Objects in the bucket, in total. */
  scanned: number;
  /** Objects no row points at, and old enough that no upload can still be in flight. */
  orphans: Array<{ key: string; lastModified: Date | null; size: number }>;
  /** Objects unreferenced but too recent to judge — an upload may be mid-flight. */
  tooRecent: number;
  /** Keys the database holds, for the arithmetic in the report. */
  referenced: number;
}

/** Every key any row points at. Held in memory on purpose: the comparison needs the whole set. */
export async function referencedKeys(dataSource: DataSource): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const source of STORAGE_KEY_SOURCES) {
    /*
      `jsonb_typeof(...) = 'array'` on the jsonb sources is not defensive noise: one row holding an
      object where an array was expected makes `jsonb_array_elements` throw, which would take out
      the whole reference set and turn every live document into an "orphan".
    */
    const sql = source.kind === 'jsonb-array'
      ? `SELECT jsonb_array_elements_text("${source.column}") AS k FROM "${source.table}"
           WHERE "${source.column}" IS NOT NULL AND jsonb_typeof("${source.column}") = 'array'`
      : source.kind === 'jsonb-objects'
        ? `SELECT jsonb_array_elements("${source.column}") ->> '${source.keyField}' AS k FROM "${source.table}"
             WHERE "${source.column}" IS NOT NULL AND jsonb_typeof("${source.column}") = 'array'`
        : `SELECT "${source.column}" AS k FROM "${source.table}" WHERE "${source.column}" IS NOT NULL AND "${source.column}" <> ''`;
    let rows: Array<{ k: string | null }>;
    try {
      rows = await dataSource.query(sql);
    } catch (error) {
      /*
        A table this deployment does not have is not a reason to report every object as an orphan.
        Refusing loudly is the only safe answer: the caller must not treat a partial reference set
        as a complete one.
      */
      throw new Error(
        `Could not read ${source.table}.${source.column}, so the reference set is incomplete and no `
        + `object can safely be called an orphan: ${(error as Error).message}`,
      );
    }
    for (const row of rows) if (row.k) keys.add(row.k);
  }
  return keys;
}

/**
 * Compare the bucket against the database.
 *
 * `graceMs` keeps very recent objects out of the answer: an upload that has written its object but
 * not yet its row is indistinguishable from an orphan, and the difference between them is a few
 * seconds of clock.
 */
export async function findOrphanObjects(
  dataSource: DataSource,
  storage: StorageEngine,
  graceMs = 7 * 24 * 60 * 60 * 1000,
  now: number = Date.now(),
): Promise<OrphanReport> {
  if (typeof storage.listObjects !== 'function') {
    throw new Error('This storage driver cannot enumerate objects, so orphans cannot be found.');
  }
  const referenced = await referencedKeys(dataSource);
  const report: OrphanReport = { scanned: 0, orphans: [], tooRecent: 0, referenced: referenced.size };

  let cursor: string | undefined;
  do {
    const page = await storage.listObjects(cursor);
    for (const object of page.objects) {
      report.scanned++;
      if (referenced.has(object.key)) continue;
      const age = object.lastModified ? now - object.lastModified.getTime() : Infinity;
      if (age < graceMs) { report.tooRecent++; continue; }
      report.orphans.push(object);
    }
    cursor = page.cursor ?? undefined;
  } while (cursor);

  return report;
}
