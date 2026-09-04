import { diffFields, maskToLast4 } from './diff-fields';

describe('diffFields', () => {
  const FIELDS = [
    { key: 'name', label: 'Name' },
    { key: 'pan', label: 'PAN', sensitive: true },
  ] as const;

  it('reports only the fields that actually changed', () => {
    const changes = diffFields(
      { name: 'Old', pan: 'ABCDE1234F' },
      { name: 'New', pan: 'ABCDE1234F' },
      FIELDS as any,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ field: 'name', fromValue: 'Old', toValue: 'New' });
  });

  it('skips a field the caller did not supply at all (undefined means "not sent")', () => {
    const changes = diffFields({ name: 'Old', pan: 'X' }, {}, FIELDS as any);
    expect(changes).toHaveLength(0);
  });

  it('masks a sensitive field to its last 4 characters on both sides', () => {
    const changes = diffFields(
      { name: 'Old', pan: 'AAAAA1111A' },
      { name: 'Old', pan: 'BBBBB2222B' },
      FIELDS as any,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].fromValue).toBe('******111A');
    expect(changes[0].toValue).toBe('******222B');
    // The clear values must never appear anywhere in the diff entry.
    expect(JSON.stringify(changes[0])).not.toContain('AAAAA1111A');
    expect(JSON.stringify(changes[0])).not.toContain('BBBBB2222B');
  });
});

describe('maskToLast4', () => {
  it('keeps only the last 4 characters visible', () => {
    expect(maskToLast4('ABCDE1234F')).toBe('******234F');
  });

  it('masks a short value entirely rather than exposing it whole', () => {
    expect(maskToLast4('AB')).toBe('**');
  });

  it('passes null through unchanged', () => {
    expect(maskToLast4(null)).toBeNull();
  });
});
