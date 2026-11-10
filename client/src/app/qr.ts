/**
 * QR codes for linking a second device (#96), and the one place the app
 * imports the `qr` package: its dependency-free encoder and pure-JS decoder,
 * by the author of the @noble libraries, pinned exactly in package.json.
 *
 * The decoder runs on the main thread, on frames a canvas reads from the
 * camera, because the CSP allows no `blob:` worker and no WebAssembly. A
 * frame is read, decoded and dropped: nothing keeps one, and the canvas is
 * cleared after each read.
 */
import encodeQR from 'qr';
import decodeQR from 'qr/decode.js';

/** The light border around the symbol, in modules: ISO/IEC 18004's quiet zone. */
export const QUIET_ZONE = 4;

/** The longest side a camera frame is drawn at before it's decoded, in pixels. */
export const MAX_FRAME = 800;

/** RGBA pixels, the shape a canvas `ImageData` has. */
export interface Frame {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/**
 * The modules of `text`'s QR code, at medium error correction, with the
 * quiet zone around them: `true` is a dark module.
 */
export function qrModules(text: string): boolean[][] {
  return encodeQR(text, 'raw', { ecc: 'medium', border: QUIET_ZONE });
}

/** The text of the QR code in `frame`, or null when it holds none the decoder can read. */
export function decodeFrame(frame: Frame): string | null {
  try {
    return decodeQR(frame);
  } catch {
    return null;
  }
}

/**
 * A reader of camera frames: each call draws the video's current frame on
 * one canvas, at most {@link MAX_FRAME} pixels on its longer side, reads its
 * pixels and clears it. Null until the video has a frame, or where there's
 * no 2D canvas.
 */
export function canvasFrames(): (video: HTMLVideoElement) => Frame | null {
  const canvas = document.createElement('canvas');
  return (video) => {
    const { videoWidth, videoHeight } = video;
    if (videoWidth === 0 || videoHeight === 0) return null;
    const scale = Math.min(1, MAX_FRAME / Math.max(videoWidth, videoHeight));
    canvas.width = Math.round(videoWidth * scale);
    canvas.height = Math.round(videoHeight * scale);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = context.getImageData(0, 0, canvas.width, canvas.height);
    context.clearRect(0, 0, canvas.width, canvas.height);
    return frame;
  };
}
