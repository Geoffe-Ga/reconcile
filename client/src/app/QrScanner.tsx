/**
 * Scan a linking code with the camera (#96).
 *
 * The camera opens only after the person taps Scan the code, facing away
 * from them (`facingMode: 'environment'`), with no microphone. While it's
 * open, the scanner reads a frame five times a second and decodes it on the
 * main thread (`qr.ts`), keeping no frame. It stops every track when the
 * person stops scanning, when it reads a linking code, and when it unmounts,
 * even for a camera that only opens after it has gone. Where the browser has
 * no camera, or refuses it, it says to paste the code instead.
 */
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { Button } from 'react-aria-components';

import { messages } from './messages';
import { canvasFrames, decodeFrame, type Frame } from './qr';

/** How often the scanner reads a frame while the camera is open, in milliseconds. */
export const FRAME_MS = 200;

/** Props for {@link QrScanner}. */
export interface QrScannerProps {
  /** Called once, with the first code the camera reads that `isCode` accepts. */
  readonly onCode: (text: string) => void;
  /** Whether scanned text is a code this screen takes. */
  readonly isCode: (text: string) => boolean;
  /** Opens the rear camera: the browser's `getUserMedia` unless a test hands in another. */
  readonly openCamera?: () => Promise<MediaStream>;
  /** Reads the video's current frame: a canvas unless a test hands in another reader. */
  readonly readFrame?: (video: HTMLVideoElement) => Frame | null;
}

/** Where scanning has got to. */
type Scan =
  | { readonly kind: 'idle' | 'starting' | 'unavailable' }
  | { readonly kind: 'scanning'; readonly stream: MediaStream };

/** The browser's rear camera with no microphone, or null where there's no camera API. */
function rearCamera(): (() => Promise<MediaStream>) | null {
  const devices = navigator.mediaDevices as MediaDevices | undefined;
  if (typeof devices?.getUserMedia !== 'function') return null;
  return () => devices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
}

/** Stops every track of `stream`, which turns the camera off. */
function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/** Scan the code, the camera while it scans, and Stop scanning. */
export function QrScanner({ onCode, isCode, openCamera, readFrame }: QrScannerProps) {
  const open = useMemo(() => openCamera ?? rearCamera(), [openCamera]);
  const [scan, setScan] = useState<Scan>({ kind: 'idle' });
  const [foreign, setForeign] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const mounted = useRef(false);
  const stream = scan.kind === 'scanning' ? scan.stream : null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Whether `text` is a code to take: if so, scanning stops and it's handed on. */
  const scanned = useEffectEvent((text: string): boolean => {
    if (!isCode(text)) {
      setForeign(true);
      return false;
    }
    setScan({ kind: 'idle' });
    onCode(text);
    return true;
  });

  useEffect(() => {
    const element = video.current;
    if (stream === null || element === null) return;
    element.srcObject = stream;
    element.play().catch(() => undefined);
    const read = readFrame ?? canvasFrames();
    let timer = 0;
    const tick = (): void => {
      const frame = read(element);
      const text = frame === null ? null : decodeFrame(frame);
      if (text === null || !scanned(text)) timer = window.setTimeout(tick, FRAME_MS);
    };
    timer = window.setTimeout(tick, FRAME_MS);
    return () => {
      window.clearTimeout(timer);
      stopTracks(stream);
      element.srcObject = null;
    };
  }, [stream, readFrame]);

  if (open === null) return <p className="caption">{messages.link.noCamera}</p>;

  const start = (): void => {
    setScan({ kind: 'starting' });
    open().then(
      (opened) => {
        if (mounted.current) setScan({ kind: 'scanning', stream: opened });
        else stopTracks(opened);
      },
      () => {
        if (mounted.current) setScan({ kind: 'unavailable' });
      },
    );
  };

  return (
    <div className="scanner">
      {stream === null ? (
        <div>
          <Button
            className="button button-secondary"
            isDisabled={scan.kind === 'starting'}
            onPress={start}
          >
            {messages.link.scan}
          </Button>
        </div>
      ) : (
        <>
          <video
            ref={video}
            className="scanner-video"
            aria-label={messages.link.camera}
            muted
            playsInline
            autoPlay
          />
          <p className="caption">{messages.link.scanning}</p>
          <div>
            <Button
              className="button button-secondary"
              onPress={() => {
                setScan({ kind: 'idle' });
              }}
            >
              {messages.link.stopScan}
            </Button>
          </div>
        </>
      )}
      {scan.kind === 'unavailable' ? <p className="caption">{messages.link.noCamera}</p> : null}
      <p role="status" className="status">
        {foreign ? messages.link.notLinkCode : null}
      </p>
    </div>
  );
}
