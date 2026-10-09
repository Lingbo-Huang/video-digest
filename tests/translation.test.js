const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const sidepanelI18n = require("../sidepanel-i18n.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function loadSidepanelHelpers({
  sendMessage = () => Promise.resolve({}),
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
} = {}) {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    crypto: webcrypto,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    setInterval() {},
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      removeEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: (id) => id === "followPlaybackBtn" ? { style: {} } : null,
      createElement: () => {
        let value = "";
        return {
          set textContent(text) {
            value = String(text);
          },
          get innerHTML() {
            return value
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;");
          },
        };
      },
    },
    chrome: {
      runtime: { onMessage: listeners, sendMessage },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {},
    VIDEO_DIGEST_I18N: sidepanelI18n,
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(read("sidepanel.js"), context);
  return {
    ...sandbox.__YTD_TRANSCRIPT_TESTING__,
    evaluate: (source) => vm.runInContext(source, context),
    setGlobal: (key, value) => { sandbox[key] = value; },
  };
}

function loadBackgroundHelpers({
  fetchImpl = fetch,
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
} = {}) {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    fetch: fetchImpl,
    AbortController,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get: async () => ({}),
        },
      },
      action: { onClicked: listeners },
      sidePanel: {
        setPanelBehavior() {},
        setOptions: () => Promise.resolve(),
      },
      runtime: {
        onInstalled: listeners,
        onMessage: listeners,
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
      },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {
      normalize: () => ({
        provider: "codex-local",
        aiBaseUrl: "http://127.0.0.1:43110",
        aiModel: "chatgpt-subscription",
      }),
      canonicalYouTubeUrl: (videoId) =>
        `https://www.youtube.com/watch?v=${videoId}`,
    },
    YTD_LOCAL_BRIDGE: {
      baseUrl: "http://127.0.0.1:43110",
      token: "test-install-token",
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("background.js"), sandbox);
  return sandbox.__YTD_TRANSLATION_TESTING__;
}

test("transcript header exposes original, Chinese, and bilingual modes", () => {
  const html = read("sidepanel.html");
  const js = read("sidepanel.js");
  assert.match(html, /data-transcript-mode="original"[\s\S]*?>Original</);
  assert.match(html, /data-transcript-mode="zh"[\s\S]*?data-i18n="chinese"[\s\S]*?>Chinese</);
  assert.match(html, /data-transcript-mode="bilingual"[\s\S]*?data-i18n="bilingual"[\s\S]*?>Bilingual</);
  assert.match(js, /contentType: "transcriptBatch"/);
});

test("semantic grouping rebuilds thoughts across caption boundaries", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const segments = groupTranscriptEntries([
    { start: 0, text: "This sentence starts" },
    { start: 2, text: "and ends here." },
    { start: 4, text: "A second sentence follows." },
  ]);
  assert.equal(segments.length, 1);
  assert.equal(
    segments[0].text,
    "This sentence starts and ends here. A second sentence follows.",
  );
  assert.equal(segments[0].start, 0);
});

test("subtitle renderer escapes arbitrary HTML", () => {
  const { renderSubtitleInlineMarkup } = loadSidepanelHelpers();
  const html = renderSubtitleInlineMarkup(
    '<img src=x onerror="alert(1)"><script>alert(2)</script>',
  );
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<img\b|<script\b/);
});

test("background validates translation batch size and stable IDs", () => {
  const { validateTranscriptBatchRequest } = loadBackgroundHelpers();
  assert.throws(
    () => validateTranscriptBatchRequest({ segments: [] }),
    /1 to 12 segments/,
  );
  assert.throws(
    () =>
      validateTranscriptBatchRequest({
        segments: [
          { id: "duplicate", text: "first" },
          { id: "duplicate", text: "second" },
        ],
      }),
    /unique and stable/,
  );
});

test("AI requests send the selected provider through the authenticated local bridge", async () => {
  const calls = [];
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, text: "translated" }),
      };
    },
  });
  const result = await helpers.requestAiCompletion({
    maxTokens: 128,
    responseFormat: { type: "json_object" },
    messages: [{ role: "user", content: "Hello." }],
  });

  assert.equal(result.text, "translated");
  assert.equal(calls[0].url, "http://127.0.0.1:43110/v1/complete");
  assert.equal(
    calls[0].options.headers["X-YouTube-Digest-Token"],
    "test-install-token",
  );
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    provider: "codex-local",
    messages: [{ role: "user", content: "Hello." }],
    maxTokens: 128,
    responseFormat: { type: "json_object" },
  });
});

test("local bridge responses over 2 MiB are rejected", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => "x".repeat(2 * 1024 * 1024 + 1),
    }),
  });
  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_RESPONSE_TOO_LARGE");
});

test("translation retries one empty response without responseFormat", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      const body = JSON.parse(options.body);
      requests.push(body);
      const text =
        requests.length === 1
          ? ""
          : '{"segments":[{"id":"segment-0-0","text":"中文译文。"}]}';
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, text }),
      };
    },
  });
  const result = await helpers.handleTranslateContent(
    { segments: [{ id: "segment-0-0", text: "English source sentence." }] },
    "transcriptBatch",
    "zh",
    "Video",
  );

  assert.equal(result.success, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].responseFormat, { type: "json_object" });
  assert.equal(Object.hasOwn(requests[1], "responseFormat"), false);
});

test("translation message watchdog uses the bridge hard limit", async () => {
  let timeoutCallback;
  let timeoutDelay;
  let clearCount = 0;
  const sent = [];
  const helpers = loadSidepanelHelpers({
    sendMessage: (message) => {
      sent.push(message);
      return message.action === "cancelTranslation"
        ? Promise.resolve({ success: true })
        : new Promise(() => {});
    },
    setTimeoutImpl(callback, delay) {
      timeoutCallback = callback;
      timeoutDelay = delay;
      return 73;
    },
    clearTimeoutImpl(id) {
      assert.equal(id, 73);
      clearCount += 1;
    },
  });

  const requestId = "44444444-4444-4444-8444-444444444444";
  const request = helpers.sendTranslationMessage({ action: "translateContent", requestId });
  assert.equal(timeoutDelay, 190_000);
  timeoutCallback();
  await assert.rejects(request, /timed out after 190 seconds.*try again/i);
  assert.equal(clearCount, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
    { action: "translateContent", requestId },
    { action: "cancelTranslation", requestId },
  ]);
});

test("side panel cancels all stale translation batches without touching other work", async () => {
  const sent = [];
  const helpers = loadSidepanelHelpers({
    sendMessage: async (message) => {
      sent.push(message);
      return { success: true };
    },
  });
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  helpers.activeTranslationRequestIds.add(first);
  helpers.activeTranslationRequestIds.add(second);

  helpers.cancelPendingTranslations();
  await Promise.resolve();

  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
    { action: "cancelTranslation", requestId: first },
    { action: "cancelTranslation", requestId: second },
  ]);
  assert.equal(helpers.activeTranslationRequestIds.size, 0);
});

test("switching to Overview does not generate chapters automatically", () => {
  const sent = [];
  const helpers = loadSidepanelHelpers({
    sendMessage: async (message) => { sent.push(message); return { success: true }; },
  });
  helpers.evaluate('currentTranscriptTimestamped = "0:00 Hello"');
  helpers.evaluate('switchTab("overview")');
  assert.equal(sent.length, 0);
});

test("overview analysis runs after the explicit generation action", async () => {
  const sent = [];
  const helpers = loadSidepanelHelpers({
    sendMessage: async (message) => {
      sent.push(message);
      return { success: false, error: "test failure" };
    },
  });
  helpers.evaluate('currentTranscriptTimestamped = "0:00 Hello"; currentContentKey = "youtube:video1"');
  await helpers.evaluate('triggerAnalysis()');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, "analyzeTranscript");
});

test("translation starts only when enqueued and single lines remain serial", async () => {
  const sent = [];
  const pending = [];
  const helpers = loadSidepanelHelpers({
    sendMessage: (message) => {
      sent.push(message);
      return new Promise((resolve) => pending.push(resolve));
    },
  });
  const segments = Array.from({ length: 13 }, (_, index) => ({
    id: `segment-${index}`,
    text: `Sentence ${index}.`,
    start: index,
  }));
  helpers.setGlobal("testSegments", segments);
  helpers.evaluate('currentVideoId = "video1"; currentContentKey = "youtube:video1"; currentTranscriptMode = "bilingual"; updateCache = async () => {}; createTranslationQueue(testSegments)');
  assert.equal(sent.length, 0);

  helpers.evaluate('activeTranslationQueue.enqueue(0, true, true); activeTranslationQueue.enqueue(1, true, true)');
  await new Promise(setImmediate);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content.segments.length, 1);
  pending.shift()({ success: false, error: "test failure" });
  await new Promise(setImmediate);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].content.segments.length, 1);
  pending.shift()({ success: false, error: "test failure" });
  await new Promise(setImmediate);

  helpers.evaluate('activeTranslationQueue.enqueueAll()');
  await new Promise(setImmediate);
  assert.equal(sent.length, 3);
  assert.equal(sent[2].content.segments.length, 12);
  pending.shift()({ success: false, error: "test failure" });
  await new Promise(setImmediate);
  assert.equal(sent.length, 4);
  assert.equal(sent[3].content.segments.length, 1);
  pending.shift()({ success: false, error: "test failure" });
  await new Promise(setImmediate);
});

test("manual controls are the only overview and transcript generation entry points", () => {
  const html = read("sidepanel.html");
  const panel = read("sidepanel.js");
  assert.match(html, /id="translateAllBtn"/);
  assert.match(html, /id="generateOverviewBtn"/);
  assert.match(panel, /\.transcript-translate-btn[\s\S]*?activeTranslationQueue\?\.enqueue\(index, true, true\)/);
  const startDigestSource = panel.split("async function startDigest(")[1].split("// RENDERING")[0];
  assert.doesNotMatch(startDigestSource, /translateTranscript\(/);
  const modeSource = panel.split("async function handleTranscriptModeChange(")[1].split("function renderTranscriptSegmentContent(")[0];
  assert.doesNotMatch(modeSource, /translateTranscript\(/);
});

test("background aborts only the selected in-flight translation", async () => {
  let resolveBothStarted;
  const bothStarted = new Promise((resolve) => { resolveBothStarted = resolve; });
  const pending = [];
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject, signal: options.signal });
        if (pending.length === 2) resolveBothStarted();
        options.signal.addEventListener("abort", () => {
          const error = new Error("Aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    },
  });
  const requestId = "33333333-3333-4333-8333-333333333333";
  const otherRequestId = "55555555-5555-4555-8555-555555555555";
  const translation = helpers.handleTranslateContent(
    { segments: [{ id: "segment-0-0", text: "Hello." }] },
    "transcriptBatch",
    "zh",
    "Video",
    requestId,
  );
  const otherTranslation = helpers.handleTranslateContent(
    { segments: [{ id: "segment-0-0", text: "World." }] },
    "transcriptBatch",
    "zh",
    "Video",
    otherRequestId,
  );
  await bothStarted;
  assert.equal(helpers.cancelTranslationRequest(requestId), true);
  const result = await translation;
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_CANCELED");
  assert.equal(helpers.cancelTranslationRequest(requestId), false);
  assert.equal(pending[1].signal.aborted, false);
  pending[1].resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      ok: true,
      text: JSON.stringify({ segments: [{ id: "segment-0-0", text: "世界。" }] }),
    }),
  });
  const otherResult = await otherTranslation;
  assert.equal(otherResult.success, true);
  assert.equal(otherResult.translatedContent.segments[0].text, "世界。");
});

test("Chinese prompt preserves bilingual-learning style rules", () => {
  const prompt = read("prompts/translation.md");
  assert.match(prompt, /Translate the complete thought/);
  assert.match(prompt, /Use 你, never 您/);
  assert.match(
    prompt,
    /spaces between Chinese and adjacent English words or digits/,
  );
  assert.match(prompt, /source-language `text`/);
});
