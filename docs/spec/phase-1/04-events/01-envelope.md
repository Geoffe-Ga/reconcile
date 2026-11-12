### Envelope

```json
{"v": 1, "type": "proposal", "group": "<group id>", "author": "<public key>", "ts": 1762650000000, "body": {}}
```

- The author serializes the event once with `JSON.stringify` to UTF-8. Those exact bytes are signed, sent and hashed, and nobody re-encodes them.
- The event id is the unpadded base64url SHA-256 of those bytes.
- `ts` is the author's clock in milliseconds, for display only.
- Genesis carries `group: ""`, because it can't contain its own hash. The group id is the id of the mailbox's first valid genesis, and every other event carries it.
- Text is NFC-normalized before signing. Atom text also goes through `normalizeAtomText` (#70, `client/src/engine/atomText.ts`, pinned by `vectors/atom-text.json`), in this order: lone surrogates become U+FFFD; CRLF, then any lone CR, becomes LF; NFC; trailing U+0020 and U+0009 leave each line (a trailing NBSP stays, so it is never `trim` or `\s`); and the text ends in exactly one LF. Blank text becomes `""`. Create group normalizes each genesis Atom after splitting at blank lines, and the composer's action normalizes a Proposal's text. A Markdown hard break written as two trailing spaces is therefore lost, so the editor teaches the backslash. The fold never re-normalizes received text, because browsers ship different Unicode tables. `isHeadingOnly(text)` (#103, same file) is true for normalized text that is one line matching `/^#{1,6} [^\n]*\S[^\n]*\n$/u`, a section header: `"# Values\n"` and `"## Organization\n"` are, `"# Values\nWe care.\n"` and `"#Values\n"` aren't. The fold treats a header as any other Atom; the screens set one as a header and name it in what an add does.
