/**
 * A sentence with names in it (#549), from a messages template whose names
 * are `{key}` placeholders: every name in its own `<bdi>`, so a name from
 * another device, in any direction, can't reorder the words around it. Names
 * are plain text; a placeholder with no name given stays as written.
 */

/** Props for {@link Worded}. */
export interface WordedProps {
  /** The sentence, with `{key}` where each name goes. */
  readonly template: string;
  /** The name for each placeholder's key. */
  readonly names: Readonly<Record<string, string>>;
}

/** The words of one sentence, each name in `<bdi>`. */
export function Worded({ template, names }: WordedProps) {
  // Splitting on a capturing group puts each placeholder's key at the odd indexes.
  const parts = template.split(/\{(\w+)\}/);
  return (
    <>
      {parts.map((part, index) => {
        if (index % 2 === 0) return part;
        const name = names[part];
        return name === undefined ? `{${part}}` : <bdi key={index}>{name}</bdi>;
      })}
    </>
  );
}
