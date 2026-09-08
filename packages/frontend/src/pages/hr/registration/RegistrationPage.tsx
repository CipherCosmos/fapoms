import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { RegistrationWizard } from './RegistrationWizard';

/**
 * The route this whole flow lives at now: `/hr/register` for a brand new person, `/hr/register/
 * :assayerId` to resume one already begun. The owner's own words were "improve the modal too",
 * and the modal itself was the thing standing in the way — cramped at a fixed 820px, its rail
 * wrapped onto a second line past six steps, and every one of them past the first was locked out
 * until a save nobody could see the point of yet.
 *
 * Everything that used to make the modal a modal — the fixed width, the Escape-to-close, the
 * portal — is gone; what is left is `RegistrationWizard`, unchanged in what it knows how to do,
 * now drawing a page's worth of room instead of a dialog's. This file is deliberately thin: it
 * only turns the URL into the two props the wizard has always taken.
 */
export const RegistrationPage: React.FC = () => {
  const { assayerId } = useParams<{ assayerId: string }>();
  const navigate = useNavigate();

  return (
    <RegistrationWizard
      key={assayerId ?? 'new'}
      resumeAssayerId={assayerId}
      onClose={() => navigate('/hr/roster')}
      onCreated={() => navigate('/hr/roster')}
    />
  );
};

export default RegistrationPage;
