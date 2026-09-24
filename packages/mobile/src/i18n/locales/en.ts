/**
 * English — the authoritative catalogue.
 *
 * Every other locale is measured against this file: `TranslationKey` is derived from it, and
 * anything a locale omits falls back to the sentence written here. Adding a screen's copy here
 * is what makes it translatable; nothing else is required of the translator's side.
 *
 * House style, because the reader is a field assayer visiting bank branches and is often not
 * a confident reader of English or of anything else:
 *
 *   - One idea per sentence, and short sentences.
 *   - Say what to do, not what went wrong: "Step outside and try again", not "GPS fix failed".
 *   - Never put an enum, a field name or a status code on screen.
 *   - Interpolation uses i18n-js's `%{name}` form.
 *
 * Plurals are written as two separate keys and chosen with a ternary at the call site rather
 * than through i18n-js's pluralisation rules. English and Hindi share the same one/other split,
 * so the rule engine would buy nothing here, and separate keys stay inside the type-checked
 * key union — a mistyped plural branch is then a compile error rather than a sentence that
 * renders as `[missing …]` only when a count happens to be 1.
 */
import {
  CANDIDATE_JOURNEY_NEXT_WORDS, CANDIDATE_JOURNEY_STEP_WORDS, CANDIDATE_JOURNEY_WORDS,
} from '@fapoms/shared';
import type { CatalogueNode } from '../catalogue';

export const en = {
  /** Words that appear on more than one screen. Never screen-specific copy. */
  common: {
    cancel: 'Cancel',
    save: 'Save',
    saving: 'Saving…',
    done: 'Done',
    edit: 'Edit',
    close: 'Close',
    back: 'Back',
    remove: 'Remove',
    notNow: 'Not now',
    tryAgain: 'Try again',
    signOut: 'Sign out',
    retry: 'Retry',
    notOnFile: 'Not on file',
    // Shown when a network/timeout failure leaves an action queued for automatic retry, rather
    // than a plain "failed" that implies the assayer must act again themselves.
    willRetry: "Saved. We'll send it automatically once you're back online.",
    // An offer reply or claim filed with no signal: it is on the phone and will send itself.
    // Shown as a success, so nobody presses again thinking the first press failed.
    savedOfflineTitle: 'Saved on your phone',
    savedOfflineBody: 'It will be sent by itself when you are back online.',
    showMore: 'Show %{count} more',
  },

  login: {
    /** The product name. Kept untranslated on purpose — see the note in `hi.ts`. */
    appName: 'Orbit',
    tagline: 'FIELD AUDIT OPERATIONS',
    codeLabel: 'Assayer code or phone',
    codeAccessibility: 'Assayer code or phone',
    codePlaceholder: 'AS0001',
    passwordLabel: 'Password',
    passwordAccessibility: 'Password',
    showPassword: 'Show password',
    hidePassword: 'Hide password',
    signIn: 'Sign in',
    signingIn: 'Signing in…',
    useBiometric: 'Use biometric sign-in',
    missingFields: 'Please enter both Assayer Code and Password.',
    badCredentials: 'Invalid credentials. Please try again.',
    unreachable: 'Could not reach the server. Check your connection or signal and try again.',
    biometricFailed: 'Biometric authentication failed.',
    biometricError: 'Biometric login failed.',
    identifierNotRecognised: 'That Assayer Code or phone number was not recognised.',
    /**
     * Recognised, but no sign-in has ever been issued for them.
     *
     * 540 roster-imported assayers have no password at all. Until the server learned to say so,
     * the pre-login step confirmed their identifier and greeted them by name, and the password
     * step then answered "Invalid credentials" — telling somebody their password was wrong for
     * an account that has never had one. There is nothing for them to correct, so this says who
     * can fix it instead of implying they mistyped something.
     */
    needsAppAccess: "You don't have app access yet. Ask your HR contact to set it up for you.",
    authorisedOnly: 'Authorised field personnel only',
    /**
     * The one way into self-registration from a logged-out handset.
     *
     * There is no deep link registered for the invite email's `/register/<token>` web link (no
     * `scheme` in app.config.js), so this is a plain link to a token-entry step rather than
     * something the OS can hand the app directly. See `SelfRegistrationScreen`.
     */
    registerLink: "New here? Start your registration",
    registerLinkAccessibility: 'Start appraiser self-registration',
    server: {
      hideSettings: 'Hide server settings',
      openSettings: 'Server settings',
      addressLabel: 'Backend address',
      addressAccessibility: 'Backend server address',
      addressPlaceholder: 'http://192.168.1.10:3000',
      test: 'Test',
      reachable: 'Server reachable.',
      unreachable: 'Could not reach that address.',
      saved: 'Saved. Sign in to continue.',
      saveFailed: 'Could not save that address.',
      reset: 'Reset to default',
      resetDone: 'Reset to the built-in default.',
    },
  },

  password: {
    titleVoluntary: 'Change your password',
    titleForced: 'Choose your own password',
    subtitleVoluntary: 'Enter your current password, then the new one you want to use.',
    subtitleForced:
      'Your account is still using a password that was issued to you. Set one only you know before continuing.',
    currentLabel: 'Current password',
    currentAccessibility: 'Current password',
    newLabel: 'New password',
    newAccessibility: 'New password',
    confirmLabel: 'Confirm new password',
    confirmAccessibility: 'Confirm new password',
    showNew: 'Show new password',
    hideNew: 'Hide new password',
    showConfirm: 'Show confirmed password',
    hideConfirm: 'Hide confirmed password',
    ruleLength: 'At least %{count} characters',
    ruleDiffers: 'Different from your current password',
    ruleMatches: 'Matches the new password',
    submit: 'Set password',
    errMissing: 'Enter your current password and choose a new one.',
    errTooShort: 'Your new password must be at least %{count} characters.',
    errMismatch: 'The two new passwords do not match.',
    errSameAsCurrent: 'Your new password must be different from the current one.',
    errFailed: 'Could not change your password. Please try again.',
  },

  lock: {
    title: 'Locked',
    signedInAs: 'Signed in as %{name}',
    unlock: 'Unlock',
    waiting: 'Waiting…',
    sensorStuck: 'Sensor not responding?',
    continueWithout: 'Continue without it',
    continueWithoutAccessibility: 'Continue without fingerprint check',
    switchAccount: 'Sign in as someone else',
    switchAccountAccessibility: 'Sign out and sign in as someone else',
  },

  registration: {
    /** Sign-out confirmation when registration photos are still waiting to send. */
    signOutUnsentBody: 'Photos not sent yet: %{count}. Signing out deletes them from this phone.',
    banner: {
      oneFailed: 'One paper did not send',
      manyFailed: '%{count} papers did not send',
      oneNeeded: 'One paper still needed',
      manyNeeded: '%{count} papers still needed',
      failedBody: 'It is saved on your phone. Tap below to send it again.',
      neededBody: 'You can photograph them here, or the office can add them for you.',
      sendAgain: 'Send again',
      seeWhatIsNeeded: 'See what is needed',
    },
    title: 'Your papers',
    progress: '%{done} of %{required} done',
    reassurance:
      'You do not have to do this on your phone. The office can add these papers for you. Sending them here is just quicker.',
    stillNeeded: 'Still needed',
    onTheWay: 'On the way',
    onTheWayNote: 'You can close this screen. These keep sending on their own.',
    alreadyWithOffice: 'Already with the office (%{count})',
    otherPapers: 'Other papers you can send',
    otherPapersHint: 'Not needed. Send one only if you have it.',
    allDoneTitle: 'The office has everything',
    allDoneBody: 'Nothing else is needed from you.',
    takePhoto: 'Take a photo',
    photosReceived: '%{count} photos received',
    haveThis: 'We have this.',
    state: {
      verified: 'Checked',
      received: 'Done',
      rejected: 'Sent back',
      sending: 'Sending',
      failed: 'Did not send',
      needed: 'Needed',
    },
    checkedAgainstOriginal: 'Checked against the original. Nothing more needed.',
    takeItAgain: 'Take it again',
    /**
     * What to DO, not what was wrong.
     *
     * The person reading this is holding the card, not grading it. "Too blurred" is a verdict;
     * "take it again in better light, holding the phone steady" is something they can act on
     * without having to work out what is being asked of them.
     */
    rejected: {
      ILLEGIBLE: 'The photo was too blurred or too dark to read. Please take it again in better light, holding the phone steady.',
      INCOMPLETE_CAPTURE: 'Part of the document was cut off. Please take it again with all four corners inside the frame.',
      WRONG_DOCUMENT: 'This was a different document from the one asked for. Please check which one is needed and send that.',
      NAME_MISMATCH: 'The name on this document does not match the name on your record. Please send the correct document, or contact your HR desk if your name is recorded wrongly.',
      NUMBER_MISMATCH: 'The number on this document does not match the one on your record. Please contact your HR desk.',
      EXPIRED: 'This document has expired. Please send a current one.',
      NOT_THE_PERSON: 'This document does not appear to belong to you. Please send your own.',
      ALTERED_OR_SUSPECT: 'We could not accept this document. Please contact your HR desk.',
      GENERIC: 'The office could not accept this. Please take a clear photo of the whole document and send it again.',
    },
    home: {
      title: 'Where you live',
      setHomeArea: 'Set your home area',
      body: 'We cannot place you on the map yet. Do this where you live, so we send you work that is close by.',
      useCurrent: 'Use where I am now',
      locationOffTitle: 'Location is off',
      locationOffBody: 'Allow location for this app in your phone settings, then try again.',
      outsideIndiaTitle: 'That does not look right',
      outsideIndiaBody: 'Your phone reported a place outside India. Try again from where you are based.',
      saveFailedTitle: 'Could not save',
      saveFailedBody: 'Please try again in a moment.',
      noFixTitle: 'Could not find you',
      noFixBody: 'Step outside or near a window and try again.',
      thanksTitle: 'Thank you',
      thanksBody: 'Your home area is set. You will get work closer to you.',
    },
    capture: {
      nothingTitle: 'Nothing to send',
      nothingBody: 'No photo was captured. Try again.',
      addedTitle: 'Added',
      addedBody: '%{document} is sending. You can close this screen.',
    },
    /**
     * What to photograph, per required document.
     *
     * Keyed by the server's requirement code so the row and the instruction cannot drift apart.
     * The document's *name* is not here: it arrives from the server and stays as sent, because
     * the person is holding a physical paper and has to match what is printed on it.
     */
    hints: {
      PHOTOGRAPH: 'A clear photo of your face. Look straight at the camera.',
      AADHAAR_FRONT: 'The side with your photo on it.',
      AADHAAR_BACK: 'The side with your address on it.',
      PAN_CARD: 'The whole card. Check all four corners are in the picture.',
      BANK_PASSBOOK: 'The first page, where your name and account number are printed.',
      JOINING_FORM: 'The form you filled in when you joined. Every page you signed.',
      NDA: 'The secrecy agreement you signed.',
      CODE_OF_CONDUCT: 'The rules paper you signed.',
      ETHICAL_CONDUCT_LETTER: 'The honesty letter you signed.',
      ADDRESS_PROOF: 'Any paper that shows where you live.',
      DRIVING_LICENCE: 'Both sides, if your address is printed on the back.',
      VOTER_ID: 'The side with your photo on it.',
      PASSPORT: 'The page with your photo and details on it.',
    },
  },

  /**
   * The Appraiser Recruitment self-registration flow, reached from `LoginScreen` without
   * signing in — see `SelfRegistrationScreen`. Deliberately its own namespace, separate from
   * `registration` above: that one is an already-authenticated assayer's own paperwork
   * checklist, and shares no screen, no token and no editable-field set with this.
   */
  selfRegistration: {
    tokenEntry: {
      title: 'Start your registration',
      body: 'Paste the registration link or code you were sent by email or SMS.',
      inputLabel: 'Registration link or code',
      inputPlaceholder: 'Paste your link here',
      continueLabel: 'Continue',
      missingToken: 'Paste your registration link or code first.',
      backToSignIn: 'Back to sign in',
    },
    loading: 'Opening your registration…',
    loadFailedTitle: 'Could not open this link',
    loadFailedHelp: 'Ask the HR person who invited you to send a new link.',
    ref: 'Ref #%{ref}',
    saving: 'Saving…',
    saved: 'Saved',
    savesAsYouType: 'Saves as you type',
    saveFailedTitle: 'Could not save that',
    stuckTitle: 'If you get stuck',
    stuckBody:
      'Contact the HR person who sent you this link. They can change your phone number, send the link again, or tell you which document is missing.',

    steps: {
      progress: 'Step %{step} of %{total}',
      personal: 'Personal & contact',
      address: 'Experience & address',
      bank: 'ID & bank',
      documents: 'Documents & submit',
      continue: 'Next',
      back: 'Back',
      fixOne: 'Fix 1 field to continue — it is marked in red.',
      fixMany: 'Fix %{count} fields to continue — they are marked in red.',
    },

    consent: {
      collectedBy: 'Collected by %{name}',
      retentionTitle: 'HOW LONG WE KEEP IT',
      rightsTitle: 'WHAT YOU CAN ASK FOR',
      withdrawalTitle: 'CHANGING YOUR MIND',
      contactTitle: 'WHO TO CONTACT',
      agree: 'I agree — start my form',
      versionNote: 'Notice version %{version}. A copy of exactly this is kept with your application.',
      failedTitle: 'Could not record your agreement',
      agreementTitle: 'Your agreement',
      agreedOn: 'You agreed on %{date}',
      details: 'Details',
      agreedCopy: 'Notice version %{version}. A copy of what you read is kept with your application.',
      grievance: 'Questions about your details: %{contact}',
      withdraw: 'Withdraw',
      withdrawTitle: 'Withdraw your application?',
      withdrawBody: 'This stops your application and deletes what you have given us. It cannot be undone.',
      withdrawReason: 'Why? (optional)',
      withdrawConfirm: 'Withdraw',
      withdrawFailedTitle: 'Could not withdraw',
    },

    unlock: {
      title: 'Confirm it is you to continue',
      body: 'Your saved details and documents are protected. We will send a 6-digit code to your mobile number ending %{last4}. If that is no longer your number, ask HR to correct it.',
      continue: 'Continue',
    },
    otp: {
      title: 'Mobile number',
      verified: 'Verified',
      body: 'We\'ll send you a 6-digit code.',
      yourEmail: 'your email address',
      phoneLabel: 'Your mobile number',
      phonePlaceholder: '10-digit mobile number',
      checking: 'Checking…',
      conflictFallback: 'That number cannot be used here. Contact the office and they can sort it out.',
      sendCode: 'Send code',
      resendCode: 'Resend code',
      resendIn: 'Resend code in %{time}',
      sentBody: 'Code emailed to %{email}. It works for %{minutes} minutes.',
      sentBodySms: 'Code texted to %{phone}. It works for %{minutes} minutes.',
      sentFor: 'Code sent for +91 %{phone}',
      numberChanged: 'You changed the number — resend the code for the new one.',
      codeLabel: '6-digit verification code',
      codePlaceholder: '000000',
      verify: 'Verify code',
      verifiedBody: '+91 %{phone} is verified.',
      missingPhone: 'Enter a valid 10-digit mobile number first.',
      missingCode: 'Enter the 6-digit code you received.',
      codeForOtherNumber:
        'That code was sent for +91 %{sent}, but the number now reads +91 %{now}. Change it back, or resend the code.',
      expired: 'Your verification has expired. Send a new code to continue.',
      sendFailedTitle: 'Could not send the code',
      verifyFailedTitle: 'Could not verify that code',
    },

    form: {
      identityTitle: 'Your details',
      identityNote: 'Write your name exactly as on your Aadhaar or PAN card.',
      fullName: 'Full name (as on ID)',
      fullNamePlaceholder: 'e.g. Ramesh Kumar Sharma',
      dateOfBirth: 'Date of birth',
      dobDay: 'Day',
      dobMonth: 'Month',
      dobYear: 'Year',
      email: 'Email',
      emailPlaceholder: 'you@example.com',
      gender: 'Gender',
      genderMale: 'Male',
      genderFemale: 'Female',
      genderOther: 'Other',
      genderPreferNot: 'Prefer not to say',

      experienceTitle: 'Work experience',
      experienceYears: 'Years of experience',
      chooseYears: 'Choose years',
      fresher: 'Fresher — less than 1 year',
      oneYear: '1 year',
      years: '%{count} years',
      currentEmployer: 'Current employer (if any)',
      currentEmployerPlaceholder: 'Current jeweller or valuation firm',
      expertise: 'Main skills',
      expertisePlaceholder: 'Gold testing, hallmarking…',
      availability: 'When you can work',
      availabilityPlaceholder: 'Weekdays, full-time…',

      addressTitle: 'Home address',
      addressNote: 'Type pincode — we fill the rest.',
      pincode: 'Pincode',
      pincodePlaceholder: '6-digit pincode',
      pincodeLooking: 'Checking the postal directory…',
      pincodeFilled: 'Filled in from the postal directory: %{place}. Change it below if it is not right.',
      pincodeFilledFromMap:
        'The postal directory did not answer, so this came from the map: %{place}. Please check the state and district.',
      pincodeKnown: '%{pincode} is %{place} in the postal directory.',
      pincodeKnownFromMap: '%{pincode} looks like %{place} on the map — please check it.',
      pincodeDiffers: 'The postal directory has %{pincode} as %{place}. Yours is different — keep it if you are sure.',
      pincodeUse: 'Use %{place}',
      pincodeUsed: 'Filled in for you: %{place}.',
      pincodeNotFound: 'There is no %{pincode} in the postal directory — check the six digits, or fill the address in below.',
      pincodeUnavailable: 'We could not check that pincode just now. Fill in the state, district and town below.',
      state: 'State',
      chooseState: 'Choose your state',
      asRecorded: '%{value} (as recorded)',
      district: 'District',
      districtPlaceholder: 'e.g. Thane',
      city: 'City / town',
      cityPlaceholder: 'e.g. Mumbai',
      address: 'Full home address',
      addressPlaceholder: 'House / flat no., building, street, landmark',

      pinTitle: 'Home on the map (optional)',
      pinNote: 'If you are at home, save your location. Otherwise we find it from your address.',
      pinUseCurrent: 'Use my current location',
      pinSaved: 'Home location saved. Drag the map to move the pin.',
      pinRemove: 'Remove',

      referencesTitle: 'References',
      referencesNote: 'At least 1 person, with phone.',
      referenceName: 'Their name',
      referenceNamePlaceholder: 'Former employer or colleague',
      referencePhone: 'Their phone number',
      referencePhonePlaceholder: '10-digit mobile',
      referenceRelation: 'How they know you',
      referenceRelationPlaceholder: 'e.g. Former manager',
      referenceEmail: 'Their email (optional)',
      referenceEmailPlaceholder: 'name@example.com',
      referenceEmailInvalid: 'That email does not look right.',
      referenceAdd: 'Add reference',
      referenceRemove: 'Remove',
      referenceNameNeeded: 'Give a name for this reference.',
      referenceTooMany: 'Only 3 references are needed.',
      referenceMaxNote: 'Three references is the most this form takes — remove one to change them.',

      referralTitle: 'Who referred you',
      referralToggle: 'Someone referred me',
      referralNote: 'One of our assayers, our staff, a bank branch — give their mobile or email.',
      referralType: 'Who they are',
      referralTypePlaceholder: 'Choose',
      referralName: 'Their name',
      referralMobile: 'Their mobile',
      referralEmail: 'Their email',
      referralClear: 'Clear',
      referralByHr: '%{who} — recorded by our HR team. Tell them if this is not right.',

      categoryTitle: 'How do you work?',
      freelancer: 'Freelancer',
      freelancerDesc: 'You work on your own and take valuation jobs as scheduled.',
      freelancerDocs: 'Needs: experience certificate or letter',
      proprietor: 'Proprietor',
      proprietorDesc: 'You own or run a registered jewellery shop or assaying firm.',
      proprietorDocs: 'Needs: shop establishment proof + association letter',
      categoryDocsKept:
        'What you already sent for %{documents} is not needed for this choice. It stays on your application, and HR can still see it.',

      idNumbersTitle: 'ID numbers',
      pan: 'PAN number',
      panPlaceholder: 'ABCDE1234F',
      aadhaar: 'Aadhaar number',
      aadhaarPlaceholder: '12 digits',

      bankTitle: 'Bank account for payments',
      bankNote: 'Enter your IFSC code first — we fill in the bank name.',
      bankAccountNumber: 'Bank account number',
      bankAccountPlaceholder: '9–18 digits',
      bankAccountConfirm: 'Re-enter account number',
      bankAccountConfirmPlaceholder: 'Type it again, from your passbook',
      ifsc: 'IFSC code',
      ifscPlaceholder: 'e.g. SBIN0001234',
      ifscLooking: 'Checking the IFSC code…',
      ifscFound: '%{bank}, %{branch} — bank name filled in below.',
      ifscFoundKept: 'This code is %{bank}, %{branch}. Keeping the name you typed: “%{typed}”.',
      ifscNotFound: 'We could not find this IFSC code — check your passbook, or type the bank name.',
      bankName: 'Bank name',
      bankNamePlaceholder: 'Filled in from the IFSC code, or type it',
      bankChecked: 'Checked from the IFSC code.',
      bankEdit: 'Edit anyway',

      qualification: 'Highest education',
      qualificationPlaceholder: 'e.g. B.Com, Diploma in Gemology',
      qualificationHint: 'As written on your certificate.',

      emergencyTitle: 'Emergency contact',
      emergencyHint: 'Family member we can call.',
      emergencyName: 'Contact name',
      emergencyNamePlaceholder: 'e.g. Sunita Sharma',
      emergencyPhone: 'Contact phone',
      emergencyRelation: 'Relationship',
      chooseRelation: 'Choose relationship',
      relationOther: 'Other — type it',
      relationOtherPlaceholder: 'e.g. Uncle, Neighbour',
      alternatePhone: 'Your other number (optional)',
      alternatePhonePlaceholder: 'Optional second number',
    },

    /** Month names for the date-of-birth picker, January first. */
    months: {
      jan: 'January',
      feb: 'February',
      mar: 'March',
      apr: 'April',
      may: 'May',
      jun: 'June',
      jul: 'July',
      aug: 'August',
      sep: 'September',
      oct: 'October',
      nov: 'November',
      dec: 'December',
    },

    errors: {
      fullNameRequired: 'Enter your full name exactly as on your Aadhaar or PAN.',
      fullNameTooShort: 'That name looks too short — enter your full name.',
      emailInvalid: 'That email address does not look right.',
      dateOfBirthRequired: 'Choose your date of birth — day, month and year — as on your Aadhaar or PAN.',
      dobUnreadable: 'Choose the day, the month and the year.',
      dobFuture: 'A date of birth cannot be in the future — check the year.',
      dobTooEarly: 'That year is before %{value} — check it against the date on your ID.',
      dobTooYoung: 'You must be at least %{min} to register — that date makes you %{count}.',
      dobTooOld: 'That date makes you %{count}, which is past the age we can register — check the year against your ID.',
      accountConfirmMissing: 'Type the account number a second time to confirm it.',
      accountConfirmMismatch: 'The two account numbers do not match — check each digit against the passbook.',
      pincodeRequired: 'Enter your 6-digit pincode.',
      pincodeInvalid: 'A pincode is exactly 6 digits.',
      stateRequired: 'Choose your state.',
      cityRequired: 'Enter your city or town.',
      addressRequired: 'Enter your full home address (house no., building, street).',
      addressTooShort: 'Please enter your complete address so we can find you.',
      employmentCategoryRequired: 'Choose Freelancer or Proprietor — it decides which documents we ask for.',
      panInvalid: 'A PAN looks like ABCDE1234F — five letters, four digits, one letter.',
      aadhaarInvalid: 'An Aadhaar number is 12 digits — check it against the card.',
      ifscInvalid: 'An IFSC code looks like HDFC0001234 — four letters, a zero, then six characters.',
      bankAccountInvalid: 'A bank account number is 9–18 digits.',
      phoneInvalid: 'That does not look like a 10-digit mobile number.',
      tooLong: 'Keep this under %{max} characters (%{length} now).',
      outOfRange: 'Choose between %{min} and %{max} years.',
      checkAnswer: 'Check this answer.',
      hintPan: 'A PAN looks like ABCDE1234F — five letters, four digits, one letter.',
      hintIfsc: 'An IFSC code looks like HDFC0001234 — four letters, a zero, then six characters.',
      hintAadhaarLength: 'An Aadhaar number is 12 digits.',
      hintAadhaarChecksum: 'These 12 digits are not a real Aadhaar number — check them against the card.',
      hintPincode: 'A pincode is exactly 6 digits.',
      hintBankAccount: 'A bank account number is 9 to 18 digits — numbers only, exactly as printed in the passbook.',
    },

    documents: {
      title: 'Documents',
      titleFreelancer: 'Freelancer documents',
      titleProprietor: 'Proprietor documents',
      hint: 'Lay flat, good light, all 4 corners.',
      photoRow: 'Clear face photo, for your ID card.',
      onlyIfRented: 'Only if your address differs from Aadhaar',
      onlyIfShopRented: 'Only if your shop is rented',
      onlyIfApplicable: 'Only if it applies to you',
      passbookNote: 'The page with your name, account number and IFSC. A cancelled cheque or bank statement is also fine.',
      missingRequired: 'Add your %{document} before submitting.',
      added: 'Added',
      takePhoto: 'Take photo',
      orChooseFile: 'or choose file',
      orChooseGallery: 'or choose from gallery',
      chooseFile: 'Choose file',
      retake: 'Retake',
      remove: 'Remove',
      removeTitle: 'Remove this file?',
      removeBody: 'It is taken off your application. You can add it again.',
      removeFailedTitle: 'Could not remove that',
      uploading: 'Uploading…',
      cameraDenied: 'Camera is off for Orbit.',
      openSettings: 'Allow camera in Settings',
      previewFile: 'File %{index} of %{count}',
      previewOpen: 'Open file',
      previewNotImage: 'This file is a PDF. Open it to check it.',
      uploadFailedTitle: 'Could not upload that',
      none: 'Choose Freelancer or Proprietor in step 3 to see the documents needed.',
    },

    checklist: {
      title: 'Still needed:',
      phone: 'Verify your mobile number',
      fullName: 'Your full name',
      category: 'Freelancer or Proprietor',
      photo: 'Your face photo',
      document: '%{document}',
    },

    submit: {
      button: 'Submit',
      failedTitle: 'Could not submit',
    },

    status: {
      pendingTitle: 'Submitted. HR will call you.',
      approvedTitle: 'Approved.',
      rejectedTitle: 'Not approved.',
      reviewNote: 'Review note: %{note}',
      withdrawnTitle: 'Withdrawn.',
      withdrawnBody: 'What you gave us is deleted, apart from a note that you applied and withdrew. Ask HR for a new link to apply again.',
      awaitingInfoTitle: 'HR asked for more information',
      awaitingInfoFallback: 'Please check and update your details.',
      fixItem: 'Fix',
      refLabel: 'Your reference',
      help: 'Questions? Contact the HR person who invited you.',
    },

    /**
     * The road after the form: the steps, the one "what happens next" sentence, the paused line and
     * the headings of HR's asks. The English is not written out here — it is `candidate-journey.ts`
     * in @fapoms/shared, which the web link draws the same page from, so the phone and the browser
     * cannot drift into saying different things. A translation still goes under these keys in its
     * own locale file, like any other.
     */
    journeySteps: CANDIDATE_JOURNEY_STEP_WORDS,
    journeyNext: CANDIDATE_JOURNEY_NEXT_WORDS,
    journey: CANDIDATE_JOURNEY_WORDS,
  },

  /**
   * Sentences for the failures the app can actually recognise.
   *
   * Two sources feed these: messages the mobile API layer produces itself, and the handful of
   * backend messages that are stable enough to match on. Anything unrecognised still renders
   * the server's own English — see `server-errors.ts` for why that is the honest default and
   * what would have to change on the backend to close the gap.
   */
  errors: {
    network: 'No connection. Check your signal and try again.',
    serverUnreachable: 'Could not reach the server. Try again in a moment.',
    notSignedIn: 'You are signed out. Sign in again.',
    sessionExpired: 'Your session has ended. Sign in with your password.',
    invalidCredentials: 'That Assayer Code or password is not right. Try again.',
    accountLocked: 'This account is locked for now. Try again later, or ask the office.',
    accountInactive: 'This account is not switched on. Ask the office about it.',
    noPasswordSet: 'No password is set on this account. Ask your HR contact to set one.',
    currentPasswordWrong: 'Your current password is not right.',
    passwordTooShort: 'Choose a password of at least 8 characters.',
    passwordTooEasy: 'That password is too easy to guess. Choose a different one.',
    passwordFieldsMissing: 'Enter your current password and your new one.',
    notYourRecord: 'You can only change your own record.',
    badCoordinates: 'Your phone reported a place we cannot use. Try again outside.',
    noFileChosen: 'No file was chosen. Pick a file and try again.',
    fileGone: 'That photo is no longer on this phone. Take it again.',
    uploadNotArrived: 'This did not reach the office. It will be sent again.',
    unknownState: 'We do not recognise that state. Choose one from the list.',
    accessOnHold: 'Your access is on hold. Please speak to your HR contact.',
    accountClosed: 'This account is closed. If you think that is wrong, speak to your HR contact.',
    passwordChangeRequired: 'Set a new password before you carry on.',
    /**
     * An onboarding session, which may reach the registration screens and nothing else.
     *
     * Worded as a next step, not a closed door: these accounts CAN sign in now, and the person
     * can finish their own paperwork from the app while the joining checks run.
     */
    registrationInProgress:
      'You can finish your registration here. The office will open the rest of the app once your joining checks are done.',
    lockedOneMinute: 'Too many wrong tries. Try again in 1 minute.',
    lockedMinutes: 'Too many wrong tries. Try again in %{count} minutes.',
    generic: 'That did not work. Please try again.',
    requestAlreadySent: 'This was already sent with different details. Reload and try again.',
    assignmentChanged: 'This assignment was changed by someone else. Reload and try again.',
    assignmentOutOfSync: 'This assignment is out of sync with the server. Reload and try again.',
    fileNotAccepted: 'That file could not be accepted. Choose a clearer photo or PDF and try again.',
    fileTypeNotAllowed: 'That file type is not accepted here. Use a photo or PDF.',
    fileTooLarge: 'That file is too large to send. Use a smaller photo or PDF.',
    /**
     * Refusals on a job, chosen by the server's code. These sentences are general on purpose: the
     * server's own English carries the specifics (the dates, the distance), and in English that
     * sentence is shown instead — see `server-errors.ts` (`BY_CODE_GENERAL`).
     */
    assayerOnLeave: 'You are on leave on the day of this job, so it cannot be accepted. Ask operations to move the date or give it to someone else.',
    notScheduledToday: 'This job is not for today. Check-in opens on the day of the job. If the visit has moved, ask operations to change the date first.',
    notYourAssignment: 'This job is no longer assigned to you. Pull down to refresh your list.',
    assayerNotActive: 'Your account is not active, so you cannot take on or start work. Contact HR.',
    invalidStateForCheckIn: 'Accept this job before you check in.',
    complianceBlocked: 'You cannot take on new work until a check on your record is sorted out. Contact HR.',
    invalidAssignmentTransition: 'This job has already moved on and cannot be changed from here. Pull down to refresh.',
    tooFarFromBranch: 'You seem to be too far from the branch. Check-in works only at the branch itself. Step outside for a clear GPS fix and try again.',
    acceptDateUnavailable: 'That date cannot be used for this job. Ask operations for another date.',
    reassignAfterCheckIn: 'You have already checked in to this job, so it cannot be given to someone else. Speak to operations.',
    officeCheckInReasonRequired: 'The office must give a reason when it checks someone in.',
  },

  /**
   * Actions saved on the phone ("it will send by itself") that the server then refused. They stay
   * listed until the assayer dismisses them, so a refused check-in or claim never vanishes.
   */
  queue: {
    refusedTitle: 'Not accepted by the office',
    refusedNotifyTitle: '%{what} was not accepted',
    refusedLine: '%{what}: %{reason}',
    refusedFallback: 'The office did not accept it.',
    dismiss: 'OK',
    dismissAccessibility: 'Dismiss: %{what}',
    kinds: {
      CHECK_IN: 'Your check-in',
      CHECK_OUT: 'Your check-out',
      ASSIGNMENT_STATUS: 'Your answer to a job offer',
      EXPENSE_CLAIM: 'Your expense claim',
      QUERY_MESSAGE: 'Your reply',
    },
  },

  profile: {
    photo: {
      label: 'Photograph',
      add: 'Add your photo',
      change: 'Change your photo',
      addHint: 'Tap to add your photo. Branches use it to know who has arrived.',
      changeHint: 'Tap to change your photo.',
    },
    status: { active: 'ACTIVE', incomplete: 'INCOMPLETE' },
    employment: { inHouse: 'In-house', contract: 'Contract' },
    editing: { edit: 'Edit', done: 'Done editing' },
    saveChanges: 'Save changes',
    footer: 'Orbit Field Assayer •',
    identity: {
      /** Shown before the name arrives, and as the avatar's initials source. */
      fallbackName: 'Field Assayer',
      avatarFallback: 'Assayer',
    },
    gaps: {
      accessibility: '%{count} profile details missing — open the section to fix them',
      oneMissing: '%{field} is missing.',
      manyMissing: '%{count} details missing, including %{field}.',
      /**
       * The field names interpolated here come from `@fapoms/shared`, which has no catalogue of
       * its own — see the handover note. In Hindi this sentence therefore reads as translated
       * prose around an English list of field names, which is imperfect but truthful; the
       * alternative is a second, drifting copy of the shared field labels living in this app.
       */
      waitingOnHr: 'Waiting on HR: %{fields}.',
      heldUp: 'Payments and assignments can be held up without these.',
      backOffice: 'They are held by the back office, so you cannot change them here.',
      complete: 'Your record is complete.',
    },
    stats: {
      completed: 'Completed',
      assigned: 'Assigned',
      rating: 'Rating',
      ratingHint: 'out of 5',
    },
    sections: {
      profile: 'Profile',
      work: 'Work',
      performance: 'Performance',
      app: 'App',
      account: 'Account',
      help: 'Help & Support',
      session: 'Session',
    },
    rows: {
      contact: 'Contact',
      contactHint: 'Add your phone number',
      address: 'Address',
      addressHint: 'Where you are based',
      emergency: 'Emergency contact',
      emergencyHint: 'Who to call if something happens on site',
      availability: 'Availability',
      availabilityHint: "Mark days you're unavailable — you won't be offered audits then.",
      availabilityAccessibility: 'Set your time off',
      capability: 'Capability',
      capabilityHint: '%{skills} skills · %{languages} languages',
      capacity: 'Capacity',
      capacityHint: 'How much work you can take',
      payment: 'Payment details',
      paymentHint: 'Bank account and PAN',
      performance: 'Performance',
      performanceHint: '%{rate}% completion rate',
      performanceHintEmpty: 'Your assignment history and ratings',
      appearance: 'Appearance',
      appearanceFallback: 'Theme',
      notifications: 'Notifications',
      pushUpdating: 'Updating this device with the server…',
      pushOn: 'Push notifications on',
      pushOff: 'Push notifications off',
      location: 'Location & Recommendations',
      liveOn: 'Live location sharing on',
      liveOff: 'Live location sharing off',
      connection: 'Connection',
      security: 'Security & Biometrics',
      biometricOn: 'Biometric lock on',
      biometricOff: 'Password and biometric lock',
      accreditation: 'Accreditation & License',
      licenceNumber: 'License No: %{number}',
      noLicence: 'No licence number on file',
      feedback: 'Support',
      feedbackHint: 'Report a bug, suggest an improvement, or ask the product team a question',
      feedbackAccessibility: 'Open Help & Support',
      signOut: 'Sign out',
      signOutHint: "You'll need your password to sign back in",
    },
    signOutConfirm: {
      title: 'Sign out of Orbit?',
      body: "You'll need your password to sign back in.",
      accessibility: 'Sign out of Orbit',
    },
    attributes: {
      /** Chip offered under a skill/language search box for a value typed that is not already
       *  on the roster's vocabulary - the "add a genuinely new one" escape hatch. */
      addNew: 'Add "%{name}"',
    },
    fields: {
      phone: 'Phone',
      alternatePhone: 'Alternate phone',
      email: 'Email',
      emailPlaceholder: 'you@example.com',
      address: 'Address',
      addressPlaceholder: 'Flat / house, building, street',
      city: 'City',
      pincode: 'Pincode',
      pincodePlaceholder: '6 digits',
      district: 'District',
      state: 'State',
      stateLabel: 'State',
      name: 'Name',
      relation: 'Relation',
      relationOtherPlaceholder: 'Who are they to you?',
      skills: 'Skills',
      skillsPlaceholder: 'Search or type to add a skill…',
      languages: 'Languages',
      languagesPlaceholder: 'Search or type to add a language…',
      experienceYears: 'Experience (years)',
      maxPerDay: 'Max per day',
      maxPerWeek: 'Max per week',
      preferredRegions: 'Preferred regions',
      bankAccount: 'Bank account',
      ifsc: 'IFSC',
    },
    address: {
      chooseState: 'Choose a state',
      chooseStateAccessibility: 'Choose state',
      chooseRegions: 'Choose the regions you can work in',
      chooseRegionsAccessibility: 'Choose preferred regions',
      /** Suffix after an off-list region value this screen still shows rather than drops - see
       *  `RegionMultiSelect` in ProfileScreen.tsx and `profile-preferred-regions.ts`. */
      asRecordedSuffix: '(as recorded)',
      homeLocation: 'Home location',
      finding: 'Finding you…',
      useCurrent: 'Use my current location',
      useThisPin: 'Use this pin',
      placePin: 'Place the pin on a map',
      noPin: 'No home location on file yet.',
      pinExplainer:
        'Your travel distance and travel claims are measured from this pin, so it decides which audits you are offered and what you are paid to reach them.',
      pincodeLookup: 'Looking up that pincode…',
      unrecognisedState:
        'Your device reported the state as “%{state}”, which isn\'t one we recognise — please pick it below.',
      pinSavedNoLookup:
        'Pin saved. This phone could not look up the address for it — please fill the fields below yourself.',
      pinSavedLookupFailed:
        'Pin saved. The address lookup did not respond — please fill the fields below yourself.',
      pincodeNotFound: 'Could not look that pincode up on this phone — fill the district and state yourself.',
      pincodeMovedPin: 'Pin moved to the centre of that pincode — drag the map to your exact home.',
      pincodeLookupFailed: 'Pincode lookup failed on this phone — fill the district and state yourself.',
      pinOutsideIndia: 'That point is outside India. Move the pin to your home address before saving.',
      permissionOff:
        'Location permission is off. Allow location for Orbit in your phone settings, or place the pin on the map instead.',
      fixOutsideIndia: 'Your phone reported a position outside India. Place the pin on the map instead.',
      noFix:
        'Could not get a location fix. Step outside or near a window and try again, or place the pin on the map.',
    },
    theme: {
      label: 'Theme',
      hint: "Follow your phone's setting, or pin the app to one mode.",
      system: 'System',
      light: 'Light',
      dark: 'Dark',
      accessibility: '%{name} theme',
      accessibilitySelected: '%{name} theme, selected',
    },
    notifications: {
      push: 'Push notifications',
      pushHint: 'New assignments, clarifications and payment updates',
      whichAlerts: 'WHICH ALERTS',
      loading: 'Loading your alert preferences…',
      unavailable: 'Alert preferences unavailable offline.',
      sound: 'Sound alerts',
      soundHint: 'Play a chime when a notification arrives',
      /**
       * Plain-language names for the notification categories.
       *
       * The API returns enum values (ASSIGNMENT, BILLING…), which are not what a field assayer
       * should be reading. Keyed by the enum so the mapping cannot drift from the API.
       */
      categories: {
        ASSIGNMENT: 'Assignments',
        VALIDATION: 'Clarifications',
        DOCUMENT: 'Documents',
        PLANNING: 'Planning',
        WORKFORCE: 'Your record',
        BILLING: 'Payments',
        SYSTEM: 'System',
        FEEDBACK: 'Feedback',
      },
      categoryHints: {
        ASSIGNMENT: 'New offers, acceptances and cancellations',
        VALIDATION: 'Questions raised on your submitted reports',
        DOCUMENT: 'Paperwork dispatched to you, or sent back for re-upload',
        PLANNING: 'Coverage and scheduling changes affecting your branches',
        WORKFORCE: 'Certification expiry and profile changes',
        BILLING: 'Expense decisions and payouts',
        SYSTEM: 'Service notices and app updates',
        FEEDBACK: 'Replies to problems and ideas you sent us',
      },
    },
    location: {
      share: 'Share live location',
      shareHint:
        'Off by default. When on, your current position — not your home address — is used to rank you for nearby audits, like ride-hailing apps.',
      syncing: 'Syncing your sharing preference…',
      active: 'Live position active — recommendations use where you are now',
    },
    security: {
      changePassword: 'Change password',
      changePasswordHint: 'Update the password you sign in with',
      biometricLock: 'Biometric Lock',
      biometricLockHint:
        'Require your fingerprint or face to open Orbit, and after two minutes away from the app',
      sensor: 'Hardware sensor',
      sensorEnrolled: 'Fingerprint or face recognition enrolled on this device',
      sensorNotEnrolled:
        'Sensor present, but no fingerprint or face is enrolled. Add one in your phone settings.',
      sensorNone: 'This device has no biometric sensor. Sign in with your password.',
      sensorChecking: 'Checking…',
      ready: 'READY',
      unavailable: 'UNAVAILABLE',
    },
    accreditation: {
      certified: 'BIS / NABL Certified Assayer',
      verified: 'VERIFIED',
      notOnFile: 'NOT ON FILE',
      footnote:
        'Authorised for precious metal purity testing, gold ornament packet sealing, and bank collateral audits.',
    },
    connection: {
      server: 'Server',
      checking: 'CHECKING',
      online: 'ONLINE',
      offline: 'OFFLINE',
      check: 'Check connection',
      checkInProgress: 'Checking…',
    },
    /** Why a field cannot be edited on the phone. One sentence per field; the lock rule is elsewhere. */
    save: {
      notSignedInTitle: 'Not signed in',
      notSignedInBody: 'Sign in again before saving your profile.',
      noChanges: 'No changes to save',
      notSavedTitle: 'Not saved',
      notSavedBody: 'Your profile could not be saved. Please try again.',
      saved: 'Profile saved',
    },
    lockReasons: {
      fallback: 'Held by the back office — ask HR to change it.',
      maxDailyWorkload: 'Set by operations — it decides how much work you can be offered.',
      maxWeeklyWorkload: 'Set by operations, alongside your daily limit.',
      panNumber: 'Held by HR. Contact your HR coordinator to correct this.',
      bankAccountNumber:
        'Payment details are changed by HR only, so a payout cannot be redirected from a handset.',
      ifscCode: 'Changed by HR alongside your bank account.',
      joiningDate: 'Set by HR — it drives tenure, leave and settlement.',
      employmentType: 'Set by HR as part of your contract terms.',
      performanceRating: 'Recorded by operations from completed work.',
      paymentHeader:
        'Held by HR for payouts and statutory filing. Changes are reviewed before they take effect.',
    },
  },

  /**
   * Relative-day wording, shared by the home screen, the schedule and earnings.
   *
   * These live in one place because two screens previously each phrased the same day
   * differently. They interpolate a count rather than pluralising through i18n-js, for the
   * reason given at the top of this file.
   */
  dates: {
    unscheduled: 'Unscheduled',
    today: 'Today',
    tomorrow: 'Tomorrow',
    /** Backwards-looking pair, for money that has already moved. */
    yesterday: 'Yesterday',
    daysAgo: '%{count} days ago',
    inDays: 'In %{count} days',
    oneDayOverdue: '1 day overdue',
    daysOverdue: '%{count} days overdue',
    groupToday: 'Today · %{date}',
    groupTomorrow: 'Tomorrow · %{date}',
    groupOverdue: 'Overdue · %{date}',
  },

  /** The app shell: tab names and the header's icon buttons. */
  shell: {
    tabs: { home: 'Home', route: 'Route', queries: 'Queries', earnings: 'Earnings' },
    openProfile: 'Open your profile',
    uploadsFailed: 'Uploads, %{count} did not send',
    uploadsSending: 'Uploads, %{count} sending',
    notifications: 'Notifications',
    notificationsUnread: 'Notifications, %{count} unread',
    brand: 'Sumeru Global',
    /** The header's second line: the assayer's own code, or their role when none is on file. */
    codeLabel: 'Code: %{code}',
    roleFallback: 'Field Assayer',
    /**
     * The crash screen. The line beneath it is the JavaScript error's own text, which cannot be
     * translated and is not written for this reader — it stays only because it is the one thing
     * somebody can read out to the office when nothing else works.
     */
    crashFallback: 'App encountered an error',
    confirm: 'Confirm',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    mapAttribution: '© OpenStreetMap contributors · Protomaps · Natural Earth',
  },

  home: {
    greetingMorning: 'Good morning',
    greetingAfternoon: 'Good afternoon',
    greetingEvening: 'Good evening',
    stale: 'Showing your last synced schedule%{since}. Pull down to retry.',
    staleSince: ' from %{time}',
    emptyTitle: 'Nothing scheduled',
    emptyBody: 'You have no open assignments. New work will appear here as soon as it is assigned.',
    oneOffer: 'New offer',
    manyOffers: 'New offers (%{count})',
    seeAllOffers: 'See all %{count} offers',
    seeAll: 'See all',
    today: 'Today',
    seeAllToday: 'See all %{count} assignments scheduled today',
    scheduledToday: 'Scheduled today',
    scheduledTodayValue: 'Scheduled today: %{count}',
    openQueries: 'Open queries',
    openQueriesValue: 'Open queries: %{count}',
    claimsPending: 'Claims awaiting approval',
    distanceKm: '%{km} km',
    customers: '%{count} customers',
    accept: 'Accept',
    decline: 'Decline',
    scanReturn: 'Scan audited return',
    checkIn: 'Check in at branch',
    navigate: 'Navigate',
    checkOut: 'Check out',
    details: 'Details',
    /** A job not on today (IST): no Check-in button, just when it is. */
    jobOnDate: 'Your job is on %{date}',
    checkInNotAvailable: 'Check-in is not available for this job right now.',
    acceptNotAvailable: 'This offer cannot be accepted right now.',
    /** A reopened job with no check-in: only the papers are left to redo. */
    redoPapers: 'Send the papers again',
  },

  schedule: {
    title: 'Schedule',
    tabActive: 'Active',
    tabHistory: 'History',
    emptyActiveTitle: 'No active stops',
    emptyActiveBody: 'New branch assignments appear here as soon as operations dispatch them to you.',
    emptyDoneTitle: 'Nothing completed yet',
    emptyDoneBody: 'Audits you finish or decline are kept here for your records.',
    oneStop: '1 stop',
    manyStops: '%{count} stops',
    factDate: 'Date',
    factPackets: 'Packets',
    accept: 'Accept',
    decline: 'Decline',
    navigate: 'Navigate',
    checkIn: 'Check in',
    scanAndSubmit: 'Scan & submit audited return',
    leftAt: 'Left the branch at %{time}',
    checkOut: 'Check out',
    opening: 'Opening…',
    downloadPacket: 'Download audit packet',
    packetNotSent: 'The audit packet has not been sent for this branch yet.',
    packetUnavailable: 'This document is not available to download right now.',
    downloadStarted: 'Download started — check your browser or downloads.',
    downloadFailed: 'Could not open the audit packet.',
    oneClarification: '1 clarification from the desk',
    manyClarifications: '%{count} clarifications from the desk',
    historyComplete: 'That is your complete job history.',
    loadingOlder: 'Loading older jobs…',
    showOlder: 'Show older jobs',
  },

  uploads: {
    title: 'Uploads',
    subtitle: 'Everything you have sent to the office',
    oneFailed: '1 item did not send. Tap Retry.',
    manyFailed: '%{count} items did not send. Tap Retry.',
    emptyTitle: 'Nothing to send',
    emptyBody:
      'Anything you scan or attach shows here until it reaches the office. If something fails to send, you can try again from here.',
    status: {
      sent: 'Sent',
      sending: 'Sending',
      pending: 'Waiting to send',
      failed: 'Not sent',
    },
    progressSent: '%{percent}% sent',
    starting: 'Starting…',
    keepsGoing: '%{progress} — you can leave this screen, it keeps going.',
    /**
     * Two nouns, because "packet" is the audit-return word and means nothing on a photograph of
     * a PAN card. The list carries both kinds, so each row says what it actually holds.
     */
    failedPacket: 'This packet did not reach the office.',
    failedDocument: 'This document did not reach the office.',
    tapRetry: '%{reason} Tap Retry to send it again.',
    remove: 'Remove',
    removeConfirmTitle: 'Remove this without sending it?',
    removeConfirmBody: 'The office will not receive it. You will need to scan or attach it again.',
    delivered: 'Delivered %{time}',
    clear: 'Clear',
    clearAccessibility: 'Clear %{title} from the list',
    fallbackDocument: 'Document',
    fallbackPacket: 'Audit packet',
  },

  /**
   * The assignment lifecycle: accept, decline, arrive, leave.
   *
   * Separate from `home` because the same sentences fire from the Home cards, the Route list
   * and the assignment detail view — the copy belongs to the action, not to the screen the
   * assayer happened to start it from.
   */
  assignment: {
    historyFailedTitle: 'Could not load older jobs',
    historyFailedBody: 'The connection dropped. Try again in a moment.',
    acceptFailedTitle: 'Not accepted',
    acceptFailedBody: 'The assignment could not be accepted.',
    reasonRequiredTitle: 'Add a reason',
    reasonRequiredBody:
      'Tell the desk why you are declining — too far, fee too low, date impossible. They need it to re-plan the branch.',
    declineFailedTitle: 'Not declined',
    declineFailedBody: 'The assignment could not be declined.',
    /**
     * Arriving and leaving both refuse without a real device fix, and both say the same three
     * things to do about it. One body, two titles, so the assayer is told which action they are
     * being stopped from completing.
     */
    locationNeededCheckIn: 'Location needed to check in',
    locationNeededCheckOut: 'Location needed to check out',
    locationNeededBody:
      'We could not get your location. Turn on location for this app, step outside if you are indoors, then try again.',
    checkedInTitle: 'Checked in',
    checkedInBody: 'Checked in at %{branch}',
    checkInFailedTitle: 'Could not check in',
    checkInFailedBody: 'Check-in failed. Please try again.',
    /** The connection dropped mid-call, so the app genuinely does not know which way it went. */
    // Check-in taken with no signal: saved on the phone and sent by itself. The server records
    // the time it ARRIVES (it stamps check-in on receipt), so the sentence says so rather than
    // letting anybody believe the tap time is what the audit will show.
    checkInSavedOffline:
      'Your check-in at %{branch} will be sent when you are back online. The time recorded is when it arrives.',
    serverUnreachableTitle: 'Could not reach the server',
    checkOutConfirmTitle: 'Check out of this branch?',
    checkOutConfirmBody:
      'This records that you have left %{branch}. It does not submit your audit — you can still upload paperwork afterwards. The time cannot be changed once recorded.',
    checkOutConfirmCancel: 'Not yet',
    checkOutConfirmAccept: 'Check out',
    checkedOutTitle: 'Checked out',
    checkedOutBody: 'You have left %{branch}. Upload your paperwork when it is ready.',
    checkOutFailedTitle: 'Could not check out',
    checkOutFailedBody: 'Check-out failed. Please try again.',
    checkOutSavedOffline:
      'Your check-out from %{branch} will be sent when you are back online. The time recorded is when it arrives.',
    /** Sending the return finishes the job, after which check-out can no longer be recorded. */
    checkOutBeforeReturnTitle: 'Check out first?',
    checkOutBeforeReturnBody:
      'You are still checked in at %{branch}. Sending the papers finishes the job, and your leaving time can no longer be recorded after that.',
    checkOutBeforeReturnCheckOut: 'Check out, then send',
    checkOutBeforeReturnSendAnyway: 'Send without checking out',
  },

  scan: {
    purpose: 'Audited return for this assignment',
    queuedTitle: 'Added to uploads',
    queuedOne: '1 page sending in the background. Check Uploads for progress.',
    queuedMany: '%{count} pages sending in the background. Check Uploads for progress.',
    uploadingTitle: 'Uploading',
    uploadingBody: 'Sending %{file}…',
    uploadedTitle: 'Upload complete',
    uploadedOne: '1 page uploaded as %{file}.',
    uploadedMany: '%{count} pages uploaded as %{file}.',
    failedTitle: 'Upload failed',
    failedBody: '%{file} was not uploaded. Please retry before leaving the branch.',
    /** The transport had something to say about why. Kept, because it is often actionable. */
    failedBodyReason: '%{file} was not uploaded: %{reason}. Please retry before leaving the branch.',
    /**
     * The page-by-page fallback path (no PDF could be assembled), which reports per page.
     * The singular sentence is written out rather than counted: "All 1 page were uploaded" is
     * what the old inline pluralisation produced.
     */
    allUploadedOne: 'The page was uploaded.',
    allUploadedMany: 'All %{count} pages were uploaded.',
    /**
     * The packet arrived and the job is still open — since the departure rule, filing the return
     * closes an assignment only when the attendance record stands on its own. Worded as an
     * instruction rather than an error, because nothing went wrong with the upload and the fix is
     * one the assayer can do before they drive away.
     */
    notClosedTitle: 'Sent — the job is still open',
    notClosedBody:
      '%{file} reached the desk, but the visit is not closed yet: %{reason} Check out on site, or ask the desk to close it.',
    notClosedBodyNoReason:
      '%{file} reached the desk, but the visit is not closed yet. Check out on site before leaving, or ask the desk to close it.',
    partialTitle: 'Some pages did not upload',
    partialOne:
      '%{uploaded} of %{total} uploaded. Page %{pages} failed — please scan it again before leaving the branch.',
    partialMany:
      '%{uploaded} of %{total} uploaded. Pages %{pages} failed — please scan them again before leaving the branch.',
  },

  expense: {
    title: 'Log an expense',
    categoryLabel: 'Expense category',
    /**
     * The four claim categories as words.
     *
     * The API's enum (`TRAVEL_KM`) reached the confirmation toast verbatim — "TRAVEL_KM for
     * ₹250 is awaiting approval" — because the toast interpolated the value the modal passes
     * back rather than the label it had just shown. Both ends read these keys now.
     */
    categories: {
      travelKm: 'Travel (km)',
      toll: 'Toll',
      food: 'Food',
      other: 'Other',
    },
    amountLabel: 'Amount (₹)',
    amountPlaceholder: 'e.g. 250',
    overLimit:
      'Over the %{limit} limit for a single claim. Split it across claims, or ask operations to approve it separately.',
    limitHint: 'Up to %{limit} per claim.',
    descriptionLabel: 'Description',
    descriptionPlaceholder: 'Reason / notes',
    submit: 'Submit expense',
    noAssignmentTitle: 'No assignment selected',
    noAssignmentBody: 'Open the assignment you are claiming for and file the expense from there.',
    jobLabel: 'Which job is this for?',
    /** Claims are only for visits under way or done (checked in, working, completed). */
    noClaimableJobs: 'You can claim an expense once you have checked in to a job.',
    chooseJob: 'Choose the job this expense is for.',
    invalidAmountTitle: 'Enter a valid amount',
    invalidAmountBody: 'Use digits only, for example 1000 or 1,000.',
    filedTitle: 'Claim filed',
    filedBody: '%{amount} for %{category} is awaiting approval.',
    savedOfflineBody: 'Your claim will be sent by itself when you are back online.',
    failedTitle: 'Claim not filed',
    failedBody: 'The expense could not be submitted.',
  },

  issue: {
    title: 'Report an issue',
    subtitle: '%{branch} · the operations desk will be notified and will follow up.',
    problemLabel: 'What’s the problem?',
    /**
     * The five situations a field worker actually hits.
     *
     * Keyed locally rather than read from `@fapoms/shared`'s `assignmentIssueCategoryLabel`,
     * which composes English for the web desk and cannot be translated from here. The shared
     * function stays as the fallback for a category this build has not been taught.
     */
    categories: {
      cannotAttend: 'Cannot attend',
      branchInaccessible: 'Branch inaccessible',
      needsClarification: 'Needs clarification',
      safetyConcern: 'Safety concern',
      other: 'Other',
    },
    detailsLabel: 'Details (optional)',
    detailsPlaceholder: 'Add anything the desk needs to know…',
    sending: 'Sending…',
    send: 'Send to desk',
    sentTitle: 'Reported to desk',
    sentBody: 'The operations team has been notified and will follow up.',
    failedTitle: 'Not sent',
    failedBody: 'The issue could not be reported. Please try again.',
  },

  idCard: {
    title: 'My ID card',
    open: 'My ID card',
    openHint: 'Your digital ID — show it at the branch',
    close: 'Close',
    loadFailed: 'Your ID card could not be loaded.',
    notIssuedTitle: 'Your ID card is not issued yet',
    notIssuedBody: 'It appears here as soon as these are done. Your HR contact can help.',
    qrLabel: 'Verification QR code',
    codeLabel: 'Verification code',
    changesIn: 'New code in %{seconds}s',
    howToCheck: 'The branch scans the QR, or checks your ID number and this code at %{place}.',
    loadingCode: 'Getting your live code…',
    offline: 'Cannot reach the server. The card needs a connection to show a live code — a code that is not live proves nothing.',
    ifFound: 'If found, please call %{phone}',
    screenshotWarning: 'A screenshot of your ID card is not valid — its code stops working within two minutes. Always show the live card.',
  },

  availability: {
    title: 'Your availability',
    subtitle: 'Mark the days you are off. You will not be offered audits on those days.',
    previousMonth: 'Previous month',
    nextMonth: 'Next month',
    /** Single letters under the calendar columns. Sunday first, matching the grid. */
    dayInitials: {
      sun: 'S', mon: 'M', tue: 'T', wed: 'W', thu: 'T', fri: 'F', sat: 'S',
    },
    hintPickStart: 'Tap a start day, then an end day. Tap a marked day to remove it.',
    hintPickEnd: 'Now tap the last day of your time off.',
    markedTimeOff: 'marked as time off',
    selectedAsStart: 'selected as start',
    timeOff: 'TIME OFF',
    saving: 'Saving…',
    save: 'Save availability',
    savedTitle: 'Availability saved',
    savedBody: 'You won’t be offered audits on your days off.',
    failedTitle: 'Not saved',
    failedBody: 'Your availability could not be saved.',
  },

  /**
   * The invoice reveal-and-confirm sheet — the first place this app ever shows the assayer a
   * fee. The copy therefore does two jobs at once: explain what these numbers are, and make
   * the submission read as the deliberate act of consent it is.
   */
  invoice: {
    title: 'Your invoice',
    subtitle: 'Check every line before you submit. These are the amounts you are billing for.',
    loading: 'Loading your invoice…',
    loadFailed: 'Could not load your invoice. Check your connection and try again.',
    emptyTitle: 'No invoice to review',
    emptyBody: 'Operations has not invited you to bill yet. You will be notified here when they do.',
    itemsOne: '1 item',
    itemsMany: '%{count} items',
    lineFee: 'Audit fee',
    lineExpense: 'Expense',
    subtotalBase: 'Base subtotal',
    subtotalTravel: 'Travel subtotal',
    tdsDeducted: 'TDS deducted',
    total: 'Total for this invoice',
    submit: 'Submit invoice',
    /** The second, deliberate step: restate what is being agreed to, then ask. */
    confirmTitle: 'Submit this invoice?',
    confirmBodyOne:
      'You are submitting 1 item for %{total}. This submits your invoice for these amounts.',
    confirmBodyMany:
      'You are submitting %{count} items for %{total}. This submits your invoice for these amounts.',
    confirmCta: 'Yes, submit',
    confirmBack: 'Go back',
    submitting: 'Submitting…',
    /** The submit is online-only on purpose — consent must bind to the figures on screen. */
    submitOffline:
      'Could not reach the server, so nothing was submitted. Connect to the internet and tap Submit again.',
    submitConflict:
      'This invoice changed on the server. Its current state is shown below — check it again before doing anything.',
    submitFailed: 'Your invoice could not be submitted. Please try again.',
    submittedBadge: 'Submitted — awaiting approval',
    submittedNote:
      'Operations will check and approve this invoice. The amounts join your earnings once it is approved.',
    submittedToastTitle: 'Invoice submitted',
    submittedToastBody: 'Operations will review it. You will be notified when it is approved.',
  },

  earnings: {
    balanceLabel: 'BALANCE OWED TO YOU',
    balanceOwed: 'Owed to you across all completed work, after payments and TDS.',
    /**
     * The gated wording: once invoicing is on, the totals cover only approved invoices (plus
     * pre-invoicing rows), so the caption must not claim "all completed work" — completed
     * audits awaiting invoicing are counted on this screen but never priced.
     */
    balanceOwedGated: 'Owed to you across your approved invoices, after payments and TDS.',
    balanceSettled: 'You are fully settled — nothing outstanding right now.',
    /** No figure is shown at all when the statement cannot be read — only this. */
    statementFailed:
      'Could not load your statement. Pull down to try again — your money is safe, this screen just cannot read it right now.',
    statementLoading: 'Loading your statement…',
    chipEarned: 'Earned',
    chipPaid: 'Paid',
    chipPending: 'Pending',
    statExpenses: 'Expenses claimed',
    statAudits: 'Audits completed',
    statClaimsPending: 'Claims pending',
    statClaimsPendingHint: 'awaiting desk approval',
    emptyTitle: 'No earnings activity yet',
    emptyBody: 'Complete your first audit and your fees, payables and payments will build up here.',
    payoutsTitle: 'Payouts',
    payoutsEmptyTitle: 'Nothing raised yet',
    payoutsEmptyBody: 'A payout is raised the moment an audit completes — none are on your statement yet.',
    /** A hold is a flag over any of the three states, not a fourth one — hence the extra key. */
    payableStatus: {
      pending: 'Awaiting approval',
      approved: 'Approved, awaiting final approval',
      approvedForPayment: 'Approved for payment',
      paid: 'Paid',
      onHold: 'On hold',
      voided: 'Reversed',
    },
    expenseReimbursement: 'Expense reimbursement',
    outstanding: '%{amount} outstanding',
    /** The breakdown finance works from. TDS keeps its English name — see the note in `hi.ts`. */
    base: 'Base %{amount}',
    travel: 'Travel %{amount}',
    tds: 'TDS -%{amount}',
    /** The lifetime TDS-withheld chip, next to Earned/Paid/Pending — the web statement's
     *  equivalent (`AssayerStatementPage.tsx`) already shows this; the app previously did not. */
    chipTdsWithheld: 'TDS withheld (u/s %{section})',
    /** Which assayer invoice a payable rides, shown next to its own row. */
    invoiceLabel: 'Invoice %{number}',
    invoiceStatus: {
      invited: 'Sent to you',
      submitted: 'Submitted',
      approved: 'Approved, awaiting final approval',
      hodApproved: 'Approved for payment',
      paid: 'Paid',
      cancelled: 'Cancelled',
      superseded: 'Replaced by a newer invoice',
    },
    paymentsTitle: 'Payments received',
    paymentsSummary: 'What has already been paid to you',
    claimsTitle: 'Expense claims',
    claimsEmptyTitle: 'No claims yet',
    claimsEmptyBody: 'Log tolls, food and travel as you go — approved claims are reimbursed with your fees.',
    claimStatus: {
      approved: 'Approved',
      pending: 'Awaiting approval',
      rejected: 'Rejected',
    },
    /** The desk's reason, shown on a rejected claim — silently missing from this app before. */
    claimReviewNote: 'Reason: %{reason}',
    completedTitle: 'Completed audits',
    completedSummary: 'Your finished jobs',
    completedEmptyTitle: 'No earnings yet',
    completedEmptyBody: 'Your fee appears here the moment you complete your first audit.',
    /** A finished audit the billing engine has not raised a payout for yet (pre-gate wording). */
    notBooked: 'Not booked yet',
    /** The gated sibling of `notBooked`: the money exists but is not revealed until invoicing. */
    awaitingInvoicingRow: 'Awaiting invoicing',
    completedBadge: 'Completed',
    /** Rows earned before the invoicing gate existed — amounts visible under the old rules. */
    preInvoicingBadge: 'Pre-invoicing',
    /**
     * The earnings gate's cards. Counts only, never a rupee: the amounts first appear on the
     * invoice invitation itself, which the "review" button opens.
     */
    invoicing: {
      awaitingOne: '1 completed audit is awaiting invoicing',
      awaitingMany: '%{count} completed audits are awaiting invoicing',
      awaitingBody: 'Operations will invite you when they are ready to bill. Nothing is needed from you yet.',
      invitedTitle: 'Your invoice is ready to review',
      invitedBodyOne: 'Operations has prepared 1 item for you to check and submit.',
      invitedBodyMany: 'Operations has prepared %{count} items for you to check and submit.',
      reviewCta: 'Review & submit invoice',
      submittedTitle: 'Invoice submitted',
      submittedBody: 'Your invoice is with operations. The amounts join your earnings once it is approved.',
      viewCta: 'View submitted invoice',
    },
  },

  /**
   * Clarifications raised by the data entry desk about a packet the assayer submitted.
   *
   * One group across the list, the chat shell and the thread itself: the same nouns ("the
   * desk", "clarification", "packet") have to mean the same thing in all three, and an assayer
   * moves between them in a single sitting.
   */
  queries: {
    replySavedOffline: 'Your reply will be sent when you are back online.',
    tabNeedsAttention: 'Needs attention',
    tabAll: 'All',
    state: {
      needsYou: 'Needs your reply',
      withDesk: 'With the desk',
      resolved: 'Resolved',
    },
    /** How long the desk has been waiting on this assayer. Hours for the first day. */
    waitingOneDay: 'Waiting 1d',
    waitingDays: 'Waiting %{count}d',
    waitingHours: 'Waiting %{count}h',
    justNow: 'Just now',
    oneQuestion: '1 question',
    manyQuestions: '%{count} questions',
    allClearTitle: 'All clear — nothing waiting on you',
    noneTitle: 'No queries from the desk',
    emptyBody:
      'When the data entry desk cannot read something on a sheet you submitted, they ask here — with the exact area of the page marked.',
    historyBody: 'Everything below is settled history.',
    resolvedSection: 'Resolved · %{count}',
    /** Read aloud by the screen reader; the visible row says the same in three pieces. */
    rowAccessibility: '%{branch}, %{state}, %{count}',
    rowAccessibilityWaiting: '%{branch}, %{state}, %{wait}, %{count}',
    rowAccessibilityResolved: '%{branch}, resolved, %{count}',
    deskName: 'Data Entry Team',
    /** The avatar's initials. Follows the name above, so it changes with it. */
    deskInitials: 'DE',
    deskShort: 'Data entry',
    callDesk: 'Call the data entry team about this query',
    callFailedTitle: 'Call not started',
    callFailedBody: 'The call could not be placed.',
    /** A thread with neither a customer name nor an account number to identify it by. */
    tabFallback: 'Query %{number}',
    noneForBranch: 'No clarifications have been raised for this branch.',
    scanPurpose: 'Attach to this clarification',
    uploadFailedTitle: 'Upload failed',
    uploadFailedBody: '%{file} was not attached.',
    attachFailedTitle: 'Attachment failed',
    attachPickFailed: 'The file could not be selected.',
    packetNotHereTitle: 'Packet not open here',
    packetNotHereBody: 'Ask the desk to resend the mark from a newer message.',
    packetMissingTitle: 'Packet not available yet',
    packetMissingBody: 'The packet for this branch has not been sent yet.',
    packetOpenFailedTitle: 'Cannot open the packet',
    packetOpenFailedBody: 'This document is not available to open right now.',
    packetOpenErrorBody: 'This document could not be opened just now — please try again.',
    scanNotAttachedTitle: 'Not attached',
    scanNotAttachedBody: 'The scan could not be uploaded. Please retry.',
    scanNotSentTitle: 'Not sent',
    scanNotSentBody: 'The scan could not be sent.',
    scanSentTitle: 'Sent',
    scanSentOne: '1 page sent to the desk.',
    scanSentMany: '%{count} pages sent to the desk.',
    scanSendFailed: 'The scanned document could not be sent.',
    askedAbout: '%{who} asked about %{what}',
    thisPacket: 'this packet',
    account: 'A/C %{number}',
    loadFailed:
      'Could not load this thread. The desk may have replied — check your connection and try again.',
    noReplies: 'No replies yet. Answer below and the desk will see it immediately.',
    retryThread: 'Retry loading the thread',
    stale: 'Showing an older copy — tap to refresh',
    resolvedComposer: 'This clarification is resolved. The desk will reopen it if anything else is needed.',
    removeAttachment: 'Remove %{file}',
    attachFile: 'Attach a file',
    scanDocument: 'Scan a document',
    replyPlaceholder: 'Reply to the desk…',
    sending: 'Sending',
    sendReply: 'Send reply',
    sendFailedTitle: 'Not sent',
    sendFailedBody: 'Your message could not be delivered.',
    attachFailedBody: 'The file could not be attached.',
    cannotOpenTitle: 'Cannot open',
    cannotOpenBody: 'No app on this device can open that file.',
    markedOnPage: 'The desk marked this on page %{page}',
    seeMark: 'See where on your document →',
    seeMarkAccessibility: 'See where on your document the desk marked',
  },

  location: {
    /**
     * Shown after the pin is saved, when the written address disagrees with where the person
     * actually is. Deliberately not an error: the person did the right thing and their pin is now
     * correct — what still needs their help is the address text on the record, which is what goes
     * on documents and what gets looked up again if the pin is ever cleared.
     */
    addressMismatchTitle: 'Your location is saved — please check your address',
    addressMismatchState:
      'Your address says %{recorded}, but you are in %{actual}. Your map pin is now correct. Please open your profile and correct your address, so your documents and your travel are worked out from the right place.',
    addressMismatchDistance:
      'Your address points to a place about %{km} km away from where you are. Your map pin is now correct. Please open your profile and correct your address, so your documents and your travel are worked out from the right place.',
    confirmTitle: 'Confirm where you are based',
    confirmBody:
      'We could not place you accurately on the map. Tap below where you live or work from, so we send you jobs that are actually close by.',
    /**
     * Set into the location context's `errorMsg` rather than shown as a toast.
     *
     * These are captured when the failure happens, so a language change afterwards leaves the
     * banner in the old language until the next attempt. Acceptable: the fix for the banner is
     * to try again, which re-renders it.
     */
    permissionDenied: 'Permission to use your location was refused.',
    permissionError: 'Could not ask for location permission. Try again in a moment.',
    servicesOff: 'Location is turned off. Turn on location to check in at a branch.',
    noFix: 'Could not get your location. Move to open sky if you are indoors, then try again.',
    timedOut:
      'Could not get your location in time. Move to open sky if you are indoors, then try again.',
  },

  nav: {
    dismiss: 'Dismiss',
    /** An assignment with no branch name; the sheet still has to be titled something. */
    branchFallback: 'Branch',
    titleFallback: 'In-app navigation',
    travelTime: 'TRAVEL TIME',
    distance: 'DISTANCE',
    drive: 'Drive',
    transit: 'Transit',
    estimate: 'ESTIMATE',
    estimateNote: 'Straight-line estimate — no route service reachable. The real drive will be longer.',
    start: 'Start navigation',
    cannotNavigate: 'Turn-by-turn needs your location and a reachable route service.',
    closeNavigation: 'Close navigation',
    /**
     * The last step of a route, and the only instruction this app writes itself — every other
     * one is prose composed by the routing service and arrives in English. Translating the
     * turn list needs the route request to carry a language, which is a backend ask.
     */
    arrive: 'Arrive',
    next: 'Next: %{instruction}',
    speed: '%{kmh} km/h',
    /** An ETA. Short units, because these sit inside a tile beside a big number. */
    durationMinutes: '%{count} min',
    durationHours: '%{count} hr',
    durationHoursMinutes: '%{hours} hr %{minutes} min',
    calculatingDrive: 'Calculating drive route…',
    calculatingTransit: 'Calculating transit route…',
    fare: 'Fare %{amount}',
    drivingDistance: '%{distance} driving distance',
    transitDistance: '%{distance} transit distance',
    stepMetres: '%{count} m',
    refresh: 'Refresh',
    stopNav: 'Stop',
    startNav: 'Start',
    permissionDenied: 'Location permission denied. Showing destination only.',
    routeFailed: 'Could not fetch a route.',
    routeFetchFailed: 'Route fetch failed.',
    noPinTitle: 'This branch has no map location yet',
    noPinBody:
      'Operations has not pinned it. Use the address on the assignment for now — nothing here would be accurate.',
    unavailableTitle: 'Map unavailable in this build',
    unavailableBody:
      'This app was built without a Google Maps key, so the map cannot be shown. Everything else works — including check-in.',
    destinationCoords: 'Destination: %{coords}',
    you: 'You',
    destination: 'Destination',
    liveTraffic: 'Live traffic',
    /** The tile source's own name. A proper noun; `hi.ts` omits it and falls back to this. */
    openStreetMap: 'OpenStreetMap',
  },

  /** Returning the audited sheets: the three-step screen, and the hook that files the packet. */
  paperwork: {
    noAuditTitle: 'No audit selected',
    noAuditBody: 'Open a stop from your route and check in to start returning its paperwork.',
    forBranch: 'RETURNING PAPERWORK FOR',
    step1: 'Capture the audited sheets',
    step1Body: 'Scan every page of the completed packet, or attach a PDF you have already produced.',
    scanPages: 'Scan pages',
    attachPdf: 'Attach PDF',
    step2: 'Review',
    uploading: 'Uploading…',
    readyToSubmit: 'Ready to submit',
    nothingCaptured: 'Nothing captured yet — complete step 1 first.',
    step3: 'Submit',
    submitting: 'Submitting…',
    submit: 'Submit to the data entry desk',
    captureFirst: 'Capture the sheets before submitting.',
    backgroundNote:
      'Once submitted, the packet sends in the background. You can leave this screen — it keeps going, even on weak signal.',
    onePacketFailed: '1 packet not sent',
    manyPacketsFailed: '%{count} packets not sent',
    onePacketSending: '1 packet sending',
    manyPacketsSending: '%{count} packets sending',
    tapToRetry: 'Tap to retry the ones that failed.',
    tapForProgress: 'Tap to see progress.',
    actionNeeded: 'Action needed',
    sending: 'Sending',
    viewUploads: 'View my uploads',
    reportIssue: 'Report an issue',
    attachedTitle: 'PDF attached',
    attachedBody: '%{file} is ready to submit.',
    pickFailedTitle: 'Could not attach that file',
    pickFailedBody: 'The PDF could not be selected. Try again, or scan the pages instead.',
    nothingToSubmitTitle: 'Nothing to submit',
    nothingToSubmitBody: 'Attach a PDF or scan the pages first.',
    queuedTitle: 'Added to uploads',
    queuedBody: '%{file} is sending in the background. You can leave this screen.',
    queueFailedTitle: 'Could not queue upload',
    queueFailedBody: 'The packet could not be saved for sending. Please try again.',
  },

  scanner: {
    unavailableTitle: 'Scanner unavailable',
    unavailableBody: 'The document scanner could not be opened.',
    tooBigTitle: 'File is too large',
    pickFailedTitle: 'Could not open files',
    pickFailedBody: 'File selection failed.',
    /*
      What to do with the paper in front of you, one sentence per kind of document. Keyed by
      `DocumentScanProfile.hintKey` in `@fapoms/shared`, which is the same row the browser scanner
      reads its own wording from — so a document's guidance changes in one place for both apps.
    */
    hint: {
      card: 'Lay the card flat — all four corners in view.',
      aadhaarFront: 'The side with the photograph. The back goes on its own row.',
      aadhaarBack: 'The side with the address on it.',
      passport: 'The page with the photograph, held open and flat. Add the address page after it.',
      page: 'Flatten the page. Add each further page after this one.',
      portrait: 'Head and shoulders, facing the camera, plain background.',
      passbook: 'The page with the account number and the name on it.',
      free: 'Fill the frame with the document and hold steady.',
    },
    close: 'Close scanner',
    scanTitle: 'Scan document',
    opening: 'Opening scanner…',
    cameraBody: 'Lay flat, good light, all 4 corners.',
    takePhoto: 'Take photo',
    orChooseFile: 'or choose file',
    chooseFile: 'Choose file',
    cameraDenied: 'Camera is off for Orbit. Allow camera in Settings, or choose a file.',
    openSettings: 'Allow camera in Settings',
  },

  decline: {
    title: 'Decline this assignment',
    reasonLabel: 'Reason for declining',
    detailsLabel: 'Additional detail (optional)',
    /**
     * Says what to write, not "provide context for operations".
     *
     * A preset chip alone is a complete reason now, so this box is for whatever a chip does not
     * already say - the decline is still refused without SOME reason (see
     * `assignment.reasonRequiredBody`), which is why "Other" needs this box filled in.
     */
    reasonPlaceholder: 'Anything else operations should know…',
    confirm: 'Decline assignment',
    categories: {
      tooFar: 'Too far',
      feeTooLow: 'Fee too low',
      scheduleConflict: 'Schedule conflict',
      uncomfortableBranch: 'Not comfortable with this branch',
      other: 'Other',
    },
  },

  feedback: {
    title: 'Help & Support',
    newTitle: 'New support request',
    sendNew: 'New support request',
    emptyTitle: 'No support requests yet',
    emptyBody:
      'Report a bug, suggest an improvement or ask a question — the product team will reply here.',
    kindLabel: 'What kind?',
    /** Let the desk classify it. The other four chips come from the shared category labels. */
    kindAuto: 'Auto',
    titleLabel: 'Title (optional)',
    titlePlaceholder: 'Short summary',
    detailsLabel: 'Details',
    detailsPlaceholder: 'What happened, or what would help?',
    attach: 'Attach a photo or file',
    attachAnother: 'Add another',
    attachmentFallback: 'Attachment',
    attachmentSending: '%{file} · sending…',
    attachmentFailed: '%{file} · %{reason}',
    removeAttachment: 'Remove %{file}',
    sending: 'Sending…',
    send: 'Send',
    categoryResponded: '%{category} · team responded',
    categoryAwaiting: '%{category} · awaiting first response',
    you: 'You',
    productTeam: 'Product team',
    replyPlaceholder: 'Add to the conversation…',
    sendReply: 'Send',
  },

  stats: {
    emptyTitle: 'No performance data yet',
    emptyBody:
      'Once you are offered and complete your first audit, your completion rate and query stats will show up here.',
    completedLabel: 'ASSIGNMENTS COMPLETED',
    completedOf: '%{done} of %{total} offered assignments finished.',
    completed: 'Completed',
    assigned: 'Assigned',
    openQueries: 'Open queries',
    rating: 'Rating',
    ratingHint: 'out of 5',
    performance: 'Performance',
    queriesResolved: 'Queries resolved',
    ratio: '%{done} of %{total}',
  },

  notifications: {
    /**
     * Android's per-app notification settings, verbatim.
     *
     * Registered once at startup, after the saved language has been applied — the channels used
     * to be created as a module-import side effect, which ran before any preference had been
     * read and so could only ever have produced English. Android lets a channel's name and
     * description be updated afterwards (its importance and sound cannot), so switching language
     * re-labels them on the next launch.
     */
    channels: {
      criticalName: 'Critical alerts',
      criticalDescription:
        'Escalations and deadlines that need your attention right now. These interrupt with sound and a distinct vibration.',
      highName: 'Important updates',
      highDescription:
        'New assignments, approvals and status changes that are worth looking at promptly.',
      normalName: 'General activity',
      normalDescription:
        'Everyday activity on your audits and reports. Arrives with a sound, without taking over the screen.',
      lowName: 'Quiet updates',
      lowDescription:
        'Informational notices such as onboarding and directory changes. Silent — they simply wait in your notification drawer.',
    },
    title: 'Notifications',
    titleWithCount: 'Notifications (%{count})',
    close: 'Close notifications',
    markAllRead: 'Mark all read',
    markAllReadAccessibility: 'Mark all notifications as read',
    emptyTitle: 'Nothing new',
    emptyBody: 'Assignment offers, clarification requests and payment updates land here.',
    /** Swipe actions: the state the swipe puts the row into, not the state it is in. */
    swipeUnread: 'Unread',
    swipeRead: 'Read',
  },

  call: {
    /** Falls back when the signalling payload carries no peer name. */
    peerFallback: 'Data Entry Team',
    avatarFallback: 'Desk',
    incoming: 'Incoming call',
    connecting: 'Connecting…',
    ringing: 'Ringing…',
    aboutQuery: 'ABOUT THIS QUERY',
    decline: 'Decline',
    accept: 'Accept',
    answerFailedTitle: 'Could not answer',
    answerFailedBody: 'The call could not be connected.',
    mute: 'Mute',
    unmute: 'Unmute',
    end: 'End',
    speaker: 'Speaker',
  },

  language: {
    title: 'Language',
    hint: 'Choose the language this app uses',
    system: 'Phone default',
    en: 'English',
    /**
     * Written in Hindi in the *English* catalogue too, deliberately.
     *
     * Someone who cannot read the English interface has to be able to find this row and
     * recognise their own language in it. A row that says "Hindi" in English is useless to
     * exactly the person the setting exists for.
     */
    hi: 'हिन्दी (Hindi)',
    /** Shown under the Hindi option while the translation is still awaiting native review. */
    hiDraftNote: 'Hindi is still being checked. Some words will show in English.',
  },
} as const satisfies CatalogueNode;
