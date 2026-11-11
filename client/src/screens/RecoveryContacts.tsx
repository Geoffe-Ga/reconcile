/**
 * Choose recovery contacts (`#/recovery`; #109; ADR-0043 §1, ADR-0008,
 * ADR-0009, ADR-0075 §4): how many people, how many of them it takes, and
 * who, from the people in the person's groups, each under their group by
 * their name there.
 *
 * It starts at 3 of 5 (`recoveryPolicy.ts`), or at the last choice when
 * choosing again, with the contacts who still share a group already picked.
 * Save is ready once exactly as many people are picked as the first field
 * asks. The screen says what a contact is in terms of trust, never growth:
 * nothing counts, ranks or invites anyone (ADR-0008). Who to offer comes from
 * `contactGroups` (`store/recovery.ts`), so the person themselves and any group
 * where they can't see the roster never appear.
 */
import { type SyntheticEvent, useState } from 'react';
import {
  Button,
  CheckboxButton,
  CheckboxField,
  CheckboxGroup,
  Form,
  Group,
  Input,
  Label,
  NumberField,
} from 'react-aria-components';

import { messages } from '../app/messages';
import { BackLink, PageHeader } from '../app/ui';
import {
  DEFAULT,
  MAX_CONTACTS,
  MAX_NEEDED,
  MIN_CONTACTS,
  MIN_NEEDED,
  isAllowedThreshold,
} from '../crypto/recoveryPolicy';
import type { ContactGroup, RecoveryChoice, RecoveryStatus } from '../store/recovery';

/** Props for {@link RecoveryContacts}. */
export interface RecoveryContactsProps {
  /** The groups and people a share can go to, from `contactGroups`, in the store's order. */
  readonly groups: readonly ContactGroup[];
  /** Where the person's contacts stand, or null before they've chosen any. */
  readonly current: RecoveryStatus | null;
  /** Chooses the contacts; rejects when it couldn't. */
  readonly onSave: (choice: RecoveryChoice) => Promise<void>;
}

/** A pick's key: its group and member, which no group id or key can run together. */
function pickKey(groupId: string, member: string): string {
  return `${groupId} ${member}`;
}

/** The picks to start from: the current contacts who still share a group, as the screen offers them. */
function startingPicks({ groups, current }: RecoveryContactsProps): ReadonlySet<string> {
  const offered = new Set(
    groups.flatMap(({ groupId, members }) => members.map(({ member }) => pickKey(groupId, member))),
  );
  const shared = (current?.contacts ?? []).filter(({ shared: still }) => still);
  return new Set(
    shared.map(({ groupId, member }) => pickKey(groupId, member)).filter((key) => offered.has(key)),
  );
}

/** Whole numbers, written without grouping. */
const WHOLE: Intl.NumberFormatOptions = { maximumFractionDigits: 0, useGrouping: false };

/** Props for {@link CountField}. */
interface CountFieldProps {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (value: number) => void;
}

/** A whole number with a step button either side, as the voting time is (#106). */
function CountField({ label, value, min, max, onChange }: CountFieldProps) {
  const { recovery } = messages;
  return (
    <NumberField
      className="field"
      value={value}
      minValue={min}
      maxValue={max}
      formatOptions={WHOLE}
      onChange={(next) => {
        // A blank field keeps the last count: there's always one to show.
        if (Number.isInteger(next)) onChange(next);
      }}
    >
      <Label className="field-label">{label}</Label>
      <Group className="number-group">
        <Button slot="decrement" className="button button-secondary number-step">
          <span aria-hidden="true">{recovery.fewer}</span>
        </Button>
        <Input className="input input-number" />
        <Button slot="increment" className="button button-secondary number-step">
          <span aria-hidden="true">{recovery.more}</span>
        </Button>
      </Group>
    </NumberField>
  );
}

/** Props for {@link GroupPicks}. */
interface GroupPicksProps {
  readonly group: ContactGroup;
  readonly picked: ReadonlySet<string>;
  readonly isDisabled: boolean;
  readonly onChange: (groupId: string, members: readonly string[]) => void;
}

/** One group's people as checkboxes, labelled "People in <group>", each name in `<bdi>`. */
function GroupPicks({ group, picked, isDisabled, onChange }: GroupPicksProps) {
  const { groupId, name, members } = group;
  const value = members
    .filter(({ member }) => picked.has(pickKey(groupId, member)))
    .map(({ member }) => member);
  return (
    <CheckboxGroup
      className="recovery-group"
      value={value}
      isDisabled={isDisabled}
      onChange={(chosen) => {
        onChange(groupId, chosen);
      }}
    >
      <Label className="recovery-group-label">
        {messages.recovery.inGroupBefore} <bdi>{name}</bdi>
      </Label>
      <ul className="recovery-people">
        {members.map(({ member, name: person }) => (
          <li key={member}>
            <CheckboxField value={member}>
              <CheckboxButton className="checkbox">
                <span className="checkbox-box" aria-hidden="true" />
                <bdi>{person}</bdi>
              </CheckboxButton>
            </CheckboxField>
          </li>
        ))}
      </ul>
    </CheckboxGroup>
  );
}

/** The live line under the picks: how many are picked of how many asked, or that it's too many. */
function pickedLine(count: number, n: number): string {
  const { recovery } = messages;
  return count > n ? recovery.tooMany(count, n) : recovery.picked(count, n);
}

/** The form: the two counts, the people, and Save. */
function PickForm(props: RecoveryContactsProps) {
  const { groups, current, onSave } = props;
  const { recovery } = messages;
  const [n, setN] = useState(current?.n ?? DEFAULT.n);
  const [t, setT] = useState(current?.t ?? DEFAULT.t);
  const [picked, setPicked] = useState(() => startingPicks(props));
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const contacts = groups.flatMap(({ groupId, members }) =>
    members
      .filter(({ member }) => picked.has(pickKey(groupId, member)))
      .map(({ member }) => ({ groupId, member })),
  );
  const ready = contacts.length === n && isAllowedThreshold(t, n);
  const changeGroup = (groupId: string, members: readonly string[]) => {
    setPicked((now) => {
      const others = [...now].filter((key) => !key.startsWith(`${groupId} `));
      return new Set([...others, ...members.map((member) => pickKey(groupId, member))]);
    });
  };
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    setFailed(false);
    onSave({ t, contacts }).catch(() => {
      setSaving(false);
      setFailed(true);
    });
  };
  return (
    <Form className="form" onSubmit={submit}>
      <div className="recovery-counts">
        <CountField
          label={recovery.howMany}
          value={n}
          min={MIN_CONTACTS}
          max={MAX_CONTACTS}
          onChange={(next) => {
            setN(next);
            setT((now) => Math.min(now, next));
          }}
        />
        <CountField
          label={recovery.needed}
          value={t}
          min={MIN_NEEDED}
          max={Math.min(MAX_NEEDED, n)}
          onChange={setT}
        />
      </div>
      <p className="recovery-any">{recovery.anyOf(t, n)}</p>
      {groups.map((group) => (
        <GroupPicks
          key={group.groupId}
          group={group}
          picked={picked}
          isDisabled={saving}
          onChange={changeGroup}
        />
      ))}
      <p role="status" className="recovery-picked">
        {saving ? recovery.saving : pickedLine(contacts.length, n)}
      </p>
      {failed ? (
        <p role="alert" className="form-error">
          {recovery.failed}
        </p>
      ) : null}
      <div className="row form-actions">
        <Button type="submit" className="button button-primary" isDisabled={!ready || saving}>
          {recovery.save}
        </Button>
      </div>
    </Form>
  );
}

/**
 * The picker: what recovery contacts are, the issue's words on whom to pick,
 * and, once anyone in the person's groups can hold a share, the form.
 */
export function RecoveryContacts(props: RecoveryContactsProps) {
  const { recovery } = messages;
  const again = props.current !== null;
  return (
    <main className="shell">
      <BackLink to={{ name: 'settings' }} label={messages.settings.title} />
      <PageHeader
        title={again ? recovery.againTitle : recovery.title}
        pageTitle={recovery.pageTitle}
      />
      <div className="stack recovery-about">
        <p className="lede">{recovery.lede}</p>
        <p>{recovery.pick}</p>
        {again ? <p className="caption">{recovery.again}</p> : null}
      </div>
      {props.groups.length === 0 ? (
        <p className="lede">{recovery.nobody}</p>
      ) : (
        <PickForm {...props} />
      )}
    </main>
  );
}
