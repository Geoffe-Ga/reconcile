/**
 * The first-run guide (#91): after the first Create group or Join on a device,
 * up to three cards say once how a group decides, and the person can skip it.
 *
 * 1. **Propose**, for someone `can()` lets propose.
 * 2. **Vote 0–4**, for someone it lets vote. The scale's ends and the
 *    ordinary bar come from the engine (`SCORE_MIN`, `SCORE_MAX` and the
 *    group's `rules.bars.ordinary`, formatted as the consent meter formats
 *    them), never from the copy.
 * 3. **Discuss in your chat**, for anyone who reads the group.
 *
 * A Member sees only the last, and so does a newcomer still earning a vote
 * (#101); nobody sees any until the relay has returned their join. It's a
 * React Aria modal Dialog: focus moves in and stays, each card's heading takes
 * focus as it appears, and Back, Next (Done on the last card) and Skip sit on
 * every card. Skip, Done and Escape all close it, and the caller records it as
 * seen (`src/platform/guide.ts`).
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';

import { can, type Capability } from '../engine/capabilities';
import { SCORE_MAX, SCORE_MIN } from '../engine/event';
import type { GroupState } from '../engine/fold';
import { formatAverageLine, formatZeroLine } from './format';
import { messages } from './messages';

/** Props for {@link FirstRunGuide}. */
export interface FirstRunGuideProps {
  /** The group just created or joined, folded from relay records. */
  readonly state: GroupState;
  /** This device's author id in the group. */
  readonly me: string;
  /** Skip, Done or Escape: the guide is finished with. */
  readonly onClose: () => void;
}

/** One card: what it explains, and the capability its action needs. */
interface Card {
  readonly needs: Capability;
  readonly title: string;
  readonly body: string;
}

/** The cards `me` sees in this group, in order: each only where `can()` allows its action. */
function cardsFor(state: GroupState, me: string): readonly Card[] {
  const { guide } = messages;
  const bar = state.rules.bars.ordinary;
  const low = String(SCORE_MIN);
  const high = String(SCORE_MAX);
  const cards: readonly Card[] = [
    { needs: 'propose', title: guide.proposeTitle, body: guide.propose },
    {
      needs: 'vote',
      title: guide.voteTitle(low, high),
      body: guide.vote(low, high, formatAverageLine(bar), formatZeroLine(bar)),
    },
    { needs: 'read', title: guide.discussTitle, body: guide.discuss },
  ];
  return cards.filter((card) => can(state, me, card.needs));
}

interface CardsProps {
  readonly cards: readonly Card[];
  readonly onClose: () => void;
}

/** The card at hand, where it sits among them, and Back, Next or Done, and Skip. */
function Cards({ cards, onClose }: CardsProps) {
  const [at, setAt] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  // A level change while the guide is open can take a card away.
  const index = Math.min(at, cards.length - 1);
  const card = cards[index];
  const last = index === cards.length - 1;
  const { guide } = messages;

  useEffect(() => {
    heading.current?.focus();
  }, [index]);

  if (card === undefined) return null;
  return (
    <div className="stack guide">
      <div className="page-head">
        <p className="eyebrow">{guide.step(index + 1, cards.length)}</p>
        <Heading slot="title" ref={heading} tabIndex={-1} className="dialog-title">
          {card.title}
        </Heading>
      </div>
      <p className="lede">{card.body}</p>
      <div className="row form-actions">
        <Button
          className="button button-secondary"
          isDisabled={index === 0}
          onPress={() => {
            setAt(index - 1);
          }}
        >
          {guide.back}
        </Button>
        <Button
          className="button button-primary"
          onPress={() => {
            if (last) onClose();
            else setAt(index + 1);
          }}
        >
          {last ? guide.done : guide.next}
        </Button>
        <Button className="button button-quiet" onPress={onClose}>
          {guide.skip}
        </Button>
      </div>
    </div>
  );
}

/** The guide, open over the group's home, or nothing until `me` holds a card's capability. */
export function FirstRunGuide({ state, me, onClose }: FirstRunGuideProps) {
  const cards = cardsFor(state, me);
  if (cards.length === 0) return null;
  return (
    <ModalOverlay
      className="modal-overlay"
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal className="modal">
        <Dialog className="dialog">
          <Cards cards={cards} onClose={onClose} />
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
