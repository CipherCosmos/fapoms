#!/usr/bin/env node
/**
 * G1 — the backend's HTTP surface, as a stable text snapshot.
 *
 * One line per endpoint: `METHOD /full/path  handler  | decorators…  | params…`, sorted by path.
 * Keyed by URL, never by file, so moving a controller to another folder produces no diff — while
 * dropping a guard, a role, a permission, a throttle or a DTO type does. That is the whole point:
 * the reorganization moves files and must not change who may call what.
 *
 * Static (TypeScript AST), so it needs no database, no Redis and no running app.
 *
 *   node scripts/reorg/snapshot-backend-routes.mjs            → prints the snapshot
 *   node scripts/reorg/snapshot-backend-routes.mjs --out FILE → writes it
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'packages', 'backend', 'src');

const HTTP = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'All', 'Options', 'Head']);
// Anything that is not an HTTP verb, a Swagger annotation or a validator is kept: guards, roles,
// permissions, throttles, interceptors, audit and scope markers all live here.
const IGNORE = /^(Api[A-Z]|Is[A-Z]|Min$|Max|Length|Matches|Type$|ValidateNested|Array|Transform|Expose|Exclude|ArrayM)/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p, out); }
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const norm = (s) => s.replace(/\s+/g, ' ').replace(/,\s*([\]})])/g, '$1').trim();

function decorators(node) {
  const ds = ts.canHaveDecorators?.(node) ? ts.getDecorators(node) ?? [] : node.decorators ?? [];
  return ds.map((d) => {
    const e = d.expression;
    if (ts.isCallExpression(e)) return { name: e.expression.getText(), args: e.arguments.map((a) => norm(a.getText())) };
    return { name: e.getText(), args: [] };
  });
}

function joinPath(...parts) {
  const segs = parts.flatMap((p) => String(p ?? '').split('/')).filter(Boolean);
  return '/' + segs.join('/');
}

const unquote = (s) => (s && /^['"`].*['"`]$/.test(s) ? s.slice(1, -1) : s);

function controllerPrefixes(dec) {
  if (!dec || dec.args.length === 0) return [''];
  const a = dec.args[0];
  if (a.startsWith('[')) return a.slice(1, -1).split(',').map((x) => unquote(x.trim()));
  if (a.startsWith('{')) { const m = a.match(/path:\s*(['"`][^'"`]*['"`]|\[[^\]]*\])/); return m ? controllerPrefixes({ args: [m[1]] }) : ['']; }
  return [unquote(a)];
}

const describe = (ds) => ds.filter((d) => !HTTP.has(d.name) && d.name !== 'Controller' && !IGNORE.test(d.name))
  .map((d) => (d.args.length ? `${d.name}(${d.args.join(', ')})` : d.name)).sort();

const lines = [];
for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8');
  if (!text.includes('@Controller')) continue;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  sf.forEachChild(function visit(node) {
    if (ts.isClassDeclaration(node)) {
      const cds = decorators(node);
      const ctrl = cds.find((d) => d.name === 'Controller');
      if (ctrl) {
        const classMarks = describe(cds);
        for (const m of node.members) {
          if (!ts.isMethodDeclaration(m)) continue;
          const mds = decorators(m);
          const verbs = mds.filter((d) => HTTP.has(d.name));
          if (!verbs.length) continue;
          const params = m.parameters.map((p) => {
            const pd = describe(decorators(p)).join(' ');
            const pdAll = decorators(p).map((d) => (d.args.length ? `${d.name}(${d.args.join(', ')})` : d.name)).join(' ');
            return `${pdAll || pd}:${p.type ? norm(p.type.getText()) : 'any'}`;
          }).filter((s) => !s.startsWith(':'));
          for (const prefix of controllerPrefixes(ctrl)) {
            for (const v of verbs) {
              const paths = v.args.length ? (v.args[0].startsWith('[') ? v.args[0].slice(1, -1).split(',').map((x) => unquote(x.trim())) : [unquote(v.args[0])]) : [''];
              for (const sub of paths) {
                lines.push(`${v.name.toUpperCase().padEnd(6)} ${joinPath('api/v1', prefix, sub)}  ${node.name?.text}.${m.name.getText()}`
                  + `\n    class:  ${classMarks.join('  ') || '-'}`
                  + `\n    method: ${describe(mds).join('  ') || '-'}`
                  + `\n    params: ${params.join('  ') || '-'}`);
              }
            }
          }
        }
      }
    }
    node.forEachChild(visit);
  });
}

lines.sort();
const out = `# Backend HTTP surface — ${lines.length} endpoints\n\n${lines.join('\n')}\n`;
const i = process.argv.indexOf('--out');
if (i > 0) { writeFileSync(process.argv[i + 1], out); console.error(`wrote ${lines.length} endpoints to ${process.argv[i + 1]}`); }
else process.stdout.write(out);
