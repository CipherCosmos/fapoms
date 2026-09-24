#!/usr/bin/env node
/**
 * G4 — the web app's routes and who may open them, as a stable text snapshot.
 *
 * Three sections:
 *   1. Every <Route> in App.tsx: its path and the page component it renders (by the component's
 *      exported name, never its file path, so moving a page into a feature folder is no diff).
 *   2. Every redirect (<Navigate>, and the HR legacy-path table).
 *   3. The permission verdict: `canAccessRoute` evaluated for every built-in role, a custom role
 *      holding every permission, and a custom role holding none, on every path — plus each
 *      role's landing page from `defaultRouteFor`. This is the real function, executed, not
 *      re-implemented, so a moved or edited permission table shows up here.
 *
 *   node scripts/reorg/snapshot-web-routes.mjs [--out FILE]
 */
import { createRequire } from 'node:module';
import Module from 'node:module';
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'packages', 'frontend', 'src');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(spec|test)\./.test(name)) out.push(p);
  }
  return out;
}
const files = walk(SRC);
const findDefining = (re) => {
  const hit = files.find((f) => re.test(readFileSync(f, 'utf8')));
  if (!hit) throw new Error(`no file matches ${re}`);
  return hit;
};
const norm = (s) => s.replace(/\s+/g, ' ').trim();

// ── 1 + 2: routes and redirects from the router file ─────────────────────────────────────────
const APP = findDefining(/<Routes[\s>]/);
const appText = readFileSync(APP, 'utf8');
const app = ts.createSourceFile(APP, appText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

// lazy page name → the export it pulls (`m.Dashboard`) — the page's identity without its path.
const lazy = new Map();
app.forEachChild(function v(n) {
  if (ts.isVariableDeclaration(n) && n.initializer && /React\.lazy|\blazy\(/.test(n.initializer.getText())) {
    const m = n.initializer.getText().match(/default:\s*m\.(\w+)/) ?? n.initializer.getText().match(/import\(['"][^'"]*\/(\w+)['"]\)/);
    lazy.set(n.name.getText(), m ? m[1] : '?');
  }
  n.forEachChild(v);
});

const attr = (el, name) => {
  const a = el.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === name);
  if (!a || !a.initializer) return a ? 'true' : undefined;
  return ts.isStringLiteral(a.initializer) ? a.initializer.text : norm(a.initializer.getText());
};
const tagsIn = (text) => [...text.matchAll(/<([A-Z]\w*)/g)].map((m) => m[1]).filter((t) => t !== 'Navigate' && t !== 'Suspense');

const routes = [];
const redirects = [];
app.forEachChild(function v(n) {
  const el = ts.isJsxSelfClosingElement(n) ? n : ts.isJsxElement(n) ? n.openingElement : null;
  if (el) {
    const tag = el.tagName.getText();
    if (tag === 'Route') {
      const path = attr(el, 'path') ?? (attr(el, 'index') ? '(index)' : '(layout)');
      const element = attr(el, 'element') ?? '';
      const target = element.match(/<Navigate[^>]*to=\{?["'`]([^"'`]+)/);
      if (target) redirects.push(`${path}  →  ${target[1]}`);
      else routes.push(`${path}  ${tagsIn(element).map((t) => (lazy.has(t) ? `${t}[${lazy.get(t)}]` : t)).join(' > ') || '-'}`);
    }
  }
  n.forEachChild(v);
});

// HR legacy paths: the table App maps to redirects. Its values are references to another table,
// so the module is executed (see `load` below) rather than pattern-matched.
const legacyImport = appText.match(/LEGACY_PATHS[^;]*from\s+['"]([^'"]+)['"]/);
const legacyFile = legacyImport && [`${resolve(dirname(APP), legacyImport[1])}.ts`, `${resolve(dirname(APP), legacyImport[1])}.tsx`].find(existsSync);

// ── 3: permission verdicts, from the real functions ──────────────────────────────────────────
const PERMS = findDefining(/export function canAccessRoute\(/);
function load(file) {
  const js = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
  }).outputText;
  const m = new Module(file);
  m.filename = file;
  m.paths = Module._nodeModulePaths(dirname(file));
  m._compile(js, file);
  return m;
}
const mod = load(PERMS);
const { canAccessRoute, defaultRouteFor, ROUTE_PERMISSIONS } = mod.exports;
const { SystemRole } = mod.require('@fapoms/shared');
if (legacyFile) {
  for (const [from, to] of Object.entries(load(legacyFile).exports.LEGACY_PATHS)) redirects.push(`${from}  →  ${to}  (HR legacy)`);
}
// The `Object.entries(LEGACY_PATHS).map(...)` <Route> itself has a computed path; the table above
// is what it expands to, so its placeholder line is dropped from the route list.
for (let k = routes.length - 1; k >= 0; k--) if (routes[k].startsWith('from ')) routes.splice(k, 1);

const allPerms = [...new Set(ROUTE_PERMISSIONS.flatMap((r) => r.requiredPermissions ?? []))];
const principals = [
  ...Object.values(SystemRole).map((r) => [r, [r], []]),
  ['CUSTOM(all perms)', ['CUSTOM_ROLE'], allPerms],
  ['CUSTOM(no perms)', ['CUSTOM_ROLE'], []],
];
const concrete = (p) => p.replace(/:[A-Za-z]+/g, 'x');
const paths = [...new Set([
  ...routes.map((r) => r.split('  ')[0]).filter((p) => p.startsWith('/')),
  ...ROUTE_PERMISSIONS.map((r) => r.path),
].map(concrete))].sort();

const verdicts = paths.map((p) => {
  const ok = principals.filter(([, roles, perms]) => canAccessRoute(roles, perms, p)).map(([n]) => n);
  return `${p}  ${ok.length ? ok.join(', ') : '(nobody)'}`;
});
const landing = principals.map(([n, roles, perms]) => `${n}  →  ${defaultRouteFor(roles, perms)}`);

routes.sort(); redirects.sort();
const out = [
  `# Web routes — ${routes.length} routes, ${redirects.length} redirects, ${paths.length} paths × ${principals.length} principals`,
  '', '## Routes', ...routes, '', '## Redirects', ...redirects,
  '', '## Who may open each path', ...verdicts, '', '## Landing page per principal', ...landing, '',
].join('\n');
const i = process.argv.indexOf('--out');
if (i > 0) { writeFileSync(process.argv[i + 1], out); console.error(`wrote web-route snapshot to ${process.argv[i + 1]}`); }
else process.stdout.write(out);
