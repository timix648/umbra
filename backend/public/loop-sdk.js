var LoopSDKBundle = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // entry-loop.js
  var entry_loop_exports = {};
  __export(entry_loop_exports, {
    loop: () => loop
  });

  // node_modules/@partylayer/adapter-loop/node_modules/@fivenorth/loop-sdk/dist/index.js
  var __create = Object.create;
  var __getProtoOf = Object.getPrototypeOf;
  var __defProp2 = Object.defineProperty;
  var __getOwnPropNames2 = Object.getOwnPropertyNames;
  var __hasOwnProp2 = Object.prototype.hasOwnProperty;
  function __accessProp(key) {
    return this[key];
  }
  var __toESMCache_node;
  var __toESMCache_esm;
  var __toESM = (mod, isNodeMode, target) => {
    var canCache = mod != null && typeof mod === "object";
    if (canCache) {
      var cache = isNodeMode ? __toESMCache_node ??= /* @__PURE__ */ new WeakMap() : __toESMCache_esm ??= /* @__PURE__ */ new WeakMap();
      var cached = cache.get(mod);
      if (cached)
        return cached;
    }
    target = mod != null ? __create(__getProtoOf(mod)) : {};
    const to = isNodeMode || !mod || !mod.__esModule ? __defProp2(target, "default", { value: mod, enumerable: true }) : target;
    for (let key of __getOwnPropNames2(mod))
      if (!__hasOwnProp2.call(to, key))
        __defProp2(to, key, {
          get: __accessProp.bind(mod, key),
          enumerable: true
        });
    if (canCache)
      cache.set(mod, to);
    return to;
  };
  var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
  var require_can_promise = __commonJS((exports, module) => {
    module.exports = function() {
      return typeof Promise === "function" && Promise.prototype && Promise.prototype.then;
    };
  });
  var require_utils = __commonJS((exports) => {
    var toSJISFunction;
    var CODEWORDS_COUNT = [
      0,
      26,
      44,
      70,
      100,
      134,
      172,
      196,
      242,
      292,
      346,
      404,
      466,
      532,
      581,
      655,
      733,
      815,
      901,
      991,
      1085,
      1156,
      1258,
      1364,
      1474,
      1588,
      1706,
      1828,
      1921,
      2051,
      2185,
      2323,
      2465,
      2611,
      2761,
      2876,
      3034,
      3196,
      3362,
      3532,
      3706
    ];
    exports.getSymbolSize = function getSymbolSize(version) {
      if (!version)
        throw new Error('"version" cannot be null or undefined');
      if (version < 1 || version > 40)
        throw new Error('"version" should be in range from 1 to 40');
      return version * 4 + 17;
    };
    exports.getSymbolTotalCodewords = function getSymbolTotalCodewords(version) {
      return CODEWORDS_COUNT[version];
    };
    exports.getBCHDigit = function(data) {
      let digit = 0;
      while (data !== 0) {
        digit++;
        data >>>= 1;
      }
      return digit;
    };
    exports.setToSJISFunction = function setToSJISFunction(f) {
      if (typeof f !== "function") {
        throw new Error('"toSJISFunc" is not a valid function.');
      }
      toSJISFunction = f;
    };
    exports.isKanjiModeEnabled = function() {
      return typeof toSJISFunction !== "undefined";
    };
    exports.toSJIS = function toSJIS(kanji) {
      return toSJISFunction(kanji);
    };
  });
  var require_error_correction_level = __commonJS((exports) => {
    exports.L = { bit: 1 };
    exports.M = { bit: 0 };
    exports.Q = { bit: 3 };
    exports.H = { bit: 2 };
    function fromString(string) {
      if (typeof string !== "string") {
        throw new Error("Param is not a string");
      }
      const lcStr = string.toLowerCase();
      switch (lcStr) {
        case "l":
        case "low":
          return exports.L;
        case "m":
        case "medium":
          return exports.M;
        case "q":
        case "quartile":
          return exports.Q;
        case "h":
        case "high":
          return exports.H;
        default:
          throw new Error("Unknown EC Level: " + string);
      }
    }
    exports.isValid = function isValid(level) {
      return level && typeof level.bit !== "undefined" && level.bit >= 0 && level.bit < 4;
    };
    exports.from = function from(value, defaultValue) {
      if (exports.isValid(value)) {
        return value;
      }
      try {
        return fromString(value);
      } catch (e) {
        return defaultValue;
      }
    };
  });
  var require_bit_buffer = __commonJS((exports, module) => {
    function BitBuffer() {
      this.buffer = [];
      this.length = 0;
    }
    BitBuffer.prototype = {
      get: function(index) {
        const bufIndex = Math.floor(index / 8);
        return (this.buffer[bufIndex] >>> 7 - index % 8 & 1) === 1;
      },
      put: function(num, length) {
        for (let i = 0; i < length; i++) {
          this.putBit((num >>> length - i - 1 & 1) === 1);
        }
      },
      getLengthInBits: function() {
        return this.length;
      },
      putBit: function(bit) {
        const bufIndex = Math.floor(this.length / 8);
        if (this.buffer.length <= bufIndex) {
          this.buffer.push(0);
        }
        if (bit) {
          this.buffer[bufIndex] |= 128 >>> this.length % 8;
        }
        this.length++;
      }
    };
    module.exports = BitBuffer;
  });
  var require_bit_matrix = __commonJS((exports, module) => {
    function BitMatrix(size) {
      if (!size || size < 1) {
        throw new Error("BitMatrix size must be defined and greater than 0");
      }
      this.size = size;
      this.data = new Uint8Array(size * size);
      this.reservedBit = new Uint8Array(size * size);
    }
    BitMatrix.prototype.set = function(row, col, value, reserved) {
      const index = row * this.size + col;
      this.data[index] = value;
      if (reserved)
        this.reservedBit[index] = true;
    };
    BitMatrix.prototype.get = function(row, col) {
      return this.data[row * this.size + col];
    };
    BitMatrix.prototype.xor = function(row, col, value) {
      this.data[row * this.size + col] ^= value;
    };
    BitMatrix.prototype.isReserved = function(row, col) {
      return this.reservedBit[row * this.size + col];
    };
    module.exports = BitMatrix;
  });
  var require_alignment_pattern = __commonJS((exports) => {
    var getSymbolSize = require_utils().getSymbolSize;
    exports.getRowColCoords = function getRowColCoords(version) {
      if (version === 1)
        return [];
      const posCount = Math.floor(version / 7) + 2;
      const size = getSymbolSize(version);
      const intervals = size === 145 ? 26 : Math.ceil((size - 13) / (2 * posCount - 2)) * 2;
      const positions = [size - 7];
      for (let i = 1; i < posCount - 1; i++) {
        positions[i] = positions[i - 1] - intervals;
      }
      positions.push(6);
      return positions.reverse();
    };
    exports.getPositions = function getPositions(version) {
      const coords = [];
      const pos = exports.getRowColCoords(version);
      const posLength = pos.length;
      for (let i = 0; i < posLength; i++) {
        for (let j = 0; j < posLength; j++) {
          if (i === 0 && j === 0 || i === 0 && j === posLength - 1 || i === posLength - 1 && j === 0) {
            continue;
          }
          coords.push([pos[i], pos[j]]);
        }
      }
      return coords;
    };
  });
  var require_finder_pattern = __commonJS((exports) => {
    var getSymbolSize = require_utils().getSymbolSize;
    var FINDER_PATTERN_SIZE = 7;
    exports.getPositions = function getPositions(version) {
      const size = getSymbolSize(version);
      return [
        [0, 0],
        [size - FINDER_PATTERN_SIZE, 0],
        [0, size - FINDER_PATTERN_SIZE]
      ];
    };
  });
  var require_mask_pattern = __commonJS((exports) => {
    exports.Patterns = {
      PATTERN000: 0,
      PATTERN001: 1,
      PATTERN010: 2,
      PATTERN011: 3,
      PATTERN100: 4,
      PATTERN101: 5,
      PATTERN110: 6,
      PATTERN111: 7
    };
    var PenaltyScores = {
      N1: 3,
      N2: 3,
      N3: 40,
      N4: 10
    };
    exports.isValid = function isValid(mask) {
      return mask != null && mask !== "" && !isNaN(mask) && mask >= 0 && mask <= 7;
    };
    exports.from = function from(value) {
      return exports.isValid(value) ? parseInt(value, 10) : void 0;
    };
    exports.getPenaltyN1 = function getPenaltyN1(data) {
      const size = data.size;
      let points = 0;
      let sameCountCol = 0;
      let sameCountRow = 0;
      let lastCol = null;
      let lastRow = null;
      for (let row = 0; row < size; row++) {
        sameCountCol = sameCountRow = 0;
        lastCol = lastRow = null;
        for (let col = 0; col < size; col++) {
          let module2 = data.get(row, col);
          if (module2 === lastCol) {
            sameCountCol++;
          } else {
            if (sameCountCol >= 5)
              points += PenaltyScores.N1 + (sameCountCol - 5);
            lastCol = module2;
            sameCountCol = 1;
          }
          module2 = data.get(col, row);
          if (module2 === lastRow) {
            sameCountRow++;
          } else {
            if (sameCountRow >= 5)
              points += PenaltyScores.N1 + (sameCountRow - 5);
            lastRow = module2;
            sameCountRow = 1;
          }
        }
        if (sameCountCol >= 5)
          points += PenaltyScores.N1 + (sameCountCol - 5);
        if (sameCountRow >= 5)
          points += PenaltyScores.N1 + (sameCountRow - 5);
      }
      return points;
    };
    exports.getPenaltyN2 = function getPenaltyN2(data) {
      const size = data.size;
      let points = 0;
      for (let row = 0; row < size - 1; row++) {
        for (let col = 0; col < size - 1; col++) {
          const last = data.get(row, col) + data.get(row, col + 1) + data.get(row + 1, col) + data.get(row + 1, col + 1);
          if (last === 4 || last === 0)
            points++;
        }
      }
      return points * PenaltyScores.N2;
    };
    exports.getPenaltyN3 = function getPenaltyN3(data) {
      const size = data.size;
      let points = 0;
      let bitsCol = 0;
      let bitsRow = 0;
      for (let row = 0; row < size; row++) {
        bitsCol = bitsRow = 0;
        for (let col = 0; col < size; col++) {
          bitsCol = bitsCol << 1 & 2047 | data.get(row, col);
          if (col >= 10 && (bitsCol === 1488 || bitsCol === 93))
            points++;
          bitsRow = bitsRow << 1 & 2047 | data.get(col, row);
          if (col >= 10 && (bitsRow === 1488 || bitsRow === 93))
            points++;
        }
      }
      return points * PenaltyScores.N3;
    };
    exports.getPenaltyN4 = function getPenaltyN4(data) {
      let darkCount = 0;
      const modulesCount = data.data.length;
      for (let i = 0; i < modulesCount; i++)
        darkCount += data.data[i];
      const k = Math.abs(Math.ceil(darkCount * 100 / modulesCount / 5) - 10);
      return k * PenaltyScores.N4;
    };
    function getMaskAt(maskPattern, i, j) {
      switch (maskPattern) {
        case exports.Patterns.PATTERN000:
          return (i + j) % 2 === 0;
        case exports.Patterns.PATTERN001:
          return i % 2 === 0;
        case exports.Patterns.PATTERN010:
          return j % 3 === 0;
        case exports.Patterns.PATTERN011:
          return (i + j) % 3 === 0;
        case exports.Patterns.PATTERN100:
          return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
        case exports.Patterns.PATTERN101:
          return i * j % 2 + i * j % 3 === 0;
        case exports.Patterns.PATTERN110:
          return (i * j % 2 + i * j % 3) % 2 === 0;
        case exports.Patterns.PATTERN111:
          return (i * j % 3 + (i + j) % 2) % 2 === 0;
        default:
          throw new Error("bad maskPattern:" + maskPattern);
      }
    }
    exports.applyMask = function applyMask(pattern, data) {
      const size = data.size;
      for (let col = 0; col < size; col++) {
        for (let row = 0; row < size; row++) {
          if (data.isReserved(row, col))
            continue;
          data.xor(row, col, getMaskAt(pattern, row, col));
        }
      }
    };
    exports.getBestMask = function getBestMask(data, setupFormatFunc) {
      const numPatterns = Object.keys(exports.Patterns).length;
      let bestPattern = 0;
      let lowerPenalty = Infinity;
      for (let p = 0; p < numPatterns; p++) {
        setupFormatFunc(p);
        exports.applyMask(p, data);
        const penalty = exports.getPenaltyN1(data) + exports.getPenaltyN2(data) + exports.getPenaltyN3(data) + exports.getPenaltyN4(data);
        exports.applyMask(p, data);
        if (penalty < lowerPenalty) {
          lowerPenalty = penalty;
          bestPattern = p;
        }
      }
      return bestPattern;
    };
  });
  var require_error_correction_code = __commonJS((exports) => {
    var ECLevel = require_error_correction_level();
    var EC_BLOCKS_TABLE = [
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      2,
      2,
      1,
      2,
      2,
      4,
      1,
      2,
      4,
      4,
      2,
      4,
      4,
      4,
      2,
      4,
      6,
      5,
      2,
      4,
      6,
      6,
      2,
      5,
      8,
      8,
      4,
      5,
      8,
      8,
      4,
      5,
      8,
      11,
      4,
      8,
      10,
      11,
      4,
      9,
      12,
      16,
      4,
      9,
      16,
      16,
      6,
      10,
      12,
      18,
      6,
      10,
      17,
      16,
      6,
      11,
      16,
      19,
      6,
      13,
      18,
      21,
      7,
      14,
      21,
      25,
      8,
      16,
      20,
      25,
      8,
      17,
      23,
      25,
      9,
      17,
      23,
      34,
      9,
      18,
      25,
      30,
      10,
      20,
      27,
      32,
      12,
      21,
      29,
      35,
      12,
      23,
      34,
      37,
      12,
      25,
      34,
      40,
      13,
      26,
      35,
      42,
      14,
      28,
      38,
      45,
      15,
      29,
      40,
      48,
      16,
      31,
      43,
      51,
      17,
      33,
      45,
      54,
      18,
      35,
      48,
      57,
      19,
      37,
      51,
      60,
      19,
      38,
      53,
      63,
      20,
      40,
      56,
      66,
      21,
      43,
      59,
      70,
      22,
      45,
      62,
      74,
      24,
      47,
      65,
      77,
      25,
      49,
      68,
      81
    ];
    var EC_CODEWORDS_TABLE = [
      7,
      10,
      13,
      17,
      10,
      16,
      22,
      28,
      15,
      26,
      36,
      44,
      20,
      36,
      52,
      64,
      26,
      48,
      72,
      88,
      36,
      64,
      96,
      112,
      40,
      72,
      108,
      130,
      48,
      88,
      132,
      156,
      60,
      110,
      160,
      192,
      72,
      130,
      192,
      224,
      80,
      150,
      224,
      264,
      96,
      176,
      260,
      308,
      104,
      198,
      288,
      352,
      120,
      216,
      320,
      384,
      132,
      240,
      360,
      432,
      144,
      280,
      408,
      480,
      168,
      308,
      448,
      532,
      180,
      338,
      504,
      588,
      196,
      364,
      546,
      650,
      224,
      416,
      600,
      700,
      224,
      442,
      644,
      750,
      252,
      476,
      690,
      816,
      270,
      504,
      750,
      900,
      300,
      560,
      810,
      960,
      312,
      588,
      870,
      1050,
      336,
      644,
      952,
      1110,
      360,
      700,
      1020,
      1200,
      390,
      728,
      1050,
      1260,
      420,
      784,
      1140,
      1350,
      450,
      812,
      1200,
      1440,
      480,
      868,
      1290,
      1530,
      510,
      924,
      1350,
      1620,
      540,
      980,
      1440,
      1710,
      570,
      1036,
      1530,
      1800,
      570,
      1064,
      1590,
      1890,
      600,
      1120,
      1680,
      1980,
      630,
      1204,
      1770,
      2100,
      660,
      1260,
      1860,
      2220,
      720,
      1316,
      1950,
      2310,
      750,
      1372,
      2040,
      2430
    ];
    exports.getBlocksCount = function getBlocksCount(version, errorCorrectionLevel) {
      switch (errorCorrectionLevel) {
        case ECLevel.L:
          return EC_BLOCKS_TABLE[(version - 1) * 4 + 0];
        case ECLevel.M:
          return EC_BLOCKS_TABLE[(version - 1) * 4 + 1];
        case ECLevel.Q:
          return EC_BLOCKS_TABLE[(version - 1) * 4 + 2];
        case ECLevel.H:
          return EC_BLOCKS_TABLE[(version - 1) * 4 + 3];
        default:
          return;
      }
    };
    exports.getTotalCodewordsCount = function getTotalCodewordsCount(version, errorCorrectionLevel) {
      switch (errorCorrectionLevel) {
        case ECLevel.L:
          return EC_CODEWORDS_TABLE[(version - 1) * 4 + 0];
        case ECLevel.M:
          return EC_CODEWORDS_TABLE[(version - 1) * 4 + 1];
        case ECLevel.Q:
          return EC_CODEWORDS_TABLE[(version - 1) * 4 + 2];
        case ECLevel.H:
          return EC_CODEWORDS_TABLE[(version - 1) * 4 + 3];
        default:
          return;
      }
    };
  });
  var require_galois_field = __commonJS((exports) => {
    var EXP_TABLE = new Uint8Array(512);
    var LOG_TABLE = new Uint8Array(256);
    (function initTables() {
      let x = 1;
      for (let i = 0; i < 255; i++) {
        EXP_TABLE[i] = x;
        LOG_TABLE[x] = i;
        x <<= 1;
        if (x & 256) {
          x ^= 285;
        }
      }
      for (let i = 255; i < 512; i++) {
        EXP_TABLE[i] = EXP_TABLE[i - 255];
      }
    })();
    exports.log = function log(n) {
      if (n < 1)
        throw new Error("log(" + n + ")");
      return LOG_TABLE[n];
    };
    exports.exp = function exp(n) {
      return EXP_TABLE[n];
    };
    exports.mul = function mul(x, y) {
      if (x === 0 || y === 0)
        return 0;
      return EXP_TABLE[LOG_TABLE[x] + LOG_TABLE[y]];
    };
  });
  var require_polynomial = __commonJS((exports) => {
    var GF = require_galois_field();
    exports.mul = function mul(p1, p2) {
      const coeff = new Uint8Array(p1.length + p2.length - 1);
      for (let i = 0; i < p1.length; i++) {
        for (let j = 0; j < p2.length; j++) {
          coeff[i + j] ^= GF.mul(p1[i], p2[j]);
        }
      }
      return coeff;
    };
    exports.mod = function mod(divident, divisor) {
      let result = new Uint8Array(divident);
      while (result.length - divisor.length >= 0) {
        const coeff = result[0];
        for (let i = 0; i < divisor.length; i++) {
          result[i] ^= GF.mul(divisor[i], coeff);
        }
        let offset = 0;
        while (offset < result.length && result[offset] === 0)
          offset++;
        result = result.slice(offset);
      }
      return result;
    };
    exports.generateECPolynomial = function generateECPolynomial(degree) {
      let poly = new Uint8Array([1]);
      for (let i = 0; i < degree; i++) {
        poly = exports.mul(poly, new Uint8Array([1, GF.exp(i)]));
      }
      return poly;
    };
  });
  var require_reed_solomon_encoder = __commonJS((exports, module) => {
    var Polynomial = require_polynomial();
    function ReedSolomonEncoder(degree) {
      this.genPoly = void 0;
      this.degree = degree;
      if (this.degree)
        this.initialize(this.degree);
    }
    ReedSolomonEncoder.prototype.initialize = function initialize(degree) {
      this.degree = degree;
      this.genPoly = Polynomial.generateECPolynomial(this.degree);
    };
    ReedSolomonEncoder.prototype.encode = function encode(data) {
      if (!this.genPoly) {
        throw new Error("Encoder not initialized");
      }
      const paddedData = new Uint8Array(data.length + this.degree);
      paddedData.set(data);
      const remainder = Polynomial.mod(paddedData, this.genPoly);
      const start = this.degree - remainder.length;
      if (start > 0) {
        const buff = new Uint8Array(this.degree);
        buff.set(remainder, start);
        return buff;
      }
      return remainder;
    };
    module.exports = ReedSolomonEncoder;
  });
  var require_version_check = __commonJS((exports) => {
    exports.isValid = function isValid(version) {
      return !isNaN(version) && version >= 1 && version <= 40;
    };
  });
  var require_regex = __commonJS((exports) => {
    var numeric = "[0-9]+";
    var alphanumeric = "[A-Z $%*+\\-./:]+";
    var kanji = "(?:[u3000-u303F]|[u3040-u309F]|[u30A0-u30FF]|[uFF00-uFFEF]|[u4E00-u9FAF]|[u2605-u2606]|[u2190-u2195]|u203B|[u2010u2015u2018u2019u2025u2026u201Cu201Du2225u2260]|[u0391-u0451]|[u00A7u00A8u00B1u00B4u00D7u00F7])+";
    kanji = kanji.replace(/u/g, "\\u");
    var byte = "(?:(?![A-Z0-9 $%*+\\-./:]|" + kanji + `)(?:.|[\r
]))+`;
    exports.KANJI = new RegExp(kanji, "g");
    exports.BYTE_KANJI = new RegExp("[^A-Z0-9 $%*+\\-./:]+", "g");
    exports.BYTE = new RegExp(byte, "g");
    exports.NUMERIC = new RegExp(numeric, "g");
    exports.ALPHANUMERIC = new RegExp(alphanumeric, "g");
    var TEST_KANJI = new RegExp("^" + kanji + "$");
    var TEST_NUMERIC = new RegExp("^" + numeric + "$");
    var TEST_ALPHANUMERIC = new RegExp("^[A-Z0-9 $%*+\\-./:]+$");
    exports.testKanji = function testKanji(str) {
      return TEST_KANJI.test(str);
    };
    exports.testNumeric = function testNumeric(str) {
      return TEST_NUMERIC.test(str);
    };
    exports.testAlphanumeric = function testAlphanumeric(str) {
      return TEST_ALPHANUMERIC.test(str);
    };
  });
  var require_mode = __commonJS((exports) => {
    var VersionCheck = require_version_check();
    var Regex = require_regex();
    exports.NUMERIC = {
      id: "Numeric",
      bit: 1 << 0,
      ccBits: [10, 12, 14]
    };
    exports.ALPHANUMERIC = {
      id: "Alphanumeric",
      bit: 1 << 1,
      ccBits: [9, 11, 13]
    };
    exports.BYTE = {
      id: "Byte",
      bit: 1 << 2,
      ccBits: [8, 16, 16]
    };
    exports.KANJI = {
      id: "Kanji",
      bit: 1 << 3,
      ccBits: [8, 10, 12]
    };
    exports.MIXED = {
      bit: -1
    };
    exports.getCharCountIndicator = function getCharCountIndicator(mode, version) {
      if (!mode.ccBits)
        throw new Error("Invalid mode: " + mode);
      if (!VersionCheck.isValid(version)) {
        throw new Error("Invalid version: " + version);
      }
      if (version >= 1 && version < 10)
        return mode.ccBits[0];
      else if (version < 27)
        return mode.ccBits[1];
      return mode.ccBits[2];
    };
    exports.getBestModeForData = function getBestModeForData(dataStr) {
      if (Regex.testNumeric(dataStr))
        return exports.NUMERIC;
      else if (Regex.testAlphanumeric(dataStr))
        return exports.ALPHANUMERIC;
      else if (Regex.testKanji(dataStr))
        return exports.KANJI;
      else
        return exports.BYTE;
    };
    exports.toString = function toString(mode) {
      if (mode && mode.id)
        return mode.id;
      throw new Error("Invalid mode");
    };
    exports.isValid = function isValid(mode) {
      return mode && mode.bit && mode.ccBits;
    };
    function fromString(string) {
      if (typeof string !== "string") {
        throw new Error("Param is not a string");
      }
      const lcStr = string.toLowerCase();
      switch (lcStr) {
        case "numeric":
          return exports.NUMERIC;
        case "alphanumeric":
          return exports.ALPHANUMERIC;
        case "kanji":
          return exports.KANJI;
        case "byte":
          return exports.BYTE;
        default:
          throw new Error("Unknown mode: " + string);
      }
    }
    exports.from = function from(value, defaultValue) {
      if (exports.isValid(value)) {
        return value;
      }
      try {
        return fromString(value);
      } catch (e) {
        return defaultValue;
      }
    };
  });
  var require_version = __commonJS((exports) => {
    var Utils = require_utils();
    var ECCode = require_error_correction_code();
    var ECLevel = require_error_correction_level();
    var Mode = require_mode();
    var VersionCheck = require_version_check();
    var G18 = 1 << 12 | 1 << 11 | 1 << 10 | 1 << 9 | 1 << 8 | 1 << 5 | 1 << 2 | 1 << 0;
    var G18_BCH = Utils.getBCHDigit(G18);
    function getBestVersionForDataLength(mode, length, errorCorrectionLevel) {
      for (let currentVersion = 1; currentVersion <= 40; currentVersion++) {
        if (length <= exports.getCapacity(currentVersion, errorCorrectionLevel, mode)) {
          return currentVersion;
        }
      }
      return;
    }
    function getReservedBitsCount(mode, version) {
      return Mode.getCharCountIndicator(mode, version) + 4;
    }
    function getTotalBitsFromDataArray(segments, version) {
      let totalBits = 0;
      segments.forEach(function(data) {
        const reservedBits = getReservedBitsCount(data.mode, version);
        totalBits += reservedBits + data.getBitsLength();
      });
      return totalBits;
    }
    function getBestVersionForMixedData(segments, errorCorrectionLevel) {
      for (let currentVersion = 1; currentVersion <= 40; currentVersion++) {
        const length = getTotalBitsFromDataArray(segments, currentVersion);
        if (length <= exports.getCapacity(currentVersion, errorCorrectionLevel, Mode.MIXED)) {
          return currentVersion;
        }
      }
      return;
    }
    exports.from = function from(value, defaultValue) {
      if (VersionCheck.isValid(value)) {
        return parseInt(value, 10);
      }
      return defaultValue;
    };
    exports.getCapacity = function getCapacity(version, errorCorrectionLevel, mode) {
      if (!VersionCheck.isValid(version)) {
        throw new Error("Invalid QR Code version");
      }
      if (typeof mode === "undefined")
        mode = Mode.BYTE;
      const totalCodewords = Utils.getSymbolTotalCodewords(version);
      const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
      const dataTotalCodewordsBits = (totalCodewords - ecTotalCodewords) * 8;
      if (mode === Mode.MIXED)
        return dataTotalCodewordsBits;
      const usableBits = dataTotalCodewordsBits - getReservedBitsCount(mode, version);
      switch (mode) {
        case Mode.NUMERIC:
          return Math.floor(usableBits / 10 * 3);
        case Mode.ALPHANUMERIC:
          return Math.floor(usableBits / 11 * 2);
        case Mode.KANJI:
          return Math.floor(usableBits / 13);
        case Mode.BYTE:
        default:
          return Math.floor(usableBits / 8);
      }
    };
    exports.getBestVersionForData = function getBestVersionForData(data, errorCorrectionLevel) {
      let seg;
      const ecl = ECLevel.from(errorCorrectionLevel, ECLevel.M);
      if (Array.isArray(data)) {
        if (data.length > 1) {
          return getBestVersionForMixedData(data, ecl);
        }
        if (data.length === 0) {
          return 1;
        }
        seg = data[0];
      } else {
        seg = data;
      }
      return getBestVersionForDataLength(seg.mode, seg.getLength(), ecl);
    };
    exports.getEncodedBits = function getEncodedBits(version) {
      if (!VersionCheck.isValid(version) || version < 7) {
        throw new Error("Invalid QR Code version");
      }
      let d = version << 12;
      while (Utils.getBCHDigit(d) - G18_BCH >= 0) {
        d ^= G18 << Utils.getBCHDigit(d) - G18_BCH;
      }
      return version << 12 | d;
    };
  });
  var require_format_info = __commonJS((exports) => {
    var Utils = require_utils();
    var G15 = 1 << 10 | 1 << 8 | 1 << 5 | 1 << 4 | 1 << 2 | 1 << 1 | 1 << 0;
    var G15_MASK = 1 << 14 | 1 << 12 | 1 << 10 | 1 << 4 | 1 << 1;
    var G15_BCH = Utils.getBCHDigit(G15);
    exports.getEncodedBits = function getEncodedBits(errorCorrectionLevel, mask) {
      const data = errorCorrectionLevel.bit << 3 | mask;
      let d = data << 10;
      while (Utils.getBCHDigit(d) - G15_BCH >= 0) {
        d ^= G15 << Utils.getBCHDigit(d) - G15_BCH;
      }
      return (data << 10 | d) ^ G15_MASK;
    };
  });
  var require_numeric_data = __commonJS((exports, module) => {
    var Mode = require_mode();
    function NumericData(data) {
      this.mode = Mode.NUMERIC;
      this.data = data.toString();
    }
    NumericData.getBitsLength = function getBitsLength(length) {
      return 10 * Math.floor(length / 3) + (length % 3 ? length % 3 * 3 + 1 : 0);
    };
    NumericData.prototype.getLength = function getLength() {
      return this.data.length;
    };
    NumericData.prototype.getBitsLength = function getBitsLength() {
      return NumericData.getBitsLength(this.data.length);
    };
    NumericData.prototype.write = function write(bitBuffer) {
      let i, group, value;
      for (i = 0; i + 3 <= this.data.length; i += 3) {
        group = this.data.substr(i, 3);
        value = parseInt(group, 10);
        bitBuffer.put(value, 10);
      }
      const remainingNum = this.data.length - i;
      if (remainingNum > 0) {
        group = this.data.substr(i);
        value = parseInt(group, 10);
        bitBuffer.put(value, remainingNum * 3 + 1);
      }
    };
    module.exports = NumericData;
  });
  var require_alphanumeric_data = __commonJS((exports, module) => {
    var Mode = require_mode();
    var ALPHA_NUM_CHARS = [
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
      "I",
      "J",
      "K",
      "L",
      "M",
      "N",
      "O",
      "P",
      "Q",
      "R",
      "S",
      "T",
      "U",
      "V",
      "W",
      "X",
      "Y",
      "Z",
      " ",
      "$",
      "%",
      "*",
      "+",
      "-",
      ".",
      "/",
      ":"
    ];
    function AlphanumericData(data) {
      this.mode = Mode.ALPHANUMERIC;
      this.data = data;
    }
    AlphanumericData.getBitsLength = function getBitsLength(length) {
      return 11 * Math.floor(length / 2) + 6 * (length % 2);
    };
    AlphanumericData.prototype.getLength = function getLength() {
      return this.data.length;
    };
    AlphanumericData.prototype.getBitsLength = function getBitsLength() {
      return AlphanumericData.getBitsLength(this.data.length);
    };
    AlphanumericData.prototype.write = function write(bitBuffer) {
      let i;
      for (i = 0; i + 2 <= this.data.length; i += 2) {
        let value = ALPHA_NUM_CHARS.indexOf(this.data[i]) * 45;
        value += ALPHA_NUM_CHARS.indexOf(this.data[i + 1]);
        bitBuffer.put(value, 11);
      }
      if (this.data.length % 2) {
        bitBuffer.put(ALPHA_NUM_CHARS.indexOf(this.data[i]), 6);
      }
    };
    module.exports = AlphanumericData;
  });
  var require_byte_data = __commonJS((exports, module) => {
    var Mode = require_mode();
    function ByteData(data) {
      this.mode = Mode.BYTE;
      if (typeof data === "string") {
        this.data = new TextEncoder().encode(data);
      } else {
        this.data = new Uint8Array(data);
      }
    }
    ByteData.getBitsLength = function getBitsLength(length) {
      return length * 8;
    };
    ByteData.prototype.getLength = function getLength() {
      return this.data.length;
    };
    ByteData.prototype.getBitsLength = function getBitsLength() {
      return ByteData.getBitsLength(this.data.length);
    };
    ByteData.prototype.write = function(bitBuffer) {
      for (let i = 0, l = this.data.length; i < l; i++) {
        bitBuffer.put(this.data[i], 8);
      }
    };
    module.exports = ByteData;
  });
  var require_kanji_data = __commonJS((exports, module) => {
    var Mode = require_mode();
    var Utils = require_utils();
    function KanjiData(data) {
      this.mode = Mode.KANJI;
      this.data = data;
    }
    KanjiData.getBitsLength = function getBitsLength(length) {
      return length * 13;
    };
    KanjiData.prototype.getLength = function getLength() {
      return this.data.length;
    };
    KanjiData.prototype.getBitsLength = function getBitsLength() {
      return KanjiData.getBitsLength(this.data.length);
    };
    KanjiData.prototype.write = function(bitBuffer) {
      let i;
      for (i = 0; i < this.data.length; i++) {
        let value = Utils.toSJIS(this.data[i]);
        if (value >= 33088 && value <= 40956) {
          value -= 33088;
        } else if (value >= 57408 && value <= 60351) {
          value -= 49472;
        } else {
          throw new Error("Invalid SJIS character: " + this.data[i] + `
Make sure your charset is UTF-8`);
        }
        value = (value >>> 8 & 255) * 192 + (value & 255);
        bitBuffer.put(value, 13);
      }
    };
    module.exports = KanjiData;
  });
  var require_dijkstra = __commonJS((exports, module) => {
    var dijkstra = {
      single_source_shortest_paths: function(graph, s, d) {
        var predecessors = {};
        var costs = {};
        costs[s] = 0;
        var open = dijkstra.PriorityQueue.make();
        open.push(s, 0);
        var closest, u, v, cost_of_s_to_u, adjacent_nodes, cost_of_e, cost_of_s_to_u_plus_cost_of_e, cost_of_s_to_v, first_visit;
        while (!open.empty()) {
          closest = open.pop();
          u = closest.value;
          cost_of_s_to_u = closest.cost;
          adjacent_nodes = graph[u] || {};
          for (v in adjacent_nodes) {
            if (adjacent_nodes.hasOwnProperty(v)) {
              cost_of_e = adjacent_nodes[v];
              cost_of_s_to_u_plus_cost_of_e = cost_of_s_to_u + cost_of_e;
              cost_of_s_to_v = costs[v];
              first_visit = typeof costs[v] === "undefined";
              if (first_visit || cost_of_s_to_v > cost_of_s_to_u_plus_cost_of_e) {
                costs[v] = cost_of_s_to_u_plus_cost_of_e;
                open.push(v, cost_of_s_to_u_plus_cost_of_e);
                predecessors[v] = u;
              }
            }
          }
        }
        if (typeof d !== "undefined" && typeof costs[d] === "undefined") {
          var msg = ["Could not find a path from ", s, " to ", d, "."].join("");
          throw new Error(msg);
        }
        return predecessors;
      },
      extract_shortest_path_from_predecessor_list: function(predecessors, d) {
        var nodes = [];
        var u = d;
        var predecessor;
        while (u) {
          nodes.push(u);
          predecessor = predecessors[u];
          u = predecessors[u];
        }
        nodes.reverse();
        return nodes;
      },
      find_path: function(graph, s, d) {
        var predecessors = dijkstra.single_source_shortest_paths(graph, s, d);
        return dijkstra.extract_shortest_path_from_predecessor_list(predecessors, d);
      },
      PriorityQueue: {
        make: function(opts) {
          var T = dijkstra.PriorityQueue, t = {}, key;
          opts = opts || {};
          for (key in T) {
            if (T.hasOwnProperty(key)) {
              t[key] = T[key];
            }
          }
          t.queue = [];
          t.sorter = opts.sorter || T.default_sorter;
          return t;
        },
        default_sorter: function(a, b) {
          return a.cost - b.cost;
        },
        push: function(value, cost) {
          var item = { value, cost };
          this.queue.push(item);
          this.queue.sort(this.sorter);
        },
        pop: function() {
          return this.queue.shift();
        },
        empty: function() {
          return this.queue.length === 0;
        }
      }
    };
    if (typeof module !== "undefined") {
      module.exports = dijkstra;
    }
  });
  var require_segments = __commonJS((exports) => {
    var Mode = require_mode();
    var NumericData = require_numeric_data();
    var AlphanumericData = require_alphanumeric_data();
    var ByteData = require_byte_data();
    var KanjiData = require_kanji_data();
    var Regex = require_regex();
    var Utils = require_utils();
    var dijkstra = require_dijkstra();
    function getStringByteLength(str) {
      return unescape(encodeURIComponent(str)).length;
    }
    function getSegments(regex, mode, str) {
      const segments = [];
      let result;
      while ((result = regex.exec(str)) !== null) {
        segments.push({
          data: result[0],
          index: result.index,
          mode,
          length: result[0].length
        });
      }
      return segments;
    }
    function getSegmentsFromString(dataStr) {
      const numSegs = getSegments(Regex.NUMERIC, Mode.NUMERIC, dataStr);
      const alphaNumSegs = getSegments(Regex.ALPHANUMERIC, Mode.ALPHANUMERIC, dataStr);
      let byteSegs;
      let kanjiSegs;
      if (Utils.isKanjiModeEnabled()) {
        byteSegs = getSegments(Regex.BYTE, Mode.BYTE, dataStr);
        kanjiSegs = getSegments(Regex.KANJI, Mode.KANJI, dataStr);
      } else {
        byteSegs = getSegments(Regex.BYTE_KANJI, Mode.BYTE, dataStr);
        kanjiSegs = [];
      }
      const segs = numSegs.concat(alphaNumSegs, byteSegs, kanjiSegs);
      return segs.sort(function(s1, s2) {
        return s1.index - s2.index;
      }).map(function(obj) {
        return {
          data: obj.data,
          mode: obj.mode,
          length: obj.length
        };
      });
    }
    function getSegmentBitsLength(length, mode) {
      switch (mode) {
        case Mode.NUMERIC:
          return NumericData.getBitsLength(length);
        case Mode.ALPHANUMERIC:
          return AlphanumericData.getBitsLength(length);
        case Mode.KANJI:
          return KanjiData.getBitsLength(length);
        case Mode.BYTE:
          return ByteData.getBitsLength(length);
      }
    }
    function mergeSegments(segs) {
      return segs.reduce(function(acc, curr) {
        const prevSeg = acc.length - 1 >= 0 ? acc[acc.length - 1] : null;
        if (prevSeg && prevSeg.mode === curr.mode) {
          acc[acc.length - 1].data += curr.data;
          return acc;
        }
        acc.push(curr);
        return acc;
      }, []);
    }
    function buildNodes(segs) {
      const nodes = [];
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        switch (seg.mode) {
          case Mode.NUMERIC:
            nodes.push([
              seg,
              { data: seg.data, mode: Mode.ALPHANUMERIC, length: seg.length },
              { data: seg.data, mode: Mode.BYTE, length: seg.length }
            ]);
            break;
          case Mode.ALPHANUMERIC:
            nodes.push([
              seg,
              { data: seg.data, mode: Mode.BYTE, length: seg.length }
            ]);
            break;
          case Mode.KANJI:
            nodes.push([
              seg,
              { data: seg.data, mode: Mode.BYTE, length: getStringByteLength(seg.data) }
            ]);
            break;
          case Mode.BYTE:
            nodes.push([
              { data: seg.data, mode: Mode.BYTE, length: getStringByteLength(seg.data) }
            ]);
        }
      }
      return nodes;
    }
    function buildGraph(nodes, version) {
      const table = {};
      const graph = { start: {} };
      let prevNodeIds = ["start"];
      for (let i = 0; i < nodes.length; i++) {
        const nodeGroup = nodes[i];
        const currentNodeIds = [];
        for (let j = 0; j < nodeGroup.length; j++) {
          const node = nodeGroup[j];
          const key = "" + i + j;
          currentNodeIds.push(key);
          table[key] = { node, lastCount: 0 };
          graph[key] = {};
          for (let n = 0; n < prevNodeIds.length; n++) {
            const prevNodeId = prevNodeIds[n];
            if (table[prevNodeId] && table[prevNodeId].node.mode === node.mode) {
              graph[prevNodeId][key] = getSegmentBitsLength(table[prevNodeId].lastCount + node.length, node.mode) - getSegmentBitsLength(table[prevNodeId].lastCount, node.mode);
              table[prevNodeId].lastCount += node.length;
            } else {
              if (table[prevNodeId])
                table[prevNodeId].lastCount = node.length;
              graph[prevNodeId][key] = getSegmentBitsLength(node.length, node.mode) + 4 + Mode.getCharCountIndicator(node.mode, version);
            }
          }
        }
        prevNodeIds = currentNodeIds;
      }
      for (let n = 0; n < prevNodeIds.length; n++) {
        graph[prevNodeIds[n]].end = 0;
      }
      return { map: graph, table };
    }
    function buildSingleSegment(data, modesHint) {
      let mode;
      const bestMode = Mode.getBestModeForData(data);
      mode = Mode.from(modesHint, bestMode);
      if (mode !== Mode.BYTE && mode.bit < bestMode.bit) {
        throw new Error('"' + data + '" cannot be encoded with mode ' + Mode.toString(mode) + `.
 Suggested mode is: ` + Mode.toString(bestMode));
      }
      if (mode === Mode.KANJI && !Utils.isKanjiModeEnabled()) {
        mode = Mode.BYTE;
      }
      switch (mode) {
        case Mode.NUMERIC:
          return new NumericData(data);
        case Mode.ALPHANUMERIC:
          return new AlphanumericData(data);
        case Mode.KANJI:
          return new KanjiData(data);
        case Mode.BYTE:
          return new ByteData(data);
      }
    }
    exports.fromArray = function fromArray(array) {
      return array.reduce(function(acc, seg) {
        if (typeof seg === "string") {
          acc.push(buildSingleSegment(seg, null));
        } else if (seg.data) {
          acc.push(buildSingleSegment(seg.data, seg.mode));
        }
        return acc;
      }, []);
    };
    exports.fromString = function fromString(data, version) {
      const segs = getSegmentsFromString(data, Utils.isKanjiModeEnabled());
      const nodes = buildNodes(segs);
      const graph = buildGraph(nodes, version);
      const path = dijkstra.find_path(graph.map, "start", "end");
      const optimizedSegs = [];
      for (let i = 1; i < path.length - 1; i++) {
        optimizedSegs.push(graph.table[path[i]].node);
      }
      return exports.fromArray(mergeSegments(optimizedSegs));
    };
    exports.rawSplit = function rawSplit(data) {
      return exports.fromArray(getSegmentsFromString(data, Utils.isKanjiModeEnabled()));
    };
  });
  var require_qrcode = __commonJS((exports) => {
    var Utils = require_utils();
    var ECLevel = require_error_correction_level();
    var BitBuffer = require_bit_buffer();
    var BitMatrix = require_bit_matrix();
    var AlignmentPattern = require_alignment_pattern();
    var FinderPattern = require_finder_pattern();
    var MaskPattern = require_mask_pattern();
    var ECCode = require_error_correction_code();
    var ReedSolomonEncoder = require_reed_solomon_encoder();
    var Version = require_version();
    var FormatInfo = require_format_info();
    var Mode = require_mode();
    var Segments = require_segments();
    function setupFinderPattern(matrix, version) {
      const size = matrix.size;
      const pos = FinderPattern.getPositions(version);
      for (let i = 0; i < pos.length; i++) {
        const row = pos[i][0];
        const col = pos[i][1];
        for (let r = -1; r <= 7; r++) {
          if (row + r <= -1 || size <= row + r)
            continue;
          for (let c = -1; c <= 7; c++) {
            if (col + c <= -1 || size <= col + c)
              continue;
            if (r >= 0 && r <= 6 && (c === 0 || c === 6) || c >= 0 && c <= 6 && (r === 0 || r === 6) || r >= 2 && r <= 4 && c >= 2 && c <= 4) {
              matrix.set(row + r, col + c, true, true);
            } else {
              matrix.set(row + r, col + c, false, true);
            }
          }
        }
      }
    }
    function setupTimingPattern(matrix) {
      const size = matrix.size;
      for (let r = 8; r < size - 8; r++) {
        const value = r % 2 === 0;
        matrix.set(r, 6, value, true);
        matrix.set(6, r, value, true);
      }
    }
    function setupAlignmentPattern(matrix, version) {
      const pos = AlignmentPattern.getPositions(version);
      for (let i = 0; i < pos.length; i++) {
        const row = pos[i][0];
        const col = pos[i][1];
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            if (r === -2 || r === 2 || c === -2 || c === 2 || r === 0 && c === 0) {
              matrix.set(row + r, col + c, true, true);
            } else {
              matrix.set(row + r, col + c, false, true);
            }
          }
        }
      }
    }
    function setupVersionInfo(matrix, version) {
      const size = matrix.size;
      const bits = Version.getEncodedBits(version);
      let row, col, mod;
      for (let i = 0; i < 18; i++) {
        row = Math.floor(i / 3);
        col = i % 3 + size - 8 - 3;
        mod = (bits >> i & 1) === 1;
        matrix.set(row, col, mod, true);
        matrix.set(col, row, mod, true);
      }
    }
    function setupFormatInfo(matrix, errorCorrectionLevel, maskPattern) {
      const size = matrix.size;
      const bits = FormatInfo.getEncodedBits(errorCorrectionLevel, maskPattern);
      let i, mod;
      for (i = 0; i < 15; i++) {
        mod = (bits >> i & 1) === 1;
        if (i < 6) {
          matrix.set(i, 8, mod, true);
        } else if (i < 8) {
          matrix.set(i + 1, 8, mod, true);
        } else {
          matrix.set(size - 15 + i, 8, mod, true);
        }
        if (i < 8) {
          matrix.set(8, size - i - 1, mod, true);
        } else if (i < 9) {
          matrix.set(8, 15 - i - 1 + 1, mod, true);
        } else {
          matrix.set(8, 15 - i - 1, mod, true);
        }
      }
      matrix.set(size - 8, 8, 1, true);
    }
    function setupData(matrix, data) {
      const size = matrix.size;
      let inc = -1;
      let row = size - 1;
      let bitIndex = 7;
      let byteIndex = 0;
      for (let col = size - 1; col > 0; col -= 2) {
        if (col === 6)
          col--;
        while (true) {
          for (let c = 0; c < 2; c++) {
            if (!matrix.isReserved(row, col - c)) {
              let dark = false;
              if (byteIndex < data.length) {
                dark = (data[byteIndex] >>> bitIndex & 1) === 1;
              }
              matrix.set(row, col - c, dark);
              bitIndex--;
              if (bitIndex === -1) {
                byteIndex++;
                bitIndex = 7;
              }
            }
          }
          row += inc;
          if (row < 0 || size <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    }
    function createData(version, errorCorrectionLevel, segments) {
      const buffer = new BitBuffer();
      segments.forEach(function(data) {
        buffer.put(data.mode.bit, 4);
        buffer.put(data.getLength(), Mode.getCharCountIndicator(data.mode, version));
        data.write(buffer);
      });
      const totalCodewords = Utils.getSymbolTotalCodewords(version);
      const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
      const dataTotalCodewordsBits = (totalCodewords - ecTotalCodewords) * 8;
      if (buffer.getLengthInBits() + 4 <= dataTotalCodewordsBits) {
        buffer.put(0, 4);
      }
      while (buffer.getLengthInBits() % 8 !== 0) {
        buffer.putBit(0);
      }
      const remainingByte = (dataTotalCodewordsBits - buffer.getLengthInBits()) / 8;
      for (let i = 0; i < remainingByte; i++) {
        buffer.put(i % 2 ? 17 : 236, 8);
      }
      return createCodewords(buffer, version, errorCorrectionLevel);
    }
    function createCodewords(bitBuffer, version, errorCorrectionLevel) {
      const totalCodewords = Utils.getSymbolTotalCodewords(version);
      const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
      const dataTotalCodewords = totalCodewords - ecTotalCodewords;
      const ecTotalBlocks = ECCode.getBlocksCount(version, errorCorrectionLevel);
      const blocksInGroup2 = totalCodewords % ecTotalBlocks;
      const blocksInGroup1 = ecTotalBlocks - blocksInGroup2;
      const totalCodewordsInGroup1 = Math.floor(totalCodewords / ecTotalBlocks);
      const dataCodewordsInGroup1 = Math.floor(dataTotalCodewords / ecTotalBlocks);
      const dataCodewordsInGroup2 = dataCodewordsInGroup1 + 1;
      const ecCount = totalCodewordsInGroup1 - dataCodewordsInGroup1;
      const rs = new ReedSolomonEncoder(ecCount);
      let offset = 0;
      const dcData = new Array(ecTotalBlocks);
      const ecData = new Array(ecTotalBlocks);
      let maxDataSize = 0;
      const buffer = new Uint8Array(bitBuffer.buffer);
      for (let b = 0; b < ecTotalBlocks; b++) {
        const dataSize = b < blocksInGroup1 ? dataCodewordsInGroup1 : dataCodewordsInGroup2;
        dcData[b] = buffer.slice(offset, offset + dataSize);
        ecData[b] = rs.encode(dcData[b]);
        offset += dataSize;
        maxDataSize = Math.max(maxDataSize, dataSize);
      }
      const data = new Uint8Array(totalCodewords);
      let index = 0;
      let i, r;
      for (i = 0; i < maxDataSize; i++) {
        for (r = 0; r < ecTotalBlocks; r++) {
          if (i < dcData[r].length) {
            data[index++] = dcData[r][i];
          }
        }
      }
      for (i = 0; i < ecCount; i++) {
        for (r = 0; r < ecTotalBlocks; r++) {
          data[index++] = ecData[r][i];
        }
      }
      return data;
    }
    function createSymbol(data, version, errorCorrectionLevel, maskPattern) {
      let segments;
      if (Array.isArray(data)) {
        segments = Segments.fromArray(data);
      } else if (typeof data === "string") {
        let estimatedVersion = version;
        if (!estimatedVersion) {
          const rawSegments = Segments.rawSplit(data);
          estimatedVersion = Version.getBestVersionForData(rawSegments, errorCorrectionLevel);
        }
        segments = Segments.fromString(data, estimatedVersion || 40);
      } else {
        throw new Error("Invalid data");
      }
      const bestVersion = Version.getBestVersionForData(segments, errorCorrectionLevel);
      if (!bestVersion) {
        throw new Error("The amount of data is too big to be stored in a QR Code");
      }
      if (!version) {
        version = bestVersion;
      } else if (version < bestVersion) {
        throw new Error(`
The chosen QR Code version cannot contain this amount of data.
Minimum version required to store current data is: ` + bestVersion + `.
`);
      }
      const dataBits = createData(version, errorCorrectionLevel, segments);
      const moduleCount = Utils.getSymbolSize(version);
      const modules = new BitMatrix(moduleCount);
      setupFinderPattern(modules, version);
      setupTimingPattern(modules);
      setupAlignmentPattern(modules, version);
      setupFormatInfo(modules, errorCorrectionLevel, 0);
      if (version >= 7) {
        setupVersionInfo(modules, version);
      }
      setupData(modules, dataBits);
      if (isNaN(maskPattern)) {
        maskPattern = MaskPattern.getBestMask(modules, setupFormatInfo.bind(null, modules, errorCorrectionLevel));
      }
      MaskPattern.applyMask(maskPattern, modules);
      setupFormatInfo(modules, errorCorrectionLevel, maskPattern);
      return {
        modules,
        version,
        errorCorrectionLevel,
        maskPattern,
        segments
      };
    }
    exports.create = function create(data, options) {
      if (typeof data === "undefined" || data === "") {
        throw new Error("No input text");
      }
      let errorCorrectionLevel = ECLevel.M;
      let version;
      let mask;
      if (typeof options !== "undefined") {
        errorCorrectionLevel = ECLevel.from(options.errorCorrectionLevel, ECLevel.M);
        version = Version.from(options.version);
        mask = MaskPattern.from(options.maskPattern);
        if (options.toSJISFunc) {
          Utils.setToSJISFunction(options.toSJISFunc);
        }
      }
      return createSymbol(data, version, errorCorrectionLevel, mask);
    };
  });
  var require_utils2 = __commonJS((exports) => {
    function hex2rgba(hex) {
      if (typeof hex === "number") {
        hex = hex.toString();
      }
      if (typeof hex !== "string") {
        throw new Error("Color should be defined as hex string");
      }
      let hexCode = hex.slice().replace("#", "").split("");
      if (hexCode.length < 3 || hexCode.length === 5 || hexCode.length > 8) {
        throw new Error("Invalid hex color: " + hex);
      }
      if (hexCode.length === 3 || hexCode.length === 4) {
        hexCode = Array.prototype.concat.apply([], hexCode.map(function(c) {
          return [c, c];
        }));
      }
      if (hexCode.length === 6)
        hexCode.push("F", "F");
      const hexValue = parseInt(hexCode.join(""), 16);
      return {
        r: hexValue >> 24 & 255,
        g: hexValue >> 16 & 255,
        b: hexValue >> 8 & 255,
        a: hexValue & 255,
        hex: "#" + hexCode.slice(0, 6).join("")
      };
    }
    exports.getOptions = function getOptions(options) {
      if (!options)
        options = {};
      if (!options.color)
        options.color = {};
      const margin = typeof options.margin === "undefined" || options.margin === null || options.margin < 0 ? 4 : options.margin;
      const width = options.width && options.width >= 21 ? options.width : void 0;
      const scale = options.scale || 4;
      return {
        width,
        scale: width ? 4 : scale,
        margin,
        color: {
          dark: hex2rgba(options.color.dark || "#000000ff"),
          light: hex2rgba(options.color.light || "#ffffffff")
        },
        type: options.type,
        rendererOpts: options.rendererOpts || {}
      };
    };
    exports.getScale = function getScale(qrSize, opts) {
      return opts.width && opts.width >= qrSize + opts.margin * 2 ? opts.width / (qrSize + opts.margin * 2) : opts.scale;
    };
    exports.getImageWidth = function getImageWidth(qrSize, opts) {
      const scale = exports.getScale(qrSize, opts);
      return Math.floor((qrSize + opts.margin * 2) * scale);
    };
    exports.qrToImageData = function qrToImageData(imgData, qr, opts) {
      const size = qr.modules.size;
      const data = qr.modules.data;
      const scale = exports.getScale(size, opts);
      const symbolSize = Math.floor((size + opts.margin * 2) * scale);
      const scaledMargin = opts.margin * scale;
      const palette = [opts.color.light, opts.color.dark];
      for (let i = 0; i < symbolSize; i++) {
        for (let j = 0; j < symbolSize; j++) {
          let posDst = (i * symbolSize + j) * 4;
          let pxColor = opts.color.light;
          if (i >= scaledMargin && j >= scaledMargin && i < symbolSize - scaledMargin && j < symbolSize - scaledMargin) {
            const iSrc = Math.floor((i - scaledMargin) / scale);
            const jSrc = Math.floor((j - scaledMargin) / scale);
            pxColor = palette[data[iSrc * size + jSrc] ? 1 : 0];
          }
          imgData[posDst++] = pxColor.r;
          imgData[posDst++] = pxColor.g;
          imgData[posDst++] = pxColor.b;
          imgData[posDst] = pxColor.a;
        }
      }
    };
  });
  var require_canvas = __commonJS((exports) => {
    var Utils = require_utils2();
    function clearCanvas(ctx, canvas, size) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!canvas.style)
        canvas.style = {};
      canvas.height = size;
      canvas.width = size;
      canvas.style.height = size + "px";
      canvas.style.width = size + "px";
    }
    function getCanvasElement() {
      try {
        return document.createElement("canvas");
      } catch (e) {
        throw new Error("You need to specify a canvas element");
      }
    }
    exports.render = function render(qrData, canvas, options) {
      let opts = options;
      let canvasEl = canvas;
      if (typeof opts === "undefined" && (!canvas || !canvas.getContext)) {
        opts = canvas;
        canvas = void 0;
      }
      if (!canvas) {
        canvasEl = getCanvasElement();
      }
      opts = Utils.getOptions(opts);
      const size = Utils.getImageWidth(qrData.modules.size, opts);
      const ctx = canvasEl.getContext("2d");
      const image = ctx.createImageData(size, size);
      Utils.qrToImageData(image.data, qrData, opts);
      clearCanvas(ctx, canvasEl, size);
      ctx.putImageData(image, 0, 0);
      return canvasEl;
    };
    exports.renderToDataURL = function renderToDataURL(qrData, canvas, options) {
      let opts = options;
      if (typeof opts === "undefined" && (!canvas || !canvas.getContext)) {
        opts = canvas;
        canvas = void 0;
      }
      if (!opts)
        opts = {};
      const canvasEl = exports.render(qrData, canvas, opts);
      const type = opts.type || "image/png";
      const rendererOpts = opts.rendererOpts || {};
      return canvasEl.toDataURL(type, rendererOpts.quality);
    };
  });
  var require_svg_tag = __commonJS((exports) => {
    var Utils = require_utils2();
    function getColorAttrib(color, attrib) {
      const alpha = color.a / 255;
      const str = attrib + '="' + color.hex + '"';
      return alpha < 1 ? str + " " + attrib + '-opacity="' + alpha.toFixed(2).slice(1) + '"' : str;
    }
    function svgCmd(cmd, x, y) {
      let str = cmd + x;
      if (typeof y !== "undefined")
        str += " " + y;
      return str;
    }
    function qrToPath(data, size, margin) {
      let path = "";
      let moveBy = 0;
      let newRow = false;
      let lineLength = 0;
      for (let i = 0; i < data.length; i++) {
        const col = Math.floor(i % size);
        const row = Math.floor(i / size);
        if (!col && !newRow)
          newRow = true;
        if (data[i]) {
          lineLength++;
          if (!(i > 0 && col > 0 && data[i - 1])) {
            path += newRow ? svgCmd("M", col + margin, 0.5 + row + margin) : svgCmd("m", moveBy, 0);
            moveBy = 0;
            newRow = false;
          }
          if (!(col + 1 < size && data[i + 1])) {
            path += svgCmd("h", lineLength);
            lineLength = 0;
          }
        } else {
          moveBy++;
        }
      }
      return path;
    }
    exports.render = function render(qrData, options, cb) {
      const opts = Utils.getOptions(options);
      const size = qrData.modules.size;
      const data = qrData.modules.data;
      const qrcodesize = size + opts.margin * 2;
      const bg = !opts.color.light.a ? "" : "<path " + getColorAttrib(opts.color.light, "fill") + ' d="M0 0h' + qrcodesize + "v" + qrcodesize + 'H0z"/>';
      const path = "<path " + getColorAttrib(opts.color.dark, "stroke") + ' d="' + qrToPath(data, size, opts.margin) + '"/>';
      const viewBox = 'viewBox="0 0 ' + qrcodesize + " " + qrcodesize + '"';
      const width = !opts.width ? "" : 'width="' + opts.width + '" height="' + opts.width + '" ';
      const svgTag = '<svg xmlns="http://www.w3.org/2000/svg" ' + width + viewBox + ' shape-rendering="crispEdges">' + bg + path + `</svg>
`;
      if (typeof cb === "function") {
        cb(null, svgTag);
      }
      return svgTag;
    };
  });
  var require_browser = __commonJS((exports) => {
    var canPromise = require_can_promise();
    var QRCode = require_qrcode();
    var CanvasRenderer = require_canvas();
    var SvgRenderer = require_svg_tag();
    function renderCanvas(renderFunc, canvas, text, opts, cb) {
      const args = [].slice.call(arguments, 1);
      const argsNum = args.length;
      const isLastArgCb = typeof args[argsNum - 1] === "function";
      if (!isLastArgCb && !canPromise()) {
        throw new Error("Callback required as last argument");
      }
      if (isLastArgCb) {
        if (argsNum < 2) {
          throw new Error("Too few arguments provided");
        }
        if (argsNum === 2) {
          cb = text;
          text = canvas;
          canvas = opts = void 0;
        } else if (argsNum === 3) {
          if (canvas.getContext && typeof cb === "undefined") {
            cb = opts;
            opts = void 0;
          } else {
            cb = opts;
            opts = text;
            text = canvas;
            canvas = void 0;
          }
        }
      } else {
        if (argsNum < 1) {
          throw new Error("Too few arguments provided");
        }
        if (argsNum === 1) {
          text = canvas;
          canvas = opts = void 0;
        } else if (argsNum === 2 && !canvas.getContext) {
          opts = text;
          text = canvas;
          canvas = void 0;
        }
        return new Promise(function(resolve, reject) {
          try {
            const data = QRCode.create(text, opts);
            resolve(renderFunc(data, canvas, opts));
          } catch (e) {
            reject(e);
          }
        });
      }
      try {
        const data = QRCode.create(text, opts);
        cb(null, renderFunc(data, canvas, opts));
      } catch (e) {
        cb(e);
      }
    }
    exports.create = QRCode.create;
    exports.toCanvas = renderCanvas.bind(null, CanvasRenderer.render);
    exports.toDataURL = renderCanvas.bind(null, CanvasRenderer.renderToDataURL);
    exports.toString = renderCanvas.bind(null, function(data, _, opts) {
      return SvgRenderer.render(data, opts);
    });
  });
  var import_qrcode = __toESM(require_browser(), 1);
  var RequestTimeoutError = class extends Error {
    constructor(timeout) {
      super(`Request timed out after ${timeout}ms.`);
    }
  };
  var PopupClosedError = class extends Error {
    constructor() {
      super("Wallet popup was closed before the request completed.");
    }
  };
  var RejectRequestError = class extends Error {
    code;
    constructor(message, code) {
      super(message || "Request was rejected by the wallet.");
      this.code = code;
    }
  };
  var UnauthorizedError = class extends Error {
    code;
    constructor(code) {
      super(code || "Unauthorized");
      this.code = code;
    }
  };
  var PaymentRequiredError = class extends Error {
    code;
    trackingId;
    gasAmount;
    status;
    expiresAt;
    constructor(details) {
      super(details?.message || "Payment required");
      this.code = details?.code;
      this.trackingId = details?.tracking_id;
      this.gasAmount = details?.gas_amount;
      this.status = details?.status;
      this.expiresAt = details?.expires_at;
    }
  };
  var UNAUTH_CODES = /* @__PURE__ */ new Set(["UNAUTHENTICATED", "UNAUTHORIZED", "SESSION_EXPIRED", "LOGGED_OUT"]);
  function extractErrorCode(message) {
    if (typeof message?.error?.code === "string" && message.error.code.length > 0) {
      return message.error.code;
    }
    if (message?.type === "unauthorized" && typeof message?.code === "string") {
      return message.code;
    }
    return null;
  }
  function isUnauthCode(code) {
    if (!code) {
      return false;
    }
    return UNAUTH_CODES.has(code);
  }
  var MessageType;
  ((MessageType2) => {
    MessageType2["HANDSHAKE_ACCEPT"] = "handshake_accept";
    MessageType2["HANDSHAKE_REJECT"] = "handshake_reject";
    MessageType2["TICKET_REVOKED"] = "ticket_revoked";
    MessageType2["RUN_TRANSACTION"] = "run_transaction";
    MessageType2["TRANSACTION_COMPLETED"] = "transaction_completed";
    MessageType2["SIGN_RAW_MESSAGE"] = "sign_raw_message";
    MessageType2["SIGN_RAW_MESSAGE_RESPONSE"] = "sign_raw_message_response";
    MessageType2["REJECT_REQUEST"] = "reject_request";
  })(MessageType ||= {});
  var DEFAULT_REQUEST_TIMEOUT_MS = 3e5;
  function generateUUID() {
    return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => {
      const gCrypto = globalThis.crypto;
      if (!gCrypto?.getRandomValues) {
        const n2 = Number(c);
        return (n2 ^ Math.random() * 16 >> n2 / 4).toString(16);
      }
      const arr = gCrypto.getRandomValues(new Uint8Array(1));
      const byte = arr[0];
      const n = Number(c);
      return (n ^ (byte & 15) >> n / 4).toString(16);
    });
  }
  function generateRequestId() {
    const gCrypto = globalThis.crypto;
    if (gCrypto?.randomUUID) {
      return gCrypto.randomUUID();
    }
    return generateUUID();
  }
  var Provider = class {
    connection;
    party_id;
    public_key;
    email;
    auth_token;
    requests = /* @__PURE__ */ new Map();
    requestTimeout = DEFAULT_REQUEST_TIMEOUT_MS;
    hooks;
    constructor({ connection, party_id, public_key, auth_token, email, hooks }) {
      if (!connection) {
        throw new Error("Provider requires a connection object.");
      }
      this.connection = connection;
      this.party_id = party_id;
      this.public_key = public_key;
      this.email = email;
      this.auth_token = auth_token;
      this.hooks = hooks;
    }
    getAuthToken() {
      return this.auth_token;
    }
    handleResponse(message) {
      console.log("Received response:", message);
      if (message?.type === "transaction_completed" && (message?.payload?.update_id || message?.payload?.update_data || message?.payload?.status)) {
        if (message?.payload?.error_message) {
          message.payload.error = { error_message: message.payload.error_message };
          delete message.payload.error_message;
        }
        this.hooks?.onTransactionUpdate?.(message.payload, message);
      }
      if (message.request_id) {
        this.requests.set(message.request_id, message);
      }
    }
    rejectPendingRequests(code, message) {
      for (const requestId of this.requests.keys()) {
        this.requests.set(requestId, {
          request_id: requestId,
          type: "reject_request",
          payload: {
            code,
            message
          }
        });
      }
    }
    getHolding() {
      return this.connection.getHolding(this.auth_token);
    }
    getAccount() {
      return this.connection.verifySession(this.auth_token);
    }
    getActiveContracts(params) {
      return this.connection.getActiveContracts(this.auth_token, params);
    }
    async estimateGas(payload) {
      return this.connection.estimateGasForConnect(this.auth_token, payload);
    }
    async submitTransaction(payload, options) {
      const requestPayload = {
        ...payload,
        ...options?.deduplicationPeriod ? { deduplicationPeriod: toLedgerDeduplicationPeriod(options.deduplicationPeriod) } : {}
      };
      const requestPayloadWithTraffic = options?.estimateTraffic ? { ...requestPayload, estimate_traffic: true } : requestPayload;
      const executionMode = options?.executionMode;
      const finalPayload = executionMode === "wait" ? { ...requestPayloadWithTraffic, execution_mode: "wait" } : requestPayloadWithTraffic;
      return this.sendRequest("run_transaction", finalPayload, options);
    }
    async submitAndWaitForTransaction(payload, options) {
      const requestPayload = {
        ...payload,
        ...options?.deduplicationPeriod ? { deduplicationPeriod: toLedgerDeduplicationPeriod(options.deduplicationPeriod) } : {}
      };
      const requestPayloadWithTraffic = options?.estimateTraffic ? { ...requestPayload, estimate_traffic: true } : requestPayload;
      return this.sendRequest("run_transaction", { ...requestPayloadWithTraffic, execution_mode: "wait" }, options);
    }
    async transfer(recipient, amount, instrument, options) {
      const amountStr = typeof amount === "number" ? amount.toString() : amount;
      const { requestedAt, executeBefore, requestTimeout, estimateTraffic, memo } = options || {};
      const message = options?.message;
      const resolveDate = (value, fallbackMs) => {
        if (value instanceof Date) {
          return value.toISOString();
        }
        if (typeof value === "string" && value.length > 0) {
          return value;
        }
        if (fallbackMs) {
          return new Date(Date.now() + fallbackMs).toISOString();
        }
        return (/* @__PURE__ */ new Date()).toISOString();
      };
      const requestedAtIso = resolveDate(requestedAt);
      const executeBeforeIso = resolveDate(executeBefore, 24 * 60 * 60 * 1e3);
      const transferRequest = {
        recipient,
        amount: amountStr,
        instrument: {
          instrument_admin: instrument?.instrument_admin,
          instrument_id: instrument?.instrument_id || "Amulet"
        },
        requested_at: requestedAtIso,
        execute_before: executeBeforeIso
      };
      if (memo) {
        transferRequest.memo = memo;
      }
      const preparedPayload = await this.connection.prepareTransfer(this.auth_token, transferRequest);
      const submitFn = options?.executionMode === "wait" ? this.submitAndWaitForTransaction.bind(this) : this.submitTransaction.bind(this);
      return submitFn({
        commands: preparedPayload.commands,
        disclosedContracts: preparedPayload.disclosedContracts,
        packageIdSelectionPreference: preparedPayload.packageIdSelectionPreference,
        actAs: preparedPayload.actAs,
        readAs: preparedPayload.readAs,
        synchronizerId: preparedPayload.synchronizerId
      }, {
        requestTimeout,
        message,
        estimateTraffic,
        deduplicationPeriod: options?.deduplicationPeriod
      });
    }
    async signMessage(message) {
      return this.sendRequest("sign_raw_message", message);
    }
    async ensureConnected() {
      if (this.connection.ws && this.connection.ws.readyState === WebSocket.OPEN) {
        return Promise.resolve();
      }
      try {
        await this.connection.reconnect();
      } catch (error) {
        this.hooks?.onSessionInvalid?.();
        throw error;
      }
      if (this.connection.ws && this.connection.ws.readyState === WebSocket.OPEN) {
        return;
      }
      throw new Error("Not connected.");
    }
    sendRequest(messageType, params = {}, options) {
      return new Promise((resolve, reject) => {
        const requestId = generateRequestId();
        let requestContext;
        const ensure = async () => {
          try {
            await this.ensureConnected();
            requestContext = await this.hooks?.onRequestStart?.(messageType, options?.requestLabel);
          } catch (error) {
            console.error("[LoopSDK] error when checking connection status", error);
            this.hooks?.onRequestFinish?.({
              status: "error",
              messageType,
              requestLabel: options?.requestLabel,
              requestContext
            });
            reject(error);
            return;
          }
          const requestBody = {
            request_id: requestId,
            type: messageType,
            payload: params
          };
          if (options?.message) {
            requestBody.ticket = { message: options.message };
            if (typeof params === "object" && params !== null && !Array.isArray(params)) {
              requestBody.payload = {
                ...params,
                ticket: { message: options.message }
              };
            }
          }
          try {
            this.connection.ws.send(JSON.stringify(requestBody));
          } catch (error) {
            console.error("[LoopSDK] error when sending request", error);
            reject(error);
            return;
          }
          this.requests.set(requestId, null);
          const intervalTime = 300;
          let elapsedTime = 0;
          const timeoutMs = options?.requestTimeout ?? this.requestTimeout;
          const intervalId = setInterval(() => {
            const response = this.requests.get(requestId);
            if (response) {
              clearInterval(intervalId);
              this.requests.delete(requestId);
              const code = extractErrorCode(response);
              if (isUnauthCode(code)) {
                this.hooks?.onRequestFinish?.({
                  status: "error",
                  messageType,
                  requestLabel: options?.requestLabel,
                  requestContext,
                  errorCode: code
                });
                reject(new UnauthorizedError(code));
                return;
              }
              if (response.type === "reject_request") {
                const rejectMessage = response?.payload?.message;
                const rejectCode = response?.payload?.code;
                this.hooks?.onRequestFinish?.({
                  status: "rejected",
                  messageType,
                  requestLabel: options?.requestLabel,
                  requestContext
                });
                reject(new RejectRequestError(rejectMessage, rejectCode));
              } else {
                this.hooks?.onRequestFinish?.({
                  status: "success",
                  messageType,
                  requestLabel: options?.requestLabel,
                  requestContext
                });
                resolve(response.payload);
              }
            } else {
              if (isClosedWindow(requestContext)) {
                clearInterval(intervalId);
                this.requests.delete(requestId);
                this.rejectPendingRequest(requestId, "POPUP_CLOSED", "Wallet popup was closed before the request completed.");
                this.hooks?.onRequestFinish?.({
                  status: "error",
                  messageType,
                  requestLabel: options?.requestLabel,
                  requestContext,
                  errorCode: "POPUP_CLOSED"
                });
                reject(new PopupClosedError());
                return;
              }
              elapsedTime += intervalTime;
              if (elapsedTime >= timeoutMs) {
                clearInterval(intervalId);
                this.requests.delete(requestId);
                this.hooks?.onRequestFinish?.({
                  status: "timeout",
                  messageType,
                  requestLabel: options?.requestLabel,
                  requestContext
                });
                reject(new RequestTimeoutError(timeoutMs));
              }
            }
          }, intervalTime);
        };
        ensure();
      });
    }
    rejectPendingRequest(requestId, code, message) {
      if (!this.connection.ws || this.connection.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        this.connection.ws.send(JSON.stringify({
          request_id: requestId,
          type: "reject_request",
          payload: {
            code,
            message
          }
        }));
      } catch (error) {
        console.warn("[LoopSDK] failed to reject pending request", error);
      }
    }
  };
  function isClosedWindow(value) {
    if (!value || typeof value !== "object") {
      return false;
    }
    return "closed" in value && value.closed === true;
  }
  function toLedgerDeduplicationPeriod(input) {
    if ("empty" in input) {
      return { Empty: {} };
    }
    return {
      DeduplicationDuration: {
        value: {
          seconds: input.seconds,
          nanos: input.nanos ?? 0
        }
      }
    };
  }
  var Connection = class {
    walletUrl = "https://cantonloop.com";
    apiUrl = "https://cantonloop.com";
    ws = null;
    network = "main";
    ticketId = null;
    ticketAuthToken = null;
    onMessageHandler = null;
    reconnectPromise = null;
    status = "disconnected";
    constructor({ network, walletUrl, apiUrl }) {
      this.network = network || "main";
      switch (this.network) {
        case "local":
          this.walletUrl = "http://localhost:3000";
          this.apiUrl = "http://localhost:8080";
          break;
        case "devnet":
        case "dev":
          this.walletUrl = "https://devnet.cantonloop.com";
          this.apiUrl = "https://devnet.cantonloop.com";
          break;
        case "testnet":
        case "test":
          this.walletUrl = "https://testnet.cantonloop.com";
          this.apiUrl = "https://testnet.cantonloop.com";
          break;
        case "mainnet":
        case "main":
          this.walletUrl = "https://cantonloop.com";
          this.apiUrl = "https://cantonloop.com";
          break;
      }
      if (walletUrl) {
        this.walletUrl = walletUrl;
      }
      if (apiUrl) {
        this.apiUrl = apiUrl;
      }
    }
    connectInProgress() {
      return this.status === "connecting" || this.status === "connected";
    }
    async getTicket(appName, sessionId, version) {
      const response = await fetch(`${this.apiUrl}/api/v1/.connect/pair/tickets`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          app_name: appName,
          session_id: sessionId,
          version
        })
      });
      if (!response.ok) {
        throw new Error("Failed to get ticket from server.");
      }
      return response.json();
    }
    async disconnect(ticketId, authToken) {
      const response = await fetch(`${this.apiUrl}/api/v1/.connect/tickets/${encodeURIComponent(ticketId)}/disconnect`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`
        }
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`Failed to disconnect ticket with status ${response.status}.`);
      }
    }
    async getHolding(authToken) {
      const response = await fetch(`${this.apiUrl}/api/v1/.connect/pair/account/holding`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`
        }
      });
      if (!response.ok) {
        throw new Error("Failed to get holdings. " + await response.text());
      }
      return response.json();
    }
    async getActiveContracts(authToken, params) {
      const url = new URL(`${this.apiUrl}/api/v1/.connect/pair/account/active-contracts`);
      if (params?.templateId) {
        url.searchParams.append("templateId", params.templateId);
      }
      if (params?.interfaceId) {
        url.searchParams.append("interfaceId", params.interfaceId);
      }
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`
        }
      });
      if (!response.ok) {
        throw new Error("Failed to get active contracts.");
      }
      return response.json();
    }
    async prepareTransfer(authToken, params) {
      const payload = {
        recipient: params.recipient,
        amount: params.amount
      };
      if (params.instrument) {
        if (params.instrument.instrument_admin) {
          payload.instrument_admin = params.instrument.instrument_admin;
        }
        if (params.instrument.instrument_id) {
          payload.instrument_id = params.instrument.instrument_id;
        }
      }
      if (params.requested_at) {
        payload.requested_at = params.requested_at;
      }
      if (params.execute_before) {
        payload.execute_before = params.execute_before;
      }
      if (params.memo) {
        payload.memo = params.memo;
      }
      const response = await fetch(`${this.apiUrl}/api/v1/.connect/pair/transfer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        console.error("Failed to prepare transfer.", await response.text());
        throw new Error("Failed to prepare transfer.");
      }
      const data = await response.json();
      return data.payload;
    }
    async verifySession(authToken) {
      const response = await fetch(`${this.apiUrl}/api/v1/.connect/pair/account`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`
        }
      });
      if (!response.ok) {
        if ([400, 401, 403, 404].includes(response.status)) {
          throw new UnauthorizedError(`Session verification failed with status ${response.status}.`);
        }
        throw new Error(`Session verification failed with status ${response.status}.`);
      }
      const data = await response.json();
      const email = data?.email;
      if (!data?.party_id || !data?.public_key) {
        throw new Error("Invalid session verification response.");
      }
      const account = {
        party_id: data?.party_id,
        auth_token: authToken,
        public_key: data?.public_key,
        email,
        has_preapproval: data?.has_preapproval,
        utility_preapproval_admins: Array.isArray(data?.utility_preapproval_admins) ? data.utility_preapproval_admins : [],
        has_merge_delegation: data?.has_merge_delegation,
        usdc_bridge_access: data?.usdc_bridge_access
      };
      return account;
    }
    connectWebSocket(ticketId, ticketAuthToken, onMessage) {
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) && this.ticketId !== ticketId) {
        this.ws.close();
        this.ws = null;
        this.status = "disconnected";
      }
      if (this.status === "connecting" || this.status === "connected") {
        return;
      }
      this.onMessageHandler = onMessage;
      this.ticketId = ticketId;
      this.ticketAuthToken = ticketAuthToken;
      this.status = "connecting";
      this.attachWebSocket(ticketId, ticketAuthToken, onMessage);
    }
    reconnect() {
      if (!this.ticketId || !this.ticketAuthToken || !this.onMessageHandler) {
        return Promise.reject(new Error("Cannot reconnect without a known ticket."));
      }
      return new Promise((resolve, reject) => {
        let opened = false;
        this.attachWebSocket(this.ticketId, this.ticketAuthToken, this.onMessageHandler, () => {
          opened = true;
          resolve();
        }, () => {
          if (opened) {
            return;
          }
          reject(new Error("Failed to reconnect to ticket server."));
        }, () => {
          if (opened) {
            return;
          }
          reject(new Error("Failed to reconnect to ticket server."));
        });
      });
    }
    async exchangeApiKey({ publicKey, signature, epoch }) {
      const response = await fetch(`${this.apiUrl}/api/v1/.connect/pair/apikey`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          public_key: publicKey,
          signature,
          epoch
        })
      });
      if (!response.ok) {
        throw new Error("Failed to get API key from server.");
      }
      return response.json();
    }
    async parseErrorResponse(response) {
      const text = await response.text();
      if (!text) {
        return null;
      }
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    errorMessage(details, fallback) {
      if (typeof details === "string" && details.length > 0) {
        return details;
      }
      if (typeof details?.message === "string" && details.message.length > 0) {
        return details.message;
      }
      return fallback;
    }
    async prepareTransaction(session, params) {
      const response = await fetch(`${this.apiUrl}/api/v1/.connect/tickets/prepare-transaction`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.userApiKey}`
        },
        body: JSON.stringify({
          payload: params,
          ticket_id: session.ticketId
        })
      });
      if (response.status === 402) {
        throw new PaymentRequiredError(await this.parseErrorResponse(response));
      }
      if (!response.ok) {
        const details = await this.parseErrorResponse(response);
        throw new Error(this.errorMessage(details, `Failed to prepare transaction with status ${response.status}.`));
      }
      return response.json();
    }
    async estimateGas(session, params) {
      const response = await fetch(`${this.apiUrl}/api/v1/.connect/tickets/estimate-gas`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.userApiKey}`
        },
        body: JSON.stringify({
          ticket_id: session.ticketId,
          request_id: generateRequestId(),
          payload: {
            commands: params.commands,
            disclosedContracts: params.disclosedContracts,
            packageIdSelectionPreference: params.packageIdSelectionPreference,
            actAs: params.actAs,
            readAs: params.readAs,
            synchronizerId: params.synchronizerId
          }
        })
      });
      if (!response.ok) {
        const details = await this.parseErrorResponse(response);
        throw new Error(this.errorMessage(details, `Failed to estimate gas with status ${response.status}.`));
      }
      const data = await response.json();
      return {
        requires_gas: data?.requiresFee,
        can_execute: data?.canExecute,
        estimated_gas_amount: data?.estimatedFeeAmount,
        estimated_gas_asset: data?.estimatedFeeAsset
      };
    }
    async estimateGasForConnect(authToken, params) {
      const response = await fetch(`${this.apiUrl}/api/v1/.connect/tickets/transaction/estimate-gas`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          request_id: generateRequestId(),
          tx: {
            commands: params.commands,
            disclosedContracts: params.disclosedContracts,
            packageIdSelectionPreference: params.packageIdSelectionPreference,
            actAs: params.actAs,
            readAs: params.readAs,
            synchronizerId: params.synchronizerId
          }
        })
      });
      if (!response.ok) {
        const details = await this.parseErrorResponse(response);
        throw new Error(this.errorMessage(details, `Failed to estimate gas with status ${response.status}.`));
      }
      const data = await response.json();
      return {
        requires_gas: data?.requiresFee,
        can_execute: data?.canExecute,
        estimated_gas_amount: data?.estimatedFeeAmount,
        estimated_gas_asset: data?.estimatedFeeAsset
      };
    }
    async executeTransaction(session, params) {
      if (!session.ticketId) {
        throw new Error("Ticket ID is required");
      }
      const response = await fetch(`${this.apiUrl}/api/v1/.connect/tickets/execute-transaction`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.userApiKey}`
        },
        body: JSON.stringify({
          ticket_id: session.ticketId,
          request_id: generateRequestId(),
          command_id: params.command_id,
          signature: params.signature,
          transaction_data: params.transaction_data,
          deduplication_period: params.deduplication_period
        })
      });
      if (response.status === 402) {
        throw new PaymentRequiredError(await this.parseErrorResponse(response));
      }
      if (!response.ok) {
        const details = await this.parseErrorResponse(response);
        throw new Error(this.errorMessage(details, `Failed to execute transaction with status ${response.status}.`));
      }
      return response.json();
    }
    async getPendingGas(userApiKey, trackingId) {
      const url = new URL(`${this.apiUrl}/api/v1/transfer/pending-fee`);
      if (trackingId) {
        url.searchParams.set("tracking_id", trackingId);
      }
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userApiKey}`
        }
      });
      if (!response.ok) {
        const details = await this.parseErrorResponse(response);
        throw new Error(this.errorMessage(details, "Failed to get pending gas."));
      }
      return await response.json();
    }
    async preparePendingGas(userApiKey, trackingId) {
      const response = await fetch(`${this.apiUrl}/api/v1/transfer/pending-fee/prepare`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userApiKey}`
        },
        body: JSON.stringify(trackingId ? { tracking_id: trackingId } : {})
      });
      if (!response.ok) {
        const details = await this.parseErrorResponse(response);
        throw new Error(this.errorMessage(details, "Failed to prepare pending gas."));
      }
      return response.json();
    }
    async executePendingGas(userApiKey, params) {
      const response = await fetch(`${this.apiUrl}/api/v1/transfer/pending-fee/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userApiKey}`
        },
        body: JSON.stringify(params)
      });
      if (!response.ok) {
        const details = await this.parseErrorResponse(response);
        throw new Error(this.errorMessage(details, "Failed to execute pending gas."));
      }
      return response.json();
    }
    websocketUrl(ticketId) {
      return `${this.network === "local" ? "ws" : "wss"}://${this.apiUrl.replace("https://", "").replace("http://", "")}/api/v1/.connect/pair/ws/${encodeURIComponent(ticketId)}`;
    }
    websocketProtocols(ticketAuthToken) {
      return ["loop-connect", `loop-ticket-auth.${ticketAuthToken}`];
    }
    attachWebSocket(ticketId, ticketAuthToken, onMessage, onOpen, onError, onClose) {
      const wsUrl = this.websocketUrl(ticketId);
      const ws = new WebSocket(wsUrl, this.websocketProtocols(ticketAuthToken));
      ws.onmessage = onMessage;
      ws.onopen = () => {
        this.status = "connected";
        console.log("[LoopSDK] Connected to ticket server.");
        onOpen?.();
      };
      ws.onclose = (event) => {
        if (this.ws === ws) {
          this.status = "disconnected";
          this.ws = null;
        }
        console.log("[LoopSDK] Disconnected from ticket server.");
        onClose?.(event);
      };
      ws.onerror = (event) => {
        ws.close();
        if (this.ws === ws) {
          this.status = "disconnected";
          this.ws = null;
        }
        onError?.(event);
      };
      this.ws = ws;
    }
  };
  var STORAGE_KEY_LOOP_CONNECT = "loop_connect";
  var SessionInfo = class _SessionInfo {
    sessionId;
    ticketId;
    ticketAuthToken;
    authToken;
    partyId;
    publicKey;
    email;
    userApiKey;
    _isAuthorized = false;
    constructor({ sessionId, ticketId, ticketAuthToken, authToken, partyId, publicKey, email, userApiKey }) {
      this.sessionId = sessionId;
      this.ticketId = ticketId;
      this.ticketAuthToken = ticketAuthToken;
      this.authToken = authToken;
      this.partyId = partyId;
      this.publicKey = publicKey;
      this.email = email;
      this.userApiKey = userApiKey;
    }
    setTicketId(ticketId, ticketAuthToken) {
      this.ticketId = ticketId;
      this.ticketAuthToken = ticketAuthToken;
      this.save();
    }
    clearTicket() {
      this.ticketId = void 0;
      this.ticketAuthToken = void 0;
      this.save();
    }
    authorized() {
      if (this.ticketId === void 0 || this.sessionId === void 0 || this.authToken === void 0 || this.partyId === void 0 || this.publicKey === void 0) {
        throw new Error("Session cannot be authorized without all required fields.");
      }
      this._isAuthorized = true;
    }
    isPreAuthorized() {
      return !this._isAuthorized && this.ticketId !== void 0 && this.sessionId !== void 0 && this.authToken !== void 0 && this.partyId !== void 0 && this.publicKey !== void 0;
    }
    isAuthorized() {
      return this._isAuthorized;
    }
    save() {
      localStorage.setItem("loop_connect", this.toJson());
    }
    reset() {
      localStorage.removeItem(STORAGE_KEY_LOOP_CONNECT);
      this.sessionId = generateRequestId();
      this._isAuthorized = false;
      this.ticketId = void 0;
      this.ticketAuthToken = void 0;
      this.authToken = void 0;
      this.partyId = void 0;
      this.publicKey = void 0;
      this.email = void 0;
    }
    static fromStorage() {
      const existingConnectionRaw = localStorage.getItem(STORAGE_KEY_LOOP_CONNECT);
      if (!existingConnectionRaw) {
        return new _SessionInfo({ sessionId: generateRequestId() });
      }
      let session = null;
      try {
        session = new _SessionInfo(JSON.parse(existingConnectionRaw));
      } catch (error) {
        console.error("Failed to parse existing connection info, local storage is corrupted.", error);
        localStorage.removeItem(STORAGE_KEY_LOOP_CONNECT);
        session = new _SessionInfo({ sessionId: generateRequestId() });
      }
      return session;
    }
    toJson() {
      return JSON.stringify({
        sessionId: this.sessionId,
        ticketId: this.ticketId,
        ticketAuthToken: this.ticketAuthToken,
        authToken: this.authToken,
        partyId: this.partyId,
        publicKey: this.publicKey,
        email: this.email
      });
    }
  };
  var UsdcBridge = class {
    getProvider;
    constructor(getProvider) {
      this.getProvider = getProvider;
    }
    requireProvider() {
      const provider = this.getProvider();
      if (!provider) {
        throw new Error("SDK not connected. Call connect() and wait for acceptance first.");
      }
      return provider;
    }
    withdrawalUSDCxToEthereum(recipient, amount, options) {
      const provider = this.requireProvider();
      const amountStr = typeof amount === "number" ? amount.toString() : amount;
      const withdrawRequest = {
        recipient,
        amount: amountStr,
        reference: options?.reference
      };
      return prepareUsdcWithdraw(provider.connection, provider.getAuthToken(), withdrawRequest).then((preparedPayload) => provider.submitTransaction({
        commands: preparedPayload.commands,
        disclosedContracts: preparedPayload.disclosedContracts,
        packageIdSelectionPreference: preparedPayload.packageIdSelectionPreference,
        actAs: preparedPayload.actAs,
        readAs: preparedPayload.readAs,
        synchronizerId: preparedPayload.synchronizerId
      }, { requestTimeout: options?.requestTimeout, message: options?.message }));
    }
  };
  async function prepareUsdcWithdraw(connection, authToken, params) {
    const payload = {
      recipient: params.recipient,
      amount: params.amount
    };
    if (params.reference) {
      payload.reference = params.reference;
    }
    const response = await fetch(`${connection.apiUrl}/api/v1/.connect/pair/usdc/withdraw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      throw new Error("Failed to prepare USDC withdrawal.");
    }
    const data = await response.json();
    return data.payload;
  }
  var LoopWallet = class {
    getProvider;
    extension;
    constructor(getProvider) {
      this.getProvider = getProvider;
      this.extension = {
        usdcBridge: new UsdcBridge(this.getProvider)
      };
    }
    requireProvider() {
      const provider = this.getProvider();
      if (!provider) {
        throw new Error("SDK not connected. Call connect() and wait for acceptance first.");
      }
      return provider;
    }
    transfer(recipient, amount, instrument, options) {
      const provider = this.requireProvider();
      return provider.transfer(recipient, amount, instrument, options);
    }
  };
  var LoopSDK = class {
    version = "0.13.4";
    appName = "Unknown";
    connection = null;
    session = null;
    provider = null;
    openMode = "popup";
    requestSigningMode = "popup";
    popupWindow = null;
    redirectUrl;
    onAccept = null;
    onReject = null;
    onTransactionUpdate = null;
    overlay = null;
    wallet;
    constructor() {
      this.wallet = new LoopWallet(() => this.provider);
    }
    init({
      appName,
      network,
      walletUrl,
      apiUrl,
      onAccept,
      onReject,
      onTransactionUpdate,
      options
    }) {
      if (typeof window === "undefined" || typeof document === "undefined" || typeof localStorage === "undefined") {
        throw new Error("LoopSDK can only be initialized in a browser environment with localStorage support.");
      }
      this.appName = appName;
      this.onAccept = onAccept || null;
      this.onReject = onReject || null;
      this.onTransactionUpdate = onTransactionUpdate || null;
      const resolvedOptions = {
        openMode: "popup",
        requestSigningMode: "popup",
        redirectUrl: void 0,
        ...options ?? {}
      };
      this.openMode = resolvedOptions.openMode;
      this.requestSigningMode = resolvedOptions.requestSigningMode;
      this.redirectUrl = resolvedOptions.redirectUrl;
      this.connection = new Connection({ network, walletUrl, apiUrl });
    }
    async loadSessionInfo() {
      if (this.session) {
        return;
      }
      this.session = SessionInfo.fromStorage();
      if (!this.session.isPreAuthorized()) {
        return;
      }
      try {
        const verifiedAccount = await this.connection?.verifySession(this.session.authToken);
        if (!verifiedAccount || verifiedAccount?.party_id !== this.session.partyId) {
          console.warn("[LoopSDK] Stored partyId does not match verified account. Clearing cached session.");
          this.logout();
          return;
        }
        this.session.authorized();
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          console.error("Unauthorized error when verifying session.", err);
          this.session.reset();
          return;
        }
        console.error("[LoopSDK] Failed to verify session.", err);
        throw err;
      }
    }
    async autoConnect() {
      if (!this.connection) {
        throw new Error("SDK not initialized. Call init() first.");
      }
      await this.loadSessionInfo();
      if (!this.session) {
        throw new Error("No valid session found. The network connection maynot available or the backend is not reachable.");
      }
      if (this.session.isAuthorized()) {
        if (!this.session.ticketAuthToken) {
          console.warn("[LoopSDK] Stored session is missing ticket auth. Reconnect required.");
          this.logout();
          return Promise.resolve();
        }
        this.provider = new Provider({
          connection: this.connection,
          party_id: this.session.partyId,
          auth_token: this.session.authToken,
          public_key: this.session.publicKey,
          email: this.session.email,
          hooks: this.createProviderHooks()
        });
        this.onAccept?.(this.provider);
        this.connection.connectWebSocket(this.session.ticketId, this.session.ticketAuthToken, this.handleWebSocketMessage.bind(this));
        return Promise.resolve();
      }
    }
    async connect() {
      if (!this.connection) {
        throw new Error("SDK not initialized. Call init() first.");
      }
      await this.autoConnect();
      if (!this.session) {
        throw new Error("No valid session found. The network connection maynot available or the backend is not reachable.");
      }
      if (this.session.isAuthorized()) {
        return;
      }
      try {
        this.session.clearTicket();
        if (!this.session.ticketId) {
          if (!this.session.sessionId) {
            throw new Error("Session ID is required to create a connect ticket.");
          }
          const { ticket_id: ticketId, auth_token: ticketAuthToken } = await this.connection.getTicket(this.appName, this.session.sessionId, this.version);
          this.session.setTicketId(ticketId, ticketAuthToken);
        }
        if (!this.connection.connectInProgress()) {
          this.connection.connectWebSocket(this.session.ticketId, this.session.ticketAuthToken, this.handleWebSocketMessage.bind(this));
        }
        this.showQrCode(this.buildConnectUrl(this.session.ticketId));
      } catch (error) {
        console.error(error);
        throw error;
      }
    }
    handleWebSocketMessage(event) {
      const message = JSON.parse(event.data);
      const errCode = extractErrorCode(message);
      if (isUnauthCode(errCode)) {
        console.warn("[LoopSDK] Detected session invalidation:", errCode, {
          message
        });
        this.logout();
        return;
      }
      console.log("[LoopSDK] WS message received:", message);
      if (message.type === "handshake_accept") {
        console.log("[LoopSDK] Entering HANDSHAKE_ACCEPT flow");
        const { partyId, publicKey, email } = message.payload || {};
        const authToken = this.session?.ticketAuthToken;
        if (authToken && partyId && publicKey) {
          this.provider = new Provider({
            connection: this.connection,
            party_id: partyId,
            auth_token: authToken,
            public_key: publicKey,
            email,
            hooks: this.createProviderHooks()
          });
          try {
            this.session.authToken = authToken;
            this.session.partyId = partyId;
            this.session.publicKey = publicKey;
            this.session.email = email;
            this.session.authorized();
            this.session.save();
            this.onAccept?.(this.provider);
            this.hideQrCode();
            console.log("[LoopSDK] HANDSHAKE_ACCEPT: closing popup (if exists)");
            this.popupWindow = null;
          } catch (error) {
            console.error("Failed to update local storage with auth token.", error);
          }
        }
      } else if (message.type === "handshake_reject") {
        console.log("[LoopSDK] Entering HANDSHAKE_REJECT flow");
        this.clearLocalSession();
        this.onReject?.();
        console.log("[LoopSDK] HANDSHAKE_REJECT: closing popup (if exists)");
        this.popupWindow = null;
      } else if (message.type === "ticket_revoked") {
        console.log("[LoopSDK] Entering TICKET_REVOKED flow");
        const status = message?.payload?.status || "invalid";
        this.provider?.rejectPendingRequests("SESSION_EXPIRED", `Connect ticket is ${status}. Please reconnect.`);
        this.clearLocalSession();
        this.onReject?.();
      } else if (this.provider) {
        this.provider.handleResponse(message);
      }
    }
    getConnectUrl() {
      if (!this.session?.ticketId) {
        throw new Error("No ticket ID found. Please call connect() first.");
      }
      return this.buildConnectUrl(this.session.ticketId);
    }
    buildConnectUrl(ticketId) {
      const url = new URL("/.connect/", this.connection.walletUrl);
      url.searchParams.set("ticketId", ticketId);
      if (this.redirectUrl) {
        url.searchParams.set("redirectUrl", this.redirectUrl);
      }
      return url.toString();
    }
    buildDashboardUrl() {
      if (!this.connection) {
        throw new Error("Connection not initialized");
      }
      return this.connection.walletUrl;
    }
    openRequestUi() {
      if (typeof window === "undefined") {
        return null;
      }
      if (!this.session?.ticketId) {
        console.warn("[LoopSDK] Cannot open wallet UI for request: no active ticket.");
        return null;
      }
      const dashboardUrl = this.buildDashboardUrl();
      const targetMode = this.requestSigningMode === "tab" ? "tab" : "popup";
      const opened = this.openWallet(dashboardUrl, targetMode);
      if (opened) {
        this.popupWindow = opened;
        return opened;
      }
      return null;
    }
    openWallet(url, mode) {
      if (typeof window === "undefined") {
        return null;
      }
      const targetMode = mode || this.openMode;
      if (targetMode === "popup") {
        const width = 480;
        const height = 720;
        const left = (window.innerWidth - width) / 2 + window.screenX;
        const top = (window.innerWidth - height) / 2 + window.screenY;
        const features = `width=${width},height=${height},left=${left},top=${top},menubar=no,toolbar=no,location=no,resizable=yes,scrollbars=yes,status=no`;
        const popup = window.open(url, "loop-wallet", features);
        if (!popup) {
          return window.open(url, "_blank", "noopener,noreferrer");
        }
        this.popupWindow = popup;
        try {
          popup.focus();
        } catch {
        }
        return popup;
      }
      return window.open(url, "_blank", "noopener,noreferrer");
    }
    injectModalStyles() {
      if (document.getElementById("loop-connect-styles"))
        return;
      const style = document.createElement("style");
      style.id = "loop-connect-styles";
      style.textContent = `
			.loop-connect {
				position: fixed;
				inset: 0;
				background: rgba(0, 0, 0, 0.85);
				backdrop-filter: blur(8px);
				display: flex;
				justify-content: center;
				align-items: center;
				z-index: 10000;
				font-family: "Inter", system-ui, -apple-system, sans-serif;
				animation: fadeIn 0.2s ease-out;
			}
			.loop-connect dialog {
				position: relative;
				overflow: hidden;
				background: #080808;
				box-shadow: 0 24px 60px -12px rgba(0, 0, 0, 0.5);
				border-radius: 40px;
				border: none;
				width: 340px;
				height: 534px;
				box-sizing: border-box;
				padding: 32px;
				display: flex;
				flex-direction: column;
				align-items: center;
				gap: 0;
				color: #ffffff;
			}
			.loop-connect .bg-logo {
				position: absolute;
				right: -20px;
				top: -40px;
				width: 140px;
				height: auto;
				opacity: 0.06;
				pointer-events: none;
			}
			.loop-connect h3 {
				position: absolute;
				top: 32px;
				left: 32px;
				right: 32px;
				margin: 0;
				font-size: 18px;
				font-weight: 700;
				line-height: 27px;
				letter-spacing: -0.45px;
				text-align: center;
			}
			.loop-connect figure {
				position: absolute;
				top: 91px;
				left: 32px;
				width: 276px;
				height: 276px;
				margin: 0;
				background: #ffffff;
				padding: 20px;
				border-radius: 8px;
				display: flex;
				justify-content: center;
				border: none;
				box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.1);
				box-sizing: border-box;
			}
			.loop-connect img {
				display: block;
				width: 236px;
				height: 236px;
				object-fit: contain;
				border-radius: 12px;
			}
			.loop-connect .divider {
				position: absolute;
				top: 399px;
				left: 36px;
				right: 36px;
				width: auto;
				display: flex;
				align-items: center;
				justify-content: center;
				gap: 12px;
				color: #64748b;
				font-size: 11px;
				font-weight: 700;
				letter-spacing: 0.15em;
				text-transform: uppercase;
				text-align: center;
			}
			.loop-connect .divider::before,
			.loop-connect .divider::after {
				content: "";
				flex: 1;
				height: 1px;
				background: #1e293b;
			}
			.loop-connect button {
				position: absolute;
				top: 447.5px;
				left: 32px;
				right: 32px;
				background: #f2ff96;
				border: none;
				color: #0f172a;
				text-align: center;
				font-family: "Inter", system-ui, -apple-system, sans-serif;
				font-style: normal;
				padding: 0 24px;
				border-radius: 8px;
				font-size: 15px;
				font-weight: 600;
				line-height: 22.5px;
				cursor: pointer;
				transition: all 0.2s ease;
				width: auto;
				height: 54.5px;
				box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.2),
					0 4px 6px -4px rgba(0, 0, 0, 0.2);
			}
			.loop-connect button:hover {
				background: #f6ffb4;
			}
			@keyframes fadeIn {
				from { opacity: 0; }
				to { opacity: 1; }
			}
		`;
      document.head.appendChild(style);
    }
    showQrCode(url) {
      this.injectModalStyles();
      import_qrcode.default.toDataURL(url, { margin: 0 }, (err, dataUrl) => {
        if (err) {
          console.error("Failed to generate QR code", err);
          return;
        }
        const overlay = document.createElement("div");
        overlay.id = "loop-sdk-connect-overlay";
        overlay.className = "loop-sdk-connect-overlay loop-connect";
        const dialog = document.createElement("dialog");
        dialog.open = true;
        const bgLogo = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        bgLogo.setAttribute("class", "bg-logo");
        bgLogo.setAttribute("viewBox", "0 0 124.05 305.64");
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", "M24.58,99.47L124.05,0v224.42L24.58,124.95c-7.04-7.04-7.04-18.45,0-25.49Z");
        path.setAttribute("fill", "currentColor");
        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("x", "12.89");
        rect.setAttribute("y", "194.48");
        rect.setAttribute("width", "98.27");
        rect.setAttribute("height", "98.27");
        rect.setAttribute("rx", "18.02");
        rect.setAttribute("ry", "18.02");
        rect.setAttribute("transform", "translate(-154.1 115.21) rotate(-45)");
        rect.setAttribute("fill", "currentColor");
        bgLogo.appendChild(path);
        bgLogo.appendChild(rect);
        const title = document.createElement("h3");
        title.textContent = "Scan with Phone";
        const figure = document.createElement("figure");
        const img = document.createElement("img");
        img.src = dataUrl;
        img.alt = "QR Code";
        figure.appendChild(img);
        const divider = document.createElement("div");
        divider.className = "divider";
        divider.textContent = "OR";
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Continue in Browser";
        button.addEventListener("click", () => {
          this.openWallet(url);
        });
        dialog.appendChild(bgLogo);
        dialog.appendChild(title);
        dialog.appendChild(figure);
        dialog.appendChild(divider);
        dialog.appendChild(button);
        overlay.appendChild(dialog);
        overlay.addEventListener("click", (e) => {
          if (e.target === overlay) {
            this.hideQrCode();
          }
        });
        document.body.appendChild(overlay);
        this.overlay = overlay;
      });
    }
    hideQrCode() {
      if (this.overlay && this.overlay.parentElement) {
        this.overlay.parentElement.removeChild(this.overlay);
        this.overlay = null;
      }
    }
    clearLocalSession() {
      this.session?.reset();
      this.provider = null;
      this.connection?.ws?.close();
      this.hideQrCode();
    }
    invalidateLocalSession() {
      this.clearLocalSession();
      this.onReject?.();
    }
    logout() {
      const ticketId = this.session?.ticketId;
      const authToken = this.session?.authToken;
      if (ticketId && authToken) {
        this.connection?.disconnect(ticketId, authToken).catch((error) => {
          console.warn("[LoopSDK] Failed to disconnect connect ticket.", error);
        });
      }
      this.clearLocalSession();
    }
    requireProvider() {
      if (!this.provider) {
        throw new Error("SDK not connected. Call connect() and wait for acceptance first.");
      }
      return this.provider;
    }
    createProviderHooks() {
      return {
        onRequestStart: () => this.openRequestUi(),
        onRequestFinish: () => {
          return;
        },
        onTransactionUpdate: this.onTransactionUpdate ?? void 0,
        onSessionInvalid: () => this.invalidateLocalSession()
      };
    }
  };
  var loop = new LoopSDK();
  return __toCommonJS(entry_loop_exports);
})();
