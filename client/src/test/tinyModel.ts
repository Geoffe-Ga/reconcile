/**
 * A tiny stand-in for the Bedfellows model's files (#476), so unit tests and
 * the e2e specs run the real runtime with no download: a WordPiece tokenizer
 * of a few dozen words in the real one's format, and an ONNX graph that looks
 * up an 8-number vector for each token, with the real model's inputs and
 * output. Its vectors mean nothing; what it proves is that the files load,
 * verify and run under the deploy CSP.
 *
 * The ONNX file is written here, field by field, from `onnx.proto`'s field
 * numbers, rather than kept as a binary in git. The runtime's WebAssembly is
 * the real one, from the npm package (`ortWasm.ts`). It imports nothing, so
 * the e2e specs use it too.
 */

/** The vocabulary, in id order. The first five are BERT's special tokens. */
export const TINY_VOCAB: readonly string[] = [
  '[PAD]',
  '[UNK]',
  '[CLS]',
  '[SEP]',
  '[MASK]',
  '.',
  ',',
  'keep',
  'the',
  'reading',
  'room',
  'open',
  'we',
  'want',
  'library',
  'to',
  'stay',
  'our',
  'chess',
  'club',
  'needs',
  'new',
  'board',
  '##s',
];

/** Each token's vector size. */
export const TINY_DIMENSIONS = 8;

/** A special token as `tokenizer.json` lists it. */
function special(content: string, id: number) {
  return {
    id,
    content,
    single_word: false,
    lstrip: false,
    rstrip: false,
    normalized: false,
    special: true,
  };
}

/** The tokenizer, in the format of the real model's `tokenizer.json` (BERT, uncased). */
export function tinyTokenizerJson(): string {
  const vocab = Object.fromEntries(TINY_VOCAB.map((token, id) => [token, id]));
  const specials = TINY_VOCAB.slice(0, 5).map((token, id) => special(token, id));
  return JSON.stringify({
    version: '1.0',
    truncation: null,
    padding: null,
    added_tokens: specials,
    normalizer: {
      type: 'BertNormalizer',
      clean_text: true,
      handle_chinese_chars: true,
      strip_accents: null,
      lowercase: true,
    },
    pre_tokenizer: { type: 'BertPreTokenizer' },
    post_processor: {
      type: 'TemplateProcessing',
      single: [
        { SpecialToken: { id: '[CLS]', type_id: 0 } },
        { Sequence: { id: 'A', type_id: 0 } },
        { SpecialToken: { id: '[SEP]', type_id: 0 } },
      ],
      pair: [],
      special_tokens: {
        '[CLS]': { id: '[CLS]', ids: [2], tokens: ['[CLS]'] },
        '[SEP]': { id: '[SEP]', ids: [3], tokens: ['[SEP]'] },
      },
    },
    decoder: { type: 'WordPiece', prefix: '##', cleanup: true },
    model: {
      type: 'WordPiece',
      unk_token: '[UNK]',
      continuing_subword_prefix: '##',
      max_input_chars_per_word: 100,
      vocab,
    },
  });
}

/** Token `id`'s vector in the tiny model: small whole numbers, different for every token. */
export function tinyVectorOf(id: number): number[] {
  return Array.from({ length: TINY_DIMENSIONS }, (_, d) => ((id * 7 + d * 3) % 11) - 5);
}

/** `n` as a protobuf varint. */
function varint(n: number): number[] {
  const out: number[] = [];
  let rest = n;
  do {
    const low = rest % 128;
    rest = Math.floor(rest / 128);
    out.push(rest > 0 ? low + 128 : low);
  } while (rest > 0);
  return out;
}

/** A varint field. */
function int(field: number, value: number): number[] {
  return [...varint(field * 8), ...varint(value)];
}

/** A length-delimited field. */
function bytes(field: number, value: readonly number[]): number[] {
  return [...varint(field * 8 + 2), ...varint(value.length), ...value];
}

/** A string field. */
function text(field: number, value: string): number[] {
  return bytes(field, [...new TextEncoder().encode(value)]);
}

/** ONNX's element types. */
const FLOAT = 1;
const INT64 = 7;

/** A `ValueInfoProto`: a tensor's name, element type and shape, each dimension a size or a name. */
function valueInfo(name: string, type: number, shape: readonly (number | string)[]): number[] {
  const dims = shape.flatMap((dim) =>
    bytes(1, typeof dim === 'number' ? int(1, dim) : text(2, dim)),
  );
  return [...text(1, name), ...bytes(2, bytes(1, [...int(1, type), ...bytes(2, dims)]))];
}

/** The real model's inputs, in its order. */
const INPUTS = ['input_ids', 'attention_mask', 'token_type_ids'];

/**
 * The tiny model: `last_hidden_state = Gather(table, input_ids)`, with the real
 * model's three inputs (`attention_mask` and `token_type_ids` unused), or
 * `inputs` after `input_ids` instead, and its output, at opset 13.
 */
export function tinyModelOnnx(inputs: readonly string[] = INPUTS.slice(1)): Uint8Array {
  const table = new Float32Array(TINY_VOCAB.flatMap((_, id) => tinyVectorOf(id)));
  const tensor = [
    ...int(1, TINY_VOCAB.length),
    ...int(1, TINY_DIMENSIONS),
    ...int(2, FLOAT),
    ...text(8, 'table'),
    ...bytes(9, [...new Uint8Array(table.buffer)]),
  ];
  const node = [
    ...text(1, 'table'),
    ...text(1, 'input_ids'),
    ...text(2, 'last_hidden_state'),
    ...text(4, 'Gather'),
  ];
  const tokens = ['batch', 'sequence'];
  const graph = [
    ...bytes(1, node),
    ...text(2, 'tiny'),
    ...bytes(5, tensor),
    ...['input_ids', ...inputs].flatMap((name) => bytes(11, valueInfo(name, INT64, tokens))),
    ...bytes(12, valueInfo('last_hidden_state', FLOAT, [...tokens, TINY_DIMENSIONS])),
  ];
  const opset = [...text(1, ''), ...int(2, 13)];
  return new Uint8Array([...int(1, 8), ...bytes(7, graph), ...bytes(8, opset)]);
}
