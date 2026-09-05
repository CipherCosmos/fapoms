import { of } from 'rxjs';
import { SystemRole } from '@fapoms/shared';
import {
  ASSAYER_MONEY_FIELDS,
  AssayerMoneyRedactionInterceptor,
  redactAssignmentMoneyDeep,
} from './assayer-money-redaction.interceptor';

/**
 * The assayer sees no money, whichever route the response came out of.
 *
 * Fees became an ops-internal fact (2026-09): settled on the phone, first revealed at
 * invoicing. Before this interceptor, `GET /assignments/assayer/:id`, `GET /assignments/:id`
 * and every transition response returned the raw fee columns to the field app — the PII
 * interceptor beside this one strips identity, not money. These specs pin the policy: an
 * assayer-only principal gets no fee key anywhere in the graph, and everyone else's payload
 * is untouched byte for byte.
 */
describe('assayer money redaction at the response boundary', () => {
  /** An assignment as the work-list and transition routes actually return it: fee columns on
   *  the row, and the same row joined under other names elsewhere in the payload. */
  const assignmentPayload = () => ({
    success: true,
    data: {
      id: 'asn-1',
      assignmentNumber: 'ASN-2026-0001',
      status: 'PENDING',
      proposedFee: 1900,
      agreedFee: null,
      quotedBaseFee: 1250,
      quotedTravelFee: 650,
      counterTravelFee: 900,
      negotiationCount: 2,
      lastCounterRequestId: 'b3e1f7a2-4c5d-4e6f-8a9b-0c1d2e3f4a5b',
      // Operational facts, not money — the app renders distance and mode without a rupee
      // figure being derivable from either.
      quotedDistanceKm: 42.5,
      quotedTransportMode: 'BUS',
      scheduledDate: '2026-09-10',
      projectBranch: {
        id: 'pb-1',
        branch: { id: 'b-1', name: 'Pune Main' },
        // The same assignment joined back under a different name — the shape TypeORM hands
        // back and the reason the strip is key-by-key on every node, not per-route.
        assignments: [
          { id: 'asn-1', proposedFee: 1900, agreedFee: 1900, negotiationCount: 2 },
        ],
      },
    },
  });

  const run = (body: any, roles: string[], userId = 'as-1') => {
    const ctx: any = {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => ({ user: { id: userId, roles: roles.map((name) => ({ name })) } }) }),
    };
    let seen: any;
    new AssayerMoneyRedactionInterceptor()
      .intercept(ctx, { handle: () => of(body) } as any)
      .subscribe((v) => { seen = v; });
    return seen;
  };

  it('strips every fee key from an assayer-only response, nested and joined shapes included', () => {
    const out: any = run(assignmentPayload(), [SystemRole.ASSAYER]);

    for (const key of ASSAYER_MONEY_FIELDS) {
      expect(out.data).not.toHaveProperty(key);
    }
    // The joined copy of the row is the same policy, two levels down and inside an array.
    expect(out.data.projectBranch.assignments[0]).not.toHaveProperty('proposedFee');
    expect(out.data.projectBranch.assignments[0]).not.toHaveProperty('agreedFee');
    expect(out.data.projectBranch.assignments[0]).not.toHaveProperty('negotiationCount');
  });

  it('keeps the operational facts and everything that is not money', () => {
    const out: any = run(assignmentPayload(), [SystemRole.ASSAYER]);

    expect(out.data.quotedDistanceKm).toBe(42.5);
    expect(out.data.quotedTransportMode).toBe('BUS');
    expect(out.data.status).toBe('PENDING');
    expect(out.data.scheduledDate).toBe('2026-09-10');
    expect(out.data.projectBranch.branch.name).toBe('Pune Main');
    // This strips fields, it does not filter rows or unwrap envelopes.
    expect(out.success).toBe(true);
    expect(out.data.projectBranch.assignments).toHaveLength(1);
  });

  /**
   * A transition response is the raw saved entity — the exact payload that used to hand an
   * accept's agreed fee straight back to the phone that accepted it.
   */
  it('strips the fee keys from a transition response too', () => {
    const out: any = run(
      { success: true, data: { id: 'asn-1', status: 'ACCEPTED', agreedFee: 1900, proposedFee: 1900 } },
      [SystemRole.ASSAYER],
    );
    expect(out.data.status).toBe('ACCEPTED');
    expect(out.data).not.toHaveProperty('agreedFee');
    expect(out.data).not.toHaveProperty('proposedFee');
  });

  /** The desk's whole job is the money: a staff response must come through untouched. */
  it.each([SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.AUDITOR])(
    'leaves a %s response untouched',
    (role) => {
      const out: any = run(assignmentPayload(), [role]);
      expect(out).toEqual(assignmentPayload());
      expect(out.data.proposedFee).toBe(1900);
      expect(out.data.projectBranch.assignments[0].agreedFee).toBe(1900);
    },
  );

  /**
   * A principal holding a staff role AND the assayer role is staff: the blinding exists for the
   * field app's own tokens, not for an operations user who also does field work.
   */
  it('leaves a mixed staff+assayer principal untouched', () => {
    const out: any = run(assignmentPayload(), [SystemRole.OPERATIONS, SystemRole.ASSAYER]);
    expect(out.data.proposedFee).toBe(1900);
    expect(out.data.negotiationCount).toBe(2);
  });

  it('does not disturb a response that is not an object', () => {
    expect(run('ok', [SystemRole.ASSAYER])).toBe('ok');
    expect(run(null, [SystemRole.ASSAYER])).toBeNull();
  });

  it('terminates on the parent↔child cycles TypeORM hands back', () => {
    const node: any = { id: 'asn-1', proposedFee: 1900 };
    node.self = node;
    const wrapper: any = { assignment: node };
    node.parent = wrapper;

    // Would not return at all without the visited set.
    const out: any = redactAssignmentMoneyDeep(wrapper);
    expect(out.assignment).not.toHaveProperty('proposedFee');
  });

  it('walks arrays at the top level — the work-list shape', () => {
    const out: any = redactAssignmentMoneyDeep([
      { id: 'asn-1', proposedFee: 100, quotedDistanceKm: 3 },
      { id: 'asn-2', agreedFee: 200 },
    ]);
    expect(out[0]).not.toHaveProperty('proposedFee');
    expect(out[0].quotedDistanceKm).toBe(3);
    expect(out[1]).not.toHaveProperty('agreedFee');
  });
});
