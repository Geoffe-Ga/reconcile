/**
 * A linking code as a QR code, with the same code as text beside it (#96).
 *
 * The symbol is an inline `<svg>` of its modules, never a `data:` image,
 * which the CSP (#71) refuses. Its colors are fixed (DESIGN.md's `qr-dark`
 * on `qr-light`) in both themes, because a camera reads dark modules on a
 * light ground, and a code drawn light on dark fails on many phones. The
 * text is selectable, and selects as a whole, for a device with no camera.
 */
import { useMemo } from 'react';

import { messages } from './messages';
import { qrModules } from './qr';

/** Props for {@link QrCode}. */
export interface QrCodeProps {
  /** The text to encode and show. */
  readonly text: string;
}

/** One SVG subpath per run of dark modules in a row: a 1-module-high rectangle. */
function modulePath(modules: readonly (readonly boolean[])[]): string {
  const runs: string[] = [];
  modules.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== true) {
        x += 1;
        continue;
      }
      const start = x;
      while (row[x] === true) x += 1;
      runs.push(`M${String(start)} ${String(y)}h${String(x - start)}v1h-${String(x - start)}z`);
    }
  });
  return runs.join('');
}

/** The code's QR symbol and, beside it, the same code as text. */
export function QrCode({ text }: QrCodeProps) {
  const { size, path } = useMemo(() => {
    const modules = qrModules(text);
    return { size: String(modules.length), path: modulePath(modules) };
  }, [text]);
  return (
    <figure className="qr">
      <svg
        className="qr-symbol"
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={messages.link.qrLabel}
        shapeRendering="crispEdges"
      >
        <rect className="qr-light" width={size} height={size} />
        <path className="qr-dark" d={path} />
      </svg>
      <figcaption className="qr-caption">
        <span className="caption">{messages.link.codeText}</span>
        <code className="qr-text">{text}</code>
      </figcaption>
    </figure>
  );
}
