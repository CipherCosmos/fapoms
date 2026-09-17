import { PublicRegistrationController } from './public-registration.controller';

/**
 * THE CANDIDATE'S FORM MUST NOT REFUSE EVERY NUMBER.
 *
 * `checkPhoneForToken` answers in an object either way — `{conflict: false}` when the number is
 * free. The route used to test that object for truthiness (`conflict ? … : …`), and an object is
 * always truthy, so every number came back as a conflict with `message` undefined. The page then
 * printed its own fallback — "This mobile number is already registered with someone else." — and
 * nobody could get past step one of registration with any number at all, including numbers that
 * appear nowhere in the database.
 *
 * Observed live on 2026-09-16: `GET /public/registration/:token/check-phone/9771401044` answered
 * `{"conflict":true}` for a number held by no assayer and no application.
 */
describe('the public form asking whether a number is free', () => {
  const controllerWith = (answer: unknown) => new PublicRegistrationController(
    { checkPhoneForToken: jest.fn().mockResolvedValue(answer) } as never,
  );

  it('passes a free number straight through as free', async () => {
    const controller = controllerWith({ conflict: false });
    await expect(controller.checkPhone('tok', '9771401044')).resolves.toEqual({ conflict: false });
  });

  it('reports a real clash, with the sentence the service chose', async () => {
    const controller = controllerWith({
      conflict: true,
      message: 'This mobile number is already in use by somebody on our roster.',
    });
    await expect(controller.checkPhone('tok', '9876543210')).resolves.toEqual({
      conflict: true,
      message: 'This mobile number is already in use by somebody on our roster.',
    });
  });

  it('never answers "conflict" without saying why — that is what the page mistook for a refusal', async () => {
    const controller = controllerWith({ conflict: false });
    const answer = await controller.checkPhone('tok', '9771401044') as { conflict: boolean; message?: string };
    expect(answer.conflict === true && !answer.message).toBe(false);
  });
});
