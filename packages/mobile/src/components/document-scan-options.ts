import { scanProfileFor, type DocumentScanProfile } from '@fapoms/shared';
import type { ScanOptions } from '../../modules/document-scanner';

/**
 * TELLING GOOGLE'S SCANNER WHICH DOCUMENT IT IS ABOUT.
 *
 * The phone does not run the web app's detector — it hands over to ML Kit, which finds the page,
 * corrects the perspective and assembles a PDF on the device, and does all of it better than
 * JavaScript over a decoded JPEG would. What ML Kit cannot know is which of twenty-eight documents
 * this particular row is asking for, and that is exactly what the browser scanner was just taught.
 *
 * So the same table answers on both platforms (`scanProfileFor` in `@fapoms/shared`), and this file
 * turns its answer into the two things ML Kit's API actually accepts — a page limit and whether
 * importing from the gallery is offered — plus the filename the scan lands under. Everything else
 * in that profile (the outline, the finish) belongs to Google's own editor here, which is why this
 * is a translation of the profile rather than a second copy of the rules.
 *
 * Pure on purpose: the mobile package runs its tests in node with no React Native runtime (see
 * `jest.config.js`), so logic that needs proving lives in a file like this rather than inside a
 * component nothing can render.
 */

export interface ScanPlan {
  options: ScanOptions;
  profile: DocumentScanProfile;
}

/**
 * How ML Kit should be opened for a given requirement.
 *
 * The page limit is the useful half. A PAN card is one side and a photograph is one photograph:
 * capping them stops a scan of somebody's card silently growing a second page from the desk behind
 * it, and matches the browser, where those rows have no "Another page" button at all. A joining
 * form is left uncapped because nobody knows how long theirs is.
 */
export function scanPlanFor(requirement: string | null | undefined): ScanPlan {
  const profile = scanProfileFor(requirement);
  return {
    profile,
    options: {
      resultFormat: 'both',
      // The phone's own gallery is this platform's "Choose file", and it is inside Google's editor
      // rather than beside it — the same two doors, one screen further in.
      galleryImportAllowed: true,
      ...(profile.multiPage ? {} : { pageLimit: 1 }),
    },
  };
}

/*
  `scanFileName` is no longer defined here. It was written in this file first and then again inside
  the browser's scanner with its own slug expression — two answers to "what is this file called",
  which is exactly the kind of pair that drifts. It now lives beside the upload rules in
  @fapoms/shared and is re-exported here so this file's callers do not all have to change.
*/
export { scanFileName } from '@fapoms/shared';
