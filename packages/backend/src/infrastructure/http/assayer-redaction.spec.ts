import { of } from 'rxjs';
import { SystemRole } from '@fapoms/shared';
import { redactAssayersDeep } from '../../modules/assayer/assayer-visibility';
import { AssayerRedactionInterceptor } from './assayer-redaction.interceptor';

/**
 * Assayer identity and banking must not leave the system to a role that may not read them,
 * whichever route the response came out of.
 *
 * `scopeAssayerForRoles` guarded the four assayer endpoints. The assayer record is joined into
 * schedules, assignments, the operations inbox, documents and clarification threads — and
 * because PAN and bank account decrypt on entity load, each of those joins handed both to
 * DESK, DESK_OPERATOR and AUDITOR: the exact roles the policy exists to exclude. The front
 * door was locked and a dozen side windows were open.
 */
describe('assayer redaction at the response boundary', () => {
  /** A schedule as the API returns it: the assayer hangs off it, and off its assignment too. */
  const scheduleWithAssayer = () => ({
    id: 'sch-1',
    scheduledDate: '2026-09-01',
    assayer: {
      id: 'as-1', assayerCode: 'AS-01', displayName: 'Belekar', phone: '9000000000', state: 'Maharashtra',
      panNumber: 'ABCDE1234F', aadhaarNumber: '1111 2222 3333', dateOfBirth: '1990-01-01',
      bankAccountNumber: '000123456789', ifscCode: 'HDFC0000123', passwordHash: 'never',
    },
    assignment: {
      id: 'asn-1',
      assayer: { id: 'as-2', assayerCode: 'AS-02', displayName: 'Rao', panNumber: 'ZZZZZ9999Z' },
    },
  });

  const SECRETS = ['panNumber', 'aadhaarNumber', 'dateOfBirth', 'bankAccountNumber', 'ifscCode', 'passwordHash'];

  describe.each([SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.AUDITOR])('for %s', (role) => {
    it('strips identity and banking however deeply the assayer is nested', () => {
      const out: any = redactAssayersDeep(scheduleWithAssayer(), [role]);

      for (const f of SECRETS) expect(out.assayer[f]).toBeUndefined();
      // Two levels down, through a different relation, is the same record type and the same rule.
      expect(out.assignment.assayer.panNumber).toBeUndefined();
    });

    it('keeps what the role needs to do its job', () => {
      const out: any = redactAssayersDeep(scheduleWithAssayer(), [role]);

      expect(out.assayer.displayName).toBe('Belekar');
      expect(out.assayer.assayerCode).toBe('AS-01');
      expect(out.assayer.state).toBe('Maharashtra');
      // The surrounding record is untouched — this redacts fields, it does not filter rows.
      expect(out.id).toBe('sch-1');
      expect(out.scheduledDate).toBe('2026-09-01');
    });
  });

  /**
   * The privileged path is the one this walk used to skip entirely, and the one the masking is
   * for. ADMIN and OPERATIONS keep the fields — that is what separates them from the desk, whose
   * keys are deleted — but a join that reaches an assayer no longer hands over the real numbers.
   * Before this, `/schedules`, `/assignments` and the operations inbox all did, on every request,
   * with no audit row anywhere.
   */
  it('masks rather than strips for the roles that onboard and pay, wherever the assayer is nested', () => {
    for (const role of [SystemRole.ADMIN, SystemRole.OPERATIONS]) {
      const out: any = redactAssayersDeep(scheduleWithAssayer(), [role]);
      expect(out.assayer.panNumber).toBe('******234F');
      expect(out.assayer.bankAccountNumber).toBe('********6789');
      // The second, differently-nested assayer is reached by the same walk — this is the join
      // that leaked, and it is a different person with a different number.
      expect(out.assignment.assayer.panNumber).toBe('******999Z');
      // Everything else the role legitimately reads is untouched.
      expect(out.assayer.displayName).toBe('Belekar');
    }
  });

  it('shows an assayer their own details and not another assayer’s', () => {
    const out: any = redactAssayersDeep(scheduleWithAssayer(), [SystemRole.ASSAYER], 'as-1');

    expect(out.assayer.bankAccountNumber).toBe('000123456789');
    expect(out.assignment.assayer.panNumber).toBeUndefined();
  });

  it('terminates on the parent↔child cycles TypeORM hands back', () => {
    const node: any = { id: 'as-1', assayerCode: 'AS-01', panNumber: 'ABCDE1234F' };
    node.self = node;
    const wrapper: any = { assayer: node };
    node.parent = wrapper;

    // Would not return at all without the visited set.
    const out: any = redactAssayersDeep(wrapper, [SystemRole.DESK]);
    expect(out.assayer.panNumber).toBeUndefined();
  });

  it('leaves a payload with no assayer in it alone', () => {
    const plain = { id: 'b-1', name: 'Pune Main', nested: { total: 3 } };
    expect(redactAssayersDeep(plain, [SystemRole.DESK])).toEqual(plain);
  });

  describe('the interceptor', () => {
    const run = (body: any, roles: string[], userId?: string) => {
      const ctx: any = {
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => ({ user: { id: userId, roles: roles.map((name) => ({ name })) } }) }),
      };
      let seen: any;
      new AssayerRedactionInterceptor()
        .intercept(ctx, { handle: () => of(body) } as any)
        .subscribe((v) => { seen = v; });
      return seen;
    };

    it('redacts whatever a handler returned, without the handler taking part', () => {
      const out = run(scheduleWithAssayer(), [SystemRole.DESK]);
      expect(out.assayer.panNumber).toBeUndefined();
      expect(out.assignment.assayer.panNumber).toBeUndefined();
    });

    it('does not disturb a response that is not an object', () => {
      expect(run('ok', [SystemRole.DESK])).toBe('ok');
      expect(run(null, [SystemRole.DESK])).toBeNull();
    });
  });
});
