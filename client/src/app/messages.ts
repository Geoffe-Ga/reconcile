/**
 * Every string the app shows (ADR-0055 as cut by ADR-0073; spec §2).
 *
 * One typed catalog, with no ICU library: a string that takes a value is a
 * function. ESLint forbids literal text in `src/app/` and `src/screens/` JSX,
 * so a new screen adds its words here. The voice is DESIGN.md's: plain, warm
 * and direct, in the active voice, with no exclamation marks. Terms follow
 * CLAUDE.md's domain vocabulary (Document, Proposal, Atom as "section").
 */
/** The language these strings are in, which dates, countdowns and counts are formatted in. */
const LOCALE = 'en-GB';

/** A whole number as this language writes it, such as "2,000". */
const count = (n: number): string => n.toLocaleString(LOCALE);

/**
 * What a restore or a link says of the group entries (#336) and personal
 * Documents (#351) it left out because they didn't check out, `where` they
 * were: a sentence for each kind it left any of, groups first.
 */
function leftOut(skipped: number, skippedDocuments: number, where: string): string[] {
  const groups =
    skipped === 1
      ? `One group ${where} couldn’t be read and was left out.`
      : `${count(skipped)} groups ${where} couldn’t be read and were left out.`;
  const documents =
    skippedDocuments === 1
      ? `One personal Document ${where} couldn’t be read and was left out.`
      : `${count(skippedDocuments)} personal Documents ${where} couldn’t be read and were left out.`;
  return [...(skipped === 0 ? [] : [groups]), ...(skippedDocuments === 0 ? [] : [documents])];
}

/**
 * A sentence with names in it (#549): its words in order, each name marked,
 * so a screen sets every name in its own `<bdi>` (`Worded`), since names come
 * from other devices.
 */
export type Words = readonly (string | { readonly name: string })[];

/** A name in {@link Words}. */
const named = (name: string) => ({ name });

/**
 * Why a coalition that sits in `above` refuses to admit `asking` (#549): its
 * seat there keeps the level it stated, so a level higher its votes there
 * would come as they stop counting (ADR-0036's 2026-11-21 amendment).
 */
const refusedWhy = (coalition: string, above: string, asking: string): Words => [
  named(coalition),
  ' sits in ',
  named(above),
  '. Admitting ',
  named(asking),
  ' would put ',
  named(coalition),
  ' a level higher than its seat there, so its votes there would arrive too late to count.',
];

/** The route instead (#549): `asking` asks into `above` itself, with a card one of its groups makes. */
const refusedRoute = (asking: string, above: string): Words => [
  named(asking),
  ' can ask into ',
  named(above),
  ' directly instead: ask a group in ',
  named(above),
  ' for its card.',
];

/** What a result says once a device has deleted its ballots: by expiry (#111), or in an archive (#108). */
const CLEARED_ON = 'Individual scores and notes were cleared on';

export const messages = {
  app: {
    name: 'Reconcile',
    locale: LOCALE,
    pageTitle: (screen: string) => `${screen} · Reconcile`,
    yourGroups: 'Your groups',
    newTab: '(opens in a new tab)',
    back: '←',
    forward: '→',
    outward: '↗',
    /** Ends a quotation that leaves words out, as in "Shared spaces are cleaned every…". */
    ellipsis: '…',
  },
  /** The link bar (#444; ADR-0077 §6): the pill at the top of every screen that opens any Reconcile link. */
  linkBar: {
    /** The Reconcile mark's name, at the bar's start: it opens the landing page (`#/about`). */
    about: 'About Reconcile',
    /** The field's name, and its placeholder. */
    label: 'Search or paste a link',
    clear: 'Clear',
    paste: 'Paste',
    /** The rows' name as a list. */
    rows: 'What you pasted',
    open: 'Open',
    /** What each kind of link is, in plain words. */
    kinds: {
      invite: 'An invite',
      card: 'A reconcile card',
      follow: 'A coalition to follow',
      door: 'A front door',
      shared: 'A shared Document',
      vote: 'A vote',
    },
    damaged: 'This link is damaged or cut off. Copy all of it and paste it again.',
    notALink: 'That isn’t a Reconcile link.',
    /** A code pasted here: where it goes, and the screen that takes it. The bar never keeps the code. */
    codes: {
      'linking-code': {
        line: 'That’s a linking code. Open Link to my other device and paste it there.',
        screen: 'Link to my other device',
      },
      'recovery-code': {
        line: 'That’s a recovery code. Open Help someone recover and paste it there.',
        screen: 'Help someone recover',
      },
    },
    /** How many rows show, said politely as they change. */
    results: (count: number) => (count === 1 ? '1 result' : `${String(count)} results`),
  },
  /** Search on this device (#445), from the link bar. */
  search: {
    /** The results' name as a list. */
    results: 'Results',
    /** The panel's name, as a region Tab can reach to scroll the results. */
    panel: 'Search results',
    /** Each kind of result's eyebrow, in the order they show. */
    shelves: {
      groups: 'Groups',
      documents: 'Documents',
      proposals: 'Proposals',
      dispatches: 'Dispatches',
      yours: 'Yours',
      places: 'Go to',
    },
    showAll: (count: number) => `Show all ${String(count)}`,
    nothing: 'Nothing on this device matches.',
    scope: 'Search covers only what this device holds.',
    /** The app's own places, by the names search finds them by. */
    places: {
      start: 'Your groups',
      discover: 'Discover',
      personal: 'Personal',
      settings: 'Settings',
      recovery: 'Recovery contacts',
      create: 'Create a group',
    },
  },
  /** The tab bar (#423; ADR-0077 §7): the app's three places, a glyph and a word each. */
  tabs: {
    /** The bar's name as a landmark. */
    label: 'Main',
    groups: 'Groups',
    discover: 'Discover',
    me: 'Me',
  },
  /** Discover (#423; ADR-0077 §6): reading across groups. */
  discover: {
    pageTitle: 'Discover',
    title: 'Discover',
    /** The empty state's one sentence, while this device holds no Dispatch (#429). */
    empty:
      'Dispatches from your groups, and from the coalitions you’re in or follow, show up here.',
    /** The feed (#429): every Dispatch this device holds, newest first. */
    feedLabel: 'Dispatches from your groups and coalitions',
    /** After a dissolved group's name on its Dispatches' eyebrow: "<group> · Ended". */
    endedSeparator: '·',
    ended: 'Ended',
    /** Where a card or link opens: the link bar (#444). */
    pasteInBar: 'To open a card or link, paste it into the bar at the top.',
    /**
     * The public shelf (#484; ADR-0081): Dispatches that listed groups voted
     * to publish, each under its group's name. The section shows only while
     * the shelf holds an entry.
     */
    shelfHeading: 'On the public shelf',
    shelfLede:
      'Groups that chose to be listed publish these by vote. Anyone with the app can read them.',
    /** Under an entry (#431): since when its group has been listed, by month. */
    listedSince: (month: string) => `Listed since ${month}`,
    /** On an entry its own group sees before the relay day's wait ends (#431). */
    showsTomorrow: 'Shows publicly tomorrow',
    /** Under an entry: its own page, with Share and Copy for its link (#431). */
    passAlong: 'Share or copy its link',
    /**
     * A tombstone (#489; listed-doors.md §6.1): what the steward took down,
     * in its place, naming the covenant clause in words, never a reporter
     * or the group (ADR-0013: decisions are public).
     */
    removed: (clause: string) => `Removed: ${clause}`,
    removedEntry: 'Reconcile’s steward took this entry off the public shelf under the covenant.',
    removedListing:
      'Reconcile’s steward took a group’s listing, and everything it published, off the public shelf under the covenant.',
    /** In place of the whole section while the steward's pause stands (#489). */
    paused:
      'The public shelf is paused for now. Nothing on it shows until Reconcile’s steward lifts the pause.',
  },
  /**
   * On Start and Discover (#491; listed-doors.md §6.5): the steward removed
   * from the shelf a group this device sent an application or a reconcile
   * card to, or a Dispatch it published. The device matched it alone, from
   * what it sent, and told no one; Dismiss hides the line on this device.
   */
  removals: {
    heading: 'Removed from the public shelf',
    asked: (date: string, clause: string) =>
      `A group you asked to join on ${date} was removed from the shelf: ${clause}.`,
    askedEntry: (date: string, clause: string) =>
      `A Dispatch from a group you asked to join on ${date} was removed from the shelf: ${clause}.`,
    proposed: (date: string, clause: string) =>
      `A group you proposed reconciling with on ${date} was removed from the shelf: ${clause}.`,
    proposedEntry: (date: string, clause: string) =>
      `A Dispatch from a group you proposed reconciling with on ${date} was removed from the shelf: ${clause}.`,
    dismiss: 'Dismiss',
  },
  /** One shelf entry's own page (#431; listed-doors.md §5.2): the link Share and Copy pass along. */
  shelfEntry: {
    pageTitle: 'On the public shelf',
    linkLabel: 'Link to this entry',
    linkHint: 'Anyone with the app can open it and read it, without joining anything.',
    copy: 'Copy link',
    gone: 'This entry isn’t on the public shelf. It may have come down, or its 30 days ended.',
    toDiscover: 'Go to Discover',
    /** Opens the listing's front door (#432, §5.2). */
    askToJoin: 'Ask to join',
    /** Opens the same door, where a group that may propose reconciling with it does so (#426, #432). */
    proposeReconciling: 'Propose reconciling',
    /**
     * On Group home (#431, §4.5): an entry under the group's name that its
     * log didn't make, which a member's device withdrew.
     */
    strayHeading: 'Taken off the public shelf',
    stray:
      'Someone posted this under your group’s name without a vote, using your front door’s key. A member’s device took it down.',
    /**
     * On Group home (#489, §6.1): a hold the steward placed on the group's
     * listing or one of its entries, with the clause it names, which only
     * the group's own members see.
     */
    heldHeading: 'Held off the public shelf',
    held: (clause: string) => `Held: ${clause}`,
    heldListing: 'Your group’s listing and everything it published.',
    heldUntil: (date: string) =>
      `Reconcile’s steward is looking at this. Unless they remove it, it shows again on ${date}.`,
    /** On Group home (#490, §6.1): the steward removed the group's listing, under a clause. */
    removedHeading: 'Removed from the public shelf',
    removed: (clause: string) => `Removed: ${clause}`,
    removedListing: 'Your group’s listing and everything it published.',
    /**
     * Report this entry (#490, §6.3): any reader may send one to the
     * steward. It says nothing about who sent it and has no reply, and it
     * hides nothing.
     */
    report: 'Report this entry',
    reportTitle: 'Report this entry to Reconcile’s steward',
    reportLede:
      'The steward reads it and decides. Your report doesn’t say who you are, and you won’t get a reply. It hides nothing by itself.',
    reportClause: 'What it breaks in the covenant',
    noteLabel: 'Note (optional)',
    noteHint: (max: number) => `Up to ${String(max)} characters. Only the steward reads it.`,
    noteTooLong: (max: number) => `Keep the note to ${String(max)} characters.`,
    send: 'Send',
    sending: 'Sending…',
    cancel: 'Cancel',
    reportSent: 'Sent to Reconcile’s steward.',
    sendFailed: 'It wasn’t sent. Check your connection and try again.',
    /**
     * Ask the steward to look again (#490, §6.3): a member who may propose,
     * in a held or removed group, sends one appeal, signed with the door's key.
     */
    appeal: 'Ask the steward to look again',
    appealTitle: 'Ask Reconcile’s steward to look again',
    appealLede:
      'It goes to the steward under your group’s front door, not your name. You won’t get a reply in the app.',
    appealLabel: 'Why it should show',
    appealHint: (max: number) => `Up to ${String(max)} characters.`,
    appealRequired: 'Say why it should show.',
    appealSent: 'Sent. The steward reads it and decides.',
  },
  start: {
    pageTitle: 'Your groups',
    title: 'Your groups',
    empty: 'You aren’t in any groups on this device yet.',
    create: 'Create group',
    inviteHeading: 'Have an invite link?',
    /** Where an invite, or any other Reconcile link, opens now: the link bar (#444). */
    pasteInBar: 'Paste it, or any Reconcile link, into the bar at the top.',
    documentTitle: (title: string) => `Document: ${title}`,
    settingUp: 'Saved on this device. Waiting for the relay.',
    mayClear: 'This browser may clear Reconcile’s data if the device runs low on space.',
    leaving: 'Leaving…',
    restoreHeading: 'Have a backup file?',
    linkHeading: 'Have Reconcile on another device?',
    link: 'Link to my other device',
    settings: 'Settings',
    personal: 'Personal',
    personalHint: 'Your mission statement and other Documents of your own, on this device only.',
    recoverHeading: 'Lost every device?',
    recover: 'Recover with my contacts',
    /** The coalitions this device follows (#124), each with its member groups. */
    followingHeading: 'Following',
  },
  install: {
    pageTitle: 'Add to Home Screen',
    title: 'Add Reconcile to your Home Screen',
    otherApp: 'If you opened this inside another app, open it in Safari first.',
    steps: ['Tap Share, or tap ••• and then Share.', 'Choose Add to Home Screen, then tap Add.'],
    open: 'Open Reconcile from your Home Screen.',
    /** The last step with a link held to copy (#76, #280), by its kind: where to paste it. */
    openToPaste: {
      invite:
        'Open Reconcile from your Home Screen and paste your invite link into the bar at the top.',
      card: 'Open Reconcile from your Home Screen and paste your card link into the bar at the top.',
      follow:
        'Open Reconcile from your Home Screen and paste your follow link into the bar at the top.',
      vote: 'Open Reconcile from your Home Screen, then paste this link into the bar at the top.',
    },
    why: 'Safari can clear a website’s data after a week without a visit, so on iPhone and iPad Reconcile runs from your Home Screen.',
    /**
     * A link held to copy into the installed app, by its kind (#280): the
     * section's heading when it shows no preview, as the link bar names the
     * kind, its field and its button.
     */
    held: {
      invite: { heading: 'Your invite', label: 'Your invite link', copy: 'Copy invite link' },
      card: { heading: 'A reconcile card', label: 'Your card link', copy: 'Copy card link' },
      follow: {
        heading: 'A coalition to follow',
        label: 'Your follow link',
        copy: 'Copy follow link',
      },
      vote: { heading: 'A vote', label: 'Your vote link', copy: 'Copy vote link' },
    },
    /** Under every held link's field. */
    heldHint: 'Copy it now, then paste it into Reconcile once it’s on your Home Screen.',
    appLabel: 'Reconcile’s address',
    appHint: 'To open Reconcile in Safari, copy this and paste it into Safari’s address bar.',
    copyApp: 'Copy link',
    copied: 'Copied.',
  },
  // The pilot notice (ADR-0056). "Sealed" and "can’t read" hold because every
  // blob is sealed before it leaves the device (#71, spec §3).
  notice: {
    pageTitle: 'Before you start',
    eyebrow: 'Reconcile pilot',
    title: 'Before you start',
    lede: 'You’re helping a few groups try out Reconcile. Here’s what that means for you.',
    accept: 'I understand',
    topics: [
      {
        heading: 'What’s stored',
        lines: [
          'Your groups live on this device: their Documents, Proposals and votes, the name you use in each group, and the keys that let you take part. There are no accounts.',
          'Messages between your group’s devices pass through Reconcile’s relay, which keeps them for 30 days. Each one is sealed on your device before it’s sent.',
        ],
        list: [],
      },
      {
        heading: 'What the relay can see',
        lines: ['Whoever runs the relay can’t read what your group writes. They can see:'],
        list: [
          'your device’s IP address while it’s connected, though the relay doesn’t log it',
          'when messages arrive',
          'each message’s size class, one of four sizes',
          'which mailboxes your device checks',
          // A listing goes up from members' devices (#486; ADR-0081), so a live observer ties
          // the listed name to the group's mailboxes: an accepted pilot risk (listed-doors.md §7).
          'if your group lists its front door on the public shelf, that your device is in that group, since your device posts the listing',
        ],
      },
      {
        heading: 'Data can be lost',
        lines: [
          'A lost or reset phone, cleared browser data or a bug can lose your groups on this device. Your group keeps its own copies, and a new invite link brings you back in.',
        ],
        list: [],
      },
      {
        heading: 'This is a test',
        lines: [
          'Reconcile is new and will change as we learn. It hasn’t had an outside security review yet, so keep anything sensitive out of it for now.',
          'If something goes wrong, tell the person who invited you.',
        ],
        list: [],
      },
    ],
  },
  create: {
    pageTitle: 'Create a group',
    eyebrow: 'New group',
    title: 'Create a group',
    lede: 'You write the first draft of your group’s Documents. After that, each one changes only when a Proposal passes your group’s vote.',
    groupName: 'Group name',
    groupNameMissing: 'Give your group a name.',
    yourName: 'Your name',
    yourNameHint: 'This name is only shown in this group. It doesn’t have to be your real name.',
    yourNameMissing: 'Add the name your group will see.',
    chat: 'Chat link (optional)',
    chatHint: 'Where your group already talks, such as a Discord, Signal or WhatsApp group.',
    chatInvalid: 'Use a web link that starts with https:// or http://.',
    /** Each Document block's heading (#92), numbered from 1. */
    documentBlock: (number: number) => `Document ${String(number)}`,
    /** The first block's title until the founder changes it (#92). */
    defaultTitle: 'Mission statement',
    documentTitle: 'Document title',
    documentTitleHint: 'For example, House rules or Our mission.',
    documentTitleMissing: 'Give the Document a title.',
    documentTitleTooLong: (max: number) => `Keep the title to ${count(max)} characters or fewer.`,
    addDocument: 'Add another Document',
    removeDocument: 'Remove',
    /** A block's Remove starts with its visible word (WCAG 2.5.3). */
    removeDocumentLabel: (number: number) => `Remove Document ${String(number)}`,
    documentText: 'Document text',
    documentTextHint:
      'Leave a blank line between sections. Your group proposes changes one section at a time.',
    documentTextMissing: 'Write at least one section.',
    tooLarge: 'This Document is too long to send. Shorten it, then try again.',
    /** Said under the longest block's text when the Documents fit only apart (#92). */
    tooLargeTogether: 'Together, your Documents are too long to send. Shorten one, then try again.',
    visibility: (documents: number) =>
      `Everyone you invite sees the group name, your name, the chat link and ${documents === 1 ? 'this Document' : 'these Documents'}.`,
    submit: 'Create group',
    failed: 'Your group couldn’t be saved on this device. Try again.',
  },
  join: {
    pageTitle: 'Join a group',
    loading: 'Opening the invite…',
    eyebrow: 'You’re invited',
    /** Around the inviter's name, which renders in its own `<bdi>`: "From Ana’s invite". */
    fromBefore: 'From',
    fromAfter: '’s invite',
    documentLabel: 'Their Document',
    nameLabel: 'Your name',
    nameHint: 'This name is only shown in this group. It doesn’t have to be your real name.',
    nameMissing: 'Add the name your group will see.',
    /** What joining shows the group: individual ballots expire `days` after each decision (#111). */
    visibility: (days: number) =>
      `People in this group will see the name you choose and how you vote, until ${count(days)} days after each decision.`,
    submit: 'Join group',
    badLinkTitle: 'This invite link doesn’t work',
    badLink: 'This invite link has expired or is damaged. Ask someone in your group for a new one.',
    offlineTitle: 'Can’t open the invite yet',
    offline: 'Can’t reach the relay right now. Check your connection, then try again.',
    retry: 'Try again',
    failed: 'Joining didn’t finish. Try again.',
    /** Under the whole Document (#91): the explicit fit check before a name is asked for. */
    question: 'Do you share enough of this to join?',
    notNow: 'Not now',
    /** Read as Not now's description: it drops the invite and writes nothing. */
    notNowHint: 'You can open the link again while it lasts.',
    memberTitle: 'You’re already in this group',
    alreadyJoined:
      'This invite is for a group you’re already in on this device. Anything this device was missing from its history is here now.',
    openGroup: 'Open your group',
  },
  /**
   * The first-run guide (#91): up to three cards after the first Create group
   * or Join on a device. Every number arrives from the engine's rules and the
   * score scale, never typed here.
   */
  guide: {
    /** Where a card sits among those this person sees, such as "2 of 3". */
    step: (step: number, steps: number) => `${count(step)} of ${count(steps)}`,
    next: 'Next',
    back: 'Back',
    skip: 'Skip',
    done: 'Done',
    proposeTitle: 'Propose',
    propose:
      'Suggest new wording for any section, with a short reason. Nothing changes until the group agrees.',
    /** The score scale's ends, such as "Vote 0–4". */
    voteTitle: (low: string, high: string) => `Vote ${low}–${high}`,
    /** The scale's ends, then the ordinary bar's average line and share of zeros, such as "2.0" and "10%". */
    vote: (low: string, high: string, average: string, zeros: string) =>
      `Score each version from ${low} (strongly opposed) to ${high} (strongly supportive). Most changes pass when the average is at least ${average} and fewer than ${zeros} of scores are ${low}. A ${low} needs a reason.`,
    discussTitle: 'Discuss in your chat',
    discuss: 'Talk it through in your group’s own chat. Every Proposal links to it.',
  },
  home: {
    pageTitle: 'Your group',
    eyebrow: 'Your group',
    /** Over the list of the group's Documents (#92). */
    documentsLabel: 'Documents',
    proposeDocument: 'Propose a new Document',
    needsYourVote: 'Needs your vote',
    openProposals: 'Open Proposals',
    /** The open Proposals after 'Needs your vote', when it lists any. */
    otherOpen: 'Other open Proposals',
    noProposals: 'Nothing to vote on yet.',
    people: 'People',
    /** Read between a name and its level, as in "Ana, Co-Creator"; the screen shows a gap. */
    levelSeparator: ',',
    /** Read between a name and who invited them, as in "Ben, invited by Ana". */
    invitedBySeparator: ',',
    invitedBy: 'invited by',
    invite: 'Invite people',
    copyInvite: 'Copy invite link',
    inviteWarning:
      'Anyone who opens this link in the next 2 days can read everything this group has written and voted on, and what comes next. Send it directly to the people you’re inviting.',
    inviteField: 'Invite link',
    making: 'Making your invite link…',
    makeFailed:
      'The invite link couldn’t be made, so nothing was copied. Making one needs the relay. Check your connection, then try again.',
    copied: 'Copied. Send it to the people you’re inviting.',
    copyFailed: 'Copying is blocked here. Select the link above and copy it yourself.',
    missingHistory:
      'Some history may be missing on this device. Open a new invite link from your group to catch up.',
    /** When the group's key changed after this membership left on another device (#98). */
    keyLeft: 'You left this group on another device.',
    /** When the group's key changed and this device has no wrap that opens (#98). */
    keyMissed:
      'This group’s key changed and this device didn’t get the new one. Ask someone in the group for a new invite link.',
    joinDiscussion: 'Join discussion',
    discussion: 'Discussion',
    unreachable: 'Can’t reach the relay right now.',
    unreachableSince: (time: string) => `Can’t reach the relay right now. Last synced ${time}.`,
    missingTitle: 'This group isn’t on this device',
    missing: 'Open an invite link to join it, or go back to your groups.',
    focus: 'Focus',
    /** Over the option a priority vote chose, on the card that opens its result (#107). */
    currentFocus: 'Current focus',
    noFocus: 'Your group hasn’t chosen a focus yet.',
    askFocus: 'Ask what to focus on',
    settingUpTitle: 'Setting up your group',
    settingUp: 'Your group is saved on this device. It appears here once it reaches the relay.',
  },
  composer: {
    pageTitle: 'Propose a change',
    title: 'Propose a change',
    current: (section: number) => `Section ${String(section)} now reads`,
    titleLabel: 'Title',
    titleHint: 'A few words that say what changes.',
    titleMissing: 'Give your Proposal a title.',
    titleTooLong: (max: number) => `Keep the title to ${count(max)} characters or fewer.`,
    whyLabel: 'Why',
    whyHint: 'Tell your group what this fixes or makes better.',
    whyMissing: 'Say why you’re proposing this.',
    whyTooLong: (max: number) => `Keep it to ${count(max)} characters or fewer.`,
    textLabel: 'New text',
    textHint: 'If your group passes it, this replaces the section.',
    textMissing: 'Write the new text for this section.',
    textUnchanged:
      'This reads the same as the section does now. Change it to propose something new.',
    tooLarge: 'This is too long to send. Shorten it, then try again.',
    linkLabel: 'Discussion link (optional)',
    linkHint: 'Where your group can talk it over. It starts as your group’s latest link.',
    linkInvalid: 'Use a web link that starts with https:// or http://.',
    visibility:
      'Your draft stays on this device until you propose it. Then everyone in your group sees this Proposal and that you made it.',
    draftRestored: 'Your draft is back. It’s saved on this device only.',
    discard: 'Discard draft',
    discarded: 'Draft discarded.',
    submit: 'Propose this change',
    failed: 'Your Proposal couldn’t be saved on this device. Try again.',
    missingTitle: 'This section isn’t in the Document',
    missing: 'Go back to the Document and choose a section to change.',
    notAllowedTitle: 'You can’t propose changes here',
    notAllowed: 'Your place in this group doesn’t include proposing changes.',
    versionPageTitle: 'Add your version',
    versionTitle: 'Add your version',
    versionLede:
      'This section already has an open Proposal. Your wording goes on its ballot beside the others, and everyone scores each version.',
    versionLabel: 'Your version',
    versionMissing: 'Write your version of this section.',
    versionHint: 'If your group passes it, this replaces the section.',
    textOnBallot:
      'This reads the same as a version already on the ballot. Change it to add something new.',
    versionVisibility:
      'Your draft stays on this device until you add it. Then everyone in your group sees your version and that you wrote it.',
    versionSubmit: 'Add your version',
    versionFailed: 'Your version couldn’t be saved on this device. Try again.',
    againTitle: 'Propose again',
    againLede:
      'This opens a new vote on the same wording, with a fresh window. Change anything you like first.',
    againVersions: 'Also on the ballot',
    againVersionsHint:
      'These versions go on the new ballot after yours. Your group sees that you added them.',
    fullTitle: 'This ballot is full',
    full: 'This ballot already has three versions.',
    addPageTitle: 'Add a section',
    addTitle: 'Add a section',
    addAtStart: 'If your group passes it, your section goes at the start of the Document.',
    addAfter: (section: number) =>
      `If your group passes it, your section goes right after section ${String(section)}.`,
    addTextLabel: 'Section text',
    addTextHint: 'If your group passes it, this becomes a new section.',
    addTextMissing: 'Write the new section.',
    addSubmit: 'Propose this section',
    addVersionLede:
      'This new section has an open Proposal. Your wording goes on its ballot beside the others, and everyone scores each version.',
    addVersionHint: 'If your group passes it, this becomes the new section.',
    removePageTitle: 'Propose removing a section',
    removeTitle: 'Propose removing this section',
    removeLede: 'If your group passes it, this section leaves the Document.',
    removeVersionLede:
      'This section already has an open Proposal. Removing it goes on that ballot as another version, and everyone scores each version.',
    removeSubmit: 'Propose removing it',
    removeVersionSubmit: 'Add removal to the ballot',
    removeVersionVisibility: 'Everyone in your group sees this version and that you added it.',
    removalOnBallotTitle: 'Removing this section is already on the ballot',
    removalOnBallot: 'Score it on the section’s open Proposal.',
    /** A section with an open move (#103) takes no change, removal or version until it closes. */
    movingTitle: 'This section is being moved',
    moving: 'Score its move on the open Proposal. You can propose a change once that vote closes.',
    /** Add a section here's header choices (#103): one line, built into `# …` or `## …`. */
    headerPageTitle: 'Add a section header',
    headerTitle: 'Add a section header',
    subheaderPageTitle: 'Add a subsection header',
    subheaderTitle: 'Add a subsection header',
    headingLabel: 'Heading',
    headerHint: 'One line. If your group passes it, it shows as a section header.',
    subheaderHint: 'One line. If your group passes it, it shows as a subsection header.',
    headingMissing: 'Write the heading.',
    /** The Proposal title a header's heading prefills, until it's changed by hand. */
    headerProposalTitle: (heading: string) => `Add section header: ${heading}`,
    subheaderProposalTitle: (heading: string) => `Add subsection header: ${heading}`,
    headerSubmit: 'Propose this header',
    /** Move this section (#103). */
    movePageTitle: 'Move a section',
    moveTitle: 'Move this section',
    moveLede:
      'If your group passes it, this section comes out of its place and goes where you choose. Its words stay as they are.',
    movePlaceLabel: 'Where it goes',
    moveFirst: 'Put it first',
    /** Before the first words of the section it would follow, which go in `<bdi>`. */
    moveAfter: 'Put it after:',
    moveHere: 'It’s here now.',
    movePlaceMissing: 'Choose where the section goes.',
    moveSubmit: 'Propose this move',
    moveBusyTitle: 'This section has an open Proposal',
    moveBusy: 'You can propose moving it once that vote closes.',
    moveAloneTitle: 'There’s nowhere to move this section',
    moveAlone: 'It’s the only section in its Document.',
    /** Protect this section, or change its protection (#116). */
    protectPageTitle: 'Protect a section',
    protectTitle: 'Protect this section',
    protectChangeTitle: 'Change this section’s protection',
    protectLede:
      'A protected section is harder to change. If your group passes this, its words stay as they are, and what it takes to change it is what you choose here.',
    /** The bar a class Proposal needs, from the rules: "an average of 3.0 or more, with zeros under 5%". */
    protectBar: (average: string, zeros: string) =>
      `Protecting a section, or removing its protection, needs your group’s higher bar: an average of ${average} or more, with zeros under ${zeros}.`,
    protectLabel: 'Protection',
    /** Each choice's name, then its one line, by the class it gives the section. */
    protectChoices: {
      entrenched: {
        name: 'Entrenched',
        line: 'Later changes need a higher bar and a longer vote.',
      },
      eternal: { name: 'Eternal', line: 'No vote can ever change, move or remove it.' },
    },
    /** An entrenched section's choices: eternal, or back to ordinary. */
    protectChangeChoices: {
      eternal: { name: 'Make it eternal', line: 'No vote can ever change, move or remove it.' },
      ordinary: {
        name: 'Remove the protection',
        line: 'Later changes go back to the usual bar and vote.',
      },
    },
    protectMissing: 'Choose how to protect this section.',
    protectChangeMissing: 'Choose what happens to this section’s protection.',
    /** Under the choice while Eternal is chosen (ADR-0015 §3). */
    permanent: 'This is permanent. Once it passes, the only way out is to leave the group.',
    protectSubmit: 'Propose this protection',
    protectChangeSubmit: 'Propose this change',
    eternalTitle: 'This section is eternal',
    eternal: 'No vote can change, move or remove it, or its protection.',
    protectBusyTitle: 'This section has an open Proposal',
    protectBusy: 'You can propose protecting it once that vote closes.',
    protectingTitle: 'This section’s protection is being decided',
    protecting: 'Score it on the open Proposal. You can propose a change once that vote closes.',
    /** Over a composer for a change, move or removal of an entrenched section (#116). */
    entrenchedNote: (average: string, zeros: string) =>
      `This section is entrenched. Changing, moving or removing it needs your group’s higher bar: an average of ${average} or more, with zeros under ${zeros}, and a longer vote.`,
    /** The checkbox that adds a Dispatch to a Proposal (#112). */
    dispatchLabel: 'Send a Dispatch if this passes',
    dispatchHint:
      'If your group passes this, everyone in it gets the Dispatch. Voters see it on the ballot first.',
    /** Where a carried Dispatch's title starts: the Document's own title, set in the field. */
    dispatchTitle: (document: string) => `Updated: ${document}`,
    /** Where a new Document's carried Dispatch title starts (#92). */
    dispatchNewTitle: (document: string) => `New Document: ${document}`,
    newDocumentPageTitle: 'Propose a new Document',
    newDocumentTitle: 'Propose a new Document',
    newDocumentLede:
      'If your group passes it, your group has a new Document, listed after the others. What you write here becomes its first sections.',
    documentTitleLabel: 'Document title',
    documentTitleHint: 'For example, Budget or Chores.',
    documentTitleMissing: 'Give the new Document a title.',
    documentTitleTooLong: (max: number) =>
      `Keep the Document title to ${count(max)} characters or fewer.`,
    sectionsLabel: 'First sections',
    sectionsHint: 'Leave a blank line between sections.',
    sectionsMissing: 'Write at least one section.',
    section: (section: number) => `Section ${String(section)}`,
    newDocumentSubmit: 'Propose this Document',
    newDocumentVersionLede:
      'This new Document has an open Proposal. Your wording goes on its ballot beside the others, and everyone scores each version.',
    newDocumentVersionHint:
      'If your group passes it, these become the new Document’s first sections. Leave a blank line between sections.',
    dispatchTitleLabel: 'Dispatch title',
    dispatchTextLabel: 'Dispatch text (optional)',
  },
  /** The priority composer (#107): one question, 2–7 options, everyone scores each. */
  priority: {
    pageTitle: 'Ask what to focus on',
    title: 'Ask what to focus on',
    lede: 'Everyone scores each option from 0 to 4. The options that pass rank by their average, and the top one becomes your group’s focus.',
    questionLabel: 'Question',
    question: 'What should we focus on?',
    questionMissing: 'Write the question your group will answer.',
    questionTooLong: (max: number) => `Keep the question to ${count(max)} characters or fewer.`,
    whyHint: 'Tell your group why it’s time to choose.',
    whyMissing: 'Say why you’re asking now.',
    optionsLabel: 'Options',
    optionsHint: (min: number, max: number, length: number) =>
      `From ${count(min)} to ${count(max)} options, each up to ${count(length)} characters.`,
    optionLabel: (option: number) => `Option ${String(option)}`,
    optionBlank: 'Write this option, or remove it.',
    optionTooLong: (max: number) => `Keep each option to ${count(max)} characters or fewer.`,
    optionRepeated: 'This option is already on the list.',
    addOption: 'Add option',
    remove: 'Remove',
    removeLabel: (option: number) => `Remove option ${String(option)}`,
    visibility: 'Everyone in your group sees this question and that you asked it.',
    submit: 'Ask your group',
    failed: 'Your question couldn’t be saved on this device. Try again.',
    openTitle: 'Your group is already choosing a focus',
    open: 'You can ask again once its vote closes.',
    seeOpen: 'See the open vote',
  },
  proposal: {
    pageTitle: 'Proposal',
    /** Over an ordered Proposal's title: its number among the group's Proposals (#123), and whether it's open. */
    eyebrowOpen: (number: number) => `Proposal ${String(number)} · Open`,
    eyebrowClosed: (number: number) => `Proposal ${String(number)} · Closed`,
    eyebrowNew: 'New Proposal',
    proposedBy: 'Proposed by',
    changes: (section: number) => `Changes to section ${String(section)}`,
    newSection: 'New section',
    /** What a new Document's ballot shows: its first sections, wholly added (#92). */
    firstSections: 'First sections',
    removes: 'Removes this section',
    addsAfter: (words: string) => `Adds a section after ‘${words}’`,
    addsAtStart: 'Adds a section at the start',
    addsAtEnd: 'Adds a section at the end',
    /** What a header add does (#103): a section header for `#`, a subsection header for deeper. */
    addsHeaderAfter: (sub: boolean, heading: string, words: string) =>
      `Adds a ${sub ? 'subsection' : 'section'} header ‘${heading}’ after ‘${words}’`,
    addsHeaderAtStart: (sub: boolean, heading: string) =>
      `Adds a ${sub ? 'subsection' : 'section'} header ‘${heading}’ at the start`,
    addsHeaderAtEnd: (sub: boolean, heading: string) =>
      `Adds a ${sub ? 'subsection' : 'section'} header ‘${heading}’ at the end`,
    /** What a move does (#103), heading its one card. */
    movesAfter: (words: string) => `Moves this section after ‘${words}’`,
    movesToStart: 'Moves this section to the start',
    movesToEnd: 'Moves this section to the end',
    /** Over an open move's card: the section it moves, by its number now. */
    moving: (section: number) => `Moving section ${String(section)}`,
    /** Over an open class Proposal's card (#116): the section it protects, by its number now. */
    protecting: (section: number) => `Protection for section ${String(section)}`,
    /** What a class Proposal does (#116), heading its one card, by the class it gives. */
    marksEntrenched: 'Marks this section entrenched',
    marksEternal: 'Marks this section eternal. This can’t be undone.',
    removesProtection: 'Removes this section’s protection',
    /** The higher bar, in words, over a class Proposal's ballot (#116). */
    protectionBar: (average: string, zeros: string) =>
      `A section’s protection changes only at your group’s higher bar: an average of ${average} or more, with zeros under ${zeros}.`,
    /** The higher bar, in words, over a change, move or removal of an entrenched section (#116). */
    entrenchedBar: (average: string, zeros: string) =>
      `This section is entrenched, so this needs your group’s higher bar: an average of ${average} or more, with zeros under ${zeros}.`,
    readsAs: 'How it will read',
    proposed: 'Proposed text',
    onBallot: 'On the ballot',
    addVersion: 'Add your version',
    ballotFull: 'This ballot already has three versions.',
    yourVersion: 'Your version',
    joinedAfter: 'You joined after this opened, so you can’t vote on it.',
    notVotingLevel: 'You weren’t at a voting level when this opened, so you can’t vote on it.',
    /** Over the Dispatch a Proposal carries (#112). */
    dispatchHeading: 'If this passes',
    dispatchLine: 'Everyone in your group gets this Dispatch.',
    missingTitle: 'This Proposal isn’t on this device',
    missing: 'Go back to your group to see its open Proposals.',
    /** Over a priority vote's question (#107): its number, as any Proposal's (#123). */
    eyebrowPriority: (number: number) => `Proposal ${String(number)} · Priority vote`,
    eyebrowPriorityClosed: (number: number) => `Proposal ${String(number)} · Closed priority vote`,
    options: 'Options',
    optionsHint:
      'Score each option. The options that pass rank by their average, and the top one becomes your group’s focus.',
  },
  ballot: {
    version: (version: number) => `Version ${String(version)}`,
    scoreFor: (version: number) => `Score for version ${String(version)}`,
    /** Before a priority option's text, which follows in `<bdi>`: "Score for Fix the website". */
    scoreForOption: 'Score for',
    visibility: 'Everyone in your group sees your scores and note.',
    newVersion: 'A new version was added. Score it to update your ballot.',
    separator: '·',
    scores: ['Strongly opposed', 'Opposed', 'Neutral', 'Supportive', 'Strongly supportive'],
    scoreMissing: 'Choose a score from 0 to 4.',
    noteLabel: 'Note (optional)',
    reasonLabel: 'Your reason for a 0',
    betterLabel: 'What would make this a 3 for you?',
    noteMissing: 'Add your reason for the 0.',
    /** A note the person wrote on the same Dispatch in another group (#126; ADR-0065). */
    copiedNote:
      'You wrote this in another group. Write a fresh one for this group, so the two can’t be matched.',
    noteTooLong: (max: number) => `Keep the note to ${count(max)} characters or fewer.`,
    submit: 'Send your vote',
    update: 'Update your vote',
    closed: 'Voting has closed, so this ballot can’t change.',
    failed: 'Your vote couldn’t be saved on this device. Try again.',
  },
  meter: {
    /** The meter's eyebrow, over each version's two bars while the vote is open. */
    title: 'So far',
    label: (version: number) => `How version ${String(version)} stands so far`,
    optionLabel: (option: string) => `How ${option} stands so far`,
    average: 'Average',
    zeros: 'Zeros',
    /** The line the average must reach, from the bar, such as "needs 2.5". */
    averageLine: (line: string) => `needs ${line}`,
    /** The share of zeros it must stay under, from the bar, such as "under 8%". */
    zeroLine: (line: string) => `under ${line}`,
    /** Removal's zeros line (ADR-0075 §3): "one at most, or under 5%". */
    zeroLineOr: (allowed: number, line: string) =>
      `${allowed === 1 ? 'one' : count(allowed)} at most, or under ${line}`,
    percent: (percent: number) => `${count(percent)}%`,
    /** A bar's value, then how it stands against its line: "1.9 · Short by 0.1". */
    reading: (value: string, standing: string) => `${value} · ${standing}`,
    passes: 'Passes',
    short: (gap: string) => `Short by ${gap}`,
    tooManyZeros: (zeros: number, scorers: number) =>
      `Too many zeros: ${count(zeros)} of ${count(scorers)}`,
    noScores: 'No scores yet',
    scoredBy: (scorers: number, quorum: number) =>
      `Scored by ${count(scorers)} · needs ${count(quorum)}`,
  },
  result: {
    title: 'Result',
    passed: 'This passed. The Document now reads:',
    passedVersion: (version: number) =>
      `Version ${String(version)} passed. The Document now reads:`,
    passedRemoval: 'This passed. The Document no longer has this section.',
    passedVersionRemoval: (version: number) =>
      `Version ${String(version)} passed. The Document no longer has this section.`,
    /** A move's pass (#103), before the section it moved. */
    passedMove: 'This passed. The section has moved.',
    /** A class Proposal's pass (#116), by the class it gave, before the section. */
    passedEntrenched: 'This passed. The section is now entrenched.',
    passedEternal: 'This passed. The section is now eternal.',
    passedUnprotected: 'This passed. The section is no longer protected.',
    /** A new Document's pass (#92), before its first sections. */
    passedDocument: 'This passed. The new Document reads:',
    passedVersionDocument: (version: number) =>
      `Version ${String(version)} passed. The new Document reads:`,
    failed: 'This didn’t pass.',
    failedVersions: 'No version passed.',
    lapsed: 'Not enough people weighed in. This isn’t a no.',
    /** Before the names of the winning version's author, and the proposer if someone else. */
    thanks: 'Thank you,',
    and: 'and',
    end: '.',
    late: 'Your vote arrived after voting closed and wasn’t counted.',
    proposeAgain: 'Propose again',
    busy: 'This section has an open Proposal now. You can propose this again once it closes.',
    /** A version's unmet condition, such as "Version 2: too many zeros: 2 of 12." */
    unmet: (version: number, condition: string) => `Version ${String(version)}: ${condition}`,
    belowQuorum: (scorers: number, quorum: number) =>
      `Scored by ${count(scorers)}, but it needed ${count(quorum)}.`,
    shortOf: (average: string, line: string, gap: string) =>
      `Its average was ${average}, short of ${line} by ${gap}.`,
    tooManyZeros: (zeros: number, scorers: number) =>
      `Too many zeros: ${count(zeros)} of ${count(scorers)}.`,
    totals: 'Totals',
    /** One version's totals, such as "Scored by 5 · average 2.6 · 1 zero". */
    totalsLine: (scorers: number, average: string, zeros: number) =>
      `Scored by ${count(scorers)} · average ${average} · ${
        zeros === 0 ? 'no zeros' : zeros === 1 ? '1 zero' : `${count(zeros)} zeros`
      }`,
    noScores: 'Nobody scored it.',
    ballots: (n: number) =>
      n === 1 ? 'Individual ballots (1)' : `Individual ballots (${count(n)})`,
    noBallots: 'Nobody voted.',
    /** A score with its label, such as "3 · Supportive". */
    scored: (score: number, label: string) => `${String(score)} · ${label}`,
    /** One score on a ballot of several versions, such as "Version 1: 3 · Supportive". */
    scoreOn: (version: number, score: string) => `Version ${String(version)}: ${score}`,
    unscored: (version: number) => `Version ${String(version)}: not scored`,
    /** "Voting ran <start> – <end>.", its two times each in a `<time>` element. */
    ranFrom: 'Voting ran',
    ranTo: '–',
    ranEnd: '.',
    ranEarlyEnd: ', when everyone had voted.',
    /** A priority vote's result (#107). */
    focusNow: 'Your group’s focus is now:',
    noOption: 'No option passed, so your group’s focus stays as it was.',
    ranked: 'Passed, best first',
    notCleared: 'Didn’t clear the floor',
    /** The disclosure that holds a priority vote's totals and its ballots. */
    details: (n: number) =>
      n === 1 ? 'Totals and individual ballots (1)' : `Totals and individual ballots (${count(n)})`,
    /** Between an option, in `<bdi>`, and what follows, as in "Fix the website: 3 · Supportive". */
    optionSeparator: ':',
    notScored: 'not scored',
    priorityBusy: 'Your group has an open priority vote now. You can ask again once it closes.',
    /** "Individual scores and notes are visible until <date>. …", the date in a `<time>` element (#111). */
    visibleUntil: 'Individual scores and notes are visible until',
    visibleUntilEnd: '. Screenshots taken before then can outlast this.',
    /** "Individual scores and notes were cleared on <date>.", once the device has deleted them. */
    clearedOn: CLEARED_ON,
    clearedOnEnd: '.',
    /** "A record of this decision posted by <name> doesn’t match the ballots on this device." */
    mismatchBefore: 'A record of this decision posted by',
    mismatchAfter: 'doesn’t match the ballots on this device.',
  },
  leave: {
    open: 'Leave this group',
    title: 'Leave this group?',
    body: 'Leaving removes this group from this device. Others keep what they already have. When you leave, the group gets a new key, so this device and any backup can’t read what comes next.',
    confirm: 'Leave this group',
    cancel: 'Cancel',
    failed: 'Leaving couldn’t be saved on this device. Try again.',
    leaving: 'Leaving…',
    leavingNote:
      'This group leaves this device as soon as the relay has your leave. Until then, you can read it but not propose or vote.',
    noVoting: 'You’re leaving this group, so you can’t vote here.',
    noProposingTitle: 'You’re leaving this group',
    noProposing: 'You can’t propose changes in a group you’re leaving.',
  },
  tell: {
    action: 'Tell your group',
    /** Over the message Tell your group shares, which shows beneath it as it will read. */
    hint: 'Shares this message and a link to this vote:',
    /** Adds the Proposal's title to the message, for one share; it starts unticked every time. */
    includeTitle: 'Include the title',
    shared: 'Shared.',
    copied: 'Copied. Paste it into your group’s chat.',
    blocked: 'Sharing and copying are both blocked here. Tell your group in your chat instead.',
  },
  /**
   * The ready-made chat messages (#113; ADR-0074, Discussion bridge), one for
   * each moment of a vote. Each first sentence ends with `end`: a period, or
   * the quoted title when someone ticks Include the title (./chatMessages.ts).
   * The open lines' only other variable is the day voting ends.
   */
  chat: {
    open: (end: string, day: string) =>
      `A new Proposal is open in Reconcile${end} Voting ends ${day}.`,
    version: (end: string, day: string) =>
      `I added a version in Reconcile${end} Voting ends ${day}.`,
    closing: (end: string) => `A vote closes within a day in Reconcile${end}`,
    result: (end: string) => `A vote has finished in Reconcile${end}`,
    /** How a first sentence ends with no title. */
    untitled: '.',
    /** How it ends with the title, such as `: "Quiet hours".` */
    titled: (title: string) => `: "${title}".`,
    /** The chat bot's result post inside a Proposal's Discord thread (#123; ADR-0011). */
    concluded: 'The argument has concluded. A vote has finished in Reconcile.',
    /** The name of a Proposal's Discord thread: its number, never its title (#123; ADR-0039). */
    threadName: (number: number) => `Proposal ${String(number)} in Reconcile`,
  },
  decided: {
    title: 'Decided',
    empty: 'Nothing decided yet.',
    /** Each outcome as the Decided list names it. */
    outcomes: { pass: 'Passed', fail: 'Didn’t pass', lapse: 'Lapsed' },
    /** Added to an entry once this device has deleted its individual scores and notes (#111). */
    cleared: 'Scores cleared',
  },
  send: {
    sending: 'Sending…',
    saved: 'Saved on this device. It will send when you’re back online.',
    sent: 'Sent',
  },
  countdown: {
    closes: (left: string) => `Closes ${left}`,
    closed: 'Voting closed',
  },
  window: {
    label: 'Voting time (days)',
    closes: (day: string) =>
      `Closes about ${day}. The exact time is set when the relay receives it.`,
    range: (min: number, max: number) =>
      `Voting can run ${count(min)} to ${count(max)} days, from when the relay receives your Proposal.`,
    outside: (min: number, max: number) => `Choose from ${count(min)} to ${count(max)} days.`,
    fewer: '−',
    more: '+',
    runs: (days: number) => `Voting runs ${count(days)} days`,
  },
  markdown: {
    hint: '**bold**, *italic*, # heading, - list, [link](https://…). End a line with \\ for a line break.',
    modes: 'Write or preview',
    write: 'Write',
    preview: 'Preview',
    previewEmpty: 'Nothing to preview yet.',
  },
  diff: {
    added: 'added',
    removed: 'removed',
    legend: 'Added words are underlined and highlighted. Removed words are struck through.',
  },
  levels: {
    label: 'Your involvement',
    hint: 'Everyone in this group sees your choice. You can change it at any time.',
    /** Each level's name, in `LEVELS` order (Member, Collaborator, Co-Creator). */
    names: ['Member', 'Collaborator', 'Co-Creator'],
    /** What each level adds, in `LEVELS` order. */
    descriptions: [
      'Follow along and read',
      'Also vote, vouch and invite',
      'Also propose changes and add versions',
    ],
    save: 'Save your choice',
    failed: 'Your choice couldn’t be saved on this device. Try again.',
    following: 'You’re following this group. Choose Collaborator or Co-Creator to vote or propose.',
    notProposing: 'You vote on changes here. Choose Co-Creator to propose them.',
    change: 'Change your involvement',
  },
  /** Several Documents per group (#92): what leads a Proposal that changes or creates one. */
  documents: {
    /** Before a new Document's title, as in "New Document: Budget". */
    newPrefix: 'New Document:',
    missingTitle: 'This Document isn’t in this group',
    missing: 'Go back to your group to see its Documents.',
  },
  document: {
    pageTitle: 'Document',
    eyebrow: 'Document',
    propose: 'Propose a change',
    proposeLabel: (section: number) => `Propose a change to section ${String(section)}`,
    addVersion: 'Add your version',
    addVersionLabel: (section: number) => `Add your version to section ${String(section)}`,
    ballotFull: 'This section’s ballot already has three versions.',
    empty: 'This Document has no sections yet.',
    addHere: 'Add a section here',
    /** Each gap's name starts with its visible words, which name the spot too (WCAG 2.5.3). */
    addAtStartLabel: 'Add a section here, at the start',
    addAfterLabel: (section: number) => `Add a section here, after section ${String(section)}`,
    remove: 'Propose removing this section',
    removeLabel: (section: number) => `Propose removing this section, section ${String(section)}`,
    /** Move this section (#103), disabled with its reason while the section is busy. */
    move: 'Move this section',
    moveLabel: (section: number) => `Move this section, section ${String(section)}`,
    moving: 'This section has an open move.',
    /**
     * Protect this section (#116), or Change its protection on an entrenched
     * one; disabled, with Move, while the section is busy.
     */
    protect: 'Protect this section',
    protectLabel: (section: number) => `Protect this section, section ${String(section)}`,
    changeProtection: 'Change its protection',
    changeProtectionLabel: (section: number) => `Change its protection, section ${String(section)}`,
    /** Why Move and Protect wait, one line for both (#103, #116). */
    busy: (movable: boolean) =>
      movable
        ? 'You can move or protect this section once its open Proposal closes.'
        : 'You can protect this section once its open Proposal closes.',
    protecting: 'This section has an open vote on its protection.',
    /** In place of every action on an eternal section (#116). */
    eternal: 'This section is eternal. It can’t be changed.',
    /** Add a section here's choices (#103), in a menu its button names. */
    addSection: 'Section',
    addHeader: 'Section header',
    addSubheader: 'Subsection header',
    copy: 'Copy as Markdown',
    copyHint:
      'To start a fresh group from this Document, copy it, then paste it into Create group.',
    copied: 'Copied',
    copyFailed:
      'Copying is blocked here. The Document is selected below, so you can copy it yourself.',
    markdownLabel: 'The Document as Markdown',
  },
  /** A protected section's badge (#116; DESIGN.md Atom block), set as an eyebrow. */
  atomBadge: {
    entrenched: 'Entrenched',
    eternal: 'Eternal',
  },
  /**
   * A section's history, in its side sheet, and a Document's change log
   * (#104). Where a person's name or a date sits inside a line, the words
   * around it are kept apart, so the screen sets the name in `<bdi>` and the
   * date in `<time>`.
   */
  history: {
    open: 'History',
    /** Each section's History button: its visible word, then the section (WCAG 2.5.3). */
    openLabel: (section: number) => `History of section ${String(section)}`,
    title: (section: number) => `History of section ${String(section)}`,
    /** The sheet's heading for a section a pass has since removed, opened from the change log. */
    removedTitle: 'History of a removed section',
    close: 'Close',
    /** Under the heading while nothing has changed the section since it began. */
    unchanged: 'No Proposal has changed this section since it began.',
    founding: 'Founding text',
    writtenBy: 'Written by',
    founded: 'Founded',
    proposedBy: 'Proposed by',
    decided: 'Decided',
    /** In place of the text, for the pass that removed the section (#75). */
    removed: 'This removed the section.',
    /**
     * Where a passed move put the section (#103), over its text in its history
     * and in the change log: after the first words of the section it follows,
     * to the top, or to the end once that section had gone.
     */
    movedAfter: (words: string) => `Moved after ‘${words}’`,
    movedToTop: 'Moved to the top',
    movedToEnd: 'Moved to the end',
    /**
     * What a passed class change gave the section (#116), over its text in its
     * history and in the change log, by the class it gave: the names #116's
     * badges use, and lifting its protection for ordinary.
     */
    classChanged: {
      entrenched: 'Entrenched',
      eternal: 'Made eternal',
      ordinary: 'Protection lifted',
    },
    /** A group that hadn't posted a result on a coalition motion once results stopped counting. */
    noResult: 'No result',
    seeResult: 'See the full result',
    notPassed: (proposals: number) => `Proposals that didn’t pass (${count(proposals)})`,
  },
  changeLog: {
    pageTitle: 'Change log',
    eyebrow: 'Change log',
    /** The Document view's link to its change log. */
    link: 'Change log',
    lede: 'Every change that passed, newest first. Open one to see its section’s history.',
    /** In place of the lede while the log holds only the Document's beginning. */
    unchanged: 'Nothing has changed this Document since it began.',
    founded: 'Founding text',
    created: 'Started this Document',
    added: 'Added a section',
    changed: (words: string) => `Changed ‘${words}’`,
    removed: (words: string) => `Removed ‘${words}’`,
  },
  /**
   * Stewards and suspensions (#102). Where a person's name sits inside a
   * sentence, the words before and after it are kept apart, so the screen
   * sets the name in `<bdi>` (see `Named` in src/app/stewards.tsx).
   */
  stewards: {
    heading: 'Stewards',
    badge: 'Steward',
    /** Read between a level and the badge, as in "Ana, Co-Creator, Steward". */
    badgeSeparator: ',',
    seat: (seat: number) => `Seat ${String(seat)}`,
    empty: 'Empty',
    founderHold: 'Holds this seat until your group elects a steward.',
    termEnds: (date: string) => `Term ends ${date}.`,
    termEnded: (date: string) =>
      `Term ended ${date}. They stay steward until your group elects someone.`,
    secondSeat: (members: number) =>
      `A second seat opens once ${count(members)} people in your group vote.`,
    due: (seat: number) => `A steward election is due for seat ${String(seat)}.`,
    about: (days: number) =>
      `A steward can suspend someone at once, for ${count(days)} days, and turn off the chat bot or the front door while your group votes on it. Everyone in the group sees each one, and your group can recall a steward by a vote at any time.`,
    propose: 'Propose a steward',
    proposeFor: (seat: number) => `Propose a steward for seat ${String(seat)}`,
    recall: 'Propose recall',
    recallLabel: (name: string) => `Propose recall of ${name}`,
    suspend: 'Suspend',
    suspendLabel: (name: string) => `Suspend ${name}`,
    suspendedUntil: (date: string) => `Suspended until ${date}.`,
    /** A suspension a removal vote extends (ADR-0059): it ends when that vote closes. */
    suspendedUntilVote: (date: string) =>
      `Suspended until the vote on removing them closes, by ${date}.`,
    reasonPrefix: 'Reason:',
    youAreSuspended: (date: string) =>
      `A steward suspended you until ${date}. You can read, but not post, propose or vote.`,
    youAreSuspendedUntilVote: (date: string) =>
      `A steward suspended you until the vote on removing you closes, by ${date}. You can read and post one response on that vote, but not propose or vote.`,
    dialogTitle: { before: 'Suspend', after: '?' },
    dialogLine: (days: number) =>
      `Everyone in the group will see this. It ends after ${count(days)} days.`,
    reasonLabel: 'Reason (optional)',
    reasonHint: 'Say what happened, in a sentence. Everyone in the group reads it.',
    reasonTooLong: (max: number) => `Keep the reason to ${count(max)} characters or fewer.`,
    confirm: 'Suspend',
    cancel: 'Cancel',
    suspendFailed: 'The suspension couldn’t be saved on this device. Try again.',
    makeSteward: (seat: number) => ({ before: 'Make', after: `steward (seat ${String(seat)})` }),
    recallSteward: { before: 'Recall', after: 'as steward' },
    makeStewardTitle: (name: string, seat: number) => `Make ${name} steward (seat ${String(seat)})`,
    recallStewardTitle: (name: string) => `Recall ${name} as steward`,
    electLine: (days: number) =>
      `If this passes, they can suspend someone at once, for ${count(days)} days, until your group recalls them or their term ends.`,
    recallLine: 'If this passes, their seat is empty until your group elects a steward.',
    score: 'Your score',
    ownRecall: 'This Proposal would recall you as steward, so you don’t vote on it.',
    elected: (seat: number) => ({
      before: 'This passed.',
      after: `is now steward for seat ${String(seat)}.`,
    }),
    recalled: { before: 'This passed.', after: 'is no longer a steward.' },
    composerPageTitle: 'Propose a steward',
    composerTitle: (seat: number) => `Propose a steward for seat ${String(seat)}`,
    recallPageTitle: 'Propose a recall',
    recallTitle: (seat: number) => `Propose a recall for seat ${String(seat)}`,
    nomineeLabel: 'Who should hold this seat?',
    nomineeHint: 'Anyone who votes here and isn’t suspended can stand.',
    nomineeMissing: 'Choose who you’re proposing.',
    titleHint: 'It starts as what the ballot will say. Change it if you like.',
    whyHint: 'Tell your group why. They’ll talk it over before voting.',
    visibility: 'Everyone in your group sees this Proposal and that you made it.',
    submit: 'Propose this steward',
    recallSubmit: 'Propose this recall',
    failed: 'Your Proposal couldn’t be saved on this device. Try again.',
    unavailableTitle: 'This seat can’t take a Proposal now',
    unavailable:
      'Another steward Proposal for this seat may be open, or your group isn’t large enough for it yet. Go back to your group to see its stewards.',
    notAllowed: 'Your place in this group doesn’t include proposing.',
    noNominees: 'Nobody in your group can stand for this seat right now.',
  },
  /** Dissolving a group (#108; ADR-0051): the composer, and what its ballot decides. */
  dissolve: {
    propose: 'Propose dissolving the group',
    pageTitle: 'Propose dissolving',
    eyebrow: 'Dissolve',
    title: 'Propose dissolving the group',
    lede: 'If your group passes this, it ends. Every device keeps a read-only copy, and nothing new is sent or accepted.',
    bar: (average: string, zeros: string) =>
      `Dissolving needs more support than an ordinary change: an average of at least ${average}, with under ${zeros} zeros.`,
    titleHint: 'A few words your group will see on the ballot.',
    whyHint: 'Tell your group why it’s time. They’ll talk it over before voting.',
    wipeLabel: 'Also erase it from every device',
    wipeHint:
      'Each copy of Reconcile will erase this group. No app can stop someone who already kept a copy, a screenshot or a backup file.',
    visibility: 'Everyone in your group sees this Proposal and that you made it.',
    submit: 'Propose dissolving',
    failed: 'Your Proposal couldn’t be saved on this device. Try again.',
    unavailableTitle: 'You can’t propose dissolving now',
    notAllowed: 'Your place in this group doesn’t include proposing.',
    alreadyOpen:
      'A Proposal to dissolve this group is already open. Go back to your group to vote on it.',
    ballotTitle: 'Dissolve the group',
    keepLine: 'If this passes, your group ends. Every device keeps a read-only copy.',
    wipeLine: (days: number) =>
      `If this passes, your group ends, and every device erases it ${count(days)} days later.`,
    passed: 'This passed. Your group has dissolved.',
  },
  /** A dissolved group's read-only copy on this device (#108). */
  removal: {
    /** On a person's row in the People list, read with their name: "Propose removing Kim". */
    propose: 'Propose removing',
    proposeLabel: (name: string) => `Propose removing ${name}`,
    pageTitle: 'Propose removing someone',
    eyebrow: 'Removal',
    title: 'Propose a removal',
    /** What the title starts as: what the ballot will say. */
    titleDefault: (name: string) => `Remove ${name}`,
    /** The bar in words, from the engine: "an average of at least 3.0, and no more than one 0 unless fewer than 5% scored 0". */
    bar: (average: string, allowed: number, zeros: string) =>
      `This needs a higher bar: an average of at least ${average}, and no more than ${
        allowed === 1 ? 'one 0' : `${count(allowed)} 0s`
      } unless fewer than ${zeros} scored 0.`,
    /** After the bar, read after their name: "<name> can’t vote on it, but can post one response." */
    cantVote: 'can’t vote on it, but can post one response.',
    runs: (days: number) => `Voting runs ${count(days)} days, and nobody can make it shorter.`,
    titleHint: 'It starts as what the ballot will say. Change it if you like.',
    whyHint:
      'Say what happened and what your group has tried. Everyone in the group reads it, including the person you’d remove.',
    visibility: 'Everyone in your group sees this Proposal and that you made it.',
    submit: 'Propose this removal',
    failed: 'Your Proposal couldn’t be saved on this device. Try again.',
    unavailableTitle: 'You can’t propose this removal now',
    notAllowed: 'Your place in this group doesn’t include proposing a removal.',
    notMember: 'They aren’t in this group now. Go back to your group to see who is.',
    yourself: 'You can’t propose removing yourself. To go, choose Leave this group.',
    alreadyOpen:
      'A vote on removing them is already open, or has passed. Go back to your group to see it.',
    ballotTitle: { before: 'Remove', after: 'from the group' },
    ballotLine:
      'If this passes, they leave the group, and the group gets a new key, so they see nothing new. They keep what they already had.',
    ownRemoval:
      'This Proposal would remove you, so you don’t vote on it. You can post one response.',
    /** Read right after their name, over the response: "Kim’s response". */
    responseOf: '’s response',
    /** Read after their name while the vote is open and they haven’t: "Kim hasn’t posted a response." */
    noResponse: 'hasn’t posted a response.',
    respondLabel: 'Your response',
    respondHint:
      'Everyone in the group reads it on the ballot. You can post one, and can’t change it after.',
    respond: 'Post your response',
    respondEmpty: 'Write your response first.',
    respondTooLong: (max: number) => `Keep your response to ${count(max)} characters or fewer.`,
    respondFailed: 'Your response couldn’t be saved on this device. Try again.',
    passed: { before: 'This passed.', after: 'is no longer in this group.' },
    passedYou: 'This passed. You’re no longer in this group.',
    eyebrowRemoved: 'Removed',
    removedOn: (date: string) =>
      `You were removed from this group by a vote on ${date}. You keep what’s already on this device, but you won’t see anything new.`,
    stillOpen: 'Open when you were removed',
    stillOpenLine: 'You won’t see how this ends',
    readOnlyTitle: 'You were removed from this group',
    readOnly: 'This is a read-only copy. Nothing new can be proposed or voted on.',
  },
  archive: {
    eyebrow: 'Dissolved',
    dissolvedOn: (date: string) => `This group dissolved on ${date}. This is a read-only copy.`,
    erasedOn: (date: string) => `It will be erased from this device on ${date}.`,
    remove: 'Remove from this device',
    removeTitle: 'Remove this group from this device?',
    removeBody:
      'This erases your read-only copy of this group from this device. Others keep their own copies.',
    removeConfirm: 'Remove from this device',
    cancel: 'Cancel',
    removeFailed: 'This group couldn’t be removed from this device. Try again.',
    unfinished: 'Not decided',
    closed: 'Closed when the group dissolved',
    readOnlyTitle: 'This group has dissolved',
    readOnly: 'This is a read-only copy. Nothing new can be proposed or voted on.',
    cleared: (date: string) => `${CLEARED_ON} ${date}.`,
  },
  /**
   * A group a restore brought back that hasn't heard from the group since its
   * copy was made (#231; ADR-0051's 2026-11-11 amendment). It may have
   * dissolved meanwhile, so it reads only until this device hears something
   * new, or the person opens a new invite link from someone in it.
   */
  unconfirmed: {
    eyebrow: 'Read-only for now',
    note: 'This copy came from a backup, and nothing new from your group has reached this device since. If your group dissolved after the backup was made, this copy stays read-only.',
    opens:
      'It opens as usual as soon as this device sees anything new from your group. To open it sooner, ask someone in your group for a new invite link and open it here.',
    noVoting:
      'This copy came from a backup and hasn’t heard from your group since, so you can’t vote here yet.',
    readOnlyTitle: 'This group is read-only for now',
    readOnly:
      'This copy came from a backup and hasn’t heard from your group since. Nothing new can be proposed or sent until it does.',
  },
  /**
   * The group's opt-ins (#117; ADR-0038, ADR-0039, ADR-0040): the Discord chat
   * bot and the front door. Each changes only by a Proposal, so nothing here
   * reads as a switch. Each warning says what the outside platform would hold.
   */
  optIns: {
    pageTitle: 'Group rules',
    eyebrow: 'Group rules',
    title: 'What reaches outside your group',
    lede: 'Your group decides each of these by a Proposal. Nobody can turn one on alone.',
    founding: 'The other rules were set when your group was founded, and they don’t change.',
    names: { chatBot: 'Discord chat bot', frontDoor: 'Front door' },
    warnings: {
      chatBot:
        'Discord’s servers will hold that this group uses Reconcile, when votes open and close, and each Proposal’s number. They won’t see titles, text, names or votes. Anyone in the channel sees the nudges. Discord also sees the internet address of the member’s phone that posts each notice.',
      frontDoor:
        'Anyone with the address can see the group’s name and a short excerpt of its mission statement, and ask to join. It never lists people.',
    },
    current: 'Now',
    off: { chatBot: 'Off', frontDoor: 'Closed' },
    on: { chatBot: 'On', frontDoor: 'Open' },
    /** Before the webhook's last 4 characters, which sit in a mono span. */
    webhookEnding: 'Webhook ending in',
    narrowed: { before: 'Off for now. Steward', after: 'turned it off while your group votes.' },
    voting: 'Your group is voting on this now.',
    seeVote: 'See the vote',
    proposeOn: 'Propose turning this on',
    proposeOff: 'Propose turning this off',
    turnOffNow: 'Turn off now',
    /** Each opt-in's name inside a sentence. */
    inSentence: { chatBot: 'Discord chat bot', frontDoor: 'front door' },
    /** Read after a link's own words, so two alike links say which opt-in each is for. */
    forOptIn: (name: string) => `for the ${name}`,
    homeHeading: 'Rules',
    homeLink: 'Chat bot and front door',
    homeSummary: (bot: string, door: string) => `Chat bot: ${bot} · Front door: ${door}`,
    /** Group home's word for the front door once a membership's end closed it (#288). */
    closedByLeave: 'Closed when a member left',
    /** What each change does, as its ballot is headed and its title starts. */
    motions: {
      chatBot: {
        on: 'Turn on the Discord chat bot',
        off: 'Turn off the Discord chat bot',
        replace: 'Replace the chat bot’s webhook',
      },
      frontDoor: {
        on: 'Open a front door',
        off: 'Close the front door',
        replace: 'Change the front door',
      },
    },
    /** What passing does, under the ballot's heading. */
    lines: {
      chatBot: {
        on: 'If this passes, the bot posts content-free nudges in the channel the webhook belongs to.',
        off: 'If this passes, the bot stops posting.',
        replace:
          'If this passes, the bot posts through the new webhook. Delete the old one in Discord, so nobody who still has it can post there.',
      },
      frontDoor: {
        on: 'If this passes, your group gets a public page where people can ask to join.',
        off: 'If this passes, the front door closes.',
        replace: 'If this passes, the front door changes.',
      },
    },
    /** What else a front door change does, after its line (#121). */
    doorCount: {
      shows: 'Its page shows how many people are in your group.',
      hides: 'Its page stops showing how many people are in your group.',
      moves: 'It moves to a new link, and the old link closes.',
    },
    /**
     * A listing (#485; ADR-0081): what passing does, after the line; the
     * heading and the pass of a change to the listing alone; and an opening
     * that also lists.
     */
    listing: {
      lines: {
        list: 'Your group’s name goes on the public shelf, under the covenant below.',
        unlist: 'Your group comes off the public shelf.',
        renew:
          'Your group’s listing accepts the covenant below in place of the one it accepted before.',
        /** A change that keeps a door at the address whose listing a narrowing ended (#501). */
        ended:
          'A steward’s narrowing took your group off the public shelf for good at this link, so passing this doesn’t list the door again.',
      },
      motions: {
        list: 'List the front door on the public shelf',
        unlist: 'Take the front door off the public shelf',
        renew: 'Accept the new covenant',
      },
      passed: {
        list: 'This passed. Your group’s front door is listed on the public shelf.',
        unlist: 'This passed. Your group’s front door is off the public shelf.',
        renew: 'This passed. Your group’s listing accepts the new covenant.',
      },
      openedAndListed:
        'This passed. Your group’s front door is open and listed on the public shelf.',
      /** Opening a door's choice to list it too, never ticked for the proposer. */
      choiceLabel: 'Also list it on the public shelf',
      choiceHint:
        'Its name goes in a public list anyone with the app can read. Your group votes on a covenant too.',
      proposeList: 'Propose listing this door',
      proposeUnlist: 'Propose taking it off the shelf',
      /** Group rules, under an open front door that is listed. */
      listed: 'Listed on the public shelf, under the covenant your group accepted.',
      /** Group rules, once a steward's narrowing ended the door's listing for good (#501). */
      ended:
        'Not listed. A steward’s narrowing took this door off the public shelf for good. Your group can vote afresh to list it again, at a new link.',
      /** The listing composer, when listing again moves the door to new keys (#501). */
      newLink:
        'The shelf keeps this door’s old listing final, so listing it again moves it to a new link, and the old link closes.',
      unavailable:
        'Only an open front door can be listed. Go back to your group’s rules to see where it stands.',
      /** Before a listing vote, when a listed group already holds a name like this one (#487). */
      lookAlike:
        'A listed group already uses a name like this. Yours won’t be shown while theirs is.',
    },
    /** A pass's outcome sentence. */
    passed: {
      chatBot: {
        on: 'This passed. The Discord chat bot is on.',
        off: 'This passed. The Discord chat bot is off.',
        replace: 'This passed. The bot posts through the new webhook.',
      },
      frontDoor: {
        on: 'This passed. Your group’s front door is open.',
        off: 'This passed. The front door is closed.',
        replace: 'This passed. The front door changed.',
      },
    },
    narrowedBallot: {
      before: 'Steward',
      after: 'turned this off at once. It stays off while your group votes.',
    },
    /** Group rules' front door, once a membership's end closed it (#288). */
    doorClosedByLeave:
      'The front door closed because a member left, and they still have its keys. A new Proposal to open it reopens it, with new keys and a new link.',
    /**
     * A front door Proposal that was open when a member left (#288): what
     * passing it does, after its line, and its pass, which opens no door.
     */
    exposed: {
      line: 'A member left while this vote was open, and they have the keys it carries, so if it passes the front door stays closed. A new Proposal to open it reopens it.',
      passed:
        'This passed, but the front door stays closed: a member left while the vote was open, and they have its keys. A new Proposal to open it reopens it.',
    },
    composerPageTitle: 'Propose a rules change',
    nowTitle: (motion: string) => `${motion} now`,
    higherBar: (average: string, zeros: string) =>
      `Turning this on needs your group’s higher bar: an average of ${average} or more, with zeros under ${zeros}.`,
    nowLine: 'It’s off until the group decides. This Proposal asks the group to keep it off.',
    webhookLabel: 'Discord webhook URL',
    webhookHint:
      'In Discord, open the channel’s settings › Integrations › Webhooks › Copy Webhook URL. Use a text channel, or a forum channel to give each Proposal its own thread. Only your group’s devices keep it, and the ballot shows only its last 4 characters.',
    webhookMissing: 'Paste the webhook URL from Discord.',
    webhookInvalid: 'Use a Discord webhook URL, starting with https://discord.com/api/webhooks/.',
    submitNow: 'Turn off now',
    unavailableTitle: 'This can’t take a Proposal now',
    unavailable:
      'Your group may be voting on this already. Go back to your group’s rules to see where it stands.',
    nowUnavailable:
      'You can’t turn this off at once right now. You can still propose turning it off.',
  },
  /**
   * The covenant a listed door accepts (#485; ADR-0081 §3), wherever it
   * shows: the listing composer and the ballot. Its text lives in
   * src/shelf/covenant.ts; this is what is said around it.
   */
  covenant: {
    heading: 'The covenant',
    draft: 'Draft',
    draftLine: 'This is a draft. Its wording isn’t final yet.',
    exposure:
      'Your group’s name will be public beside the words it votes to publish. Anyone can read them, and copy them before they come down. Members’ devices post the listing, so whoever runs the relay can tell which devices are in your group.',
    unknown:
      'This vote names a covenant this app doesn’t have. Update Reconcile to read it before you vote.',
  },
  /**
   * A group's front door (#121; ADR-0038): the public page, its form, and
   * what members and applicants see of what follows. Where a name sits inside
   * a sentence, the words around it are kept apart, so the screen sets the
   * name in `<bdi>`.
   */
  /**
   * A vote link (#472, ADR-0079): the screen `#vote/{token}` opens, which
   * shows only while it looks, or when the vote isn't on this device. Its
   * words never name a group, and never vary with the token.
   */
  vote: {
    pageTitle: 'A vote',
    title: 'A vote',
    looking: 'Looking for this vote on this device…',
    missing:
      'This vote isn’t on this device. It opens only on a device that’s in the vote’s group.',
    /** Copy link to this vote, on a Proposal's page and on its result. */
    copyLabel: 'Link to this vote',
    copyHint: 'Only people in this group can open this link.',
    copy: 'Copy link to this vote',
  },
  door: {
    /** The tab's title on every state: never the group's own name, which browser history would keep. */
    pageTitle: 'Front door',
    eyebrow: 'Front door',
    loading: 'Opening the front door…',
    closed: 'This front door is closed.',
    closedHint: 'If you know someone in the group, ask them for an invite link.',
    damaged: 'This front door link is damaged. Check you copied all of it.',
    offlineTitle: 'Can’t open this front door yet',
    offline: 'Can’t reach the relay right now. Check your connection, then try again.',
    retry: 'Try again',
    /** The page's excerpt, read as a quotation from the group. */
    excerptLabel: 'From their Document',
    people: (n: number) =>
      n === 1 ? '1 person is in this group.' : `${count(n)} people are in this group.`,
    askHeading: 'Ask to join',
    nameLabel: 'Name you’d like to use',
    nameHint: 'Only this group sees it. It doesn’t have to be your real name.',
    nameMissing: 'Add the name you’d like to use.',
    nameTooLong: (max: number) => `Use ${count(max)} characters or fewer.`,
    messageLabel: 'Why you’d like to join',
    messageHint: (max: number) => `Up to ${count(max)} characters.`,
    messageMissing: 'Say a little about why you’d like to join.',
    messageTooLong: (max: number) => `Use ${count(max)} characters or fewer.`,
    careful: 'Don’t include anything you wouldn’t want this group to read.',
    /** On an open door, for a device in a group that may take a card (#426). */
    proposeReconciling: 'Propose reconciling with this group',
    /** The picker under the message (#425): a checkbox per personal Document, none checked. */
    documentsLabel: 'Send some of your own Documents with this',
    documentsHint:
      'This group’s members will read the ones you check. Another group you send them to could recognize the same words.',
    documentsTooMany: (max: number) => `Send up to ${count(max)} Documents with one request.`,
    documentsTooLong: 'That’s more than one request can carry. Choose fewer or shorter Documents.',
    /** In the picker's place at a door the shelf lists, while it's newly listed or held (#432, §5.3). */
    newlyListed: 'This group is newly listed, so you can’t attach Documents yet.',
    /** On a door whose listing the steward suspended (#489, §6.1), naming the clause in words. */
    removedListing: (clause: string) =>
      `Reconcile’s steward removed this group’s listing from the public shelf: ${clause}.`,
    send: 'Send',
    failed: 'Your request didn’t go. Check your connection, then try again.',
    /** Around the group's name: "Sent. If someone in Riverside Tenants invites you, it shows on Your groups." */
    sent: { before: 'Sent. If someone in', after: 'invites you, it shows on Your groups.' },
    asked: {
      before: 'You asked to join',
      after: 'from this device. Any invite shows on Your groups.',
    },
    yourGroups: 'Go to Your groups',
    /** The install guide (ADR-0029): an iPhone outside the installed app copies the link instead. */
    installLabel: 'This front door’s link',
    installHint: 'Copy it now, then paste it into Reconcile once it’s on your Home Screen.',
    copyLink: 'Copy link',
    openToApply:
      'Open Reconcile from your Home Screen and paste the front door link into the bar at the top.',
    /** Start's list of this device's requests. */
    requestsHeading: 'Asked to join',
    waiting: (day: string) => `Asked ${day}. No invite yet.`,
    /** After the group's name: "Riverside Tenants invited you". */
    invitedYou: 'invited you',
    openInvite: 'Open your invite',
    /** Group home's Applications, for members who may invite. */
    applications: 'Applications',
    applicationsLede:
      'People who asked to join at your front door. Only your group’s devices can read these.',
    noApplications: 'No one has asked to join yet.',
    /** Over the Documents an application carries a copy of (#425). */
    documentsSent: 'Documents they sent',
    /** Applications' reconcile cards left at the door (#426). */
    cardsHeading: 'Groups asking to reconcile',
    cardArrived: (day: string) => `Arrived ${day}`,
    /** A card's heading before it has opened, or once it can't. */
    cardUnopened: 'A reconcile card',
    bringToVote: 'Bring it to a vote',
    /** Read after Bring it to a vote's own words: "Bring it to a vote for Eastside Housing". */
    forCard: (name: string) => `for ${name}`,
    /** Read after Dismiss's own word: "Dismiss the card for Eastside Housing". */
    cardOf: (name: string) => `the card for ${name}`,
    /** Read after Dismiss for a card that never opened: "Dismiss the card that arrived Sat 14 Nov". */
    cardOn: (day: string) => `the card that arrived ${day}`,
    cardExpired: 'This card has expired.',
    cardOffline: 'Can’t open this card right now. Check your connection, then look again.',
    dismissCardHint: 'Dismisses it for everyone in your group.',
    askedOn: (day: string) => `Asked ${day}`,
    /** Before the inviter's name: "Invited by Ana". */
    invitedBy: 'Invited by',
    sendInvite: 'Send an invite',
    /** Read after Send an invite's own words, so each button says whose it is. */
    forApplicant: (name: string) => `to ${name}`,
    dismiss: 'Dismiss',
    /** Read after Dismiss's own word: "Dismiss Kim’s application". */
    applicationOf: (name: string) => `${name}’s application`,
    dismissHint: 'Hides it on this device only.',
    sending: 'Sending the invite…',
    inviteSent: 'Invite sent. It waits 2 days for their device.',
    inviteFailed: 'The invite didn’t go. Check your connection, then try again.',
    /** Group rules' front door card, while the door is open. */
    linkLabel: 'Front door link',
    linkHint:
      'Post it anywhere. Whoever opens it sees your group’s name and the first section of your Document, and can ask to join.',
    counted: 'It shows how many people are in your group.',
    uncounted: 'It doesn’t show how many people are in your group.',
    /** The opt-in composer's one choice when it opens the door. */
    countLabel: 'Show how many people are in the group',
    countHint: 'Off unless your group chooses it. The page never shows who they are.',
  },
  // Personal (#93): a person's own Documents, kept on this device only (ADR-0001).
  personal: {
    pageTitle: 'Personal',
    title: 'Personal',
    lede: 'Documents of your own. Nobody votes on them: you change them whenever you like.',
    /** Personal's line on where Documents go, while the device keeps no relay backup key. */
    privacy:
      'They stay on this device. Nothing here is sent to the relay or to your groups, unless you share one by link or send one with a request to join. A backup file you save includes them.',
    /** In place of privacy once the device keeps a relay backup key (#97, #248): its sealed copy carries them. */
    privacyRelayBackup:
      'They stay on this device. Nothing here goes to your groups. A backup file you save includes them, and so does your sealed relay backup.',
    /** The editor's line on where its Document goes, while the device keeps no relay backup key. */
    documentPrivacy:
      'This stays on this device. Nothing here is sent to the relay or to your groups, unless you send it with a request to join. A backup file you save includes it.',
    /** In place of documentPrivacy once the device keeps a relay backup key (#97, #248). */
    documentPrivacyRelayBackup:
      'This stays on this device. Nothing here goes to your groups. A backup file you save includes it, and so does your sealed relay backup.',
    missionTitle: 'My mission statement',
    missionPrompt: 'What do you stand for, and what are you working toward?',
    newDocument: 'New document',
    /** Personal's quiet link to Settings, which the tab bar's Me reaches through it (#423). */
    settings: 'Settings',
    documentPageTitle: 'Personal Document',
    eyebrow: 'Personal',
    untitled: 'Untitled',
    titleLabel: 'Title',
    titleMissing: 'Give this Document a title.',
    titleTooLong: (max: number) => `Keep the title to ${count(max)} characters or fewer.`,
    textLabel: 'Text',
    textHint: 'Nobody votes on this. It saves on this device as you type.',
    saved: 'Saved on this device.',
    notSaved: 'Not saved yet. Fix the title to save your changes.',
    failed: 'Your changes couldn’t be saved on this device. Keep typing to try again.',
    unreadable: 'This Document couldn’t be read on this device. Reload Reconcile, then try again.',
    delete: 'Delete',
    /** Around the Document's title, which renders in its own `<bdi>`: "Delete ‘Mine’ from this device?" */
    deleteBefore: 'Delete ‘',
    deleteAfter: '’ from this device?',
    deleteBody: 'A backup you saved earlier still has it.',
    deleteConfirm: 'Delete',
    deleteCancel: 'Cancel',
    deleteFailed: 'It couldn’t be deleted from this device. Try again.',
    /** Under Delete's question, for a shared Document (#105): deleting stops its link first. */
    deleteShared: 'Deleting it stops sharing its link first, which needs the relay.',
    deleteSharedFailed:
      'Sharing couldn’t be stopped, so nothing was deleted. Check your connection, then try again.',
    /** Under a shared Document's title on Personal (#105). */
    sharedLine: 'Shared by link',
    /** In place of sharedLine while a restore has paused the Document's share (#328). */
    pausedLine: 'Link paused after a restore',
    /** In place of sharedLine once this device hasn't posted to the share for 30 days (#339). */
    idleLine: 'Link paused after 30 days without an update',
    /** In place of documentPrivacy while the Document is shared (#105). */
    sharedPrivacy:
      'This stays on this device, and a sealed copy of its latest version waits on the relay for its link. Nothing here is sent to your groups. A backup file you save includes it.',
    /** In place of sharedPrivacy once the device keeps a relay backup key (#97, #248). */
    sharedPrivacyRelayBackup:
      'This stays on this device, and a sealed copy of its latest version waits on the relay for its link. Nothing here is sent to your groups. A backup file you save includes it, and so does your sealed relay backup.',
    /**
     * Share link (#105; ADR-0074's personal page at level 2): one Document,
     * read-only, by a link whose key only its holders have.
     */
    share: {
      heading: 'Share by link',
      /** Before it's on: what the link shows, and to whom. */
      about:
        'Share link makes a link anyone can open in any browser to read this Document’s latest version, without joining anything. They see its title and text, never your name, your groups or your other Documents.',
      /** Before it's on: what the relay keeps and sees (ADR-0075 §2). */
      relay:
        'The relay keeps only a sealed copy it can’t read. As when your groups sync, it sees this device’s internet address while it posts, so someone watching it live could tell this device also uses your groups.',
      start: 'Share link',
      starting: 'Making your link…',
      startFailed:
        'The link couldn’t be made, so nothing was shared. Making one needs the relay. Check your connection, then try again.',
      tooLarge: 'This Document is too long to share by link. Shorten it, then try again.',
      tooLargeShared:
        'This Document is now too long for its link, which still shows the last version that fit. Shorten it to update the link.',
      field: 'Link',
      /** Beside the link: who can read it, and when it stops. */
      warning:
        'Anyone with this link can read this Document. It stops working if you don’t open Reconcile for 30 days.',
      /** How edits reach the link. */
      edits: 'Your edits reach the link when you leave this page.',
      pending:
        'Your latest changes haven’t reached the link yet. Reconcile sends them the next time it opens online.',
      shareAgain: 'Share link again',
      shared: 'Shared.',
      copied: 'Copied. Send it to the people you want to read it.',
      blocked: 'Copying is blocked here. Select the link above and copy it yourself.',
      /** What the share sheet carries beside the link: fixed, never the Document's words (spec §9). */
      message: 'Something I wrote, shared read-only with Reconcile:',
      stop: 'Stop sharing',
      stopping: 'Stopping…',
      stopped:
        'Sharing stopped. People who opened the link may have kept a copy, and earlier copies stay on the relay, still sealed, until they expire within a month.',
      stopFailed:
        'Sharing couldn’t be stopped, so nothing changed and the link still works. Stopping needs the relay. Check your connection, then try again.',
      /**
       * In place of the link while a restore has paused the share (#328): the
       * backup may predate Stop sharing, so nothing is sent until the person chooses.
       */
      paused: 'This link was live when the backup was made. Keep sharing?',
      /**
       * In place of paused once this device hasn't posted to the share for 30
       * days (#339): another device may have stopped it, and its tombstone lapsed.
       */
      pausedIdle:
        'This device hasn’t updated this link in 30 days, so it may have been stopped on another device. Keep sharing?',
      pausedNote:
        'Nothing goes to the link until you choose. Keep sharing sends it this Document’s latest version.',
      keep: 'Keep sharing',
      keeping: 'Updating the link…',
      kept: 'Still shared. The link shows this Document’s latest version.',
      keptPending: 'Still shared. The link hasn’t caught up with this Document yet.',
      keepStopped: 'This link had already been stopped, so it stays off.',
      pausedStopFailed:
        'Sharing couldn’t be stopped, so the link stays paused. Stopping needs the relay. Check your connection, then try again.',
      /** In place of the link while the device's keys are locked with a passkey, which holds its seed (#255). */
      locked:
        'This Document is shared by link, but your keys on this device are locked with your passkey. Close Reconcile, open it again and unlock it to see the link, stop sharing or delete this Document.',
      /**
       * In place of the paused question while the device's keys are locked (#255, #328):
       * keeping or stopping a share needs its keys, and nothing goes to the link meanwhile.
       */
      lockedPaused:
        'This link was live when the backup was made, and nothing goes to it until you choose. Your keys on this device are locked with your passkey. Close Reconcile, open it again and unlock it to keep sharing, stop sharing or delete this Document.',
      /**
       * In place of pausedIdle while the device's keys are locked (#255, #339): this device
       * hasn't posted to the share for 30 days, and nothing goes to the link meanwhile.
       */
      lockedIdle:
        'This device hasn’t updated this link in 30 days, so it may have been stopped on another device, and nothing goes to it until you choose. Your keys on this device are locked with your passkey. Close Reconcile, open it again and unlock it to keep sharing, stop sharing or delete this Document.',
      /** When Share link, Stop sharing or Keep sharing finds the keys locked, as another tab can lock them (#255). */
      lockedNow:
        'Your keys on this device are locked with your passkey, so nothing changed. Close Reconcile, open it again and unlock it, then try again.',
    },
  },
  /**
   * The page a share link opens (#105), for anyone, in any browser, outside
   * first run: it reads the Document and keeps nothing.
   */
  shared: {
    /** The tab's title: never the Document's own words, which browser history would keep. */
    pageTitle: 'Shared page',
    note: 'Shared with Reconcile. Read-only.',
    loading: 'Opening the page…',
    empty: 'Nothing is written here yet.',
    goneTitle: 'This link doesn’t work',
    gone: 'This page isn’t shared any more, or the link is damaged.',
    offlineTitle: 'Can’t open this page yet',
    offline: 'Can’t reach the relay right now. Check your connection, then try again.',
    retry: 'Try again',
  },
  /**
   * Earning a vote (#101; ADR-0014, ADR-0021): a newcomer's progress on the
   * People list, Vouch and its dialog, and the newcomer's own lines. Where a
   * name sits inside a sentence, the words around it are kept apart, so the
   * screen sets the name in `<bdi>`.
   */
  admission: {
    /** The first word of a newcomer's progress, as in "New · 1 of 2 vouches · wait ends Sun 22 Nov". */
    newcomer: 'New',
    /** Between the parts of a newcomer's progress. */
    separator: '·',
    vouches: (have: number, need: number) => `${count(have)} of ${count(need)} vouches`,
    waitEnds: (date: string) => `wait ends ${date}`,
    canVoteFrom: (date: string) => `can vote from ${date}`,
    /** Before the names of everyone who has vouched for a newcomer, as in "Vouched for by Ana and Ben". */
    vouchedBy: 'Vouched for by',
    vouchFor: { before: 'Vouch for' },
    dialogTitle: { before: 'Vouch for', after: '?' },
    dialogLine:
      'Vouch only for someone you’ve met or talked with, on a call or in person. Everyone in the group sees your vouch.',
    confirm: 'Vouch',
    cancel: 'Cancel',
    failed: 'Your vouch couldn’t be saved on this device. Try again.',
    /** A newcomer's own line before anyone has given them every vouch they need, while the wait runs. */
    voteAfterOnce: (date: string, need: number) =>
      `You can vote on Proposals that open after ${date}, once ${count(need)} people vouch for you.`,
    /** A newcomer's own line once the wait has ended without every vouch they need. */
    voteOnce: (need: number) =>
      `You can vote on Proposals that open once ${count(need)} people vouch for you.`,
    /** A newcomer's own line once vouched for, while the wait runs. */
    voteAfter: (date: string) => `You can vote on Proposals that open after ${date}.`,
    /** Under the level picker while a newcomer earns their vote. */
    levelsWait: 'Voting and proposing start once you have a vote. Until then, you read and follow.',
    /** On a Proposal that opened before this member's vote arrived. */
    noVoteYet: 'You didn’t have a vote yet when this opened.',
  },
  // Settings (#78): save and restore a backup, and Erase (ADR-0046 as cut by ADR-0073).
  settings: {
    pageTitle: 'Settings',
    title: 'Settings',
    notifyHeading: 'Notifications',
    backupHeading: 'Back up your groups',
    recoveryHeading: 'Recovery contacts',
    restoreHeading: 'Restore a backup',
    linkHeading: 'Link a new device',
    passkeyHeading: 'Lock with a passkey',
    bedfellowsHeading: 'Bedfellows',
    eraseHeading: 'Erase this device',
    stewardHeading: 'Steward key',
  },
  // The build a device runs, and a new one waiting (#513; ADR-0073's 2026-11-19 amendment).
  update: {
    /** Settings' last line: the build's version, so devices can be compared before a protocol change. */
    version: (id: string) => `Version ${id}`,
    /** On Start and Settings while a new version is installed and waits for the next launch. */
    ready: 'A new version is ready. Close and reopen Reconcile.',
  },
  // The steward's key (#488; docs/spec/listed-doors.md §6.2, §6.4): quiet in
  // Settings, for the one device of the platform's steward, the founder during
  // the pilot. The console lists listings waiting for release, holds, what
  // stands on the shelf and the pause (#489).
  shelfSteward: {
    keyLede:
      'Only for Reconcile’s steward, who releases groups onto the public shelf. Nobody else needs this.',
    label: 'Steward secret',
    import: 'Import',
    importing: 'Importing…',
    wrong: 'That isn’t the steward’s secret this app knows.',
    locked: 'Unlock your keys first, then import it.',
    failed: 'It wasn’t kept. You can try again.',
    held: 'This device holds the steward key.',
    open: 'Open the steward’s console',
    pageTitle: 'Steward',
    title: 'Steward’s console',
    consoleLede:
      'Listings wait here until you release them. Readers will see the name and the covenant, and nothing else.',
    waitingHeading: 'Waiting for release',
    none: 'No listing is waiting.',
    unavailable: 'The relay has no public shelf.',
    readFailed: 'The shelf couldn’t be read. Try again later.',
    covenantCurrent: 'Accepted this app’s covenant',
    covenantOther: 'Accepted another covenant version',
    waitingSince: (date: string) => `Waiting since ${date}`,
    lookalike: 'A live listing holds a name like this one:',
    lookalikeHint: 'Released, this listing would sit behind it, unseen, with its entries.',
    willSee: (name: string) => `Readers will see “${name}” on Discover.`,
    release: 'Release',
    releasing: 'Releasing…',
    released: 'Released. Devices show it at their next read of the shelf.',
    releaseFailed: 'It wasn’t released. You can try again.',
    /**
     * The other four notices (#489, §6.1, §6.4): each action says what
     * readers, and the group, will see before it is sent. A notice names a
     * clause, never who reported anything.
     */
    holdsHeading: 'Holds',
    noHolds: 'Nothing is held.',
    heldListing: (name: string) => `The listing “${name}” and its entries`,
    heldEntry: (title: string) => `The entry “${title}”`,
    heldUnknown: 'A record this device hasn’t read',
    heldFor: (clause: string, date: string) =>
      `Held: ${clause}. It shows again on ${date} unless you act.`,
    shelfHeading: 'On the shelf',
    emptyShelf: 'Nothing is on the shelf.',
    clauseLabel: 'Under which clause',
    clauseOption: (clause: string, words: string) => `${clause}: ${words}`,
    hold: 'Hold',
    uphold: 'Uphold',
    suspend: 'Suspend',
    willSeeHoldListing: (clause: string) =>
      `Hold: readers won’t see this listing or its entries for 7 days, unless you suspend it. Its group sees “Held: ${clause}”.`,
    willSeeHoldEntry: (clause: string) =>
      `Hold: readers won’t see this entry for 7 days, unless you uphold it. Its group sees “Held: ${clause}”.`,
    willSeeUphold: (clause: string) =>
      `Uphold: readers will see “Removed: ${clause}” in its place until its 30 days end.`,
    willSeeSuspend: (clause: string) =>
      `Suspend: readers will see “Removed: ${clause}” in its place, and its door’s page says its listing was removed.`,
    pauseHeading: 'Pause',
    pausedNow: 'The shelf is paused.',
    showingNow: 'The shelf is showing.',
    pause: 'Pause the shelf',
    resume: 'Lift the pause',
    willSeePause: (line: string) => `Readers will see “${line}” in place of the whole shelf.`,
    willSeeResume: 'Readers will see the shelf again.',
    sending: 'Sending…',
    sent: 'Sent. Devices act on it at their next read of the shelf.',
    sendFailed: 'It wasn’t sent. You can try again.',
    /**
     * Reports and appeals (#490, §6.3, §6.4), newest first, each beside what
     * it names. Neither says who sent it.
     */
    inboxHeading: 'Reports and appeals',
    noInbox: 'No reports or appeals.',
    reportOf: (clause: string) => `Report: ${clause}`,
    appealOf: 'Appeal from the group',
    receivedOn: (date: string) => `Received ${date}`,
    aboutEntry: (title: string) => `About the entry “${title}”`,
    aboutListing: (name: string) => `About the listing “${name}”`,
    aboutGone: 'About something no longer on the shelf',
    /**
     * Dismissing an item, on this device only, and lifting a suspension
     * (#490, §6.1, §6.4). Nothing about a dismissal reaches the relay.
     */
    dismiss: 'Dismiss',
    dismissFailed: 'It wasn’t dismissed. You can try again.',
    /**
     * Entries the shelf classifier flagged (#493; ADR-0082), shown only while
     * it is switched on: the rule's name, never a score, in the shelf's order.
     */
    flaggedHeading: 'Flagged by the classifier',
    flaggedLede:
      'Read on this device only. A flag hides nothing, no reader sees it, and the list keeps the shelf’s order. The classifier misses most of what the covenant names, so reports come first.',
    flaggedBy: (rule: 'threat' | 'identity-hate') =>
      `Flagged by the ${rule === 'threat' ? 'threat' : 'identity hate'} rule`,
    noFlagged: 'The classifier flagged nothing.',
    flagsFailed:
      'The classifier couldn’t run on this device. Nothing was hidden or held because of it.',
    aboutSuspended: (clause: string) => `About a listing you suspended: ${clause}`,
    suspendedHeading: 'Suspended',
    noSuspended: 'Nothing is suspended.',
    suspendedOn: (date: string) => `A listing removed on ${date}`,
    removedFor: (clause: string) => `Removed: ${clause}`,
    addressOf: (start: string) => `Address ${start}…`,
    lift: 'Lift the suspension',
    lifting: 'Lifting…',
    lifted: 'Lifted. When its group posts its listing again, it waits here for your release.',
    willSeeLift: (clause: string) =>
      `Lift: readers no longer see “Removed: ${clause}”, and its door’s page no longer says its listing was removed. Its group may list again, and its listing waits for your release, as a new one does.`,
  },
  /**
   * Settings' Clear Bedfellows history (#480; ADR-0080 §5): one line on what
   * it forgets, and one quiet button. The history never leaves the device.
   */
  bedfellowsHistory: {
    lede: 'Forgets which entries Bedfellows showed you on this device, how you marked them, and where its dial stands.',
    clear: 'Clear Bedfellows history',
    clearing: 'Clearing…',
    cleared: 'Bedfellows history cleared.',
    failed: 'Bedfellows history couldn’t be cleared. Reload Reconcile, then try again.',
  },
  // Passkey unlock (#95; ADR-0008, ADR-0030): offered once after the pilot
  // notice and always in Settings. iOS allows one passkey request per tap, so
  // the first time asks twice. The no-PRF line is #95's own words.
  passkey: {
    pageTitle: 'Lock with a passkey',
    title: 'Lock your keys with a passkey',
    lede: 'Someone who picks up your unlocked phone could act as you in your groups. With a passkey, Reconcile asks for your face, fingerprint or screen lock each time it opens.',
    twice:
      'The first time, your phone asks twice: once to make the passkey, then once to check it can lock your keys.',
    privacy:
      'Your password manager keeps it as “Reconcile key”, with nothing about your groups, and nothing about it reaches the relay.',
    create: 'Make a passkey',
    creating: 'Waiting for your passkey…',
    createFailed: 'No passkey was made. You can try again.',
    confirmLede: 'Now confirm your passkey, and Reconcile locks your keys with it.',
    confirm: 'Confirm your passkey',
    confirming: 'Waiting for your passkey…',
    confirmFailed: 'Your passkey didn’t answer. Try again.',
    locked:
      'Your keys on this device are locked with your passkey. Reconcile asks for it each time it opens.',
    noPrf: 'This device’s passkey can’t protect your keys, so they stay on this device as before.',
    saveBackup: 'Save a backup',
    notNow: 'Not now',
    continue: 'Continue',
    /**
     * Before a passkey locks anything (#389): a way back if it ever stops
     * unlocking this device, a backup file of every group or recovery contacts.
     */
    gateHeading: 'First, a way back to your groups',
    gate: 'If your passkey ever stops unlocking this device, after an update or from another device, only a backup file or your recovery contacts can bring your groups back. Save a backup file now, then make your passkey.',
    gateContacts: 'Choose recovery contacts instead',
    /** The offer on a device with no group yet: nothing to back up, so it asks again later. */
    gateEmpty:
      'A passkey locks your keys only once a backup file or your recovery contacts can bring your groups back. You’re in no group yet, so Reconcile asks again once you are.',
    wayBack:
      'Your backup file is saved. If your passkey ever stops unlocking this device, it brings your groups back.',
    noRecovery:
      'Nothing was locked: no backup file holds every group, and no recovery contacts are chosen. Save a backup file or choose recovery contacts, then try again.',
    /** Settings, where Save a backup and Recovery contacts sit above. */
    settingsGate:
      'Before you can lock your keys, save a backup file of every group or choose recovery contacts, above. If your passkey ever stops unlocking this device, they bring your groups back.',
    settingsEmpty:
      'Once you’re in a group, save a backup file or choose recovery contacts, above, and you can lock your keys here.',
    /** A device locked before #389 whose groups have no way back: it stays locked, and asks. */
    lockedNoWayBack:
      'No backup file holds every group, and no recovery contacts are chosen. If your passkey ever stops unlocking this device, nothing could bring your groups back. Save a backup file or choose recovery contacts, above.',
  },
  // The unlock screen (#95): a device whose keys are locked opens here, and
  // nothing syncs or signs until the passkey unlocks it.
  unlock: {
    pageTitle: 'Unlock Reconcile',
    title: 'Unlock Reconcile',
    lede: 'Your keys on this device are locked with your passkey.',
    unlock: 'Unlock with your passkey',
    unlocking: 'Waiting for your passkey…',
    failed: 'Your passkey didn’t unlock Reconcile.',
    tryAgain: 'Try again',
    restoreHeading: 'Restore a backup',
    restoreLede:
      'Restoring puts the groups in your backup file in place of the locked ones on this device. Their keys stay on this device unlocked, and you can lock them with a passkey again in Settings.',
    eraseHeading: 'Erase this device',
  },
  /**
   * Dispatches (#112; ADR-0003, ADR-0074): news for everyone in a group.
   * Where a name or a title sits inside a sentence, the words around it are
   * kept apart, so the screen sets it in `<bdi>`.
   */
  dispatches: {
    pageTitle: 'Dispatches',
    title: 'Dispatches',
    lede: 'News for everyone in your group, newest first.',
    empty: 'No Dispatches yet.',
    /** Group home's link to every Dispatch, read with `seeAllWhat` after it. */
    seeAll: 'See all',
    seeAllWhat: 'Dispatches',
    send: 'Send a Dispatch',
    from: { before: 'From' },
    fromProposal: { before: 'From the Proposal ‘', after: '’' },
    /** Before a Document's title, on the link that opens it. */
    open: 'Open',
    /** Read between who sent a Dispatch and its date. */
    dateSeparator: '·',
  },
  /**
   * A Dispatch that may rise (#126; ADR-0037), on its ballot: the group's own
   * vote on it, a promotion motion in another group, and a score this
   * person's device carries from another group.
   */
  rising: {
    heading: 'The Dispatch',
    ballotTitle: 'Send this Dispatch',
    /** How far it can go, with the form's label for its ceiling. */
    ceiling: (label: string) => `How far it can go: ${label}`,
    groupLine: {
      0: 'If your group passes it, it goes out to everyone here.',
      1: 'If your group passes it, it goes out to everyone here. Then the coalition your group is in votes on it.',
      2: 'If your group passes it, it goes out to everyone here. Then the coalition your group is in votes on it, and then the coalition above that.',
      coalitions:
        'If your group passes it, it goes out to everyone here. Then the coalition your group is in votes on it, then any coalition above that, in turn.',
    },
    passed:
      'This passed. It went out to everyone in your group, and the coalition your group is in votes on it next.',
    /** The pass of a Dispatch put to the vote for this group only, to ask for the public shelf (#430). */
    passedHere: 'This passed. It went out to everyone in your group.',
    /** Before the seat that passed it, which follows in `<bdi>`: "Passed by Riverside Tenants". */
    passedBy: { before: 'Passed by' },
    motionLine: (coalition: string) =>
      `If ${coalition} passes it, it goes out to everyone in ${coalition}.`,
    goesOn: 'Then the coalition above votes on it.',
    carried: (score: number) =>
      `Your ${String(score)} from another group will be cast here before voting ends.`,
    change: 'Change',
    dontCast: 'Don’t cast',
    freshReason: 'You gave this a 0 elsewhere. Write a fresh reason for this group.',
  },
  /**
   * The shelf line (#430; ADR-0081; listed-doors.md §5.1): the second line on
   * a listed group's Dispatch ballot, and its result. Nothing here says it is
   * posted yet: the group's devices post it (§4.5).
   */
  shelfLine: {
    /** The line's card, the group's name inside: "Put Riverside Tenants to this on the public shelf". */
    ballotTitle: (name: string) => `Put ${name} to this on the public shelf`,
    line: 'If your group passes this line and the Dispatch, anyone with the app can read its title and text on the public shelf, under your group’s name, but never who wrote it or how anyone voted. This line can’t pass unless the Dispatch does.',
    /** What each of the two lines is called in its score and meter labels. */
    names: { dispatch: 'sending it', shelf: 'the public shelf' },
    scoreFor: (line: string) => `Score for ${line}`,
    meterLabel: (line: string) => `How ${line} stands so far`,
    published: 'Your group put its name to this on the public shelf.',
    failed: 'The public shelf line didn’t pass, so this stays in your group.',
    dispatchFailed: 'Nothing goes on the public shelf, because the Dispatch didn’t pass.',
    unlisted:
      'Your group’s front door wasn’t listed when voting closed, so nothing goes on the public shelf.',
  },
  sendDispatch: {
    pageTitle: 'Send a Dispatch',
    eyebrow: 'Dispatches',
    title: 'Send a Dispatch',
    lede: 'A Dispatch goes to everyone in your group, whatever their involvement. Phones with notifications on say only “Something new in Reconcile.”',
    titleLabel: 'Title',
    titleHint: 'A few words that say what it’s about.',
    titleMissing: 'Give your Dispatch a title.',
    textLabel: 'Text (optional)',
    textHint: 'Plain text. Links and formatting show just as you type them.',
    documentLabel: 'Point to a Document (optional)',
    noDocument: 'No Document',
    visibility: 'Everyone in your group sees this Dispatch and that you sent it.',
    submit: 'Send Dispatch',
    failed: 'Your Dispatch couldn’t be saved on this device. Try again.',
    notAllowedTitle: 'You can’t send Dispatches here',
    notAllowed:
      'Your place in this group doesn’t include sending Dispatches. Co-Creators send them.',
    leaving: 'You can’t send a Dispatch in a group you’re leaving.',
    /** How far a Dispatch can rise (#126; ADR-0037, ADR-0071), offered once the group sits in a formed coalition. */
    ceilingLabel: 'How far can it go?',
    ceilings: {
      0: 'This group only',
      1: 'One level up',
      2: 'Two levels up',
      coalitions: 'As high as your group’s coalitions reach',
    },
    ceilingHints: {
      0: 'It goes out now, to everyone in your group.',
      1: 'Your group votes on it first. If it passes, the coalition your group is in votes on it too.',
      2: 'Your group votes first, then the coalition your group is in, then the coalition above that.',
      coalitions:
        'Your group votes first, then the coalition your group is in, then any coalition above that, in turn.',
    },
    /**
     * The shelf line (#430; ADR-0081), offered only while the group's front
     * door is listed: asking for it puts the Dispatch to a vote.
     */
    shelfLabel: 'Also ask to put it on the public shelf',
    shelfHint:
      'Your group votes on it first, with a second line: putting your group’s name to it on the public shelf, where anyone with the app can read it. It stays in this group, rising to no coalition.',
    visibilityShelf:
      'Everyone in your group sees this Proposal and that you made it. If your group passes both lines, anyone with the app can read its title and text under your group’s name, but never who wrote it or how anyone voted.',
    submitVote: 'Put it to a vote',
    visibilityVote:
      'Everyone in your group sees this Proposal and that you made it. Each coalition it reaches sees only its title and text, never who wrote it or how anyone voted.',
  },
  /**
   * Opt-in push (#99; ADR-0012, ADR-0075 §2). A notification only ever shows
   * `somethingNew`: no group, name, text, id or count. The disclosure comes
   * before any switch, and says plainly what the relay and Apple or Google see.
   */
  push: {
    somethingNew: 'Something new in Reconcile',
    disclosure:
      'Notifications only ever say “Something new in Reconcile.” To send them, the relay keeps this phone’s push address for each group you turn on, for up to 30 days. That lets whoever runs the relay see that the same phone is in each of those groups. Apple or Google can see when this phone is woken. Notifications may show on your lock screen and a paired watch.',
    notify: (group: string) => `Notify me about ${group}`,
    blocked: 'Notifications are blocked for Reconcile in this device’s settings.',
    unavailable: 'This device can’t get notifications from Reconcile.',
    failed: 'That didn’t reach the relay, so nothing changed. Try again when you’re online.',
    none: 'Once you’re in a group, you can turn on its notifications here.',
  },
  backup: {
    lede: 'One file holds every group on this device, with the keys and the name you use in each, and your personal Documents. With the file and its passphrase, you can bring your groups back on a new phone, or set up a second device that votes as you.',
    passphrase: 'Passphrase',
    passphraseHint: 'At least 8 characters. Nobody can recover this passphrase for you.',
    passphraseShort: 'Use at least 8 characters.',
    confirm: 'Passphrase again',
    confirmMismatch: 'The two passphrases don’t match.',
    make: 'Make a backup file',
    making: 'Locking your backup with your passphrase…',
    makeFailed: 'The backup file couldn’t be made. Try again.',
    ready: 'Your backup file is ready. Without the passphrase, nothing in it can be read.',
    save: 'Save the file',
    saved: 'Saved. Keep the file and the passphrase in different places.',
    cancelled: 'The file wasn’t saved. Save the file to try again.',
    none: 'There are no groups on this device to back up yet.',
  },
  /** Settings' line on the relay backup (#97), shown once the device keeps one. */
  relayBackup: {
    saved: (day: string) => `Backed up to the relay ${day}.`,
    tooLarge: 'Your groups are too large for the relay backup. Save a backup file instead.',
    waiting: 'Your groups will be backed up to the relay the next time Reconcile syncs.',
    /** Once a later choice of recovery contacts on another device retired this device's backup key (#272). */
    retired:
      'You chose recovery contacts again on another of your devices, so this one stopped backing up to the relay. Link it again from that device to back it up.',
  },
  restore: {
    lede: 'Bring back the groups in a backup file you saved. On a second device, they vote as you.',
    choose: 'Choose backup file',
    chosen: 'Backup file:',
    passphrase: 'Its passphrase',
    passphraseMissing: 'Enter the passphrase this backup was saved with.',
    submit: 'Restore',
    restoring: 'Opening your backup…',
    /**
     * How many groups came back, then how many group entries (#336) and
     * personal Documents (#351) didn't check out and were left out, when any
     * were. When no group came back: what it left out of the groups, or else
     * that it holds none, then any Documents it left out.
     */
    restored: (groups: number, skipped: number, skippedDocuments: number) => {
      const left = leftOut(skipped, skippedDocuments, 'in this backup');
      const back =
        groups === 1
          ? '1 group is back on this device.'
          : `${count(groups)} groups are back on this device.`;
      const lead = groups === 0 ? (skipped === 0 ? 'This backup holds no groups.' : null) : back;
      return [...(lead === null ? [] : [lead]), ...left].join(' ');
    },
    /**
     * After a restore from a file saved before #98, which holds no encryption
     * key: once another device of the person's has given a group theirs, only
     * that one counts, so this device misses each new key (#225).
     */
    older:
      'This backup is from an older version of Reconcile. If you’ve used Reconcile on another device since you saved it, this device won’t get a group’s new key when someone leaves. Ask someone in that group for a new invite link then, or restore a newer backup saved on that device.',
    failed: 'That passphrase doesn’t open this backup, or the file is damaged.',
  },
  erase: {
    open: 'Erase Reconcile from this device',
    body: 'This erases Reconcile’s data on this device. Your groups carry on for everyone else, and a backup file you saved can bring them back here.',
    hold: 'Hold to erase',
    released: 'You let go early, so nothing was erased.',
    erasing: 'Erasing…',
    failed: 'Some of Reconcile’s data couldn’t be erased. Reload Reconcile, then try again.',
    cancel: 'Cancel',
  },
  /** Press and hold (#78): what the button's live region says while it's held. */
  hold: {
    hint: (seconds: number) =>
      `Press and hold for ${count(seconds)} seconds. On a keyboard, hold Space or Enter.`,
    holding: (left: number) =>
      left === 1 ? 'Keep holding: 1 second left.' : `Keep holding: ${count(left)} seconds left.`,
  },
  /**
   * Linking a second device (#96; ADR-0044 as cut by ADR-0074): the existing
   * device shows a code, the new one scans or pastes it, both show a number,
   * and only the existing device confirms.
   */
  link: {
    lede: 'Use your groups on a laptop or a second phone. This device shows a code, the new one scans it, and both show a number for you to check before anything is sent.',
    open: 'Link a new device',
    none: 'There are no groups on this device to link yet.',
    // The existing device.
    newPageTitle: 'Link a new device',
    newTitle: 'Link a new device',
    newLede:
      'On your new device, open Reconcile and tap Link to my other device. Then scan this code, or paste it there.',
    qrLabel: 'Linking code',
    codeText: 'The same code as text',
    copy: 'Copy the code',
    copied: 'Copied. Paste it on your new device.',
    copyFailed: 'The code couldn’t be copied. Select it and copy it instead.',
    lasts:
      'This code works for 10 minutes. Nothing is sent until you check a number on both devices.',
    waitingNew: 'Waiting for your new device…',
    number: (digits: string) => `${digits.slice(0, 3)} ${digits.slice(3)}`,
    compare: 'Does your new device show the same number?',
    match: 'Match',
    noMatch: 'Don’t match',
    sending: 'Sending your groups…',
    sent: 'Sent. Your new device is adding your groups.',
    notSent: 'Nothing was sent. Make a new code to try again.',
    expired: 'This code has expired. Nothing was sent.',
    sendFailed: 'Your groups couldn’t be sent. Make a new code to try again.',
    again: 'Make a new code',
    // A tab whose keys another tab locked with a passkey (#95) shows no code until it's unlocked.
    locked:
      'Your keys on this device are locked with your passkey. Close Reconcile, open it again and unlock it, then link a new device.',
    backToSettings: 'Settings',
    // The new device.
    thisPageTitle: 'Link to your other device',
    thisTitle: 'Link to your other device',
    thisLede:
      'On your other device, open Settings and tap Link a new device. Then scan the code it shows, or paste it here.',
    pasteLabel: 'Code from your other device',
    pasteHint: 'It starts with RL1.',
    pasteSubmit: 'Link this device',
    notACode: 'That isn’t a linking code. Copy it again from your other device.',
    connecting: 'Connecting to your other device…',
    offline: 'Can’t reach the relay right now. Check your connection and try again.',
    waitingOther: 'Waiting for your other device…',
    check: 'Check that your other device shows the same number, then confirm there.',
    cancel: 'Cancel',
    /**
     * How many groups the device now has, then how many group entries (#336)
     * and personal Documents (#351) from the bundle were left out.
     */
    linked: (groups: number, skipped: number, skippedDocuments: number) => {
      const now =
        groups === 1
          ? 'Linked. This device now has 1 group.'
          : `Linked. This device now has ${count(groups)} groups.`;
      return [now, ...leftOut(skipped, skippedDocuments, 'from your other device')].join(' ');
    },
    mismatch: 'That code didn’t match. Start again on your other device.',
    damaged: 'Your groups didn’t arrive in one piece. Start again on your other device.',
    joinExpired: 'That code has expired. Start again on your other device.',
    startAgain: 'Start again',
    unreachable: 'Can’t reach the relay right now. Still trying.',
    // The camera.
    scan: 'Scan the code',
    scanning: 'Point your camera at the code on your other device.',
    stopScan: 'Stop scanning',
    camera: 'Camera',
    noCamera: 'The camera can’t be used here. Paste the code instead.',
    notLinkCode: 'That isn’t a Reconcile linking code.',
  },
  /**
   * Recovery contacts (#109; ADR-0043 §1, ADR-0008, ADR-0075 §4): framed as
   * trust, never growth. `pick` is the picker's copy, word for word as the
   * issue gives it. Nothing here counts people or invites anyone.
   */
  recovery: {
    pageTitle: 'Recovery contacts',
    title: 'Choose recovery contacts',
    againTitle: 'Choose again',
    lede: 'If you lose every device, people you trust can help you get back into your groups. Each holds a share of a key, and no one share opens anything on its own.',
    pick: 'Pick people who know you and would answer a call from you. Pick people you’d trust with all your groups at once. If you pick the same person in two groups, they can tell both names are you.',
    again:
      'Choosing again gives everyone you pick a new share. Every share you gave before stops working, even for people you pick again.',
    howMany: 'People to pick',
    needed: 'Needed to help you back in',
    fewer: '−',
    more: '+',
    anyOf: (t: number, n: number) =>
      `Any ${String(t)} of the ${String(n)} people you pick can help you back in together.`,
    picked: (picked: number, n: number) => `${String(picked)} of ${String(n)} picked.`,
    tooMany: (picked: number, n: number) =>
      `${String(picked)} picked. Pick ${String(n)}, or change how many people to pick.`,
    nobody:
      'No one in your groups can hold a share yet. Once someone joins a group with you, you can pick them here.',
    inGroupBefore: 'People in',
    save: 'Save recovery contacts',
    saving: 'Backing up your groups and sending each share…',
    failed: 'Your recovery contacts couldn’t be saved. Try again.',
    none: 'You haven’t chosen anyone yet.',
    /** When this device holds the backup key the contacts' shares rebuild, but not the list (#272). */
    elsewhere:
      'You chose recovery contacts on another of your devices. Who they are stays on that device. Choosing again here replaces them.',
    /** Once a later choice on another device retired this plan's key (#272). */
    superseded:
      'You chose recovery contacts again on another of your devices. The people you chose here no longer hold a working share.',
    choose: 'Choose recovery contacts',
    chooseAgain: 'Choose again',
    status: (n: number, t: number) => `${String(n)} recovery contacts · ${String(t)} needed`,
    inGroupOf: 'in',
    gone: 'No longer in a shared group',
    belowThreshold: (t: number) =>
      `Fewer than ${String(t)} of your recovery contacts still share a group with you. Choose again so they can help you back in.`,
    holdingBefore: 'You’re holding a recovery share for',
    groupOpen: '(',
    groupClose: ')',
    holdingHeading: 'Shares you hold',
    dismiss: 'OK',
    help: 'Help someone recover',
    /** After a recovery (#118): the contacts who helped know the key, so the person chooses again. */
    recovered:
      'You’re back in. Choose your recovery contacts again: it makes a new key, and the shares that brought you back stop working.',
  },
  /**
   * Recovering with contacts, on the new device (#118; ADR-0043 §2): the
   * code to send, the number to read out, and the wait. `check` is the
   * issue's words.
   */
  recover: {
    pageTitle: 'Recover with your contacts',
    title: 'Recover with your contacts',
    lede: 'If you’ve lost every device, the people you chose as recovery contacts can bring your groups back to this one.',
    codeLabel: 'Your recovery code',
    codeHint: 'Send it to your recovery contacts by message or email.',
    share: 'Share the code',
    shared: 'Shared.',
    copied: 'Copied. Send it to your recovery contacts.',
    blocked: 'The code couldn’t be shared or copied. Select it and copy it instead.',
    /** What Share sends beside the code; the app's address goes with it. */
    message: 'My Reconcile recovery code:',
    check: 'Send this code to your recovery contacts, then call them and read them both numbers.',
    firstNumber: 'First number',
    secondNumber: 'Second number',
    /** Under the numbers (#398): why the second one matters, in plain words. */
    numbersNote:
      'Only this device shows the second number. A share that comes without it is left out.',
    wait: 'Once a contact approves, their device waits 72 hours, then sends their share here. If you still have a device, it can cancel. Come back to this page: your code stays the same.',
    waiting: 'Waiting for your contacts.',
    arrived: (shares: number, needed: number) =>
      `${count(shares)} of ${count(needed)} shares have arrived.`,
    /** Shares that came with another second number, left out (#398). */
    mismatched: (n: number) =>
      n === 1
        ? 'A share came with a different second number, so it was left out. Call your contacts, check the second number with them, and ask them to send their share again.'
        : `${count(n)} shares came with a different second number, so they were left out. Call your contacts, check the second number with them, and ask them to send their share again.`,
    unreachable: 'Can’t reach the relay right now. Still trying.',
    /** "Are these your groups?" (#398): nothing is restored until the person says yes. */
    foundHeading: 'Are these your groups?',
    foundLede:
      'Your contacts’ shares opened a backup with these groups. Restore it only if they’re yours.',
    foundNone: 'This backup holds no groups.',
    yes: 'Yes, restore them',
    no: 'No, they aren’t mine',
    restoring: 'Restoring…',
    restoreFailed: 'These groups couldn’t be restored. Try again.',
    declined:
      'Nothing was restored. Someone else may have your recovery code. Stop recovering, start again for a new code, and call each contact as you send it.',
    stop: 'Stop recovering',
    stopNote: 'Stopping forgets this code, so no share sent to it can be read.',
  },
  /** A recovery contact's side (#118): the code, whose share, the call and the number. */
  helpRecover: {
    pageTitle: 'Help someone recover',
    title: 'Help someone recover',
    lede: 'Someone who chose you as a recovery contact has lost their devices. Their new device shows a code for them to send you.',
    none: 'You don’t hold anyone’s recovery share on this device.',
    codeLabel: 'Their recovery code',
    codeHint: 'It starts with RR1.',
    notACode: 'That isn’t a recovery code. Ask them to send it again.',
    next: 'Continue',
    who: 'Which person?',
    /** One option: "<name> (<group>)". */
    person: (name: string, group: string) => `${name} (${group})`,
    /** "Call <name> or meet them. Make sure it's really them." around the name. */
    callBefore: 'Call',
    callAfter: 'or meet them. Make sure it’s really them.',
    numberLabel: 'The first number they read out',
    numberHint: 'Six digits, from their new device.',
    wrongNumber:
      'That number doesn’t match this code. Check it’s the code they sent, and ask them to read the number again.',
    /** The second number (#398), which their share goes with. */
    secondLabel: 'The second number they read out',
    secondHint: 'Six more digits, under the first.',
    badSecond: 'The second number is six digits. Ask them to read it again.',
    approve: 'Approve',
    approving: 'Approving…',
    failed: 'This couldn’t be approved. Try again.',
    back: 'Back',
    heldHeading: 'Recoveries you’re helping with',
    /** "Holding <name>'s share until <date>. Open Reconcile after then to send it." */
    holdingBefore: 'Holding',
    holdingUntil: (date: string) => `’s share until ${date}. Open Reconcile after then to send it.`,
    holdingSoon: '’s share. The 72 hours start once the relay has your approval.',
    readyAfter: '’s share goes to their new device the next time Reconcile syncs.',
    sentAfter: '’s share went to their new device.',
    /** "<name>'s share went to their new device with the second number 966 043." (#398) */
    sentWith: (number: string) =>
      `’s share went to their new device with the second number ${number}.`,
    /** Sending a share again with a corrected second number (#398). */
    resendOpen: 'Send it again with another number',
    resendHint:
      'If they read a different second number, type it here. Their device leaves out a share with the wrong one.',
    resend: 'Send again',
    resending: 'Sending…',
    resent: 'Sent again.',
    resendFailed: 'This couldn’t be sent again. Try again.',
    resendCancel: 'Cancel',
    stoppedAfter: '’s share stays with you: this recovery was cancelled.',
    another: 'Help someone else',
    settings: 'Settings',
  },
  /** The person's devices (#118): the alert on Start and every group home, and Cancel. The issue's words. */
  recoveryAlert: {
    body: (date: string) =>
      `Someone asked your recovery contacts to restore your Reconcile on a new device. If this wasn’t you, cancel now. It completes ${date}.`,
    cancel: 'Cancel this recovery',
    cancelling: 'Cancelling…',
    failed: 'The recovery couldn’t be cancelled. Try again.',
    cancelled: 'You cancelled this recovery. Your contacts keep their shares.',
  },
  /** Group home's quiet suggestion, once per group, until a backup holds it (#78). */
  backupCard: {
    body: 'Save a backup so you can get this group back if you lose your phone.',
    save: 'Save a backup',
    notNow: 'Not now',
  },
  /**
   * Share beside Copy on a reconcile card's link and a follow link (#424;
   * ADR-0077 §6): the device's share sheet gets the link alone.
   */
  linkShare: {
    button: 'Share',
    shared: 'Shared.',
    /** By the button: a chat app's operator can read what goes through it, for as long as the link works. */
    chatNote:
      'If you send it through a chat app, whoever runs that app can read the link too, and open it in those 2 days.',
  },
  /** Reconcile with another group (#114): making a card, and the card a formed coalition's row makes. */
  card: {
    pageTitle: 'Reconcile with another group',
    title: 'Reconcile with another group',
    lede: 'Propose a coalition with another group. Your group votes on it here, then theirs votes on it there. It forms only if both pass.',
    nameLabel: 'The coalition’s name',
    nameHint: 'A name of its own, apart from either group’s.',
    nameMissing: 'Add a name for the coalition.',
    nameTooLong: (max: number) => `Keep the name to ${count(max)} characters or fewer.`,
    statementLabel: 'Its first statement',
    statementHint:
      'What both groups would stand for together. Leave a blank line between sections.',
    statementMissing: 'Add the statement both groups will vote on.',
    whyLabel: 'Why',
    whyHint: 'Tell your group why you’d reconcile.',
    whyMissing: 'Tell your group why.',
    whyTooLong: (max: number) => `Keep this to ${count(max)} characters or fewer.`,
    yourNameLabel: 'Your name in the coalition',
    yourNameHint: 'This name is only shown in this coalition.',
    yourNameMissing: 'Add the name the coalition will see.',
    submit: 'Make the card',
    making: 'Making the card…',
    tooLarge: 'This statement is too long to send. Shorten it, then try again.',
    failed:
      'Can’t reach the relay right now, so there’s no card yet. Your group’s Proposal is saved. Try again.',
    retry: 'Try again',
    madeTitle: 'Your card is ready',
    linkLabel: 'Card link',
    warning:
      'Anyone who opens this link in the next 2 days can read the coalition from then on. Send it only to someone in the group you want to reconcile with.',
    copy: 'Copy',
    copied: 'Copied.',
    copyFailed: 'Couldn’t copy it. Select the link and copy it yourself.',
    proposalLink: 'Open your group’s Proposal',
    /** The coalition statement's title: every card's Document is its mission statement. */
    documentTitle: 'Mission statement',
    proposalTitle: (name: string) => `Reconcile into ${name}`,
    admitTitle: (group: string) => `Admit ${group}`,
    another: 'Make a card for another group',
    failedAnother: 'Can’t reach the relay right now, so there’s no card yet. Try again.',
    anotherLede: 'Bring in another group: they vote, then every group in the coalition does.',
    /** Reconcile with another coalition (#122): the same card, from a coalition's row. */
    coalitionTitle: 'Reconcile with another coalition',
    coalitionLede:
      'Propose a coalition of coalitions. Every group in your coalition votes on it, then the other side votes. It forms only if both pass.',
    coalitionWhyHint: 'Tell every group in your coalition why you’d reconcile.',
    coalitionNameHint: 'A name of its own, apart from either side’s.',
    coalitionStatementHint:
      'What both sides would stand for together. Leave a blank line between sections.',
    coalitionWarning:
      'Anyone who opens this link in the next 2 days can read the new coalition from then on. Send it only to someone in the group or coalition you want to reconcile with.',
    coalitionLink: 'Open your coalition',
    coalitionCant:
      'Only someone who takes part in this coalition and can propose there makes its card, and a coalition already three levels up can’t join another.',
    coalitionKeyWaits:
      'This coalition’s key hasn’t reached this device yet. You can make its card once it arrives.',
    /** Propose reconciling, from another group's front door (#426). */
    doorTitle: 'Propose reconciling',
    /** Around the door's group, which renders in its own `<bdi>`. */
    doorLede: {
      before: 'This sends a card to',
      after:
        '. Your group votes on it here, and their members can bring it to a vote for the next 24 to 48 hours. The coalition forms only if both groups pass.',
    },
    doorGroupLabel: 'Your group',
    doorGroupHint: 'It votes on this card too. Only groups where you can propose are listed.',
    doorSubmit: 'Send the card',
    /** Around the door's group: "Your card is at Oak St Co-op’s front door. …" */
    doorSent: {
      before: 'Your card is at',
      after: '’s front door. Their members can bring it to a vote for the next 24 to 48 hours.',
    },
    doorBack: 'Back to the front door',
  },
  /** Opening a card and bringing it to one of your groups (#114). */
  bring: {
    pageTitle: 'Bring a card',
    loading: 'Opening the card…',
    eyebrow: 'A reconcile card',
    /** Around the maker's group, which renders in its own `<bdi>`: "From Riverside Tenants". */
    from: 'From',
    statementLabel: 'Their proposed statement',
    admitLede:
      'This coalition has already formed. Your group votes first, then every group in it votes on letting yours in.',
    question: 'Bring this to one of your groups?',
    /** When a coalition this person takes part in may take it too (#122). */
    questionBoth: 'Bring this to one of your groups or coalitions?',
    groupLabel: 'Your group',
    groupHint: 'It votes on this card. Only groups where you can propose are listed.',
    /** When a coalition this person takes part in can take the card too (#122). */
    groupOrCoalitionLabel: 'Your group or coalition',
    groupOrCoalitionHint:
      'It votes on this card. A coalition votes group by group. Only those where you can propose are listed.',
    /** Under a coalition's name in the picker (#122). */
    coalitionOption: 'Coalition',
    noGroups:
      'None of your groups on this device can take this card. You need to be able to propose there, and it can’t hold this card already.',
    yourNameLabel: 'Your name in the coalition',
    yourNameHint: 'This name is only shown in this coalition.',
    yourNameMissing: 'Add the name the coalition will see.',
    submit: 'Bring to my group',
    submitCoalition: 'Bring to my coalition',
    notNow: 'Not now',
    failed: 'Bringing the card didn’t finish. Try again.',
    badLinkTitle: 'This card doesn’t work',
    badLink: 'This card has expired or is damaged. Ask the group that sent it for a new one.',
    /**
     * A coalition this person takes part in that can't take the card (#549):
     * the card's coalition sits in a coalition above, and `asking` would raise
     * its level. The lead names the note; then why, and the route.
     */
    refusedLead: (asking: string): Words => [named(asking), ' can’t take this card.'],
    refusedWhy,
    refusedRoute,
    usedTitle: 'Can’t bring this card',
    used: 'This card has already been used.',
    offlineTitle: 'Can’t open the card yet',
    offline: 'Can’t reach the relay right now. Check your connection, then try again.',
    retry: 'Try again',
  },
  /**
   * Following a coalition from its link (#124; ADR-0053, ADR-0075 §5). Every
   * word of the preview came from a participant's device, so the screen sets
   * each name in `<bdi>`, as plain text.
   */
  follow: {
    pageTitle: 'Follow a coalition',
    loading: 'Opening the link…',
    eyebrow: 'Follow a coalition',
    groupsLabel: 'Its member groups',
    statementLabel: 'From its statement',
    question: 'Follow this coalition?',
    /** Where M2-03's name hint sits on Join: what following shows of you, which is nothing. */
    hint: 'You’ll read its Documents, what it decides and its Dispatches on this device. Following adds nothing to the coalition: no name of yours, and no one sees that you follow. You won’t see inside any member group.',
    submit: 'Follow',
    notNow: 'Not now',
    notNowHint: 'You can open the link again while it lasts.',
    failed: 'Following didn’t finish. Try again.',
    badLinkTitle: 'This follow link doesn’t work',
    badLink:
      'This follow link has expired or is damaged. Ask someone in the coalition for a new one.',
    offlineTitle: 'Can’t open the link yet',
    offline: 'Can’t reach the relay right now. Check your connection, then try again.',
    retry: 'Try again',
    heldTitle: 'This coalition is already on this device',
    held: 'Anything this device was missing from its history is here now.',
    open: 'Open the coalition',
  },
  /** Group home's Coalitions, and what a reconcile Proposal says of its coalition (#114). */
  coalitions: {
    heading: 'Coalitions',
    start: 'Reconcile with another group',
    forming: 'Forming',
    formed: 'Formed',
    declined: 'Didn’t form',
    /** Around a group's name, in its own `<bdi>`: "Waiting for Oak St Co-op’s vote". */
    waitingBefore: 'Waiting for',
    waitingAfter: '’s vote',
    /** Around a group's name: "Oak St Co-op didn’t pass this". */
    didntPassAfter: 'didn’t pass this',
    /** After a group's own waiting line, while its open vote has a ballot and isn't passing (#250). */
    notPassing: 'Currently not passing',
    waitingCard: 'Waiting for another group to bring the card.',
    /**
     * Under a coalition this coalition asked into, which refused it (#549):
     * it sits in a coalition above, and admitting this one would raise its level.
     */
    refusedWhy,
    refusedRoute,
    /** A coalition still forming at `formsFinal`, declined by the close-out (#250). */
    lapsed: 'Not every group voted in time, so the coalition won’t form.',
    /**
     * In place of the ballot on a group's open reconcile vote once another
     * founding group's fail has declined its coalition (#250), after that
     * group's name in its own `<bdi>`.
     */
    withdrawnAfter: 'didn’t pass this, so the coalition won’t form.',
    /**
     * Above the ballot on an open reconcile or coalition vote, from 3 days
     * before it closes, for someone who hasn't scored it (#250): around the
     * deadline in a `<time>` element.
     */
    reminderBefore: 'If you don’t vote by',
    reminderAfter: ', you won’t be counted.',
    youTakePart: 'You take part as',
    takePart: 'Take part',
    takePartHint: 'Join the coalition under your group’s seat.',
    nameLabel: 'Your name in the coalition',
    nameHint: 'This name is only shown in this coalition.',
    nameMissing: 'Add the name the coalition will see.',
    joining: 'Joining…',
    takePartFailed: 'That didn’t save. Try again.',
    mismatch: 'The result reported for your group doesn’t match your group’s vote.',
    /** On a reconcile Proposal: "Reconcile with Oak St Co-op", the other group in its own `<bdi>`. */
    with: 'Reconcile with',
    statement: 'The coalition’s statement',
    /** Under a reconcile ballot's one version. */
    reconcileLine: 'If your group and the other group both pass this, the coalition forms.',
    /**
     * In place of the ballot on a coalition's motion to take a seat above
     * whose sealed seat secret doesn't make the seat key it states (#375).
     */
    misstatedSeat:
      'This can’t be voted on. The seat it asks for doesn’t match the secret it carries, so no one could ever act for it.',
    /** In place of the ballot on such a motion while this device checks its seat (#375). */
    checkingSeat: 'Checking the seat this asks for…',
    /** A reconcile Proposal's pass, and a coalition motion's in the group. */
    reconcilePassed:
      'This passed. Your group’s pass goes to the coalition, which forms once every group has passed.',
    motionPassed:
      'This passed in your group. Your group’s pass goes to the coalition, which decides with every group’s.',
    /** Under a coalition motion's one version. */
    motionLine:
      'Every group in the coalition votes on this. Only your group’s pass or fail goes back.',
    from: 'From the coalition',
    /** A coalition motion's own lapse in a group (#120): it goes to the coalition as a fail. */
    motionLapsed:
      'Not enough people in your group weighed in, so the coalition counts your group as not passing it.',
    /** Opens the coalition's home from group home's row (#120). */
    open: 'Open the coalition',
    /** From a coalition's row (#122): the card flow one level up. */
    reconcileCoalition: 'Reconcile with another coalition',
    /** Between the names of a chain, as in "Riverside Tenants · in Eastside Housing" (#122). */
    chainIn: 'in',
    /** Above the coalitions a coalition is in or asks into (#122). */
    above: 'Coalitions it’s in',
    /** A coalition still waiting for its own groups' vote on joining one above (#122). */
    waitingOwn: 'Waiting for its groups’ vote.',
    /** Over a coalition motion in a group's lists and on its page, before the coalition's name (#120). */
    voteTag: 'Coalition vote',
    tagSeparator: '·',
    /** After the tag's coalition, around the coalitions a motion came through (#122). */
    through: '(through',
    throughEnd: ')',
    then: 'then',
    /** Before a coalition's name on a nested motion's progress lines (#122). */
    progressIn: 'In',
    /** Under a nested motion's progress (#122): what crosses each line. */
    nestedLine:
      'Your group’s pass or fail goes to the coalition it’s in. Only that coalition’s pass or fail goes on up.',
    /** On an admit ballot for a coalition (#122), before its member groups. */
    admitsCoalition: 'A coalition of',
    admitsTitle: 'Asking to join',
    admitsLevel: (level: number) => `Level ${count(level)}`,
    /** The coalition's home (#120). */
    missingTitle: 'This coalition isn’t on this device',
    missing: 'Go back to your groups, and open it from a group that’s in it.',
    homeEyebrow: 'Coalition',
    homePageTitle: 'Coalition',
    groups: 'Member groups',
    /** Beside a member group this person is in. */
    yourGroup: 'Your group',
    /** Beside a member that is a coalition (#122), and one this person takes part in. */
    coalitionSeat: 'Coalition',
    yourCoalition: 'Your coalition',
    documents: 'Documents',
    openMotions: 'Open Proposals',
    noOpen: 'Nothing is open in the coalition right now.',
    /** A motion this device proposed, before the relay has it. */
    pending: 'Saved on this device. Every group sees it once the relay has it.',
    /** The progress of a coalition motion (#120): only whether each group passed, never a count of people. */
    progressTitle: 'Across the coalition',
    passedOf: (passed: number, seats: number) =>
      `${count(passed)} of ${count(seats)} groups ${passed === 1 ? 'has' : 'have'} passed.`,
    /** Before the groups still deciding, each in its own `<bdi>`, as in "Waiting for Oak St Co-op." */
    waitingFor: 'Waiting for',
    /** Between the last two names in a list. */
    and: 'and',
    listSeparator: ',',
    end: '.',
    twoThirds: (needed: number, seats: number, passed: number, failed: number) =>
      `Needs ${count(needed)} of ${count(seats)} · ${count(passed)} passed${
        failed === 0 ? '' : `, ${count(failed)} didn’t`
      }`,
    mine: { pass: 'Your group passed this.', fail: 'Your group didn’t pass this.' },
    waitingMore: (groups: number) =>
      groups === 1 ? 'Waiting for 1 more group.' : `Waiting for ${count(groups)} more groups.`,
    passed: 'The coalition passed this.',
    /** "The coalition passed this. It takes effect on <day>.", the day in a `<time>` element (#250). */
    takesEffect: 'The coalition passed this. It takes effect on',
    nowReads: 'The coalition passed this. It now reads:',
    failedEvery: 'Not every group passed.',
    failedTwoThirds: 'Fewer than two-thirds of the groups passed.',
    resultTitle: 'The coalition’s result',
    eachGroup: 'Each group',
    standing: { pass: 'Passed', fail: 'Didn’t pass', deciding: 'Still deciding' },
    /** The coalition's Document and its composer (#120). */
    documentEyebrow: 'Coalition Document',
    takePartFirst: 'To propose a change to the coalition’s Document, take part in it first.',
    cantPropose:
      'Changes here are proposed by people who can propose in a member group and take part in the coalition.',
    sectionOpen: 'A change to this section is open for a vote.',
    composerLede:
      'Every group in the coalition votes on this inside the group. Only each group’s pass or fail comes back.',
    composerWhyHint: 'Tell every group in the coalition what this fixes or makes better.',
    composerTextHint: 'If the coalition passes it, this replaces the section.',
    composerLinkHint: 'Where the groups can talk it over.',
    composerVisibility:
      'Your draft stays on this device until you propose it. Then every group in the coalition sees this Proposal, under the name you take part as.',
    /**
     * Under "Send a Dispatch if this passes" on a coalition's composer (#124):
     * its pass is final a day after voting ends for each level it has (#387).
     */
    composerDispatchHint: (days: number) =>
      `If the coalition passes this, the Dispatch goes out once the pass is final, ${
        days === 1 ? 'a day' : `${count(days)} days`
      } after voting ends. Everyone who reads the coalition gets it: its followers, and people in its groups who open it.`,
    /** The coalition home of someone who only follows it (#124). */
    followingEyebrow: 'Following',
    /** Between member groups' names under a followed coalition's name: "Riverside Tenants · Oak St Co-op". */
    groupsSeparator: '·',
    /** A follow link (#124; ADR-0053): the button copies one, with Share beside it (#424, #456). */
    followers: 'Followers',
    copyFollowLink: 'Copy a follow link',
    shareWarning:
      'Anyone who opens this link in the next 2 days can read this coalition from then on, including the names its participants chose and which group each comes from. They won’t see inside any member group.',
    shareField: 'Follow link',
    sharing: 'Making your follow link…',
    shareFailed:
      'The follow link couldn’t be made, so nothing was copied. Making one needs the relay. Check your connection, then try again.',
    shareCopied: 'Copied. Send it to the people you want to follow this coalition.',
    /** Unfollow (#124): it works like Leave, and posts nothing. */
    unfollow: 'Unfollow',
    unfollowTitle: 'Unfollow this coalition?',
    unfollowBody:
      'Unfollowing removes this coalition and everything this device read of it. Nothing is sent, so no one learns you followed it or stopped. To follow it again, you’ll need a new follow link.',
    unfollowCancel: 'Cancel',
    unfollowFailed: 'Unfollowing couldn’t be saved on this device. Try again.',
  },
  /** A coalition's room (#125): one small encrypted room where its member groups' people talk. */
  room: {
    /** The room's entry on the coalition's home. */
    homeTitle: 'Room',
    open: 'Open the room',
    homeLine: 'Where people from every member group talk. Only the member groups can read it.',
    eyebrow: 'Room',
    pageTitle: 'Room',
    /** Under the room's heading: who can read it, and the 30-day rule. */
    note: 'Only people in the coalition’s member groups can read this room. The relay can’t, and neither can anyone who only follows the coalition. Each device deletes a message 30 days after the relay received it.',
    listLabel: 'Messages',
    empty: 'No messages yet.',
    /** The polite announcement of messages that arrive while the person is at the bottom. */
    newFrom: (name: string, text: string) => `New message from ${name}: ${text}`,
    newMessages: (n: number) => `${count(n)} new messages`,
    messageLabel: 'Message',
    messageHint:
      'Plain text. Everyone in the coalition’s member groups sees it under your coalition name.',
    send: 'Send',
    emptyMessage: 'Write a message first.',
    longMessage: 'A message can be up to 2,000 characters.',
    failed: 'That didn’t save. Try again.',
    takePartFirst: 'To write here, take part in the coalition first.',
    joining: 'You can write here once you’ve joined the coalition. That happens at the next sync.',
    reads:
      'People who take part in the coalition write here. To take part, you need to be able to propose in your group.',
    missingTitle: 'There’s no room for you here',
    missing:
      'Only people in the coalition’s member groups can read its room. Go back to the coalition’s home.',
  },
  // The landing page (ADR-0078): what a new visitor reads before first run.
  // It explains each feature through a case study, at about a 7th-grade
  // reading level, and writes Group with a capital as the founder's intro does.
  landing: {
    /** Over the landing page when it's opened again from inside the app (`#/about`): the way home. */
    back: 'Back to your groups',
    nav: {
      label: 'On this page',
      dispatch: 'Dispatch',
      reconcile: 'Reconcile',
      documents: 'Documents',
      privacy: 'Privacy',
    },
    title: 'Reconcile',
    partOfSpeech: 'verb.',
    definition: 'To find common ground, then act on it together.',
    lede: 'Reconcile is a home for all sorts of Groups.',
    points: [
      'Agree by vote on Documents like your mission, values, house rules or action roadmaps.',
      'Write posts, called Dispatches, for the people who follow your Groups.',
      'Team up with other Groups to form Coalitions when you find common ground and a shared mission.',
      'And above all, read and write the Dispatches that spread to higher-level Coalitions when the Groups composing them vote to promote them.',
    ],
    start: 'Start a Group',
    seeIt: 'See it in real life',
    caseStudy: 'A case study',
    dispatch: {
      name: 'Dispatch',
      title: 'How far should news of one talk travel?',
      stepsLabel: 'Where the Dispatch went',
      intro:
        'A dharma teacher is giving a talk in Berkeley. He posts about it in his San Jose sangha’s WhatsApp group. Here is where it goes next.',
      steps: [
        {
          where: 'San Jose sangha',
          title: 'The Group votes',
          body: 'They like it. They vote to share it with everyone who follows their page.',
          verdict: 'Yes. Shared, and passed up.',
          passed: true,
        },
        {
          where: 'Bay Area Coalition',
          title: 'The Coalition votes',
          body: 'San Jose belongs to it, with Palo Alto and San Francisco. They want it too.',
          verdict: 'Yes. Shared, and passed up.',
          passed: true,
        },
        {
          where: 'California Coalition',
          title: 'The bigger Coalition votes',
          body: 'Sanghas across the state. For Los Angeles, Berkeley is too far to drive.',
          verdict: 'No. It stops here.',
          passed: false,
        },
      ],
      takeaway: 'The news reached everyone close enough to come. No one else was bothered with it.',
    },
    reconcile: {
      name: 'Reconcile',
      title: 'They disagree on vaccines. They agree on microplastics.',
      groups: [
        { name: 'Climate activists', about: 'A local chapter that meets on Facebook.' },
        { name: 'Holistic medicine group', about: 'A movement that talks on Reddit.' },
      ],
      tally: [
        { shared: false, lead: 'Vaccines.', rest: 'Most of one Group disagrees with the other.' },
        { shared: true, lead: 'Microplastics.', rest: 'Both Groups are worried.' },
        {
          shared: true,
          lead: 'A petition.',
          rest: 'It would put a proposition on the next ballot. Both would sign.',
        },
      ],
      thenTitle: 'So they Reconcile',
      then: [
        'Each Group votes to join up.',
        'They gather the values they share into one mission.',
        'That forms a Coalition.',
        'An action plan goes out as a Dispatch: sign the petition. Everyone in the Coalition gets it.',
      ],
      after: 'Neither Group has to change its mind about anything else.',
      note: 'Think of it as an operating system for anarcho-syndicalism: small Groups that run themselves, and decide things together by vote.',
    },
    documents: {
      name: 'Documents',
      kind: 'Two case studies',
      title: 'Anything your Group needs to agree on.',
      kindsLabel: 'Kinds of Document',
      kinds: ['Missions', 'Values', 'Lists of demands', 'Action roadmaps', 'House rules'],
      cases: [
        {
          title: 'At home',
          body: 'Your household Discord can’t agree on lights out. Your teenager Proposes a change to the house rules. Everyone talks it over and votes, right in the app.',
        },
        {
          title: 'In a movement',
          body: 'Your movement is too big and too mixed to write one list of demands. So members vote, and the list becomes whatever most of them agree on.',
        },
      ],
      voteTitle: 'How a vote works',
      scaleLabel: 'The ballot scale',
      rules: [
        {
          shared: true,
          lead: 'Enthusiasm counts.',
          rest: 'You score from 0 to 4, not just yes or no.',
        },
        { shared: true, lead: 'It passes', rest: 'with an average of 2 or more.' },
        {
          shared: false,
          lead: 'It’s blocked',
          rest: 'if 1 in 10 voters or more give it a 0. That many people can’t live with it.',
        },
      ],
      levels: [
        'Follows the Group and gets its Dispatches.',
        'Votes on changes.',
        'Votes, writes, and Proposes changes.',
      ],
      levelsNote: 'After you join a Group, you pick your own level.',
    },
    privacy: {
      name: 'Privacy',
      kind: 'Why it’s built this way',
      title: 'A map of who believes what is worth a lot.',
      pair: [
        {
          title: 'The risk',
          body: 'Governments, data brokers and advertisers would all want a tool that maps activists and their politics.',
        },
        { title: 'Our answer', body: 'Reconcile keeps that data where even we can’t get at it.' },
      ],
      points: [
        {
          title: 'Every vote and Dispatch is a sealed letter',
          body: 'We pass it along. We can’t open it.',
        },
        {
          title: 'No one outside sees who belongs to which Group',
          body: 'Not us, and not anyone who asks us.',
        },
        {
          title: 'Not only for activists',
          body: 'Families, fan clubs and sanghas get the same protection.',
        },
      ],
    },
    network: {
      name: 'The network',
      title: 'A feed that follows your roots.',
      intro:
        'Trees that look separate are linked underground. Thin threads between their roots carry water and warnings from tree to tree. Dispatches travel the same way: through the Groups you joined and the Coalitions they formed.',
      points: [
        {
          title: 'Votes decide what spreads',
          body: 'A Dispatch spreads because Groups voted to share it. No one can pay to spread it.',
        },
        {
          title: 'Nothing built to hook you',
          body: 'No ads. No like counts. No leaderboards. Reconcile runs on gifts.',
        },
        {
          title: 'No public map',
          body: 'Groups team up by private invitation. No one can look up who has joined with whom.',
        },
      ],
    },
    begin: {
      title: 'Start with your own Group.',
      body: 'Reconcile is in a small pilot. It’s free. It runs in your browser, and you can add it to your phone’s home screen.',
    },
    footer: 'No ads, no trackers, and nothing loaded from other sites.',
  },
} as const;
