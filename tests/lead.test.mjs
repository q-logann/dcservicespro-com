import assert from "node:assert/strict";
import test from "node:test";

import handler from "../api/lead.js";

process.env.RESEND_API_KEY = "re_test_key";
process.env.LEAD_TO_EMAIL = "derrick@dcservicespro.com";
process.env.LEAD_FROM_EMAIL = "DC Services Website <quotes@send.dcservicespro.com>";

function request(body, options = {}) {
  const contentType = options.contentType || "application/json";
  return {
    method: options.method || "POST",
    body,
    headers: {
      host: "dcservicespro.com",
      origin: "https://dcservicespro.com",
      "content-type": contentType,
      "content-length": String(Buffer.byteLength(typeof body === "string" ? body : JSON.stringify(body))),
      ...options.headers,
    },
  };
}

function response() {
  return {
    statusCode: null,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      this.ended = true;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

async function run(req) {
  const res = response();
  await handler(req, res);
  return res;
}

test("rejects an empty request before sending email", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, { status: 200 });
  };
  try {
    const res = await run(request({}));
    assert.equal(res.statusCode, 400);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects invalid contact information and unexpected fields", async () => {
  const badContact = await run(
    request({ formType: "residential", name: "Jordan", address: "30043", contact: "call me" })
  );
  assert.equal(badContact.statusCode, 400);
  assert.match(badContact.body.error, /valid phone number or email/i);

  const extraField = await run(
    request({
      formType: "residential",
      name: "Jordan",
      address: "30043",
      contact: "jordan@example.net",
      admin: "true",
    })
  );
  assert.equal(extraField.statusCode, 400);
  assert.match(extraField.body.error, /unexpected/i);

  const punctuationOnly = await run(
    request({ formType: "residential", name: "Jordan", address: "30043", contact: "----------" })
  );
  assert.equal(punctuationOnly.statusCode, 400);
});

test("silently accepts honeypot submissions without sending email", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, { status: 200 });
  };
  try {
    const res = await run(request({ formType: "residential", _hp: "spam" }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sends a validated residential lead with escaped HTML and reply-to", async () => {
  const originalFetch = globalThis.fetch;
  let requestOptions;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://api.resend.com/emails");
    requestOptions = options;
    return new Response(JSON.stringify({ id: "email_123" }), { status: 200 });
  };
  try {
    const res = await run(
      request({
        formType: "residential",
        _hp: "",
        _elapsedMs: "5000",
        name: "Jordan <script>",
        address: "123 Main St",
        contact: "jordan@example.net",
      })
    );
    assert.equal(res.statusCode, 200);
    const email = JSON.parse(requestOptions.body);
    assert.equal(email.to, "derrick@dcservicespro.com");
    assert.equal(email.reply_to, "jordan@example.net");
    assert.match(email.subject, /Jordan <script>/);
    assert.match(email.html, /Jordan &lt;script&gt;/);
    assert.doesNotMatch(email.html, /Jordan <script>/);
    assert.match(requestOptions.headers.Authorization, /^Bearer re_test_key$/);
    assert.match(requestOptions.headers["Idempotency-Key"], /^lead\/residential\/[0-9a-f-]{36}$/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not discard a fast valid submission", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ id: "email_fast" }), { status: 200 });
  };
  try {
    const res = await run(
      request({
        formType: "residential",
        _hp: "",
        _elapsedMs: "50",
        name: "Jordan",
        address: "30043",
        contact: "jordan@example.net",
      })
    );
    assert.equal(res.statusCode, 200);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sends a validated commercial lead", async () => {
  const originalFetch = globalThis.fetch;
  let email;
  globalThis.fetch = async (_url, options) => {
    email = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: "email_456" }), { status: 200 });
  };
  try {
    const res = await run(
      request({
        formType: "commercial",
        _hp: "",
        _elapsedMs: "5000",
        business: "Peachtree Property Group",
        contactName: "Alex Morgan",
        role: "Property Manager",
        propertyType: "apartment-community",
        size: "12 buildings",
        contact: "678-555-0199",
        notes: "Quote requested for fall cleanup.",
      })
    );
    assert.equal(res.statusCode, 200);
    assert.equal(email.reply_to, undefined);
    assert.match(email.text, /Property Type: apartment-community/);
    assert.match(email.subject, /Alex Morgan/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("redirects a valid native form submission back to its success page", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ id: "email_789" }), { status: 200 });
  try {
    const formBody = new URLSearchParams({
      formType: "commercial",
      business: "Test Property",
      contactName: "Alex Morgan",
      propertyType: "other",
      contact: "alex@example.net",
    }).toString();
    const res = await run(request(formBody, { contentType: "application/x-www-form-urlencoded" }));
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.Location, "/commercial-quote.html?sent=1#form-success");
    assert.equal(res.ended, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
