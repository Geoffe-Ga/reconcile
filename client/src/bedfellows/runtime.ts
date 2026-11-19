/**
 * The model runtime (#476; ADR-0080 §2): ONNX Runtime Web's plain
 * WebAssembly build and Hugging Face's WordPiece tokenizer, both pinned
 * exactly. This is the only module that imports either (dependency-cruiser's
 * `only-runtime-ts-imports-the-runtime`), so swapping the runtime touches one
 * file.
 *
 * It fetches nothing. It is handed the three files, already checked against
 * their pins (`src/net/modelFiles.ts`), and runs on one thread in the worker
 * it is loaded in: no proxy worker, no threads (which would need a `blob:`
 * worker the CSP refuses), and no file from any URL. Compiling the
 * WebAssembly it is handed needs `'wasm-unsafe-eval'` in the CSP's
 * `script-src`, and nothing else.
 *
 * Its logging is set to errors only, and those it throws rather than prints,
 * so nothing of the reader's reaches the console.
 */
import { Tokenizer } from '@huggingface/tokenizers';
import { env, InferenceSession, Tensor } from 'onnxruntime-web/wasm';

/** The model's files, each checked against its pin. */
export interface RuntimeFiles {
  /** The ONNX network. */
  readonly model: Uint8Array;
  /** `tokenizer.json`, as UTF-8. */
  readonly tokenizer: Uint8Array;
  /** ONNX Runtime Web's WebAssembly. */
  readonly runtime: Uint8Array;
}

/**
 * The model's last hidden states for a batch of sentences, laid out as
 * [sentences, tokens, dimensions], with `mask` saying which tokens are real
 * (1) and which are padding (0), laid out as [sentences, tokens].
 */
export interface TokenStates {
  readonly data: Float32Array;
  readonly mask: Uint8Array;
  readonly sentences: number;
  readonly tokens: number;
  readonly dimensions: number;
}

/** A started model: sentences in, their token states out. */
export interface Encoder {
  encode(sentences: readonly string[]): Promise<TokenStates>;
}

/**
 * The most tokens a sentence keeps, its [CLS] and [SEP] included: the
 * sentence-transformers setting for all-MiniLM-L6-v2. A claim is one
 * sentence, so this cuts only a run-on one.
 */
export const MAX_TOKENS = 256;

/**
 * `tokenizer_config.json` for an uncased BERT WordPiece tokenizer, which is
 * what all-MiniLM-L6-v2 uses. It says nothing `tokenizer.json` doesn't, so it
 * isn't a pinned file of its own.
 */
const TOKENIZER_CONFIG = {
  clean_up_tokenization_spaces: true,
  cls_token: '[CLS]',
  do_basic_tokenize: true,
  do_lower_case: true,
  mask_token: '[MASK]',
  model_max_length: 512,
  never_split: null,
  pad_token: '[PAD]',
  sep_token: '[SEP]',
  strip_accents: null,
  tokenize_chinese_chars: true,
  tokenizer_class: 'BertTokenizer',
  unk_token: '[UNK]',
};

/** The inputs this encoder can feed. */
const FEEDABLE = new Set(['input_ids', 'attention_mask', 'token_type_ids']);

/** ONNX Runtime's log level for errors only. */
const ERRORS_ONLY = 3;

/** `ids`, cut to {@link MAX_TOKENS} with its last token, [SEP], kept at the end. */
function capped(ids: readonly number[]): readonly number[] {
  if (ids.length <= MAX_TOKENS) return ids;
  return [...ids.slice(0, MAX_TOKENS - 1), ...ids.slice(-1)];
}

/** The batch's token ids and mask, each padded with 0 to its longest sentence. */
function batchOf(tokenizer: Tokenizer, sentences: readonly string[]) {
  const encoded = sentences.map((sentence) => capped(tokenizer.encode(sentence).ids));
  const tokens = Math.max(1, ...encoded.map((ids) => ids.length));
  const ids = new BigInt64Array(sentences.length * tokens);
  const mask = new Uint8Array(sentences.length * tokens);
  encoded.forEach((sentence, s) => {
    sentence.forEach((id, i) => {
      ids[s * tokens + i] = BigInt(id);
      mask[s * tokens + i] = 1;
    });
  });
  return { ids, mask, tokens };
}

/** The tensor for input `name`, from one batch of `sentences`. */
function feedFor(
  name: string,
  batch: { ids: BigInt64Array; mask: Uint8Array; tokens: number },
  sentences: number,
): Tensor {
  const dims = [sentences, batch.tokens];
  if (name === 'attention_mask') {
    return new Tensor('int64', BigInt64Array.from(batch.mask, BigInt), dims);
  }
  if (name === 'token_type_ids')
    return new Tensor('int64', new BigInt64Array(batch.ids.length), dims);
  return new Tensor('int64', batch.ids, dims);
}

/**
 * Starts the model from its checked files: one session, on WebAssembly, on
 * this thread.
 *
 * @throws {Error} when the model asks for an input this encoder can't feed.
 */
export async function startEncoder(files: RuntimeFiles): Promise<Encoder> {
  env.wasm.wasmBinary = files.runtime;
  env.wasm.numThreads = 1;
  env.wasm.proxy = false;
  env.logLevel = 'error';
  const tokenizer = new Tokenizer(
    JSON.parse(new TextDecoder().decode(files.tokenizer)) as object,
    TOKENIZER_CONFIG,
  );
  const session = await InferenceSession.create(files.model, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    logSeverityLevel: ERRORS_ONLY,
  });
  const unfed = session.inputNames.filter((name) => !FEEDABLE.has(name));
  if (unfed.length > 0) {
    await session.release();
    throw new Error(`The model asks for an input the encoder can’t feed: ${unfed.join(', ')}.`);
  }
  const output = session.outputNames[0] ?? 'last_hidden_state';
  return {
    encode: async (sentences) => {
      const batch = batchOf(tokenizer, sentences);
      const feeds = Object.fromEntries(
        session.inputNames.map((name) => [name, feedFor(name, batch, sentences.length)]),
      );
      const results = await session.run(feeds);
      const states = results[output];
      const dimensions = states?.dims[2] ?? 0;
      return {
        data: states?.data as Float32Array,
        mask: batch.mask,
        sentences: sentences.length,
        tokens: batch.tokens,
        dimensions,
      };
    },
  };
}
