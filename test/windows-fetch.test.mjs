import assert from "node:assert/strict";
import { test } from "node:test";
import {
  followWindowsFetchRedirects,
  resolveWindowsFetchRedirect,
  validateWindowsFetchUrl,
  WINDOWS_FETCH_MAX_REDIRECTS,
} from "../electron/windows-fetch.mjs";

test("Windows fetch validates relative and allowlisted cross-host redirects", async () => {
  const calls = [];
  const responses = [
    { status: 302, location: "/pdf/2501.12345" },
    { status: 307, location: "https://export.arxiv.org/pdf/2501.12345" },
    { status: 200, contentType: "application/pdf", contentLength: "42" },
  ];

  const result = await followWindowsFetchRedirects(
    "https://arxiv.org/abs/2501.12345",
    "HEAD",
    async (url, method) => {
      calls.push({ url: url.toString(), method });
      return responses.shift();
    },
  );

  assert.deepEqual(calls, [
    { url: "https://arxiv.org/abs/2501.12345", method: "HEAD" },
    { url: "https://arxiv.org/pdf/2501.12345", method: "HEAD" },
    { url: "https://export.arxiv.org/pdf/2501.12345", method: "HEAD" },
  ]);
  assert.equal(result.status, 200);
  assert.equal(result.contentType, "application/pdf");
  assert.equal(result.contentLength, "42");
  assert.equal(result.redirectCount, 2);
});

test("Windows fetch handles common redirect statuses without changing GET", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const methods = [];
    const result = await followWindowsFetchRedirects(
      "https://arxiv.org/abs/2501.12345",
      "GET",
      async (_url, method) => {
        methods.push(method);
        return methods.length === 1
          ? { status, location: "/pdf/2501.12345" }
          : { status: 200 };
      },
    );
    assert.deepEqual(methods, ["GET", "GET"]);
    assert.equal(result.redirectCount, 1);
  }
});

test("Windows fetch rejects a redirect outside the allowlist before requesting it", async () => {
  let calls = 0;
  await assert.rejects(
    () => followWindowsFetchRedirects(
      "https://arxiv.org/abs/2501.12345",
      "GET",
      async () => {
        calls += 1;
        return { status: 302, location: "https://example.com/stolen" };
      },
    ),
    /不允许访问该网络地址/,
  );
  assert.equal(calls, 1);
});

test("Windows fetch rejects a redirect without Location", async () => {
  await assert.rejects(
    () => followWindowsFetchRedirects(
      "https://arxiv.org/abs/2501.12345",
      "GET",
      async () => ({ status: 302 }),
    ),
    /缺少 Location/,
  );
});

test("Windows fetch follows at most six redirects", async () => {
  let calls = 0;
  await assert.rejects(
    () => followWindowsFetchRedirects(
      "https://arxiv.org/start",
      "GET",
      async () => {
        calls += 1;
        return { status: 301, location: `/hop-${calls}` };
      },
    ),
    new RegExp(`超过 ${WINDOWS_FETCH_MAX_REDIRECTS} 次`),
  );
  assert.equal(calls, WINDOWS_FETCH_MAX_REDIRECTS + 1);
});

test("Windows fetch URL validation rejects credentials and unsafe protocols", () => {
  assert.throws(
    () => validateWindowsFetchUrl("https://user:secret@arxiv.org/abs/2501.12345"),
    /不允许访问该网络地址/,
  );
  assert.throws(
    () => resolveWindowsFetchRedirect("https://arxiv.org/start", "http://arxiv.org/plaintext"),
    /不允许访问该网络地址/,
  );
});

test("Windows fetch redirect runner refuses methods other than GET and HEAD", async () => {
  await assert.rejects(
    () => followWindowsFetchRedirects(
      "https://arxiv.org/start",
      "POST",
      async () => ({ status: 200 }),
    ),
    /不支持的网络方法：POST/,
  );
});
