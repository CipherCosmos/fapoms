import React from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { RegistrationWizard } from './RegistrationWizard';

/**
 * The route this flow lives at: `/hr/register/application/:applicationId`.
 *
 * It used to be `/hr/register` for a brand new person, and that was the hole. A seven-step form
 * with nothing behind it had to create something to write to, so step one did — a live row on the
 * roster, before any interview, any application or any review. It was also what the roster's "Add
 * assayer" button opened, which made the bypass the path everybody found and the rest of the
 * pipeline look optional.
 *
 * There is no "new" any more. A candidate's application exists because somebody passed their
 * interview; this page is the desk typing into it on their behalf, and the URL names which one.
 *
 * Deliberately thin: it only turns the URL into the props the wizard takes.
 */
export const RegistrationPage: React.FC = () => {
  const { applicationId } = useParams<{ applicationId: string }>();
  const navigate = useNavigate();

  // No application named, nothing to fill in. The candidate screen is where somebody is added.
  if (!applicationId) return <Navigate to="/hr/interviews" replace />;

  return (
    <RegistrationWizard
      key={applicationId}
      applicationId={applicationId}
      onClose={() => navigate('/hr/applications')}
      onCreated={() => navigate('/hr/applications')}
    />
  );
};

export default RegistrationPage;
