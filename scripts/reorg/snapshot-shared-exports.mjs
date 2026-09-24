#!/usr/bin/env node
/**
 * G5 — the public API of `@fapoms/shared`, as a stable text snapshot.
 *
 * Every name the barrel exports, with its kind (value / type / enum member list), resolved by the
 * TypeScript checker so type-only exports — which vanish at runtime — are covered too. Moving a
 * file inside `packages/shared/src` must leave this unchanged; a lost or renamed export shows up.
 *
 *   node scripts/reorg/snapshot-shared-exports.mjs [--out FILE]
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = join(ROOT, 'packages', 'shared', 'src', 'index.ts');

const program = ts.createProgram([INDEX], {
  target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, strict: true, skipLibCheck: true, noEmit: true,
});
const checker = program.getTypeChecker();
const mod = checker.getSymbolAtLocation(program.getSourceFile(INDEX));
if (!mod) { console.error('could not resolve the shared barrel'); process.exit(1); }

const F = ts.SymbolFlags;
const lines = [];
for (const exp of checker.getExportsOfModule(mod)) {
  const sym = exp.flags & F.Alias ? checker.getAliasedSymbol(exp) : exp;
  const f = sym.flags;
  let kind;
  if (f & F.Enum) {
    const members = [...(sym.exports?.keys() ?? [])].map(String).sort();
    kind = `enum { ${members.join(', ')} }`;
  } else if (f & F.Class) kind = 'class';
  else if (f & F.Function) kind = 'function';
  else if (f & F.Variable) kind = 'const';
  else if (f & F.Interface) kind = 'interface';
  else if (f & F.TypeAlias) kind = 'type';
  else kind = `other(${f})`;
  lines.push(`${exp.getName()}: ${kind}`);
}
lines.sort();
const out = `# @fapoms/shared public exports — ${lines.length}\n\n${lines.join('\n')}\n`;
const i = process.argv.indexOf('--out');
if (i > 0) { writeFileSync(process.argv[i + 1], out); console.error(`wrote ${lines.length} exports to ${process.argv[i + 1]}`); }
else process.stdout.write(out);
