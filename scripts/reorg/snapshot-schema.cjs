#!/usr/bin/env node
/**
 * G3 — the database schema the backend's entities declare, as a stable text snapshot.
 *
 * Built from TypeORM's own metadata (the same globs the migration CLI uses), without a database:
 * every table with its columns (name, type, length/precision, nullability, default, primary,
 * generated), indices, uniques, checks and foreign keys. Keyed by table name, never by file, so
 * moving an entity to another folder is no diff — while a changed column, a lost index or a
 * dropped foreign key shows up. A relocation phase must leave this byte-identical.
 *
 *   node scripts/reorg/snapshot-schema.cjs [--out FILE]
 *
 * CommonJS on purpose: it registers ts-node to load the .entity.ts files, which is a CJS hook.
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const BACKEND = path.join(ROOT, 'packages', 'backend');
const req = (m) => require(require.resolve(m, { paths: [BACKEND] }));

req('reflect-metadata');
req('ts-node').register({
  transpileOnly: true,
  project: path.join(BACKEND, 'tsconfig.json'),
  compilerOptions: { module: 'commonjs' },
});
const { DataSource } = req('typeorm');

const val = (v) => {
  if (v === undefined || v === null) return String(v);
  if (typeof v === 'function') { try { return `fn:${v()}`; } catch { return 'fn'; } }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

(async () => {
  const ds = new DataSource({
    type: 'postgres',
    entities: [
      path.join(BACKEND, 'src/**/*.entity.ts'),
      path.join(BACKEND, 'src/modules/**/*.entities.ts'),
    ],
  });
  await ds.buildMetadatas(); // no connection is opened

  const tables = [];
  for (const m of ds.entityMetadatas) {
    const out = [`TABLE ${m.tablePath}${m.tableType !== 'regular' ? ` (${m.tableType})` : ''}`];
    const cols = m.columns.map((c) => {
      const t = typeof c.type === 'function' ? c.type.name.toLowerCase() : String(c.type);
      const size = [c.length && `len=${c.length}`, c.precision != null && `p=${c.precision}`, c.scale != null && `s=${c.scale}`]
        .filter(Boolean).join(',');
      const flags = [
        c.isPrimary && 'PK', c.isNullable ? 'null' : 'not-null', c.isGenerated && `gen:${c.generationStrategy}`,
        c.isArray && 'array', c.enum && `enum[${c.enum.join('|')}]${c.enumName ? `:${c.enumName}` : ''}`,
        c.default !== undefined && `default=${val(c.default)}`, c.isCreateDate && 'createDate',
        c.isUpdateDate && 'updateDate', c.isDeleteDate && 'deleteDate', c.isVersion && 'version',
        c.spatialFeatureType && `spatial=${c.spatialFeatureType}`, c.srid && `srid=${c.srid}`,
        c.asExpression && `as=${c.asExpression}`,
      ].filter(Boolean).join(' ');
      return `  col ${c.databaseName}: ${t}${size ? `(${size})` : ''} ${flags}`;
    }).sort();
    const idx = m.indices.map((i) => `  index ${i.name ?? '(unnamed)'}${i.isUnique ? ' UNIQUE' : ''}${i.isSpatial ? ' SPATIAL' : ''} (${i.columns.map((c) => c.databaseName).join(', ')})${i.where ? ` WHERE ${i.where}` : ''}`).sort();
    const uq = m.uniques.map((u) => `  unique ${u.name ?? '(unnamed)'} (${u.columns.map((c) => c.databaseName).join(', ')})`).sort();
    const ck = m.checks.map((c) => `  check ${c.name ?? '(unnamed)'} ${c.expression}`).sort();
    const fk = m.foreignKeys.map((f) => `  fk ${f.name ?? '(unnamed)'} (${f.columnNames.join(', ')}) -> ${f.referencedTablePath}(${f.referencedColumnNames.join(', ')}) onDelete=${f.onDelete} onUpdate=${f.onUpdate}`).sort();
    tables.push([...out, ...cols, ...idx, ...uq, ...ck, ...fk].join('\n'));
  }
  tables.sort();
  const text = `# Entity schema — ${tables.length} tables\n\n${tables.join('\n\n')}\n`;
  const i = process.argv.indexOf('--out');
  if (i > 0) { fs.writeFileSync(process.argv[i + 1], text); console.error(`wrote ${tables.length} tables`); }
  else process.stdout.write(text);
})().catch((e) => { console.error(e); process.exit(1); });
