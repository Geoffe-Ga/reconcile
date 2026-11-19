/**
 * The model runtime (#476; ADR-0080 §2): ONNX Runtime Web's plain
 * WebAssembly build and Hugging Face's WordPiece tokenizer, both pinned
 * exactly. This is the only module that imports either (dependency-cruiser's
 * `only-runtime-ts-imports-the-runtime`), so swapping the runtime touches one
 * file.
 *
 * It runs the embedding model (`startEncoder`, #476) and, for the stance
 * check, a sentence-pair classifier (`startPairClassifier`, #478); and, for
 * the steward's console alone, a one-text, multi-label classifier
 * (`startTextClassifier`, #493; ADR-0082), which `src/shelf/classify.ts`
 * loads only when the shelf classifier is switched on. It fetches nothing. It is handed each model's three files, already checked against
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

/** A started session and its tokenizer, from the model's checked files. */
interface Opened {
  readonly session: InferenceSession;
  readonly tokenizer: Tokenizer;
}

/**
 * Opens the model from its checked files: one session, on WebAssembly, on
 * this thread.
 *
 * @throws {Error} when the model asks for an input this runtime can't feed.
 */
async function open(files: RuntimeFiles): Promise<Opened> {
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
  return { session, tokenizer };
}

/**
 * Starts the model from its checked files: one session, on WebAssembly, on
 * this thread.
 *
 * @throws {Error} when the model asks for an input this encoder can't feed.
 */
export async function startEncoder(files: RuntimeFiles): Promise<Encoder> {
  const { session, tokenizer } = await open(files);
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

/** A started sentence-pair classifier: a premise and a hypothesis in, one probability per label out. */
export interface PairClassifier {
  classify(premise: string, hypothesis: string): Promise<Float32Array>;
}

/** `sentence`'s token ids without [CLS] or [SEP], at most {@link MAX_TOKENS} − 2 of them. */
function idsOf(tokenizer: Tokenizer, sentence: string): number[] {
  return tokenizer.encode(sentence, { add_special_tokens: false }).ids.slice(0, MAX_TOKENS - 2);
}

/**
 * The pair's tensors: `[CLS] premise [SEP] hypothesis [SEP]`, the
 * hypothesis and its [SEP] as the second token type (the [CLS] and [SEP] the
 * tokenizer wraps an empty sentence in), each sentence cut to
 * {@link MAX_TOKENS} − 2 tokens so the pair fits a BERT model's 512 positions.
 */
function pairFeeds(
  tokenizer: Tokenizer,
  names: readonly string[],
  premise: string,
  hypothesis: string,
): Record<string, Tensor> {
  const wrapper = tokenizer.encode('').ids;
  const [cls, sep] = [wrapper.slice(0, 1), wrapper.slice(1)];
  const first = [...cls, ...idsOf(tokenizer, premise), ...sep];
  const second = [...idsOf(tokenizer, hypothesis), ...sep];
  const ids = [...first, ...second];
  const values: Record<string, readonly number[]> = {
    input_ids: ids,
    attention_mask: ids.map(() => 1),
    token_type_ids: [...first.map(() => 0), ...second.map(() => 1)],
  };
  const dims = [1, ids.length];
  return Object.fromEntries(
    names.map((name) => [
      name,
      new Tensor('int64', BigInt64Array.from(values[name] ?? [], BigInt), dims),
    ]),
  );
}

/** `logits` turned into probabilities that add up to 1. */
function softmax(logits: ArrayLike<number>): Float32Array {
  const values = Array.from(logits);
  const top = Math.max(...values);
  const exps = values.map((x) => Math.exp(x - top));
  const total = exps.reduce((sum, x) => sum + x, 0);
  return Float32Array.from(exps, (x) => x / total);
}

/**
 * Starts a sentence-pair classifier, such as a natural-language-inference
 * model (#478), from its checked files: one session, on WebAssembly, on this
 * thread. It reads one pair per run, as the embedder reads one sentence
 * (#477): an 8-bit model's answer would otherwise shift with its neighbours.
 *
 * @throws {Error} when the model asks for an input this runtime can't feed.
 */
export async function startPairClassifier(files: RuntimeFiles): Promise<PairClassifier> {
  const { session, tokenizer } = await open(files);
  const output = session.outputNames[0] ?? 'logits';
  return {
    classify: async (premise, hypothesis) => {
      const feeds = pairFeeds(tokenizer, session.inputNames, premise, hypothesis);
      const results = await session.run(feeds);
      return softmax((results[output]?.data ?? []) as Float32Array);
    },
  };
}

/** A started one-text classifier: a text in, each label's own probability out. */
export interface TextClassifier {
  scores(text: string): Promise<Float32Array>;
}

/** Each of `logits` on its own through the logistic function, as a multi-label model is read. */
function sigmoid(logits: ArrayLike<number>): Float32Array {
  return Float32Array.from(Array.from(logits), (x) => 1 / (1 + Math.exp(-x)));
}

/**
 * Starts a one-text, multi-label classifier, such as the shelf classifier's
 * toxicity model (#493; ADR-0082), from its checked files: one session, on
 * WebAssembly, on this thread. It reads `[CLS] text [SEP]`, cut to
 * {@link MAX_TOKENS} tokens, one text per run, and answers each label's
 * probability on its own, since a text may carry several labels or none.
 *
 * @throws {Error} when the model asks for an input this runtime can't feed.
 */
export async function startTextClassifier(files: RuntimeFiles): Promise<TextClassifier> {
  const { session, tokenizer } = await open(files);
  const output = session.outputNames[0] ?? 'logits';
  return {
    scores: async (text) => {
      const batch = batchOf(tokenizer, [text]);
      const feeds = Object.fromEntries(
        session.inputNames.map((name) => [name, feedFor(name, batch, 1)]),
      );
      const results = await session.run(feeds);
      return sigmoid((results[output]?.data ?? []) as Float32Array);
    },
  };
}
