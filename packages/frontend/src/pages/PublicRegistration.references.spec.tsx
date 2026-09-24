import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReferencesEditor } from './PublicRegistration';

/**
 * References are the one thing the candidate form never asked for: the desk wizard collects
 * them, the roster stores them, the qualification score counts them — and the candidate's own
 * link had no boxes for them. Submit now refuses without a ringable one, so this editor is
 * where that rule is met.
 */
describe('ReferencesEditor', () => {
  const draw = (references: Array<{ fullName: string; phone: string; relationship: string }> = [], onChange = jest.fn()) => {
    render(
      <MemoryRouter>
        <ReferencesEditor references={references} error={null} onChange={onChange} />
      </MemoryRouter>,
    );
    return onChange;
  };

  it('adds a reference with a name, phone and relationship', () => {
    const onChange = draw();
    fireEvent.change(screen.getByLabelText('Their name *'), { target: { value: 'Meera Rao' } });
    fireEvent.change(screen.getByLabelText('Their phone number'), { target: { value: '9822014455' } });
    fireEvent.change(screen.getByLabelText('How they know you'), { target: { value: 'Former manager' } });
    fireEvent.change(screen.getByLabelText('Their email (optional)'), { target: { value: 'Meera@Example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add reference' }));

    expect(onChange).toHaveBeenCalledWith([
      { fullName: 'Meera Rao', phone: '9822014455', relationship: 'Former manager', email: 'meera@example.com' },
    ]);
  });

  it('refuses a reference with no name', () => {
    const onChange = draw();
    fireEvent.change(screen.getByLabelText('Their phone number'), { target: { value: '9822014455' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add reference' }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('Give a name for this reference.')).toBeInTheDocument();
  });

  it('stops at three and says so', () => {
    const three = [1, 2, 3].map((n) => ({ fullName: `Ref ${n}`, phone: '9822014455', relationship: '' }));
    draw(three);
    expect(screen.queryByRole('button', { name: 'Add reference' })).not.toBeInTheDocument();
    expect(screen.getByText(/Three references is the most/)).toBeInTheDocument();
  });

  it('removes a reference', () => {
    const onChange = draw([{ fullName: 'Meera Rao', phone: '9822014455', relationship: '' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove reference Meera Rao' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('shows the submit refusal where the candidate meets it', () => {
    render(
      <MemoryRouter>
        <ReferencesEditor
          references={[]}
          error="Add at least one reference with a name and a 10-digit mobile number."
          onChange={jest.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Add at least one reference/)).toBeInTheDocument();
  });
});
