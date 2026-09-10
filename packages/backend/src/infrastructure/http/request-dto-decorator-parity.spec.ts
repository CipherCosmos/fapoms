import 'reflect-metadata';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join, relative, sep } from 'path';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import * as classValidator from 'class-validator';
import { AssignmentController } from '../../modules/assignment/assignment.controller';
import { OcrBoundaryController } from '../ocr/ocr-boundary.controller';

/**
 * Every property a request DTO declares must carry a validator, or the whole endpoint is dead.
 *
 * The global pipe (main.ts) runs `whitelist: true, forbidNonWhitelisted: true`. `whitelist`
 * strips properties class-validator holds no metadata for; `forbidNonWhitelisted` turns that
 * strip into a 400 instead. Which properties get checked is decided from the *instance*, not
 * from the request: `tsconfig` targets ES2022, so TypeScript emits every declared field as a
 * real class field, and `new SomeRequestDto()` — which class-transformer calls on every
 * request — already owns each declared key with the value `undefined`. A field the caller never
 * sent is therefore still present, and a field with no decorator is still non-whitelisted.
 *
 * So one missing decorator does not weaken one field. It refuses every request to that route,
 * with a message naming a property the caller did not send:
 *
 *   - `CreateAssignmentRequestDto.clientRequestId` (assignment.controller.ts) had none, and
 *     `POST /assignments` answered `400 property clientRequestId should not exist` to every
 *     caller. The system could not create an assignment at all — the central act of the product.
 *   - `ReceiveOcrResultsDto` (ocr-boundary.controller.ts) declared two properties and imported
 *     nothing from class-validator, so BOTH of its keys were non-whitelisted and the OCR
 *     engine's callback was answered `400 property externalJobId should not exist, property
 *     ocrPayload should not exist` — the two fields it had just sent. No scan had ever reached a
 *     reviewer through that route. (Nest sets `forbidUnknownValues: false` on the pipe, so
 *     class-validator's own guard against a target it holds no metadata for never fired.)
 *
 * Both were found by reading source, not by a failing test, because there is no failing test to
 * find: the DTO compiles, the route registers, Swagger documents it, and every unit test of the
 * service underneath it passes. The only signal is a 400 in production naming a field nobody
 * typed. A per-DTO test would pin the two known ones and say nothing about the next one, so this
 * walks every class reachable from a `@Body()` or `@Query()` parameter — 140-odd of them — and
 * fails on any declared property with no validator on it.
 *
 * Deliberately NOT policed here, so the green tick is not read as more than it is: a `@Body()`
 * typed by an *interface* or an inline object literal. Those are erased at compile time, the
 * metatype Nest sees is `Object`, and `ValidationPipe` skips them entirely — the opposite
 * failure, in which nothing is checked and everything is accepted. `compliance.controller.ts`
 * has four such routes and eleven inline-object bodies exist elsewhere. Closing that would turn
 * `forbidNonWhitelisted` on for routes that have never had it, which is a behaviour change for
 * their callers and belongs in its own change, not smuggled into this guard.
 */
describe('request DTOs and the decorators the global pipe whitelists against', () => {
  const SRC = join(__dirname, '..', '..');

  /** Comments hold example DTO snippets and `@Body()` prose; strip them before any matching. */
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  const sources = (() => {
    const out: Array<{ file: string; text: string }> = [];
    (function walk(dir: string) {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          // `_historical` is retired code kept for reference; it binds no live route.
          if (e.name !== '_historical' && e.name !== 'node_modules') walk(p);
        } else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') && !e.name.endsWith('.d.ts')) {
          out.push({ file: relative(SRC, p), text: strip(readFileSync(p, 'utf8')) });
        }
      }
    })(SRC);
    return out;
  })();

  /** Walk balanced brackets from `from` (which must sit on an opener) to its match. */
  const matchAt = (text: string, from: number, open: string, close: string): number => {
    let depth = 0;
    for (let i = from; i < text.length; i++) {
      if (text[i] === open) depth++;
      else if (text[i] === close && --depth === 0) return i;
    }
    return -1;
  };

  type ClassDecl = { name: string; file: string; heritage: string; body: string };

  /** Every class declared anywhere in the backend, by name, with its body text. */
  const declaredClasses = (() => {
    const byName = new Map<string, ClassDecl>();
    for (const { file, text } of sources) {
      const re = /(?:^|\n)\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)([^{]*)\{/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const open = text.indexOf('{', m.index + m[0].length - 1);
        const end = matchAt(text, open, '{', '}');
        if (end < 0) continue;
        if (!byName.has(m[1])) {
          byName.set(m[1], { name: m[1], file, heritage: (m[2] ?? '').trim(), body: text.slice(open + 1, end) });
        }
      }
    }
    return byName;
  })();

  /**
   * Type names bound to a `@Body()` / `@Query()` parameter.
   *
   * `@Query('status') status?: ExpenseStatus` is in here too and is harmless: it resolves to an
   * enum rather than a class, and only names that resolve to a declared class are followed. A
   * bare `@Query() q: SomeQueryDto` binds and validates the WHOLE query string, which is exactly
   * as fatal as a body — billing-engine.controller.ts carries the note from the time
   * `?status=PENDING` became "property status should not exist" for that reason.
   */
  const boundTypes = (() => {
    const found: Array<{ type: string; file: string }> = [];
    for (const { file, text } of sources) {
      const re = /@(?:Body|Query)\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const closed = matchAt(text, re.lastIndex - 1, '(', ')');
        if (closed < 0) continue;
        const rest = text.slice(closed + 1, closed + 300);
        // `name: ` / `name?: ` — then the type. An inline `{ ... }` literal is erased, so skip it.
        const decl = /^\s*(?:readonly\s+)?[A-Za-z_$][\w$]*\s*[?!]?\s*:\s*/.exec(rest);
        if (!decl) continue;
        const type = /^([A-Za-z_$][\w$]*)/.exec(rest.slice(decl[0].length));
        if (type) found.push({ type: type[1], file });
      }
    }
    return found;
  })();

  /** Split a class body into members on the `;` that ends each one, ignoring nested brackets. */
  const membersOf = (body: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') depth--;
      else if (c === ';' && depth === 0) { out.push(body.slice(start, i)); start = i + 1; }
    }
    out.push(body.slice(start));
    return out.map((s) => s.trim()).filter(Boolean);
  };

  /** Peel `@Name` / `@Name(...)` off the front of a member, returning them and what is left. */
  const splitDecorators = (member: string): { decorators: string[]; declaration: string } => {
    const decorators: string[] = [];
    let rest = member;
    for (;;) {
      const at = /^@([A-Za-z_$][\w$]*)\s*(\()?/.exec(rest);
      if (!at) break;
      decorators.push(at[1]);
      if (!at[2]) { rest = rest.slice(at[0].length).trim(); continue; }
      const closed = matchAt(rest, at[0].length - 1, '(', ')');
      if (closed < 0) break;
      rest = rest.slice(closed + 1).trim();
    }
    return { decorators, declaration: rest };
  };

  const byFile = new Map(sources.map((s) => [s.file, s.text]));

  /**
   * The declaration statement for a top-level `const` / `let` / `function` named `name`.
   *
   * Ends at the `;` that closes the declarator, or — for a `function` — at the `}` that closes
   * its body, tracking bracket depth so an initialiser containing either character does not end
   * the statement early. The text is what tells the rules below whether the declaration reaches
   * `ValidateBy` itself, or reaches it through something else.
   */
  const declarationOf = (text: string, name: string): string | null => {
    const at = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(const|let|function)\\s+${name}\\b`).exec(text);
    if (!at) return null;
    const isFn = at[1] === 'function';
    const start = at.index;
    let depth = 0;
    let opened = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (c === '(' || c === '[' || c === '{') { depth++; opened = true; }
      else if (c === ')' || c === ']' || c === '}') {
        depth--;
        if (isFn && opened && depth === 0 && c === '}') return text.slice(start, i + 1);
      } else if (c === ';' && depth === 0) return text.slice(start, i);
    }
    return text.slice(start);
  };

  /** The repo-local module and original name a file imported `local` from, if it did. */
  const importOriginOf = (file: string, local: string): { file: string; name: string } | null => {
    const text = byFile.get(file);
    if (text === undefined) return null;
    const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const spec = m[2];
      if (!spec.startsWith('.')) continue; // a package, not this repo — nothing to read
      const bound = m[1]
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const aliased = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(part);
          return aliased ? { name: aliased[1], as: aliased[2] } : { name: part, as: part };
        })
        .find((b) => b.as === local);
      if (!bound) continue;
      const base = join(dirname(file), spec).split(sep).join('/');
      for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
        if (byFile.has(candidate)) return { file: candidate, name: bound.name };
      }
      return null;
    }
    return null;
  };

  /**
   * Whether `name`, as it is bound in `file`, reaches a `ValidateBy` call.
   *
   * `ValidateBy` is the only thing in class-validator that registers metadata under a name of
   * the repo's own choosing, so "reaches ValidateBy" is the whole of what makes a repo-local
   * decorator real to the pipe. A name reaches it when its own declaration calls it, or when its
   * initialiser calls — or is a bare alias of — another name that does, in this file or in a
   * repo-local module it was imported from.
   *
   * The indirection is not hypothetical. `IsPanFormat` is `identityFormatRule('isPanFormat', …)`;
   * `identityFormatRule` is an alias of `formatRule`; and `formatRule`, which is the declaration
   * that actually calls `ValidateBy`, lives in `infrastructure/http/format-validators.ts` because
   * `POST /clients` needed the same phone and URL rules the assayer routes already had. The
   * earlier version of this check asked only whether the DTO's own file mentioned `ValidateBy`,
   * so the day the factory moved out of `assayer.controller.ts` every identity rule in it stopped
   * counting as a validator.
   *
   * That direction of breakage is the safe one — an unrecognised rule makes its property look
   * bare and fails the check below rather than passing it — which is why this was a red suite and
   * not a quiet hole. The positive assertions in the next test are what turned it red.
   */
  const reachesValidateBy = (name: string, file: string, seen = new Set<string>()): boolean => {
    const key = `${file}::${name}`;
    if (seen.has(key)) return false; // an import cycle proves nothing; stop rather than recur
    seen.add(key);
    const text = byFile.get(file);
    if (text === undefined) return false;

    const decl = declarationOf(text, name);
    if (decl) {
      if (/\bValidateBy\s*\(/.test(decl)) return true;
      const eq = decl.indexOf('=');
      if (eq < 0) return false;
      const initialiser = decl.slice(eq + 1).trim();
      // `someRule(...)` — built by a factory; or `someRule` — a plain alias of one.
      const from = /^([A-Za-z_$][\w$]*)\s*(?:\(|$)/.exec(initialiser);
      return from ? reachesValidateBy(from[1], file, seen) : false;
    }

    const origin = importOriginOf(file, name);
    return origin ? reachesValidateBy(origin.name, origin.file, seen) : false;
  };

  /**
   * A name counts as a validator when class-validator itself exports it — the honest definition,
   * because that export IS what writes the metadata the pipe reads — or when it is a repo-local
   * rule that reaches `ValidateBy`, which registers metadata under its own constraint name and
   * is therefore just as real to the pipe.
   *
   * `@Type()`, `@Transform()` and `@ApiProperty()` are correctly NOT validators: a property
   * carrying only those is still stripped, and the route still dies.
   */
  const isValidator = (name: string, file: string): boolean => {
    if (Object.prototype.hasOwnProperty.call(classValidator, name)) return true;
    return reachesValidateBy(name, file);
  };

  type Prop = { name: string; validators: string[]; decorators: string[]; typeText: string };

  const propertiesOf = (cls: ClassDecl): Prop[] => {
    const props: Prop[] = [];
    for (const member of membersOf(cls.body)) {
      const { decorators, declaration } = splitDecorators(member);
      const modifiers = '(?:public|private|protected|readonly|static|declare|abstract|override)\\s+';
      const asProperty = new RegExp(`^(?:${modifiers})*([A-Za-z_$][\\w$]*)\\s*[?!]?\\s*:`).exec(declaration);
      if (!asProperty) continue;
      // A method with a return-type annotation reads the same up to the name; the `(` separates them.
      if (new RegExp(`^(?:${modifiers})*[A-Za-z_$][\\w$]*\\s*[?!]?\\s*\\(`).test(declaration)) continue;
      if (/^(?:constructor|get|set)\b/.test(declaration)) continue;
      props.push({
        name: asProperty[1],
        decorators,
        validators: decorators.filter((d) => isValidator(d, cls.file)),
        typeText: declaration.slice(declaration.indexOf(':') + 1).trim(),
      });
    }
    return props;
  };

  /**
   * Every DTO class the pipe can be handed, closed over nesting and inheritance.
   *
   * A `@ValidateNested()` child is validated by the same executor with the same options, so an
   * undecorated property on `CoordinateDto` refuses the parent request just as surely; and an
   * inherited property is an own key on the instance exactly like a declared one, which is the
   * entire mechanism of this bug (`AssignmentReassignmentEntity` learned the same lesson from
   * `BaseEntity`, in the database rather than the pipe).
   */
  const dtos = (() => {
    const seen = new Set<string>();
    const out: Array<ClassDecl & { props: Prop[]; reachedFrom: string }> = [];
    const queue: Array<{ type: string; from: string }> = boundTypes.map((b) => ({ type: b.type, from: b.file }));
    while (queue.length) {
      const { type, from } = queue.shift()!;
      if (seen.has(type)) continue;
      seen.add(type);
      const cls = declaredClasses.get(type);
      if (!cls) continue; // a primitive, an enum, or a type imported from @fapoms/shared
      const props = propertiesOf(cls);
      out.push({ ...cls, props, reachedFrom: from });
      for (const p of props) {
        for (const t of p.typeText.matchAll(/[A-Za-z_$][\w$]*/g)) {
          if (declaredClasses.has(t[0])) queue.push({ type: t[0], from: cls.file });
        }
      }
      const parent = /extends\s+([A-Za-z_$][\w$]*)/.exec(cls.heritage);
      if (parent) queue.push({ type: parent[1], from: cls.file });
    }
    return out;
  })();

  it('finds the DTOs and their properties, so a broken scan cannot pass as a clean result', () => {
    expect(dtos.length).toBeGreaterThan(100);
    expect(dtos.reduce((n, d) => n + d.props.length, 0)).toBeGreaterThan(400);
    // The two routes this guard was written for, reached the way a caller reaches them.
    expect(dtos.map((d) => d.name)).toEqual(
      expect.arrayContaining(['CreateAssignmentRequestDto', 'ReceiveOcrResultsDto']),
    );
  });

  it('reads decorators off the source rather than assuming them', () => {
    // If `splitDecorators`/`isValidator` ever stopped matching, every property would look bare
    // and the check below would still be "green" in the wrong direction — loudly, but only
    // because this asserts the positive case as well.
    const create = dtos.find((d) => d.name === 'CreateAssignmentRequestDto')!;
    expect(create.props.find((p) => p.name === 'projectBranchId')!.validators).toEqual(['IsUUID']);
    expect(create.props.find((p) => p.name === 'proposedFee')!.validators).toEqual(['IsOptional', 'IsNumber', 'Min']);
    // A repo-local ValidateBy rule counts, in both shapes it takes. `IsPanFormat` is declared in
    // the DTO's own file but reaches `ValidateBy` only through an alias and an imported factory;
    // `IsHttpUrl` is not declared in its DTO's file at all and is imported ready-made. Neither
    // was recognised while this check asked only whether the file itself said `ValidateBy`.
    const assayer = dtos.find((d) => d.name === 'CreateAssayerRequestDto')!;
    expect(assayer.props.find((p) => p.name === 'panNumber')!.validators).toContain('IsPanFormat');
    const client = dtos.find((d) => d.name === 'CreateClientRequestDto')!;
    expect(client.props.find((p) => p.name === 'website')!.validators).toContain('IsHttpUrl');
    expect(client.props.find((p) => p.name === 'contactPhone')!.validators).toContain('IsIndianMobile');
    // And the factory is reached, not guessed: the name that actually calls `ValidateBy` lives
    // two hops away, in a file neither DTO declares anything in.
    expect(isValidator('formatRule', 'infrastructure/http/format-validators.ts')).toBe(true);
    // Not everything a DTO file declares is a validator, and neither is a class-transformer or
    // Swagger decorator — a property carrying only those is still stripped by the pipe.
    expect(isValidator('Type', 'modules/billing-engine/billing-engine.controller.ts')).toBe(false);
    expect(isValidator('assayerUploadMulterOptions', 'modules/assayer/assayer.controller.ts')).toBe(false);
  });

  it('gives every declared property of every request DTO at least one validator', () => {
    // Add the decorator the field actually needs — `@IsOptional() @IsString()` for a free-text
    // optional, `@IsObject()` for an opaque payload. `@Allow()` whitelists without checking and
    // is the last resort, not the quick fix.
    const strippedAndRefused = dtos.flatMap((d) =>
      d.props
        .filter((p) => p.validators.length === 0)
        .map((p) => `${d.file} :: ${d.name}.${p.name} (reached from ${d.reachedFrom})`),
    );

    expect({ strippedAndRefused }).toEqual({ strippedAndRefused: [] });
  });

  /**
   * The scan above reads text. This runs the real pipe over the real classes the routes are bound
   * to, read off `design:paramtypes` exactly as Nest reads them — the same technique
   * `assayer-identity-dto.spec.ts` uses, so swapping the DTO on the route fails here too.
   *
   * It is here because the two fixed endpoints deserve a positive control and not only a
   * negative one: "no undecorated property" is the rule, "a good request is now accepted" is the
   * thing anybody actually cares about. The existing unit suites could not have shown either —
   * `assignment-phase2-concurrency.spec.ts` calls `AssignmentService.create()` directly with a
   * plain object and never constructs the DTO, so the route's own gate is not in the picture.
   */
  describe('the two endpoints this was written for, through the real pipe', () => {
    // Same options as app.useGlobalPipes(new CodedValidationPipe({ ... })) in main.ts.
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    });

    const CreateAssignmentDto = Reflect.getMetadata('design:paramtypes', AssignmentController.prototype, 'create')?.[0];
    const OcrCallbackDto = Reflect.getMetadata('design:paramtypes', OcrBoundaryController.prototype, 'callbackOcr')?.[1];

    const refusalOf = async (body: unknown, metatype: unknown): Promise<string[] | null> => {
      try {
        await pipe.transform(body, { type: 'body', metatype } as never);
        return null;
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        const res = (e as BadRequestException).getResponse() as { message: string[] | string };
        return Array.isArray(res.message) ? res.message : [String(res.message)];
      }
    };

    it('binds the classes this file names, so the metadata it reads is the route’s own', () => {
      expect(CreateAssignmentDto?.name).toBe('CreateAssignmentRequestDto');
      expect(OcrCallbackDto?.name).toBe('ReceiveOcrResultsDto');
    });

    it('accepts a minimal valid create body — the request that used to be refused', async () => {
      // Nothing exotic: the two required ids and no idempotency key, which is what the web app
      // sends. This exact body came back `400 property clientRequestId should not exist`.
      expect(await refusalOf(
        {
          projectBranchId: '11111111-1111-4111-8111-111111111111',
          assayerId: '22222222-2222-4222-8222-222222222222',
        },
        CreateAssignmentDto,
      )).toBeNull();
    });

    it('accepts a create body that does send an idempotency key, and rejects one too long for the column', async () => {
      expect(await refusalOf(
        {
          projectBranchId: '11111111-1111-4111-8111-111111111111',
          assayerId: '22222222-2222-4222-8222-222222222222',
          clientRequestId: 'web-create-6f1c5f0e-2f2a-4b0f-9c5e-1d4a2b3c4d5e',
        },
        CreateAssignmentDto,
      )).toBeNull();

      // 101 characters: one past assignment_idempotency_records.client_request_id. A 400 naming
      // the field, not a 500 out of Postgres after the transaction has already started.
      const messages = await refusalOf(
        {
          projectBranchId: '11111111-1111-4111-8111-111111111111',
          assayerId: '22222222-2222-4222-8222-222222222222',
          clientRequestId: 'k'.repeat(101),
        },
        CreateAssignmentDto,
      );
      expect(messages?.join(' ')).toContain('clientRequestId');
    });

    it('still refuses what it always should have — a junk id, and a genuinely unknown field', async () => {
      expect(await refusalOf({ projectBranchId: 'not-a-uuid', assayerId: 'nope' }, CreateAssignmentDto))
        .not.toBeNull();
      // The whitelist itself is not weakened by the fix; a typo is still named.
      const messages = await refusalOf(
        {
          projectBranchId: '11111111-1111-4111-8111-111111111111',
          assayerId: '22222222-2222-4222-8222-222222222222',
          clientRequstId: 'typo',
        },
        CreateAssignmentDto,
      );
      expect(messages?.join(' ')).toContain('clientRequstId');
    });

    it('accepts an OCR engine callback, and refuses one carrying nothing to review', async () => {
      expect(await refusalOf(
        { externalJobId: 'ocr-job-8842', ocrPayload: { pages: [{ text: 'BRANCH LEDGER' }] } },
        OcrCallbackDto,
      )).toBeNull();

      // A COMPLETED job whose payload is null opens a human-review case with nothing in it.
      expect(await refusalOf({ externalJobId: 'ocr-job-8842', ocrPayload: null }, OcrCallbackDto))
        .not.toBeNull();
      expect(await refusalOf({ ocrPayload: { pages: [] } }, OcrCallbackDto)).not.toBeNull();
    });
  });
});
