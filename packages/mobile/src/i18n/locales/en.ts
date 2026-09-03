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
    notNow: 'Not now',
    tryAgain: 'Try again',
    signOut: 'Sign out',
    retry: 'Retry',
    notOnFile: 'Not on file',
  },

  login: {
    /** The product name. Kept untranslated on purpose — see the note in `hi.ts`. */
    appName: 'Orbit',
    tagline: 'FIELD AUDIT OPERATIONS',
    codeLabel: 'ASSAYER CODE OR PHONE',
    codeAccessibility: 'Assayer code or phone',
    codePlaceholder: 'AS0001',
    passwordLabel: 'PASSWORD',
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
    server: {
      hideSettings: 'Hide server settings',
      openSettings: 'Server settings',
      addressLabel: 'BACKEND ADDRESS',
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
    currentLabel: 'CURRENT PASSWORD',
    currentAccessibility: 'Current password',
    newLabel: 'NEW PASSWORD',
    newAccessibility: 'New password',
    confirmLabel: 'CONFIRM NEW PASSWORD',
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
      received: 'Done',
      sending: 'Sending',
      failed: 'Did not send',
      needed: 'Needed',
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
  },

  profile: {
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
      balance: 'Balance',
      rating: 'Rating',
      ratingHint: 'out of 5',
    },
    sections: {
      profile: 'Profile',
      work: 'Work',
      performance: 'Performance',
      app: 'App',
      account: 'Account',
      help: 'Help & Feedback',
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
      feedback: 'Send feedback',
      feedbackHint: 'Report a bug, suggest an improvement, or ask the product team a question',
      feedbackAccessibility: 'Open feedback and support',
      signOut: 'Sign out',
      signOutHint: "You'll need your password to sign back in",
    },
    signOutConfirm: {
      title: 'Sign out of Orbit?',
      body: "You'll need your password to sign back in.",
      accessibility: 'Sign out of Orbit',
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
      stateLabel: 'STATE',
      name: 'Name',
      relation: 'Relation',
      skills: 'Skills',
      skillsPlaceholder: 'Gold assaying, purity testing',
      languages: 'Languages',
      languagesPlaceholder: 'English, Hindi',
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
      homeLocation: 'HOME LOCATION',
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
      },
      categoryHints: {
        ASSIGNMENT: 'New offers, acceptances and cancellations',
        VALIDATION: 'Questions raised on your submitted reports',
        DOCUMENT: 'Paperwork dispatched to you, or sent back for re-upload',
        PLANNING: 'Coverage and scheduling changes affecting your branches',
        WORKFORCE: 'Certification expiry and profile changes',
        BILLING: 'Expense decisions and payouts',
        SYSTEM: 'Service notices and app updates',
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
    mapAttribution: '© OpenStreetMap contributors',
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
    balance: 'Balance due to you',
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
    dayTotal: ' · %{amount}',
    factDate: 'Date',
    factPackets: 'Packets',
    factFee: 'Fee',
    feeNotSet: 'Fee not set',
    includesTravel: 'Includes %{amount} travel',
    includesTravelBy: ' by %{mode}',
    includesTravelDistance: ' · ~%{km} km each way',
    counterOffer: 'Counter-offer round %{round} of %{max} · proposed %{amount}',
    accept: 'Accept',
    decline: 'Decline',
    negotiationClosed: 'Negotiation closed',
    proposeFee: 'Propose a different fee (%{round}/%{max})',
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
    checkInUnconfirmed:
      'Your check-in was not confirmed — the connection dropped. Move to better signal and tap Check in again; if it already went through, it will show as checked in.',
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
    checkOutUnconfirmed:
      'Your check-out was not confirmed — the connection dropped. Move to better signal and tap Check out again; if it already went through, it will show as checked out.',
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
    partialTitle: 'Some pages did not upload',
    partialOne:
      '%{uploaded} of %{total} uploaded. Page %{pages} failed — please scan it again before leaving the branch.',
    partialMany:
      '%{uploaded} of %{total} uploaded. Pages %{pages} failed — please scan them again before leaving the branch.',
  },

  expense: {
    title: 'Log an expense',
    categoryLabel: 'EXPENSE CATEGORY',
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
    /** Split around the mode so the sentence stays whole when there is no mode to name. */
    quotedIncluded:
      'Your fee for this assignment already includes %{amount} for travel. Claim here only what that did not cover.',
    quotedIncludedByMode:
      'Your fee for this assignment already includes %{amount} for travel by %{mode}. Claim here only what that did not cover.',
    amountLabel: 'AMOUNT (₹)',
    amountPlaceholder: 'e.g. 250',
    overLimit:
      'Over the %{limit} limit for a single claim. Split it across claims, or ask operations to approve it separately.',
    limitHint: 'Up to %{limit} per claim.',
    descriptionLabel: 'DESCRIPTION',
    descriptionPlaceholder: 'Reason / notes',
    submit: 'Submit expense',
    noAssignmentTitle: 'No assignment selected',
    noAssignmentBody: 'Open the assignment you are claiming for and file the expense from there.',
    invalidAmountTitle: 'Enter a valid amount',
    invalidAmountBody: 'Use digits only, for example 1000 or 1,000.',
    filedTitle: 'Claim filed',
    filedBody: '%{amount} for %{category} is awaiting approval.',
    failedTitle: 'Claim not filed',
    failedBody: 'The expense could not be submitted.',
  },

  issue: {
    title: 'Report an issue',
    subtitle: '%{branch} · the operations desk will be notified and will follow up.',
    problemLabel: 'WHAT’S THE PROBLEM?',
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
    detailsLabel: 'DETAILS (OPTIONAL)',
    detailsPlaceholder: 'Add anything the desk needs to know…',
    sending: 'Sending…',
    send: 'Send to desk',
    sentTitle: 'Reported to desk',
    sentBody: 'The operations team has been notified and will follow up.',
    failedTitle: 'Not sent',
    failedBody: 'The issue could not be reported. Please try again.',
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

  negotiate: {
    title: 'Ask for a different travel amount',
    currentFee: 'Current offered fee: %{amount}',
    includesTravel: 'Includes %{amount} for travel.',
    includesTravelByMode: 'Includes %{amount} for travel by %{mode}.',
    /** Its own sentence rather than a clause, so no language has to fit it inside the one above. */
    aboutDistance: 'About %{km} km each way.',
    amountLabel: 'TRAVEL YOU ARE ASKING FOR (₹)',
    amountPlaceholder: 'e.g. 2200',
    remarksLabel: 'REASON / REMARKS (OPTIONAL)',
    remarksPlaceholder: 'e.g. Long-distance travel allowance required',
    amountRequired: 'Enter the travel amount you are asking for.',
    submitFailed: 'Could not send your travel request.',
    submitting: 'Submitting…',
    submit: 'Send request',
    /**
     * Says travel, because travel is what moved. The audit fee comes from the rate card and is
     * not the assayer's to change; naming it here would have them expecting money they never
     * asked for.
     */
    sentTitle: 'Travel request sent',
    sentBody: 'You asked for %{amount} of travel. Operations will reply.',
    failedTitle: 'Not sent',
    failedBody: 'Your travel request could not be submitted.',
  },

  earnings: {
    balanceLabel: 'BALANCE OWED TO YOU',
    balanceOwed: 'Owed to you across all completed work, after payments and TDS.',
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
      approved: 'Approved',
      paid: 'Paid',
      onHold: 'On hold',
    },
    expenseReimbursement: 'Expense reimbursement',
    outstanding: '%{amount} outstanding',
    /** The breakdown finance works from. TDS keeps its English name — see the note in `hi.ts`. */
    base: 'Base %{amount}',
    travel: 'Travel %{amount}',
    tds: 'TDS -%{amount}',
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
    completedTitle: 'Completed audits',
    completedSummary: 'Your finished jobs',
    completedEmptyTitle: 'No earnings yet',
    completedEmptyBody: 'Your fee appears here the moment you complete your first audit.',
    /** A finished audit the billing engine has not raised a payout for yet. */
    notBooked: 'Not booked yet',
    completedBadge: 'Completed',
  },

  /**
   * Clarifications raised by the data entry desk about a packet the assayer submitted.
   *
   * One group across the list, the chat shell and the thread itself: the same nouns ("the
   * desk", "clarification", "packet") have to mean the same thing in all three, and an assayer
   * moves between them in a single sitting.
   */
  queries: {
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
    pickFailedTitle: 'Could not open files',
    pickFailedBody: 'File selection failed.',
    nameRequiredTitle: 'Name required',
    nameRequiredBody: 'Give the document a name before saving.',
    close: 'Close scanner',
    saveTitle: 'Save document',
    scanTitle: 'Scan document',
    onePage: '1 page',
    manyPages: '%{count} pages',
    opening: 'Opening scanner…',
    fileNameLabel: 'FILE NAME',
    fileNamePlaceholder: 'Document name',
    pagesLabel: 'PAGES',
    savedAsPdf: 'Saved as a single PDF. Reorder, crop, rotate and filter pages from the scanner screen.',
    savedAsImages: 'Pages will be saved as images.',
    notHereTitle: 'Scanner not available here',
    notHereBody: 'On-device document scanning needs the Android app. Attach an existing file instead.',
    readyTitle: 'Ready to scan',
    readyBody: 'Position the document in the frame. Edges are detected automatically.',
    rescan: 'Rescan',
    openScanner: 'Open scanner',
    attachFile: 'Attach file',
    saveOne: 'Save 1 page',
    saveMany: 'Save %{count} pages',
  },

  decline: {
    title: 'Decline this assignment',
    reasonLabel: 'REASON FOR DECLINING',
    /**
     * Says what to write, not "provide context for operations".
     *
     * The decline is refused without a real reason (see `assignment.reasonRequiredBody`), so the
     * placeholder has to teach what counts as one before the assayer is stopped for it.
     */
    reasonPlaceholder: 'Too far, fee too low, date impossible…',
    confirm: 'Decline assignment',
  },

  feedback: {
    title: 'Feedback',
    newTitle: 'New feedback',
    sendNew: 'Send new feedback',
    emptyTitle: 'No feedback yet',
    emptyBody:
      'Report a bug, suggest an improvement or ask a question — the product team will reply here.',
    kindLabel: 'WHAT KIND?',
    /** Let the desk classify it. The other four chips come from the shared category labels. */
    kindAuto: 'Auto',
    titleLabel: 'TITLE (OPTIONAL)',
    titlePlaceholder: 'Short summary',
    detailsLabel: 'DETAILS',
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
