# Bedfellows evaluation corpus (first labeller's pass)

An invented, labelled corpus for measuring Bedfellows, the feature that says
"You both care about this:" when a sentence in a reader's own Documents truly
agrees with a sentence in another group's public shelf entry. Every later
threshold is tuned and checked against these labels.

**This is the first labeller's pass.** The founder's review is the second
labeller's pass; disagreements between the two are expected and should be
recorded, not silently overwritten.

## Files

- `readers.json`: 40 readers (28 `tune`, 12 `held-out`), each with 1 to 5 Documents of mixed length. Paragraphs are separated by a blank line.
- `entries.json`: shelf entries (short public Dispatches, text at most 500 characters), each with a `publisher`, a `subject`, a `hostile` flag and, on some, `angerAtPowerful: true`.
- `publishers.json`: the invented groups that publish entries. All of a publisher's entries are in its one split.
- `pairs.json`: labelled reader/entry pairs.

## Claims and labels

- A **claim** is one whole sentence (ending in `.`, `!` or `?`); an entry's title also counts as one. Matching is sentence against sentence.
- `readerSentence` and `entrySentence` are copied exactly from the reader's Documents and from the entry's title or text. They are required for `shared-claim` and `opposed`, given where useful for `unclear`, `word-sense-trap`, `idiom` and `passing-mention`, and omitted for `unrelated` and `near-copy`.
- **Labels follow real meaning, not surface words.** Sarcasm is labelled by what it means (case `irony`). A sentence that quotes an opponent in order to reject it is labelled by the writer's own stance (case `quoted-opponent`).

## Kinds

- **shared-claim**: a reader sentence and an entry sentence genuinely agree on a value or aim. Mostly paraphrase ("reading room" vs "library"), often between groups that disagree about nearly everything else.
- **opposed**: both sentences are about the same subject and take opposite stances.
- **unclear**: same subject, but the stance is mixed or ambiguous; a careful reader couldn't call it agree or oppose.
- **word-sense-trap**: a shared word or phrase means different things on each side (chess boards vs a housing board, a river bank vs a food bank). A word-overlap matcher should fall for these.
- **idiom**: one side uses the shared word only in an idiom or figure of speech ("the devil's in the details" vs "warriors against the devil").
- **passing-mention**: the shared subject is only a two- or three-word mention on one side, not what that text is about.
- **near-copy**: the entry is nearly the same text as one of the reader's Documents, lightly reworded or trimmed. It shares everything, not something, so it should not be shown as a "you both care about this" moment.
- **unrelated**: nothing shared at all.

Named cases in `case`: `428-reading-room`, `428-deer-season`, `428-chess-boards`, `428-passing-mention`, `devil-idiom`, `irony`, `quoted-opponent`. `note` gives a short reason where the label needs one.

## Splits

Splitting is by reader and entry. A pair's reader and entry are always in the same split, and no sentence of reader or entry text appears in both splits. Tune thresholds on `tune` only, and report on `held-out` once.

## Hostile and anger at the powerful

- `hostile: true` marks an entry that is **mainly hostility toward a group of people**: a kind of person cast as the enemy, to be shunned, exposed or driven out (newcomers, trans people, hunters, vegans, believers, atheists, the young, the old, police officers, rival fans). They are realistic but contain no slurs. Some are paired, labelled by meaning like any other entry.
- `angerAtPowerful: true` marks an entry that is angry at a **powerful body or its conduct** (a landlord company, a council, a water or rail company, officials, a quarry operator) without attacking a group of people. These are **not** hostile (`hostile: false`). The line: "Fennick Estates Ltd ignores our letters" is anger at the powerful; "every landlord is a parasite" is hostility toward people.

## Subjects

Each entry has exactly one `subject` from this fixed list:

housing, libraries, hunting, animals, environment, belief, labour, business, recovery, sport, parks, schools, food, transport, health, care, privacy, arts, hobbies, heritage, youth, elders, veterans, migration, family, justice, politics, money, community, disability

`belief` covers faith groups and secular or humanist groups alike.

<!-- subjects: housing libraries hunting animals environment belief labour business recovery sport parks schools food transport health care privacy arts hobbies heritage youth elders veterans migration family justice politics money community disability -->

## Privacy

Everything here is invented: groups, people, places (Brindlewood, Harrow Creek, the Fennick estate, Tollby, the Wend) and texts. No real group, organisation, person, brand or place is named, and no real mission statement, slogan or scripture is quoted.
