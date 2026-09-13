// Public, JSON-safe Stage5C board and opponent-branch input contract.
// Keep every rule identical to app/stage5c_contract.py.
(() => {
  "use strict";

  const MODE = "stage5c1-board-v1";
  // 5C-2A keeps every 5C-1 board rule and additionally samples the declared
  // binary probabilities per trial. Sampled outcomes are recorded, not applied.
  const BRANCH_SAMPLING_MODE = "stage5c2a-branch-sampling-v1";
  const MODES = [MODE, BRANCH_SAMPLING_MODE];
  const BRANCH_MODEL = "binary-probability-v1";
  const BRANCH_KEYS = ["removal", "burst"];
  const DEFAULT_OPPONENT = Object.freeze({
    life: 5, reserve: 4, trash: 0, count: 0,
    hand_count: 4, deck_count: 40, field: [], mirage: null, burst_set: false,
  });

  function normalize(value = null) {
    if (value === null || value === undefined || value === false) return null;
    if (value === true) value = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("stage5c must be an object, true, or null");
    }
    const unknown = Object.keys(value).filter((key) =>
      !["mode", "opponent", "branch_probabilities", "opponent_model",
        "resolved_branch_events"].includes(key));
    if (unknown.length) throw new Error(`unknown stage5c fields: ${unknown.sort().join(", ")}`);
    const mode = value.mode ?? MODE;
    if (!MODES.includes(mode)) throw new Error(`stage5c.mode must be one of ${MODES.join(", ")}`);
    if ((value.opponent_model ?? BRANCH_MODEL) !== BRANCH_MODEL) {
      throw new Error(`stage5c.opponent_model must be ${BRANCH_MODEL}`);
    }
    if (JSON.stringify(value.resolved_branch_events ?? []) !== "[]") {
      throw new Error("stage5c.resolved_branch_events is an engine output and must be submitted empty");
    }

    const sourceOpponent = value.opponent ?? {};
    if (!sourceOpponent || typeof sourceOpponent !== "object" || Array.isArray(sourceOpponent)) {
      throw new Error("stage5c.opponent must be an object");
    }
    const unknownOpponent = Object.keys(sourceOpponent).filter((key) =>
      !Object.hasOwn(DEFAULT_OPPONENT, key));
    if (unknownOpponent.length) {
      throw new Error(`unknown stage5c.opponent fields: ${unknownOpponent.sort().join(", ")}`);
    }
    const opponent = structuredClone({ ...DEFAULT_OPPONENT, ...sourceOpponent });
    for (const key of ["life", "reserve", "trash", "count", "hand_count", "deck_count"]) {
      if (!Number.isInteger(opponent[key]) || opponent[key] < 0 || opponent[key] > 200) {
        throw new Error(`stage5c.opponent.${key} must be an integer between 0 and 200`);
      }
    }
    if (!Array.isArray(opponent.field) || opponent.field.length) {
      throw new Error("stage5c.opponent.field is reserved for a later 5C-2 unit and must be empty");
    }
    if (opponent.mirage !== null) {
      throw new Error("stage5c.opponent.mirage is reserved for a later 5C-2 unit and must be null");
    }
    if (typeof opponent.burst_set !== "boolean") {
      throw new Error("stage5c.opponent.burst_set must be boolean");
    }

    const sourceProbabilities = value.branch_probabilities ?? {};
    if (!sourceProbabilities || typeof sourceProbabilities !== "object"
        || Array.isArray(sourceProbabilities)) {
      throw new Error("stage5c.branch_probabilities must be an object");
    }
    const unknownProbabilities = Object.keys(sourceProbabilities).filter((key) =>
      !BRANCH_KEYS.includes(key));
    if (unknownProbabilities.length) {
      throw new Error(`unknown stage5c branch probabilities: ${unknownProbabilities.sort().join(", ")}`);
    }
    const branchProbabilities = {};
    for (const key of BRANCH_KEYS) {
      const probability = sourceProbabilities[key] ?? 0;
      if (typeof probability !== "number" || !Number.isFinite(probability)
          || probability < 0 || probability > 1) {
        throw new Error(`stage5c.branch_probabilities.${key} must be between 0 and 1`);
      }
      branchProbabilities[key] = probability;
    }
    if (mode === BRANCH_SAMPLING_MODE && branchProbabilities.burst > 0 && !opponent.burst_set) {
      // A burst can only fire from a set card. Sampling one anyway would be
      // the implicit opponent default this stage is required not to invent.
      throw new Error(
        "stage5c.branch_probabilities.burst requires stage5c.opponent.burst_set");
    }
    return {
      mode, opponent_model: BRANCH_MODEL, opponent,
      branch_probabilities: branchProbabilities, resolved_branch_events: [],
    };
  }

  globalThis.Stage5CContract = { MODE, BRANCH_SAMPLING_MODE, MODES, BRANCH_MODEL, normalize };
})();

// Stage6A-0 two-deck match contract. This validates inputs only; combat,
// reaction windows and burst policy remain explicitly unavailable.
(() => {
  "use strict";

  const FORMAT = "BattleSpiritsDB.stage6-match";
  const FORMAT_VERSION = 1;
  const MODE = "stage6a0-match-contract-v1";
  const PLAYER_IDS = ["self", "opponent"];
  const INITIAL_HAND_SIZE = 4;
  const MAX_SAFE_SEED = Number.MAX_SAFE_INTEGER;
  const DECISION_MODEL = Object.freeze({
    observation: "rules-visible-v1",
    policy: "deterministic-score-v1",
    lookahead: "current-window-v1",
    windows: Object.freeze({
      main_action: "stage4-v56-reuse",
      attack_declare: "reserved",
      block_declare: "reserved",
      life_damage: "reserved",
      destruction: "reserved",
      vanish: "reserved",
      burst: "reserved",
    }),
  });
  const CAPABILITIES = Object.freeze({
    contract_validation: true,
    dual_deck_inputs: true,
    fixed_opening_hands: true,
    representative_search_inputs: true,
    dual_deck_execution: false,
    combat: false,
    reaction_windows: false,
    burst_policy: false,
    victory: false,
  });

  function stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }

  async function sha256Hex(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function exactKeys(value, expected, name) {
    if (!isObject(value)) throw new Error(`${name} must be an object`);
    const actual = Object.keys(value);
    const unknown = actual.filter((key) => !expected.includes(key)).sort();
    const missing = expected.filter((key) => !Object.hasOwn(value, key)).sort();
    if (unknown.length) throw new Error(`unknown ${name} fields: ${unknown.join(", ")}`);
    if (missing.length) throw new Error(`missing ${name} fields: ${missing.join(", ")}`);
  }

  function fingerprint(value, name) {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
      throw new Error(`${name} must be a lowercase SHA-256 fingerprint`);
    }
  }

  function normalizeDeck(deck, name) {
    exactKeys(deck, ["cards", "total_cards", "contract_card_no"], name);
    if (!Array.isArray(deck.cards) || !deck.cards.length) {
      throw new Error(`${name}.cards must be a non-empty array`);
    }
    const counts = new Map();
    for (const entry of deck.cards) {
      exactKeys(entry, ["card_no", "quantity"], `${name}.cards entry`);
      if (typeof entry.card_no !== "string" || !entry.card_no.trim()
          || !Number.isInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > 99) {
        throw new Error(`invalid ${name}.cards entry`);
      }
      const cardNo = entry.card_no.trim();
      if (counts.has(cardNo)) throw new Error(`duplicate ${name} card_no: ${cardNo}`);
      counts.set(cardNo, entry.quantity);
    }
    const total = [...counts.values()].reduce((sum, quantity) => sum + quantity, 0);
    if (total > 200) throw new Error(`${name} must contain at most 200 cards`);
    if (deck.total_cards !== total) throw new Error(`${name}.total_cards does not match cards`);
    if (deck.contract_card_no !== null
        && (typeof deck.contract_card_no !== "string" || !counts.has(deck.contract_card_no))) {
      throw new Error(`${name}.contract_card_no must be null or a card in the deck`);
    }
    return {
      deck: {
        cards: [...counts].sort(([left], [right]) => left.localeCompare(right, "en"))
          .map(([card_no, quantity]) => ({ card_no, quantity })),
        total_cards: total,
        contract_card_no: deck.contract_card_no,
      },
      counts,
    };
  }

  function normalizePlayerOptions(source, deck, playerId) {
    const value = source ?? {};
    if (!isObject(value)) throw new Error(`options.${playerId} must be an object`);
    const allowed = ["initial_hand", "consider_mulligan", "force_contract_turn1",
      "target_card_nos"];
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
    if (unknown.length) {
      throw new Error(`unknown options.${playerId} fields: ${unknown.join(", ")}`);
    }
    const counts = new Map(deck.cards.map((entry) => [entry.card_no, entry.quantity]));
    let initialHand = value.initial_hand ?? null;
    if (initialHand !== null) {
      if (!Array.isArray(initialHand)
          || initialHand.some((cardNo) => typeof cardNo !== "string" || !cardNo.trim())) {
        throw new Error(`options.${playerId}.initial_hand must be null or an array`);
      }
      initialHand = initialHand.map((cardNo) => cardNo.trim());
      const requested = new Map();
      for (const cardNo of initialHand) requested.set(cardNo, (requested.get(cardNo) || 0) + 1);
      if (initialHand.length > INITIAL_HAND_SIZE
          || [...requested].some(([cardNo, count]) => count > (counts.get(cardNo) || 0))) {
        throw new Error(`options.${playerId}.initial_hand is not a legal exact hand`);
      }
    }
    const considerMulligan = value.consider_mulligan ?? false;
    const forceContract = value.force_contract_turn1 ?? false;
    if (typeof considerMulligan !== "boolean" || typeof forceContract !== "boolean") {
      throw new Error(`options.${playerId} mulligan and force-contract flags must be boolean`);
    }
    if (forceContract && initialHand !== null
        && !initialHand.includes(deck.contract_card_no)) {
      throw new Error(`options.${playerId}.initial_hand must include the Contract card `
        + "when force_contract_turn1 is enabled");
    }
    const targetSource = value.target_card_nos ?? [];
    if (!Array.isArray(targetSource)
        || targetSource.some((cardNo) => typeof cardNo !== "string" || !cardNo.trim())) {
      throw new Error(`options.${playerId}.target_card_nos must be an array`);
    }
    const targets = [...new Set(targetSource.map((cardNo) => cardNo.trim()))]
      .sort((left, right) => left.localeCompare(right, "en"));
    const outside = targets.filter((cardNo) => !counts.has(cardNo));
    if (outside.length) {
      throw new Error(`options.${playerId}.target cards are not in the deck: ${outside.join(", ")}`);
    }
    return {
      opening: { mode: initialHand === null ? "natural" : "fixed-exact", initial_hand: initialHand },
      options: {
        consider_mulligan: considerMulligan,
        force_contract_turn1: forceContract,
        target_card_nos: targets,
      },
    };
  }

  function integerOption(options, name, defaultValue, minimum, maximum) {
    const value = options[name] ?? defaultValue;
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`options.${name} must be between ${minimum} and ${maximum}`);
    }
    return value;
  }

  async function build(selfPacket, opponentPacket, sourceOptions = {}) {
    const options = sourceOptions ?? {};
    if (!isObject(options)) throw new Error("options must be an object");
    const allowed = ["first_player", "max_rounds", "trials", "seed", ...PLAYER_IDS];
    const unknown = Object.keys(options).filter((key) => !allowed.includes(key)).sort();
    if (unknown.length) throw new Error(`unknown Stage6 options: ${unknown.join(", ")}`);
    await Stage5PortableEngine.validatePacket(selfPacket);
    await Stage5PortableEngine.validatePacket(opponentPacket);
    const packetRows = { self: selfPacket, opponent: opponentPacket };
    if (stableStringify(selfPacket.catalog) !== stableStringify(opponentPacket.catalog)) {
      throw new Error("both Stage6 players must use the same portable catalog");
    }
    const firstPlayer = options.first_player ?? "self";
    if (!PLAYER_IDS.includes(firstPlayer)) {
      throw new Error("options.first_player must be self or opponent");
    }
    const players = PLAYER_IDS.map((playerId) => {
      const packet = packetRows[playerId];
      const { deck } = normalizeDeck(packet.deck, `${playerId}_packet.deck`);
      return {
        player_id: playerId,
        engine_packet_fingerprint: packet.fingerprint,
        deck,
        ...normalizePlayerOptions(options[playerId], deck, playerId),
      };
    });
    const basis = {
      format: FORMAT,
      format_version: FORMAT_VERSION,
      mode: MODE,
      stage4_version: Stage5PortableEngine.STAGE_VERSION,
      engine_slice: Stage5PortableEngine.ENGINE_SLICE,
      catalog: structuredClone(selfPacket.catalog),
      first_player: firstPlayer,
      // 上限40(2026-08-23に30から拡張)。デッキ切れ敗北を確実に踏ませるため
      // ——40枚デッキは1ターン1ドローでも37ターン目に負ける。Python同一。
      max_rounds: integerOption(options, "max_rounds", 5, 1, 40),
      trials: integerOption(options, "trials", 500, 4, 20000),
      seed: integerOption(options, "seed", 12345, 0, MAX_SAFE_SEED),
      players,
      decision_model: structuredClone(DECISION_MODEL),
      capabilities: structuredClone(CAPABILITIES),
    };
    return { ...basis, fingerprint: await sha256Hex(stableStringify(basis)) };
  }

  async function validate(value) {
    const topKeys = ["format", "format_version", "mode", "stage4_version", "engine_slice",
      "catalog", "first_player", "max_rounds", "trials", "seed", "players",
      "decision_model", "capabilities", "fingerprint"];
    exactKeys(value, topKeys, "Stage6 match");
    if (value.format !== FORMAT || value.format_version !== FORMAT_VERSION || value.mode !== MODE
        || value.stage4_version !== Stage5PortableEngine.STAGE_VERSION
        || value.engine_slice !== Stage5PortableEngine.ENGINE_SLICE) {
      throw new Error("unsupported Stage6 match contract");
    }
    exactKeys(value.catalog, ["schema_version", "fingerprint"], "Stage6 catalog");
    if (!Number.isInteger(value.catalog.schema_version) || value.catalog.schema_version < 1) {
      throw new Error("Stage6 catalog.schema_version must be a positive integer");
    }
    fingerprint(value.catalog.fingerprint, "Stage6 catalog.fingerprint");
    if (!PLAYER_IDS.includes(value.first_player)) {
      throw new Error("Stage6 first_player must be self or opponent");
    }
    for (const [name, minimum, maximum] of [
      ["max_rounds", 1, 40], ["trials", 4, 20000], ["seed", 0, MAX_SAFE_SEED]]) {
      if (!Number.isSafeInteger(value[name]) || value[name] < minimum || value[name] > maximum) {
        throw new Error(`Stage6 ${name} must be between ${minimum} and ${maximum}`);
      }
    }
    if (stableStringify(value.decision_model) !== stableStringify(DECISION_MODEL)) {
      throw new Error("Stage6 decision_model is not the A-0 model");
    }
    if (stableStringify(value.capabilities) !== stableStringify(CAPABILITIES)) {
      throw new Error("Stage6 capabilities must not claim unimplemented execution");
    }
    if (!Array.isArray(value.players) || value.players.length !== PLAYER_IDS.length
        || value.players.some((player, index) => player?.player_id !== PLAYER_IDS[index])) {
      throw new Error("Stage6 players must be self then opponent");
    }
    for (const [index, playerId] of PLAYER_IDS.entries()) {
      const player = value.players[index];
      exactKeys(player, ["player_id", "engine_packet_fingerprint", "deck", "opening", "options"],
        `Stage6 players.${playerId}`);
      fingerprint(player.engine_packet_fingerprint,
        `Stage6 players.${playerId}.engine_packet_fingerprint`);
      const { deck } = normalizeDeck(player.deck, `Stage6 players.${playerId}.deck`);
      const normalized = normalizePlayerOptions({
        initial_hand: isObject(player.opening) ? player.opening.initial_hand : null,
        ...(isObject(player.options) ? player.options : {}),
      }, deck, playerId);
      if (stableStringify(player.deck) !== stableStringify(deck)
          || stableStringify(player.opening) !== stableStringify(normalized.opening)
          || stableStringify(player.options) !== stableStringify(normalized.options)) {
        throw new Error(`Stage6 players.${playerId} is not canonical`);
      }
    }
    fingerprint(value.fingerprint, "Stage6 fingerprint");
    const { fingerprint: ignored, ...basis } = value;
    if (await sha256Hex(stableStringify(basis)) !== value.fingerprint) {
      throw new Error("Stage6 match fingerprint does not match");
    }
    return value;
  }

  globalThis.Stage6MatchContract = {
    FORMAT, FORMAT_VERSION, MODE, DECISION_MODEL, CAPABILITIES, build, validate,
  };
})();

// Stage5 cross-language deterministic RNG. Keep byte-for-byte semantics in
// sync with app/stage5_portable_rng.py.
(() => {
  "use strict";

  const ALGORITHM = "xoshiro128ss-v1";
  const UINT32_RANGE = 0x100000000;
  const MAX_SAFE_SEED = Number.MAX_SAFE_INTEGER;

  function rotl32(value, shift) {
    return ((value << shift) | (value >>> (32 - shift))) >>> 0;
  }

  function mix32(value) {
    value >>>= 0;
    value ^= value >>> 16;
    value = Math.imul(value, 0x85ebca6b) >>> 0;
    value ^= value >>> 13;
    value = Math.imul(value, 0xc2b2ae35) >>> 0;
    value ^= value >>> 16;
    return value >>> 0;
  }

  function fnv1a32(label) {
    let digest = 0x811c9dc5;
    for (const character of String(label)) {
      const code = character.charCodeAt(0);
      if (code > 0x7f) throw new Error("stream labels must be ASCII");
      digest = (digest ^ code) >>> 0;
      digest = Math.imul(digest, 0x01000193) >>> 0;
    }
    return digest;
  }

  // Independent seed for one named stream of the same trial. Stage 5C-2A
  // samples opponent branches without disturbing the deck stream. Keep this
  // bit-for-bit identical to derive_stream_seed in stage5_portable_rng.py.
  function deriveStreamSeed(seed, label) {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > MAX_SAFE_SEED) {
      throw new Error(`seed must be an integer between 0 and ${MAX_SAFE_SEED}`);
    }
    const salt = fnv1a32(label);
    const low = (seed % UINT32_RANGE) >>> 0;
    const high = Math.floor(seed / UINT32_RANGE) >>> 0;
    return mix32((low ^ salt) >>> 0) * 0x200000
      + (mix32((high ^ rotl32(salt, 16)) >>> 0) & 0x1fffff);
  }

  class PortableRng {
    constructor(seed) {
      if (!Number.isSafeInteger(seed) || seed < 0 || seed > MAX_SAFE_SEED) {
        throw new Error(`seed must be an integer between 0 and ${MAX_SAFE_SEED}`);
      }
      const low = (seed % UINT32_RANGE) >>> 0;
      const high = Math.floor(seed / UINT32_RANGE) >>> 0;
      let value = (low ^ rotl32(high, 16) ^ 0x9e3779b9) >>> 0;
      this.state = [];
      for (let index = 0; index < 4; index += 1) {
        value = (value + 0x9e3779b9) >>> 0;
        this.state.push(mix32(value));
      }
      if (!this.state.some(Boolean)) this.state[0] = 0x6d2b79f5;
    }

    nextU32() {
      let [s0, s1, s2, s3] = this.state;
      const result = Math.imul(rotl32(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
      const temporary = (s1 << 9) >>> 0;
      s2 = (s2 ^ s0) >>> 0;
      s3 = (s3 ^ s1) >>> 0;
      s1 = (s1 ^ s2) >>> 0;
      s0 = (s0 ^ s3) >>> 0;
      s2 = (s2 ^ temporary) >>> 0;
      s3 = rotl32(s3, 11);
      this.state = [s0, s1, s2, s3];
      return result;
    }

    nextInt(bound) {
      if (!Number.isInteger(bound) || bound < 1 || bound > UINT32_RANGE) {
        throw new Error("bound must be an integer between 1 and 2**32");
      }
      const limit = Math.floor(UINT32_RANGE / bound) * bound;
      while (true) {
        const value = this.nextU32();
        if (value < limit) return value % bound;
      }
    }

    safeInteger() {
      const high = this.nextU32() & 0x1fffff;
      return high * UINT32_RANGE + this.nextU32();
    }

    shuffle(values) {
      for (let index = values.length - 1; index > 0; index -= 1) {
        const other = this.nextInt(index + 1);
        [values[index], values[other]] = [values[other], values[index]];
      }
      return values;
    }
  }

  function openingHand(deckCards, options) {
    const {
      seed, contract_card_no: contractCardNo = null,
      consider_mulligan: considerMulligan = false,
      initial_hand: initialHand = null, hand_size: handSize = 4,
    } = options || {};
    const deck = [...deckCards];
    new PortableRng(seed).shuffle(deck);
    const hand = [];
    if (initialHand !== null) {
      if (!Array.isArray(initialHand) || initialHand.length > handSize) {
        throw new Error("initial_hand is not a legal subset of this deck");
      }
      for (const cardNo of initialHand) {
        const index = deck.indexOf(cardNo);
        if (index < 0) throw new Error("initial_hand is not a legal subset of this deck");
        deck.splice(index, 1);
        hand.push(cardNo);
      }
    } else if (contractCardNo !== null && !considerMulligan) {
      const index = deck.indexOf(contractCardNo);
      if (index < 0) throw new Error("contract_card_no is not in this deck");
      deck.splice(index, 1);
      hand.push(contractCardNo);
      while (deck.length && hand.length < handSize) hand.push(deck.pop());
    } else {
      while (deck.length && hand.length < handSize) hand.push(deck.pop());
    }
    return {
      algorithm: ALGORITHM,
      seed,
      opening_hand: hand,
      deck_order: deck.reverse(),
    };
  }

  function evaluateGoldenSpec(spec) {
    const probe = new PortableRng(spec.seed);
    const result = openingHand(spec.deck_cards, spec);
    const shuffled = [...spec.deck_cards];
    new PortableRng(spec.seed).shuffle(shuffled);
    return {
      ...result,
      uint32: Array.from({ length: spec.probe_count ?? 8 }, () => probe.nextU32()),
      safe_integers: Array.from({ length: 3 }, () => probe.safeInteger()),
      shuffled,
      ...(spec.stream_labels ? {
        stream_seeds: Object.fromEntries(spec.stream_labels.map((label) =>
          [label, deriveStreamSeed(spec.seed, label)])),
      } : {}),
    };
  }

  globalThis.Stage5PortableRng = {
    ALGORITHM,
    PortableRng,
    deriveStreamSeed,
    evaluateGoldenSpec,
    fnv1a32,
    openingHand,
  };
})();

// First Stage5 5B engine slice: public card loading, canonical engine packets,
// and deterministic opening hands. Full Stage4 resolution remains on the PC.
(() => {
  "use strict";

  const PACKET_FORMAT = "BattleSpiritsDB.stage4-engine-packet";
  const PACKET_FORMAT_VERSION = 1;
  const ENGINE_SLICE = "stage4-v56-v1";
  const STAGE_VERSION = "v56";
  const MAX_DECK_CARDS = 200;

  async function sha256Hex(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function normalizeDeckEntries(entries) {
    if (!Array.isArray(entries) || !entries.length) {
      throw new Error("deck entries must be a non-empty array");
    }
    const counts = new Map();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)
          || Object.keys(entry).sort().join(",") !== "card_no,quantity"
          || typeof entry.card_no !== "string" || !entry.card_no.trim()
          || !Number.isInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > 99) {
        throw new Error("each deck entry must contain valid card_no and quantity");
      }
      const cardNo = entry.card_no.trim();
      if (counts.has(cardNo)) throw new Error(`duplicate card_no: ${cardNo}`);
      counts.set(cardNo, entry.quantity);
    }
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
    if (total > MAX_DECK_CARDS) {
      throw new Error(`deck must contain at most ${MAX_DECK_CARDS} cards`);
    }
    return {
      entries: [...counts].sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([card_no, quantity]) => ({ card_no, quantity })),
      total,
    };
  }

  async function buildEnginePacket(catalogCards, deckEntries, catalogMeta) {
    const normalized = normalizeDeckEntries(deckEntries);
    if (!catalogMeta || !Number.isInteger(catalogMeta.schema_version)
        || !/^[0-9a-f]{64}$/.test(catalogMeta.fingerprint || "")) {
      throw new Error("portable catalog metadata is invalid");
    }
    const byNo = new Map(catalogCards.map((card) => [card.card_no, card]));
    const missing = normalized.entries
      .map((entry) => entry.card_no).filter((cardNo) => !byNo.has(cardNo));
    if (missing.length) throw new Error(`catalog is missing cards: ${missing.join(", ")}`);
    const deckDefinitions = normalized.entries.map((entry) => byNo.get(entry.card_no));
    for (const card of deckDefinitions) {
      if (card.is_token || card.transform_side === "裏") {
        throw new Error(`card cannot be put in a deck: ${card.card_no}`);
      }
    }
    const dependencyNos = deckDefinitions.some((card) =>
      (card.stage4?.enablers || []).some((effect) => effect.kind === "token_spawn"))
      ? ["BS76-T001"] : [];
    const missingDependencies = dependencyNos.filter((cardNo) => !byNo.has(cardNo));
    if (missingDependencies.length) {
      throw new Error(`catalog is missing engine dependencies: ${missingDependencies.join(", ")}`);
    }
    const definitions = [...deckDefinitions,
      ...dependencyNos.filter((cardNo) => !normalized.entries.some((entry) => entry.card_no === cardNo))
        .map((cardNo) => byNo.get(cardNo))]
      .sort((left, right) => left.card_no.localeCompare(right.card_no, "en"));
    const contracts = deckDefinitions.filter((card) => card.is_contract_card)
      .map((card) => card.card_no).sort((left, right) => left.localeCompare(right, "en"));
    const basis = {
      format: PACKET_FORMAT,
      format_version: PACKET_FORMAT_VERSION,
      stage_version: STAGE_VERSION,
      engine_slice: ENGINE_SLICE,
      rng: {
        algorithm: Stage5PortableRng.ALGORITHM,
        seed_format: "javascript-safe-integer",
        shuffle: "fisher-yates-descending-v1",
      },
      catalog: {
        schema_version: catalogMeta.schema_version,
        fingerprint: catalogMeta.fingerprint,
      },
      deck: {
        cards: normalized.entries,
        total_cards: normalized.total,
        contract_card_no: contracts[0] || null,
      },
      definitions,
      capabilities: {
        opening_hand: true,
        card_loading: true,
        compiled_card_ir: true,
        portable_core_subset: true,
        payment: true,
        candidate_generation: true,
        effect_resolution: true,
        aggregation: true,
        representative_traces: true,
        full_simulation: true,
      },
    };
    const fingerprint = await sha256Hex(Stage5PortableStore.stableStringify(basis));
    return { ...basis, fingerprint };
  }

  async function validatePacket(packet) {
    if (!packet || packet.format !== PACKET_FORMAT
        || packet.format_version !== PACKET_FORMAT_VERSION
        || packet.stage_version !== STAGE_VERSION
        || packet.engine_slice !== ENGINE_SLICE) {
      throw new Error("unsupported Stage4 engine packet");
    }
    if (packet.rng?.algorithm !== Stage5PortableRng.ALGORITHM
        || !/^[0-9a-f]{64}$/.test(packet.fingerprint || "")) {
      throw new Error("Stage4 engine packet metadata is invalid");
    }
    const { fingerprint, ...basis } = packet;
    const actual = await sha256Hex(Stage5PortableStore.stableStringify(basis));
    if (actual !== fingerprint) throw new Error("engine packet fingerprint does not match");
    return packet;
  }

  async function runOpening(packet, options) {
    await validatePacket(packet);
    const deckCards = [];
    for (const entry of packet.deck.cards) {
      for (let count = 0; count < entry.quantity; count += 1) deckCards.push(entry.card_no);
    }
    return {
      packet_fingerprint: packet.fingerprint,
      engine_slice: ENGINE_SLICE,
      full_simulation: true,
      ...Stage5PortableRng.openingHand(deckCards, {
        ...options,
        contract_card_no: packet.deck.contract_card_no,
      }),
    };
  }

  function verifyGolden(fixture) {
    if (!fixture || fixture.format !== "BattleSpiritsDB.stage5b-golden"
        || fixture.format_version !== 1 || !Array.isArray(fixture.cases)) {
      throw new Error("Stage5 5B golden fixture is invalid");
    }
    const failures = [];
    for (const row of fixture.cases) {
      const actual = Stage5PortableRng.evaluateGoldenSpec(row.spec);
      if (Stage5PortableStore.stableStringify(actual)
          !== Stage5PortableStore.stableStringify(row.expected)) {
        failures.push(row.name);
      }
    }
    return { ok: failures.length === 0, cases: fixture.cases.length, failures };
  }

  globalThis.Stage5PortableEngine = {
    ENGINE_SLICE,
    PACKET_FORMAT,
    PACKET_FORMAT_VERSION,
    STAGE_VERSION,
    buildEnginePacket,
    runOpening,
    validatePacket,
    verifyGolden,
  };
})();

// Stage5 5B-2 portable Stage4 core. Card text is compiled by Python v56 into
// public JSON IR; this file executes that IR without database or network use.
(() => {
  "use strict";

  const RUNTIME_VERSION = "stage4-v56-portable-v6";
  // Python `stage4_sim._DEBUG` に対応する開発用トレース。Workerのスクリプト
  // URLへ `?lookahead_debug=1` を付けると、先読みのrankを`console.log`へ出す
  // ——Python側と同じ書式なので、乖離の突き合わせでそのまま並べられる。
  // 既定は無効で、通常の実行には一切影響しない。
  const DEBUG_LOOKAHEAD = typeof location !== "undefined"
    && new URLSearchParams(location.search || "").has("lookahead_debug");
  // Actual opponent boards contain functions and therefore must never enter a
  // structuredClone used by lookahead.  Only the live state is keyed here;
  // speculative clones intentionally have no opponent and cannot mutate it.
  const MAIN_STEP_OPPONENTS = new WeakMap();
  const BASIC_COLORS = ["赤", "紫", "緑", "白", "黄", "青"];
  const SUPPORTED_EFFECTS = new Set([
    "draw", "coreboost", "self_coreboost", "field_coreboost", "count_gain",
    "search", "recover", "self_recover", "side_recover", "stash_top",
    "oracle_mill", "oracle_pickup", "oracle_watch", "deck_discard_draw",
    "hand_filter", "core_to_trash", "life_core_move", "token_spawn",
    "creator_core_transfer", "driving_force",
    "exchange", "reveal_play_remainder", "face_up_top_cycle",
  ]);
  // Python `resolve_burst_effects`が実際に解ける語彙と同一。以前は資源系だけを
  // 列挙していたため、実行系には実装済みの相手盤面干渉でも共有HTMLが入口で拒否した。
  const SUPPORTED_BURST_EFFECTS = new Set([
    "draw", "coreboost", "core_to_trash", "field_coreboost", "count_gain",
    "burst_free_play_self", "burst_return_self_to_hand", "burst_pay_own_effect",
    "unit_destroy", "unit_exhaust", "unit_core_remove", "unit_bounce",
    "unit_heavy_exhaust", "unit_bp_down", "life_core_remove", "field_core_remove",
  ]);

  // Stage 5C-2A opponent branches. Keep every name and rule identical to the
  // matching constants in app/stage4_sim.py.
  const BRANCH_KEYS = ["removal", "burst"];
  const BRANCH_STREAM_LABELS = {
    removal: "stage5c2a-branch:removal",
    burst: "stage5c2a-branch:burst",
  };
  const BRANCH_WINDOWS = {
    removal: "preceding_opponent_turn",
    burst: "own_turn",
  };
  const BRANCH_UINT32_RANGE = 0x100000000;

  // Integer comparison keeps Python and JavaScript identical: multiplying an
  // IEEE-754 double by 2**32 is exact, so both languages floor the same value.
  function branchThreshold(probability) {
    return Math.floor(probability * BRANCH_UINT32_RANGE);
  }

  function clone(value) {
    return structuredClone(value);
  }

  function counterAdd(counter, source, factor = 1) {
    for (const [key, value] of Object.entries(source || {})) {
      counter[key] = (counter[key] || 0) + value * factor;
      if (!counter[key]) delete counter[key];
    }
  }

  function median(values) {
    const rows = [...values].sort((a, b) => a - b);
    const middle = Math.floor(rows.length / 2);
    return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
  }

  function validateOptions(options) {
    const source = options || {};
    const integer = (name, fallback, minimum, maximum) => {
      const value = source[name] ?? fallback;
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
      }
      return value;
    };
    const initialHand = source.initial_hand ?? null;
    if (initialHand !== null && (!Array.isArray(initialHand) || initialHand.length > 4)) {
      throw new Error("initial_hand must be null or an array of at most four cards");
    }
    return {
      seed: integer("seed", 12345, 0, Number.MAX_SAFE_INTEGER),
      trials: integer("trials", 500, 4, 2000),
      turns: integer("turns", 3, 1, 30),
      going_first: source.going_first ?? true,
      consider_mulligan: source.consider_mulligan ?? false,
      force_contract_turn1: source.force_contract_turn1 ?? false,
      target_card_nos: [...new Set(source.target_card_nos || [])].sort(),
      initial_hand: initialHand === null ? null : [...initialHand],
      stage5c: Stage5CContract.normalize(source.stage5c ?? null),
    };
  }

  function assessPacket(packet) {
    const unsupported = [];
    for (const definition of packet.definitions || []) {
      const card = definition.stage4;
      if (!card || card.ir_version !== 1) {
        unsupported.push(`${definition.card_no}:compiled-ir`);
        continue;
      }
      for (const effect of card.burst_effects || []) {
        if (!SUPPORTED_BURST_EFFECTS.has(effect.kind)) {
          unsupported.push(`${definition.card_no}:burst-${effect.kind}`);
        }
      }
      for (const effect of card.enablers || []) {
        if (!SUPPORTED_EFFECTS.has(effect.kind)) {
          unsupported.push(`${definition.card_no}:${effect.kind}`);
        }
      }
    }
    return {
      ok: unsupported.length === 0,
      runtime_version: RUNTIME_VERSION,
      unsupported: [...new Set(unsupported)].sort(),
    };
  }

  function cardMatchesAlternative(card, alternative) {
    const lineages = new Set(card.lineages || []);
    const colors = new Set(card.colors || []);
    const keywords = new Set(card.keywords || []);
    // Python `normalize_card_name` と同じ正規化(半角＋全角スペースを落とす)。
    // 半角だけだと全角スペース入りの名前で片側だけ当たる。
    const name = normalizeCardName(card.name);
    const cardType = card.card_type || "";
    const hasAny = (actual, expected) => (expected || []).some((value) => actual.has(value));
    if (alternative.lineage_any && !hasAny(lineages, alternative.lineage_any)) return false;
    if (alternative.lineage_groups
        && !alternative.lineage_groups.every((group) => hasAny(lineages, group))) return false;
    if (alternative.color_any && !hasAny(colors, alternative.color_any)) return false;
    if (alternative.color_exact
        && (colors.size !== alternative.color_exact.length
          || !alternative.color_exact.every((value) => colors.has(value)))) return false;
    // 《煌臨》は《F契約煌臨》等の変種すべてを含む(Python `keyword_predicate_matches`)。
    // keywordsは変種名で入っているので、集合の積だけで見ると1枚も一致しない。
    const keywordMatches = (expected) => hasAny(keywords, expected)
      || ((expected || []).includes("煌臨")
        && [...keywords].some((held) => held.endsWith("煌臨")));
    if (alternative.keyword_any && !keywordMatches(alternative.keyword_any)) return false;
    if (alternative.card_type_any
        && !alternative.card_type_any.some((value) => cardType.includes(value))) return false;
    if (alternative.cost_min !== undefined && alternative.cost_min !== null
        && card.cost < alternative.cost_min) return false;
    if (alternative.cost_max !== undefined && alternative.cost_max !== null
        && card.cost > alternative.cost_max) return false;
    if (alternative.name_exact
        && name !== normalizeCardName(alternative.name_exact)) return false;
    const nameContains = alternative.name_contains_any || alternative.name_contains;
    if (nameContains
        && ![...nameContains].some((value) => name.includes(normalizeCardName(value)))) return false;
    if (alternative.exclude_name_contains
        && [...alternative.exclude_name_contains].some(
          (value) => name.includes(normalizeCardName(value)))) return false;
    return true;
  }

  // Python `matches_condition_slot` / `matches_basic_condition` の移植。
  //
  // **戻り値は三値**(true / false / null)。Python側が `None` を返すのは条件が
  // (None,None) のとき、つまり「無条件」ではなく**効果テキストの条件をローダーが
  // 取りこぼした**とき(例: CB08-057「オーズ」/「アンク」/「バース」を含む、
  // CB28-RV020「ドラット」/「ギドラ」— どちらも条件が消えている)。この「不明」を
  // Pythonは場所ごとに違う向きへ倒しており、両方を再現しないと乖離する:
  //   - `access_tier`  … `match is not False` で**楽観**(不明なら届くとみなす)
  //   - `pick_condition_slots` … 真偽値として**保守**(不明なら拾わず、
  //                              「先頭1枚」フォールバックへ落とす)
  // JSは以前どちらにも `true` を返していたので前者だけ偶然合い、後者で別の札を
  // 選んでいた。null(falsy)を返せば後者は自動で揃い、前者は `!== false` で拾う。
  // あわせて2点直す: 系統と名前が両方あるときは AND でなく **OR**、名前比較は
  // 半角に加えて**全角スペースも落とす**(`normalize_card_name`)。
  function normalizeCardName(value) {
    return String(value ?? "").replaceAll(" ", "").replaceAll("　", "");
  }

  function cardMatchesSlot(card, slot) {
    if (!card) return false;
    const alternatives = slot?.alternatives || [];
    if (alternatives.length) return alternatives.some((row) => cardMatchesAlternative(card, row));
    const groups = slot?.lineage_groups;
    if (groups && groups.length) {
      const lineages = new Set(card.lineages || []);
      return groups.every((group) => (group || []).some((value) => lineages.has(value)));
    }
    const condition = slot?.condition || [null, null];
    const lineages = condition[0] || [];
    const name = condition[1];
    if (!lineages.length && !name) return null;
    if (name && normalizeCardName(card.name) === normalizeCardName(name)) return true;
    return Boolean(lineages.length
      && lineages.some((value) => (card.lineages || []).includes(value)));
  }

  // Python `matches_basic_condition` そのもの(スロットではなく素の条件タプル用)。
  // 三値で返すのは `cardMatchesSlot` と同じ理由。
  function matchesCondition(condition, card) {
    const lineages = (condition || [])[0] || [];
    const name = (condition || [])[1];
    if (!lineages.length && !name) return null;
    if (name && normalizeCardName(card?.name) === normalizeCardName(name)) return true;
    return Boolean(lineages.length
      && lineages.some((value) => (card?.lineages || []).includes(value)));
  }

  // Python `choose_top_or_bottom` の移植。以前のJSは種別リスト・reveal有無・
  // 参照するフィールド(condition_slots か condition か)がPythonとどれも違い、
  // 残余を上に残すか下へ送るかが食い違っていた。Pythonの規約は:
  //   - 手札の enabler のうち reveal を持つ search/exchange/oracle_pickup だけを見る
  //   - その enabler の **condition**(condition_slotsではない)を使う
  //   - 条件が (None,None) なら即 top
  //   - 残余のどれかに合致、または「不明(null)」でも top(楽観)
  function chooseTopOrBottom(remaining, hand, cards) {
    if (!remaining.length) return "bottom";
    for (const cardNo of hand) {
      for (const enabler of cards[cardNo]?.enablers || []) {
        if (enabler.reveal === null || enabler.reveal === undefined) continue;
        if (!["search", "exchange", "oracle_pickup"].includes(enabler.kind)) continue;
        const condition = enabler.condition || [null, null];
        if (!(condition[0] || []).length && !condition[1]) return "top";
        for (const remainingNo of remaining) {
          const matched = matchesCondition(condition, cards[remainingNo]);
          if (matched || matched === null) return "top";
        }
      }
    }
    return "bottom";
  }

  function isEngine(card) {
    return Boolean((card?.enablers || []).length);
  }

  function accessTier(cardNo, cards, targets) {
    const card = cards[cardNo];
    if (!card) return 2;
    let best = 2;
    for (const effect of card.enablers || []) {
      if (effect.kind === "self_recover"
          || !["search", "recover", "oracle_pickup"].includes(effect.kind)) continue;
      const slots = effect.condition_slots || [{
        condition: effect.condition || [null, null], limit: effect.amount,
      }];
      for (const [otherNo, other] of Object.entries(cards)) {
        // Python `access_tier` は `any(match is not False)`。条件不明(null)は
        // 「届く」側へ倒す——ここを truthy 判定にすると、条件を取りこぼした
        // サーチ/回収カードが軒並みtier2に落ちてプレイ順が変わる。
        if (otherNo === cardNo
            || !slots.some((slot) => cardMatchesSlot(other, slot) !== false)) continue;
        if (targets.has(otherNo)) return 0;
        if (isEngine(other)) best = 1;
      }
    }
    return best;
  }

  /** 手札から捨てる札を選ぶ。Python `stage4_selection.choose_hand_discards` と同一。
   *
   *  **`access_tier`だけで並べてはいけない。** 残す優先度は4段で、狙い札(0)・
   *  エンジンへ届く札(1)・**タダで撃てる防御札**(2、`is_free_defense`)・それ以外(3)。
   *  捨てるのは段の高いものから、同じ段なら手札の後ろから。ここが`tier`だけを
   *  見ていたので、**tierが同じ2枚のどちらを捨てるかがPythonと食い違っていた**
   *  ——絶甲氷盾入りの掃検デッキで初めて表に出た(2026-08-21)。デッキが
   *  `is_free_defense`の札を1枚も持たない限り差が出ないので、それまでの
   *  「全一致」はこの経路を一度も踏んでいなかった。
   *
   *  `discardAll`は手札の**並び順そのまま**返す(段で並べ替えない)。捨てる集合は
   *  同じでも、トラッシュに積まれる順が変わると以降の回収がずれる。 */
  function chooseHandDiscards(state, cards, targets, amount, discardAll) {
    if (discardAll) return [...state.hand];
    const keepRank = (cardNo) => (targets.has(cardNo) ? 0
      : accessTier(cardNo, cards, targets) <= 1 ? 1
        : (cards[cardNo] || {}).is_free_defense ? 2 : 3);
    return state.hand
      .map((cardNo, index) => ({ cardNo, index, rank: keepRank(cardNo) }))
      .sort((left, right) => right.rank - left.rank || right.index - left.index)
      .slice(0, Math.max(0, amount))
      .map((row) => row.cardNo);
  }

  /** デッキの「場を離れるとき契約煌臨元になる」トークン。Python
   *  `contract_base_token_no`と同じで、カード番号をエンジンに書かないための解決口。 */
  function contractBaseTokenNo(cards) {
    for (const [cardNo, card] of Object.entries(cards || {})) {
      if (card.is_token && card.moves_to_contract_base) return cardNo;
    }
    return null;
  }

  /** デッキの契約フラッグネクサス。カード種別そのものが識別子。 */
  function contractFlagNexusNo(cards) {
    for (const [cardNo, card] of Object.entries(cards || {})) {
      if (card.card_type === "契約フラッグネクサス") return cardNo;
    }
    return null;
  }

  /** 契約煌臨元になると場/リザーブのコアで維持を賄える札。 */
  function fieldCoreKourinBaseNo(cards) {
    for (const [cardNo, card] of Object.entries(cards || {})) {
      if (card.f_kourin_cores_from_field) return cardNo;
    }
    return null;
  }

  function bugAuraActive(state) {
    return state.bugNo !== null && state.field.some((unit) => !unit.waiting
      && (unit.kourin_stack || []).includes(state.bugNo)
      && (unit.kourin_stack || []).length >= 6);
  }

  function bugFlagEligible(unit, cards) {
    const card = cards?.[unit.card_no];
    return (card?.lineages || []).includes("旗種")
      && (card.colors || []).length === 1 && card.colors[0] === "白";
  }

  /** その窓のあいだ効くシンボル追加を、受け手のuidごとに合算する。
   *  Python `stage4_evaluation.static_symbol_bonus` と同一。召喚時の
   *  `summon_symbol_grants`(支払い中だけ)の兄弟で、違いは窓だけ。
   *  `scope`は呼び手が今どの窓に居るか——`always`の付与は常に効き、`main`は
   *  軽減の窓、`attack`は打点の窓でだけ効く。 */
  function staticSymbolBonuses(state, cards, scope = "main") {
    const bonus = new Map();
    for (const unit of state.field) {
      if (unit.waiting) continue;
      const source = cards[unit.card_no] || {};
      for (const grant of source.static_symbol_grants || []) {
        const grantScope = grant.scope || "always";
        if (grantScope !== "always" && grantScope !== scope) continue;
        if (grant.required_level !== null && grant.required_level !== undefined
            && levelFor(unit, cards) < grant.required_level) continue;
        const beneficiaries = new Set();
        if (grant.beneficiary_self) beneficiaries.add(unit.uid);
        if (grant.beneficiary_slot) {
          for (const other of state.field) {
            if (!other.waiting
                && cardMatchesSlot(cards[other.card_no], grant.beneficiary_slot)) {
              beneficiaries.add(other.uid);
            }
          }
        }
        for (const uid of beneficiaries) {
          if (!bonus.has(uid)) bonus.set(uid, {});
          counterAdd(bonus.get(uid), grant.symbols);
        }
      }
    }
    return bonus;
  }

  /** 旗の追加と常時のシンボル追加を1体ぶんまとめる。Python
   *  `stage4_sim._flag_symbol_bonus(unit, uid, scope)` と同一。
   *  `staticBonus`を渡せば場ぜんぶの再計算を省ける。 */
  function flagSymbolBonus(state, cards, unit, scope, staticBonus) {
    const bonus = {};
    if (bugAuraActive(state) && bugFlagEligible(unit, cards)) {
      counterAdd(bonus, { "白": 1 });
    }
    const table = staticBonus || staticSymbolBonuses(state, cards, scope);
    counterAdd(bonus, table.get(unit.uid) || {});
    // 一時シンボルは**窓を問わず**効く。実際にその札に付いているので、
    // 生きているあいだは軽減にも打点にも入る。Python `_flag_symbol_bonus` 同一。
    counterAdd(bonus, timedSymbolBonus(unit, cards));
    return bonus;
  }

  /** その体に記録されている一時シンボルの合計。Python `_timed_symbol_bonus` 同一。
   *  `required_level`が残っている行は**毎回読み直す**——期間の印字が無い形は
   *  「効果が続いている」だけなので、Lvが下がった時点で消える(裁定id1586)。
   *  期間が印字された行は読み直さない(裁定id1605)。 */
  /** アタック宣言の窓で、その体自身へ付くシンボルを記録する。
   *  Python `_apply_attack_symbol_grants` と同一。発揮元は本体と合体中の
   *  ブレイヴだけ——⚠️ 煌臨元は入れない(この族は`works_as_contract_base`を
   *  持たないので、入れると撃たれないはずの節まで撃つ)。 */
  function applyAttackSymbolGrants(state, cards, unit, uid) {
    const sources = [unit.card_no].concat(
      combinedBraves(state, uid).map((brave) => brave.card_no));
    for (const sourceNo of sources) {
      for (const grant of (cards[sourceNo] || {}).attack_symbol_grants || []) {
        const required = grant.required_level;
        if (required !== null && required !== undefined
            && levelFromThresholds(
              unit.cores, (cards[sourceNo] || {}).level_thresholds) < required) {
          continue;
        }
        // 印字の盤面条件。⭐ 見るのは**発揮した瞬間**だけ(裁定id1605 BS68-019)。
        // Python `_apply_attack_symbol_grants` 同一。
        if (!stateConditionsMet(grant.state_conditions, state, cards, uid)) continue;
        if (!unit.timed_symbol_grants) unit.timed_symbol_grants = [];
        unit.timed_symbol_grants.push({
          symbols: { ...grant.symbols },
          scope: grant.scope,
          required_level: grant.recheck_source_level ? (required ?? null) : null,
          source_card_no: sourceNo,
        });
        record(state, cards, "symbol_granted", { card_no: sourceNo, uid,
          symbols: { ...grant.symbols }, scope: grant.scope });
      }
    }
  }

  function timedSymbolBonus(unit, cards) {
    const bonus = {};
    for (const row of unit.timed_symbol_grants || []) {
      if (row.required_level !== null && row.required_level !== undefined
          && levelFromThresholds(
            unit.cores, (cards[row.source_card_no] || {}).level_thresholds)
            < row.required_level) {
        continue;
      }
      counterAdd(bonus, row.symbols);
    }
    return bonus;
  }

  function sumCounter(counter) {
    return Object.values(counter || {}).reduce((sum, value) => sum + value, 0);
  }

  function effectiveSymbols(state, cards) {
    const result = {};
    const bugAura = bugAuraActive(state);
    const staticBonus = staticSymbolBonuses(state, cards);
    for (const unit of state.field) {
      if (!unit.waiting) {
        counterAdd(result, unit.symbols);
        if (bugAura && bugFlagEligible(unit, cards)) {
          counterAdd(result, { "白": 1 });
        }
        // 常時のシンボル追加(Python `_flag_symbol_bonus` の第2項と同一)。
        counterAdd(result, staticBonus.get(unit.uid) || {});
      }
    }
    return result;
  }

  /** コア数と閾値からLvを出す。Python `stage4_state.core_level` と同一。
   *  発揮元と受け手が別のカードのときは、こちらへ**発揮元の閾値**を渡す。 */
  function levelFromThresholds(cores, thresholds) {
    return Math.max(0, ...Object.entries(thresholds || {})
      .filter(([, threshold]) => threshold !== null && threshold <= cores)
      .map(([level]) => Number(level)));
  }

  function levelFor(unit, cards) {
    return levelFromThresholds(unit.cores, cards[unit.card_no]?.level_thresholds);
  }

  /** そのユニットで撃てる盤面のフラッシュ効果を発揮元ごとに並べる。
   *  Python `_field_flash_sources` と同一。
   *
   *  発揮元はユニット自身と、【契約煌臨元】の見出しを持つ煌臨元
   *  (`works_as_contract_base`)。門は印字のLvの範囲・〔ターンに1回〕・コアの
   *  支払い(支払いがあるのは【契約技：N】を持つものだけ。このカードのコアN個を
   *  ボイドへ)。支払いは盤面を壊さない範囲でだけ行い、ソウルコアは使わない。 */
  function fieldFlashSources(state, cards, unit) {
    if (!unit || unit.waiting) return [];
    const level = levelFor(unit, cards);
    const candidates = [[unit.card_no, false],
      ...(unit.kourin_stack || []).map((baseNo) => [baseNo, true])];
    const sources = [];
    for (const [cardNo, baseOnly] of candidates) {
      const effects = ((cards[cardNo] || {}).field_flash_effects || [])
        .filter((effect) => !baseOnly || effect.works_as_contract_base);
      if (!effects.length || state.fieldFlashUsed.has(`${unit.uid}:${cardNo}`)) continue;
      const gate = effects[0];
      if (gate.flash_level_min !== null && gate.flash_level_min !== undefined
          && !(gate.flash_level_min <= level && level <= gate.flash_level_max)) continue;
      const cost = gate.flash_cost_cores || 0;
      const ordinary = unit.cores - Number(Boolean(unit.soul_core));
      if (cost && (ordinary < cost || unit.cores - cost < unit.floor)) continue;
      sources.push({ card_no: cardNo, cost, effects });
    }
    return sources;
  }

  /** 場のカード全部について盤面のフラッシュ効果を1度ずつ試す。
   *  Python `_resolve_all_field_flash` と同一。〔ターンに1回〕なので、同じターンに
   *  何度呼んでも実際に撃つのは1回だけ。 */
  function resolveAllFieldFlash(state, cards, targets) {
    for (const unit of [...state.field].sort((left, right) => left.uid - right.uid)) {
      resolveFieldFlash(state, cards, targets, unit);
    }
    resolveSoulFlash(state, cards, targets);
  }

  /** 魂状態のカードで撃てるフラッシュ効果。Python `_soul_flash_sources` と同一。
   *
   *  魂状態はスピリットではないので**コアを持たずLvも無い**。それでも
   *  **【魂状態】と書かれた効果はLvに関係なく発揮する**(Q9726/Q9733/Q10796)ので、
   *  場のユニットとは別の経路で撃つ。①Lvの門を通さない、②コアの支払いを要求する
   *  節は撃てない(魂状態のカードの上にはコアを置けない)、③〔ターンに1回〕は
   *  `fieldFlashUsed`を共用し鍵は`soul:<card_no>`。 */
  function soulFlashSources(state, cards) {
    const sources = [];
    for (const cardNo of [...new Set(state.soulCards)]) {
      const effects = ((cards[cardNo] || {}).field_flash_effects || [])
        .filter((effect) => effect.works_as_soul_state && !effect.flash_cost_cores);
      if (!effects.length || state.fieldFlashUsed.has(`soul:${cardNo}`)) continue;
      sources.push({ card_no: cardNo, cost: 0, effects });
    }
    return sources;
  }

  function coalesceFaceUpCycleTrace(state, traceMark) {
    if (!state.trace) return;
    const rows = state.events.slice(traceMark);
    const drawEvent = rows.find((event) => event.type === "draw");
    if (drawEvent) {
      for (const event of rows) {
        if (event.type === "count_gained") event.state = clone(drawEvent.state);
      }
    }
  }

  /** 魂状態のカードのフラッシュ効果を撃つ。Python `_resolve_soul_flash` と同一。 */
  function resolveSoulFlash(state, cards, targets) {
    let fired = false;
    for (const source of soulFlashSources(state, cards)) {
      state.fieldFlashUsed.add(`soul:${source.card_no}`);
      for (const effect of source.effects) {
        record(state, cards, "effect_start", { card_no: source.card_no, uid: null,
          effect_kind: effect.kind, window: "soul_flash" });
        const traceMark = state.events.length;
        const ok = resolveEffect(state, cards, targets, effect, null);
        record(state, cards, "effect_complete", { card_no: source.card_no, uid: null,
          effect_kind: effect.kind, window: "soul_flash", resolved: Boolean(ok) });
        if (effect.kind === "face_up_top_cycle") {
          coalesceFaceUpCycleTrace(state, traceMark);
        }
        flushCountReactions(state, cards, targets);
        noteLegalCandidates(state, cards, targets);
      }
      fired = true;
    }
    return fired;
  }

  /** 盤面のフラッシュ効果を撃つ。Python `_resolve_field_flash` と同一。 */
  function resolveFieldFlash(state, cards, targets, unit) {
    for (const source of fieldFlashSources(state, cards, unit)) {
      state.fieldFlashUsed.add(`${unit.uid}:${source.card_no}`);
      if (source.cost) {
        unit.cores -= source.cost;
        // ボイドへ置いたコアはどのゾーンにも入らない(トラッシュではない)。
        recordCoreMove(state, cards, { amount: source.cost, source: "field",
          destination: "void", reason: "contract_technique",
          source_card_no: unit.card_no, source_uid: unit.uid });
      }
      for (const effect of source.effects) {
        record(state, cards, "effect_start", { card_no: source.card_no, uid: unit.uid,
          effect_kind: effect.kind, window: "field_flash" });
        const traceMark = state.events.length;
        const ok = resolveEffect(state, cards, targets, effect, unit.uid);
        record(state, cards, "effect_complete", { card_no: source.card_no, uid: unit.uid,
          effect_kind: effect.kind, window: "field_flash", resolved: Boolean(ok) });
        if (effect.kind === "face_up_top_cycle") {
          coalesceFaceUpCycleTrace(state, traceMark);
        }
        flushCountReactions(state, cards, targets);
        noteLegalCandidates(state, cards, targets);
      }
    }
  }

  /** 効いている『ライフ保護』を通した後の減少量。
   *  Python `_life_damage_after_protection` と同一。
   *
   *  `attacker`はアタックによる減少なら`{cost}`、効果による減少なら`null`。
   *  アタック限定の保護は効果によるライフ減少を止めない。 */
  function lifeDamageAfterProtection(state, amount, attacker) {
    for (const row of state.lifeProtections) {
      if (row.source_kind === "attack" && !attacker) continue;
      if (row.attacker_cost_min !== null && row.attacker_cost_min !== undefined
          && (!attacker || (attacker.cost || 0) < row.attacker_cost_min)) continue;
      if (row.protection === "none") return 0;
      amount = Math.min(amount, row.amount);
    }
    return amount;
  }

  function countRequirementsMet(requirements, count) {
    return (requirements || []).every((requirement) => {
      if (requirement.threshold === null || requirement.threshold === undefined) return true;
      if (requirement.comparison === ">=") return count >= requirement.threshold;
      if (requirement.comparison === "<=") return count <= requirement.threshold;
      if (requirement.comparison === "=") return count === requirement.threshold;
      return true;
    });
  }

  function stateConditionsMet(conditions, state, cards, sourceUid = null) {
    if (!conditions || !conditions.length) return true;
    const symbols = effectiveSymbols(state, cards);
    // 印字の盤面条件が見る材料。Python `_state_condition_board` と同一。
    // ⚠️ 相手の口は`units`を持たないことがある——持っていなければ「読めない」＝
    // nullに倒し、`opponent_unit_max`は満たさない扱いにする。
    const board = state.combatOpponent;
    const opponentUnits = (board && typeof board.units === "function")
      ? board.units().length : null;
    return conditions.every((condition) => {
      if (condition.kind === "symbol_present") return (symbols[condition.color] || 0) > 0;
      if (condition.kind === "life_threshold") {
        return condition.comparison === "以上"
          ? state.life >= condition.value : state.life <= condition.value;
      }
      if (condition.kind === "sealed") return Boolean(state.lifeHasSoul);
      if (condition.kind === "opponent_unit_max") {
        return opponentUnits !== null && opponentUnits <= condition.value;
      }
      // 手札の**枚数**は公開情報。相手の枚数は盤面が結ばれていないと読めない。
      // Python `state_conditions_met` の`hand_counts`と同一。
      if (condition.kind === "hand_count") {
        const have = condition.subject === "自分"
          ? state.hand.length
          : ((board && typeof board.hand_count === "function")
            ? board.hand_count() : null);
        if (have === null) return false;
        return condition.comparison === "以上"
          ? have >= condition.value : have <= condition.value;
      }
      // セット済みミラージュ。色の指定が無ければ「何かセットしていれば」。
      if (condition.kind === "own_mirage_set") {
        if (!state.mirage) return false;
        const wanted = condition.colors || [];
        if (!wanted.length) return true;
        const colors = (cards[state.mirage] || {}).colors || [];
        return wanted.some((color) => colors.includes(color));
      }
      // 相手がカードをセットしているか。**バーストとミラージュの両方**を数える
      // (印字が「カード」と言っている)。Python `opponent_card_set` と同一。
      if (condition.kind === "opponent_card_set") {
        if (!board || typeof board.burst_set !== "function") return false;
        return Boolean(board.burst_set()
          || (typeof board.mirage_set === "function" && board.mirage_set()));
      }
      // 「このスピリットに[ソウルコア]が置かれている間」は**発揮元自身**の状態。
      if (condition.kind === "source_has_soul_core") {
        const source = state.field.find((unit) => unit.uid === sourceUid);
        return Boolean(source && source.soul_core);
      }
      if (condition.kind === "own_named_card_present") {
        const nameOf = (cardNo) => (cards[cardNo] || {}).name || "";
        const names = state.field
          .filter((unit) => !unit.waiting)
          .map((unit) => nameOf(unit.card_no));
        // 場以外のゾーンは、印字が「魂状態/煌臨元を含む」と言ったぶんだけ数える。
        // Python `_state_condition_board` の`own_zone_names`と同一。
        for (const zone of condition.zones || []) {
          if (zone === "soul") names.push(...state.soulCards.map(nameOf));
          if (zone === "side") names.push(...state.sideCards.map(nameOf));
          if (zone === "kourin") {
            for (const unit of state.field) {
              if (unit.waiting) continue;
              names.push(...(unit.kourin_stack || []).map(nameOf));
            }
          }
        }
        // 名前の突き合わせは`normalizeCardName`(空白を落とす)を通す。Python同一。
        const needle = normalizeCardName(condition.name_contains) || "";
        return names.some((name) => normalizeCardName(name).includes(needle));
      }
      return true;
    });
  }

  function effectActive(effect, state, cards, sourceUid) {
    if (effect.required_level !== null && effect.required_level !== undefined) {
      const source = state.field.find((unit) => unit.uid === sourceUid);
      if (!source || levelFor(source, cards) < effect.required_level) return false;
    }
    return countRequirementsMet(effect.count_requirements, state.count)
      && stateConditionsMet(effect.state_conditions, state, cards, sourceUid);
  }

  function paymentFor(card, symbols, count = 0, allColorGrant = false) {
    let discount = 0;
    for (const reduction of card.reductions || []) {
      const [color, limit] = reduction;
      const available = color === "全" || allColorGrant
        ? BASIC_COLORS.reduce((sum, value) => sum + (symbols[value] || 0), 0)
        : (symbols[color] || 0);
      discount += Math.min(available, limit);
    }
    const countRule = card.cost_per_count;
    if (countRule?.step) {
      let countDiscount = Math.floor(count / countRule.step) * countRule.discount;
      if (countRule.max_discount !== null && countRule.max_discount !== undefined) {
        countDiscount = Math.min(countDiscount, countRule.max_discount);
      }
      discount += countDiscount;
    }
    const pay = Math.max(0, (card.cost || 0) - discount);
    const maintenance = card.card_type === "マジック" ? 0 : (card.maintenance || 0);
    return { pay, total: pay + maintenance, maintenance };
  }

  function summonPaymentSymbols(state, cards, candidate) {
    const symbols = effectiveSymbols(state, cards);
    for (const grant of candidate.summon_symbol_grants || []) {
      if (grant.scope !== "candidate") continue;
      for (const unit of state.field) {
        if (!unit.waiting && cardMatchesSlot(cards[unit.card_no], grant.beneficiary_slot)) {
          counterAdd(symbols, grant.symbols);
        }
      }
    }
    for (const unit of state.field) {
      if (unit.waiting) continue;
      const source = cards[unit.card_no];
      for (const grant of source.summon_symbol_grants || []) {
        if (grant.scope !== "field" || !cardMatchesSlot(candidate, grant.trigger_slot)) continue;
        if (grant.required_level !== null && grant.required_level !== undefined
            && levelFor(unit, cards) < grant.required_level) continue;
        const beneficiaries = new Set();
        if (grant.beneficiary_self) beneficiaries.add(unit.uid);
        for (const other of state.field) {
          if (!other.waiting && cardMatchesSlot(cards[other.card_no], grant.beneficiary_slot)) {
            beneficiaries.add(other.uid);
          }
        }
        for (const _uid of beneficiaries) counterAdd(symbols, grant.symbols);
      }
    }
    return symbols;
  }

  function paymentForState(state, cards, card) {
    const grantHit = state.field.some((unit) => !unit.waiting
      && cards[unit.card_no]?.reduction_grant
      && cardMatchesSlot(card, { condition: cards[unit.card_no].reduction_grant }));
    return paymentFor(card, summonPaymentSymbols(state, cards, card), state.count, grantHit);
  }

  function summonConditionsMet(card, state, cards) {
    const conditions = card.summon_conditions || [];
    if (!conditions.length) return true;
    for (const condition of conditions) {
      const structured = ["min_cost", "required_card_type", "required_color",
        "required_card_name", "required_lineage"].some(
        (key) => condition[key] !== null && condition[key] !== undefined);
      if (structured && state.field.some((unit) => {
        if (unit.waiting) return false;
        const host = cards[unit.card_no];
        if (!host) return false;
        if (condition.min_cost !== null && condition.min_cost !== undefined
            && (host.cost || 0) < condition.min_cost) return false;
        if (condition.required_card_type) {
          const types = condition.required_card_type.split("/").filter(Boolean);
          if (types.length && !types.some((type) => (host.card_type || "").includes(type))) return false;
        }
        if (condition.required_color && !(host.colors || []).includes(condition.required_color)) return false;
        if (condition.required_card_name
            && !(host.name || "").replaceAll(" ", "").includes(
              condition.required_card_name.replaceAll(" ", ""))) return false;
        if (condition.required_lineage
            && !(host.lineages || []).includes(condition.required_lineage)) return false;
        return true;
      })) return true;
      if (condition.state_requirement === "life_at_least"
          && state.life >= Number(condition.state_value)) return true;
      if (condition.state_requirement === "count_at_least"
          && state.count >= Number(condition.state_value)) return true;
      if (condition.state_requirement === "no_spirit_on_field_or_in_trash") {
        const fieldSpirit = state.field.some((unit) => !unit.waiting
          && (cards[unit.card_no]?.card_type || "").includes("スピリット"));
        const trashSpirit = state.trashCards.some((cardNo) =>
          (cards[cardNo]?.card_type || "").includes("スピリット"));
        if (!fieldSpirit && !trashSpirit) return true;
      }
      // Catalog v1 compatibility: old artifacts carried these three exact
      // text forms.  New v2 artifacts use state_requirement and contain no
      // condition_text.
      const text = condition.condition_text || "";
      let match = text.match(/^自分のライフ(\d+)以上$/);
      if (match && state.life >= Number(match[1])) return true;
      match = text.match(/^自分のカウント(\d+)以上$/);
      if (match && state.count >= Number(match[1])) return true;
      if (text === "自分のスピリット0体＆自分のトラッシュのスピリットカード0枚") {
        const fieldSpirit = state.field.some((unit) => !unit.waiting
          && (cards[unit.card_no]?.card_type || "").includes("スピリット"));
        const trashSpirit = state.trashCards.some((cardNo) =>
          (cards[cardNo]?.card_type || "").includes("スピリット"));
        if (!fieldSpirit && !trashSpirit) return true;
      }
    }
    return false;
  }

  function normalizedName(value) {
    return String(value || "").replace(/[\s・]/gu, "");
  }

  function isKourinCard(card) {
    return (card.keywords || []).some((keyword) => keyword.includes("煌臨"));
  }

  function isFKourin(card) {
    return ["F契約", "封印F契約"].includes(card.kourin_kind);
  }

  function isSealedKourin(card) {
    return card.kourin_kind === "封印F契約";
  }

  function kourinTermMatches(host, unit, term, count) {
    const value = term.trim();
    if (!value) return true;
    let match = value.match(/^C(\d+)以上$/u);
    if (match) return count >= Number(match[1]);
    match = value.match(/^コスト(\d+)以上$/u);
    if (match) return (host.cost || 0) >= Number(match[1]);
    if (value === "煌臨中") return Boolean((unit.kourin_stack || []).length);
    if (value.startsWith("「") && value.endsWith("」")) {
      return normalizedName(host.name).includes(normalizedName(value.slice(1, -1)));
    }
    if (value.includes("契約スピリット")) {
      const color = BASIC_COLORS.find((candidate) => value.includes(candidate));
      return Boolean(host.is_contract) && (host.card_type || "").includes("スピリット")
        && (!color || (host.colors || []).includes(color));
    }
    if (BASIC_COLORS.includes(value)) return (host.colors || []).includes(value);
    return (host.lineages || []).includes(value);
  }

  // 「いま煌臨してよいタイミングか」は**ここでは見ない**。Python
  // `kourin_host_uids`と同じく「この土台へ煌臨できるか」だけを答える。
  // タイミングの制限は合法手を数える側（`legalCandidates`）が掛ける
  // ——サーチの優先判定は「アタック時にしか煌臨できない札」でも
  // 「その公開札は将来の煌臨先になる」と見なすのが正しく、ここで弾くと
  // Pythonと違う札を拾う（seed 20260818のA-1不一致の原因）。
  const KOURIN_MAIN_TIMINGS = [null, "main", "self_turn"];

  function kourinHosts(card, state, cards) {
    if (!isKourinCard(card) || !card.kourin_condition) return [];
    const groups = card.kourin_condition.split("/").map((value) => value.trim()).filter(Boolean);
    return state.field.filter((unit) => {
      if (unit.waiting) return false;
      const host = cards[unit.card_no];
      if (!host || host.is_brave) return false;
      const allowed = ["スピリット", "アルティメット"];
      if (isFKourin(card)) allowed.push("ネクサス");
      if (!allowed.some((kind) => (host.card_type || "").includes(kind))) return false;
      return groups.some((group) => group.split(/[＆&]/u).every(
        (term) => kourinTermMatches(host, unit, term, state.count)));
    });
  }

  // 魂状態のカードに**当たらない**条件語(Python `_SOUL_KOURIN_TYPE_TERMS` と同一)。
  // 魂状態は「スピリットなどではない」ので種別を指す語は満たさない(Q9726)。
  // Q10608がその実例——「白の契約スピリット」はフィールドのスピリットに限定され、
  // 同じカードでも系統：「零契約」を指す条件なら魂状態へ煌臨できる。
  const SOUL_KOURIN_TYPE_TERMS = ["スピリット", "アルティメット", "ネクサス", "ブレイヴ"];

  /** 魂状態のカードのうち、この煌臨カードが乗れるもの。
   *  Python `kourin_soul_hosts` と同一。 */
  function kourinSoulHosts(card, state, cards) {
    if (!isKourinCard(card) || !card.kourin_condition) return [];
    const groups = card.kourin_condition.split("/").map((v) => v.trim()).filter(Boolean);
    const empty = { kourin_stack: [] };
    const seen = new Set();
    const result = [];
    for (const cardNo of state.soulCards) {
      if (seen.has(cardNo)) continue;
      seen.add(cardNo);
      const host = cards[cardNo];
      if (!host || !host.soul_kourin_allowed) continue;
      const ok = groups.some((group) => {
        const terms = group.split(/[＆&]/u).filter(Boolean);
        if (!terms.length) return false;
        // 種別を指す条件は魂状態に当たらない(Q10608)。
        if (terms.some((term) => SOUL_KOURIN_TYPE_TERMS.some((w) => term.includes(w)))) {
          return false;
        }
        return terms.every((term) => kourinTermMatches(host, empty, term, state.count));
      });
      if (ok) result.push(cardNo);
    }
    return result;
  }

  /** 魂状態への《契約煌臨》が払えるか。Python `_soul_kourin_payment_possible` と同一。
   *  魂状態のカードはコアを持たないので、ソウルコアはリザーブかライフからしか出ず、
   *  維持コアは「フィールド/リザーブのコアを好きなだけ置く」で載せる分。 */
  function soulKourinPaymentPossible(card, state, cards, destination) {
    if (!(state.reserveHasSoul || (state.lifeHasSoul && destination !== "life"))) {
      return false;
    }
    const available = state.reserve - (state.reserveHasSoul ? 1 : 0)
      + reclaimable(state, false, cards) - state.reserve;
    return available >= (card.maintenance || 0);
  }

  function kourinSoulSource(state, host, destination) {
    if (state.reserveHasSoul) return "reserve";
    if (state.lifeHasSoul && destination !== "life") return "life";
    if (host?.soul_core && !host.waiting && host.cores > host.floor) return "field";
    return null;
  }

  function hasContractBase(unit, cardNo) {
    return unit?.card_no === cardNo || (unit?.kourin_stack || []).includes(cardNo);
  }

  // ---- 契約煌臨元の置き換え(BS76-T001 Q31679/Q31742) --------------------
  // Python側 `stage4_kourin_runtime.py` と同じ規約。効果で場を離れるとき、
  // バグの土台とその上に載っているカードは、まとめて別のF契約煌臨スピリットの
  // 煌臨元へ移る。コストで離れる場合は対象外。
  const KOURIN_BASE_LEAVE_CAUSES = new Set(["own_effect", "opponent_effect", "rule"]);
  // 魂状態(ルール)。契約カードは**自分以外の原因で**場を離れるとき、代わりに
  // 魂状態にできる。Python `stage4_conditions.SOUL_STATE_LEAVE_CAUSES` と同一で、
  // 一致はテストで守る。自分の効果では魂状態にできない(Q9858)。`cost`/`rule`は
  // 裁定を持っていないので入れていない。
  const SOUL_STATE_LEAVE_CAUSES = new Set(["battle", "effect"]);

  /** 場を離れる山のうち魂状態になるカード。Python `soul_state_cards` と同一。
   *  契約カードは煌臨元に居ても個別に魂状態にできる(Q10799)。 */
  function soulStateCards(stack, cause, cards) {
    if (!SOUL_STATE_LEAVE_CAUSES.has(cause)) return [];
    return (stack || []).filter((cardNo) => Boolean(cards[cardNo]?.is_contract));
  }

  function kourinBaseSegment(stack, baseCardNo) {
    const rows = [...(stack || [])];
    const index = rows.lastIndexOf(baseCardNo);
    return index < 0 ? [] : rows.slice(index);
  }

  function fContractWhiteSpiritTarget(state, cards, excludeUid) {
    return [...state.field].sort((left, right) => left.uid - right.uid).find((unit) => {
      if (unit.uid === excludeUid || unit.waiting) return false;
      const card = cards[unit.card_no] || {};
      return (card.card_type || "").includes("スピリット")
        && (card.colors || []).includes("白")
        && ["F契約", "封印F契約"].includes(card.kourin_kind);
    }) || null;
  }

  /** 効果で場を離れる1体を確定する。Python `_finalize_field_leave` と同じ順序。 */
  // `destination`は**離れるカード自身**の行き先(6B-3のバウンス)。既定は"trash"で、
  // ほかに"hand"/"deck_top"/"deck_bottom"。煌臨元は行き先に関わらずトラッシュへ、
  // トークンはどこへ戻す印字でも消滅する。契約煌臨元の置き換えが起きる枝は従来
  // どおり(置き換えが移り先を決める効果そのものなので上書きしない)。
  function finalizeFieldLeave(state, cards, unit, cause, destination = "trash") {
    state.reserve += unit.cores;
    if (unit.soul_core) state.reserveHasSoul = true;
    let stack = [...(unit.kourin_stack || []), unit.card_no];
    const target = fContractWhiteSpiritTarget(state, cards, unit.uid);
    const moved = KOURIN_BASE_LEAVE_CAUSES.has(cause)
      ? kourinBaseSegment(stack, state.bugNo) : [];
    state.field.splice(state.field.indexOf(unit), 1);
    state.recurring = state.recurring.filter((entry) => entry.uid !== unit.uid);
    // 魂状態(ルール)。Python `_finalize_field_leave` と同一——**フィールドを
    // 離れていない**扱いなので行き先へ動かさず、『離れた後』の引き金も起こさない
    // (Q10096・Q10318)。契約煌臨元の置き換えは別ルールなので、その枝では触らない。
    const soulTaken = (target && moved.length) ? [] : soulStateCards(stack, cause, cards);
    if (soulTaken.length) state.soulCards.push(...soulTaken);
    if (soulTaken.includes(unit.card_no)) {
      const rest = stack.filter((cardNo) => !soulTaken.includes(cardNo));
      const trashedRest = rest.filter((cardNo) => !cards[cardNo]?.is_token);
      state.trashCards.push(...trashedRest);
      record(state, cards, "soul_state_entered", { card_no: unit.card_no, uid: unit.uid,
        cause, moved_card_nos: soulTaken, trash_card_nos: trashedRest,
        cores_returned: unit.cores });
      return;
    }
    if (soulTaken.length) {
      // 煌臨元の契約カードだけが魂状態になった枝。行き先計算から外す。
      // **ここでも記録する**(Python同一)。上の枝でしか記録しておらず、煌臨元だけが
      // 魂状態になる場合は`soulCards`が黙って増えていた。
      record(state, cards, "soul_state_entered", { card_no: unit.card_no, uid: unit.uid,
        cause, moved_card_nos: soulTaken, trash_card_nos: [],
        cores_returned: unit.cores });
      stack = stack.filter((cardNo) => !soulTaken.includes(cardNo));
    }
    if (target && moved.length) {
      // 山は下から上。移ってきた契約土台は移り先の既存の山の下へ入る。
      const remaining = stack.slice(0, stack.length - moved.length);
      target.kourin_stack = [...moved, ...(target.kourin_stack || [])];
      const trashed = remaining.filter((cardNo) => !cards[cardNo]?.is_token);
      state.trashCards.push(...trashed);
      record(state, cards, "field_left", { card_no: unit.card_no, uid: unit.uid,
        cause, destination: "kourin_base", target_uid: target.uid,
        moved_card_nos: moved, trash_card_nos: trashed, cores_returned: unit.cores });
      return;
    }
    const isToken = Boolean(cards[unit.card_no]?.is_token);
    if (destination !== "trash" && !isToken) {
      // 手札/デッキへ戻す。煌臨元は行き先に関わらずトラッシュへ。
      const bases = stack.slice(0, -1).filter((cardNo) => !cards[cardNo]?.is_token);
      state.trashCards.push(...bases);
      if (destination === "hand") state.hand.push(unit.card_no);
      // 山札は下→上なので、トップは末尾。Pythonの``deck.append``/``deck.insert(0, …)``と同じ。
      else if (destination === "deck_top") state.deck.push(unit.card_no);
      else state.deck.unshift(unit.card_no);
      record(state, cards, "field_left", { card_no: unit.card_no, uid: unit.uid, cause,
        destination, moved_card_nos: [unit.card_no], trash_card_nos: bases,
        cores_returned: unit.cores });
      return;
    }
    const trashed = stack.filter((cardNo) => !cards[cardNo]?.is_token);
    state.trashCards.push(...trashed);
    record(state, cards, "field_left", { card_no: unit.card_no, uid: unit.uid, cause,
      destination: isToken ? "vanish" : "trash",
      moved_card_nos: trashed, cores_returned: unit.cores });
  }

  function kourinMaintenancePossible(card, state, host, destination) {
    if (host.cores >= (card.maintenance || 0)) return true;
    if (!isFKourin(card) || !hasContractBase(host, state.fieldCoreKourinNo)) return false;
    const reserveAfterSoul = state.reserve - Number(state.reserveHasSoul && destination !== "life");
    const movableField = state.field.filter((unit) => unit.uid !== host.uid
      && !unit.waiting && !unit.soul_core).reduce((sum, unit) => sum + unit.cores, 0);
    return host.cores + reserveAfterSoul + movableField >= (card.maintenance || 0);
  }

  /** 《顕現》の指定された創界神ネクサスを場から探す。Python
   *  `manifestation_creator_uids` と同一。⚠️ **「」の名称指定は部分一致**
   *  ——完全一致で書いていたため顕現が事実上まるごと成立していなかった
   *  (2026-08-23修正。両ランタイムが同じ誤りだったので掃検では割れない)。 */
  function manifestationCreators(card, state, cards) {
    if (!card.manifestation_condition) return [];
    const countMatch = card.manifestation_condition.match(/C(\d+)以上/u);
    const names = [...card.manifestation_condition.matchAll(/「([^」]+)」/gu)];
    if (!countMatch || names.length !== 1 || state.count < Number(countMatch[1])) return [];
    const wanted = normalizedName(names[0][1]);
    return state.field.filter((unit) => !unit.waiting && unit.creator_core && unit.cores > 0
      && (normalizedName(cards[unit.card_no]?.name) || "").includes(wanted));
  }

  function manifestationSoulSource(state) {
    if (state.reserveHasSoul) return { zone: "reserve", unit: null };
    if (state.lifeHasSoul) return { zone: "life", unit: null };
    const unit = [...state.field].sort((a, b) => a.uid - b.uid)
      .find((row) => row.soul_core && !row.waiting);
    return unit ? { zone: "field", unit } : null;
  }

  function manifestationPossible(state, cards, creator, maintenance, allowSacrifice) {
    const source = manifestationSoulSource(state);
    if (!source || (source.zone === "life" && state.life <= 1)) return false;
    if (!creator || creator.cores - Number(source.unit?.uid === creator.uid) < 1) return false;
    let available = state.reserve - Number(source.zone === "reserve");
    available += reclaimable(state, allowSacrifice, cards) - state.reserve;
    if (source.unit && !source.unit.creator_core) available -= 1;
    return maintenance <= available;
  }

  /** このユニットに合体しているブレイヴ(uid昇順)。Python `_combined_braves`と同一。 */
  function combinedBraves(state, hostUid) {
    if (hostUid === null || hostUid === undefined) return [];
    return state.field
      .filter((unit) => unit.combined_host_uid === hostUid && !unit.waiting)
      .sort((left, right) => left.uid - right.uid);
  }

  /** 合体先になれるユニット(uid昇順)。Python `brave_combine_host_uids`と同一で、
   *  **待機中は除く**。合体先は1体に決まるので、可否だけでなく相手も返す。 */
  function braveCombineHosts(card, state, cards) {
    if (!card.is_brave) return [];
    const conditions = card.combine_conditions || [];
    return [...state.field].filter((unit) => {
      if (unit.waiting) return false;
      const candidate = cards[unit.card_no];
      if (!candidate || candidate.is_brave
          || !["スピリット", "アルティメット"].some(
            (type) => (candidate.card_type || "").includes(type))) return false;
      if (!conditions.length) return true;
      return conditions.some((condition) => {
        if (condition.min_cost !== null && condition.min_cost !== undefined
            && candidate.cost < condition.min_cost) return false;
        if (condition.required_color && !(candidate.colors || []).includes(condition.required_color)) return false;
        const requiredLineage = condition.required_lineage ?? condition.required_lineage_id;
        if (requiredLineage
            && !(candidate.lineages || []).includes(requiredLineage)) return false;
        if (condition.required_card_type
            && !(candidate.card_type || "").includes(condition.required_card_type)) return false;
        return true;
      });
    }).sort((left, right) => Number(Boolean(left.heavy_exhausted))
      - Number(Boolean(right.heavy_exhausted))
      || Number(Boolean(left.exhausted)) - Number(Boolean(right.exhausted))
      || left.uid - right.uid);
  }

  function braveMode(card, state, cards) {
    if (!card.is_brave) return null;
    const hosts = braveCombineHosts(card, state, cards);
    const tiredHostsOnly = hosts.length && hosts.every((host) => host.exhausted);
    return state.combat && tiredHostsOnly && !card.cannot_battle_as_spirit
      ? "spirit" : hosts.length ? "combine" : "spirit";
  }

  // **契約カードは自壊させない**(2026-08-21 ユーザー裁定、Python同一)。契約カードは
  // デッキの中核システムで、支払いのために自分で失う不利は普通のスピリットを整理する
  // 場合と比べ物にならない——相手の除去に対して魂状態が用意されているのも、そこを
  // 守るためのルールである。余剰コア(floor超過)は場を離れないので使ってよい。
  const sacrificeProtected = (unit, cards) => Boolean(
    (unit.kourin_stack || []).length || cards[unit.card_no]?.is_contract);

  function reclaimable(state, allowSacrifice, cards) {
    let total = state.reserve;
    for (const unit of state.field) {
      if (unit.creator_core || unit.waiting) continue;
      total += allowSacrifice && !sacrificeProtected(unit, cards)
        ? unit.cores : Math.max(0, unit.cores - unit.floor);
    }
    return total;
  }

  /** バグ割引を選ぶと支払い前に減る原資。Python `_bug_discount_funding_penalty` と同一。 */
  function bugDiscountFundingPenalty(state, cards) {
    const bug = [...state.field].sort((left, right) => left.uid - right.uid)
      .find((unit) => !unit.waiting && unit.card_no === state.bugNo);
    if (!bug) return 0;
    const target = fContractWhiteSpiritTarget(state, cards, bug.uid);
    // すでに煌臨元を持つユニットはもともと自壊対象外なので原資は減らない。
    if (!target || (target.kourin_stack || []).length) return 0;
    return target.cores - Math.max(0, target.cores - target.floor);
  }

  function legalCandidates(state, cards, targets, only = null) {
    const seen = new Set();
    const rows = [];
    state.hand.forEach((cardNo, handIndex) => {
      if ((only && !only.has(cardNo)) || seen.has(cardNo)) return;
      seen.add(cardNo);
      const card = cards[cardNo];
      if (!card) return;
      if (isSealedKourin(card) && state.sealedKourinNames.has(card.name)) return;
      const allowSacrifice = accessTier(cardNo, cards, targets) <= 1;
      const destination = isSealedKourin(card) ? "life" : "trash";
      // メインステップで煌臨できる札だけが合法手になる（Python
      // `_collect_legal_play_options`が同じ位置で同じ判定をしている）。
      const hosts = (KOURIN_MAIN_TIMINGS.includes(card.kourin_timing ?? null)
        ? kourinHosts(card, state, cards) : []).sort((left, right) =>
        Number(!(isFKourin(card) && left.card_no === state.flagNo))
          - Number(!(isFKourin(card) && right.card_no === state.flagNo))
        || left.uid - right.uid);
      const host = hosts.find((unit) => kourinSoulSource(state, unit, destination)
        && kourinMaintenancePossible(card, state, unit, destination));
      // 場に宿主がいないなら**魂状態のカードへ乗り直せないか**(Python同一)。
      const soulHost = host ? null
        : (KOURIN_MAIN_TIMINGS.includes(card.kourin_timing)
          ? kourinSoulHosts(card, state, cards).find(
            () => soulKourinPaymentPossible(card, state, cards, destination))
          : undefined) || null;
      if (card.is_contract && card.kourin_kind && !host && !soulHost) return;
      if (host) {
        rows.push({ hand_index: handIndex, card_no: cardNo, brave_mode: null,
          allow_sacrifice: false, mode: "kourin", kourin_host_uid: host.uid,
          pay: 0, total: 0, maintenance: 0 });
        return;
      }
      if (soulHost) {
        rows.push({ hand_index: handIndex, card_no: cardNo, brave_mode: null,
          allow_sacrifice: false, mode: "kourin_from_soul",
          kourin_soul_card_no: soulHost,
          pay: 0, total: card.maintenance || 0, maintenance: card.maintenance || 0 });
        return;
      }
      const creator = manifestationCreators(card, state, cards).find((unit) =>
        manifestationPossible(state, cards, unit, card.maintenance || 0, allowSacrifice));
      if (!creator && !summonConditionsMet(card, state, cards)) return;
      const mode = braveMode(card, state, cards);
      const cost = creator
        ? { pay: 0, total: card.maintenance || 0, maintenance: card.maintenance || 0 }
        : paymentForState(state, cards, card);
      const tokenCost = card.token_sacrifice_summon_cost;
      if (!creator && tokenCost !== null && tokenCost !== undefined
        && state.field.some((unit) => !unit.waiting && unit.card_no === state.bugNo)) {
        cost.pay = Math.min(cost.total, tokenCost);
        cost.total = cost.pay;
      }
      if (mode === "combine") cost.total = cost.pay;
      // 自壊なしで払えるならそこで通す。自壊が要るときだけ、トークン破壊で先に
      // 減る原資(bugDiscountFundingPenalty)を足して判定する。Python側と同じ順序。
      if (cost.total > reclaimable(state, false, cards)) {
        if (!allowSacrifice) return;
        const need = cost.total + (cost.total === tokenCost
          ? bugDiscountFundingPenalty(state, cards) : 0);
        if (need > reclaimable(state, true, cards)) return;
      }
      rows.push({ hand_index: handIndex, card_no: cardNo, brave_mode: mode,
        allow_sacrifice: allowSacrifice, mode: creator ? "manifestation" : "normal",
        manifestation_creator_uid: creator?.uid ?? null, ...cost });
    });
    return rows;
  }

  function stateView(state, cards) {
    const fieldSoul = state.field.find((unit) => unit.soul_core);
    const soulLocation = state.reserveHasSoul ? "reserve"
      : state.trashHasSoul ? "trash" : state.lifeHasSoul ? "life"
        : fieldSoul ? `field:${fieldSoul.uid}` : null;
    return {
      hand: [...state.hand], deck_count: state.deck.length,
      deck_top_face_up: state.deck.length && state.faceUpTop === state.deck.at(-1)
        ? state.faceUpTop : null,
      trash_cards: [...state.trashCards], side_cards: [...state.sideCards],
      excluded_cards: [...state.excludedCards],
      // 魂状態はフィールドの上のゾーン。**戦闘の棋譜だけが持つ**——ソリティアでは
      // 必ず空なので、鍵を足すだけでv56のgoldenとfingerprintが動く。
      ...(state.combat ? { soul_cards: [...state.soulCards] } : {}),
      field: ((staticMain) => state.field.map((unit) => {
        const bugCount = (unit.kourin_stack || []).filter(
          (cardNo) => cardNo === state.bugNo).length;
        const auraBonus = bugAuraActive(state) && bugFlagEligible(unit, cards) ? 10000 : 0;
        // 合体中のブレイヴのBPはホストへ加算される(Python `_effective_bp_bonus`と同一)。
        const braveBp = combinedBraves(state, unit.uid).reduce(
          (sum, brave) => sum + (cards[brave.card_no]?.base_bp || 0), 0);
        // 相手効果によるBP減少(6B-3)。期間ごとに境界で捨てる。
        const bpPenalty = (unit.bp_penalties || []).reduce(
          (sum, row) => sum + row.amount, 0);
        const bpBonus = bugCount * 1000 + auraBonus + braveBp - bpPenalty;
        // ⚠️ 旗だけでなく常時のシンボル追加も入れる(2026-08-31)。Python
        // `_trace_state`は`_flag_symbol_bonus`経由で入れていたのに、こちらは
        // 旗しか入れていなかった。掃検のデッキに該当カードが1枚も無いため
        // 割れずに残っていた**潜在の食い違い**である。
        const symbolBonus = flagSymbolBonus(state, cards, unit, "main", staticMain);
        return ({
        uid: unit.uid, card_no: unit.card_no, cores: unit.cores,
        floor: unit.floor, soul_core: Boolean(unit.soul_core), level: levelFor(unit, cards),
        waiting: Boolean(unit.waiting), brave_mode: unit.brave_mode,
        combined_host_uid: unit.combined_host_uid ?? null,
        kourin_stack: [...(unit.kourin_stack || [])],
        protections: bugCount ? ["opponent_spirit_ultimate_effect"] : [],
        base_bp: cards[unit.card_no]?.base_bp || 0,
        bp_bonus: bpBonus, bp: (cards[unit.card_no]?.base_bp || 0) + bpBonus,
        symbol_bonus: symbolBonus,
        // 疲労は戦闘を扱うときだけ棋譜へ出す(Stage4 v56と5Cの列を増やさない)。
        ...(state.combat ? {
          exhausted: Boolean(unit.exhausted),
          heavy_exhausted: Boolean(unit.heavy_exhausted),
        } : {}),
      }); }))(staticSymbolBonuses(state, cards, "main")),
      reserve: state.reserve, trash: state.spent, life: state.life,
      soul_location: soulLocation, count: state.count, mirage: state.mirage, burst: state.burst,
      // Pythonの`open_pool_stack`と同じく、入れ子になった公開効果も外側から
      // 順に1本へ畳んで棋譜へ出す。各poolは解決中の実配列そのものなので、
      // 公開時反応で札を取り除いた時点も過去のコピーではなく現在値を写せる。
      open_pool: state.openPoolStack.flat(),
      ...(state.stage5c ? {
        opponent: structuredClone(state.stage5c.opponent),
        opponent_model: state.stage5c.opponent_model,
        branch_probabilities: { ...state.stage5c.branch_probabilities },
        // 5C-1 stays empty; 5C-2A accumulates what has been sampled so far.
        resolved_branch_events: structuredClone(state.resolvedBranchEvents || []),
      } : {}),
    };
  }

  /** コア移動を1件記録する。Python `_record_core_move` と同一。
   *
   *  **`source_card_no`は`source_uid`から埋め直す**——Pythonのヘルパがそうして
   *  いるのに、JSは各所で`record`を直に呼んでいたため、IRが`source_card_no`を
   *  持たない効果(実データの大半)で**Worker側だけキーが落ちていた**。
   *  詳細モードでしか出ないので掃検の既定では見えず、剣獣ヘルメスの検証デッキで
   *  詳細を取ったときに初めて露見した(2026-08-21)。 */
  function recordCoreMove(state, cards, details) {
    if (!(details.amount > 0)) return;
    const filled = { ...details };
    if ((filled.source_card_no === undefined || filled.source_card_no === null)
        && filled.source_uid !== undefined && filled.source_uid !== null) {
      const unit = state.field.find((row) => row.uid === filled.source_uid);
      if (unit) filled.source_card_no = unit.card_no;
    }
    // Pythonのヘルパは**3つのキーを必ず載せる**(渡されなければNone)ので、
    // JS側も既定をnullで埋めてから記録する。キーごと落ちると詳細モードが割れる。
    record(state, cards, "core_moved", {
      source_card_no: null, source_uid: null, target_uid: null, ...filled });
  }

  function record(state, cards, type, details = {}, turn = state.turn) {
    if (!state.trace) return;
    state.events.push({
      seq: state.events.length + 1,
      type,
      turn,
      state: stateView(state, cards),
      // Python `TraceRecorder.record`と同じく**その時点の値を写す**。参照のまま
      // 積むと、後から中身を書き換える呼び出し元が過去のイベントまで書き換えて
      // しまう。実際`cards_opened`は公開プールの配列をそのまま渡していたため、
      // 直後の公開時反応が1枚抜くと**記録済みの「何を捲ったか」が2枚に減って
      // いた**（Pythonは3枚のまま）。
      // `undefined`は**`null`へ寄せる**。Pythonの`_record(**kwargs)`は渡された
      // キーをNoneのまま載せるのに、JSは`undefined`のまま積むとJSONで**キーごと
      // 消える**ので、詳細モードだけが「Python: null / Worker: undefined」で
      // 割れ続けていた(2026-08-21、剣獣ヘルメスの検証デッキで露見)。
      details: structuredClone(Object.fromEntries(
        Object.entries(details).map(([key, value]) =>
          [key, value === undefined ? null : value]))),
    });
  }

  // 5C-2A records the sampled branch and stops there: `applied` stays false so
  // a reader can never mistake a sampled removal for a card that actually left.
  function addBranchEvent(state, cards, kind, probability, status, extra = {}) {
    const threshold = extra.threshold ?? null;
    const roll = extra.roll ?? null;
    const event = {
      seq: state.resolvedBranchEvents.length + 1,
      turn: state.turn,
      kind,
      window: BRANCH_WINDOWS[kind],
      probability,
      threshold,
      roll,
      roll_succeeded: roll !== null && roll < threshold,
      resolved: status === "resolved",
      status,
      target: extra.target ?? null,
      target_pool_size: extra.target_pool_size ?? null,
      applied: false,
    };
    state.resolvedBranchEvents.push(event);
    const { turn, ...details } = event;
    record(state, cards, "branch_sampled", details);
  }

  // Each kind owns an independent stream, so changing one probability never
  // moves the other kind's outcomes. Probability 0 is an explicit statement
  // that the branch never happens and is not drawn at all.
  function sampleOpponentBranches(state, cards, options) {
    if (!state.branchSampling) return;
    for (const kind of BRANCH_KEYS) {
      const probability = state.stage5c.branch_probabilities[kind];
      if (!(probability > 0)) continue;
      if (kind === "removal" && options.going_first && state.turn === 1) {
        // 先攻1ターン目の前に相手のターンは無い。
        addBranchEvent(state, cards, kind, probability, "no_opponent_turn");
        continue;
      }
      // バーストは発生源(相手のセット済みバースト)が要るが、それは契約側で
      // 拒否済み。試行中にバーストを消費するのは5C-2B以降の話。
      const rng = state.branchRngs[kind];
      const threshold = branchThreshold(probability);
      const roll = rng.nextU32();
      if (roll >= threshold) {
        addBranchEvent(state, cards, kind, probability, "declined", { threshold, roll });
        continue;
      }
      if (kind === "removal") {
        const pool = state.field.filter((unit) => !unit.waiting)
          .map((unit) => unit.uid).sort((left, right) => left - right);
        if (!pool.length) {
          addBranchEvent(state, cards, kind, probability, "no_target",
            { threshold, roll, target_pool_size: 0 });
          continue;
        }
        // 相手の意思決定はモデル化しない方針なので、対象は「選ばれる」のではなく
        // 候補から一様に引く。優先度を付ければそれは相手AIになる。
        const uid = pool[rng.nextInt(pool.length)];
        const unit = state.field.find((row) => row.uid === uid);
        addBranchEvent(state, cards, kind, probability, "resolved", {
          threshold, roll, target: { uid, card_no: unit.card_no },
          target_pool_size: pool.length,
        });
        continue;
      }
      addBranchEvent(state, cards, kind, probability, "resolved", { threshold, roll });
    }
  }

  // 選んだ札が0枚のときはイベントを出さない(Python v56の_record_card_selectionと
  // 同じ規約)。空の「カード選択」を出すと、Worker側だけ棋譜が1イベント長くなる。
  function recordCardSelection(state, cards, details) {
    if (!details.cards?.length) return;
    record(state, cards, "cards_selected", details);
  }

  // 山札は下→上（末尾がトップ）。「上からn枚」はPythonの``deck[-n:]``と同じく
  // **下→上の順**で返す（配列の末尾が一番上の札）。
  // Pythonの``deck[-0:]``が山札全体になる罠と同じものがJSにもある
  // （``splice(-0)``は``splice(0)``＝全部）。0枚は必ず空にする。
  function topSliceStart(state, amount) {
    return Math.max(0, state.deck.length - Math.max(0, amount));
  }

  // 非破壊。取り出した札は呼び出し側が値で取り除く（Python v56の``deck.remove``）。
  function peekTopSlice(state, amount) {
    return state.deck.slice(topSliceStart(state, amount));
  }

  // 破壊的。位置で切り取る（Pythonの``del deck[-len(cards):]``）。
  function takeTopSlice(state, amount) {
    clearRemovedFaceUpTop(state, amount);
    return state.deck.splice(topSliceStart(state, amount));
  }

  function clearRemovedFaceUpTop(state, amount) {
    if (amount > 0 && state.faceUpTop === state.deck.at(-1)) state.faceUpTop = null;
  }

  // 表向きトップはカード番号ではなく「現在トップにある物理コピー」の印。
  // 取り出し口を集約し、同番号の次コピーが表向きとして再出現するのを防ぐ。
  function takeTopCard(state) {
    if (!state.deck.length) return null;
    clearRemovedFaceUpTop(state, 1);
    return state.deck.pop();
  }

  function draw(state, cards, amount, reason = "draw") {
    let count = 0;
    const drawn = [];
    while (state.deck.length && count < amount) {
      const cardNo = takeTopCard(state);
      state.hand.push(cardNo);
      state.seen.add(cardNo);
      state.handGain += 1;
      state.dig += 1;
      drawn.push(cardNo);
      count += 1;
    }
    if (count) record(state, cards, "draw", { cards: drawn });
    return count;
  }

  function resolveFaceUpTopCycle(state, cards, targets, effect, sourceUid) {
    if (!state.deck.length) return false;
    const preEffectCount = state.count;
    const revealed = state.deck.at(-1);
    state.faceUpTop = revealed;
    record(state, cards, "deck_top_revealed", { card_no: revealed, source_uid: sourceUid });
    const revealedCard = cards[revealed] || {};
    const canReplace = (revealedCard.lineages || []).includes(effect.summon_lineage)
      && (revealedCard.cost || 0) <= preEffectCount;
    applyCountGain(state, cards, effect.count_gain || 0, null,
      { reason: "face_up_top_cycle", source_uid: sourceUid });
    let pendingSummon = null;
    if (canReplace) {
      const brave = braveMode(revealedCard, state, cards);
      const pay = effect.summon_cost || 0;
      const total = pay + (brave === "combine" ? 0 : (revealedCard.maintenance || 0));
      if (total <= reclaimable(state, true, cards)) {
        takeTopCard(state);
        state.seen.add(revealed);
        state.dig += 1;
        pendingSummon = { card_no: revealed, pay, total,
          maintenance: revealedCard.maintenance || 0, brave_mode: brave,
          allow_sacrifice: true, mode: "face_up_draw_replacement" };
      }
    }
    if (!pendingSummon) draw(state, cards, effect.draw || 0, "face_up_top_cycle");
    if (state.hand.length) {
      const rows = state.hand.map((cardNo, index) => ({ cardNo, index,
        tier: accessTier(cardNo, cards, targets), cost: cards[cardNo]?.cost || 0 }));
      const summonable = rows.filter((row) =>
        (cards[row.cardNo]?.lineages || []).includes(effect.summon_lineage)
          && row.cost <= preEffectCount)
        .sort((a, b) => a.tier - b.tier || a.cost - b.cost || a.index - b.index);
      const returned = summonable[0] || rows.sort(
        (a, b) => b.tier - a.tier || b.cost - a.cost || b.index - a.index)[0];
      state.hand.splice(returned.index, 1);
      state.deck.push(returned.cardNo);
      state.faceUpTop = returned.cardNo;
      record(state, cards, "card_moved", { card_no: returned.cardNo, source: "hand",
        destination: "deck_top_face_up", reason: "face_up_top_cycle" });
    }
    if (pendingSummon) {
      play(state, cards, targets, pendingSummon);
    }
    return true;
  }

  function chooseFromPool(pool, slots, cards, targets, priorityKey = null) {
    const work = [...pool];
    const picked = [];
    const pickedSlots = [];
    for (const slot of slots || []) {
      const before = picked.length;
      const limit = slot.limit;
      let taken = 0;
      const take = (predicate) => {
        while ((limit === null || limit === undefined || taken < limit)) {
          // Pythonは (priority, プール内の位置) の最小を取る。priorityが無ければ
          // 先頭から。ここを位置だけで選ぶと、カード固有の優先が効かない。
          let index = -1;
          let best = null;
          work.forEach((cardNo, position) => {
            if (!predicate(cardNo)) return;
            const rank = [priorityKey ? priorityKey(cardNo) : 0, position];
            if (best === null || rank[0] < best[0] || (rank[0] === best[0] && rank[1] < best[1])) {
              best = rank;
              index = position;
            }
          });
          if (index < 0) break;
          picked.push(work.splice(index, 1)[0]);
          taken += 1;
        }
      };
      take((cardNo) => targets.has(cardNo) && cardMatchesSlot(cards[cardNo], slot));
      take((cardNo) => isEngine(cards[cardNo]) && cardMatchesSlot(cards[cardNo], slot));
      if (!taken && !(slot.alternatives || []).length
          && !(slot.condition || []).some(Boolean) && work.length) {
        picked.push(work.shift());
        taken += 1;
      }
      take((cardNo) => cardMatchesSlot(cards[cardNo], slot));
      pickedSlots.push({ slot, cards: picked.slice(before) });
    }
    return { picked, remaining: work, picked_slots: pickedSlots };
  }

  function putRemainder(state, cards, remaining, destination, sourceCardNo) {
    if (!remaining.length) return;
    if (destination === "trash") {
      state.trashCards.push(...remaining);
      recordCardSelection(state, cards, { cards: remaining, source: "open",
        destination: "trash", reason: "search_remainder", source_card_no: sourceCardNo });
    } else if (destination === "top") {
      // `remaining`は下→上。Pythonの``deck.extend(cards)``と同じで、
      // 末尾のカードが一番上（次に引く札）になる。
      state.deck.push(...remaining);
      record(state, cards, "cards_returned_to_deck", { cards: remaining,
        destination: "top", order: "bottom_to_top", reason: "search_remainder",
        source_card_no: sourceCardNo });
    } else {
      // Pythonの``deck[0:0] = cards``。先頭のカードが一番下になる。
      state.deck.unshift(...remaining);
      record(state, cards, "cards_returned_to_deck", { cards: remaining,
        destination: "bottom", order: "bottom_to_top", reason: "search_remainder",
        source_card_no: sourceCardNo });
    }
  }

  /** トラッシュへ落ちたカード自身の「手札に加えられる」。
   *  Python `apply_trash_reactions` と同一。**印字の3つの制限は別のルール**
   *  (`battlespirits_schema_draft.md`の表):
   *   - once_per_turn_name … 同名カード全体でターン1回(〔ターンに1回：同名〕と
   *     「この効果はターンに1回しか使えない」。公式裁定Q9で同一ルール)
   *   - once_per_turn_card … **そのカード1枚ごとに**1回。同名コピーは区別できないので
   *     デッキの枚数を上限にする
   *   - no_duplicate … 同じ処理の中で重ねない(ターンを跨ぐ制限は掛けない) */
  function applyTrashReactions(state, cards, landed, sourceCardNo, oracle) {
    const firedNow = new Set();
    for (const cardNo of [...landed]) {
      const index = state.trashCards.indexOf(cardNo);
      if (index < 0) continue;
      for (const reaction of cards[cardNo]?.trash_reactions || []) {
        if (reaction.event !== "milled_from_deck") continue;
        if (reaction.source_oracle) {
          if (!oracle) continue;
        } else if (!openReactionMatches(reaction, sourceCardNo, cards)) {
          continue;
        }
        const name = cards[cardNo]?.name;
        const limit = reaction.limit;
        if (limit === "once_per_turn_name" && state.trashReactionNames.has(name)) continue;
        if (limit === "no_duplicate" && firedNow.has(cardNo)) continue;
        if (limit === "once_per_turn_card"
            && (state.trashReactionCardUses[cardNo] || 0)
              >= (state.deckCopies[cardNo] || 0)) continue;
        state.trashCards.splice(state.trashCards.indexOf(cardNo), 1);
        state.hand.push(cardNo);
        state.handGain += 1;
        firedNow.add(cardNo);
        if (limit === "once_per_turn_name") state.trashReactionNames.add(name);
        else if (limit === "once_per_turn_card") {
          state.trashReactionCardUses[cardNo] =
            (state.trashReactionCardUses[cardNo] || 0) + 1;
        }
        record(state, cards, "card_moved", { card_no: cardNo, destination: "hand",
          reason: "trash_reaction", source_card_no: sourceCardNo });
        break;
      }
    }
  }

  function openReactionMatches(reaction, sourceCardNo, cards) {
    const source = cards[sourceCardNo];
    if (!source) return Boolean(reaction.source_any);
    if (reaction.source_color && !(source.colors || []).includes(reaction.source_color)) return false;
    if ((reaction.source_lineages || []).length
        && !reaction.source_lineages.some((value) => (source.lineages || []).includes(value))) return false;
    return !reaction.source_name_contains
      || (source.name || "").includes(reaction.source_name_contains);
  }

  /** ルール行動でセットする1枚を数える節。Python `burst_effect_is_useful` と同一。
   *  「その後コストを支払うことで…」は**本体効果が撃てるときだけ**数える。
   *  相手盤面干渉(6C-2C)も数える——開くのは戦闘の途中か相手のターンなので、
   *  相手の体を落とせるならそのためにセットする価値がある。 */
  const USEFUL_BURST_KINDS = ["draw", "coreboost", "core_to_trash",
    "field_coreboost", "count_gain", "burst_free_play_self",
    "unit_destroy", "unit_exhaust", "unit_core_remove", "unit_bounce",
    "unit_heavy_exhaust", "unit_bp_down", "life_core_remove", "field_core_remove"];

  function burstEffectIsUseful(card, effect) {
    if (effect.kind === "burst_pay_own_effect") {
      return (card.enablers || []).some((row) => row.mode === "on_play");
    }
    return USEFUL_BURST_KINDS.includes(effect.kind);
  }

  /** バーストの条件のうち**Stage6が実イベントから開けるもの**(6C-2)。
   *  Python `stage4_sim.OBSERVABLE_BURST_CATEGORIES` と同一で、`stage6_sim.js`も
   *  ここから引く(片方だけ足すと「規則はあるが一度も効かない」状態になる)。 */
  const BURST_LIFE_LOSS = "ライフ減少後";
  const BURST_OPPONENT_ATTACK = "相手アタック後";
  const BURST_OWN_DESTROYED = "自分スピリット消滅/破壊後";
  const BURST_OWN_LEFT_FIELD = "自分スピリット離脱後";
  const OBSERVABLE_BURST_CATEGORIES = [BURST_LIFE_LOSS, BURST_OPPONENT_ATTACK,
    BURST_OWN_DESTROYED, BURST_OWN_LEFT_FIELD];
  // 「自分のスピリットが場を離れたら」型は、離れる元が自分の場に居ないと起きない。
  const BURST_NEEDS_OWN_UNIT = [BURST_OWN_DESTROYED, BURST_OWN_LEFT_FIELD];

  /** そのバーストが**踏まれうる盤面か**を二値で答える(6C-3)。
   *  Python `burst_category_can_be_stepped_on` と同一。 */
  function burstCategoryCanBeSteppedOn(categories, opponentView, ownUnits) {
    if (!opponentView) return false;
    const watched = (categories || []).filter(
      (value) => OBSERVABLE_BURST_CATEGORIES.includes(value));
    if (!watched.length || (opponentView.attackers || 0) <= 0) return false;
    if (watched.some((value) => !BURST_NEEDS_OWN_UNIT.includes(value))) return true;
    return ownUnits > 0;
  }

  function setBurst(state, cards, cardNo, source = "effect") {
    if (!(cards[cardNo]?.burst_effects || []).length) return false;
    if (state.burst) {
      const replaced = state.burst;
      // Python `_replace_burst_to_trash`は新しい札をburstへ置いてから差し替えを
      // 記録する。古い札のままsnapshotを取ると、次のburst_setまで盤面が嘘になる。
      state.burst = cardNo;
      state.trashCards.push(replaced);
      record(state, cards, "burst_replaced", {
        card_no: replaced, destination: "trash", replacement: cardNo,
      });
    } else state.burst = cardNo;
    record(state, cards, "burst_set", { card_no: cardNo, source });
    return true;
  }

  function beginEffectFrame(state) {
    state.effectFrameDepth += 1;
  }

  function deferFieldLeave(state, callback) {
    if (state.effectFrameDepth > 0) state.deferredFieldLeaves.push(callback);
    else callback();
  }

  function endEffectFrame(state) {
    state.effectFrameDepth -= 1;
    if (state.effectFrameDepth < 0) throw new Error("effect frame underflow");
    if (state.effectFrameDepth) return;
    while (state.deferredFieldLeaves.length) state.deferredFieldLeaves.shift()();
  }

  function applyOpenReactions(state, cards, targets, pool, sourceCardNo) {
    for (const cardNo of [...pool]) {
      const card = cards[cardNo];
      const reaction = (card?.open_reactions || []).find((row) =>
        openReactionMatches(row, sourceCardNo, cards));
      if (!reaction) continue;
      record(state, cards, "open_reaction_declared", { card_no: cardNo,
        source_card_no: sourceCardNo, destination: reaction.destination });
      if (reaction.same_name_policy === "once_per_turn"
          && state.openReactionNames.has(card.name)) continue;
      const cost = reaction.cost || 0;
      const total = cost + (reaction.destination === "field" ? card.maintenance || 0 : 0);
      if (reaction.destination === "field" && !summonConditionsMet(card, state, cards)) continue;
      if (total > reclaimable(state, true, cards)) continue;
      record(state, cards, "open_reaction_queued", { card_no: cardNo,
        source_card_no: sourceCardNo, destination: reaction.destination });
      record(state, cards, "effect_start", { card_no: cardNo,
        effect_kind: "opened_reaction", source_card_no: sourceCardNo });
      let resolved = false;
      if (reaction.destination === "burst") {
        pool.splice(pool.indexOf(cardNo), 1);
        resolved = setBurst(state, cards, cardNo, "effect");
      } else if (reaction.destination === "hand") {
        if (total) {
          const deficit = total - state.reserve;
          if (deficit > 0) fundPayment(state, cards, targets, deficit, true);
          payFromReserve(state, cost, 0);
          state.reserve -= total;
          state.spent += cost;
        }
        pool.splice(pool.indexOf(cardNo), 1);
        state.hand.push(cardNo);
        state.seen.add(cardNo);
        state.handGain += 1;
        resolved = true;
      } else if (reaction.destination === "field") {
        if (total) {
          const deficit = total - state.reserve;
          if (deficit > 0) fundPayment(state, cards, targets, deficit, true);
        }
        pool.splice(pool.indexOf(cardNo), 1);
        const soulCore = total ? payFromReserve(state, cost, card.maintenance || 0) : false;
        state.reserve -= total;
        state.spent += cost;
        state.uid += 1;
        const uid = state.uid;
        state.field.push({ uid, card_no: cardNo, cores: card.maintenance || 0,
          floor: card.maintenance || 0, symbols: card.symbols || {}, brave_mode: null,
          creator_core: (card.lineages || []).includes("創界神"), waiting: false,
          // 疲労状態。戦闘(6B)でだけ動き、combat無効なら常にfalseのまま。
          exhausted: false,
          soul_core: soulCore, kourin_stack: [] });
        state.played.add(cardNo);
        state.playCounts[state.turn] = (state.playCounts[state.turn] || 0) + 1;
        record(state, cards, "card_entered", { card_no: cardNo, uid,
          destination: "field", mode: "opened_reaction", source_card_no: sourceCardNo });
        resolvePlayedEffects(state, cards, targets, { ...card, card_no: cardNo }, uid, null);
        resolved = true;
      }
      if (resolved && reaction.same_name_policy === "once_per_turn") {
        state.openReactionNames.add(card.name);
      }
      record(state, cards, "effect_complete", { card_no: cardNo,
        effect_kind: "opened_reaction", source_card_no: sourceCardNo, resolved });
    }
  }

  function applyCountGain(state, cards, amount, cap, details = {}) {
    if (!(amount > 0)) return false;
    const before = state.count;
    // Python `apply_count_gain` と同じ。「最大Nまで」は既存値をNへ下げない。
    state.count = Math.max(before,
      Math.min(cap ?? Number.MAX_SAFE_INTEGER, before + amount));
    if (state.count === before) return false;
    record(state, cards, "count_gained", { old_count: before, new_count: state.count,
      amount: state.count - before, cap: cap ?? null, reason: "effect",
      source_card_no: null, source_uid: null, source_count: null, ...details });
    state.pendingCountEvents.push({ old_count: before, new_count: state.count,
      amount: state.count - before });
    return true;
  }

  function faraSourceCount(state) {
    return state.field.reduce((sum, unit) => sum
      + Number(!unit.waiting && unit.card_no === state.flagNo)
      + (unit.kourin_stack || []).filter((cardNo) => cardNo === state.flagNo).length, 0);
  }

  function consumePlatinumBug(state, cards) {
    const bug = [...state.field].filter((unit) => !unit.waiting && unit.card_no === state.bugNo)
      .sort((left, right) => left.uid - right.uid)[0];
    if (!bug) return false;
    // 移り先は**呼び出し元に決めさせない**。Python `_consume_platinum_bug` と同じ
    // 共通規則（uid昇順・waiting除外の白のF契約/封印F契約スピリット）で選ぶ。
    // 煌臨経路だけが「いま煌臨したユニット」を渡していたため、契約スピリットが
    // 2体並んだ瞬間からuidの小さい既存の1体を飛ばし、同じ盤面でPythonと別の
    // ユニットへ契約煌臨元が積まれていた（seed 20260815のA-1不一致の原因）。
    // 自分の`bugDiscountFundingPenalty`も共通規則で原資を見積もっているので、
    // 呼び出し元指定は見積もりとも食い違っていた。
    const target = fContractWhiteSpiritTarget(state, cards, bug.uid);
    state.reserve += bug.cores;
    if (bug.soul_core) state.reserveHasSoul = true;
    state.field.splice(state.field.indexOf(bug), 1);
    state.recurring = state.recurring.filter((entry) => entry.uid !== bug.uid);
    if (target) target.kourin_stack = [state.bugNo, ...(target.kourin_stack || [])];
    record(state, cards, "field_left", { card_no: state.bugNo, uid: bug.uid,
      cause: "own_effect", destination: target ? "kourin_base" : "vanish",
      target_uid: target?.uid ?? null, moved_card_nos: target ? [state.bugNo] : [],
      cores_returned: bug.cores });
    return true;
  }

  /** 倍率が数える『自分の場のユニット』か。Python `_amount_per_unit_matches` と同一。 */
  function amountPerUnitMatches(spec, unit, state, cards) {
    if (unit.waiting) return false;
    const card = cards[unit.card_no] || {};
    const types = spec.target_types || [];
    if (types.length
      && !types.some((word) => (card.card_type || "").endsWith(word))) return false;
    if (spec.color && !(card.colors || []).includes(spec.color)) return false;
    const lineages = spec.target_lineages || [];
    if (lineages.length
      && !lineages.some((value) => (card.lineages || []).includes(value))) return false;
    // 名前は部分一致(「自分の「ドール」1体につき」)。並ぶときはどれかに当たれば
    // 数える。比較はnormalizedNameを通す。
    const names = spec.target_names || [];
    if (names.length && !names.some(
      (name) => normalizedName(card.name).includes(normalizedName(name)))) {
      return false;
    }
    // 「【アブソリューツ】を持つ自分のスピリット」。所持はkeywordsだけで見る。
    if (spec.target_keyword && !(card.keywords || []).includes(spec.target_keyword)) {
      return false;
    }
    // 「自分の合体スピリット」はブレイヴが重なっている体(乗られているホスト側)。
    if (spec.combined_only && !combinedBraves(state, unit.uid).length) return false;
    return true;
  }

  /** 倍率(「〜Nにつき」)。倍率を持たない節は1、数えられない主語は0。
   *  Python `_amount_per_multiplier` と同一。 */
  function amountPerMultiplier(effect, state, cards) {
    const spec = effect.amount_per;
    if (!spec) return 1;
    const per = spec.per || 1;
    let value;
    if (spec.subject === "count") value = state.count;
    else if (spec.subject === "own_hand") value = state.hand.length;
    else if (spec.subject === "own_field_units") {
      value = state.field.filter(
        (unit) => amountPerUnitMatches(spec, unit, state, cards)).length;
    } else return 0;
    return Math.floor(value / per);
  }

  function resolveEffect(state, cards, targets, effect, sourceUid) {
    if (!effectActive(effect, state, cards, sourceUid)) return false;
    // 倍率は`amount`へ掛けてから通常の解決へ渡す(Pythonも`resolve_enabler`の
    // 入口で同じことをする)。0回なら`amount`が0になり、対象を1つも取らない。
    const amount = (effect.amount ?? 0) * amountPerMultiplier(effect, state, cards);
    if (effect.kind === "face_up_top_cycle") {
      return resolveFaceUpTopCycle(state, cards, targets, effect, sourceUid);
    }
    if (effect.kind === "draw") {
      // 山札が尽きていても「ドローの節は解決した」。Python `resolve_enabler`は
      // `draw()`を呼んで常に`success`を返し、実際に増えたかは`changed`側で見る。
      // ここで0枚を「不発」にすると、Pythonが解決済みと書く節をWorkerだけ
      // 不発と書く(seed 20260817の戦闘モードで発覚)。
      draw(state, cards, amount, "effect");
      return true;
    }
    if (effect.kind === "coreboost") {
      state.reserve += amount;
      recordCoreMove(state, cards, { amount, source: "void", destination: "reserve",
        reason: "coreboost", source_card_no: effect.source_card_no, source_uid: sourceUid });
      return amount > 0;
    }
    if (effect.kind === "self_coreboost" || effect.kind === "field_coreboost") {
      const targetMatches = (unit) => {
        if (effect.kind === "self_coreboost") return unit.uid === sourceUid;
        const card = cards[unit.card_no];
        const spec = effect.target_spec || "";
        if (!spec.includes("創界神") && (card.lineages || []).includes("創界神")) return false;
        if (spec.includes("このスピリット以外") && unit.uid === sourceUid) return false;
        const types = ["スピリット", "アルティメット", "ブレイヴ", "ネクサス"]
          .filter((value) => spec.includes(value));
        if (types.length && !types.some((value) => (card.card_type || "").includes(value))) return false;
        const colors = BASIC_COLORS.filter((value) => spec.includes(value));
        if (colors.length && !colors.some((value) => (card.colors || []).includes(value))) return false;
        // 系統・名前はPython(`parse_condition`)が`系統:銀零`のような短縮記法から
        // 解いてIRへ載せている。ここで生テキストを見ると「」が無い書き方を取り
        // こぼし、「銀零のスピリットへ」が「どのスピリットでもよい」になる。
        const lineages = effect.target_lineages || [];
        if (lineages.length
          && !lineages.some((value) => (card.lineages || []).includes(value))) return false;
        if (effect.target_name
          && !normalizedName(card.name).includes(normalizedName(effect.target_name))) return false;
        const names = [...spec.matchAll(/「([^」]+)」/gu)].map((match) => match[1]);
        return !names.length || spec.includes("系統")
          || names.some((name) => normalizedName(card.name).includes(normalizedName(name)));
      };
      const unit = [...state.field].filter((row) => !row.waiting && targetMatches(row))
        .sort((left, right) => accessTier(left.card_no, cards, targets)
          - accessTier(right.card_no, cards, targets)
          || Number(left.uid !== sourceUid) - Number(right.uid !== sourceUid)
          || right.cores - left.cores || left.uid - right.uid)[0];
      if (!unit) return false;
      unit.cores += amount;
      recordCoreMove(state, cards, { amount, source: "void", destination: "field",
        reason: effect.kind, source_card_no: effect.source_card_no,
        source_uid: sourceUid, target_uid: unit.uid });
      return amount > 0;
    }
    if (effect.kind === "count_gain") {
      return applyCountGain(state, cards, amount, effect.cap, {
        source_card_no: effect.source_card_no, source_uid: sourceUid });
    }
    if (effect.kind === "search") {
      const pool = takeTopSlice(state, effect.reveal || 0);
      state.dig += pool.length;
      state.openPoolStack.push(pool);
      if (pool.length) record(state, cards, "cards_opened", {
        cards: pool, source_card_no: effect.source_card_no,
      });
      applyOpenReactions(state, cards, targets, pool, effect.source_card_no);
      const sourceUnit = state.field.find((unit) => unit.uid === sourceUid);
      const slots = (effect.condition_slots || [{ condition: effect.condition || [null, null], limit: effect.amount }])
        .filter((slot) => countRequirementsMet(slot.count_requirements, state.count)
          && stateConditionsMet(slot.state_conditions, state, cards)
          && (!slot.requires_source_kourin || (sourceUnit?.kourin_stack || []).length)
          && (slot.additional_cost || 0) <= reclaimable(state, true, cards));
      // Python `resolve_search` と同じ優先規則。
      // ①手札/狙い札にF契約煌臨があるなら、その**煌臨先になれる公開札**を優先
      //   （カード番号で名指しせず、「その札が場にあったら」という仮の盤面を
      //   既存の煌臨先判定へ渡して決める）。
      // ②バシリスクの公開の特別扱い（ファラ最優先）は廃止した（2026-08-15
      //   ユーザー判断）。公開の目的は他のサーチと同じで、共通規則で足りる。
      const searchTargets = new Set(targets);
      const kourinInHand = [...new Set([...state.hand, ...targets])]
        .filter((cardNo) => cards[cardNo] && isFKourin(cards[cardNo]));
      if (kourinInHand.length) {
        for (const candidateNo of new Set(pool)) {
          const candidate = cards[candidateNo];
          if (!candidate) continue;
          const hypothetical = { ...state, field: [{
            uid: 0, card_no: candidateNo, cores: candidate.maintenance || 0,
            floor: candidate.maintenance || 0, waiting: false, kourin_stack: [],
            brave_mode: null, soul_core: false, creator_core: false, exhausted: false,
          }] };
          if (kourinInHand.some((kourinNo) =>
            kourinHosts(cards[kourinNo], hypothetical, cards).length)) {
            searchTargets.add(candidateNo);
          }
        }
      }
      const result = chooseFromPool(pool, slots, cards, searchTargets);
      const additionalCost = result.picked_slots.reduce((sum, row) =>
        sum + (row.cards.length ? row.slot.additional_cost || 0 : 0), 0);
      if (additionalCost) {
        const deficit = additionalCost - state.reserve;
        if (deficit > 0) fundPayment(state, cards, targets, deficit, true);
        payFromReserve(state, additionalCost, 0);
        state.reserve -= additionalCost;
        state.spent += additionalCost;
        recordCoreMove(state, cards, { amount: additionalCost,
          source: "reserve", destination: "trash", reason: "search_additional_cost",
          source_card_no: effect.source_card_no, source_uid: sourceUid });
      }
      state.hand.push(...result.picked);
      result.picked.forEach((cardNo) => state.seen.add(cardNo));
      state.handGain += result.picked.length;
      recordCardSelection(state, cards, { cards: result.picked, source: "open",
        destination: "hand", reason: "search",
        source_card_no: effect.source_card_no });
      let leftover = effect.leftover || "bottom";
      if (leftover === "top_or_bottom") {
        leftover = chooseTopOrBottom(result.remaining, state.hand, cards);
      }
      putRemainder(state, cards, result.remaining, leftover, effect.source_card_no);
      if (state.openPoolStack.at(-1) !== pool) {
        throw new Error("open pool resolution order mismatch");
      }
      state.openPoolStack.pop();
      const repeatCost = effect.repeat_cost || 0;
      if ((effect.repeat_times || 0) > 0 && state.deck.length
          && repeatCost <= reclaimable(state, true, cards)) {
        if (repeatCost) {
          const deficit = repeatCost - state.reserve;
          if (deficit > 0) fundPayment(state, cards, targets, deficit, true);
          payFromReserve(state, repeatCost, 0);
          state.reserve -= repeatCost;
          state.spent += repeatCost;
          recordCoreMove(state, cards, { amount: repeatCost,
            source: "reserve", destination: "trash", reason: "search_repeat_cost",
            source_card_no: effect.source_card_no, source_uid: sourceUid });
        }
        resolveEffect(state, cards, targets,
          { ...effect, repeat_cost: 0, repeat_times: 0 }, sourceUid);
      }
      return true;
    }
    if (effect.kind === "oracle_mill") {
      const sourceUnit = state.field.find((unit) => unit.uid === sourceUid);
      if (!sourceUnit) return false;
      if (effect.same_name_policy === "none_existing"
          && state.field.some((unit) => unit.uid !== sourceUid
            && unit.card_no === effect.source_card_no)) return false;
      if (effect.same_name_policy === "once_per_turn") {
        if (state.oracleNameUsed.has(effect.source_card_no)) return false;
        state.oracleNameUsed.add(effect.source_card_no);
      }
      // Python v56 removes oracle cards by value rather than by top-slice
      // position.  Duplicate card numbers therefore consume the lowest
      // matching copy first.  Preserve that observable v56 behavior until a
      // Stage version bump changes both runtimes together.
      const pool = peekTopSlice(state, amount);
      clearRemovedFaceUpTop(state, pool.length);
      for (const cardNo of pool) {
        // 下→上なので、``list.remove``が消す「最初の一致」＝一番下のコピーは`indexOf`。
        const index = state.deck.indexOf(cardNo);
        if (index >= 0) state.deck.splice(index, 1);
      }
      state.dig += pool.length;
      state.oraclePool = [...pool];
      state.trashCards.push(...pool);
      // 落ちたカード自身の「《神託》でトラッシュに置かれたら手札に加えられる」。
      applyTrashReactions(state, cards, pool, effect.source_card_no, true);
      // Python は `if slot and slot.get("alternatives")` で**alternatives形の
      // スロットに限って**数える(神託のコア加算はその形でしか構造化していない)。
      // このガードが無いと、条件付きの普通のスロットでJSだけコアが増える。
      if (sourceUnit && (effect.condition_slot?.alternatives || []).length) {
        sourceUnit.cores += pool.filter((cardNo) =>
          Boolean(cardMatchesSlot(cards[cardNo], effect.condition_slot))).length;
      }
      // Pythonは有効な《神託》の窓へ到達した時点を解決済みとし、山札0枚でも
      // `oracle_name_used`等の内部状態が動けば`resolved=true`になる。山札枚数だけで
      // 判定すると、デッキ切れ直前の詳細棋譜でWorkerだけfalseになる。
      return true;
    }
    if (effect.kind === "oracle_pickup") {
      const slots = effect.condition_slots || [effect.condition_slot];
      const result = chooseFromPool(state.oraclePool, slots, cards, targets);
      for (const cardNo of result.picked) {
        const index = state.trashCards.indexOf(cardNo);
        if (index >= 0) state.trashCards.splice(index, 1);
      }
      state.oraclePool = result.remaining;
      state.hand.push(...result.picked);
      state.handGain += result.picked.length;
      result.picked.forEach((cardNo) => state.seen.add(cardNo));
      return result.picked.length > 0;
    }
    if (["recover", "self_recover"].includes(effect.kind)) {
      const pool = [...state.trashCards];
      const slots = effect.kind === "self_recover"
        ? [{ alternatives: [{ name_exact: cards[effect.self_card_no]?.name }], limit: amount || 1 }]
        : (effect.condition_slots || [{ condition: effect.condition || [null, null], limit: effect.amount }]);
      const result = chooseFromPool(pool, slots, cards, targets);
      if (DEBUG_LOOKAHEAD) {
        console.log(`      RECOVER t=${state.turn} pool=${JSON.stringify(pool)} `
          + `picked=${JSON.stringify(result.picked)}`);
      }
      for (const cardNo of result.picked) state.trashCards.splice(state.trashCards.indexOf(cardNo), 1);
      state.hand.push(...result.picked);
      state.handGain += result.picked.length;
      result.picked.forEach((cardNo) => state.seen.add(cardNo));
      recordCardSelection(state, cards, { cards: result.picked, source: "trash",
        destination: "hand", reason: "recover", source_card_no: effect.source_card_no });
      return result.picked.length > 0;
    }
    if (effect.kind === "field_core_remove") {
      // 相手の場全体からコアをamount個。**基準は脅威度ではなく「落とせるか」**
      // ——2個しか取れないならコア3個の大物は落とせないので、脅威度で劣っても
      // コア1〜2個の体から取る。落とすのに要る個数は`cores - floor + 1`で、
      // 維持コア0のカードは何個抜いても落ちない(自動的に候補から外れる)。
      // Python `_resolve_field_core_remove` と同一。
      const board = state.combatOpponent;
      if (!board) return false;
      const where = effect.core_destination || "reserve";
      const order = COMBAT_TARGET_ORDERS.bp_desc;
      let budget = amount;
      let taken = 0;
      while (budget > 0) {
        const rows = board.field().filter((row) => row.cores > 0);
        if (!rows.length) break;
        // 維持コア0は「必要数=コア数+1」でそもそも取り切れないので候補にしない。
        const killable = rows.filter(
          (row) => row.floor > 0 && row.cores - row.floor + 1 <= budget);
        let target;
        let want;
        if (killable.length) {
          killable.sort(order);
          target = killable[0];
          want = target.cores - target.floor + 1;
        } else {
          rows.sort(order);
          target = rows[0];
          want = Math.min(budget, target.cores);
        }
        const moved = board.remove_cores(target.uid, want, where);
        if (!moved) break;
        taken += moved;
        budget -= moved;
      }
      return taken > 0;
    }
    if (effect.kind === "life_core_remove") {
      // 相手のライフのコアを退かす(ライフバーン)。対象選択が無いので
      // ユニット干渉の経路は通らない——ライフはユニットではないので、
      // 種別照合にも並べ替えにも乗らない。Python `_resolve_life_core_remove`と同一。
      const board = state.combatOpponent;
      if (!board) return false;
      return Boolean(board.damage_life(amount, effect.core_destination || "reserve"));
    }
    if (["unit_destroy", "unit_exhaust", "unit_core_remove", "unit_bounce",
      "unit_heavy_exhaust", "unit_bp_down"].includes(effect.kind)) {
      // 相手盤面への干渉(6B-3)。対象の選び方は**決定論的**でなければ両ランタイムが
      // 割れるので、BPの高い順→コストの高い順→uid昇順で上からamount体まで。
      // Python `_combat_pick_targets` と同一。
      const board = state.combatOpponent;
      if (!board) return false;
      const types = effect.target_types || [];
      // 自己参照の閾値はここで束縛する。literalと併記されたら**厳しいほう**を採り、
      // 発揮元が場から消えていて値が取れないなら緩めるのではなく撃たない。
      // Python `_combat_pick_targets` と同一。
      const tighten = (literal, refKey, statKey) => {
        if (effect[refKey] !== "self") return literal;
        const value = combatSelfStat(state, cards, sourceUid, statKey);
        if (value === null || value === undefined) return NaN;
        return (literal === null || literal === undefined)
          ? value : Math.min(literal, value);
      };
      const bpMax = tighten(effect.target_bp_max, "target_bp_max_ref", "bp");
      const costMax = tighten(effect.target_cost_max, "target_cost_max_ref", "cost");
      const symbolsMax = tighten(
        effect.target_symbols_max, "target_symbols_max_ref", "symbol_count");
      if (Number.isNaN(bpMax) || Number.isNaN(costMax) || Number.isNaN(symbolsMax)) {
        return false;
      }
      const rows = board.field().filter((row) => {
        if (types.length && !types.some((word) => (row.card_type || "").endsWith(word))) {
          return false;
        }
        if (bpMax !== null && bpMax !== undefined && row.bp > bpMax) return false;
        if (costMax !== null && costMax !== undefined && row.cost > costMax) return false;
        // 「回復状態の」は疲労も重疲労もしていないもの。「疲労状態の」は重疲労を
        // **含む**(重疲労は疲労を含む状態なのでexhaustedも立つ)。
        if (effect.target_state === "exhausted" && !row.exhausted) return false;
        if (effect.target_state === "refreshed" && row.exhausted) return false;
        // 「[ソウルコア]が置かれている相手のスピリット」「置かれていない〜」。
        // 印字が言っていなければ不問(null)。Python `target_soul_core` と同一。
        if (effect.target_soul_core !== null && effect.target_soul_core !== undefined
            && Boolean(row.soul_core) !== effect.target_soul_core) return false;
        if (symbolsMax !== null && symbolsMax !== undefined
            && row.symbol_count > symbolsMax) return false;
        const coresMin = effect.target_cores_min;
        const coresMax = effect.target_cores_max;
        if (coresMin !== null && coresMin !== undefined && row.cores < coresMin) return false;
        if (coresMax !== null && coresMax !== undefined && row.cores > coresMax) return false;
        // 疲労は既に疲労しているものを対象にしない。
        if (effect.kind === "unit_exhaust" && row.exhausted) return false;
        // コア除去はコアを持たないものを対象にしない。
        if (effect.kind === "unit_core_remove" && !(row.cores > 0)) return false;
        // 重疲労は既に重疲労のものを対象にしない(疲労しているだけなら有効)。
        if (effect.kind === "unit_heavy_exhaust" && row.heavy_exhausted) return false;
        return true;
      });
      if (!rows.length) return false;
      rows.sort(COMBAT_TARGET_ORDERS[effect.target_order || "bp_desc"]);
      if (effect.kind === "unit_core_remove") {
        // amountは**1体あたりのコア数**なので、対象は1体だけ選ぶ。
        return Boolean(board.remove_cores(
          rows[0].uid, amount, effect.core_destination || "reserve"));
      }
      // 印字が「最もBPの高い」等と順を固定していないバウンスは、現在ステップの
      // 詰み、勝利/敗北期限、手札へ返す再使用リスクで複数対象を組として選ぶ。
      // 旧式の盤面mockは必要な口を持たないので従来順へフォールバックする。
      const smartBounce = effect.kind === "unit_bounce" && !effect.target_order
        && typeof board.units === "function" && typeof board.life === "function";
      const picked = smartBounce ? selectBounceTargets(
        rows, amount, effect.bounce_destination || "hand", {
          ownLife: state.life,
          ownUnits: combatUnits(state, cards),
          opponentLife: board.life(),
          opponentUnits: board.units(),
          reuseRisk: typeof board.bounce_reuse_risk === "function"
            ? (row) => board.bounce_reuse_risk(row) : null,
        }) : rows.slice(0, amount);
      let applied;
      if (effect.kind === "unit_destroy") {
        applied = picked.filter((row) => board.destroy(row.uid, "effect"));
      } else if (effect.kind === "unit_bounce") {
        const where = effect.bounce_destination || "hand";
        applied = picked.filter((row) => board.bounce(row.uid, where));
      } else if (effect.kind === "unit_heavy_exhaust") {
        applied = picked.filter((row) => board.heavy_exhaust(row.uid));
      } else if (effect.kind === "unit_bp_down") {
        applied = picked.filter((row) => board.bp_down(
          row.uid, effect.bp_amount, effect.bp_scope || "battle",
          Boolean(effect.destroy_at_zero)));
      } else {
        applied = picked.filter((row) => board.exhaust(row.uid));
      }
      return applied.length > 0;
    }
    if (effect.kind === "stash_top") {
      const cardsToStash = peekTopSlice(state, amount);
      clearRemovedFaceUpTop(state, cardsToStash.length);
      for (const cardNo of cardsToStash) {
        // stash_topもPythonは``deck.remove``なので一番下のコピーから消える。
        const index = state.deck.indexOf(cardNo);
        if (index >= 0) state.deck.splice(index, 1);
        state.sideCards.push(cardNo);
        state.seen.add(cardNo);
      }
      state.sideGain += cardsToStash.length;
      state.dig += cardsToStash.length;
      return cardsToStash.length > 0;
    }
    if (effect.kind === "side_recover") {
      const slots = effect.condition_slots || [{ condition: effect.condition || [null, null], limit: effect.amount }];
      const result = chooseFromPool(state.sideCards, slots, cards, targets);
      for (const cardNo of result.picked) state.sideCards.splice(state.sideCards.indexOf(cardNo), 1);
      state.hand.push(...result.picked);
      state.handGain += result.picked.length;
      result.picked.forEach((cardNo) => state.seen.add(cardNo));
      recordCardSelection(state, cards, { cards: result.picked, source: "side",
        destination: "hand", reason: "side_recover", source_card_no: effect.source_card_no });
      if (effect.stash_per_pick) {
        resolveEffect(state, cards, targets, {
          kind: "stash_top", amount: result.picked.length,
        }, sourceUid);
      }
      return result.picked.length > 0;
    }
    if (effect.kind === "deck_discard_draw") {
      // 『破棄することで1枚ドロー』は捨てる分に加えて**引く1枚**が要る
      // (Pythonのb3_deck_discard_draw_available)。この門が無いと、山札が
      // ちょうどdiscard枚のときWorkerだけが撃ち、しかも捨ててからfalseを返すので
      // 山札が減った状態で失敗する——Pythonは山札に触れずに撃たない。
      if (effect.requires_successful_draw
          && state.deck.length < (effect.discard || 0) + 1) return false;
      // Pythonは``deck.pop()``をdiscard回。捨てる順はトップから。
      const discarded = [];
      while (discarded.length < (effect.discard || 0) && state.deck.length) {
        discarded.push(takeTopCard(state));
      }
      if (discarded.length < (effect.discard || 0)) return false;
      state.trashCards.push(...discarded);
      state.dig += discarded.length;
      draw(state, cards, effect.draw || 0, "deck_discard_draw");
      return true;
    }
    if (effect.kind === "hand_filter") {
      // 手札側も同じ(Pythonのb3_hand_discard_draw_available)。捨てる札が手札に
      // 足りているか、山札が空でないかを**捨てる前に**見る。
      const handDiscardRequired = effect.discard || 0;
      if (effect.requires_successful_draw
          && !(handDiscardRequired > 0 && state.hand.length >= handDiscardRequired
               && state.deck.length > 0)) return false;
      if (effect.draw_first) draw(state, cards, effect.draw || 0, "hand_filter");
      const discard = effect.discard_all ? state.hand.length : Math.min(effect.discard || 0, state.hand.length);
      const ordered = chooseHandDiscards(
        state, cards, targets, discard, Boolean(effect.discard_all));
      for (const cardNo of ordered) {
        state.hand.splice(state.hand.indexOf(cardNo), 1);
        state.trashCards.push(cardNo);
      }
      if (!effect.draw_first) draw(state, cards, effect.draw || 0, "hand_filter");
      if (effect.draw_per_discard) draw(state, cards, ordered.length * effect.draw_per_discard, "hand_filter");
      return true;
    }
    if (effect.kind === "core_to_trash") {
      state.spent += amount;
      recordCoreMove(state, cards, { amount, source: "void", destination: "trash",
        reason: "core_to_trash", source_card_no: effect.source_card_no,
        source_uid: sourceUid });
      return amount > 0;
    }
    if (effect.kind === "life_core_move") {
      if (amount <= 0 || state.life - amount < 1
          || !["reserve", "trash"].includes(effect.destination)) return false;
      const ordinary = state.life - Number(state.lifeHasSoul);
      const sealedActive = state.field.some((unit) => !unit.waiting
        && cards[unit.card_no]?.has_sealed_effect);
      const takesSoul = state.lifeHasSoul && (!sealedActive || amount > ordinary);
      state.life -= amount;
      if (takesSoul) {
        state.lifeHasSoul = false;
        if (effect.destination === "reserve") state.reserveHasSoul = true;
        else state.trashHasSoul = true;
      }
      if (effect.destination === "reserve") state.reserve += amount;
      else state.spent += amount;
      return true;
    }
    if (effect.kind === "exchange") {
      const pool = takeTopSlice(state, effect.reveal || 0);
      if (!pool.length) return false;
      state.dig += pool.length;
      state.openPoolStack.push(pool);
      if (pool.length) record(state, cards, "cards_opened", {
        cards: pool, source_card_no: effect.source_card_no,
      });
      applyOpenReactions(state, cards, targets, pool, effect.source_card_no);
      const slots = effect.condition_slots || [{ condition: effect.condition || [null, null], limit: effect.amount }];
      const selection = chooseFromPool(pool, slots, cards, targets);
      // Python `choose_exchange_cards`(stage4_selection.py)と同じ規約:
      // **得になる交換だけ行う**。公開札はtier昇順・コスト昇順で見て、手札から
      // 「それより tier が悪い(数値が大きい)」札が出せるときだけ入れ替える。
      // 出せる札が無い公開札は交換せず、残りとしてデッキへ戻す。
      const tierOf = (cardNo) => accessTier(cardNo, cards, targets);
      const costOf = (cardNo) => cards[cardNo]?.cost || 0;
      const candidates = [...selection.picked].sort((left, right) =>
        tierOf(left) - tierOf(right) || costOf(left) - costOf(right));
      // Pythonは (tier, cost) の降順。同値の並びは元の手札順のまま(安定ソート)。
      const outgoing = state.hand.map((cardNo, index) => ({ cardNo, index }))
        .sort((left, right) => tierOf(right.cardNo) - tierOf(left.cardNo)
          || costOf(right.cardNo) - costOf(left.cardNo));
      const picked = [];
      const returned = [];
      const usedIndices = new Set();
      for (const candidate of candidates) {
        const choice = outgoing.find((item) => !usedIndices.has(item.index)
          && tierOf(item.cardNo) > tierOf(candidate));
        if (!choice) {
          selection.remaining.push(candidate);
          continue;
        }
        usedIndices.add(choice.index);
        returned.push(choice.cardNo);
        picked.push(candidate);
      }
      for (const cardNo of returned) state.hand.splice(state.hand.indexOf(cardNo), 1);
      // Pythonと同じく、手札から交換に出した札はデッキへ戻すまで公開処理領域に
      // 実在する。これが無いと`exchange_return`のsnapshotで札がどのzoneにもいない。
      pool.push(...returned);
      const destination = effect.destination || "hand";
      if (destination === "side") {
        state.sideCards.push(...picked);
        state.sideGain += picked.length;
      } else {
        state.hand.push(...picked);
        state.handGain += picked.length;
      }
      picked.forEach((cardNo) => state.seen.add(cardNo));
      recordCardSelection(state, cards, { cards: picked, source: "open",
        destination, reason: "exchange_pick", source_card_no: effect.source_card_no });
      recordCardSelection(state, cards, { cards: returned, source: "hand",
        destination: "open", reason: "exchange_return", source_card_no: effect.source_card_no });
      // 交換しなかった公開札(selection.remainingへ戻したものを含む)。
      const unpicked = [...selection.remaining];
      let revealedDestination = effect.revealed_destination || effect.leftover || "bottom";
      let returnedDestination = effect.returned_destination || effect.leftover || "bottom";
      // Pythonは交換側でも `_resolve_top_or_bottom` を呼ぶ。ここを一律bottomに
      // 潰すと、次のオープン系エンジンで掘り直せる残余を沈めてしまい山順が違う。
      if (revealedDestination === "top_or_bottom") {
        revealedDestination = chooseTopOrBottom(unpicked, state.hand, cards);
      }
      if (returnedDestination === "top_or_bottom") {
        returnedDestination = chooseTopOrBottom(returned, state.hand, cards);
      }
      if (revealedDestination === "bottom" && returnedDestination === "bottom") {
        // Pythonは「手札から戻す札」と「公開したまま選ばなかった札」を1本の
        // bottom-to-top列として同時に戻し、由来も位置ごとに記録する。
        const returnedCards = [...returned, ...unpicked];
        const cardSources = [
          ...returned.map(() => "hand"), ...unpicked.map(() => "open"),
        ];
        state.deck.unshift(...returnedCards);
        if (returnedCards.length) {
          record(state, cards, "cards_returned_to_deck", {
            cards: returnedCards, destination: "bottom", order: "bottom_to_top",
            reason: "exchange_combined_return", source_card_no: effect.source_card_no,
            card_sources: cardSources,
          });
        }
      } else {
        const returnExchangeGroup = (group, destination, reason) => {
          if (!group.length) return;
          if (destination === "trash") state.trashCards.push(...group);
          else if (destination === "top") state.deck.push(...group);
          else state.deck.unshift(...group);
          record(state, cards, "cards_returned_to_deck", {
            cards: group, destination, order: "bottom_to_top", reason,
            source_card_no: effect.source_card_no,
          });
        };
        returnExchangeGroup(
          unpicked, revealedDestination, "exchange_open_remainder");
        returnExchangeGroup(
          returned, returnedDestination, "exchange_hand_return");
      }
      if (state.openPoolStack.at(-1) !== pool) {
        throw new Error("open pool resolution order mismatch");
      }
      state.openPoolStack.pop();
      return Boolean(picked.length && returned.length);
    }
    if (effect.kind === "reveal_play_remainder") {
      if (effect.requires_predecessor_id
          && !state.completedEffects.has(effect.requires_predecessor_id)) return false;
      if (effect.requires_predecessor_id) state.completedEffects.delete(effect.requires_predecessor_id);
      const pool = takeTopSlice(state, effect.reveal || 0);
      if (!pool.length) return false;
      state.dig += pool.length;
      state.openPoolStack.push(pool);
      if (pool.length) record(state, cards, "cards_opened", {
        cards: pool, source_card_no: effect.source_card_no,
      });
      applyOpenReactions(state, cards, targets, pool, effect.source_card_no);
      pool.forEach((cardNo) => state.seen.add(cardNo));
      const selection = chooseFromPool(pool, effect.condition_slots || [], cards, targets);
      const remaining = [...pool];
      for (const cardNo of selection.picked) {
        const index = remaining.indexOf(cardNo);
        if (index < 0 || !summonConditionsMet(cards[cardNo], state, cards)) continue;
        const maintenance = cards[cardNo].maintenance || 0;
        if (maintenance > reclaimable(state, true, cards)) continue;
        remaining.splice(index, 1);
        state.hand.push(cardNo);
        play(state, cards, targets, { card_no: cardNo, pay: 0, total: maintenance,
          maintenance, brave_mode: braveMode(cards[cardNo], state, cards),
          allow_sacrifice: true, mode: "normal" });
      }
      if (effect.remainder_destination === "hand") {
        state.hand.push(...remaining);
        state.handGain += remaining.length;
      } else if (effect.remainder_destination === "side") {
        state.sideCards.push(...remaining);
        state.sideGain += remaining.length;
      } else state.trashCards.push(...remaining);
      if (state.openPoolStack.at(-1) !== pool) {
        throw new Error("open pool resolution order mismatch");
      }
      state.openPoolStack.pop();
      return true;
    }
    if (effect.kind === "token_spawn") {
      const token = state.bugNo ? cards[state.bugNo] : null;
      if (!token || !String(effect.token_name || "").includes(token.name)) return false;
      const maintenance = token.maintenance || 0;
      const source = state.field.find((unit) => unit.uid === sourceUid);
      // 生成元が場を離れていたらトークンは出ない(Python `_create_platinum_bug`の
      // `source_uid not in field_units`と同じガード)。これが無いと、離れた後でも
      // リザーブからコアを払ってバグを1体多く作ってしまう。
      if (!source) return false;
      // 「自分が出したトークンだけ」を賄える札が先、次に「誰が出したものでも
      // よい」札(Python `_platinum_bug_core_supply_source`と同じ順)。
      let supplyKey = cards[source.card_no]?.token_void_funding === "own"
        ? `own_creation:${sourceUid}` : null;
      if (supplyKey && state.bugCoreSupplyUsed.has(supplyKey)) supplyKey = null;
      if (!supplyKey) {
        const funder = state.field.find((unit) => !unit.waiting
          && cards[unit.card_no]?.token_void_funding === "any"
          && !state.bugCoreSupplyUsed.has(`any_creation:${unit.uid}`));
        if (funder) supplyKey = `any_creation:${funder.uid}`;
      }
      let soulCore = false;
      if (supplyKey) state.bugCoreSupplyUsed.add(supplyKey);
      else {
        if (maintenance > reclaimable(state, true, cards)) return false;
        const deficit = maintenance - state.reserve;
        if (deficit > 0 && !fundPayment(state, cards, targets, deficit, true)) return false;
        soulCore = payFromReserve(state, 0, maintenance);
        state.reserve -= maintenance;
      }
      state.uid += 1;
      state.field.push({ uid: state.uid, card_no: state.bugNo, cores: maintenance,
        floor: maintenance, symbols: token.symbols || {}, brave_mode: null,
        creator_core: false, waiting: false, exhausted: false,
        soul_core: soulCore, kourin_stack: [] });
      recordCoreMove(state, cards, { amount: maintenance,
        source: supplyKey ? "void" : "reserve", destination: "field", reason: "platinum_bug_entry",
        source_uid: sourceUid, target_uid: state.uid });
      const faraSources = faraSourceCount(state);
      if (faraSources) applyCountGain(state, cards, faraSources, 10, {
        reason: "platinum_bug_entry", source_card_no: state.flagNo,
        source_uid: sourceUid, source_count: faraSources });
      return true;
    }
    if (effect.kind === "creator_core_transfer") {
      if (effect.requires_successful_followup === "reveal_play_remainder" && !state.deck.length) return false;
      const donors = state.field.filter((unit) => {
        const donor = cards[unit.card_no];
        if (unit.waiting || unit.cores - unit.floor < amount
            || !(donor.lineages || []).includes("創界神")) return false;
        if (effect.source_requirement === "blue") return (donor.colors || []).includes("青");
        if (effect.source_requirement === "six_color") {
          return BASIC_COLORS.every((color) => (donor.colors || []).includes(color));
        }
        return true;
      }).sort((left, right) => right.cores - left.cores || left.uid - right.uid);
      if (!donors.length) return false;
      let target = null;
      if (effect.destination !== "reserve") {
        if (effect.destination_scope === "self") {
          target = state.field.find((unit) => unit.uid === sourceUid);
          if (!target || !(cards[target.card_no]?.card_type || "").includes("スピリット")) return false;
        } else {
          target = [...state.field].filter((unit) => !unit.waiting
            && (cards[unit.card_no]?.card_type || "").includes("スピリット"))
            .sort((left, right) => left.uid - right.uid)[0];
          if (!target) return false;
        }
      }
      donors[0].cores -= amount;
      if (target) target.cores += amount;
      else state.reserve += amount;
      return true;
    }
    // rz7_kourin_searchは2026-08-16に削除(汎用searchが印字どおりに解く)。
    if (effect.kind === "driving_force") {
      const pool = takeTopSlice(state, amount);
      state.dig += pool.length;
      state.openPoolStack.push(pool);
      if (pool.length) record(state, cards, "cards_opened", {
        cards: pool, source_card_no: effect.source_card_no,
      });
      applyOpenReactions(state, cards, targets, pool, effect.source_card_no);
      let picked = [];
      const candidates = pool.filter((cardNo) => {
        const card = cards[cardNo];
        return (card?.is_brave && (card.lineages || []).includes("異魔神")) || isFKourin(card);
      }).sort((left, right) => Number(!targets.has(left)) - Number(!targets.has(right))
        || accessTier(left, cards, targets) - accessTier(right, cards, targets)
        || left.localeCompare(right));
      if (candidates.length) picked = [candidates[0]];
      const selected = [];
      for (const cardNo of picked) {
        const index = pool.indexOf(cardNo);
        if (index >= 0) selected.push(pool.splice(index, 1)[0]);
      }
      state.hand.push(...selected);
      selected.forEach((cardNo) => state.seen.add(cardNo));
      state.handGain += selected.length;
      recordCardSelection(state, cards, { cards: selected, source: "open",
        destination: "hand", reason: effect.kind, source_card_no: effect.source_card_no });
      state.trashCards.push(...pool);
      recordCardSelection(state, cards, { cards: pool, source: "open",
        destination: "trash", reason: `${effect.kind}_open`, source_card_no: effect.source_card_no });
      if (state.openPoolStack.at(-1) !== pool) {
        throw new Error("open pool resolution order mismatch");
      }
      state.openPoolStack.pop();
      {
        let deploy = state.trashCards.find((cardNo) =>
          (cards[cardNo]?.card_type || "").includes("フラッグネクサス"));
        let stackHost = null;
        if (!deploy) {
          stackHost = state.field.find((unit) => (unit.kourin_stack || []).some((cardNo) =>
            (cards[cardNo]?.card_type || "").includes("フラッグネクサス")));
          deploy = stackHost?.kourin_stack.find((cardNo) =>
            (cards[cardNo]?.card_type || "").includes("フラッグネクサス"));
        }
        if (deploy) {
          play(state, cards, targets, { card_no: deploy, pay: 0, total: 0,
            maintenance: cards[deploy].maintenance || 0, brave_mode: null,
            allow_sacrifice: false, mode: "free_deploy",
            source_zone: stackHost ? "kourin" : "trash",
            source_host_uid: stackHost?.uid ?? null });
        }
      }
      return true;
    }
    return effect.kind === "oracle_watch";
  }

  function fundPayment(state, cards, targets, needed, allowSacrifice) {
    let remaining = needed;
    // **リザーブへの反映はこの関数を出るとき**。Pythonは`_fund_deficit`が捻出量を
    // 返すだけで、加算するのは呼び出し元(`reserve += _fund_deficit(...)`)なので、
    // ループの中で記録する`core_moved`が写す盤面ではリザーブがまだ増えていない。
    // JSが逐次足していたため、**同じイベントの盤面だけが1以上ずれていた**
    // (詳細モードでのみ出る。2026-08-21、剣獣ヘルメスの検証デッキで露見)。
    let banked = 0;
    const queued = [];
    const finalizeQueued = () => {
      for (const unit of queued.splice(0)) {
        deferFieldLeave(state, () => {
          const stack = [...(unit.kourin_stack || []), unit.card_no];
          state.trashCards.push(...stack.filter((cardNo) => !cards[cardNo]?.is_token));
          state.field.splice(state.field.indexOf(unit), 1);
          state.recurring = state.recurring.filter((entry) => entry.uid !== unit.uid);
          record(state, cards, "field_left", { card_no: unit.card_no,
            uid: unit.uid, cause: "cost",
            destination: cards[unit.card_no]?.is_token ? "vanish" : "trash",
            moved_card_nos: stack.filter((cardNo) => !cards[cardNo]?.is_token),
            cores_returned: unit.cores });
        });
      }
    };
    for (const unit of state.field) {
      if (unit.creator_core || unit.waiting) continue;
      const free = Math.max(0, unit.cores - unit.floor);
      const take = Math.min(free, remaining);
      const ordinaryFree = Math.max(
        0, unit.cores - Number(Boolean(unit.soul_core)) - unit.floor);
      if (take > ordinaryFree) {
        unit.soul_core = false;
        state.reserveHasSoul = true;
      }
      unit.cores -= take;
      remaining -= take;
      // **記録はリザーブへ足す前**。Pythonは`_fund_deficit`の中で`reclaimed`を
      // 数えるだけで、リザーブに反映するのは呼び出し元なので、この`core_moved`が
      // 写す盤面ではリザーブがまだ増えていない。JSが先に足すと**同じイベントの
      // 盤面だけが1ずれる**(詳細モードで露見、2026-08-21)。
      if (take) recordCoreMove(state, cards, { amount: take,
        source: "field", destination: "reserve", reason: "payment_funding",
        source_uid: unit.uid });
      banked += take;
      if (!remaining) { state.reserve += banked; finalizeQueued(); return true; }
    }
    if (!allowSacrifice) { state.reserve += banked; return false; }
    const unitPreservesHandReduction = (unit) => {
      if (!unit.symbols || !Object.keys(unit.symbols).length) return false;
      const without = { ...state, field: state.field.filter((row) => row.uid !== unit.uid) };
      return state.hand.some((cardNo) =>
        paymentForState(without, cards, cards[cardNo]).pay
          > paymentForState(state, cards, cards[cardNo]).pay);
    };
    const ordered = [...state.field].filter((unit) => unit.cores > 0 && !unit.creator_core
        && !unit.waiting && !sacrificeProtected(unit, cards))
      .sort((left, right) =>
        Number(unitPreservesHandReduction(left)) - Number(unitPreservesHandReduction(right))
        || accessTier(right.card_no, cards, targets) - accessTier(left.card_no, cards, targets)
        || (cards[left.card_no].cost || 0) - (cards[right.card_no].cost || 0));
    for (const unit of ordered) {
      const reclaimed = unit.cores;
      remaining -= reclaimed;
      // 記録はリザーブへ足す前(上と同じ理由。Python同一)。
      recordCoreMove(state, cards, { amount: reclaimed,
        source: "field", destination: "reserve", reason: "payment_funding",
        source_uid: unit.uid });
      banked += reclaimed;
      if (unit.soul_core) {
        state.reserveHasSoul = true;
        unit.soul_core = false;
      }
      unit.cores = 0;
      unit.waiting = true;
      record(state, cards, "field_leave_queued", { card_no: unit.card_no,
        uid: unit.uid, cause: "cost" });
      queued.push(unit);
      state.sacrifice += 1;
      if (remaining <= 0) { state.reserve += banked; finalizeQueued(); return true; }
    }
    state.reserve += banked;
    finalizeQueued();
    return false;
  }

  function payFromReserve(state, pay, maintenance, preferSoulForPay = false) {
    let ordinary = state.reserve - Number(state.reserveHasSoul);
    const forcedSoulPay = Number(Boolean(preferSoulForPay && state.reserveHasSoul
      && pay > 0 && ordinary >= (pay - 1) + maintenance));
    const normalPay = Math.min(pay - forcedSoulPay, ordinary);
    ordinary -= normalPay;
    const soulToPay = forcedSoulPay || (pay - normalPay);
    const normalMaintenance = Math.min(maintenance, ordinary);
    const soulToMaintenance = maintenance - normalMaintenance;
    if (soulToPay) {
      state.reserveHasSoul = false;
      state.trashHasSoul = true;
    } else if (soulToMaintenance) {
      state.reserveHasSoul = false;
    }
    return Boolean(soulToMaintenance);
  }

  function requirementMet(reaction, count) {
    if (reaction.comparison === ">=") return count >= reaction.threshold;
    if (reaction.comparison === "<=") return count <= reaction.threshold;
    return count === reaction.threshold;
  }

  /** バースト解決の続きに、コストを払って本体効果も撃つ(印字48種)。
   *  Python `_resolve_burst_paid_followup` と同一。印字は「その後コストを支払う
   *  ことで、このカードのメイン/フラッシュ効果を発揮する」。撃てる本体効果があり、
   *  **盤面を壊さずに**払えるときだけ払う(`allow_sacrifice=false`)。
   *  払える原資をそもそも残すかどうかは1つ前のメインステップの判断(6C-3)。 */
  function burstPaidFollowup(state, cards, targets, cardNo, effect) {
    const card = cards[cardNo];
    if (!(card.enablers || []).some((row) => row.mode === "on_play")) return false;
    const cost = paymentForState(state, cards, card);
    if (cost.total > reclaimable(state, false, cards)) return false;
    return play(state, cards, targets, {
      card_no: cardNo, pay: cost.pay, total: cost.total,
      maintenance: card.maintenance || 0, brave_mode: null,
      allow_sacrifice: false, mode: "burst_paid_followup",
      followup_timing: effect.followup_timing ?? null,
    });
  }

  function resolveBurstEffects(state, cards, targets, cardNo) {
    const card = cards[cardNo];
    if (!card) return false;
    let selfPlayed = false;
    let returnedToHand = false;
    const resolvedChoiceGroups = new Set();
    for (const effect of card.burst_effects || []) {
      const choiceGroup = effect.exclusive_group;
      if (choiceGroup !== null && choiceGroup !== undefined
          && resolvedChoiceGroups.has(choiceGroup)) continue;
      if (effect.kind === "burst_free_play_self") {
        selfPlayed = play(state, cards, targets, {
          card_no: cardNo, pay: 0, total: card.maintenance || 0,
          maintenance: card.maintenance || 0, brave_mode: braveMode(card, state, cards),
          allow_sacrifice: true, mode: "burst_free_play",
        });
      } else if (effect.kind === "burst_return_self_to_hand") {
        // 「その後、このカードを手札に戻す」(BS14-X02)。場へ出ないがトラッシュへも
        // 行かない、3つ目の行き先。
        state.hand.push(cardNo);
        record(state, cards, "card_moved",
          { card_no: cardNo, destination: "hand", reason: "burst_resolved" });
        returnedToHand = true;
      } else if (effect.kind === "burst_pay_own_effect") {
        if (selfPlayed || returnedToHand) continue;
        selfPlayed = burstPaidFollowup(state, cards, targets, cardNo, effect);
      } else {
        record(state, cards, "effect_start", { card_no: cardNo,
          effect_kind: effect.kind, source: "burst" });
        const resolved = resolveEffect(state, cards, targets, effect, null);
        record(state, cards, "effect_complete", { card_no: cardNo,
          effect_kind: effect.kind, source: "burst", resolved });
        flushCountReactions(state, cards, targets);
        // Pythonと同じく、先頭枝が対象不在なら次の「または」へフォールバックし、
        // どれか1枝が解決したら同じグループの残りは実行しない。
        if (choiceGroup !== null && choiceGroup !== undefined && resolved) {
          resolvedChoiceGroups.add(choiceGroup);
        }
      }
    }
    // 発動したバーストカードは、場へ出なければトラッシュへ行く。Pythonは
    // 2026-08-17までここを積んでおらず、発動したカードがどのゾーンにも無い状態に
    // なっていた(掃検が緑だったのは、開いたバーストが自分を召喚する型だったから)。
    // 棋譜へも書く——移動を書かないと詳細モードで追えない。
    if (!selfPlayed && !returnedToHand) {
      state.trashCards.push(cardNo);
      record(state, cards, "card_moved",
        { card_no: cardNo, destination: "trash", reason: "burst_resolved" });
    }
    for (const source of [...state.field].sort((a, b) => a.uid - b.uid)) {
      const effect = cards[source.card_no]?.after_burst_open;
      if (!effect || source.waiting || levelFor(source, cards) < (effect.required_level || 1)) {
        continue;
      }
      record(state, cards, "effect_start", { card_no: source.card_no, uid: source.uid,
        effect_kind: "after_burst_open" });
      const resolved = resolveAfterBurstOpen(state, cards, targets, source, effect);
      record(state, cards, "effect_complete", { card_no: source.card_no, uid: source.uid,
        effect_kind: "after_burst_open", resolved });
    }
    while (state.deferredPlayCompletions.length) {
      state.deferredPlayCompletions.shift()();
    }
    return true;
  }

  function resolveAfterBurstOpen(state, cards, targets, source, effect) {
    const opened = takeTopSlice(state, effect.reveal || 0);
    if (!opened.length) return false;
    state.dig += opened.length;
    opened.forEach((cardNo) => state.seen.add(cardNo));
    record(state, cards, "cards_opened", { cards: [...opened],
      source_card_no: source.card_no, reason: "after_burst_open" });
    const burst = opened.map((cardNo, index) => ({ cardNo, index,
      tier: accessTier(cardNo, cards, targets) }))
      .filter((row) => (cards[row.cardNo]?.burst_effects || []).length)
      .sort((a, b) => a.tier - b.tier || a.index - b.index)[0];
    if (burst) {
      opened.splice(opened.indexOf(burst.cardNo), 1);
      setBurst(state, cards, burst.cardNo, "effect");
    }
    const wanted = new Set(effect.summon_lineages || []);
    const summoned = opened.map((cardNo, index) => ({ cardNo, index,
      tier: accessTier(cardNo, cards, targets) }))
      .filter((row) => (cards[row.cardNo]?.card_type || "").includes("スピリット")
        && (cards[row.cardNo]?.lineages || []).some((lineage) => wanted.has(lineage)))
      .sort((a, b) => a.tier - b.tier || a.index - b.index)[0];
    let pending = null;
    if (summoned) {
      const card = cards[summoned.cardNo];
      const brave = braveMode(card, state, cards);
      const pay = effect.summon_cost || 0;
      const total = pay + (brave === "combine" ? 0 : (card.maintenance || 0));
      if (total <= reclaimable(state, true, cards)) {
        opened.splice(opened.indexOf(summoned.cardNo), 1);
        pending = { card_no: summoned.cardNo, pay, total,
          maintenance: card.maintenance || 0, brave_mode: brave,
          allow_sacrifice: true, mode: "after_burst_open" };
      }
    }
    if (opened.length) {
      state.trashCards.push(...opened);
      recordCardSelection(state, cards, { cards: [...opened], source: "open",
        destination: "trash", reason: "after_burst_open_remainder",
        source_card_no: source.card_no });
    }
    if (pending) {
      state.hand.push(pending.card_no);
      play(state, cards, targets, pending);
    }
    return true;
  }

  function flushCountReactions(state, cards, targets) {
    if (state.countReactionDeferral > 0) return;
    while (state.pendingCountEvents.length) {
      const payload = state.pendingCountEvents.shift();
      if (state.burst) {
        const cardNo = state.burst;
        const reaction = (cards[cardNo]?.burst_reactions || []).find((row) =>
          row.event === "count_increased" && requirementMet(row, payload.new_count));
        if (reaction) {
          state.burst = null;
          resolveBurstEffects(state, cards, targets, cardNo);
        }
      }
      for (const cardNo of [...state.hand]) {
        const card = cards[cardNo];
        const reaction = (card?.hand_count_reactions || []).find((row) =>
          row.event === "count_increased" && requirementMet(row, payload.new_count));
        if (!reaction || (reaction.name_restriction
            && state.handReactionNames.has(reaction.name_restriction))) continue;
        const total = reaction.summon_cost + (card.maintenance || 0);
        if (!summonConditionsMet(card, state, cards)
            || total > reclaimable(state, false, cards)) continue;
        if (play(state, cards, targets, { card_no: cardNo, pay: reaction.summon_cost,
          total, maintenance: card.maintenance || 0, brave_mode: null,
          allow_sacrifice: false, mode: "hand_reaction" })) {
          if (reaction.name_restriction) state.handReactionNames.add(reaction.name_restriction);
        }
      }
    }
  }

  function moveKourinSoul(state, host, destination) {
    const source = kourinSoulSource(state, host, destination);
    if (source === "reserve") {
      state.reserve -= 1;
      state.reserveHasSoul = false;
    } else if (source === "life") {
      state.life -= 1;
      state.lifeHasSoul = false;
    } else if (source === "field") {
      host.cores -= 1;
      host.soul_core = false;
    } else return false;
    if (destination === "life") {
      state.life += 1;
      state.lifeHasSoul = true;
    } else {
      state.spent += 1;
      state.trashHasSoul = true;
    }
    return true;
  }

  function payManifestation(state, creatorUid) {
    const source = manifestationSoulSource(state);
    const creator = state.field.find((unit) => unit.uid === creatorUid);
    if (!source || !creator || creator.waiting
        || creator.cores - Number(source.unit?.uid === creatorUid) < 1) return false;
    if (source.zone === "reserve") {
      state.reserve -= 1;
      state.reserveHasSoul = false;
    } else if (source.zone === "life") {
      state.life -= 1;
      state.lifeHasSoul = false;
    } else {
      source.unit.cores -= 1;
      source.unit.soul_core = false;
    }
    creator.cores -= 1;
    state.spent += 2;
    state.trashHasSoul = true;
    return true;
  }

  function resolveSoulPaidBraveFreeSummon(state, cards, targets, sourceCardNo) {
    const choices = [];
    for (const [zoneName, zone] of [["trash", state.trashCards], ["hand", state.hand]]) {
      zone.forEach((cardNo, index) => {
        const candidate = cards[cardNo];
        if (!candidate?.is_brave || !summonConditionsMet(candidate, state, cards)) return;
        const mode = braveMode(candidate, state, cards);
        const total = mode === "combine" ? 0 : (candidate.maintenance || 0);
        if (total > reclaimable(state, true, cards)) return;
        choices.push({ cardNo, zoneName, index, mode, total,
          zoneRank: zoneName === "trash" ? 0 : 1,
          tier: accessTier(cardNo, cards, targets), cost: candidate.cost || 0 });
      });
    }
    choices.sort((left, right) => left.zoneRank - right.zoneRank
      || left.tier - right.tier || right.cost - left.cost || left.index - right.index);
    const selected = choices[0];
    if (!selected) return false;
    if (selected.zoneName === "trash") {
      state.trashCards.splice(state.trashCards.indexOf(selected.cardNo), 1);
      state.hand.push(selected.cardNo);
      record(state, cards, "card_moved", { card_no: selected.cardNo,
        source: "trash", destination: "hand",
        reason: "soul_paid_free_summon_staging", source_card_no: sourceCardNo });
    }
    record(state, cards, "effect_free_summon_declared", { card_no: selected.cardNo,
      source: selected.zoneName, source_card_no: sourceCardNo,
      brave_mode: selected.mode, printed_cost_waived: true });
    return play(state, cards, targets, { card_no: selected.cardNo,
      pay: 0, total: selected.total, maintenance: cards[selected.cardNo].maintenance || 0,
      brave_mode: selected.mode, allow_sacrifice: true,
      mode: "soul_paid_free_summon" });
  }

  function resolvePlayedEffects(state, cards, targets, card, uid, braveMode,
                                soulCoreUsedForSummonCost = false) {
    let predecessor = { resolved: true, changed: true, kind: null };
    let gatesNext = false;
    const opponent = MAIN_STEP_OPPONENTS.get(state) || null;
    for (const effect of card.on_play_opponent_effects || []) {
      if (braveMode === "spirit" && effect.combine_only) continue;
      const beforeUids = new Set(opponent ? opponent.field().map((row) => row.uid) : []);
      record(state, cards, "effect_start", { card_no: card.card_no, uid,
        effect_kind: effect.kind, target_side: "opponent" });
      const previous = state.combatOpponent || null;
      state.combatOpponent = opponent;
      let resolved = false;
      try {
        resolved = opponent ? resolveEffect(state, cards, targets, effect, uid) : false;
      } finally {
        state.combatOpponent = previous;
      }
      const afterUids = new Set(opponent ? opponent.field().map((row) => row.uid) : []);
      const vanished = [...beforeUids].some((targetUid) => !afterUids.has(targetUid));
      const drawAmount = vanished ? (effect.draw_if_vanished || 0) : 0;
      if (drawAmount) draw(state, cards, drawAmount, "opponent_unit_vanished");
      record(state, cards, "effect_complete", { card_no: card.card_no, uid,
        effect_kind: effect.kind, target_side: "opponent", resolved,
        unit_vanished: vanished, followup_draw: drawAmount });
    }
    let replacedEffectKind = null;
    if (card.soul_paid_on_play && soulCoreUsedForSummonCost) {
      const special = card.soul_paid_on_play;
      record(state, cards, "effect_start", { card_no: card.card_no, uid,
        effect_kind: special.kind });
      const resolved = resolveSoulPaidBraveFreeSummon(
        state, cards, targets, card.card_no);
      record(state, cards, "effect_complete", { card_no: card.card_no, uid,
        effect_kind: special.kind, resolved });
      replacedEffectKind = special.replaces_effect_kind || null;
    }
    const active = (card.enablers || []).filter((effect) => effect.mode === "on_play"
      && effect.kind !== replacedEffectKind
      && !(braveMode === "spirit" && effect.combine_only));
    const processedSimultaneous = new Set();
    for (const effect of active) {
      if (effect.simultaneous_group) {
        if (processedSimultaneous.has(effect.simultaneous_group)) continue;
        processedSimultaneous.add(effect.simultaneous_group);
        const members = active.filter((candidate) =>
          candidate.simultaneous_group === effect.simultaneous_group);
        record(state, cards, "effect_start", { card_no: card.card_no, uid,
          effect_kind: "simultaneous", effect_kinds: members.map((row) => row.kind),
          simultaneous_group: effect.simultaneous_group });
        const traceMark = state.events.length;
        const results = members.map((member) =>
          effectActive(member, state, cards, uid)
            ? resolveEffect(state, cards, targets, member, uid) : false);
        record(state, cards, "effect_complete", { card_no: card.card_no, uid,
          effect_kind: "simultaneous", effect_kinds: members.map((row) => row.kind),
          simultaneous_group: effect.simultaneous_group,
          resolved: results.every(Boolean) });
        if (state.trace) {
          const finalState = stateView(state, cards);
          for (const event of state.events.slice(traceMark)) event.state = clone(finalState);
        }
        predecessor = { resolved: results.at(-1) || false,
          changed: results.at(-1) || false, kind: members.at(-1)?.kind || null };
        gatesNext = false;
        continue;
      }
      if (gatesNext && !predecessor.resolved) { gatesNext = false; continue; }
      if (effect.requires_predecessor_changed
          && (predecessor.kind !== effect.requires_predecessor_changed || !predecessor.changed)) continue;
      if (!effectActive(effect, state, cards, uid)) {
        predecessor = { resolved: false, changed: false, kind: effect.kind };
        gatesNext = Boolean(effect.gates_next_effect);
        continue;
      }
      // `effect_id`は載せない——Python `_record("effect_start", ...)`が持たない
      // フィールドで、載せると**詳細モードだけ**が最初のon_playで割れる(実測)。
      // 詳細モードは掃検の既定ではないので、この差は長らく見えていなかった。
      record(state, cards, "effect_start", { card_no: card.card_no, uid,
        effect_kind: effect.kind });
      // `changed`はPythonの`EffectResult.changed`と同じ意味＝**その節が実際に
      // 状態を動かしたか**。以前は「stateViewが1文字でも変わったか」で代用して
      // いたが、それでは大音楽堂のように「3枚オープンして戻しただけ（交換は
      // 不成立）」でも真になり、「この効果で入れ替えたとき」のカウント+1が
      // 誤って発火する。各resolverの戻り値をそのまま使う。
      const changed = resolveEffect(state, cards, targets, effect, uid);
      // Python `EffectResult.success(changed)`は、交換が0枚でも「節は解決済み」
      // (`resolved=true`)とし、後続の「入れ替えたとき」はchangedだけで止める。
      const resolved = effect.kind === "exchange" ? true : changed;
      record(state, cards, "effect_complete", { card_no: card.card_no, uid,
        effect_kind: effect.kind, resolved });
      predecessor = { resolved, changed, kind: effect.kind };
      gatesNext = Boolean(effect.gates_next_effect);
      if (effect.effect_id && resolved) state.completedEffects.add(effect.effect_id);
    }
    const recurring = (card.enablers || []).filter((effect) => effect.mode === "recurring");
    if (recurring.length) state.recurring.push({ uid, effects: recurring });
  }

  /** 魂状態からの復帰。Python `play_card`の`kourin_soul_card_no`枝と同一。
   *
   *  宿主のユニットが無いので**新しいユニットを作り**、魂状態のカードをその
   *  煌臨元にする。コアは印字どおり「自分のフィールド/リザーブのコアを好きなだけ
   *  置く」——置くのはLv1を保てる最小限(`maintenance`)だけ。 */
  function playKourinFromSoul(state, cards, targets, candidate) {
    const card = cards[candidate.card_no];
    const soulCardNo = candidate.kourin_soul_card_no;
    if (!state.soulCards.includes(soulCardNo)) return false;
    const destination = isSealedKourin(card) ? "life" : "trash";
    const maintenance = card.maintenance || 0;
    const traceDetails = { mode: "kourin_from_soul", soul_card_no: soulCardNo,
      pay: 0, total: maintenance };
    record(state, cards, "play_presented", { card_no: candidate.card_no, ...traceDetails });
    record(state, cards, "cost_calculated", { card_no: candidate.card_no, ...traceDetails });
    state.hand.splice(state.hand.indexOf(candidate.card_no), 1);
    if (!moveKourinSoul(state, null, destination)) return false;
    if (destination === "life") state.sealedKourinNames.add(card.name);
    record(state, cards, "cost_paid", { card_no: candidate.card_no,
      payment: "soul_core", soul_destination: destination, ...traceDetails });
    if (maintenance > state.reserve) {
      fundPayment(state, cards, targets, maintenance - state.reserve, false);
    }
    state.reserve -= maintenance;
    state.uid += 1;
    const uid = state.uid;
    state.field.push({ uid, card_no: candidate.card_no, cores: maintenance,
      floor: maintenance, symbols: card.symbols || {}, brave_mode: null,
      creator_core: (card.lineages || []).includes("創界神"), waiting: false,
      exhausted: false, soul_core: false, kourin_stack: [soulCardNo] });
    if (maintenance) {
      recordCoreMove(state, cards, { amount: maintenance, source: "reserve",
        destination: "field", reason: "soul_kourin_entry", target_uid: uid });
    }
    // 魂状態から出たので、そのカードはもう魂状態ではない。
    state.soulCards.splice(state.soulCards.indexOf(soulCardNo), 1);
    record(state, cards, "card_entered", { card_no: candidate.card_no, uid,
      destination: "field", ...traceDetails });
    record(state, cards, "soul_state_left", { card_no: soulCardNo, uid, reason: "kourin" });
    state.played.add(candidate.card_no);
    state.playCounts[state.turn] = (state.playCounts[state.turn] || 0) + 1;
    beginEffectFrame(state);
    resolvePlayedEffects(state, cards, targets,
      { ...card, card_no: candidate.card_no }, uid, null);
    record(state, cards, "play_complete", { card_no: candidate.card_no, uid,
      ...traceDetails });
    if (state.effectFrameDepth === 1) flushCountReactions(state, cards, targets);
    endEffectFrame(state);
    return true;
  }

  function playKourin(state, cards, targets, candidate) {
    const card = cards[candidate.card_no];
    const host = state.field.find((unit) => unit.uid === candidate.kourin_host_uid);
    if (!host) return false;
    const destination = isSealedKourin(card) ? "life" : "trash";
    const traceDetails = { mode: "kourin", host_uid: host.uid, pay: 0, total: 0 };
    record(state, cards, "play_presented", { card_no: candidate.card_no, ...traceDetails });
    record(state, cards, "cost_calculated", { card_no: candidate.card_no, ...traceDetails });
    state.hand.splice(state.hand.indexOf(candidate.card_no), 1);
    if (!moveKourinSoul(state, host, destination)) return false;
    if (destination === "life") state.sealedKourinNames.add(card.name);
    record(state, cards, "cost_paid", { card_no: candidate.card_no,
      payment: "soul_core", soul_destination: destination, ...traceDetails });
    const oldCardNo = host.card_no;
    host.kourin_stack = [...(host.kourin_stack || []), oldCardNo];
    host.card_no = candidate.card_no;
    host.symbols = card.symbols || {};
    host.brave_mode = null;
    host.floor = card.maintenance || 0;
    if (isFKourin(card) && hasContractBase(host, state.fieldCoreKourinNo)) {
      while (host.cores < host.floor) {
        const source = state.field.filter((unit) => unit.uid !== host.uid
          && !unit.waiting && !unit.soul_core && unit.cores > 0)
          .sort((left, right) => Number(left.card_no !== state.bugNo)
            - Number(right.card_no !== state.bugNo) || left.uid - right.uid)[0];
        if (source) {
          source.cores -= 1;
          host.cores += 1;
          if (source.cores < source.floor) {
            // コア移動はファラ自身の効果。離れたバグは新しくF契約煌臨した白の
            // スピリットの契約土台として下へ入る。
            if (source.card_no === state.bugNo) {
              host.kourin_stack = [state.bugNo, ...host.kourin_stack];
              state.field.splice(state.field.indexOf(source), 1);
              state.recurring = state.recurring.filter((entry) => entry.uid !== source.uid);
            } else {
              // バグ以外は共通の「場を離れる」境界へ。土台にバグを持っていれば
              // その segment ごと別のF契約煌臨スピリットへ移る(Q31679)。
              finalizeFieldLeave(state, cards, source, "own_effect");
            }
          }
        } else if (state.reserve > 0) {
          state.reserve -= 1;
          host.cores += 1;
        } else return false;
      }
    }
    state.recurring = state.recurring.filter((entry) => entry.uid !== host.uid);
    record(state, cards, "card_entered", { card_no: candidate.card_no, uid: host.uid,
      destination: "kourin_stack", ...traceDetails });
    state.played.add(candidate.card_no);
    state.playCounts[state.turn] = (state.playCounts[state.turn] || 0) + 1;
    let basiliskBonus = false;
    const faraSources = isFKourin(card) ? faraSourceCount(state) : 0;
    if (faraSources) {
      applyCountGain(state, cards, faraSources, 10, {
        reason: "f_contract_kourin", source_card_no: state.flagNo,
        source_uid: host.uid, source_count: faraSources });
      // このカウント増加は**煌臨時効果より前**に反応させる。Python
      // `play_card`の煌臨枝は`runtime.begin()`の前に`apply_count_gain`を
      // 呼ぶので、そこでは深さ0＝手札カウント反応がその場で発揮し、煌臨した
      // カード自身のサーチはその後に解決する。Worker側は効果ごとの
      // `flushCountReactions`任せで順序が逆になり、**先にどちらがデッキを
      // 引くかが入れ替わって公開されるカードまで変わっていた**
      // （seed 20260816/20260818のA-1不一致の原因）。
      if (!state.effectFrameDepth) flushCountReactions(state, cards, targets);
    }
    // PythonはF契約煌臨そのもののカウント誘発を記録・解決した後、予約batchの
    // 煌臨時効果へ入り、そこでバシリスクの任意バグ破壊を選ぶ。
    basiliskBonus = Boolean(card.token_sacrifice_search_bonus)
      && consumePlatinumBug(state, cards);
    const effectCard = basiliskBonus ? { ...card,
      enablers: (card.enablers || []).map((effect) => effect.kind === "search"
        ? { ...effect, amount: (effect.amount ?? 0) + 1,
          condition_slots: (effect.condition_slots || []).map((slot) => ({
            ...slot, limit: slot.limit === null ? null : (slot.limit ?? 0) + 1,
          })) } : effect) } : card;
    // Pythonの予約batchは、煌臨時効果の途中で増えたカウント反応をbatch本体へ
    // 戻ってから解決する。ファラの「その後」のバグ破壊も同じbatch内なので、
    // ここで生じた反応だけは破壊（＝コア返却）の後まで待たせる。F契約煌臨
    // そのものによる直前のカウント反応は上で既に解決済み。
    if (faraSources) state.countReactionDeferral += 1;
    beginEffectFrame(state);
    resolvePlayedEffects(state, cards, targets,
      { ...effectCard, card_no: candidate.card_no }, host.uid, null);
    for (let index = 0; index < faraSources; index += 1) {
      if (!consumePlatinumBug(state, cards)) break;
    }
    if (faraSources) {
      state.countReactionDeferral -= 1;
      flushCountReactions(state, cards, targets);
    }
    record(state, cards, "play_complete", { card_no: candidate.card_no, uid: host.uid,
      ...traceDetails });
    if (state.effectFrameDepth === 1) flushCountReactions(state, cards, targets);
    endEffectFrame(state);
    return true;
  }

  function play(state, cards, targets, candidate) {
    if (candidate.mode === "kourin") return playKourin(state, cards, targets, candidate);
    if (candidate.mode === "kourin_from_soul") {
      return playKourinFromSoul(state, cards, targets, candidate);
    }
    const card = cards[candidate.card_no];
    if (candidate.total === card.token_sacrifice_summon_cost) {
      // 払えないと分かっているなら、**バグを消費する前に**断る。消費してから
      // 失敗すると、成立しなかったプレイが盤面を壊したまま戻ってしまう。
      if (candidate.total > reclaimable(state, false, cards)
          && (!candidate.allow_sacrifice
              || candidate.total + bugDiscountFundingPenalty(state, cards)
                > reclaimable(state, true, cards))) return false;
      if (!consumePlatinumBug(state, cards)) return false;
    }
    const watcherUnits = [...state.field];
    const mode = candidate.mode || "normal";
    const traceDetails = { mode, pay: candidate.pay, total: candidate.total };
    if (["normal", "manifestation"].includes(mode)) {
      traceDetails.creator_uid = candidate.manifestation_creator_uid ?? null;
      traceDetails.brave_mode = candidate.brave_mode;
    }
    if (mode === "free_deploy") {
      traceDetails.source_zone = candidate.source_zone;
      traceDetails.source_host_uid = candidate.source_host_uid ?? null;
    }
    if (mode === "burst_free_play") traceDetails.discard_reason = "burst_magic_resolved";
    if (mode === "burst_paid_followup") {
      traceDetails.followup_timing = candidate.followup_timing ?? null;
      traceDetails.discard_reason = "burst_magic_resolved";
    }
    record(state, cards, "play_presented", { card_no: candidate.card_no, ...traceDetails });
    record(state, cards, "cost_calculated", { card_no: candidate.card_no, ...traceDetails });
    // Pythonの手札カウント反応は、通常play_cardと違って提示直後に手札から外し、
    // その後で不足コアを捻出する。core_movedのsnapshotにも同じzone時点を出す。
    if (mode === "hand_reaction") {
      state.hand.splice(state.hand.indexOf(candidate.card_no), 1);
    }
    if (candidate.manifestation_creator_uid !== null
        && candidate.manifestation_creator_uid !== undefined
        && !payManifestation(state, candidate.manifestation_creator_uid)) return false;
    const deficit = candidate.total - state.reserve;
    if (deficit > 0 && !fundPayment(state, cards, targets, deficit, candidate.allow_sacrifice)) return false;
    // 手札を経由しない配置(ドライビングフォースのフラッグネクサス、バーストの
    // 自己召喚)は手札を触らない。経由させると、同名カードが手札にもあるとき
    // **別の1枚が消えて並びがずれる**(Python側はどちらもゾーンから直接出す)。
    if (!["free_deploy", "burst_free_play", "burst_paid_followup", "hand_reaction",
      "face_up_draw_replacement"].includes(mode)) {
      state.hand.splice(state.hand.indexOf(candidate.card_no), 1);
    }
    const preferSoulForPay = Boolean(card.soul_paid_on_play && state.reserveHasSoul
      && candidate.pay > 0
      && [...state.hand, ...state.trashCards].some((cardNo) => cards[cardNo]?.is_brave));
    const soulCoreUsedForSummonCost = Boolean(preferSoulForPay
      || (state.reserveHasSoul
        && candidate.pay > state.reserve - Number(state.reserveHasSoul)));
    if (card.soul_paid_on_play) {
      traceDetails.soul_core_used_for_summon_cost = soulCoreUsedForSummonCost;
    }
    const soulForUnit = payFromReserve(state, candidate.pay,
      candidate.total - candidate.pay, preferSoulForPay);
    state.reserve -= candidate.total;
    state.spent += candidate.pay;
    record(state, cards, "cost_paid", { card_no: candidate.card_no,
      payment: mode === "free_deploy" ? "none"
        : candidate.mode === "manifestation" ? "soul_core_and_cores" : "cores",
      ...traceDetails });
    // ドライビングフォースの配置元は、提示・コスト確定・支払いの間は元zoneに
    // 残り、支払い後に初めて場へ移る(Pythonのtrace時点と同じ)。
    if (mode === "free_deploy") {
      if (candidate.source_zone === "kourin") {
        const host = state.field.find((unit) => unit.uid === candidate.source_host_uid);
        const index = host?.kourin_stack.indexOf(candidate.card_no) ?? -1;
        if (index >= 0) host.kourin_stack.splice(index, 1);
      } else {
        const index = state.trashCards.indexOf(candidate.card_no);
        if (index >= 0) state.trashCards.splice(index, 1);
      }
    }
    // uidは場のカードの識別子。マジックはまず解決領域へ入り、場に残るものも
    // 印字の「その後」を守って効果解決後に採番・配置する。
    const isMagic = card.card_type === "マジック";
    const staysOnField = !isMagic || Boolean(card.stays_on_field);
    // 合体先は**場に出す前**に決める(出してから探すと自分自身が候補に混じる)。
    const combinedHost = candidate.brave_mode === "combine"
      ? braveCombineHosts(card, state, cards)[0] : null;
    if (!isMagic) state.uid += 1;
    let uid = !isMagic ? state.uid : null;
    if (!isMagic) {
      state.field.push({ uid, card_no: candidate.card_no,
        cores: candidate.brave_mode === "combine" ? 0 : candidate.maintenance,
        floor: candidate.brave_mode === "combine" ? 0 : candidate.maintenance,
        symbols: card.symbols || {}, brave_mode: candidate.brave_mode,
        // 合体先。Python `combined_host_uid` と同一。
        combined_host_uid: combinedHost ? combinedHost.uid : null,
        creator_core: (card.lineages || []).includes("創界神"), waiting: false,
        exhausted: false,
        soul_core: soulForUnit, kourin_stack: [] });
    }
    record(state, cards, "card_entered", { card_no: candidate.card_no, uid,
      destination: isMagic ? "resolution" : "field",
      ...traceDetails });
    state.played.add(candidate.card_no);
    state.playCounts[state.turn] = (state.playCounts[state.turn] || 0) + 1;
    const finishPlay = () => {
      beginEffectFrame(state);
      try {
        for (const watcher of watcherUnits) {
          const watcherCard = cards[watcher.card_no];
          for (const effect of watcherCard.enablers || []) {
            if (effect.kind === "oracle_watch"
                && cardMatchesSlot(card, effect.condition_slot)) {
              watcher.cores += 1;
            }
          }
        }
        // 手札カウント反応で召喚したときの「そうしたとき」節
        // (`hand_reaction_effects`)。Pythonの予約batchと同じく、カード自身の
        // 確定処理の中で解く。
        if (mode === "hand_reaction") {
          for (const effect of card.hand_reaction_effects || []) {
            resolveEffect(state, cards, targets, effect, uid);
          }
        }
        resolvePlayedEffects(state, cards, targets, { ...card, card_no: candidate.card_no },
          uid, candidate.brave_mode, soulCoreUsedForSummonCost);
        if (isMagic && staysOnField) {
          state.uid += 1;
          uid = state.uid;
          state.field.push({ uid, card_no: candidate.card_no,
            cores: candidate.maintenance || 0, floor: candidate.maintenance || 0,
            symbols: card.symbols || {}, brave_mode: null, combined_host_uid: null,
            creator_core: (card.lineages || []).includes("創界神"), waiting: false,
            exhausted: false, soul_core: false, kourin_stack: [] });
          record(state, cards, "card_moved", { card_no: candidate.card_no, uid,
            source: "resolution", destination: "field",
            reason: "resolved_self_placement", ...traceDetails });
        } else if (isMagic) {
          state.trashCards.push(candidate.card_no);
          record(state, cards, "card_moved", { card_no: candidate.card_no, uid,
            destination: "trash", ...traceDetails });
        }
        record(state, cards, "play_complete", {
          card_no: candidate.card_no, uid, ...traceDetails });
        // Python runtimeは予約した派生（カウント反応など）をplay_complete後、
        // 待機中の場離れをさらにその後で確定する。
        if (state.effectFrameDepth === 1) flushCountReactions(state, cards, targets);
      } finally {
        endEffectFrame(state);
      }
    };
    if (["burst_free_play", "burst_paid_followup"].includes(mode)) {
      state.deferredPlayCompletions.push(finishPlay);
    } else finishPlay();
    return true;
  }

  /** 「出す価値がある」札か。Python `_collect_playable` の `has_active_effect` と同一。
   *  `enablers`に載る効果だけでは足りない——契約フラッグネクサスと、トークン破壊で
   *  得をする札(印字から導いた属性)は、効果表に列が無くても出す価値がある。
   *  **光契約ミラーでは露見しない**: あのデッキの該当カードは軒並みon_play効果を
   *  持つので上の`active`が先に真になる。on_play効果を持たない札で初めて効く。 */
  function hasActiveEffect(card, candidate, state) {
    if ((card.enablers || []).some((effect) =>
      ["on_play", "recurring"].includes(effect.mode)
        && !(candidate.brave_mode === "spirit" && effect.combine_only))) return true;
    if (MAIN_STEP_OPPONENTS.has(state)
        && (card.on_play_opponent_effects || []).some((effect) =>
          !(candidate.brave_mode === "spirit" && effect.combine_only))) return true;
    if (candidate.card_no === state.flagNo) return true;
    if (card.token_sacrifice_search_bonus) return true;
    return card.token_sacrifice_summon_cost !== null
      && card.token_sacrifice_summon_cost !== undefined
      && state.field.some((unit) => !unit.waiting && unit.card_no === state.bugNo);
  }

  /** このプレイを払った後も、バーストの本体効果ぶんの原資が残るか(6C-3)。
   *  見るのは`_affordable`と同じ原資(リザーブ＋盤面を壊さずに動かせる余剰)——
   *  ターン末のLv積み上げはその余剰へ移すだけで支払い能力を落とさない。
   *  Python `_leaves_burst_hold` と同一。 */
  function leavesBurstHold(state, cards, total) {
    return reclaimable(state, false, cards) - total >= state.burstHoldFloor;
  }

  function playableCandidates(state, cards, targets) {
    return legalCandidates(state, cards, targets).flatMap((candidate) => {
      // 6C-3: 残す方針のときは、払った後の原資がその額を割るプレイを候補から
      // 外す。**合法性ではなく方針**なので`legalCandidates`は動かさない。
      if (state.burstHoldFloor && !leavesBurstHold(state, cards, candidate.total)) return [];
      const card = cards[candidate.card_no];
      const active = hasActiveEffect(card, candidate, state);
      if (active) return [{ ...candidate, setup_only: false }];
      if (card.card_type === "マジック") return [];
      const hypothetical = { ...state, field: [...state.field, {
        uid: state.uid + 1, card_no: candidate.card_no,
        cores: candidate.brave_mode === "combine" ? 0 : card.maintenance,
        floor: candidate.brave_mode === "combine" ? 0 : card.maintenance,
        symbols: card.symbols || {}, brave_mode: candidate.brave_mode,
        creator_core: (card.lineages || []).includes("創界神"), waiting: false,
        soul_core: false, kourin_stack: [],
      }] };
      // ⚠️ **「他の札」は手札の位置で数える**(2026-08-23修正)。card_noで除くと
      // **同名の2枚目が数えられない**——プチフェニル2枚が手札にあるとき、1枚目を
      // 出せば2枚目の軽減が1つ増えるので、これは立派なセットアップである。Python
      // `_collect_playable`は最初から`other_idx != idx`で位置を見ており、ここだけが
      // 取り残されていた。掃検では見えなかった: この候補は方針が採らないかぎり
      // 棋譜に出ず、⓪までの目的関数では一度も採られなかった。
      const setup = state.hand.some((otherNo, otherIndex) =>
        otherIndex !== candidate.hand_index
        && paymentForState(hypothetical, cards, cards[otherNo]).pay
          < paymentForState(state, cards, cards[otherNo]).pay);
      const boardSetup = Boolean(state.stage5c) && candidate.total <= state.reserve;
      return setup || boardSetup
        ? [{ ...candidate, setup_only: true, board_only: !setup }] : [];
    });
  }

  function performMirageSet(state, cards, targets, cardNo) {
    const card = cards[cardNo];
    const total = card?.mirage_cost;
    if (total === null || total === undefined || !state.hand.includes(cardNo)
        || total > reclaimable(state, true, cards)) return false;
    const deficit = total - state.reserve;
    if (deficit > 0 && !fundPayment(state, cards, targets, deficit, true)) return false;
    state.hand.splice(state.hand.indexOf(cardNo), 1);
    payFromReserve(state, total, 0);
    state.reserve -= total;
    state.spent += total;
    if (state.mirage) {
      state.hand.push(state.mirage);
      state.handGain += 1;
      state.seen.add(state.mirage);
    }
    state.mirage = cardNo;
    for (const effect of card.enablers || []) {
      if (effect.mode !== "on_set" || !effectActive(effect, state, cards, null)) continue;
      resolveEffect(state, cards, targets, effect, null);
    }
    record(state, cards, "mirage_set", { card_no: cardNo, source: "rule", cost: total });
    return true;
  }

  // 《神託》/《真・神託》の配置時ミルは常に3枚(Python側 ORACLE_MILL_AMOUNT)。
  // 枚数が書かれていない効果はこの値で見積もる。
  const ORACLE_MILL_AMOUNT = 3;

  /** 貪欲選択の見積もり。Python `_greedy_play_rest` の yield_amt と同じ数え方。 */
  function candidateYield(card, braveMode) {
    const rows = card.is_brave && braveMode !== "combine"
      ? (card.enablers || []).filter((row) => !row.combine_only)
      : (card.enablers || []);
    return rows.filter((row) => ["on_play", "recurring"].includes(row.mode))
      .reduce((sum, row) => {
        // Pythonは「キーがあればその値」を取るので、値がnullなら次のキーへは
        // 進まずミル既定値になる。?? で繋ぐと別の枝へ落ちて数え方がずれる。
        const value = "amount" in row ? row.amount
          : "draw" in row ? row.draw
            : "reveal" in row ? row.reveal : 0;
        return sum + (value === null || value === undefined ? ORACLE_MILL_AMOUNT : value);
      }, 0);
  }

  function candidateCompare(state, cards, targets, left, right) {
      const fundingTier = (candidate) => candidate.total <= state.reserve ? 0
        : candidate.total <= reclaimable(state, false, cards) ? 1 : 2;
      const leftYield = candidateYield(cards[left.card_no], left.brave_mode);
      const rightYield = candidateYield(cards[right.card_no], right.brave_mode);
      return fundingTier(left) - fundingTier(right)
        || accessTier(left.card_no, cards, targets) - accessTier(right.card_no, cards, targets)
        || left.total - right.total || rightYield - leftYield
        || left.hand_index - right.hand_index;
  }

  function greedyRest(state, cards, targets, debugPlays = null) {
    while (true) {
      const candidates = playableCandidates(state, cards, targets)
        .filter((candidate) => !candidate.setup_only)
        .sort((left, right) => candidateCompare(state, cards, targets, left, right));
      if (!candidates.length) break;
      if (DEBUG_LOOKAHEAD) {
        console.log(`      GREEDY t=${state.turn} ${candidates[0].card_no} `
          + `mode=${candidates[0].brave_mode} total=${candidates[0].total}`);
      }
      const debugEntry = debugPlays ? {
        card_no: candidates[0].card_no, pay: candidates[0].pay,
        total: candidates[0].total, brave_mode: candidates[0].brave_mode ?? null,
        tier_key: [
          candidates[0].total <= state.reserve ? 0
            : candidates[0].total <= reclaimable(state, false, cards) ? 1 : 2,
          accessTier(candidates[0].card_no, cards, targets),
          candidates[0].total,
          -candidateYield(cards[candidates[0].card_no], candidates[0].brave_mode),
        ],
      } : null;
      if (debugEntry) debugPlays.push(debugEntry);
      if (!play(state, cards, targets, candidates[0])) break;
      if (debugEntry) debugEntry.after = {
        reserve: state.reserve, trash: state.spent, count: state.count,
        free_reclaimable: reclaimable(state, false, cards),
        reserve_has_soul: state.reserveHasSoul,
        life_has_soul: state.lifeHasSoul,
        trash_has_soul: state.trashHasSoul,
        field_cores: state.field.filter((unit) => !unit.waiting)
          .slice().sort((left, right) => left.uid - right.uid)
          .map((unit) => [unit.uid, unit.card_no, unit.cores, unit.floor,
            Boolean(unit.soul_core)]),
      };
    }
    return state.dig + state.handGain;
  }

  /** 辞書式にa > bか。Pythonのタプル比較と同じ順序にするためのもの
   *  ——項が4つに増えたので手書きの入れ子をやめた(2026-08-23、①)。 */
  function rankGreater(a, b) {
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return a[index] > b[index];
    }
    return false;
  }

  /** あと何ターンで削り切れるか(切り上げ)。届かないならnull。
   *  Python `stage4_sim.turns_to_finish` と同一。**定義はこの層に1つだけ**で、
   *  `stage6_sim.js`はこれを引く——アタックするかどうかと何をプレイするかが
   *  違う物差しを使うと、殴る気で組んだ盤面で殴らないが起きる(2026-08-23、①)。 */
  function turnsToFinish(life, damagePerAttacker) {
    if (damagePerAttacker <= 0 || life <= 0) return null;
    return Math.ceil(life / damagePerAttacker);
  }

  // 「削り切れない」を比較できる数にするための番人。Python `_UNREACHABLE_CLOCK`。
  const UNREACHABLE_CLOCK = 99;

  /** 厳密BP勝ちで防げるシンボル合計の最大値。Python
   *  `stage4_sim.winning_block_value`と同一。Stage6の壁配分とバウンス対象評価が
   *  同じmatchingを使うため、この層に置く。 */
  function winningBlockValue(attackers, blockers) {
    const attacks = [...(attackers || [])]
      .filter((row) => row && !row.exhausted)
      .sort((left, right) => left.bp - right.bp || left.uid - right.uid);
    const walls = [...(blockers || [])]
      .filter((row) => row && !row.exhausted)
      .sort((left, right) => left.bp - right.bp || left.uid - right.uid);
    if (!attacks.length || !walls.length) return 0;
    let previous = Array(walls.length + 1).fill(0);
    for (const attacker of attacks) {
      const current = Array(walls.length + 1).fill(0);
      for (let index = 1; index <= walls.length; index += 1) {
        const blocker = walls[index - 1];
        current[index] = Math.max(current[index - 1], previous[index]);
        if (blocker.bp > attacker.bp) {
          current[index] = Math.max(
            current[index], previous[index - 1] + (attacker.symbol_count || 0));
        }
      }
      previous = current;
    }
    return previous.at(-1);
  }

  function publicStepDamage(attackers, blockers, current = false) {
    const attacks = current
      ? [...(attackers || [])].filter((row) => !row.exhausted)
      : [...(attackers || [])].map((row) => ({ ...row, exhausted: false }));
    const walls = current
      ? [...(blockers || [])].filter((row) => !row.exhausted)
      : [...(blockers || [])].map((row) => ({ ...row, exhausted: false }));
    return Math.max(0, attacks.reduce(
      (sum, row) => sum + (row.symbol_count || 0), 0)
      - winningBlockValue(attacks, walls));
  }

  function rowCombinations(rows, count, start = 0, prefix = [], output = []) {
    if (prefix.length === count) {
      output.push([...prefix]);
      return output;
    }
    for (let index = start; index <= rows.length - (count - prefix.length); index += 1) {
      prefix.push(rows[index]);
      rowCombinations(rows, count, index + 1, prefix, output);
      prefix.pop();
    }
    return output;
  }

  /** 手札バウンス対象を、現在ステップの詰み→勝利/敗北期限→再使用リスクで選ぶ。
   *  Python `select_bounce_targets`と同一。複数対象は組全体を比較する。 */
  function selectBounceTargets(rows, amount, destination, context) {
    const count = Math.min(Math.max(Number(amount || 0), 0), rows.length);
    if (!count) return [];
    const ownUnits = [...(context.ownUnits || [])];
    const opponentUnits = [...(context.opponentUnits || [])];
    const opponentByUid = new Map(opponentUnits.map((row) => [row.uid, row]));
    const beforeWin = turnsToFinish(
      context.opponentLife, publicStepDamage(ownUnits, opponentUnits));
    const beforeLoss = turnsToFinish(
      context.ownLife, publicStepDamage(opponentUnits, ownUnits));
    const beforeOutNow = publicStepDamage(ownUnits, opponentUnits, true);
    const beforeInNow = publicStepDamage(opponentUnits, ownUnits, true);
    const finite = (clock) => clock === null ? UNREACHABLE_CLOCK : clock;
    const winsRace = (win, loss) => win !== null && (loss === null || win <= loss);
    const rank = (picked) => {
      const removed = new Set(picked.map((row) => row.uid));
      const remaining = opponentUnits.filter((row) => !removed.has(row.uid));
      const afterWin = turnsToFinish(
        context.opponentLife, publicStepDamage(ownUnits, remaining));
      const afterLoss = turnsToFinish(
        context.ownLife, publicStepDamage(remaining, ownUnits));
      const afterOutNow = publicStepDamage(ownUnits, remaining, true);
      const afterInNow = publicStepDamage(remaining, ownUnits, true);
      const risk = destination === "hand" && context.reuseRisk
        ? picked.reduce((sum, row) => sum + context.reuseRisk(row), 0) : 0;
      return [
        Number(beforeOutNow < context.opponentLife && context.opponentLife <= afterOutNow),
        Number(beforeInNow >= context.ownLife && context.ownLife > afterInNow),
        Number(winsRace(afterWin, afterLoss)),
        finite(beforeWin) - finite(afterWin),
        finite(afterLoss) - finite(beforeLoss),
        afterOutNow - beforeOutNow,
        beforeInNow - afterInNow,
        finite(afterLoss) - finite(afterWin),
        -risk,
        // Pythonは戦闘ユニットでない候補（ネクサス等）も候補行自身のシンボルで
        // 最終tie-breakする。Mapに無いと0へ落とすと、同時計のBS76-CX03より
        // シンボル0のトークンを選び、次のバウンス可否まで分岐していた。
        picked.reduce((sum, row) => sum
          + ((opponentByUid.get(row.uid) || row).symbol_count || 0), 0),
        picked.reduce((sum, row) => sum + (row.bp || 0), 0),
        picked.reduce((sum, row) => sum + (row.cost || 0), 0),
        ...picked.slice().sort((left, right) => left.uid - right.uid)
          .map((row) => -row.uid),
      ];
    };
    let best = null;
    let bestRank = null;
    for (const picked of rowCombinations(rows, count)) {
      const candidateRank = rank(picked);
      if (bestRank === null || rankGreater(candidateRank, bestRank)) {
        best = picked;
        bestRank = candidateRank;
      }
    }
    return best || [];
  }

  /** そのプレイで「削り切るまでの回数」がいくつ縮んだか。
   *  Python `stage4_sim.clock_gain` と同一。掘削と打点を素朴に足すと
   *  「1シンボル＝1枚ドロー」という根拠のない為替レートを決めることになるので、
   *  プランと同じターン数へ換算してから比べる。 */
  function clockGain(before, after) {
    if (before === null && after === null) return 0;
    return (before === null ? UNREACHABLE_CLOCK : before)
      - (after === null ? UNREACHABLE_CLOCK : after);
  }

  /** いま盤面で最も大きい体の打点(合体中のブレイヴを含む)。
   *  Python `_board_damage` と同一。`stage6_sim.js`の`reachableDamage`と
   *  同じ数え方に揃えてある。 */
  function boardDamage(state, cards) {
    return combatUnits(state, cards)
      .reduce((best, row) => Math.max(best, row.symbol_count), 0);
  }

  /** 相手を削り切るまでの残り回数。**相手が見えないときはnull**(単独のStage4)。
   *  Python `_clock_to_finish` と同一。相手ライフは公開情報。 */
  function clockToFinish(state, cards) {
    if (!state.opponentView) return null;
    return turnsToFinish(state.opponentView.life || 0, boardDamage(state, cards));
  }

  function chooseCandidate(state, cards, targets) {
    const candidates = playableCandidates(state, cards, targets);
    if (!candidates.length) return null;
    const choiceState = () => ({
      hand: [...state.hand], reserve: state.reserve, trash: state.spent, count: state.count,
      free_reclaimable: reclaimable(state, false, cards),
      reserve_has_soul: state.reserveHasSoul,
      life_has_soul: state.lifeHasSoul,
      trash_has_soul: state.trashHasSoul,
      hand_reaction_names: [...state.handReactionNames].sort(),
      field: state.field.filter((unit) => !unit.waiting)
        .slice().sort((left, right) => left.uid - right.uid)
        .map((unit) => ({ uid: unit.uid, card_no: unit.card_no, cores: unit.cores,
          floor: unit.floor, soul_core: Boolean(unit.soul_core),
          brave_mode: unit.brave_mode ?? null })),
    });
    const choiceMode = (candidate) => candidate.mode || "normal";
    if (candidates.length === 1 && !candidates[0].setup_only) {
      const candidate = candidates[0];
      if (state.choiceDebug) state.choiceDebug.push({
        turn: state.turn, state: choiceState(), baseline: null,
        candidates: [{ card_no: candidate.card_no, pay: candidate.pay,
          total: candidate.total, brave_mode: candidate.brave_mode ?? null,
          setup_only: false, mode: choiceMode(candidate), rank: null }],
        selected: { card_no: candidate.card_no, total: candidate.total,
          brave_mode: candidate.brave_mode ?? null },
      });
      return candidate;
    }
    const baseline = state.dig + state.handGain;
    const baselineTargetPlayable = state.targetPlayableTurn !== null
      || legalCandidates(state, cards, targets, targets).length > 0;
    // 打点の基準。相手が見えない単独のStage4ではnullのままで、gainは常に0に
    // なる——v56のgoldenはこの変更で動かない(2026-08-23、①)。
    const baselineClock = clockToFinish(state, cards);
    const debugRow = state.choiceDebug ? {
      turn: state.turn, state: choiceState(),
      baseline: { score: baseline, target_playable: baselineTargetPlayable,
        clock: baselineClock },
      candidates: [], selected: null,
    } : null;
    let best = null;
    let bestRank = null;
    for (const candidate of candidates) {
      const trial = clone(state);
      trial.trace = false;
      trial.events = [];
      if (!play(trial, cards, targets, candidate)) continue;
      const debugPlays = debugRow ? [] : null;
      const score = greedyRest(trial, cards, targets, debugPlays);
      const targetPlayable = legalCandidates(trial, cards, targets, targets).length > 0;
      // ⚠️ **ここに`gain`を足してはいけない**(2026-08-23、掃検が割れて戻した)。
      // 捨てるかどうかは候補集合そのものを変えるので、わずかな差が「1枚多く
      // プレイする/しない」へ増幅される。Python `_search_best_sequence` の
      // 同じ位置に理由を書いてある。
      if (candidate.setup_only && !state.stage5c && score === baseline
          && targetPlayable === baselineTargetPlayable) continue;
      const policyRank = candidate.setup_only ? -candidate.total : 1;
      const gain = clockGain(baselineClock, clockToFinish(trial, cards));
      // 打点は掘削の**次**。上に置くとコアが打点へ流れて契約技が撃てなくなる
      // (Python `_search_best_sequence` の但し書きと同じ)。
      const rank = [score, gain, Number(targetPlayable), policyRank];
      if (debugRow) debugRow.candidates.push({
        card_no: candidate.card_no, pay: candidate.pay, total: candidate.total,
        brave_mode: candidate.brave_mode ?? null, setup_only: candidate.setup_only,
        mode: choiceMode(candidate), score, clock_gain: gain,
        target_playable: targetPlayable, policy_rank: policyRank, rank: [...rank],
        greedy_plays: debugPlays,
      });
      if (DEBUG_LOOKAHEAD) {
        console.log(`    LOOKAHEAD t=${state.turn} ${candidate.card_no} `
          + `mode=${candidate.brave_mode} total=${candidate.total} `
          + `setup_only=${candidate.setup_only} rank=(${rank.join(", ")})`);
      }
      if (!bestRank || rankGreater(rank, bestRank)) {
        best = candidate;
        bestRank = rank;
      }
    }
    if (debugRow) {
      if (best) debugRow.selected = { card_no: best.card_no, total: best.total,
        brave_mode: best.brave_mode ?? null };
      state.choiceDebug.push(debugRow);
    }
    return best;
  }

  /** コアを残す価値があるセット中バーストを1つ返す(6C-3)。無ければnull。
   *  Python `_burst_hold_candidate` と同一。条件は4つ——セット中で、「その後
   *  コストを支払うことで…」の節を持ち、その本体効果を**今のエンジンが撃てて**、
   *  その条件が**踏まれうる盤面**であること。コストは**メインに入る前の盤面**で
   *  計算するので、床は多めに残る側へ倒れる。 */
  function burstHoldCandidate(state, cards) {
    const cardNo = state.burst;
    if (!cardNo || !state.opponentView) return null;
    const card = cards[cardNo];
    const effect = (card?.burst_effects || []).find(
      (row) => row.kind === "burst_pay_own_effect");
    if (!effect || !burstEffectIsUseful(card, effect)) return null;
    if (!burstCategoryCanBeSteppedOn(card.burst_conditions, state.opponentView,
      combatUnits(state, cards).length)) return null;
    const cost = paymentForState(state, cards, card).total;
    if (cost <= 0) return null;
    return { card_no: cardNo, effect, cost };
  }

  /** 本体効果を**実際に解いてみて**、目的関数がいくつ増えるかを測る(6C-3)。
   *  重み表を書かないのは`chooseCandidate`が手札のプレイを実測で比べているのと
   *  同じ理由——語彙が広がれば見積もりも自動的に追随する。Python
   *  `_burst_followup_gain` と同一(あちらは`_snapshot`/`_restore`で巻き戻す)。 */
  function burstFollowupGain(state, cards, targets, plan) {
    const trial = clone(state);
    trial.trace = false;
    trial.events = [];
    const before = trial.dig + trial.handGain;
    const paid = burstPaidFollowup(trial, cards, targets, plan.card_no, plan.effect);
    // ⚠️ **流してから測る**(2026-08-31)。`burst_paid_followup`の完了処理は
    // `deferredPlayCompletions`へ先送りされるので、そのまま読むと本体効果の
    // 増分が**必ず0**になる——6C-3の残す判断が常に「出し切る」へ倒れていた。
    // Pythonは`runtime.begin()/end()`の`end`で予約を流してから測っており、
    // ここが片側だけ抜けていた(`burst_hold`プリセットの掃検が6/24で割れていた)。
    while (trial.deferredPlayCompletions.length) {
      trial.deferredPlayCompletions.shift()();
    }
    return paid ? trial.dig + trial.handGain - before : 0;
  }

  /** メインステップのプレイを最後まで進める。`floor`は6C-3の残す額。
   *  Python `_play_out_main_step` と同一。 */
  function playOutMainStep(state, cards, targets, floor) {
    state.burstHoldFloor = floor;
    try {
      while (true) {
        const candidate = chooseCandidate(state, cards, targets);
        if (!candidate || !play(state, cards, targets, candidate)) break;
        resolveMainActivatedEffects(state, cards, targets);
        resolveTrashMainSummon(state, cards, targets);
        noteLegalCandidates(state, cards, targets);
      }
    } finally {
      state.burstHoldFloor = 0;
    }
  }

  function allocateEndTurnLevelCores(state, cards, targets) {
    let moved = 0;
    let ordinaryReserve = state.reserve - Number(state.reserveHasSoul);
    while (ordinaryReserve > 0) {
      const choices = [];
      for (const unit of state.field) {
        if (unit.creator_core || unit.waiting) continue;
        const thresholds = Object.values(cards[unit.card_no]?.level_thresholds || {})
          .filter((threshold) => threshold !== null && threshold > unit.cores);
        if (!thresholds.length) continue;
        const next = Math.min(...thresholds);
        const needed = next - unit.cores;
        if (needed <= ordinaryReserve) {
          choices.push({ unit, needed, next,
            tier: accessTier(unit.card_no, cards, targets) });
        }
      }
      choices.sort((left, right) => left.tier - right.tier
        || left.unit.uid - right.unit.uid || left.needed - right.needed);
      if (!choices.length) break;
      const choice = choices[0];
      choice.unit.cores = choice.next;
      state.reserve -= choice.needed;
      ordinaryReserve -= choice.needed;
      moved += choice.needed;
    }
    if (moved) record(state, cards, "level_allocate", { cores: moved });
  }

  function residualReduction(state, cards) {
    const remaining = {};
    for (const cardNo of state.deck) remaining[cardNo] = (remaining[cardNo] || 0) + 1;
    const byCard = [];
    let total = 0;
    for (const cardNo of Object.keys(remaining).sort()) {
      const withoutField = paymentFor(cards[cardNo], {}, state.count).pay;
      const withField = paymentForState(state, cards, cards[cardNo]).pay;
      const perCopy = Math.max(0, withoutField - withField);
      if (!perCopy) continue;
      const savings = remaining[cardNo] * perCopy;
      total += savings;
      byCard.push({ card_no: cardNo, remaining_copies: remaining[cardNo],
        core_savings_per_copy: perCopy, potential_core_savings: savings });
    }
    return { potential_core_savings: total, remaining_deck_cards: state.deck.length,
      field_symbols: effectiveSymbols(state, cards), by_card: byCard };
  }

  function noteLegalCandidates(state, cards, targets) {
    const rows = legalCandidates(state, cards, targets);
    for (const row of rows) {
      if (!(row.card_no in state.legalFirstTurns)) {
        state.legalFirstTurns[row.card_no] = state.turn;
      }
    }
    if (state.targetPlayableTurn === null
        && rows.some((row) => targets.has(row.card_no))) {
      state.targetPlayableTurn = state.turn;
    }
    return rows;
  }

  // ---- Stage6B の戦闘用インターフェース ---------------------------------
  // Python側 `stage4_sim.py` の `_combat_*` と同じ規約。片方だけ変えると
  // Python/Worker の棋譜が食い違うので、必ず両方そろえて直すこと。
  function combatUnitRow(state, cards, unit) {
    const card = cards[unit.card_no] || {};
    const view = stateView(state, cards).field.find((row) => row.uid === unit.uid);
    // ⚠️ `view.symbol_bonus`は**軽減の窓**なので流用しない。ここは打点の窓で、
    // 『自分のアタックステップ』の追加が効き『自分のメインステップ』は効かない。
    const symbolBonus = flagSymbolBonus(state, cards, unit, "attack");
    return {
      uid: unit.uid,
      card_no: unit.card_no,
      card_type: card.card_type,
      // 印字のコスト(軽減前)。『ライフ保護』の「コストN以上のアタックでは」が
      // これで判定する(6C-2B)。Python `_combat_unit_row` と同一。
      cost: card.cost || 0,
      bp: view ? view.bp : (card.base_bp || 0),
      // ライフ減少量は「アタックしたスピリットやアルティメットのシンボルと
      // 同じ数だけ」(公式ルール eternal page08)。旗のシンボル追加も数える。
      // 合体中のブレイヴのシンボルもこのユニットのぶんとして数える。
      symbol_count: Object.values(card.symbols || {}).reduce((sum, value) => sum + value, 0)
        + sumCounter(symbolBonus)
        + combinedBraves(state, unit.uid).reduce((sum, brave) => sum
          + Object.values(cards[brave.card_no]?.symbols || {})
            .reduce((inner, value) => inner + value, 0), 0),
      // この体の戦闘方針を決めるときに見るカード。Python `_combat_unit_row` の
      // `policy_card_nos` と同一。`combatResolveTrigger`はホストの節と合体中の
      // ブレイヴの節を両方撃つのに、方針はホストの`card_no`しか見ていなかった。
      // ⚠️ 煌臨元は入れない(`works_as_contract_base`を持つ節しか撃たれないため)。
      policy_card_nos: [unit.card_no].concat(
        combinedBraves(state, unit.uid).map((brave) => brave.card_no)),
      exhausted: Boolean(unit.exhausted),
    };
  }

  // 同時に発揮するアタック時/ブロック時の節の解決順。Python
  // `stage4_conditions.combat_window_order` と同じ規則:
  // ①相手の盤面に触らない節を先に ②資源を要求する節を後ろへ ③残りは印字順。
  // 連結を持つ窓(「そうしたとき」等)は印字順のまま返す。
  // Python `stage4_conditions.OPPONENT_FACING_KINDS` と同じ6種別。2026-08-17に
  // 空から埋めた——相手干渉を足したのにここへ登録しておらず、規則①が一度も
  // 効いていなかった(実データで51窓が印字順のまま)。
  const OPPONENT_FACING_KINDS = new Set([
    "unit_destroy", "unit_exhaust", "unit_core_remove",
    "unit_bounce", "unit_heavy_exhaust", "unit_bp_down",
    "life_core_remove", "field_core_remove",
  ]);
  // 戦闘の窓と、そのIRの置き場所。Python `stage4_conditions.COMBAT_WINDOW_KEYS`
  // と**同じ表**でなければならない(片側にだけ窓を足すと、その窓の節を一方だけが
  // 撃つ)。テストで3者一致を守る。
  const COMBAT_WINDOW_KEYS = {
    attack: "attack_effects",
    block: "block_effects",
    blocked: "blocked_effects",
    battle_end: "battle_end_effects",
  };
  const LINKED_KEYS = ["requires_predecessor_changed", "requires_predecessor_id",
    "gates_next_effect", "b3_followup_id", "requires_successful_followup"];

  const combatWindowLocked = (effects) =>
    effects.some((effect) => LINKED_KEYS.some((key) => effect[key]));

  const combatWindowSortKey = (effect) => [
    Number(OPPONENT_FACING_KINDS.has(effect.kind)),
    Number(Boolean((effect.count_requirements || []).length || effect.additional_cost)),
  ];

  function combatWindowOrder(effects) {
    const rows = [...effects];
    if (combatWindowLocked(rows)) return rows;
    return rows
      .map((effect, index) => ({ effect, index, rank: combatWindowSortKey(effect) }))
      .sort((left, right) => left.rank[0] - right.rank[0]
        || left.rank[1] - right.rank[1] || left.index - right.index)
      .map((row) => row.effect);
  }

  // 場のカード全部を対象行の形で返す(ネクサス込み)。Python `_combat_field_rows`。
  // 盤面の口(`board.field`)と、自己参照の閾値を取る側の**両方**がこれを使う——
  // 別経路で組み直すと、同じユニットが窓ごとに違う値を報告することになる。
  function combatFieldRows(state, cards) {
    // BPは`combatUnitRow`と同じ出どころ(`stateView`)から取る。
    const view = stateView(state, cards).field;
    return [...state.field]
      .filter((unit) => !unit.waiting)
      .sort((left, right) => left.uid - right.uid)
      .map((unit) => {
        const card = cards[unit.card_no] || {};
        const row = view.find((entry) => entry.uid === unit.uid);
        return {
          uid: unit.uid,
          card_no: unit.card_no,
          card_type: card.card_type || "",
          bp: row ? row.bp : (card.base_bp || 0),
          cost: card.cost || 0,
          // 「シンボル2つ以下の相手のスピリット」用。数え方も窓も打点と同じ
          // (印字＋旗の追加＋常時の追加＋合体中のブレイヴ)。`combatUnitRow`と揃える。
          symbol_count: Object.values(card.symbols || {})
            .reduce((sum, value) => sum + value, 0)
            + sumCounter(flagSymbolBonus(state, cards, unit, "attack"))
            + combinedBraves(state, unit.uid).reduce((sum, brave) => sum
              + Object.values(cards[brave.card_no]?.symbols || {})
                .reduce((inner, value) => inner + value, 0), 0),
          exhausted: Boolean(unit.exhausted),
          heavy_exhausted: Boolean(unit.heavy_exhausted),
          // [ソウルコア]が置かれているか。公開情報。Python `soul_core` と同一。
          soul_core: Boolean(unit.soul_core),
          cores: unit.cores,
          // Lv1維持コア。「あと何個抜けば消滅するか」の計算に要る。
          floor: unit.floor,
        };
      });
  }

  /** アタック／ブロックの候補になり得る自分のユニット。Python `_combat_units` と同一。
   *  単体で立っているブレイヴも戦闘に出る。禁じているのは印字を持つものだけ
   *  (`cannot_battle_as_spirit`)で、その制限は単体のときに限る——合体中は手前で
   *  除いているのでホストへは持ち込まれない。種別は**完全一致ではなく含有**で
   *  見る(実データの`契約スピリット`等が1体も戦闘に出られなくなるため)。 */
  function combatUnits(state, cards) {
    return state.field
      .filter((unit) => {
        if (unit.waiting || unit.brave_mode === "combine") return false;
        const card = cards[unit.card_no];
        const type = card?.card_type || "";
        if (!["スピリット", "アルティメット", "ブレイヴ"].some(
          (kind) => type.includes(kind))) return false;
        return !(type.includes("ブレイヴ") && card?.cannot_battle_as_spirit);
      })
      .sort((left, right) => left.uid - right.uid)
      .map((unit) => combatUnitRow(state, cards, unit));
  }

  // 対象の並べ替え。既定は脅威度の代理としてBP降順→コスト降順→uid昇順で、
  // 印字が最上級を指定していればそれが上書きする。**同値のときは印字が言う方向へ
  // さらに倒す**。Python `_COMBAT_TARGET_ORDERS` と同一。
  const COMBAT_TARGET_ORDERS = {
    bp_desc: (l, r) => r.bp - l.bp || r.cost - l.cost || l.uid - r.uid,
    bp_asc: (l, r) => l.bp - r.bp || l.cost - r.cost || l.uid - r.uid,
    cost_desc: (l, r) => r.cost - l.cost || r.bp - l.bp || l.uid - r.uid,
    cost_asc: (l, r) => l.cost - r.cost || l.bp - r.bp || l.uid - r.uid,
  };

  // 発揮元ユニットの現在値(自己参照の閾値用)。**自分の場**から取る。
  function combatSelfStat(state, cards, sourceUid, key) {
    if (sourceUid === null || sourceUid === undefined) return null;
    const row = combatFieldRows(state, cards).find((entry) => entry.uid === sourceUid);
    return row ? row[key] : null;
  }

  function resolveMainActivatedEffects(state, cards, targets) {
    let changed = false;
    for (const source of [...state.field].sort((a, b) => a.uid - b.uid)) {
      if (source.waiting) continue;
      for (const effect of cards[source.card_no]?.main_activated_effects || []) {
        const key = `${source.uid}:${effect.kind}`;
        if (state.mainActivatedUsed.has(key) || effect.kind !== "creator_redeploy") continue;
        const creatorCount = state.field.filter((unit) => !unit.waiting
          && (cards[unit.card_no]?.lineages || []).includes("創界神")).length;
        const cost = effect.source_core_cost || 0;
        const ordinary = source.cores - Number(Boolean(source.soul_core));
        if (creatorCount > (effect.field_limit || 0) || ordinary < cost) continue;
        const candidates = state.trashCards.map((cardNo, index) => ({ cardNo, index,
          chihiro: cards[cardNo]?.name === "日下 チヒロ" ? 0 : 1,
          tier: accessTier(cardNo, cards, targets) }))
          .filter((row) => (cards[row.cardNo]?.lineages || []).includes("創界神")
            && (cards[row.cardNo]?.card_type || "").includes("ネクサス"))
          .sort((a, b) => a.chihiro - b.chihiro || a.tier - b.tier || a.index - b.index);
        if (!candidates.length) continue;
        const picked = candidates[0].cardNo;
        state.mainActivatedUsed.add(key);
        source.cores -= cost;
        recordCoreMove(state, cards, { amount: cost, source: "field", destination: "void",
          reason: "creator_redeploy_cost", source_card_no: source.card_no,
          source_uid: source.uid });
        state.trashCards.splice(state.trashCards.indexOf(picked), 1);
        state.hand.push(picked);
        const card = cards[picked];
        if (play(state, cards, targets, { card_no: picked, pay: 0,
          total: card.maintenance || 0, maintenance: card.maintenance || 0,
          brave_mode: null, allow_sacrifice: true, mode: "creator_redeploy" })) {
          changed = true;
        }
      }
    }
    return changed;
  }

  function resolveTrashMainSummon(state, cards, targets) {
    const opponent = MAIN_STEP_OPPONENTS.get(state) || null;
    if (!opponent || !opponent.field().length || !state.hand.length) return false;
    for (const cardNo of [...new Set(state.trashCards)]) {
      const card = cards[cardNo];
      const route = card?.trash_main_summon;
      if (!route || state.trashMainSummonNamesUsed.has(card.name)) continue;
      const brave = braveMode(card, state, cards);
      const cost = paymentForState(state, cards, card);
      if (brave === "combine") cost.total = cost.pay;
      if (cost.total > reclaimable(state, true, cards)) continue;
      const discarded = state.hand.map((candidate, index) => ({ candidate, index,
        tier: accessTier(candidate, cards, targets), cost: cards[candidate]?.cost || 0 }))
        .sort((a, b) => b.tier - a.tier || b.cost - a.cost || b.index - a.index)[0];
      state.hand.splice(discarded.index, 1);
      state.excludedCards.push(discarded.candidate);
      record(state, cards, "card_excluded", { card_no: discarded.candidate, source: "hand",
        reason: "trash_main_summon_cost", source_card_no: cardNo });
      state.trashCards.splice(state.trashCards.indexOf(cardNo), 1);
      state.hand.push(cardNo);
      state.trashMainSummonNamesUsed.add(card.name);
      record(state, cards, "trash_summon_declared", { card_no: cardNo,
        once_per_game_same_name: true, pays_normal_cost: true });
      return play(state, cards, targets, { card_no: cardNo, ...cost,
        maintenance: card.maintenance || 0, brave_mode: brave,
        allow_sacrifice: true, mode: "trash_main_summon" });
    }
    return false;
  }

  function resolveOpponentEndStep(state, cards, targets, lifeReduced = false,
      model = "actual") {
    const sources = [];
    for (const unit of [...state.field].sort((left, right) => left.uid - right.uid)) {
      if (unit.waiting || unit.brave_mode === "combine") continue;
      const candidates = [[unit.card_no, true],
        ...(unit.kourin_stack || []).map((cardNo) => [cardNo, false])];
      for (const [cardNo, isTop] of candidates) {
        const effect = cards[cardNo]?.opponent_end_effect;
        if (!effect || (!isTop && !effect.works_as_contract_base)) continue;
        sources.push({ cardNo, uid: unit.uid, fieldPresent: true, effect });
      }
    }
    for (const cardNo of [...new Set(state.soulCards)]) {
      const effect = cards[cardNo]?.opponent_end_effect;
      if (effect?.works_as_soul_state) {
        sources.push({ cardNo, uid: null, fieldPresent: false, effect });
      }
    }
    const seen = new Set();
    const resolved = [];
    for (const source of sources) {
      const { cardNo, uid, fieldPresent, effect } = source;
      if (effect.non_stackable && seen.has(cardNo)) continue;
      if (effect.non_stackable) seen.add(cardNo);
      record(state, cards, "effect_start", { card_no: cardNo, uid,
        effect_kind: "opponent_end", opponent_model: model });
      let count = effect.base_count || 0;
      if (!lifeReduced) count += effect.no_life_loss_count || 0;
      if (count) applyCountGain(state, cards, count, null, {
        reason: "opponent_end", source_card_no: cardNo, source_uid: uid,
      });
      let drawAmount = lifeReduced ? 0 : effect.no_life_loss_draw || 0;
      if (effect.draw_requires_field_presence && !fieldPresent) drawAmount = 0;
      if (drawAmount) draw(state, cards, drawAmount, "opponent_end");
      record(state, cards, "effect_complete", { card_no: cardNo, uid,
        effect_kind: "opponent_end", resolved: true,
        life_reduced: Boolean(lifeReduced), opponent_model: model });
      flushCountReactions(state, cards, targets);
      resolved.push({ card_no: cardNo, uid, count, draw: drawAmount,
        life_reduced: Boolean(lifeReduced), opponent_model: model });
    }
    return resolved;
  }

  function combatBoard(state, cards, targets) {
    // `board`に束ねてから返す。`remove_cores`がコア0のユニットを破壊するとき、
    // 同じ盤面の`destroy`を呼ぶため(毎回作り直すと意図が読みにくい)。
    const board = {
      units: () => combatUnits(state, cards),
      // 6C-3: 相手盤面の公開情報の要約を受け取る口。メインステップの方針
      // (バーストのためにコアを残すか)が読む。Python `_observe_opponent` と同一。
      observe_opponent: (summary, opponentBoard = null) => {
        state.opponentView = summary ? { ...summary } : null;
        if (opponentBoard) MAIN_STEP_OPPONENTS.set(state, opponentBoard);
        else MAIN_STEP_OPPONENTS.delete(state);
      },
      // 相手の効果が対象にできる場のカード全部(ネクサスも含む)。`units`は
      // アタック/ブロックの候補なのでスピリット系しか並べないが、破壊の対象には
      // ネクサスも入る。Python `_combat_field_rows` と同一。
      field: () => combatFieldRows(state, cards),
      exhaust: (uid) => {
        const unit = state.field.find((row) => row.uid === uid);
        if (!unit || unit.exhausted) return false;
        unit.exhausted = true;
        return true;
      },
      // 相手の効果でコアを取り除く。取り除いた数を返す。Python
      // `_combat_remove_cores` と同一。消滅の条件は「コア0」ではなく
      // **載っているコアがLv1維持コア(`floor`)未満**——維持コア0のブレイヴは
      // コアを全部退かしても消えず、維持コア2のユニットは1個で消える。
      // 行き先(リザーブ/トラッシュ/ボイド)で取られた側の資源かどうかが変わる。
      // ソウルコアは通常コアを先に取ってから動かす(`damage_life`と同じ順)。
      remove_cores: (uid, amount, destination) => {
        const unit = state.field.find((row) => row.uid === uid);
        if (!unit || amount <= 0) return 0;
        const taken = Math.min(amount, unit.cores);
        if (taken <= 0) return 0;
        const ordinary = unit.cores - Number(Boolean(unit.soul_core));
        if (unit.soul_core && taken > ordinary) {
          unit.soul_core = false;
          if (destination === "reserve") state.reserveHasSoul = true;
          else if (destination === "trash") state.trashHasSoul = true;
        }
        unit.cores -= taken;
        if (destination === "reserve") state.reserve += taken;
        // トラッシュのコアは`state.spent`。`state.trash`という項目は**存在しない**
        // ので、そこへ足していた版は毎回NaNを書き込むだけで、Pythonの`trash += taken`
        // と食い違っていた(2026-08-21に発見。掃検の2デッキがどちらも「コアを
        // トラッシュへ置く」除去を撃たなかったので表に出ていなかった)。
        else if (destination === "trash") state.spent += taken;
        recordCoreMove(state, cards, { amount: taken, source: "field",
          destination, reason: "unit_core_remove", source_uid: uid });
        if (unit.cores < unit.floor) board.destroy(uid, "effect");
        return taken;
      },
      // 相手のユニットのBPを下げる(6B-3)。Python `_combat_bp_down` と同一。
      // 期間は印字どおり2種で、明記が無ければバトルの間(裁定)。
      // `destroyAtZero`は「BP0になったとき破壊する」と書いてある効果だけ。
      bp_down: (uid, amount, scope, destroyAtZero) => {
        const unit = state.field.find((row) => row.uid === uid);
        if (!unit || amount <= 0) return false;
        if (!unit.bp_penalties) unit.bp_penalties = [];
        unit.bp_penalties.push({ amount, scope });
        record(state, cards, "bp_changed", { card_no: unit.card_no, uid,
          amount: -amount, scope });
        if (destroyAtZero) {
          const view = stateView(state, cards).field.find((row) => row.uid === uid);
          if (view && view.bp <= 0) finalizeFieldLeave(state, cards, unit, "effect");
        }
        return true;
      },
      // バトル／ターンの終わりに、その期間のBP修正を捨てる。
      end_battle: () => {
        for (const unit of state.field) {
          if (unit.bp_penalties) {
            unit.bp_penalties = unit.bp_penalties.filter((row) => row.scope !== "battle");
          }
          if (unit.timed_symbol_grants) {
            unit.timed_symbol_grants = unit.timed_symbol_grants.filter(
              (row) => row.scope !== "battle");
          }
        }
        state.lifeProtections = state.lifeProtections.filter(
          (row) => row.scope !== "battle");
      },
      end_turn_modifiers: () => {
        for (const unit of state.field) {
          if (unit.bp_penalties) unit.bp_penalties = [];
          if (unit.timed_symbol_grants) unit.timed_symbol_grants = [];
        }
        state.lifeProtections = [];
      },
      // 『ライフ保護』を1つ効かせる(6C-2B)。期限は`scope`。保護は**盤面の状態**で
      // ユニットには紐づかないので、発揮元が場を離れても切れない。
      // Python `_combat_protect_life` と同一。
      protect_life: (protection) => {
        state.lifeProtections.push({ ...protection });
        record(state, cards, "life_protected", {
          protection: protection.protection, amount: protection.amount,
          scope: protection.scope, attacker_cost_min: protection.attacker_cost_min,
          source_kind: protection.source_kind });
        return true;
      },
      // 相手のユニットを重疲労させる。重疲労は疲労を**含む**状態(裁定「疲労状態と
      // 同様にアタックやブロックはできず」)なので`exhausted`も立てる。
      // Python `_combat_heavy_exhaust` と同一。
      heavy_exhaust: (uid) => {
        const unit = state.field.find((row) => row.uid === uid);
        if (!unit || unit.heavy_exhausted) return false;
        unit.exhausted = true;
        unit.heavy_exhausted = true;
        return true;
      },
      // 相手のユニットを手札/デッキへ戻す(6B-3)。Python `_combat_bounce` と同一で、
      // 場を離れる境界へ委譲して行き先だけ渡す。
      bounce: (uid, destination) => {
        const unit = state.field.find((row) => row.uid === uid);
        if (!unit) return false;
        finalizeFieldLeave(state, cards, unit, "effect", destination);
        return true;
      },
      // 手札へ返した公開カードを次ターンに払い直せるか、配置/召喚時効果を
      // 再利用できるか。相手の実手札は見ない。Python `_combat_bounce_reuse_risk`同一。
      bounce_reuse_risk: (row) => {
        const uid = typeof row === "object" ? row.uid : row;
        const unit = state.field.find((entry) => entry.uid === uid);
        if (!unit) return 0;
        const card = cards[unit.card_no] || {};
        if (card.is_token || card.is_contract) return 0;
        const symbols = summonPaymentSymbols(state, cards, card);
        counterAdd(symbols, card.symbols || {}, -1);
        const grantHit = state.field.some((source) => source.uid !== uid && !source.waiting
          && cards[source.card_no]?.reduction_grant
          && cardMatchesSlot(card, { condition: cards[source.card_no].reduction_grant }));
        const { total } = paymentFor(card, symbols, state.count, grantHit);
        const nextTurnPublicCores = state.reserve + state.trash + 1 + unit.cores
          + state.field.filter((other) => other.uid !== uid && !other.waiting)
            .reduce((sum, other) => sum + Math.max(0, other.cores - other.floor), 0);
        const onPlay = (card.enablers || []).filter(
          (effect) => effect.mode === "on_play").length;
        return 20 + (total <= nextTurnPublicCores ? 60 : 15)
          + 12 * onPlay + Math.max(0, 12 - total);
      },
      // 戻り値は**カードがトラッシュに置かれたか**("trash"/"other")。バーストの
      // 「消滅/破壊後」はトラッシュに置かれたときだけ発動できる(SD52-012・
      // CB24-X06の裁定)。Python `_combat_destroy` と同一。
      destroy: (uid, cause) => {
        const unit = state.field.find((row) => row.uid === uid);
        if (!unit) return null;
        const before = state.trashCards.length;
        // 場を離れる境界へ委譲する。以前はここに独自実装を置いていたが、
        // **契約煌臨元の置き換えを通らない**ぶんPython(`_finalize_field_leave`へ
        // 委譲)と食い違っていた。破壊が効果から撃てるようになって初めて届く
        // 経路なので、ここで揃えておく(2026-08-17)。
        finalizeFieldLeave(state, cards, unit, cause);
        return state.trashCards.length > before ? "trash" : "other";
      },
      // ライフのコアがライフエリアを離れる。アタックが通ったときと効果の両方。
      // `destination`は**アタックによる減少では常にリザーブ**(公式ルール)で、
      // 印字どおりトラッシュ/ボイドを指定するのは効果によるライフ削減(6B-3)だけ。
      // リザーブ行きはライフが減る代わりに**取られた側の資源になる**ので、
      // 行き先を落として一律に扱ってはいけない。Python `_combat_damage_life`と同一。
      // `attacker`は**何が減らしているか**(6C-2Bの『ライフ保護』)。アタックに
      // よる減少なら`{cost}`、効果による減少なら`null`。渡さないと
      // 「コスト4以上のアタックでは減らない」型が効果まで止めてしまう。
      // **ここが保護の唯一の参照点**。Python `_combat_damage_life` と同一。
      damage_life: (amount, destination = "reserve", attacker = null) => {
        // 自傷と違い**ライフ0まで削れる**(そこが勝敗の分かれ目そのもの)。
        const protectedAmount = lifeDamageAfterProtection(
          state, Math.max(amount, 0), attacker);
        const taken = Math.min(Math.max(protectedAmount, 0), state.life);
        if (taken <= 0) return 0;
        const ordinary = state.life - Number(Boolean(state.lifeHasSoul));
        if (state.lifeHasSoul && taken > ordinary) {
          state.lifeHasSoul = false;
          // ボイドへ行った魂コアはどちらの追跡フラグも立てない(コア除去と同じ規則)。
          if (destination === "reserve") state.reserveHasSoul = true;
          else if (destination === "trash") state.trashHasSoul = true;
        }
        state.life -= taken;
        if (destination === "reserve") state.reserve += taken;
        return taken;
      },
      // 印字の『アタック時』『ブロック時』の窓(6B-1②)と、その下位の窓
      // (6C: 『ブロックされたとき』『バトル終了時』)。Python
      // `_combat_resolve_trigger`と同じで、**ここが唯一の入口**——メイン
      // ステップの解決からは呼ばない。解く表もStage4本体の`enablers`ではなく、
      // ローダーが窓ごとに分けた表(`COMBAT_WINDOW_KEYS`)。
      // opponent は相手の盤面(6B-3)。相手へ触る効果はこの窓のあいだしか解けない
      // ——Stage4は元々ソリティアの掘り検証で相手を持たないので、窓の外では
      // 持っていないままにする(渡されなければ相手対象効果は不発)。
      // ⭐ バーストゾーンが埋まっているかどうか。Python `burst_set` と同一。
      // 伏せたバーストは**置いてあること自体は相手からも見える**ので、
      // 「窓を渡すと踏まれうる」の判断材料として真偽値だけ公開する。
      // ⚠️ card_noも`burst_conditions`も渡さない(守り手の伏せ札を覗かない)。
      burst_set: () => state.burst != null,
      // 手札の**枚数**は公開情報(中身は渡さない)。Python `hand_count` と同一。
      hand_count: () => state.hand.length,
      // ミラージュを**置いてあるか**だけ(中身は渡さない)。Python `mirage_set` 同一。
      mirage_set: () => state.mirage != null,
      // 6C-2: 実イベントでセット中バーストを開く。Python `trigger_event_burst`
      // と同一——確率入力(5C-2A)ではなく、盤面で実際に起きたことから発火させる。
      // 開くかどうかの方針はまだ持たない(開けるなら開く)。
      trigger_burst: (category, opponent) => {
        const cardNo = state.burst;
        if (!cardNo) return null;
        if (!((cards[cardNo] || {}).burst_conditions || []).includes(category)) {
          return null;
        }
        state.burst = null;
        // 相手の盤面の口(6C-2C)。バーストが開くのは戦闘の途中か相手のターンなので、
        // 破壊・バウンス・コア除去の節を戦闘の窓と同じように撃てる。
        state.combatOpponent = opponent || null;
        // `burst_activated`を書くのはStage6側(窓を開いたのは対戦の層)。
        try {
          resolveBurstEffects(state, cards, targets, cardNo);
        } finally {
          state.combatOpponent = null;
        }
        return cardNo;
      },
      // 6C-2B: 手札から使うフラッシュの窓。**選ぶのはStage6**で、ここは合法で
      // いま払える札を並べるだけ。払えるかは盤面を壊さずに(allowSacrifice=false)。
      // Python `_combat_flash_options` と同一。
      // フラッシュの窓で相手に何ができるか。**公開情報**(リザーブ・場の余剰コア・
      // 魂状態・デッキリスト)だけで作る。Python `_combat_flash_window_capacity`
      // と同一で、**手札は見ない**。
      flash_window_capacity: () => {
        let cheapest = null;
        for (const cardNo of Object.keys(state.deckCopies)) {
          const card = cards[cardNo] || {};
          if (!(card.flash_effects || []).length) continue;
          const { total } = paymentForState(state, cards, card);
          cheapest = cheapest === null ? total : Math.min(cheapest, total);
        }
        const payable = reclaimable(state, false, cards);
        // **印字の窓を必ず見る**(Python同一)。『自分のターン』の契約煌臨は相手の
        // ターンには乗れないので、こちらがアタックを控える理由にならない。脅威に
        // なるのは`attack_only`(『お互いの/相手のアタックステップ』)だけ。
        const kourinKinds = new Set(["契約", "超契約", "F契約", "封印F契約"]);
        const soulKourin = state.soulCards.length > 0
          && Object.keys(state.deckCopies).some((cardNo) => {
            const card = cards[cardNo] || {};
            return kourinKinds.has(card.kourin_kind)
              && card.kourin_timing === "attack_only";
          });
        return { payable, cheapest,
          can_pay: cheapest !== null && cheapest <= payable,
          soul_kourin: soulKourin };
      },
      flash_options: () => {
        const options = [];
        state.hand.forEach((cardNo, handIndex) => {
          const card = cards[cardNo] || {};
          for (const effect of card.flash_effects || []) {
            const cost = paymentForState(state, cards, card);
            if (cost.total > reclaimable(state, false, cards)) continue;
            options.push({ card_no: cardNo, hand_index: handIndex,
              kind: effect.kind, flash_when: effect.flash_when,
              // 『ライフ保護』の中身。方針は実際に減る量が減るかで選ぶ。
              protection: effect.protection ?? null,
              amount: effect.amount ?? null,
              attacker_cost_min: effect.attacker_cost_min ?? null,
              effect_id: effect.effect_id ?? null, cost: cost.total });
          }
        });
        return options;
      },
      // 支払いと行き先だけを済ませ、効果そのもの(アタックステップを終わらせる)は
      // Stage6が起こす。同じカードの他の節は撃たない——印字より狭く撃つ側の
      // 読み落としで、窓を広げる前に足す。Python `_combat_play_flash` と同一。
      play_flash: (cardNo, effectId) => {
        if (!state.hand.includes(cardNo)) return null;
        const card = cards[cardNo] || {};
        const effect = (card.flash_effects || []).find(
          (row) => (row.effect_id ?? null) === effectId);
        if (!effect) return null;
        const cost = paymentForState(state, cards, card);
        if (cost.total > reclaimable(state, false, cards)) return null;
        const traceDetails = { mode: "flash", pay: cost.pay, total: cost.total,
          effect_kind: effect.kind };
        record(state, cards, "play_presented", { card_no: cardNo, ...traceDetails });
        record(state, cards, "cost_calculated", { card_no: cardNo, ...traceDetails });
        const deficit = cost.total - state.reserve;
        if (deficit > 0) fundPayment(state, cards, targets, deficit, false);
        payFromReserve(state, cost.pay, cost.total - cost.pay);
        state.reserve -= cost.total;
        state.spent += cost.pay;
        record(state, cards, "cost_paid",
          { card_no: cardNo, payment: "cores", ...traceDetails });
        state.hand.splice(state.hand.indexOf(cardNo), 1);
        // 使ったマジックはトラッシュへ。`card_discarded`は出さない(あれは「破棄」
        // の記録で、バーストで解決したマジックだけが名乗る)。
        state.trashCards.push(cardNo);
        record(state, cards, "card_moved",
          { card_no: cardNo, destination: "trash", ...traceDetails });
        return { card_no: cardNo, kind: effect.kind,
          flash_when: effect.flash_when,
          protection: effect.protection ?? null,
          amount: effect.amount ?? null,
          scope: effect.scope ?? null,
          attacker_cost_min: effect.attacker_cost_min ?? null,
          source_kind: effect.source_kind ?? null,
          effect_id: effect.effect_id ?? null };
      },
      // 魂状態の契約カード。**公開情報**なので相手も読める(Python同一)。
      soul_cards: () => [...state.soulCards],
      // 盤面のフラッシュ効果。同じくアタック方針の入力になる公開情報。
      field_flash_options: () => [
        ...[...state.field]
          .sort((left, right) => left.uid - right.uid)
          .flatMap((unit) => fieldFlashSources(state, cards, unit).map((source) => ({
            uid: unit.uid, card_no: source.card_no, cost: source.cost,
            kinds: source.effects.map((effect) => effect.kind),
          }))),
        // 魂状態のカードは場のユニットではないので`uid`を持たない(Python同一)。
        ...soulFlashSources(state, cards).map((source) => ({
          uid: null, card_no: source.card_no, cost: 0,
          kinds: source.effects.map((effect) => effect.kind),
        })),
      ],
      // 相手のターンのフラッシュタイミングで撃つ口(6C-2B続き)。〔ターンに1回〕は
      // そのターンごとなので、相手のターンでは数え直す。Python同一。
      // 〔ターンに1回〕の数え直し。エンドステップが切り替わりの位置なので、
      // Stage6は相手のターンのエンドステップでもこの口を叩く。Python同一。
      end_step_reset: () => { state.fieldFlashUsed.clear(); state.mainActivatedUsed.clear(); },
      opponent_end_step: (lifeReduced = false, model = "actual") =>
        resolveOpponentEndStep(state, cards, targets, lifeReduced, model),
      resolve_field_flash: (uid) => {
        // `uid`がnullなら魂状態のカードの分(Python同一。Stage6は行のuidを
        // そのまま渡してくるので、口をひとつにしておく)。
        if (uid === null || uid === undefined) {
          return resolveSoulFlash(state, cards, targets);
        }
        const unit = state.field.find((row) => row.uid === uid);
        if (!unit) return false;
        const before = state.fieldFlashUsed.size;
        resolveFieldFlash(state, cards, targets, unit);
        return state.fieldFlashUsed.size > before;
      },
      resolve_trigger: (uid, window, opponent, battleRole) => {
        const unit = state.field.find((row) => row.uid === uid);
        if (!unit || unit.waiting) return [];
        const key = COMBAT_WINDOW_KEYS[window];
        // 『バトル終了時』は**どちらの宣言から遅らせた節か**で選ぶ(6C)。
        // ブロック時由来の節は、その札がブロックしたバトルでしか発揮しない。
        const inWindow = (effect) => window !== "battle_end"
          || (effect.battle_end_from || []).includes(battleRole);
        const windowRows = (cardNo, source, contractBaseOnly = false) =>
          ((cards[cardNo] || {})[key] || [])
            .filter((effect) => inWindow(effect)
              && (!contractBaseOnly || effect.works_as_contract_base))
            .map((effect) => [effect, source]);
        // [節, 合体限定判定に使う発揮元]の組。解決は**常にホスト**で行う
        // (合体中のブレイヴはコアを持たないので、置かれるコアはホストへ乗る)。
        const rows = windowRows(unit.card_no, unit);
        // 【契約煌臨元】の節は煌臨元になっていても発揮する(Python同様)。
        for (const baseNo of unit.kourin_stack || []) {
          rows.push(...windowRows(baseNo, unit, true));
        }
        // 合体中のブレイヴはホストと1体。宣言するのはホストなので、この窓で発揮する。
        for (const brave of combinedBraves(state, uid)) {
          rows.push(...windowRows(brave.card_no, brave));
        }
        if (!combatWindowLocked(rows.map(([effect]) => effect))) {
          rows.sort((left, right) => {
            const a = combatWindowSortKey(left[0]);
            const b = combatWindowSortKey(right[0]);
            return a[0] - b[0] || a[1] - b[1];
          });
        }
        const resolved = [];
        state.combatOpponent = opponent || null;
        beginEffectFrame(state);
        try {
          // ⚠️ **相手の口を結んだ後**に撃つ(Python同一)。印字の盤面条件は
          // ここでしか読めない——先に撃つと条件つきの付与が一度も発火しない。
          if (window === "attack") applyAttackSymbolGrants(state, cards, unit, uid);
          for (const [effect, source] of rows) {
            if (source.brave_mode === "spirit" && effect.combine_only) continue;
            // `effect_id`はPython側に無いので載せない(上と同じ理由)。
            record(state, cards, "effect_start", { card_no: source.card_no, uid,
              effect_kind: effect.kind, window });
            const ok = resolveEffect(state, cards, targets, effect, uid);
            record(state, cards, "effect_complete", { card_no: source.card_no, uid,
              effect_kind: effect.kind, window, resolved: ok });
            resolved.push({ kind: effect.kind, effect_id: effect.effect_id ?? null,
              resolved: Boolean(ok) });
          }
          // カウント反応など、この窓で増えたぶんの派生を先に流し、待機中の
          // 場離れは`endEffectFrame`で最後に確定する(Python runtime.end同一)。
          flushCountReactions(state, cards, targets);
        } finally {
          state.combatOpponent = null;
          endEffectFrame(state);
        }
        return resolved;
      },
      life: () => state.life,
      // 山札の残り枚数。**デッキ切れ敗北**(公式の勝利条件②)をStage6が自分の
      // スタートステップで見るための口。Python `deck_count` と同一。
      deck_count: () => state.deck.length,
      snapshot: () => stateView(state, cards),
      // ⭐ **先読みの巻き戻し**(2026-08-30)。Python `trial_snapshot`/
      // `trial_restore` と同じ口。あちらは`_snapshot`/`_restore`、こちらは
      // `clone(state)`で機構が違うが、**外から見える契約は同じ**——「取って、
      // 好きに壊して、戻すと元どおり」。`burstFollowupGain`が既に同じ形で
      // `clone(state)`を使っている(6C-3)。
      // ⚠️ `snapshot`(=`stateView`)とは別物。あちらは棋譜へ出す読み取り専用の
      // 眺めで、こちらは戻せる状態そのもの。
      // ⚠️ **同じstateオブジェクトへ書き戻す**(参照を差し替えない)。`state`を
      // キーに持つWeakMap(`MAIN_STEP_OPPONENTS`)や、既に配られた`board`の
      // クロージャが同じ実体を見ているため。
      trial_snapshot: () => clone(state),
      trial_restore: (snap) => {
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, clone(snap));
      },
      // 決着で試行を打ち切ると戻り値が無いので、記録済みイベントはここから読む。
      events: () => state.events,
    };
    return board;
  }

  function runTrial(packet, options, trialSeed, trace = false) {
    // 最後まで一息に回す呼び出し口。中身はターンごとに刻む本体そのもの。
    const stream = runTrialStream(packet, options, trialSeed, trace);
    let step = stream.next();
    while (!step.done) step = stream.next();
    return step.value;
  }

  function* runTrialStream(packet, options, trialSeed, trace = false) {
    const cards = Object.fromEntries(packet.definitions.map((definition) =>
      [definition.card_no, definition.stage4]));
    const targets = new Set(options.target_card_nos);
    const deckCards = [];
    for (const entry of packet.deck.cards) {
      for (let index = 0; index < entry.quantity; index += 1) deckCards.push(entry.card_no);
    }
    const opening = Stage5PortableRng.openingHand(deckCards, {
      seed: trialSeed, contract_card_no: packet.deck.contract_card_no,
      consider_mulligan: options.consider_mulligan, initial_hand: options.initial_hand,
    });
    const state = {
      // `deck_order`は共有契約なので**トップ（次に引く札）から順**。だが山札そのものは
      // Pythonと同じ**下→上**（index 0が一番下、末尾がトップ）で持つ。ここで一度だけ
      // 反転させることで、以降のデッキ操作をPythonと1対1で書ける。
      // stage5_rng.jsも内部は下→上で、契約を返す最後だけ`reverse()`している。
      deck: [...opening.deck_order].reverse(), hand: [...opening.opening_hand], trashCards: [],
      sideCards: [], excludedCards: [], field: [], reserve: 4, spent: 0, count: 0, uid: 0,
      // 魂状態の契約カード(Python `soul_cards` と同一)。フィールドの上にあるので
      // トラッシュでも手札でもなく、相手が原因で場を離れるときだけ入る。
      soulCards: [],
      // 盤面のフラッシュ効果を今ターン既に撃った発揮元(`uid:card_no`)。
      // 〔ターンに1回〕はそのカード1枚ごと。Python `field_flash_used` と同一。
      fieldFlashUsed: new Set(),
      mainActivatedUsed: new Set(),
      trashMainSummonNamesUsed: new Set(),
      // 効いている『ライフ保護』(6C-2B)。盤面の状態でユニットには紐づかない。
      // Python `life_protections` と同一。
      lifeProtections: [],
      life: 5, sealed: false,
      reserveHasSoul: true, trashHasSoul: false, lifeHasSoul: false,
      dig: opening.opening_hand.length, handGain: opening.opening_hand.length,
      sideGain: 0, sacrifice: 0, seen: new Set(opening.opening_hand), played: new Set(),
      playCounts: {}, recurring: [], oraclePool: [], openPoolStack: [], burst: null,
      effectFrameDepth: 0, deferredFieldLeaves: [], deferredPlayCompletions: [],
      // 相手盤面の**公開情報の要約**(6C-3)。Stage6が自分のターンの前に入れる。
      // Python `opponent_view` と同一で、口(関数)ではなく素の値——`clone(state)`で
      // 複製できる形にしておく必要がある。
      opponentView: null, faceUpTop: null,
      // 6C-3の「見送りの価値」。0以外のときは、払った後もこの数だけ原資が残る
      // プレイだけを方針が選ぶ。Python `burst_hold_floor` と同一。
      burstHoldFloor: 0,
      mirage: null, turn: 0, pendingCountEvents: [], handReactionNames: new Set(),
      openReactionNames: new Set(), trashReactionNames: new Set(),
      // 裸の〔ターンに1回〕は「そのカード1枚ごとに1回」。同名コピーを区別できないので
      // デッキの枚数(`deckCopies`)を上限に、使った回数を数える。
      trashReactionCardUses: {}, deckCopies: deckCards.reduce((counts, cardNo) => {
        counts[cardNo] = (counts[cardNo] || 0) + 1;
        return counts;
      }, {}),
      completedEffects: new Set(), sealedKourinNames: new Set(),
      // 開発用の候補・順位診断。明示された配列へだけ書き、通常のstate/棋譜には
      // 出さない。Python `choice_debug` と同じ構造を返す。
      choiceDebug: Array.isArray(options.choice_debug) ? options.choice_debug : null,
      countReactionDeferral: 0,
      oracleNameUsed: new Set(), bugCoreSupplyUsed: new Set(),
      // 「場を離れるとき契約煌臨元になるトークン」を1度だけ解決する
      // (Python `contract_base_token_no`と同じ、ROADMAP②)。
      bugNo: contractBaseTokenNo(cards),
      flagNo: contractFlagNexusNo(cards),
      fieldCoreKourinNo: fieldCoreKourinBaseNo(cards),
      trace, events: [], targetPlayableTurn: null, legalFirstTurns: {},
      stage5c: options.stage5c,
      branchSampling: options.stage5c?.mode === Stage5CContract.BRANCH_SAMPLING_MODE,
      resolvedBranchEvents: [],
      branchRngs: {},
      combat: Boolean(options.combat),
    };
    if (state.branchSampling) {
      // 分岐は山札のstreamを一切消費しない専用streamから引く。
      for (const kind of BRANCH_KEYS) {
        state.branchRngs[kind] = new Stage5PortableRng.PortableRng(
          Stage5PortableRng.deriveStreamSeed(trialSeed, BRANCH_STREAM_LABELS[kind]));
      }
    }
    record(state, cards, "opening_hand", { cards: [...state.hand], fixed: options.initial_hand !== null });
    if (state.combat) {
      // 1ターン目より前に一度止まる。先攻の最初のアタックが後攻のライフへ届く
      // ためには、後攻がまだ動く前にその盤面の口が要る。
      yield { turn: 0, step: "opening", board: combatBoard(state, cards, targets) };
    }
    for (let turn = 1; turn <= options.turns; turn += 1) {
      state.turn = turn;
      if (turn > 1 && !state.combat) {
        record(state, cards, "opponent_turn_end", {
          opponent_model: "unspecified_pass", life_reduced: false,
        }, turn - 1);
        resolveOpponentEndStep(
          state, cards, targets, false, "unspecified_pass");
        state.fieldFlashUsed.clear();
        state.mainActivatedUsed.clear();
      }
      state.handReactionNames.clear();
      state.openReactionNames.clear();
      state.trashReactionNames.clear();
      state.trashReactionCardUses = {};
      state.sealedKourinNames.clear();
      state.oracleNameUsed.clear();
      state.bugCoreSupplyUsed.clear();
      // ⓪相手の2値分岐(5C-2Aのみ)。除去は直前の相手ターンを表すので、自分のコア
      // ステップより前に抽選する。5C-2Aでは結果を盤面へ適用しない。
      sampleOpponentBranches(state, cards, options);
      // ①スタートステップ。公式の7ステップ(page05)は戦闘モードだけ棋譜へ出す。
      if (state.combat) record(state, cards, "step_start");
      // ②コアステップ(先攻1ターン目のみ無し)
      if (!(options.going_first && turn === 1)) {
        state.reserve += 1;
        if (state.combat) record(state, cards, "step_core", { gained: 1 });
      }
      // ③ドローステップ
      draw(state, cards, 1, "draw_step");
      if (state.combat) record(state, cards, "step_draw", { drawn: 1 });
      // ④リフレッシュステップ(トラッシュ→リザーブ＋疲労の全回復)
      state.reserve += state.spent;
      state.reserveHasSoul = state.reserveHasSoul || state.trashHasSoul;
      state.spent = 0;
      state.trashHasSoul = false;
      if (state.combat) {
        // 回復は**1段ずつ**。裁定「重疲労状態のスピリットは…1回の回復で疲労
        // 状態になり、再度回復すると回復状態になります」。重疲労はここでは
        // 疲労になるだけで立たない。Python側と同型。
        const recovered = state.field.filter((unit) => unit.exhausted)
          .map((unit) => unit.uid).sort((left, right) => left - right);
        for (const unit of state.field) {
          if (unit.heavy_exhausted) unit.heavy_exhausted = false;
          else unit.exhausted = false;
        }
        record(state, cards, "step_refresh", { recovered_uids: recovered });
      }
      // ⑤メインステップ(turn_start〜turn_endがその開始と終了)
      record(state, cards, "turn_start");
      // 盤面のフラッシュ効果は**メインステップでも撃てる**(ステップ指定の無い
      // 『フラッシュ』はメインステップのフラッシュタイミングでも使える。Q2508)。
      // メインの手を打つ前に一度試す——カウントを増やすフラッシュ効果は、その
      // ターンのプレイに使えなければ意味が半減する。Python `_resolve_all_field_flash` と同一。
      resolveAllFieldFlash(state, cards, targets);
      noteLegalCandidates(state, cards, targets);
      if (options.force_contract_turn1 && turn === 1 && packet.deck.contract_card_no
          && state.hand.includes(packet.deck.contract_card_no)) {
        const forced = legalCandidates(state, cards, targets,
          new Set([packet.deck.contract_card_no]))[0];
        if (forced) {
          play(state, cards, targets, { ...forced, allow_sacrifice: true });
          noteLegalCandidates(state, cards, targets);
        }
      }
      const mirageChoices = state.hand.filter((cardNo) => {
        const card = cards[cardNo];
        return card?.mirage_cost !== null && card?.mirage_cost !== undefined
          && (card.enablers || []).some((effect) => effect.mode === "on_set"
            && ["draw", "coreboost", "core_to_trash"].includes(effect.kind))
          && card.mirage_cost <= reclaimable(state, true, cards);
      }).sort((left, right) => accessTier(left, cards, targets) - accessTier(right, cards, targets)
        || cards[left].mirage_cost - cards[right].mirage_cost || left.localeCompare(right));
      if (mirageChoices.length
          && performMirageSet(state, cards, targets, mirageChoices[0])) {
        noteLegalCandidates(state, cards, targets);
      }
      const usefulBurstEffects = (cardNo) => (cards[cardNo].burst_effects || [])
        .filter((effect) => burstEffectIsUseful(cards[cardNo], effect));
      const burstChoices = state.hand.filter(
        (cardNo) => usefulBurstEffects(cardNo).length);
      if (burstChoices.length) {
        burstChoices.sort((left, right) =>
          Number(!(cards[left].burst_reactions || []).length)
            - Number(!(cards[right].burst_reactions || []).length)
          || accessTier(left, cards, targets) - accessTier(right, cards, targets)
          || usefulBurstEffects(right).length - usefulBurstEffects(left).length
          || (cards[left].cost || 0) - (cards[right].cost || 0));
        const cardNo = burstChoices[0];
        state.hand.splice(state.hand.indexOf(cardNo), 1);
        if (state.burst) {
          const replaced = state.burst;
          state.burst = cardNo;
          state.trashCards.push(replaced);
          record(state, cards, "burst_replaced", {
            card_no: replaced, destination: "trash", replacement: cardNo,
          });
        } else state.burst = cardNo;
        record(state, cards, "burst_set", { card_no: cardNo, source: "rule" });
        noteLegalCandidates(state, cards, targets);
      }
      resolveMainActivatedEffects(state, cards, targets);
      resolveTrashMainSummon(state, cards, targets);
      // 6C-3 「バーストのフラッシュ効果のためにコアを残すか」。**両方を最後まで
      // 試して、目的関数(dig + handGain)が大きいほうを採る**。残す側の見返りは
      // 本体効果を実測した増分、出し切る側の見返りはプレイの増分。**残す損失は
      // テンポだけ**(未使用のリザーブは次の自分のターンへ持ち越す)なので、
      // 比べるのはこの2つのスコアだけでよい。同点なら**出し切る**——バーストは
      // 相手が踏まなければ0点のままで、その二値は近似でしかない。
      // Python `_burst_hold_candidate` 以下と同一。
      const holdPlan = burstHoldCandidate(state, cards);
      if (!holdPlan) {
        playOutMainStep(state, cards, targets, 0);
      } else {
        const spendTrial = clone(state);
        spendTrial.trace = false;
        spendTrial.events = [];
        playOutMainStep(spendTrial, cards, targets, 0);
        const spendScore = spendTrial.dig + spendTrial.handGain
          + burstFollowupGain(spendTrial, cards, targets, holdPlan);
        const holdTrial = clone(state);
        holdTrial.trace = false;
        holdTrial.events = [];
        playOutMainStep(holdTrial, cards, targets, holdPlan.cost);
        const holdScore = holdTrial.dig + holdTrial.handGain
          + burstFollowupGain(holdTrial, cards, targets, holdPlan);
        const held = holdScore > spendScore;
        record(state, cards, "burst_hold", {
          card_no: holdPlan.card_no, cost: holdPlan.cost, held,
          spend_score: spendScore, hold_score: holdScore,
        });
        playOutMainStep(state, cards, targets, held ? holdPlan.cost : 0);
      }
      // ⑥アタックステップ。先攻1ターン目には存在しない(公式 page05)。解決は
      // Stage6が行う——相手の盤面が要るのでこの試行の中では決められない。
      // 位置はPython側と同じ「メインの後・ターン末のrecurringより前」。
      if (state.combat && !(options.going_first && turn === 1)) {
        record(state, cards, "step_attack");
        yield { turn, step: "attack", board: combatBoard(state, cards, targets) };
      }
      // メインの後にもう一度試す。入口では条件(Lv・支払い)が揃っていなくても、
      // メインでコアやカードが動いた後なら撃てることがある。〔ターンに1回〕が
      // あるので、入口で撃てていればここは何もしない。Python同一。
      resolveAllFieldFlash(state, cards, targets);
      for (const entry of state.recurring) {
        if (!state.field.some((unit) => unit.uid === entry.uid)) continue;
        for (const effect of entry.effects) {
          if (options.going_first && turn === 1
              && effect.recurring_timing === "attack_step") continue;
          resolveEffect(state, cards, targets, effect, entry.uid);
          flushCountReactions(state, cards, targets);
          noteLegalCandidates(state, cards, targets);
        }
      }
      noteLegalCandidates(state, cards, targets);
      allocateEndTurnLevelCores(state, cards, targets);
      // ⑦エンドステップ。**〔ターンに1回〕の数え直しはここ**(ユーザー裁定)。
      // ターン開始で消すと、自分のターンに撃った札が相手のターンでも撃てない
      // ままになる。Python `_end_step_reset` と同一。
      state.fieldFlashUsed.clear();
      state.mainActivatedUsed.clear();
      if (state.combat) record(state, cards, "step_end");
      record(state, cards, "turn_end");
      yield { turn, step: "turn_end",
        ...(state.combat ? { board: combatBoard(state, cards, targets) } : {}) };
    }
    const totalPlays = Object.values(state.playCounts).reduce((sum, value) => sum + value, 0);
    const idleTurns = Array.from({ length: options.turns }, (_, index) => index + 1)
      .filter((turn) => !state.playCounts[turn]).length;
    const residual = residualReduction(state, cards);
    const metrics = {
      dig: state.dig, hand_gain: state.handGain, side_gain: state.sideGain,
      sacrifice: state.sacrifice, total_plays: totalPlays, idle_turns: idleTurns,
      target_seen: [...targets].some((cardNo) => state.seen.has(cardNo)),
      target_playable: state.targetPlayableTurn !== null,
      target_playable_turn: state.targetPlayableTurn,
      residual_core_savings: residual.potential_core_savings,
    };
    if (options.stage5c) {
      metrics.board_units = state.field.filter((unit) => !unit.waiting).length;
    }
    return {
      seed: trialSeed, opening_hand: opening.opening_hand, metrics,
      resolved_branch_events: state.resolvedBranchEvents,
      played_cards: [...state.played].sort(),
      first_legal_turn_by_card: Object.fromEntries(
        Object.entries(state.legalFirstTurns).sort(([left], [right]) => left.localeCompare(right))),
      trace: trace ? {
        // v3=Stage4、v4=5C-1(分岐は保持するだけ)、v5=5C-2A(分岐を抽選して記録する)。
        trace_schema_version: state.branchSampling ? 6 : options.stage5c ? 5 : 4,
        stage_version: packet.stage_version,
        portable_runtime_version: RUNTIME_VERSION, seed: trialSeed,
        deck_id: null,
        deck_reference: { format: "BattleSpiritsDB.stage4-engine-packet",
          fingerprint: packet.fingerprint, assets_embedded: false },
        turns: options.turns, going_first: options.going_first,
        consider_mulligan: options.consider_mulligan,
        force_contract_turn1: options.force_contract_turn1,
        initial_hand: options.initial_hand, target_card_nos: options.target_card_nos,
        summary: { dig_index: state.dig, hand_gain: state.handGain,
          target_seen: metrics.target_seen, target_playable: metrics.target_playable,
          sacrifice_count: state.sacrifice, side_gain: state.sideGain, mirage_set: false },
        observation: { observation_event_counts: {}, unobserved_deck_counts: {},
          known_top_cards: [], known_bottom_cards: [], next_top_card_probability: {} },
        residual_reduction: residual,
        castability: { first_legal_turn_by_card: Object.fromEntries(
          Object.entries(state.legalFirstTurns).sort(([left], [right]) => left.localeCompare(right))) },
        stage5c: options.stage5c,
        resolved_branch_events: state.resolvedBranchEvents,
        events: state.events,
      } : null,
    };
  }

  function representativeRows(rows, hasTargets) {
    const names = ["dig", "hand_gain", "total_plays", "idle_turns", "sacrifice"];
    const centers = Object.fromEntries(names.map((name) => [name, median(rows.map((row) => row.metrics[name]))]));
    const spans = Object.fromEntries(names.map((name) => {
      const values = rows.map((row) => row.metrics[name]);
      return [name, Math.max(...values) - Math.min(...values)];
    }));
    const distance = (row) => names.reduce((sum, name) =>
      sum + Math.abs(row.metrics[name] - centers[name]) / (spans[name] || 1), 0);
    const expected = [...rows].sort((a, b) => distance(a) - distance(b) || a.seed - b.seed)[0];
    const efficient = [...rows].sort((a, b) =>
      b.metrics.dig - a.metrics.dig || b.metrics.hand_gain - a.metrics.hand_gain
      || b.metrics.total_plays - a.metrics.total_plays
      || a.metrics.sacrifice - b.metrics.sacrifice || a.seed - b.seed)[0];
    const bricked = [...rows].sort((a, b) =>
      b.metrics.idle_turns - a.metrics.idle_turns
      || a.metrics.total_plays - b.metrics.total_plays || a.metrics.dig - b.metrics.dig
      || a.metrics.hand_gain - b.metrics.hand_gain
      || Number(a.metrics.target_playable) - Number(b.metrics.target_playable)
      || a.seed - b.seed)[0];
    const selected = [
      ["expected", "想定棋譜", "試行群の主要指標の中央値に最も近い", expected],
      ["efficient", "最高効率棋譜", "試行内で掘削を第一に手札獲得・実プレイ数を比較", efficient],
      ["bricked", "最詰まり棋譜", "無行動ターンが多く、実プレイ数と掘削が少ない", bricked],
    ];
    if (hasTargets) {
      const reached = rows.filter((row) => row.metrics.target_playable_turn !== null)
        .sort((a, b) => a.metrics.target_playable_turn - b.metrics.target_playable_turn
          || b.metrics.dig - a.metrics.dig || a.seed - b.seed);
      if (reached.length) selected.push(["target_fastest", "最速到達棋譜",
        "指定した狙い札を最も早く合法プレイできた", reached[0]]);
    }
    return selected;
  }

  async function runSimulation(packet, rawOptions, callbacks = {}) {
    await Stage5PortableEngine.validatePacket(packet);
    const support = assessPacket(packet);
    if (!support.ok) {
      throw new Error(`このデッキに未コンパイルのStage4効果があります: ${support.unsupported.slice(0, 8).join(", ")}`);
    }
    const options = validateOptions(rawOptions);
    const root = new Stage5PortableRng.PortableRng(options.seed);
    const seeds = [];
    const used = new Set();
    while (seeds.length < options.trials) {
      const seed = root.safeInteger();
      if (!used.has(seed)) { used.add(seed); seeds.push(seed); }
    }
    const rows = [];
    for (let index = 0; index < seeds.length; index += 1) {
      if (callbacks.cancelled?.()) throw new Error("Stage4 Worker計算をキャンセルしました");
      rows.push(runTrial(packet, options, seeds[index], false));
      if ((index + 1) % 10 === 0 || index + 1 === seeds.length) {
        callbacks.progress?.(index + 1, seeds.length);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    const deckCardNos = packet.deck.cards.map((entry) => entry.card_no).sort();
    const castability = deckCardNos.map((cardNo) => {
      const reached = rows.map((row) => row.first_legal_turn_by_card[cardNo])
        .filter((turn) => turn !== undefined);
      return {
        card_no: cardNo,
        legal_trials: reached.length,
        legal_percent: Math.round(reached.length * 10000 / rows.length) / 100,
        mean_first_legal_turn: reached.length
          ? Math.round(reached.reduce((sum, turn) => sum + turn, 0) * 100 / reached.length) / 100
          : null,
      };
    });
    const actualPlay = deckCardNos.map((cardNo) => {
      const playedTrials = rows.filter((row) => row.played_cards.includes(cardNo)).length;
      return {
        card_no: cardNo, played_trials: playedTrials,
        played_percent: Math.round(playedTrials * 10000 / rows.length) / 100,
      };
    });
    const selections = representativeRows(rows, options.target_card_nos.length > 0);
    const scenarios = selections.map(([kind, label, objective, row]) => ({
      kind, label, objective, opening_hand: row.opening_hand, metrics: row.metrics,
      replay: { seed: row.seed, initial_hand: options.initial_hand },
      trace: runTrial(packet, options, row.seed, true).trace,
    }));
    const branchSampling = options.stage5c?.mode === Stage5CContract.BRANCH_SAMPLING_MODE
      ? {
        mode: options.stage5c.mode,
        applied_to_board: false,
        by_kind: BRANCH_KEYS.map((kind) => {
          const events = rows.flatMap((row) =>
            row.resolved_branch_events.filter((event) => event.kind === kind));
          const statusCounts = {};
          for (const event of events) {
            statusCounts[event.status] = (statusCounts[event.status] || 0) + 1;
          }
          const resolvedTrials = rows.filter((row) => row.resolved_branch_events
            .some((event) => event.kind === kind && event.resolved)).length;
          return {
            kind,
            probability: options.stage5c.branch_probabilities[kind],
            sampled_events: events.length,
            resolved_events: events.filter((event) => event.resolved).length,
            resolved_trials: resolvedTrials,
            resolved_trial_percent: Math.round(resolvedTrials * 10000 / rows.length) / 100,
            status_counts: Object.fromEntries(
              Object.entries(statusCounts).sort(([left], [right]) => left.localeCompare(right))),
          };
        }),
      }
      : null;
    return {
      runtime_version: RUNTIME_VERSION, stage_version: packet.stage_version,
      packet_fingerprint: packet.fingerprint, trials: options.trials,
      options, support,
      ...(branchSampling ? { branch_sampling: branchSampling } : {}),
      castability: { definition: "modeled_legal_route_observed_in_hand", by_card: castability },
      actual_play: { by_card: actualPlay },
      scenarios,
    };
  }

  function verifyGolden(fixture) {
    const cases = fixture?.portable_core?.payment_cases;
    if (!Array.isArray(cases)) throw new Error("5B-2 portable core goldenがありません");
    const failures = cases.filter((row) =>
      Stage5PortableStore.stableStringify(paymentFor(row.card, row.symbols, row.count))
      !== Stage5PortableStore.stableStringify(row.expected)).map((row) => row.name);
    return { ok: failures.length === 0, cases: cases.length, failures };
  }

  function trialGoldenSignature(result) {
    const eventTypes = (result.trace?.events || []).map((event) => event.type);
    let eventHash = 0x811c9dc5;
    for (const character of eventTypes.join("\n")) {
      eventHash ^= character.charCodeAt(0);
      eventHash = Math.imul(eventHash, 0x01000193) >>> 0;
    }
    return {
      opening_hand: result.opening_hand,
      metrics: result.metrics,
      plays: (result.trace?.events || []).filter((event) => event.type === "play_complete")
        .map((event) => ({ turn: event.turn, details: event.details })),
      event_count: eventTypes.length,
      event_types_fnv1a32: eventHash.toString(16).padStart(8, "0"),
      ...(result.trace?.stage5c?.mode === Stage5CContract.BRANCH_SAMPLING_MODE
        ? { resolved_branch_events: result.resolved_branch_events } : {}),
    };
  }

  globalThis.Stage5PortableSimulation = {
    RUNTIME_VERSION, SUPPORTED_EFFECTS, SUPPORTED_BURST_EFFECTS, assessPacket, legalCandidates,
    // playableCandidates は方針が実際に見る候補。Python側と突き合わせるために
    // 露出させてある(合法候補 legalCandidates との差が方針の絞り込み)。
    playableCandidates,
    paymentFor, representativeRows, runSimulation, runTrial, runTrialStream,
    winningBlockValue, selectBounceTargets,
    trialGoldenSignature, verifyGolden,
    // Stage6が実イベントから開けるバーストの条件(6C-2)。**正典はここ**で、
    // `stage6_sim.js`はこれを引く(Python側で`stage6_sim`が`stage4_sim`から
    // importしているのと同じ向き)。片方だけ足すと、規則はあるのに一度も
    // 効かない状態になり掃検でも見つからない。
    BURST_LIFE_LOSS, BURST_OPPONENT_ATTACK, BURST_OWN_DESTROYED,
    BURST_OWN_LEFT_FIELD, OBSERVABLE_BURST_CATEGORIES,
    // ⓪の物差し。**正典はここ**で`stage6_sim.js`が引く(2026-08-23、①)。
    turnsToFinish,
  };
})();

// Stage6 two-player trace: A-1 (no combat) and 6B-1 (attack step).
// Python側 `app/stage6_sim.py` と1対1で対応させること。片方だけ直すと
// PWAのPython/Worker照合が食い違って表示が止まる。
(() => {
  "use strict";

  const TRACE_FORMAT = "BattleSpiritsDB.stage6-trace";
  const TRACE_FORMAT_VERSION = 1;
  const TRACE_MODE = "stage6a1-alternating-main-v1";
  const RUNTIME_VERSION = "stage6a1-portable-v3";
  const COMBAT_MODE = "stage6b1-combat-v1";
  const COMBAT_RUNTIME_VERSION = "stage6b1-portable-v4";
  // 方針を変えたらここを上げる(棋譜の`policy`がこの版を持つ)。ルールの版
  // `COMBAT_MODE`とは別物。v2(2026-08-22): 削り切りの判定を1体ずつから
  // **アタックステップ合計**へ(`lethalStepPlan`)。Python同一。
  // v5: 受けなければ現在の公開打点段で期限が縮み、BP勝ちして守りの体を
  // 失わずに討ち取れるとき、盤面の有利交換としてブロックする(Python同一)。
  // v6: 同じステップの後続まで見て、厳密BP勝ちで防げるシンボル合計が最大に
  // なるよう壁を配る。理由は増やさず、既存の有利ブロックの割当だけを直す。
  // v7: バウンス対象を現在ステップの詰み、勝利/敗北期限、手札再使用リスクで
  // 選ぶ。複数対象は組全体を比較する(Python同一)。
  // v8: 宣言する前に「宣言したら誰が退くか」を一度解いて巻き戻し、その事実を
  // 見積もり3箇所(attackReason/attackOrder/stepDamageThrough)へ配る。相手にも
  // 同じ先読みを与える。相手の伏せたバーストは開かない(Python同一)。
  const COMBAT_POLICY = "combat-victory-plan-v8";
  const PLAYER_IDS = ["self", "opponent"];
  const CAPABILITIES = Object.freeze({
    dual_deck_execution: true,
    separate_player_state: true,
    alternating_main_turns: true,
    independent_rng_streams: true,
    combat: false,
    reaction_windows: false,
    // 印字の『アタック時』『ブロック時』を実際に発揮するか(6B-1②)。
    combat_triggers: false,
    // バトルの中の下位の窓(6C)。手札から使うフラッシュタイミングはまだ無い。
    battle_subwindows: false,
    // セット中バーストを実イベントで開くか(6C-2)。開くかどうかの方針は別。
    burst_triggers: false,
    burst_policy: false,
    // 手札から使うフラッシュタイミング(6C-2B)。いま開くのは公式手順4だけ。
    flash_defense_window: false,
    // 窓を渡す代償をアタック方針の入力に入れるか(6C-2B続き)。
    attack_window_cost: false,
    bounce_target_policy: false,
    victory: false,
    // 公式の勝利条件②「対戦相手のスタートステップで、相手のデッキが0枚だった」。
    // ライフ0(`victory`)とは判定の時点が違う遅延判定なので別に名乗る。Python同一。
    deck_out_victory: false,
    representative_search: false,
  });
  const COMBAT_CAPABILITIES = Object.freeze({
    ...CAPABILITIES,
    combat: true,
    reaction_windows: false,
    combat_triggers: true,
    battle_subwindows: true,
    burst_triggers: true,
    // 6C-3: セット中バーストの本体効果のためにコアを残すか、出し切って手札を
    // プレイするかを**期待値で比べる**。Python COMBAT_CAPABILITIES と同一。
    burst_policy: true,
    flash_defense_window: true,
    attack_window_cost: true,
    bounce_target_policy: true,
    victory: true,
    // デッキ切れ敗北(2026-08-23)。これが無いあいだ、山札が0になった試合は
    // 終わらずに空回りしていた。Python同一。
    deck_out_victory: true,
  });
  const FORBIDDEN_EVENT_TYPES = new Set([
    "attack_declared", "block_declared", "life_damaged", "battle_resolved",
    "destroyed_by_battle", "burst_activated", "flash_defense_played",
    "field_flash_resolved",
    "attack_effects_resolved", "block_effects_resolved",
    "blocked_effects_resolved", "battle_end_effects_resolved",
    "opponent_end_effect_resolved",
  ]);
  const COMBAT_EVENT_TYPES = new Set([
    "attack_declared", "block_declared", "battle_resolved", "life_damaged",
    "destroyed_by_battle", "match_won",
    // 6B-1②: 印字の『アタック時』『ブロック時』を実際に発揮した記録。
    "attack_effects_resolved", "block_effects_resolved",
    // 6C: 下位の窓。宣言の窓とは別の時点なので別のイベントで出す。
    "blocked_effects_resolved", "battle_end_effects_resolved",
    "opponent_end_effect_resolved",
    // 6C-2: セット中バーストを実イベント(いまはライフ減少)で開いた記録。
    "burst_activated",
    // 6C-2B: 守り手が手札からフラッシュの防御札を使った記録。
    "flash_defense_played",
    // 6C-2B続き: 守り手が相手のターンのフラッシュタイミングで場の効果を撃った記録。
    "field_flash_resolved",
  ]);
  const TURN_EVENT_TYPES = new Set(["turn_start", "turn_end"]);
  const STEP_EVENT_PHASES = {
    step_start: "start", step_core: "core", step_draw: "draw",
    step_refresh: "refresh", step_attack: "attack", step_end: "end",
  };
  // Python側 MAIN_EVENT_TYPES と同一。メインステップの中でStage4が記録する
  // イベントで、`detail`を指定した棋譜だけが載せる。片方に足し忘れると
  // 詳細モードの棋譜がPython/Workerで食い違う。
  const MAIN_EVENT_TYPES = new Set([
    "bp_changed",
    "branch_sampled", "burst_replaced", "burst_set", "card_entered", "card_moved",
    "cards_opened", "cards_returned_to_deck", "cards_selected", "core_moved",
    "cost_calculated", "cost_paid", "count_gained", "draw", "effect_complete",
    "effect_start", "field_leave_queued", "field_left", "level_allocate",
    "mirage_set", "open_reaction_declared", "open_reaction_queued", "opening_hand",
    "play_complete", "play_presented", "deck_top_revealed",
    "card_excluded", "trash_summon_declared", "effect_free_summon_declared",
    // アタックの窓で付いた一時シンボル(2026-08-31)。
    "symbol_granted",
    "opponent_turn_end",
    // 契約カードが場を離れる代わりに魂状態になった記録(`field_left`とは別)。
    "soul_state_entered",
    // 魂状態から《契約煌臨》で戻った記録(Python同一)。
    "soul_state_left",
    // 『ライフ保護』が効き始めた記録(6C-2B)。
    "life_protected",
    // 6C-3: バーストの本体効果のためにコアを残すかの判断。**残さなかった側も
    // 書く**——「方針が働いて出し切りを選んだ」のと「判断の入口にすら来ていない」
    // のは別の話で、後者は何も出ない。
    "burst_hold",
  ]);
  // 詳細を載せた棋譜だけが名乗る版。既定の棋譜には**キーごと存在しない**
  // （null を1つ足すだけでもfingerprintが動くため）。
  const DETAIL_LEVEL = "main-events-v3";
  // Stage4のdetailsには解決順を制御する内部作業キーもある。Stage6の公開詳細棋譜へ
  // 写す境界でだけ除外し、nullableキーは必ず載せてPythonと同じ形へ固定する。
  const INTERNAL_DETAIL_KEYS = Object.freeze({
    play_complete: Object.freeze(["fara_bug_destruction_triggers"]),
  });
  const NULLABLE_DETAIL_KEYS = Object.freeze({
    field_left: Object.freeze(["target_uid"]),
  });

  function publicMainEventDetails(type, details) {
    const result = structuredClone(details || {});
    for (const key of INTERNAL_DETAIL_KEYS[type] || []) delete result[key];
    for (const key of NULLABLE_DETAIL_KEYS[type] || []) {
      if (!Object.prototype.hasOwnProperty.call(result, key)) result[key] = null;
    }
    return result;
  }
  // 方針の語彙。Python側 SELF_GAIN_ACTIONS / OPPONENT_LOSS_ACTIONS と同一。
  const SELF_GAIN_ACTIONS = new Set([
    "ドロー", "サーチ", "回収", "コアブースト", "創界神コア増加", "自己回収",
    "創界石コア増加", "コア回収", "ソウルコア回収", "手札交換", "コア移動",
    "創界神コア移動", "トークン生成", "カウント増", "ライフ増加",
  ]);
  // ⭐ 末尾3種は2026-08-30に追加。ルール側(`_BOARD_INTERFERENCE_KINDS`)が
  // 解決できるのに方針だけが見ていなかった「体を動けなくする」語で、
  // 実データはアタック時 疲労36行/重疲労32行/BP減少21行。理由と計測は
  // Python `stage6_sim.OPPONENT_LOSS_ACTIONS` のコメントを正とする。
  const OPPONENT_LOSS_ACTIONS = new Set([
    "破壊", "バウンス", "コア除去", "除外", "バースト破棄", "創界神コア減少",
    "場残り阻止", "ライフ削減", "手札破壊", "デッキ破棄", "デッキ削り", "カウント減",
    "疲労", "重疲労", "BP減少",
  ]);
  const SELF_SIDES = new Set(["自分", "自身"]);

  const stableStringify = (value) => Stage5PortableStore.stableStringify(value);

  async function sha256Hex(value) {
    const digest = await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(stableStringify(value)));
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function streamSeeds(rootSeed, playerId) {
    return {
      deck_shuffle: Stage5PortableRng.deriveStreamSeed(
        rootSeed, `stage6a1:${playerId}:deck-shuffle`),
      main_decision: Stage5PortableRng.deriveStreamSeed(
        rootSeed, `stage6a1:${playerId}:main-decision`),
    };
  }

  function canonicalState(state) {
    const result = structuredClone(state);
    result.trash_cards = [...(result.trash_cards || [])].sort();
    result.side_cards = [...(result.side_cards || [])].sort();
    for (const unit of result.field || []) {
      unit.protections = [...(unit.protections || [])].sort();
    }
    return result;
  }

  async function startPlayer(packet, player, match, playerId, combat, choiceDebug = null) {
    await Stage5PortableEngine.validatePacket(packet);
    if (packet.fingerprint !== player.engine_packet_fingerprint) {
      throw new Error(`${playerId} packet does not match the Stage6 contract`);
    }
    if (stableStringify(packet.deck) !== stableStringify(player.deck)) {
      throw new Error(`${playerId} deck does not match the Stage6 contract`);
    }
    const seeds = streamSeeds(match.seed, playerId);
    const state = { events: null };
    const stream = Stage5PortableSimulation.runTrialStream(packet, {
      turns: match.max_rounds,
      going_first: playerId === match.first_player,
      consider_mulligan: player.options.consider_mulligan,
      force_contract_turn1: player.options.force_contract_turn1,
      target_card_nos: player.options.target_card_nos,
      initial_hand: player.opening.initial_hand,
      stage5c: null,
      combat,
      choice_debug: choiceDebug,
    }, seeds.deck_shuffle, true);
    return {
      player_id: playerId,
      going_first: playerId === match.first_player,
      seeds, stream, state,
      finished: false, result: null, board: null,
      // generator自身のイベントだけを詳細棋譜へ載せる。停止中に相手の処理から
      // board APIへ記録された行はStage6の実時系列イベント側で表す(Python同一)。
      stage6_source_seqs: new Set(),
      stage6_external_seqs: new Set(),
    };
  }

  // 1ターン(または開幕・アタックステップ)ぶんだけ進める。終わったらnull。
  function advanceTurn(runner) {
    if (runner.finished) return null;
    const before = runner.board?.events()?.length || 0;
    const step = runner.stream.next();
    if (step.done) {
      runner.result = step.value;
      runner.finished = true;
      const events = runner.result?.trace?.events || runner.board?.events() || [];
      for (const event of events.slice(before)) runner.stage6_source_seqs.add(event.seq);
      return null;
    }
    if (step.value?.board) runner.board = step.value.board;
    const events = runner.board?.events() || [];
    for (const event of events.slice(before)) runner.stage6_source_seqs.add(event.seq);
    return step.value;
  }

  function finishPlayer(runner, aborted) {
    if (aborted) {
      // 決着後のターンを裏で回して統計に混ぜない(Python側と同じ規約)。
      runner.stream.return(null);
      runner.finished = true;
    }
    while (!runner.finished) advanceTurn(runner);
    const result = runner.result;
    // 打ち切った試行は戻り値が無いので、盤面の口から記録済みイベントを読む。
    const traceEvents = result ? (result.trace?.events || []) : (runner.board?.events() || []);
    if (!traceEvents.length || traceEvents[0].type !== "opening_hand") {
      throw new Error("Stage4 trace did not provide an opening state");
    }
    return {
      player_id: runner.player_id,
      going_first: runner.going_first,
      seed_streams: {
        deck_shuffle: { seed: runner.seeds.deck_shuffle, consumed: true },
        main_decision: { seed: runner.seeds.main_decision, consumed: false },
      },
      opening_hand: result ? result.opening_hand : [...traceEvents[0].state.hand],
      metrics: result ? result.metrics : null,
      event_count: traceEvents.filter((event) => TURN_EVENT_TYPES.has(event.type)).length,
      final_state: canonicalState(traceEvents.at(-1).state),
      _events: traceEvents,
    };
  }

  // ---- 戦闘方針(Python側 `_choose_blocker` / `_attack_reason` と同一) ----
  function combatTrigger(action) {
    const timing = action.timing;
    if (!timing || timing.startsWith("相手")) return null;
    if (timing.includes("アタック時") || action.requires_own_attack) return "attack";
    if (timing.includes("ブロック時") || timing.includes("バトル時")) return "block";
    return null;
  }

  /** その体が戦闘に出たときのシンボル数(=通ったときのライフ減少量)。
   *  公式page08「アタックしたスピリットやアルティメットのシンボルと同じ数だけ、
   *  防御側のライフに置かれたコアを減らし、リザーブに移します」。 */
  function battleSymbolCount(stage4) {
    return Object.values(stage4.symbols || {}).reduce((sum, n) => sum + n, 0);
  }

  /** **構築から「1ターンに出せる打点」を割り出す**(⓪)。Python `build_victory_plan`
   *  と同一。序盤の1点の価値は「1点」ではなく、**残りを到達可能な打点で割り切れる
   *  形へ持っていったこと**にある——ライフ5に打点2では3回、4にすれば2回。
   *  効果による『シンボル追加』はまだ数えない(読めない形が大半で、当て込むと
   *  打点を過大評価する)。入力はengine packet——契約の`catalog`は指紋しか持たない。 */
  function buildVictoryPlan(packet) {
    const byNo = new Map((packet.definitions || []).map(
      (row) => [row.card_no, row.stage4 || {}]));
    const bodies = [];
    const braves = [];
    const braveByNo = {};
    let combineSlots = 1;
    let extraSlots = 0;
    for (const entry of (packet.deck || {}).cards || []) {
      const stage4 = byNo.get(entry.card_no);
      if (!stage4 || stage4.is_token) continue;
      const symbols = battleSymbolCount(stage4);
      combineSlots = Math.max(combineSlots, stage4.combine_slots || 1);
      extraSlots += stage4.extra_combine_slots || 0;
      if (stage4.is_brave) {
        braves.push(symbols);
        braveByNo[entry.card_no] = symbols;
        continue;
      }
      const cardType = stage4.card_type || "";
      if (!["スピリット", "アルティメット"].some((k) => cardType.includes(k))) continue;
      bodies.push(symbols);
    }
    bodies.sort((a, b) => b - a);
    braves.sort((a, b) => b - a);
    const slots = combineSlots + extraSlots;
    return {
      best_body_symbols: bodies[0] || 0,
      brave_symbols: braves.slice(0, slots),
      brave_symbols_by_card_no: braveByNo,
      combine_slots: combineSlots,
      extra_combine_slots: extraSlots,
      ceiling_damage: (bodies[0] || 0)
        + braves.slice(0, slots).reduce((sum, n) => sum + n, 0),
    };
  }

  /** **いま組める最良の体が出せる打点**(⓪の①)。Python `reachable_damage` と同一。
   *  ⚠️ アタックしている体自身を分母にすると条件が恒真になる（`ceil(L/s)`と
   *  `ceil((L-s)/s)`は必ず1違う）。分母は**これから殴る体**。 */
  function reachableDamage(plan, ownUnits, handBraves) {
    const slots = (plan.combine_slots || 1) + (plan.extra_combine_slots || 0);
    const free = Math.max(0, slots - 1);
    const best = (ownUnits || []).reduce(
      (max, row) => Math.max(max, row.symbol_count || 0), 0);
    return best + [...(handBraves || [])].sort((a, b) => b - a)
      .slice(0, free).reduce((sum, n) => sum + n, 0);
  }

  /** 自分の手札にあるブレイヴのシンボル数(多い順)。Python `_hand_brave_symbols` と同一。
   *  **自分の手札**なので方針が見てよい（相手の手札を見ないのと対の規約）。 */
  function handBraveSymbols(attackerBoard, plan) {
    if (!plan) return [];
    const byNo = plan.brave_symbols_by_card_no || {};
    const hand = (attackerBoard.snapshot() || {}).hand || [];
    return hand.filter((cardNo) => cardNo in byNo)
      .map((cardNo) => byNo[cardNo]).sort((a, b) => b - a);
  }

  function buildCombatProfiles(catalogCards, cardNos = null) {
    const wanted = cardNos ? new Set(cardNos) : null;
    const profiles = {};
    for (const card of catalogCards) {
      if (wanted && !wanted.has(card.card_no)) continue;
      const reasons = { attack: [], block: [] };
      for (const action of card.effect_actions || []) {
        const trigger = combatTrigger(action);
        if (!trigger) continue;
        if (SELF_GAIN_ACTIONS.has(action.action) && SELF_SIDES.has(action.target_side)) {
          reasons[trigger].push(`${action.action}(自分)`);
        } else if (OPPONENT_LOSS_ACTIONS.has(action.action) && action.target_side === "相手") {
          reasons[trigger].push(`${action.action}(相手)`);
        }
      }
      profiles[card.card_no] = {
        attack_gain: reasons.attack.length > 0,
        block_gain: reasons.block.length > 0,
        attack_reasons: [...new Set(reasons.attack)].sort(),
        block_reasons: [...new Set(reasons.block)].sort(),
      };
    }
    return profiles;
  }

  const EMPTY_PROFILE = Object.freeze({
    attack_gain: false, block_gain: false, attack_reasons: [], block_reasons: [],
  });
  const profileOf = (profiles, cardNo) => (profiles || {})[cardNo] || EMPTY_PROFILE;

  /** その体として撃たれる節をまとめた方針入力。Python `_row_profile` と同一。
   *  ルール側(`combatResolveTrigger`)はホストの節と**合体中のブレイヴの節**を
   *  同じ窓で撃つのに、方針だけがホストの`card_no`で引いていた。見る先は行が
   *  持つ`policy_card_nos`(ホスト＋合体中のブレイヴ)で、カード固有の分岐では
   *  ない——「この体としてどの節が撃たれるか」で引くので同型の新カードにも効く。
   *  ⚠️ 煌臨元は入れない(`works_as_contract_base`の節しか撃たれないため)。
   *  ⚠️ `policy_card_nos`が無い行は`card_no`だけを見る従来どおりの退化形。 */
  function rowProfile(profiles, row) {
    const cardNos = (row.policy_card_nos && row.policy_card_nos.length)
      ? row.policy_card_nos : [row.card_no];
    if (cardNos.length === 1) return profileOf(profiles, cardNos[0]);
    const attackReasons = new Set();
    const blockReasons = new Set();
    let attackGain = false;
    let blockGain = false;
    for (const cardNo of cardNos) {
      const profile = profileOf(profiles, cardNo);
      attackGain = attackGain || profile.attack_gain;
      blockGain = blockGain || profile.block_gain;
      for (const reason of profile.attack_reasons || []) attackReasons.add(reason);
      for (const reason of profile.block_reasons || []) blockReasons.add(reason);
    }
    return {
      attack_gain: attackGain,
      block_gain: blockGain,
      // Python は `sorted(set(...))` ＝コードポイント順。既定の `sort()` は
      // UTF-16コード単位順だが、語彙は全てBMP内なので同じ並びになる
      // (`buildCombatProfiles` の `attack_reasons` も同じ理由で既定の sort)。
      attack_reasons: [...attackReasons].sort(),
      block_reasons: [...blockReasons].sort(),
    };
  }

  const bestBlocker = (rows) => rows.reduce((best, row) =>
    (!best || row.bp > best.bp || (row.bp === best.bp && row.uid < best.uid)) ? row : best, null);

  function chooseBlockerDecision(attacker, blockers, defenderLife, profiles,
    planDamage = null, laterAttackers = null) {
    if (!blockers.length) return { blocker: null, reason: null };
    const gainful = blockers.filter((row) => rowProfile(profiles, row).block_gain);
    if (gainful.length) {
      // BP同値は両者破壊なので「生き残る」には含めない。生き残れるなら、後続へ
      // 強い体を残すため**勝てる中で最小BP**を使う(Python同一)。
      const survivors = gainful.filter((row) => row.bp > attacker.bp);
      const blocker = survivors.length
        ? survivors.slice().sort((left, right) => left.bp - right.bp || left.uid - right.uid)[0]
        : bestBlocker(gainful);
      return { blocker, reason: "block_effect_gains_resources" };
    }
    if (defenderLife <= attacker.symbol_count) {
      return { blocker: bestBlocker(blockers), reason: "lethal_attack_blocked" };
    }
    if (planDamage) {
      const before = turnsToFinish(defenderLife, planDamage);
      const after = turnsToFinish(defenderLife - attacker.symbol_count, planDamage);
      if (before !== null && after !== null && after < before) {
        const winners = blockers.filter((row) => row.bp > attacker.bp);
        if (winners.length) {
          let choices = winners.map((blocker) => ({ blocker,
            value: (attacker.symbol_count || 0) + winningBlockValue(
              laterAttackers, blockers.filter((other) => other.uid !== blocker.uid)) }));
          if (laterAttackers?.length) {
            const savedValue = winningBlockValue(laterAttackers, blockers);
            const bestValue = Math.max(...choices.map((choice) => choice.value));
            if (savedValue > bestValue) return { blocker: null, reason: null };
            choices = choices.filter((choice) => choice.value === bestValue);
          }
          const blocker = choices.map((choice) => choice.blocker).sort(
            (left, right) => left.bp - right.bp || left.uid - right.uid)[0];
          return { blocker, reason: "favorable_battle_preserves_clock" };
        }
      }
    }
    return { blocker: null, reason: null };
  }

  function chooseBlocker(attacker, blockers, defenderLife, profiles, planDamage = null,
    laterAttackers = null) {
    return chooseBlockerDecision(
      attacker, blockers, defenderLife, profiles, planDamage, laterAttackers).blocker;
  }

  function battleOutcome(attackerBp, blockerBp) {
    if (blockerBp > attackerBp) return "attacker_destroyed";
    if (blockerBp < attackerBp) return "blocker_destroyed";
    return "both_destroyed";
  }

  /** アタックを宣言すると**相手に渡してしまうもの**(6C-2B続き、Python
   *  `_window_gift` と同一)。読むのは**公開情報だけ**——盤面のフラッシュ効果の
   *  候補・魂状態のカード・リザーブと場の余剰コア・デッキリスト(対面知識)。
   *  **手札は見ない**。 */
  function windowGift(defenderBoard) {
    const capacity = defenderBoard.flash_window_capacity();
    return {
      field_flash: defenderBoard.field_flash_options().map((row) => row.card_no),
      soul_kourin: capacity.soul_kourin,
      can_stop_step: capacity.can_pay,
      payable: capacity.payable,
    };
  }

  /** 削り切りを抜きにしても宣言される体か(Python `_declares_without_lethal` と同一)。
   *  `lethalStepPlan`が「ブロッカーが1体使われるか」を読むために要る——
   *  **見送る体はブロックもされないのでブロッカーを減らさない**。 */
  function declaresWithoutLethal(attacker, profiles, gift) {
    if (!rowProfile(profiles, attacker).attack_gain) return false;
    return !(gift && (gift.field_flash.length || gift.soul_kourin));
  }

  /** 宣言したら**誰が退くか**を、体ごとに一度だけ解いて巻き戻す。
   *  Python `preview_attack_windows` と同一。返すのは盤面ではなく
   *  **小さな事実**(退いたuidの集合と、その窓で減った相手ライフ)——見積もりの
   *  消費側が3つ(`attackReason`/`attackOrder`/`stepDamageThrough`)あるので、
   *  盤面を配ると3箇所が別々の盤面を持つ。事実なら同じものを配れて、
   *  `chooseBlockerDecision`の定義は1つのまま。
   *  ⚠️ 巻き戻しの機構はPythonが`_snapshot`/`_restore`、こちらが`clone(state)`で
   *  **別物**なので、契約は必ず事実の側に置く(`DECISIONS.md` D13)。
   *  ⚠️ 相手の盤面も巻き戻す(アタック時効果は相手の盤面へ届く)。
   *  ⚠️ 近似である——解くのはステップ入口の盤面で、実際には2体目の窓は1体目の
   *  バトルが終わってから開く。
   *  ⚠️ 『相手のアタック後』のバーストは解かない(相手の非公開情報)。
   *  口を持たない盤面では**空を返す**ので、先読み無しの従来どおりに退化する。 */
  function previewAttackWindows(attackerBoard, defenderBoard) {
    for (const board of [attackerBoard, defenderBoard]) {
      if (typeof board.trial_snapshot !== "function"
        || typeof board.trial_restore !== "function") return new Map();
    }
    const beforeUids = new Set(defenderBoard.units().map((row) => row.uid));
    const beforeExhausted = new Set(
      defenderBoard.units().filter((row) => row.exhausted).map((row) => row.uid));
    const beforeLife = defenderBoard.life();
    const preview = new Map();
    for (const row of attackerBoard.units()) {
      if (row.exhausted) continue;
      const uid = row.uid;
      const ownState = attackerBoard.trial_snapshot();
      const theirState = defenderBoard.trial_snapshot();
      let gone;
      let lifeLoss;
      try {
        // 実際の手順と同じ順で解く(宣言＝疲労のあとにアタック時効果)。
        attackerBoard.exhaust(uid);
        attackerBoard.resolve_trigger(uid, "attack", defenderBoard);
        const after = defenderBoard.units();
        const afterUids = new Set(after.map((entry) => entry.uid));
        // 疲労・重疲労は場に残るがブロックできないので、退いた扱いにする。
        gone = new Set([...beforeUids].filter((entry) => !afterUids.has(entry)));
        for (const entry of after) {
          if (entry.exhausted && !beforeExhausted.has(entry.uid)) gone.add(entry.uid);
        }
        lifeLoss = Math.max(0, beforeLife - defenderBoard.life());
      } finally {
        attackerBoard.trial_restore(ownState);
        defenderBoard.trial_restore(theirState);
      }
      if (gone.size || lifeLoss) {
        preview.set(uid, { removed_uids: gone, life_loss: lifeLoss });
      }
    }
    return preview;
  }

  /** 1体ぶんの先読みを、ブロッカー候補と相手ライフへ当てる。
   *  Python `_previewed` と同一。先読みが無ければそのまま返す。 */
  function previewed(blockers, life, preview, uid) {
    const fact = preview && typeof preview.get === "function" ? preview.get(uid) : null;
    if (!fact) return [blockers, life];
    return [blockers.filter((row) => !fact.removed_uids.has(row.uid)),
      life - fact.life_loss];
  }

  /** このアタックステップの**合計**でライフを0にできるか(Python `_lethal_step_plan`
   *  と同一)。できるなら寄与するuidの集合、できないなら空集合。
   *  ユーザー方針②「**この**アタックで相手のライフが尽きる」を**アタックステップ
   *  単位**で読み直したもので、**新しい殴る理由は足していない**。
   *  ブロッカーは疲労するのでステップ内で有限だが、減るのは**実際に宣言される体を
   *  止めたときだけ**。相手の手札・伏せたバーストは読まないので**上振れしうる**。 */
  function lethalStepPlan(order, attackerBoard, defenderBoard, profiles, gift,
    planDamage = null, preview = null) {
    const units = new Map(attackerBoard.units().map((row) => [row.uid, row]));
    const life = defenderBoard.life();
    if (life <= 0) return new Set();
    const blockers = defenderBoard.units().filter((row) => !row.exhausted);
    const [landed, contributors] = stepDamageThrough(
      order.map((uid) => units.get(uid)), blockers, life, profiles, gift, planDamage,
      preview);
    return landed >= life ? new Set(contributors) : new Set();
  }

  /** そのアタックステップで**実際にライフへ通る打点**と、寄与した体のuid。
   *  ⭐ **削り切りの判定と相手の時計が、どちらもこれを使う**——②を入れたとき
   *  `defeatClock`だけ「場の最大1体」で数えており、同じ「1ステップで何点通るか」
   *  を2つの数え方で見ていた。Python `_step_damage_through` と同一。
   *  ブロッカーは1体につき1回。減るのは**それでも宣言される体**を止めたときだけ。 */
  function stepDamageThrough(orderUnits, blockers, life, profiles, gift = null,
    planDamage = null, preview = null) {
    const rows = orderUnits.filter(Boolean);
    // デッキ上限ではなく**現在の公開盤面が到達済みの打点段**(Python同一)。
    const publicDamage = planDamage === null
      ? rows.reduce((best, row) => Math.max(best, row.symbol_count || 0), 0)
      : planDamage;
    let remaining = [...blockers];
    const contributors = [];
    let landed = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const attacker = rows[index];
      if (!attacker || attacker.exhausted) continue;
      // ⭐ その体が宣言したら退くぶんを引いてから読む(Python同一)。
      const [seenBlockers, seenLife] = previewed(
        remaining, life - landed, preview, attacker.uid);
      const blockDecision = chooseBlockerDecision(
        attacker, seenBlockers, seenLife, profiles, publicDamage,
        rows.slice(index + 1));
      const blocker = blockDecision.blocker;
      if (blocker) {
        const outcome = battleOutcome(attacker.bp, blocker.bp);
        const declares = declaresWithoutLethal(attacker, profiles, gift);
        const committedFavorable = blockDecision.reason === "favorable_battle_preserves_clock"
          && declares;
        if (declares && (outcome !== "attacker_destroyed" || committedFavorable)) {
          remaining = remaining.filter((row) => row.uid !== blocker.uid);
        }
        continue;
      }
      contributors.push(attacker.uid);
      landed += attacker.symbol_count;
      if (life - landed <= 0) break;
    }
    return [landed, contributors];
  }

  /** アタックを宣言する順(6C-2B続き、Python `_attack_order` と同一)。
   *  止められうるときだけ「削り切れる体 → 稼げる体 → 残り」に並べ替える。 */
  function attackOrder(attackerBoard, defenderBoard, profiles, gift, planDamage = null,
    preview = null) {
    const units = attackerBoard.units();
    if (!gift.can_stop_step) return units.map((row) => row.uid);
    const life = defenderBoard.life();
    const blockers = defenderBoard.units().filter((row) => !row.exhausted);
    // ⚠️ **ここだけは削り切りを「1体で」読む**(Python同一)。並べ替えるのは
    // `can_stop_step`のとき＝**1体目で打ち切られうる**ときだけなので、
    // `lethalStepPlan`の合計を当てにするのは矛盾する。宣言するかどうかは合計で、
    // 並べる価値は単体で読む。
    const rank = (row) => {
      // 並べる価値も**宣言したら退くぶんを引いてから**読む(Python同一)。
      const [seenBlockers, seenLife] = previewed(blockers, life, preview, row.uid);
      const blocker = chooseBlocker(row, seenBlockers, seenLife, profiles, planDamage);
      if (!blocker && seenLife > 0 && seenLife <= row.symbol_count) return 0;
      return rowProfile(profiles, row).attack_gain ? 1 : 2;
    };
    return [...units]
      .sort((left, right) => rank(left) - rank(right) || left.uid - right.uid)
      .map((row) => row.uid);
  }

  /** あと何回の相手のターンで自分が負けるか(②)。Python `defeat_clock` と同一。
   *  読むのは相手の場に立っている体のシンボル数だけ(手札も伏せたバーストも
   *  見ない)。疲労は数えない——相手のリフレッシュステップで回復してから殴って
   *  くる。
   *  ⭐ 1ターンぶんは**合計**で数える(アタックステップは複数体が順に殴れる)。
   *  `max`で書いていたため実測34回中15回で期限が食い違い、最大2倍長く見積もって
   *  いた。自分側の削り切り`lethalStepPlan`は最初からステップ合計である。
   *  ⭐ 数えるのは**実際に宣言される体**だけ(`profiles`があるとき)。合計は
   *  上振れで、相手も「何がなんでもアタックしない」方針なので全部は飛んでこない。
   *  ⚠️ それでもまだ楽観側に外れる——相手の盤面がこれから伸びるぶんを見ていない。 */
  function defeatClock(ownLife, defenderUnits, profiles = null,
    ownBlockers = null, planDamage = null, preview = null) {
    const rows = [...(defenderUnits || [])];
    if (!rows.length) return null;
    // ブロッカーを渡されないときは**全部通る**前提(上振れ＝期限は短く出る)。
    // 渡されたら削り切りと同じ`stepDamageThrough`で通る打点を測る——合計だけで
    // 数えると期限が短く出すぎ、エンジンが常に刻む側へ倒れて自分の勝ち筋を
    // 組まなくなる(実測でトリスメギストスの顕現が30seedで0回になった)。
    const landed = ownBlockers === null
      ? rows.reduce((sum, row) => sum + (row.symbol_count || 0), 0)
      : stepDamageThrough(rows, ownBlockers, ownLife, profiles, null, planDamage,
        preview)[0];
    return turnsToFinish(ownLife, landed);
  }

  /** 自分のほうが先に削り切れるか(②の比較)。Python `_wins_the_race` と同一。
   *  `turnsToLose`がnullなら相手に削り切る手段が無い。**同数なら勝ち**——自分の
   *  ターンが先に来る側で数えているので、同じ回数なら先に削り切るのはこちら。
   *  ここを負け側へ倒すと拮抗した盤面で常に「間に合わない」と判定して刻み続ける。 */
  function winsTheRace(turnsToWin, turnsToLose) {
    if (turnsToWin === null) return false;
    return turnsToLose === null || turnsToWin <= turnsToLose;
  }

  function attackReason(attacker, blockers, defenderLife, profiles, gift,
    stepLethal = null, planDamage = 0, ownDefeatClock = null,
    ownDefeatClockIfAttacking = null, blockerPlanDamage = null,
    laterAttackers = null) {
    const blockDecision = chooseBlockerDecision(
      attacker, blockers, defenderLife, profiles, blockerPlanDamage, laterAttackers);
    const blocker = blockDecision.blocker;
    const profile = rowProfile(profiles, attacker);
    if (blocker && battleOutcome(attacker.bp, blocker.bp) === "attacker_destroyed"
        && !(blockDecision.reason === "favorable_battle_preserves_clock"
             && profile.attack_gain)) {
      return [null, blockDecision.reason === "favorable_battle_preserves_clock"
        ? "favorable_blocker_would_destroy_attacker"
        : "blocker_would_destroy_attacker"];
    }
    // 理由の**優先順は変えない**(`attack_gain`が先。Python同一)。
    // 削り切りは`lethalStepPlan`の集合で読む。**渡されなければ従来どおり1体で読む**
    // ——単体で削り切れる体は必ずその集合に入るので、単体判定は退化形(Python同一)。
    const lethal = stepLethal === null
      ? (!blocker && defenderLife > 0 && defenderLife <= attacker.symbol_count)
      : stepLethal.has(attacker.uid);
    // ⭐ **殴った体はブロックに回れない**(Python同一)。この体を送ると期限が縮む
    // なら、それは**守りの部品**である。⚠️ 止めるのは「残せば間に合うが、送ると
    // 間に合わなくなる」ときだけ——どのみち間に合わないなら抱えている意味が
    // ないし(A'へ倒す場面)、送っても間に合うなら抱える理由がない。
    if (planDamage && !lethal
        && ownDefeatClockIfAttacking !== null && ownDefeatClock !== null
        && ownDefeatClockIfAttacking < ownDefeatClock
        && winsTheRace(turnsToFinish(defenderLife, planDamage), ownDefeatClock)
        && !winsTheRace(
          turnsToFinish(defenderLife - attacker.symbol_count, planDamage),
          ownDefeatClockIfAttacking)) {
      return [null, "blocker_is_needed_at_home"];
    }
    if (profile.attack_gain) {
      // 削り切るなら代償は関係ない(ターンが返らない)。
      if (!lethal && gift && gift.field_flash.length) {
        return [null, "window_would_free_their_field_flash"];
      }
      if (!lethal && gift && gift.soul_kourin) {
        return [null, "window_would_let_them_kourin_onto_soul"];
      }
      return ["attack_effect_gains_resources", null];
    }
    if (lethal) return ["attack_empties_life", null];
    // ⓪ **残り距離を縮める投資**(Python同一)。序盤の1点はここでだけ正当化される
    // ——ライフ5に打点2なら3回、1点入れて4にすれば2回。**減らないなら殴らない**
    // ので「何がなんでもアタックしない」の骨格は残る。
    // ⚠️ **この理由は「分母を担えない小さな体」だけに与える**（Python同一）。
    // 殴る体の打点が分母と同じなら`ceil`の判定が恒真になり、「無ブロックなら常に
    // 殴る」へ退化する（実測でヘルメスミラーが7.3→3.6ラウンドまで縮んだ）。
    // ② **間に合わないなら、分母を担う体も刻む側へ回る**(Python同一)。
    // 役割分担の縛りは「相手の時計が自分の時計より長いあいだだけ」正しい。
    // ⚠️ 縛りを外すと`ceil`の判定は恒真になるが、**ここでは意図した挙動**
    // ——「間に合わないなら無ブロックの体は全部殴る」がA'そのものだからである。
    const planTurns = planDamage ? turnsToFinish(defenderLife, planDamage) : null;
    const racing = ownDefeatClock !== null
      && (planTurns === null || ownDefeatClock <= planTurns);
    const carriesThePlan = Boolean(planDamage) && attacker.symbol_count >= planDamage;
    if (planDamage && !blocker && (racing || !carriesThePlan)) {
      const before = turnsToFinish(defenderLife, planDamage);
      const after = turnsToFinish(defenderLife - attacker.symbol_count, planDamage);
      if (before !== null && (after === null || after < before)) {
        if (gift && gift.field_flash.length) {
          return [null, "window_would_free_their_field_flash"];
        }
        if (gift && gift.soul_kourin) {
          return [null, "window_would_let_them_kourin_onto_soul"];
        }
        if (racing && carriesThePlan) return ["attack_races_their_clock", null];
        return ["attack_shortens_the_plan", null];
      }
    }
    return [null, "no_attack_time_gain_and_life_survives"];
  }

  /** 戦闘の窓の節を解決して、撃ったぶんだけ棋譜へ出す。
   *  Python `_emit_trigger` と同一。`battleRole`は`battle_end`だけで使う(6C)。 */
  function emitTrigger(emit, board, owner, uid, unit, window, opponent, battleRole) {
    const resolved = board.resolve_trigger(uid, window, opponent, battleRole);
    if (!resolved.length) return;
    emit(`${window}_effects_resolved`, owner, { unit, effects: resolved });
  }

  // 戦闘の層で実際に起きたと分かるバーストの条件(6C-2)。**正典は`stage5_sim.js`**
  // (Python側で`stage6_sim`が`stage4_sim`からimportしているのと同じ向き)。6C-3の
  // 「残すか」の判断が同じ表を引くので、片方だけ足すと規則があるのに一度も効かない。
  const {
    BURST_LIFE_LOSS, BURST_OPPONENT_ATTACK, BURST_OWN_DESTROYED,
    BURST_OWN_LEFT_FIELD,
    // ⓪の物差し。メインステップの目的関数も同じ数え方で打点を測るので、
    // 定義は下の層に1つだけ置く(2026-08-23、①)。
    turnsToFinish,
    winningBlockValue,
  } = Stage5PortableSimulation;

  /** その持ち主のバーストを実イベントで開く。Python `_open_burst` と同一。
   *  opponentBoardは6C-2C——バーストが開くのは戦闘の途中か相手のターンで、そのとき
   *  相手の盤面は目の前にあるので、破壊・バウンス・コア除去の節を撃てる。 */
  function openBurst(emit, owner, board, category, opponentBoard = null) {
    const cardNo = board.trigger_burst(category, opponentBoard);
    if (cardNo) {
      emit("burst_activated", owner, { card_no: cardNo, condition: category });
    }
    return cardNo;
  }

  /** ライフが実際に減ったので開く。ライフが0になったバトルでは開かない
   *  (その時点で試合が終わる)。Python `_burst_after_life_loss` と同一。 */
  function burstAfterLifeLoss(emit, owner, board, opponentBoard = null) {
    if (board.life() <= 0) return null;
    return openBurst(emit, owner, board, BURST_LIFE_LOSS, opponentBoard);
  }

  /** 2人しかいないので、相手のplayer_id。Python `_other_player` と同一。 */
  function otherPlayer(owner) {
    return PLAYER_IDS.find((playerId) => playerId !== owner);
  }

  /** 2人しかいないので、持ち主でないほうの盤面。Python `_other_board` と同一。 */
  function otherBoard(boards, owner) {
    const key = Object.keys(boards).find((player) => player !== owner);
    return key === undefined ? null : boards[key];
  }

  /** 相手の盤面から、方針が読んでよい**公開情報**だけを要約する(6C-3)。
   *  いま要るのは1つ——戦闘に出られる体が何体居るか。疲労は数えない(相手の
   *  リフレッシュステップで回復してから殴ってくる)。手札・伏せたバーストの
   *  中身・デッキの残りは渡さない。Python `_opponent_public_summary` と同一。 */
  function opponentPublicSummary(board) {
    // `life`は2026-08-23(①)。メインステップが「削り切るまであと何回か」を測る
    // のに要る。ライフエリアのコアは公開情報なので非公開情報には触れていない。
    return { attackers: board.units().length, life: board.life() };
  }

  /** 相手のせいで自分のカードが場を離れたので開く。
   *  **「消滅/破壊後」はトラッシュに置かれたときだけ**(SD52-012・CB24-X06の裁定)、
   *  「離脱後」は行き先を問わない。Python `_burst_after_field_leave` と同一。 */
  function burstAfterFieldLeave(emit, owner, board, reachedTrash, opponentBoard = null) {
    if (reachedTrash === "trash") {
      const opened = openBurst(emit, owner, board, BURST_OWN_DESTROYED, opponentBoard);
      if (opened) return opened;
    }
    return openBurst(emit, owner, board, BURST_OWN_LEFT_FIELD, opponentBoard);
  }

  /** 1回のバトルの終わり(6C)。Python `_end_battle` と同一。
   *  『バトル終了時』の節をここで解き、そのあとバトル限定のBP修正を捨てる
   *  ——アタックステップの出口ではない(1ステップに複数のバトルがある)。 */
  function endBattle(emit, actor, defenderId, boards, attackerUid, blockerUid) {
    const attackerBoard = boards[actor];
    const defenderBoard = boards[defenderId];
    const attacker = attackerBoard.units().find((row) => row.uid === attackerUid);
    if (attacker) {
      emitTrigger(emit, attackerBoard, actor, attackerUid, attacker,
        "battle_end", defenderBoard, "attack");
    }
    if (blockerUid !== null && blockerUid !== undefined) {
      const blocker = defenderBoard.units().find((row) => row.uid === blockerUid);
      if (blocker) {
        emitTrigger(emit, defenderBoard, defenderId, blockerUid, blocker,
          "battle_end", attackerBoard, "block");
      }
    }
    attackerBoard.end_battle();
    defenderBoard.end_battle();
  }

  // 6C-2B: このステップで**まだアタックできる**、現在のアタッカー以外のユニット。
  // Python `_remaining_attackers` と同一。
  function remainingAttackers(order, index, attackerBoard) {
    const units = new Map(attackerBoard.units().map((row) => [row.uid, row]));
    return order.slice(index + 1).filter(
      (uid) => units.has(uid) && !units.get(uid).exhausted);
  }

  function remainingAttackerRows(order, index, attackerBoard) {
    const units = new Map(attackerBoard.units().map((row) => [row.uid, row]));
    return remainingAttackers(order, index, attackerBoard).map((uid) => units.get(uid));
  }

  // その札がこの窓で得になるか。Python `_flash_option_helps` と同一。
  // 『ただちにアタックステップを終了する』はこのバトルも残りも止める(Q29816)、
  // 『ただちにバトルを終了する』はこのバトルだけ(Q10950)、
  // 『このバトルが終了したとき』は残りのアタックだけ(Q17596)。
  // 『ライフ保護』は**実際に減る量が減るときだけ**——「Nしか減らない」は、いま
  // Nより多く減るときでなければ何も変わらない。
  function flashOptionHelps(option, threat, moreAttackers) {
    if (option.kind === "flash_life_protection") {
      if (!threat.life) return false;
      if (option.attacker_cost_min !== null && option.attacker_cost_min !== undefined
          && threat.attacker_cost < option.attacker_cost_min) return false;
      return option.protection === "none" || threat.life > option.amount;
    }
    const threatened = Boolean(threat.life || threat.unit);
    if (option.flash_when === "after_battle") return moreAttackers;
    if (option.kind === "flash_end_battle") return threatened;
    return threatened || moreAttackers;
  }

  // この窓で開く札を1枚選ぶ。Python `_flash_defense_choice` と同一。
  function flashDefenseChoice(options, threat, moreAttackers) {
    const playable = options.filter(
      (option) => flashOptionHelps(option, threat, moreAttackers));
    if (!playable.length) return null;
    return playable.slice().sort((left, right) =>
      left.cost - right.cost
      || (left.card_no < right.card_no ? -1 : left.card_no > right.card_no ? 1 : 0)
      || left.hand_index - right.hand_index)[0];
  }

  // その札がこのバトルの解決そのものを止めるか／解決してからステップを終わらせるか。
  // Python `_flash_stops_the_battle` / `_flash_ends_the_step_after` と同一。
  const flashStopsTheBattle = (flash) => Boolean(flash) && flash.flash_when === "immediate";
  const flashEndsTheStepAfter = (flash) => Boolean(flash)
    && flash.flash_when === "after_battle";

  // 公式手順4のフラッシュタイミング(6C-2B)。開くのは守り手だけで、窓は1回の
  // バトルにつき1つ。Python `_flash_defense` と同一。
  function flashDefense(emit, defenderId, defenderBoard, threat, moreAttackers) {
    // **盤面のフラッシュ効果は相手のターンでも撃つ**(6C-2B続き、Python同一)。
    // 印字が『Lv1・Lv2：フラッシュ』でステップを指定していなければ、相手の
    // アタックステップのフラッシュタイミングでも発揮する。`resolve_field_flash`はそのユニットの発揮元を
    // まとめて撃つので、同じuidを2度呼ばない。
    for (const uid of [...new Set(
      defenderBoard.field_flash_options().map((source) => source.uid))]) {
      if (defenderBoard.resolve_field_flash(uid)) {
        emit("field_flash_resolved", defenderId, { uid });
      }
    }
    const options = defenderBoard.flash_options();
    if (!options.length) return null;
    const choice = flashDefenseChoice(options, threat, moreAttackers);
    if (!choice) return null;
    const played = defenderBoard.play_flash(choice.card_no, choice.effect_id);
    if (!played) return null;
    // 『ライフ保護』はここで効かせる。盤面の状態なので、この後のバトルの解決
    // (`damage_life`)が読む。
    if (played.kind === "flash_life_protection") defenderBoard.protect_life(played);
    emit("flash_defense_played", defenderId, {
      card_no: played.card_no, kind: played.kind, flash_when: played.flash_when,
      cost: choice.cost,
      // その札を開かせたのがどちらの得か(Python同一)。
      reason: (played.flash_when === "after_battle" || !(threat.life || threat.unit))
        ? "attackers_remain" : "battle_threatens_defender",
    });
    return played;
  }

  // 『ただちに』型でバトルを解決の前に閉じる。アタックステップまで終わるなら
  // true。Python `_flash_stop_battle` と同一。
  //
  // 裁定の間に対立は無く、3つの印字は残りの手順の**どこから先を飛ばすか**が
  // 違うだけ(飛ばす範囲は入れ子)。この窓のあとは
  // ⑤フラッシュの応酬 → ⑥BP比べ → ⑦ライフ減少/破壊 → ⑧バトル終了時 → ⑨ステップ終了。
  // 『ただちにバトルを終了する』は⑤から飛ばして⑧は行う(⑨は来ない)、
  // 『ただちにアタックステップを終了する』は⑤から⑧も含めて飛ばす。
  function flashStopBattle(emit, actor, defenderId, boards, attacker, blocker, flash) {
    const endsStep = flash.kind === "flash_end_attack_step";
    emit("battle_resolved", actor, { attacker, blocker,
      outcome: endsStep ? "flash_ended_step" : "flash_ended_battle" });
    if (endsStep) {
      // バトル終了時の節は撃たない(Q29816)。バトル限定のBP修正だけ捨てる。
      boards[actor].end_battle();
      boards[defenderId].end_battle();
    } else {
      endBattle(emit, actor, defenderId, boards, attacker.uid,
        blocker ? blocker.uid : null);
    }
    return endsStep;
  }

  function resolveAttackStep(actor, defenderId, boards, emit, profiles, plan) {
    // ⓪ 分母はステップの入口で1度だけ測る（このステップのあいだ手札は動かない）。
    const attackerBoard = boards[actor];
    const defenderBoard = boards[defenderId];
    // **〔ターンに1回〕の数え直しはここではない**(ユーザー裁定、Python同一)。
    // 切り替わるのはエンドステップで、両者ぶんをターン境界がまとめて叩く。
    // 窓を渡す代償は**ステップの入口で1度だけ**測る(Python同一)。
    const gift = windowGift(defenderBoard);
    // ② 「いつまでに負けそうか」。ステップの入口で1度だけ測る(Python同一)。
    // `profiles`を渡すと相手が実際に宣言する体だけを数える。`gift`は**自分の
    // 盤面が相手へ渡す窓**なので相手の判断には使えない——渡さずに、相手は窓の
    // 代償を無視して殴ってくる側へ倒す(期限を短く)。Python同一。
    const ownLife = attackerBoard.life();
    const planDamage = plan
      ? reachableDamage(plan, attackerBoard.units(), handBraveSymbols(attackerBoard, plan))
      : 0;
    // ブロック側が見てよいのは公開盤面の到達済み段だけ。手札のブレイヴを含む
    // `planDamage`を渡すと、守り手が非公開情報を読むことになる(Python同一)。
    const publicPlanDamage = attackerBoard.units().reduce(
      (best, row) => Math.max(best, row.symbol_count || 0), 0);
    // ⭐ 宣言したら誰が退くかを、ステップ入口で体ごとに1回だけ解いて戻す。
    // 相手にも同じ先読みを与える(ユーザー判断)。Python同一。
    const ownPreview = previewAttackWindows(attackerBoard, defenderBoard);
    const theirPreview = previewAttackWindows(defenderBoard, attackerBoard);
    const order = attackOrder(
      attackerBoard, defenderBoard, profiles, gift, publicPlanDamage, ownPreview);
    for (let index = 0; index < order.length; index += 1) {
      const uid = order[index];
      let attacker = attackerBoard.units().find((row) => row.uid === uid);
      if (!attacker || attacker.exhausted) continue;
      const blockers = defenderBoard.units().filter((row) => !row.exhausted);
      // 削り切りは**残りの宣言順**で測り直す(Python同一)。1体目が止められた／
      // 破壊された後も「ここから先で削り切れるか」で読み、崩れた計画に注ぎ足さない。
      const stepLethal = lethalStepPlan(
        order.slice(index), attackerBoard, defenderBoard, profiles, gift,
        publicPlanDamage, ownPreview);
      // 公開盤面と確定した順だけを使い、壁を後続へどう配るかも読む(Python同一)。
      let laterAttackers = remainingAttackerRows(order, index, attackerBoard);
      // 疲労していない自分の体＝次の相手のターンにブロックへ回れる面々。
      // 既に宣言した体はこの時点で疲労しているので自然に外れる。Python同一。
      const home = attackerBoard.units().filter((row) => !row.exhausted);
      // 相手の時計も相手の先読み込みで測る。Python同一。
      const ownClock = defeatClock(ownLife, blockers, profiles, home, null,
        theirPreview);
      const ownClockIfAttacking = defeatClock(
        ownLife, blockers, profiles, home.filter((row) => row.uid !== uid), null,
        theirPreview);
      // 宣言するかの判断も、その体が退かせるぶんを引いた盤面で読む。
      const [seenBlockers, seenLife] = previewed(
        blockers, defenderBoard.life(), ownPreview, uid);
      const [reason, declined] = attackReason(
        attacker, seenBlockers, seenLife, profiles, gift, stepLethal,
        planDamage, ownClock, ownClockIfAttacking, publicPlanDamage,
        laterAttackers);
      if (!reason) {
        emit("attack_declined", actor, { attacker,
          reason: declined,
          attack_reasons: rowProfile(profiles, attacker).attack_reasons });
        continue;
      }
      attackerBoard.exhaust(uid);
      emit("attack_declared", actor, { attacker, reason,
        attack_reasons: rowProfile(profiles, attacker).attack_reasons });
      // 公式手順1(アタック宣言)の直後、手順2(ブロック)より前(page08)。
      emitTrigger(emit, attackerBoard, actor, uid, attacker, "attack", defenderBoard);
      // 「相手のスピリット/アルティメットのアタック後」のバースト(Python同一)。
      openBurst(emit, defenderId, defenderBoard, BURST_OPPONENT_ATTACK, attackerBoard);
      // ⭐ **アタッカー自身の戦闘値も取り直す**(Python同一、2026-08-31)。アタック時
      // 効果は自分の打点やBPも動かす——『このスピリットのアタック時』のシンボル
      // 追加が代表で、宣言前の行を使い回すと足したシンボルが打点に乗らない。
      // ⚠️ **行ごと差し替えない**。宣言の直前に`exhaust(uid)`を呼んでいるので、
      // 取り直した行は`exhausted=true`になり下流まで変わる(Python側に実測あり)。
      const attackerAfterWindow = attackerBoard.units().find((row) => row.uid === uid);
      if (attackerAfterWindow) {
        attacker = { ...attacker, symbol_count: attackerAfterWindow.symbol_count,
          bp: attackerAfterWindow.bp };
      }
      // ブロッカー候補は**アタック時効果とアタック後バーストの解決後**に
      // 取り直す(Python同一)。宣言前の一覧を使うと、そこで疲労／重疲労した体や
      // 場を離れた体が、そのままブロックできてしまう。
      const currentBlockers = defenderBoard.units().filter((row) => !row.exhausted);
      // アタック時効果／バースト後の現在盤面から後続も取り直す(Python同一)。
      laterAttackers = remainingAttackerRows(order, index, attackerBoard);
      const blockDecision = chooseBlockerDecision(
        attacker, currentBlockers, defenderBoard.life(), profiles, publicPlanDamage,
        laterAttackers);
      const blocker = blockDecision.blocker;
      if (!blocker) {
        // 公式手順4のフラッシュタイミング(6C-2B)。ブロックしないと決めた後、
        // ライフ減少より前。脅威は**通ればライフが減ること**そのもので、
        // 『ライフ保護』を選ぶには**量**が要る(Python同一)。
        const flash = flashDefense(emit, defenderId, defenderBoard,
          { life: Math.min(attacker.symbol_count, defenderBoard.life()),
            unit: false, attacker_cost: attacker.cost },
          remainingAttackers(order, index, attackerBoard).length > 0);
        if (flashStopsTheBattle(flash)) {
          if (flashStopBattle(emit, actor, defenderId, boards, attacker, null, flash)) {
            return false;
          }
          continue;
        }
        const before = defenderBoard.life();
        // アタックによる減少なので**アタッカーのコスト**を渡す。
        const taken = defenderBoard.damage_life(
          attacker.symbol_count, "reserve", { cost: attacker.cost });
        if (taken) {
          emit("life_damaged", defenderId, { attacker, amount: taken,
            life_before: before, life_after: defenderBoard.life(), reason: "unblocked" });
          burstAfterLifeLoss(emit, defenderId, defenderBoard, attackerBoard);
        }
        emit("battle_resolved", actor, { attacker, blocker: null,
          outcome: taken ? "life_damage" : "no_life_left" });
        if (defenderBoard.life() <= 0) {
          // 決着したバトルの終わりは作らない(Python同一)。
          emit("match_won", actor, { loser: defenderId, reason: "life_reached_zero" });
          return true;
        }
        endBattle(emit, actor, defenderId, boards, uid, null);
        // 『このバトルが終了したとき、アタックステップを終了する』はバトル終了時の
        // 効果をすべて解決した**後**に効く(Q17596、Python同一)。『ライフ保護』は
        // ステップを止めないので、ここでは何もしない。
        if (flashEndsTheStepAfter(flash)) return false;
        continue;
      }
      defenderBoard.exhaust(blocker.uid);
      const blockerProfile = rowProfile(profiles, blocker);
      emit("block_declared", defenderId, { attacker, blocker,
        reason: blockDecision.reason,
        block_reasons: blockerProfile.block_reasons });
      // 手順3(ブロック宣言)の直後。BP比較より前なので、ここで増えたコアや
      // BPは同じバトルの結果に効く。
      // 『ブロックされたとき』(アタック側)は『ブロック時』と同じタイミングなので、
      // ターンプレイヤー＝アタック側から解決する(6C、Python同一)。
      emitTrigger(emit, attackerBoard, actor, uid, attacker, "blocked", defenderBoard);
      emitTrigger(emit, defenderBoard, defenderId, blocker.uid, blocker, "block",
        attackerBoard);
      const freshAttacker = attackerBoard.units().find((row) => row.uid === uid) || attacker;
      const freshBlocker = defenderBoard.units().find(
        (row) => row.uid === blocker.uid) || blocker;
      // 公式手順4のフラッシュタイミング(6C-2B)。ブロック時効果のあと、BP比較の
      // 前。ブロックしたバトルは**ライフを1つも減らさない**ので、脅威はブロッカーが
      // 破壊されることだけ(`life`は0)——『ライフ保護』はここでは選ばれない。
      const blockedFlash = flashDefense(emit, defenderId, defenderBoard,
        { life: 0, attacker_cost: freshAttacker.cost,
          unit: ["blocker_destroyed", "both_destroyed"].includes(
            battleOutcome(freshAttacker.bp, freshBlocker.bp)) },
        remainingAttackers(order, index, attackerBoard).length > 0);
      if (flashStopsTheBattle(blockedFlash)) {
        if (flashStopBattle(emit, actor, defenderId, boards, freshAttacker,
          freshBlocker, blockedFlash)) return false;
        continue;
      }
      const outcome = battleOutcome(freshAttacker.bp, freshBlocker.bp);
      const destroyed = outcome === "attacker_destroyed" ? [[actor, freshAttacker]]
        : outcome === "blocker_destroyed" ? [[defenderId, freshBlocker]]
          : [[actor, freshAttacker], [defenderId, freshBlocker]];
      for (const [owner, row] of destroyed) {
        const landed = boards[owner].destroy(row.uid, "battle");
        emit("destroyed_by_battle", owner, { unit: row, outcome });
        // 破壊は相手のアタック/ブロックによるものなので「相手による」に当たる。
        burstAfterFieldLeave(emit, owner, boards[owner], landed,
          otherBoard(boards, owner));
      }
      emit("battle_resolved", actor,
        { attacker: freshAttacker, blocker: freshBlocker, outcome });
      endBattle(emit, actor, defenderId, boards, uid, blocker.uid);
      // 『このバトルが終了したとき、アタックステップを終了する』(Q17596)。
      if (flashEndsTheStepAfter(blockedFlash)) return false;
    }
    return false;
  }

  function jointState(activePlayer, latest) {
    return {
      active_player: activePlayer,
      players: Object.fromEntries(PLAYER_IDS.map((playerId) =>
        [playerId, structuredClone(latest[playerId])])),
    };
  }

  async function run(contract, selfPacket, opponentPacket, options = {}) {
    const mode = options.mode || TRACE_MODE;
    if (![TRACE_MODE, COMBAT_MODE].includes(mode)) {
      throw new Error(`unsupported Stage6 trace mode: ${mode}`);
    }
    // モードと直交する絞り込み。既定はfalseで、A-1・6B-1の棋譜は変わらない。
    if (options.detail !== undefined && options.detail !== null
        && typeof options.detail !== "boolean") {
      throw new Error("Stage6 trace detail must be a boolean");
    }
    const detail = options.detail === true;
    const combat = mode === COMBAT_MODE;
    await Stage6MatchContract.validate(contract);
    const packets = { self: selfPacket, opponent: opponentPacket };
    const contractPlayers = Object.fromEntries(
      contract.players.map((player) => [player.player_id, player]));
    const deckCardNos = new Set(contract.players.flatMap(
      (player) => player.deck.cards.map((entry) => entry.card_no)));
    const profiles = combat ? Object.fromEntries(
      Object.entries(options.combat_profiles || {})
        .filter(([cardNo]) => deckCardNos.has(cardNo))) : {};
    const runners = {};
    for (const playerId of PLAYER_IDS) {
      runners[playerId] = await startPlayer(
        packets[playerId], contractPlayers[playerId], contract, playerId, combat,
        options.choice_debug?.[playerId] || null);
    }
    // ⓪ 各プレイヤーの**勝利プラン**。対戦のあいだ変わらないので1度だけ組む。
    // `combat_profiles`と同じく公開情報の派生データ。Python `plans` と同一。
    const plans = {};
    if (combat) {
      for (const playerId of PLAYER_IDS) {
        plans[playerId] = buildVictoryPlan(packets[playerId]);
      }
    }
    const secondPlayer = PLAYER_IDS.find((playerId) => playerId !== contract.first_player);
    const combatEvents = [];
    let currentRound = 0;
    let currentActor = null;
    const emit = (type, owner, details) => {
      const phase = type === "opponent_end_effect_resolved" ? "end" : "attack";
      // board APIが記録した詳細行を、持ち主の自ターンではなく実際に起きた
      // 相手ターン位置へ移す。魂状態の遷移もこの経路で表示する(Python同一)。
      const ownerRunner = runners[owner];
      for (const source of ownerRunner.board.events()) {
        if (ownerRunner.stage6_source_seqs.has(source.seq)
            || ownerRunner.stage6_external_seqs.has(source.seq)) continue;
        ownerRunner.stage6_external_seqs.add(source.seq);
        if (!detail || !MAIN_EVENT_TYPES.has(source.type)) continue;
        const state = Object.fromEntries(PLAYER_IDS.map((playerId) =>
          [playerId, canonicalState(runners[playerId].board.snapshot())]));
        state[owner] = canonicalState(source.state);
        combatEvents.push({
          round: currentRound, actor: owner, phase, type: source.type,
          details: { ...publicMainEventDetails(source.type, source.details),
            turn_player: currentActor },
          turn_of: currentActor, state,
        });
      }
      combatEvents.push({
        round: currentRound,
        actor: owner,
        phase,
        type,
        details: { ...structuredClone(details), turn_player: currentActor },
        turn_of: currentActor,
        state: Object.fromEntries(PLAYER_IDS.map((playerId) =>
          [playerId, canonicalState(runners[playerId].board.snapshot())])),
      });
    };
    if (combat) {
      for (const playerId of PLAYER_IDS) advanceTurn(runners[playerId]);
    }
    let winner = null;
    const playedTurns = [];
    for (let round = 1; round <= contract.max_rounds && winner === null; round += 1) {
      for (const actor of [contract.first_player, secondPlayer]) {
        currentRound = round;
        currentActor = actor;
        const defender = otherPlayer(actor);
        const defenderBoard = combat ? runners[defender].board : null;
        const defenderLifeBefore = defenderBoard ? defenderBoard.life() : null;
        // **スタートステップは到達している**ので、このターンは棋譜へ記録する
        // (`turn_order`に無いターンの`match_won`はspliceが拾えない)。Python同一。
        playedTurns.push({ round, player_id: actor });
        // **デッキ切れ敗北**(公式の勝利条件②、page02)。原文は「対戦相手の
        // スタートステップで、相手のデッキが0枚だった」——**削り切った瞬間では
        // なく、その持ち主のスタートステップで見る遅延判定**。ここはそのターンを
        // 進める直前＝スタートステップの位置なので、0枚なら**ドローステップへ
        // 進まずにそこで負ける**。Python側と同一。
        if (combat && runners[actor].board
            && runners[actor].board.deck_count() <= 0) {
          winner = otherPlayer(actor);
          emit("match_won", winner, { loser: actor, reason: "deck_ran_out" });
          break;
        }
        // 6C-3: メインステップの方針が読む相手盤面の要約を、**そのターンが
        // 始まる前に**渡す。渡さないあいだStage4は相手を知らないので、
        // `burst_policy`は何も判断しない。Python側と同一。
        if (combat) {
          const board = runners[actor].board;
          const other = otherBoard(Object.fromEntries(PLAYER_IDS.map((playerId) =>
            [playerId, runners[playerId].board])), actor);
          if (board && other) board.observe_opponent(opponentPublicSummary(other), other);
        }
        for (;;) {
          const step = advanceTurn(runners[actor]);
          if (!step || step.step === "turn_end") break;
          if (step.step === "attack") {
            const boards = Object.fromEntries(PLAYER_IDS.map((playerId) =>
              [playerId, runners[playerId].board]));
            if (resolveAttackStep(actor, defender, boards, emit, profiles, plans[actor])) {
              winner = actor;
              break;
            }
          }
        }
        if (winner === null && defenderBoard) {
          const lifeReduced = defenderBoard.life() < defenderLifeBefore;
          for (const resolved of defenderBoard.opponent_end_step(
            lifeReduced, "actual_opponent")) {
            emit("opponent_end_effect_resolved", defender, resolved);
          }
        }
        // ターンの終わりで「このターンの間」のBP修正を両側から捨てる(6B-3)。
        // 相手のユニットへ掛けた修正も**掛けた側のターン**で切れるので、
        // 各シミュレータの自分のturn_endではなくここで揃えて捨てる。
        // A-1(戦闘なし)では盤面の口を開いていないので何もしない。
        //
        // 〔ターンに1回〕の数え直しも同じ位置(ユーザー裁定)。**手番でないほうにも
        // 要る**——自分のターンの分はそのシミュレータが自分のエンドステップで
        // 数え直すが、相手のターンのエンドステップは向こうのループの中で届かない。
        for (const playerId of PLAYER_IDS) {
          runners[playerId].board?.end_turn_modifiers();
          runners[playerId].board?.end_step_reset();
        }
        if (winner !== null) break;
      }
    }
    const players = Object.fromEntries(PLAYER_IDS.map((playerId) =>
      [playerId, finishPlayer(runners[playerId], winner !== null)]));
    const latest = Object.fromEntries(PLAYER_IDS.map((playerId) =>
      [playerId, canonicalState(players[playerId]._events[0].state)]));
    const events = [{
      seq: 1,
      round: 0,
      actor: null,
      phase: "opening",
      source_seq: null,
      type: "match_opening",
      details: {
        first_player: contract.first_player,
        opening_hands: Object.fromEntries(PLAYER_IDS.map((playerId) =>
          [playerId, [...players[playerId].opening_hand]])),
      },
      state: jointState(null, latest),
    }];
    const turnOrder = [...playedTurns];
    const spliceCombat = (round, actor) => {
      for (const combatEvent of combatEvents) {
        if (combatEvent.round !== round || combatEvent.turn_of !== actor) continue;
        for (const playerId of PLAYER_IDS) latest[playerId] = combatEvent.state[playerId];
        events.push({
          seq: events.length + 1,
          round,
          actor: combatEvent.actor,
          phase: combatEvent.phase,
          source_seq: null,
          type: combatEvent.type,
          details: combatEvent.details,
          state: jointState(actor, latest),
        });
      }
    };
    for (const turn of turnOrder) {
      const { round, player_id: actor } = turn;
      const sourceEvents = players[actor]._events.filter((event) =>
        runners[actor].stage6_source_seqs.has(event.seq)
          && event.turn === round && (TURN_EVENT_TYPES.has(event.type)
          || (combat && event.type in STEP_EVENT_PHASES)
          || (detail && MAIN_EVENT_TYPES.has(event.type))));
      let spliced = false;
      for (const source of sourceEvents) {
        if (source.type === "step_end") {
          spliceCombat(round, actor);
          spliced = true;
        }
        latest[actor] = canonicalState(source.state);
        const main = MAIN_EVENT_TYPES.has(source.type);
        const phase = main ? "main" : (STEP_EVENT_PHASES[source.type]
          || (source.type === "turn_start" ? "main_start" : "main_end"));
        events.push({
          seq: events.length + 1,
          round,
          actor,
          phase,
          // 境界イベントの1/2はA-1からの固定値。詳細イベントはStage4の記録順。
          source_seq: main ? source.seq
            : source.type === "turn_start" ? 1
              : source.type === "turn_end" ? 2 : null,
          type: source.type,
          // 明示した内部作業キーだけ除外し、nullableキーを正規化する。
          details: main ? publicMainEventDetails(source.type, source.details)
            : Object.fromEntries(Object.entries(source.details || {}).filter(
              ([key]) => ["gained", "drawn", "recovered_uids"].includes(key))),
          state: jointState(actor, latest),
        });
      }
      // 決着したターンはエンドステップまで進まないので、最後に置く。
      if (!spliced) spliceCombat(round, actor);
    }
    const publicPlayers = PLAYER_IDS.map((playerId) => {
      const { _events, ...row } = players[playerId];
      return row;
    });
    const basis = {
      format: TRACE_FORMAT,
      format_version: TRACE_FORMAT_VERSION,
      mode: combat ? COMBAT_MODE : TRACE_MODE,
      runtime_version: combat ? COMBAT_RUNTIME_VERSION : RUNTIME_VERSION,
      stage4_version: Stage5PortableEngine.STAGE_VERSION,
      match_fingerprint: contract.fingerprint,
      catalog: structuredClone(contract.catalog),
      seed: contract.seed,
      max_rounds: contract.max_rounds,
      first_player: contract.first_player,
      turn_order: turnOrder,
      players: publicPlayers,
      capabilities: structuredClone(combat ? COMBAT_CAPABILITIES : CAPABILITIES),
      policy: combat ? COMBAT_POLICY : null,
      combat_profiles: combat ? structuredClone(profiles) : null,
      winner,
      events,
      // 既定では**キーごと存在しない**。詳細を載せた棋譜だけが名乗る。
      ...(detail ? { detail: DETAIL_LEVEL } : {}),
    };
    return { ...basis, fingerprint: await sha256Hex(basis) };
  }

  async function validate(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Stage6 trace must be an object");
    }
    // ``detail``は有るか無いかで詳細モードを表す(Python側と同じ理由——既定の
    // 棋譜へnullを1つ足すだけでもfingerprintが動く)。
    const detail = Object.prototype.hasOwnProperty.call(value, "detail");
    const expected = [
      "format", "format_version", "mode", "runtime_version", "stage4_version",
      "match_fingerprint", "catalog", "seed", "max_rounds", "first_player", "turn_order",
      "players", "capabilities", "policy", "combat_profiles", "winner", "events",
      "fingerprint",
      ...(detail ? ["detail"] : []),
    ].sort();
    if (stableStringify(Object.keys(value).sort()) !== stableStringify(expected)) {
      throw new Error("Stage6 trace fields are not canonical");
    }
    if (detail && value.detail !== DETAIL_LEVEL) {
      throw new Error("unsupported Stage6 trace detail level");
    }
    const combat = value.mode === COMBAT_MODE;
    if (value.format !== TRACE_FORMAT || value.format_version !== TRACE_FORMAT_VERSION
        || ![TRACE_MODE, COMBAT_MODE].includes(value.mode)
        || value.runtime_version !== (combat ? COMBAT_RUNTIME_VERSION : RUNTIME_VERSION)
        || value.stage4_version !== Stage5PortableEngine.STAGE_VERSION) {
      throw new Error("unsupported Stage6 trace");
    }
    if (stableStringify(value.capabilities)
        !== stableStringify(combat ? COMBAT_CAPABILITIES : CAPABILITIES)) {
      throw new Error("Stage6 trace capabilities are not canonical");
    }
    if (value.policy !== (combat ? COMBAT_POLICY : null)) {
      throw new Error("Stage6 trace policy does not match its mode");
    }
    if (value.combat_profiles !== null && !combat) {
      throw new Error("only the combat mode may carry combat profiles");
    }
    if (value.winner !== null) {
      if (!value.capabilities?.victory) {
        throw new Error("this Stage6 mode does not decide a winner");
      }
      if (!PLAYER_IDS.includes(value.winner)) {
        throw new Error("Stage6 winner must be self or opponent");
      }
      if (!value.events.some((event) => event.type === "match_won")) {
        throw new Error("a decided Stage6 match must record match_won");
      }
    }
    if (!Array.isArray(value.players)
        || value.players.map((player) => player?.player_id).join(",") !== PLAYER_IDS.join(",")) {
      throw new Error("Stage6 trace players must be self then opponent");
    }
    if (!Array.isArray(value.events) || !value.events.length
        || value.events[0].type !== "match_opening") {
      throw new Error("Stage6 trace must start with match_opening");
    }
    if (value.events.some((event, index) => event.seq !== index + 1)) {
      throw new Error("Stage6 trace event sequence is not canonical");
    }
    const allowed = new Set(["match_opening", ...TURN_EVENT_TYPES]);
    if (combat) {
      for (const type of [...COMBAT_EVENT_TYPES, ...Object.keys(STEP_EVENT_PHASES),
        "attack_declined"]) allowed.add(type);
    }
    // メインステップの中身を名乗れるのは、詳細を載せたと宣言した棋譜だけ。
    if (detail) for (const type of MAIN_EVENT_TYPES) allowed.add(type);
    if (value.events.some((event) =>
      FORBIDDEN_EVENT_TYPES.has(event.type) && !allowed.has(event.type))) {
      throw new Error("Stage6 trace claims combat or reaction events it does not implement");
    }
    if (value.events.some((event) => !allowed.has(event.type))) {
      throw new Error("Stage6 trace contains unknown event types");
    }
    if (detail) {
      for (const event of value.events) {
        if (!MAIN_EVENT_TYPES.has(event.type)) continue;
        if (!event.details || typeof event.details !== "object" || Array.isArray(event.details)) {
          throw new Error("Stage6 main event details must be an object");
        }
        if ((INTERNAL_DETAIL_KEYS[event.type] || []).some((key) =>
          Object.prototype.hasOwnProperty.call(event.details, key))) {
          throw new Error("Stage6 trace exposes internal detail keys");
        }
        if ((NULLABLE_DETAIL_KEYS[event.type] || []).some((key) =>
          !Object.prototype.hasOwnProperty.call(event.details, key))) {
          throw new Error("Stage6 trace omits canonical nullable detail keys");
        }
      }
    }
    const { fingerprint, ...basis } = value;
    if (await sha256Hex(basis) !== fingerprint) {
      throw new Error("Stage6 trace fingerprint does not match");
    }
    return value;
  }

  globalThis.Stage6PortableSimulation = {
    TRACE_FORMAT, TRACE_FORMAT_VERSION, TRACE_MODE, RUNTIME_VERSION,
    COMBAT_MODE, COMBAT_RUNTIME_VERSION, COMBAT_POLICY, COMBAT_CAPABILITIES,
    CAPABILITIES, DETAIL_LEVEL, MAIN_EVENT_TYPES, buildCombatProfiles, run, validate,
  };
})();
