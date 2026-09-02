/**
 * jsdom, plus the web APIs the browser actually has.
 *
 * jsdom deliberately implements no networking, so `fetch`, `Response`, `Request` and `Headers` are
 * absent from its global — even though Node has provided them for years and every browser this app
 * runs in has them. Left alone, that turns the move from `testEnvironment: "node"` to `"jsdom"`
 * into six false failures in the http/api specs, which construct a `Response` to stand in for the
 * server.
 *
 * The constructor body runs in the Node realm, so `globalThis` here still has Node's copies; they
 * are handed to the sandbox only where jsdom left a hole, so anything jsdom does implement (its
 * `URL`, its `Blob`) keeps winning.
 */
const JSDOMEnvironment = require('jest-environment-jsdom').default;

const MISSING_IN_JSDOM = [
  'fetch', 'Response', 'Request', 'Headers', 'FormData',
  'AbortController', 'AbortSignal', 'ReadableStream',
  'TextEncoder', 'TextDecoder', 'structuredClone',
];

module.exports = class WebApiJSDOMEnvironment extends JSDOMEnvironment {
  constructor(config, context) {
    super(config, context);
    for (const name of MISSING_IN_JSDOM) {
      if (this.global[name] === undefined && globalThis[name] !== undefined) {
        this.global[name] = globalThis[name];
      }
    }
  }
};
