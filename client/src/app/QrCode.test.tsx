/**
 * The linking code's QR code and the camera that reads it (#96): the
 * encoder's modules, drawn as pixels and fed to the decoder, read back the
 * code, with no network call while it renders or scans; the camera opens
 * only after a tap, facing away from the person, and every track stops when
 * the scanner closes or unmounts.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import decodeQR from 'qr/decode.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { linkCode, newLinkKeys, newLinkSeed } from '../crypto/link';
import { axeViolations } from '../test/axe';
import { messages } from './messages';
import { canvasFrames, decodeFrame, type Frame, MAX_FRAME, qrModules, QUIET_ZONE } from './qr';
import { QrCode } from './QrCode';
import { FRAME_MS, QrScanner } from './QrScanner';

/** A fresh linking code, as the existing device shows it. */
function code(): string {
  return linkCode(newLinkSeed(), newLinkKeys().publicKey);
}

/** `modules` drawn as RGBA pixels, `scale` per module: dark is black, light is white. */
function pixels(modules: readonly (readonly boolean[])[], scale = 4): Frame {
  const size = modules.length * scale;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dark = modules[Math.floor(y / scale)]?.[Math.floor(x / scale)] === true;
      data.fill(dark ? 0 : 255, (y * size + x) * 4, (y * size + x) * 4 + 3);
      data[(y * size + x) * 4 + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

/** A camera stream whose tracks the test can watch. */
function fakeStream() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  return { stream, tracks };
}

/** Lets the fake clock run `count` frames, one at a time, so each awaited step lands. */
async function frames(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRAME_MS);
    });
  }
}

/**
 * Waits until the scanner shows the camera and its effect has attached
 * `stream` to the video, which React runs after the commit that shows Stop
 * scanning.
 */
async function scanning(stream: MediaStream): Promise<void> {
  await screen.findByRole('button', { name: messages.link.stopScan });
  await waitFor(() => {
    expect(document.querySelector('video')?.srcObject).toBe(stream);
  });
}

/** Gives `navigator` these `mediaDevices` (jsdom has none); returns the way to take them back. */
function withMediaDevices(value: unknown): () => void {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value });
  return () => {
    Reflect.deleteProperty(navigator, 'mediaDevices');
  };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  document.title = 'Link a new device · Reconcile';
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  // jsdom has no media playback: a video's play() resolves at once here.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('qrModules', () => {
  it('round-trips the code through the decoder, from an ImageData-shaped array', () => {
    const text = code();
    expect(decodeQR(pixels(qrModules(text)))).toBe(text);
  });

  it('reads no code from a frame without one, rather than throwing', () => {
    const blank = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(255) };
    expect(decodeFrame(blank)).toBeNull();
    expect(decodeFrame(pixels(qrModules('RL1.text')))).toBe('RL1.text');
  });

  it('keeps a 4-module light quiet zone around the symbol', () => {
    const modules = qrModules(code());
    expect(QUIET_ZONE).toBe(4);
    const edge = [...modules.slice(0, 4), ...modules.slice(-4)].flat();
    const sides = modules.flatMap((row) => [...row.slice(0, 4), ...row.slice(-4)]);
    expect([...edge, ...sides].every((dark) => !dark)).toBe(true);
    // A 90-character code fits version 6 at medium error correction: 41 modules, plus the zone.
    expect(modules).toHaveLength(41 + 8);
  });
});

describe('QrCode', () => {
  it('draws the modules in one inline SVG, dark on a fixed light square, with the text beside it', async () => {
    const text = code();
    render(
      <main>
        <h1>Link a new device</h1>
        <QrCode text={text} />
      </main>,
    );

    const svg = screen.getByRole('img', { name: messages.link.qrLabel });
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.getAttribute('viewBox')).toBe('0 0 49 49');
    expect(svg.querySelector('rect.qr-light')?.getAttribute('width')).toBe('49');
    const path = svg.querySelector('path.qr-dark')?.getAttribute('d') ?? '';
    const dark = qrModules(text).flat().filter(Boolean).length;
    const drawn = [...path.matchAll(/h(\d+)v1/g)].reduce((sum, run) => sum + Number(run[1]), 0);
    expect(drawn).toBe(dark);
    expect(svg.querySelector('image, foreignObject')).toBeNull();
    expect(screen.getByText(text).tagName.toLowerCase()).toBe('code');
    expect(screen.getByText(messages.link.codeText)).toBeTruthy();
    expect(await axeViolations()).toEqual([]);
  });
});

describe('QrScanner', () => {
  it('opens the rear camera only after a tap, and reads the code from a frame', async () => {
    vi.useFakeTimers();
    const text = code();
    const { stream, tracks } = fakeStream();
    const openCamera = vi.fn(() => Promise.resolve(stream));
    const onCode = vi.fn();
    const frame = pixels(qrModules(text));
    render(
      <QrScanner
        onCode={onCode}
        isCode={(scanned) => scanned === text}
        openCamera={openCamera}
        readFrame={() => frame}
      />,
    );
    expect(openCamera).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: messages.link.scan }));
    await frames(2);

    expect(openCamera).toHaveBeenCalledOnce();
    expect(onCode).toHaveBeenCalledExactlyOnceWith(text);
    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it('asks the browser for the environment-facing camera and no microphone', async () => {
    const { stream } = fakeStream();
    const getUserMedia = vi.fn(() => Promise.resolve(stream));
    const restore = withMediaDevices({ getUserMedia });
    render(<QrScanner onCode={vi.fn()} isCode={() => false} readFrame={() => null} />);

    fireEvent.click(screen.getByRole('button', { name: messages.link.scan }));

    await scanning(stream);
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({
      video: { facingMode: 'environment' },
      audio: false,
    });
    restore();
  });

  it('keeps scanning past a QR code that isn’t a linking code, and says so', async () => {
    vi.useFakeTimers();
    const { stream } = fakeStream();
    const other = pixels(qrModules('https://example.org/menu'));
    const onCode = vi.fn();
    render(
      <QrScanner
        onCode={onCode}
        isCode={() => false}
        openCamera={() => Promise.resolve(stream)}
        readFrame={() => other}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: messages.link.scan }));
    await frames(3);

    expect(onCode).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe(messages.link.notLinkCode);
  });

  it('stops every track when the person stops scanning', async () => {
    const { stream, tracks } = fakeStream();
    render(
      <QrScanner
        onCode={vi.fn()}
        isCode={() => false}
        openCamera={() => Promise.resolve(stream)}
        readFrame={() => null}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: messages.link.scan }));
    await scanning(stream);
    const stop = screen.getByRole('button', { name: messages.link.stopScan });

    fireEvent.click(stop);

    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: messages.link.scan })).toBeTruthy();
  });

  it('stops every track on unmount', async () => {
    const { stream, tracks } = fakeStream();
    const view = render(
      <QrScanner
        onCode={vi.fn()}
        isCode={() => false}
        openCamera={() => Promise.resolve(stream)}
        readFrame={() => null}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: messages.link.scan }));
    await scanning(stream);

    view.unmount();

    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it('stops the tracks of a camera that opens after the scanner has gone', async () => {
    const { stream, tracks } = fakeStream();
    let open: (value: MediaStream) => void = () => undefined;
    const view = render(
      <QrScanner
        onCode={vi.fn()}
        isCode={() => false}
        openCamera={() => new Promise((resolve) => (open = resolve))}
        readFrame={() => null}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: messages.link.scan }));
    view.unmount();

    await act(async () => {
      open(stream);
      await Promise.resolve();
    });

    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it('says to paste the code when the camera can’t be opened', async () => {
    render(
      <main>
        <h1>Link to your other device</h1>
        <QrScanner
          onCode={vi.fn()}
          isCode={() => false}
          openCamera={() => Promise.reject(new DOMException('Denied', 'NotAllowedError'))}
          readFrame={() => null}
        />
      </main>,
    );

    fireEvent.click(screen.getByRole('button', { name: messages.link.scan }));

    expect(await screen.findByText(messages.link.noCamera)).toBeTruthy();
    expect(await axeViolations()).toEqual([]);
  });

  it('offers no scan where the browser has no camera API, only the paste line', () => {
    const restore = withMediaDevices(undefined);
    render(<QrScanner onCode={vi.fn()} isCode={() => false} readFrame={() => null} />);

    expect(screen.queryByRole('button', { name: messages.link.scan })).toBeNull();
    expect(screen.getByText(messages.link.noCamera)).toBeTruthy();
    restore();
  });

  it('shows the camera while it scans, and passes axe', async () => {
    const { stream } = fakeStream();
    render(
      <main>
        <h1>Link to your other device</h1>
        <QrScanner
          onCode={vi.fn()}
          isCode={() => false}
          openCamera={() => Promise.resolve(stream)}
          readFrame={() => null}
        />
      </main>,
    );
    fireEvent.click(screen.getByRole('button', { name: messages.link.scan }));
    await scanning(stream);

    const video = document.querySelector('video');
    expect(video?.srcObject).toBe(stream);
    expect(video?.muted).toBe(true);
    expect(video?.hasAttribute('playsinline')).toBe(true);
    expect(screen.getByText(messages.link.scanning)).toBeTruthy();
    expect(await axeViolations()).toEqual([]);
  });
});

describe('the canvas frame reader', () => {
  it('draws the video small, reads it once, and clears the canvas, keeping no frame', () => {
    const image = { width: 2, height: 2, data: new Uint8ClampedArray(16) } as unknown as ImageData;
    const context = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => image),
      clearRect: vi.fn(),
    };
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const read = canvasFrames();
    const video = document.createElement('video');
    Object.defineProperty(video, 'videoWidth', { value: MAX_FRAME * 2 });
    Object.defineProperty(video, 'videoHeight', { value: MAX_FRAME });

    expect(read(video)).toBe(image);

    expect(getContext).toHaveBeenCalledWith('2d', { willReadFrequently: true });
    expect(context.drawImage).toHaveBeenCalledWith(video, 0, 0, MAX_FRAME, MAX_FRAME / 2);
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, MAX_FRAME, MAX_FRAME / 2);
  });

  it('reads nothing before the video has a frame, or without a 2D context', () => {
    const read = canvasFrames();
    const video = document.createElement('video');
    expect(read(video)).toBeNull();
    Object.defineProperty(video, 'videoWidth', { value: 4 });
    Object.defineProperty(video, 'videoHeight', { value: 4 });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(read(video)).toBeNull();
  });
});
