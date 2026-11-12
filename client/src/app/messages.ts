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
  start: {
    pageTitle: 'Your groups',
    title: 'Your groups',
    empty: 'You aren’t in any groups on this device yet.',
    create: 'Create group',
    inviteHeading: 'Have an invite link?',
    inviteLabel: 'Invite link',
    inviteHint:
      'Paste the link someone in your group sent you, a reconcile card from another group, or a coalition’s follow link.',
    openInvite: 'Join with an invite link',
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
    /** The coalitions this device follows (#124), each with its member groups. */
    followingHeading: 'Following',
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
    documentLabel: 'Document',
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
    /** The checkbox that adds a Dispatch to a Proposal (#112). */
    dispatchLabel: 'Send a Dispatch if this passes',
    dispatchHint:
      'If your group passes this, everyone in it gets the Dispatch. Voters see it on the ballot first.',
    /** Where a carried Dispatch's title starts: the Document's own title, set in the field. */
    dispatchTitle: (document: string) => `Updated: ${document}`,
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
    removes: 'Removes this section',
    addsAfter: (words: string) => `Adds a section after ‘${words}’`,
    addsAtStart: 'Adds a section at the start',
    addsAtEnd: 'Adds a section at the end',
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
    hint: 'Shares this message and Reconcile’s address:',
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
    copy: 'Copy as Markdown',
    copyHint:
      'To start a fresh group from this Document, copy it, then paste it into Create group.',
    copied: 'Copied',
    copyFailed:
      'Copying is blocked here. The Document is selected below, so you can copy it yourself.',
    markdownLabel: 'The Document as Markdown',
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
   * A group's front door (#121; ADR-0038): the public page, its form, and
   * what members and applicants see of what follows. Where a name sits inside
   * a sentence, the words around it are kept apart, so the screen sets the
   * name in `<bdi>`.
   */
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
    openToApply: 'Open Reconcile from your Home Screen and tap Open the front door.',
    /** Start's field for a front door link. */
    startHeading: 'Have a front door link?',
    startLabel: 'Front door link',
    startHint: 'Paste the link a group posted.',
    startOpen: 'Open the front door',
    startBadLink: 'This isn’t a front door link. Check you copied all of it.',
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
      'They stay on this device. Nothing here is sent to the relay or to your groups, unless you share one by link. A backup file you save includes them.',
    /** In place of privacy once the device keeps a relay backup key (#97, #248): its sealed copy carries them. */
    privacyRelayBackup:
      'They stay on this device. Nothing here goes to your groups. A backup file you save includes them, and so does your sealed relay backup.',
    /** The editor's line on where its Document goes, while the device keeps no relay backup key. */
    documentPrivacy:
      'This stays on this device. Nothing here is sent to the relay or to your groups. A backup file you save includes it.',
    /** In place of documentPrivacy once the device keeps a relay backup key (#97, #248). */
    documentPrivacyRelayBackup:
      'This stays on this device. Nothing here goes to your groups. A backup file you save includes it, and so does your sealed relay backup.',
    missionTitle: 'My mission statement',
    missionPrompt: 'What do you stand for, and what are you working toward?',
    newDocument: 'New document',
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
      /** In place of the link while the device's keys are locked with a passkey, which holds its seed (#255). */
      locked:
        'This Document is shared by link, but your keys on this device are locked with your passkey. Close Reconcile, open it again and unlock it to see the link, stop sharing or delete this Document.',
      /** When Share link or Stop sharing finds the keys locked, as another tab can lock them (#255). */
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
    eraseHeading: 'Erase this device',
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
  },
  restore: {
    lede: 'Bring back the groups in a backup file you saved. On a second device, they vote as you.',
    choose: 'Choose backup file',
    chosen: 'Backup file:',
    passphrase: 'Its passphrase',
    passphraseMissing: 'Enter the passphrase this backup was saved with.',
    submit: 'Restore',
    restoring: 'Opening your backup…',
    restored: (groups: number) => {
      if (groups === 0) return 'This backup holds no groups.';
      return groups === 1
        ? '1 group is back on this device.'
        : `${count(groups)} groups are back on this device.`;
    },
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
    linked: (groups: number) =>
      groups === 1
        ? 'Linked. This device now has 1 group.'
        : `Linked. This device now has ${count(groups)} groups.`,
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
  },
  /** Group home's quiet suggestion, once per group, until a backup holds it (#78). */
  backupCard: {
    body: 'Save a backup so you can get this group back if you lose your phone.',
    save: 'Save a backup',
    notNow: 'Not now',
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
    groupLabel: 'Your group',
    groupHint: 'It votes on this card. Only groups where you can propose are listed.',
    noGroups:
      'None of your groups on this device can take this card. You need to be able to propose there, and it can’t hold this card already.',
    yourNameLabel: 'Your name in the coalition',
    yourNameHint: 'This name is only shown in this coalition.',
    yourNameMissing: 'Add the name the coalition will see.',
    submit: 'Bring to my group',
    notNow: 'Not now',
    failed: 'Bringing the card didn’t finish. Try again.',
    badLinkTitle: 'This card doesn’t work',
    badLink: 'This card has expired or is damaged. Ask the group that sent it for a new one.',
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
    waitingCard: 'Waiting for another group to bring the card.',
    lapsed: 'Not every group voted in time.',
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
    /** Over a coalition motion in a group's lists and on its page, before the coalition's name (#120). */
    voteTag: 'Coalition vote',
    tagSeparator: '·',
    /** The coalition's home (#120). */
    missingTitle: 'This coalition isn’t on this device',
    missing: 'Go back to your groups, and open it from a group that’s in it.',
    homeEyebrow: 'Coalition',
    homePageTitle: 'Coalition',
    groups: 'Member groups',
    /** Beside a member group this person is in. */
    yourGroup: 'Your group',
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
    /** Under "Send a Dispatch if this passes" on a coalition's composer (#124). */
    composerDispatchHint:
      'If the coalition passes this, the Dispatch goes out once the pass is final, a week after voting ends. Everyone who reads the coalition gets it: its followers, and people in its groups who open it.',
    /** The coalition home of someone who only follows it (#124). */
    followingEyebrow: 'Following',
    /** Between member groups' names under a followed coalition's name: "Riverside Tenants · Oak St Co-op". */
    groupsSeparator: '·',
    /** Share a follow link (#124; ADR-0053). */
    followers: 'Followers',
    share: 'Share a follow link',
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
} as const;
