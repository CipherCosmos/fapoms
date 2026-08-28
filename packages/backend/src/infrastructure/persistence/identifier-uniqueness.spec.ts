import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

/**
 * Every identifier a person quotes has a database constraint behind it.
 *
 * Application code cannot make something unique. A check-then-insert is three statements with no
 * lock between them, so two callers read the same gap and both aim at it — the window is small,
 * which is exactly what makes it a bug that survives testing and appears in production. The only
 * thing that actually refuses the second write is a UNIQUE index.
 *
 * This is the list of identifiers that must never collide, checked against the entity that
 * declares them. Branches were the ones missing: `branch_code` and `sol_id` were indexed for
 * lookup and unique on neither, so re-uploading an edited branch sheet inserted a second branch
 * with the same SOL ID and everything downstream pointed at whichever it found. Added scoped per
 * client — a SOL ID is a bank's own branch number and says nothing about anybody else's.
 */
describe('business identifiers', () => {
  const ROOT = join(__dirname, '..', '..');
  const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

  /**
   * Entity file → the identifier columns on it that must be unique.
   *
   * `sol_id` and `branch_code` are scoped by client, so their guarantee is a partial unique index
   * in a migration rather than a decorator; they are asserted separately below.
   */
  const MUST_BE_UNIQUE: Record<string, string[]> = {
    'modules/project/project.entity.ts': ['projectNumber'],
    'modules/assignment/assignment.entity.ts': ['assignmentNumber'],
    'modules/assayer/assayer.entity.ts': ['assayerCode'],
    'modules/client/client.entity.ts': ['clientCode'],
    'modules/user/user.entity.ts': ['username', 'email'],
  };

  it.each(Object.entries(MUST_BE_UNIQUE))(
    '%s declares its identifier unique',
    (file, columns) => {
      const source = read(file);
      for (const column of columns) {
        // The property, and a `unique: true` inside the @Column decorator immediately above it.
        const declaration = new RegExp(
          `@Column\\(\\{[^}]*unique:\\s*true[^}]*\\}\\)[\\s\\S]{0,120}?\\b${column}\\b`,
        );
        const viaIndexDecorator = new RegExp(`@Index\\(\\[?'?${column}'?\\]?,\\s*\\{[^}]*unique:\\s*true`);
        expect(declaration.test(source) || viaIndexDecorator.test(source)).toBe(true);
      }
    },
  );

  /**
   * The client-scoped ones, and the project/branch link.
   *
   * Read from the migrations because that is where a partial unique index can be expressed —
   * TypeORM's `@Unique` cannot carry a WHERE clause, and blank is not a value: a branch with no
   * SOL ID has not collided with another branch that also has none.
   */
  it('protects branch codes, SOL IDs and project-branch links in a migration', () => {
    const migrations = execSync(
      `grep -rl "CREATE UNIQUE INDEX" "${join(ROOT, 'infrastructure/database/migrations')}" || true`,
      { encoding: 'utf8' },
    );
    const sql = migrations.trim().split('\n').filter(Boolean).map((f) => readFileSync(f, 'utf8')).join('\n');

    expect(sql).toMatch(/UQ_branches_client_branch_code[\s\S]*?"client_id",\s*"branch_code"/);
    expect(sql).toMatch(/UQ_branches_client_sol_id[\s\S]*?"client_id",\s*"sol_id"/);
    expect(sql).toMatch(/UQ_project_branches_pair[\s\S]*?"project_id",\s*"branch_id"/);
  });

  /**
   * A generator that reads-then-writes must handle losing the race, or the loser is shown an
   * error about a value they never chose and cannot change.
   */
  it.each([
    ['modules/project/project.service.ts', 'allocateProjectNumber'],
    ['modules/assayer/assayer.service.ts', 'allocateAssayerCode'],
  ])('%s retries when its allocated identifier is taken', (file, allocator) => {
    const source = read(file);
    expect(source).toContain(allocator);
    // 23505 is unique_violation. Catching it by name is what distinguishes "somebody beat me to
    // this number" from a real failure that must surface.
    expect(source).toContain("'23505'");
  });
});
