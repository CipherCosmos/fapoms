import { NotificationCategory } from '@fapoms/shared';
import { en } from './locales/en';
import { hi } from './locales/hi';

/**
 * Every category the server can send has a name and a hint on the alert-settings screen — a new
 * category (FEEDBACK was the one missed) otherwise shows as its raw enum value.
 */
describe('notification categories', () => {
  it.each(Object.values(NotificationCategory))('%s has an English and Hindi label and hint', (category) => {
    const enCats = en.profile.notifications.categories as Record<string, string>;
    const enHints = en.profile.notifications.categoryHints as Record<string, string>;
    const hiCats = (hi.profile?.notifications?.categories ?? {}) as Record<string, string>;
    const hiHints = (hi.profile?.notifications?.categoryHints ?? {}) as Record<string, string>;
    expect(enCats[category]).toBeTruthy();
    expect(enHints[category]).toBeTruthy();
    expect(hiCats[category]).toBeTruthy();
    expect(hiHints[category]).toBeTruthy();
  });
});
