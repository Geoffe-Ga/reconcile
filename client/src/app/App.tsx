import { Button } from 'react-aria-components';

/**
 * Tracer shell: proves React, React Aria, and the DESIGN.md tokens are wired.
 * Real screens replace this per docs/spec/phase-1-spec.md §7.
 */
export function App() {
  return (
    <main className="shell">
      <p className="eyebrow">Reconcile</p>
      <h1>Your group&rsquo;s living documents</h1>
      <p className="lede">
        Pitch a change, talk it through, and vote. The document is whatever survives the vote.
      </p>
      <Button className="button-primary">Create an organization</Button>
    </main>
  );
}
