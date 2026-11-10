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
  },
  start: {
    pageTitle: 'Your groups',
    title: 'Your groups',
    empty: 'You aren’t in any groups on this device yet.',
    create: 'Create group',
    inviteHeading: 'Have an invite link?',
    inviteLabel: 'Invite link',
    inviteHint: 'Paste the link someone in your group sent you.',
    openInvite: 'Join with an invite link',
    documentTitle: (title: string) => `Document: ${title}`,
    settingUp: 'Saved on this device. Waiting for the relay.',
    mayClear: 'This browser may clear Reconcile’s data if the device runs low on space.',
  },
  install: {
    pageTitle: 'Add to Home Screen',
    title: 'Add Reconcile to your Home Screen',
    otherApp: 'If you opened this inside another app, open it in Safari first.',
    steps: ['Tap Share, or tap ••• and then Share.', 'Choose Add to Home Screen, then tap Add.'],
    open: 'Open Reconcile from your Home Screen.',
    openToJoin: 'Open Reconcile from your Home Screen and tap Join with an invite link.',
    why: 'Safari can clear a website’s data after a week without a visit, so on iPhone and iPad Reconcile runs from your Home Screen.',
    inviteHeading: 'Your invite',
    inviteLabel: 'Your invite link',
    inviteHint: 'Copy it now, then paste it into Reconcile once it’s on your Home Screen.',
    copyInvite: 'Copy invite link',
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
    lede: 'You write the first draft of your group’s Document. After that, it changes only when a Proposal passes your group’s vote.',
    groupName: 'Group name',
    groupNameMissing: 'Give your group a name.',
    yourName: 'Your name',
    yourNameHint: 'This name is only shown in this group. It doesn’t have to be your real name.',
    yourNameMissing: 'Add the name your group will see.',
    chat: 'Chat link (optional)',
    chatHint: 'Where your group already talks, such as a Discord, Signal or WhatsApp group.',
    chatInvalid: 'Use a web link that starts with https:// or http://.',
    documentTitle: 'Document title',
    documentTitleHint: 'For example, House rules or Our mission.',
    documentTitleMissing: 'Give the Document a title.',
    documentText: 'Document text',
    documentTextHint:
      'Leave a blank line between sections. Your group proposes changes one section at a time.',
    documentTextMissing: 'Write at least one section.',
    section: (section: number) => `Section ${String(section)}`,
    tooLarge: 'This Document is too long to send. Shorten it, then try again.',
    visibility:
      'Everyone you invite sees the group name, your name, the chat link and this Document.',
    submit: 'Create group',
    failed: 'Your group couldn’t be saved on this device. Try again.',
  },
  join: {
    pageTitle: 'Join a group',
    loading: 'Opening the invite…',
    eyebrow: 'You’re invited',
    documentLabel: 'Their Document',
    nameLabel: 'Your name',
    nameHint: 'This name is only shown in this group. It doesn’t have to be your real name.',
    nameMissing: 'Add the name your group will see.',
    visibility: 'People in this group will see the name you choose and how you vote.',
    submit: 'Join group',
    badLinkTitle: 'This invite link doesn’t work',
    badLink: 'This invite link has expired or is damaged. Ask someone in your group for a new one.',
    offlineTitle: 'Can’t open the invite yet',
    offline: 'Can’t reach the relay right now. Check your connection, then try again.',
    retry: 'Try again',
    failed: 'Joining didn’t finish. Try again.',
    memberTitle: 'You’re already in this group',
    alreadyJoined: 'This invite is for a group you joined on this device before.',
    openGroup: 'Open your group',
  },
  home: {
    pageTitle: 'Your group',
    eyebrow: 'Your group',
    documentLabel: 'Document',
    openProposals: 'Open Proposals',
    noProposals: 'Nothing to vote on yet.',
    people: 'People',
    /** Read between a name and its level, as in "Ana, Co-Creator"; the screen shows a gap. */
    levelSeparator: ',',
    invite: 'Invite people',
    copyInvite: 'Copy invite link',
    inviteField: 'Invite link',
    copied: 'Copied. Send it to the people you’re inviting.',
    copyFailed: 'Copying is blocked here. Select the link above and copy it yourself.',
    joinDiscussion: 'Join discussion',
    discussion: 'Discussion',
    unreachable: 'Can’t reach the relay right now.',
    unreachableSince: (time: string) => `Can’t reach the relay right now. Last synced ${time}.`,
    missingTitle: 'This group isn’t on this device',
    missing: 'Open an invite link to join it, or go back to your groups.',
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
  },
  proposal: {
    pageTitle: 'Proposal',
    eyebrowOpen: 'Open Proposal',
    eyebrowClosed: 'Closed Proposal',
    eyebrowNew: 'New Proposal',
    proposedBy: 'Proposed by',
    changes: (section: number) => `Changes to section ${String(section)}`,
    readsAs: 'How it will read',
    proposed: 'Proposed text',
    onBallot: 'On the ballot',
    addVersion: 'Add your version',
    ballotFull: 'This ballot already has three versions.',
    yourVersion: 'Your version',
    joinedAfter: 'You joined after this opened, so you can’t vote on it.',
    notVotingLevel: 'You weren’t at a voting level when this opened, so you can’t vote on it.',
    missingTitle: 'This Proposal isn’t on this device',
    missing: 'Go back to your group to see its open Proposals.',
  },
  ballot: {
    version: (version: number) => `Version ${String(version)}`,
    scoreFor: (version: number) => `Score for version ${String(version)}`,
    visibility: 'Everyone in your group sees your scores and note.',
    newVersion: 'A new version was added. Score it to update your ballot.',
    separator: '·',
    scores: ['Strongly opposed', 'Opposed', 'Neutral', 'Supportive', 'Strongly supportive'],
    scoreMissing: 'Choose a score from 0 to 4.',
    noteLabel: 'Note (optional)',
    reasonLabel: 'Your reason for a 0',
    betterLabel: 'What would make this a 3 for you?',
    noteMissing: 'Add your reason for the 0.',
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
    average: 'Average',
    zeros: 'Zeros',
    /** The line the average must reach, from the bar, such as "needs 2.5". */
    averageLine: (line: string) => `needs ${line}`,
    /** The share of zeros it must stay under, from the bar, such as "under 8%". */
    zeroLine: (line: string) => `under ${line}`,
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
  },
  decided: {
    title: 'Decided',
    empty: 'Nothing decided yet.',
    /** Each outcome as the Decided list names it. */
    outcomes: { pass: 'Passed', fail: 'Didn’t pass', lapse: 'Lapsed' },
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
  document: {
    pageTitle: 'Document',
    eyebrow: 'Document',
    propose: 'Propose a change',
    proposeLabel: (section: number) => `Propose a change to section ${String(section)}`,
    addVersion: 'Add your version',
    addVersionLabel: (section: number) => `Add your version to section ${String(section)}`,
    ballotFull: 'This section’s ballot already has three versions.',
    empty: 'This Document has no sections yet.',
  },
} as const;
