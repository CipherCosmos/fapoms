import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The two halves of "what may be updated" must name the same fields.
 *
 * `UpdateAssayerDto` (assayer.service.ts) is the interface the service applies. It writes any
 * key it finds that matches a column, so adding a field there looks like it is enough.
 *
 * It is not. `UpdateAssayerRequestDto` (assayer.controller.ts) is what the global validation
 * pipe whitelists against, and the pipe *strips* properties the class does not declare. A field
 * added to only the interface therefore never reaches the service: the request returns 200, the
 * value is silently discarded, and the form tells the operator their edit was saved.
 *
 * That is exactly what happened when the appraiser roster's fields — date of birth,
 * qualification, VSTS code, HR owner, engagement type — were added to the interface alone. Seven
 * fields, seven successful saves, nothing written.
 *
 * A missing field is the dangerous direction and fails below. The reverse — declared on the
 * request, absent from the interface — is harmless (the service ignores it) but means the API
 * accepts something it does nothing with, so it is reported too.
 */
describe('what an assayer update accepts', () => {
  const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');

  /** Property names declared in a TS interface or class body, ignoring methods and comments. */
  const propertiesOf = (source: string, declaration: string): string[] => {
    const start = source.indexOf(declaration);
    if (start < 0) throw new Error(`Could not find "${declaration}" — has it been renamed?`);
    // Balance braces from the declaration's opening brace to find the body.
    const open = source.indexOf('{', start);
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) { end = i; break; }
    }
    const body = source.slice(open + 1, end);
    const withoutComments = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    return [...new Set(
      [...withoutComments.matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\??\s*:/gm)].map((m) => m[1]),
    )].sort();
  };

  const serviceFields = propertiesOf(read('assayer.service.ts'), 'export interface UpdateAssayerDto');
  const requestFields = propertiesOf(read('assayer.controller.ts'), 'class UpdateAssayerRequestDto');

  it('finds both declarations, so the check cannot pass by comparing nothing', () => {
    expect(serviceFields.length).toBeGreaterThan(20);
    expect(requestFields.length).toBeGreaterThan(20);
  });

  it('declares on the request every field the service is willing to apply', () => {
    // Add the field to UpdateAssayerRequestDto with the matching @IsOptional() validator.
    const strippedBeforeItArrives = serviceFields.filter((f) => !requestFields.includes(f));
    expect({ strippedBeforeItArrives }).toEqual({ strippedBeforeItArrives: [] });
  });

  /**
   * The other direction is not a bug at runtime — the service writes any key matching a column,
   * whatever the interface says — but a field the API accepts and the interface does not mention
   * is undocumented surface, and the next person reading the interface to learn what an update
   * does will be wrong about it.
   */
  it('mentions in the service interface every field the request accepts', () => {
    const acceptedButUndocumented = requestFields.filter((f) => !serviceFields.includes(f));
    expect({ acceptedButUndocumented }).toEqual({ acceptedButUndocumented: [] });
  });
});
