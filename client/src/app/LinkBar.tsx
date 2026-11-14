/**
 * The link bar (#444; ADR-0077 §6, DESIGN.md "Link bar"): one pill at the
 * top of every screen of the app, where any Reconcile link opens. On
 * iPhone a link opens in Safari, not in the installed app, so copy, open
 * the app, paste is how most links arrive.
 *
 * Pasting or typing never opens anything: the bar says what the text is
 * (`linkKind`) in one row, and Enter or a tap on the row opens it through
 * the link's own page. Then the bar empties and lets go of focus. A damaged
 * link, or anything that isn't a Reconcile link, gets one line instead. A
 * linking or recovery code gets one line pointing to the screen that takes
 * it, and the field empties at once: the bar never passes, prefills or keeps
 * a code. The bar keeps no history and suggests nothing: a list of the links
 * someone opened would be a list of the groups they were invited to.
 *
 * Cmd+L or Ctrl+L puts the cursor in it with its text selected, from
 * anywhere, and so does `/` outside a field. Escape empties it, and a second
 * Escape hands focus back to where it was. While its panel shows, a scrim
 * covers the page (which the app makes inert), and a tap there empties it.
 * On a touch device an empty, focused bar offers Paste, which reads the
 * clipboard once inside that tap: the only place the app reads it.
 */
import { type KeyboardEvent, type RefObject, useContext, useEffect, useRef, useState } from 'react';
import {
  Autocomplete,
  AutocompleteStateContext,
  Button,
  Input,
  type Key,
  Link,
  ListBox,
  ListBoxItem,
  SearchField,
} from 'react-aria-components';

import { clipboardReader, isTouch, type ReadClipboard } from '../platform/clipboard';
import { type CodeKind, type LinkKind, linkKind, type OpenableLink } from './linkKind';
import { messages } from './messages';
import { type Route, routeHref } from './router';
import { prepare, search, type SearchRecord, type SearchResult } from './search';
import { SearchResults } from './SearchResults';
import { moreOf, type Shelf, shelvesOf } from './searchShelves';

const words = messages.linkBar;

/** Props for {@link LinkBar}. */
export interface LinkBarProps {
  /** Opens a link the bar read, through that link's own page. */
  readonly onOpen: (link: OpenableLink) => void;
  /** Says when the panel under the bar shows or goes, so the page under the scrim can be made inert. */
  readonly onPanelChange?: (shown: boolean) => void;
  /** Reads the clipboard once, inside a tap on Paste; null where the browser can't. */
  readonly readClipboard?: ReadClipboard | null;
  /** Whether this is a touch device, where an empty, focused bar offers Paste. */
  readonly touch?: boolean;
  /** What this device holds for search (#445), built in memory; none by default. */
  readonly records?: readonly SearchRecord[];
  /** Reads what this device holds for search afresh, each time the bar takes focus; in place of `records`. */
  readonly loadRecords?: () => Promise<readonly SearchRecord[]>;
  /** Opens a search result, at its own page. */
  readonly onGo?: (record: SearchRecord) => void;
}

/** Whether `target` takes typing of its own, so `/` belongs to it. */
function isField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** Whether a key press asks for the bar: Cmd+L or Ctrl+L anywhere, or `/` outside a field. */
function asksForBar(event: globalThis.KeyboardEvent): boolean {
  if (event.altKey || event.shiftKey) return false;
  const command = event.metaKey || event.ctrlKey;
  if (command) return event.key.toLowerCase() === 'l';
  return event.key === '/' && !isField(event.target);
}

/** Puts the cursor in `input` on Cmd+L, Ctrl+L or `/`, except while a modal dialog holds focus. */
function useShortcut(input: RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.defaultPrevented || !asksForBar(event)) return;
      if (document.querySelector('[aria-modal="true"]') !== null) return;
      const field = input.current;
      if (field === null) return;
      event.preventDefault();
      field.focus();
      field.select();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [input]);
}

/** A magnifier, at the pill's start. */
function MagnifierGlyph() {
  return (
    <svg
      className="link-bar-glyph"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
    </svg>
  );
}

/** The screen each code goes to, opened bare: the bar never hands a code on. */
const CODE_SCREENS: Readonly<Record<CodeKind, Route>> = {
  'linking-code': { name: 'linkThis' },
  'recovery-code': { name: 'helpRecover' },
};

/** The panel's one line for `read`, or null for a link, which has a row of its own. */
function lineOf(read: LinkKind): string | null {
  switch (read.kind) {
    case 'damaged':
      return words.damaged;
    case 'not-a-link':
      return words.notALink;
    case 'linking-code':
    case 'recovery-code':
      return words.codes[read.kind].line;
    default:
      return null;
  }
}

/** Where a pasted code goes, in one line, and a plain link to the screen that takes it. */
function CodePointer({ kind }: { readonly kind: CodeKind }) {
  return (
    <>
      <p className="link-bar-line">{words.codes[kind].line}</p>
      <p className="link-bar-pointer">
        <Link className="forward-link" href={routeHref(CODE_SCREENS[kind])}>
          {words.codes[kind].screen} <span aria-hidden="true">{messages.app.forward}</span>
        </Link>
      </p>
    </>
  );
}

/** What the panel under the bar holds: one row for a link, a code's pointer, or one line. */
function Panel({ read, onOpen }: { readonly read: LinkKind; readonly onOpen: () => void }) {
  if (read.kind === 'linking-code' || read.kind === 'recovery-code') {
    return <CodePointer kind={read.kind} />;
  }
  if (!('payload' in read)) return <p className="link-bar-line">{lineOf(read)}</p>;
  return (
    <ListBox className="link-bar-rows" aria-label={words.rows} onAction={onOpen}>
      <ListBoxItem id="open" className="link-bar-row" textValue={words.kinds[read.kind]}>
        <span>{words.kinds[read.kind]}</span>
        <span className="link-bar-open">
          {words.open} <span aria-hidden="true">{messages.app.forward}</span>
        </span>
      </ListBoxItem>
    </ListBox>
  );
}

/** What the live region says of `read`: how many rows show, or the panel's one line. */
function announcementOf(read: LinkKind | null): string {
  if (read === null) return '';
  return lineOf(read) ?? words.results(1);
}

/** Lets go of focus in `input`, if it still holds it. */
function letGo(input: HTMLInputElement | null): void {
  if (input !== null && document.activeElement === input) input.blur();
}

/**
 * Whether focus is inside `bar`; `handBack` returns it to where it came
 * from (or lets go of `input`), and `forget` drops where that was.
 */
function useFocusInside(
  bar: RefObject<HTMLElement | null>,
  input: RefObject<HTMLInputElement | null>,
  clearPointer: (none: null) => void,
) {
  const [inside, setInside] = useState(false);
  const returnTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const element = bar.current;
    if (element === null) return;
    const onIn = (event: globalThis.FocusEvent): void => {
      const from = event.relatedTarget;
      if (from instanceof HTMLElement && !element.contains(from)) returnTo.current = from;
      setInside(true);
    };
    const onOut = (event: globalThis.FocusEvent): void => {
      const to = event.relatedTarget;
      if (to instanceof Node && element.contains(to)) return;
      setInside(false);
      // A code's pointer goes with the focus: it never waits to show again.
      clearPointer(null);
    };
    element.addEventListener('focusin', onIn);
    element.addEventListener('focusout', onOut);
    return () => {
      element.removeEventListener('focusin', onIn);
      element.removeEventListener('focusout', onOut);
    };
  }, [bar, clearPointer]);
  const handBack = () => {
    const to = returnTo.current;
    returnTo.current = null;
    if (to?.isConnected === true) to.focus();
    else letGo(input.current);
  };
  const forget = () => {
    returnTo.current = null;
  };
  return { inside, handBack, forget };
}

/**
 * Paste, while `offered` (a touch device, the bar focused and empty) and the
 * browser can read the clipboard and hasn't refused: it reads the clipboard
 * once inside the tap. Null while it isn't offered.
 */
function usePaste(
  readClipboard: ReadClipboard | null,
  offered: boolean,
  input: RefObject<HTMLInputElement | null>,
  setText: (text: string) => void,
): (() => void) | null {
  const [refused, setRefused] = useState(false);
  if (readClipboard === null || refused || !offered) return null;
  return () => {
    readClipboard().then(
      (pasted) => {
        setText(pasted);
        input.current?.focus();
      },
      () => {
        setRefused(true);
        input.current?.focus();
      },
    );
  };
}

/** Props for {@link Pill}. */
interface PillProps {
  readonly input: RefObject<HTMLInputElement | null>;
  readonly empty: boolean;
  /** Paste, while the bar offers it; else null. */
  readonly paste: (() => void) | null;
  readonly onKeyDown: (event: KeyboardEvent) => void;
  readonly onSubmit: () => void;
}

/** The magnifier, the field, and Clear while there's text, or Paste where it's offered. */
function Pill({ input, empty, paste, onKeyDown, onSubmit }: PillProps) {
  return (
    <div className="link-bar-pill">
      <MagnifierGlyph />
      <SearchField
        aria-label={words.label}
        className="link-bar-field"
        onKeyDown={onKeyDown}
        onSubmit={onSubmit}
      >
        <Input
          ref={input}
          className="link-bar-input"
          placeholder={words.label}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
        {empty ? null : (
          <Button className="link-bar-button" aria-label={words.clear}>
            {words.clear}
          </Button>
        )}
      </SearchField>
      {paste === null ? null : (
        <Button className="link-bar-button" onPress={paste}>
          {words.paste}
        </Button>
      )}
    </div>
  );
}

/** The link `read` names, when it's one the bar opens. */
function openable(read: LinkKind | null): OpenableLink | null {
  return read !== null && 'payload' in read ? read : null;
}

/**
 * What the panel shows: a link's read (a link, a code, a damaged link, or a
 * link to another site), or search results for plain words (#445).
 */
type View =
  | { readonly read: LinkKind }
  | { readonly results: readonly SearchResult[]; readonly query: string };

/** Text that's meant as a link: an address with a scheme, or a fragment. Words that aren't are a search. */
const LINK_LIKE = /(?:^|\s)(?:[a-z][a-z\d+.-]*:\/\/|#\S)/iu;

/** What the panel shows: nothing without focus or text; a code's pointer; a link's read; else a search. */
function viewOf(
  inside: boolean,
  pointer: CodeKind | null,
  text: string,
  records: readonly SearchRecord[],
): View | null {
  if (!inside) return null;
  if (pointer !== null) return { read: { kind: pointer } };
  if (text.trim() === '') return null;
  const read = linkKind(text);
  return read.kind === 'not-a-link' && !LINK_LIKE.test(text)
    ? { results: search(records, text), query: text }
    : { read };
}

/** What the live region says of `view`: how many results or rows show, or the panel's one line. */
function spokenOf(view: View | null): string {
  if (view === null) return '';
  if ('read' in view) return announcementOf(view.read);
  return view.results.length === 0 ? messages.search.nothing : words.results(view.results.length);
}

/** Props for {@link Overlay}. */
interface OverlayProps {
  /** True while the bar has focus: its live region exists only then, so a page's own stays the only one. */
  readonly live: boolean;
  readonly view: View | null;
  readonly expanded: ReadonlySet<Shelf>;
  readonly onOpen: () => void;
  readonly onResult: (key: Key) => void;
  readonly onDismiss: () => void;
}

/** What the panel holds for `view`. */
function ViewPanel({
  view,
  expanded,
  onOpen,
  onResult,
}: Omit<OverlayProps, 'view' | 'onDismiss' | 'live'> & { readonly view: View }) {
  if ('read' in view) return <Panel read={view.read} onOpen={onOpen} />;
  if (view.results.length === 0) {
    return (
      <>
        <p className="link-bar-line">{messages.search.nothing}</p>
        <p className="link-bar-line link-bar-scope">{messages.search.scope}</p>
      </>
    );
  }
  return (
    <SearchResults
      results={view.results}
      query={view.query}
      expanded={expanded}
      onAction={onResult}
    />
  );
}

/**
 * Results can run longer than the panel, which then scrolls; their rows
 * take only the keyboard's virtual focus, so the panel itself is a named
 * region Tab can reach, to scroll by keyboard (WCAG 2.1.1).
 */
function scrollerProps(view: View) {
  if (!('results' in view) || view.results.length === 0) return {};
  return { role: 'region', 'aria-label': messages.search.panel, tabIndex: 0 } as const;
}

/** The panel under the pill and the scrim behind it, while the bar has focus and text. */
function Overlay({ live, view, onDismiss, ...rest }: OverlayProps) {
  return (
    <>
      {live ? (
        <div role="status" className="visually-hidden">
          {spokenOf(view)}
        </div>
      ) : null}
      {view === null ? null : (
        <>
          <div className="link-bar-panel" {...scrollerProps(view)}>
            <ViewPanel view={view} {...rest} />
          </div>
          <div className="link-bar-scrim" data-testid="link-bar-scrim" onPointerDown={onDismiss} />
        </>
      )}
    </>
  );
}

/**
 * The records search reads: `given`, or what `load` reads each time the
 * bar takes focus, kept only while the bar shows them.
 */
function useRecords(
  given: readonly SearchRecord[],
  load: (() => Promise<readonly SearchRecord[]>) | undefined,
  inside: boolean,
): readonly SearchRecord[] {
  const [loaded, setLoaded] = useState<readonly SearchRecord[] | null>(null);
  useEffect(() => {
    if (load === undefined || !inside) return;
    let live = true;
    void load().then((records) => {
      if (!live) return;
      prepare(records);
      setLoaded(records);
    });
    return () => {
      live = false;
    };
  }, [load, inside]);
  return loaded ?? given;
}

/**
 * Drops the list's virtual focus while no rows show, so the field never
 * names a row that isn't there: React Aria keeps the last one otherwise, and
 * names it again once a new list mounts.
 */
function ForgetRow({ shown }: { readonly shown: boolean }) {
  const state = useContext(AutocompleteStateContext);
  const focused = state?.focusedNodeId ?? null;
  useEffect(() => {
    // Only when a row is named: an update with nothing to forget would re-render the bar for nothing.
    if (!shown && focused !== null) state?.setFocusedNodeId(null);
  }, [shown, focused, state]);
  return null;
}

/** No records: a search finds nothing until the app hands the bar what the device holds. */
const NO_RECORDS: readonly SearchRecord[] = [];

/** No eyebrow shows all its rows yet. */
const NONE_EXPANDED: ReadonlySet<Shelf> = new Set();

/** The search results `view` shows, if any. */
function resultsOf(view: View | null): readonly SearchResult[] {
  return view !== null && 'results' in view ? view.results : [];
}

/** The pill, the panel under it while it has focus and text, and the scrim behind them. */
export function LinkBar(props: LinkBarProps) {
  const { onOpen, onPanelChange, readClipboard = clipboardReader(), touch = isTouch() } = props;
  const { onGo } = props;
  const input = useRef<HTMLInputElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  // A pasted code's kind: the bar points to where the code goes, and keeps none of it.
  const [pointer, setPointer] = useState<CodeKind | null>(null);
  const { inside, handBack, forget } = useFocusInside(bar, input, setPointer);
  const records = useRecords(props.records ?? NO_RECORDS, props.loadRecords, inside);
  const [expanded, setExpanded] = useState<ReadonlySet<Shelf>>(NONE_EXPANDED);
  const take = (value: string) => {
    const { kind } = linkKind(value);
    const code = kind === 'linking-code' || kind === 'recovery-code' ? kind : null;
    setPointer(code);
    setText(code === null ? value : '');
    setExpanded(NONE_EXPANDED);
  };
  const paste = usePaste(readClipboard, touch && inside && text === '', input, take);
  useShortcut(input);

  const view = viewOf(inside, pointer, text, records);
  const shown = view !== null;
  useEffect(() => {
    onPanelChange?.(shown);
  }, [shown, onPanelChange]);

  const onKeyDown = (event: KeyboardEvent) => {
    // The field empties itself on Escape while it holds text; on an empty field, Escape
    // closes a code's pointer, and then hands focus back.
    if (event.key !== 'Escape' || text !== '') return;
    if (pointer === null) handBack();
    else setPointer(null);
  };
  const dismiss = () => {
    setText('');
    setPointer(null);
    handBack();
  };
  /** Empties the bar and lets go of focus, then hands `go` on. */
  const leaveFor = (go: () => void) => {
    setText('');
    setExpanded(NONE_EXPANDED);
    forget();
    letGo(input.current);
    go();
    // A tap's press ends by putting focus back in the field (React Aria's virtual focus), so let go once more after it.
    window.setTimeout(() => {
      letGo(input.current);
    }, 0);
  };
  const open = () => {
    const link = view !== null && 'read' in view ? openable(view.read) : null;
    if (link !== null) {
      leaveFor(() => {
        onOpen(link);
      });
    }
  };
  const goTo = (record: SearchRecord | undefined) => {
    if (record !== undefined) {
      leaveFor(() => {
        onGo?.(record);
      });
    }
  };
  const onResult = (key: Key) => {
    const shelf = moreOf(key);
    if (shelf !== null) setExpanded(new Set([...expanded, shelf]));
    else goTo(resultsOf(view).find((result) => result.record.id === key)?.record);
  };
  const onSubmit = () => {
    // A row with the keyboard's virtual focus opens through the list; else Enter opens the first.
    if (input.current?.hasAttribute('aria-activedescendant') === true) return;
    // The first row as it shows: the first eyebrow's first.
    const first = shelvesOf(resultsOf(view), expanded).at(0)?.rows.at(0);
    if (first === undefined) open();
    else goTo(first.record);
  };

  return (
    <div className="link-bar-band">
      <div ref={bar} role="search" className="link-bar">
        <Autocomplete inputValue={text} onInputChange={take}>
          <Pill
            input={input}
            empty={text === ''}
            paste={paste}
            onKeyDown={onKeyDown}
            onSubmit={onSubmit}
          />
          <ForgetRow shown={shown} />
          <Overlay
            live={inside}
            view={view}
            expanded={expanded}
            onOpen={open}
            onResult={onResult}
            onDismiss={dismiss}
          />
        </Autocomplete>
      </div>
    </div>
  );
}
