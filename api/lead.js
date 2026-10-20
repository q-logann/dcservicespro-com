import { randomUUID } from "node:crypto";

const MAX_BODY_BYTES = 20_000;
const RESEND_TIMEOUT_MS = 8_000;

const FORM_CONFIG = {
  residential: {
    subject: "New residential quote request",
    fields: ["name", "address", "contact"],
    required: ["name", "address", "contact"],
    maxLengths: { name: 120, address: 240, contact: 180 },
  },
  commercial: {
    subject: "New commercial estimate request",
    fields: ["business", "contactName", "role", "propertyType", "size", "contact", "notes"],
    required: ["business", "contactName", "propertyType", "contact"],
    maxLengths: {
      business: 160,
      contactName: 120,
      role: 120,
      propertyType: 80,
      size: 160,
      contact: 180,
      notes: 2_000,
    },
  },
};

const PROPERTY_TYPES = new Set([
  "property-management-hoa",
  "retail-shopping-center",
  "office-business-park",
  "apartment-community",
  "other",
]);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!isAllowedOrigin(req)) {
    res.status(403).json({ error: "Request origin not allowed" });
    return;
  }

  const contentLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    res.status(413).json({ error: "Request too large" });
    return;
  }

  const data = parseBody(req.body);
  if (!data) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  // The honeypot stops basic form bots without exposing a challenge to visitors.
  if (stringValue(data._hp)) {
    respondSuccess(req, res, data.formType);
    return;
  }

  const formType = stringValue(data.formType);
  const config = FORM_CONFIG[formType];
  if (!config) {
    res.status(400).json({ error: "Invalid form type" });
    return;
  }

  const allowedKeys = new Set([...config.fields, "formType", "_hp", "_elapsedMs", "_submissionId"]);
  if (Object.keys(data).some((key) => !allowedKeys.has(key))) {
    respondError(req, res, 400, "Unexpected form field", formType);
    return;
  }

  const cleaned = {};
  for (const field of config.fields) {
    const value = stringValue(data[field]);
    if (value.length > config.maxLengths[field]) {
      respondError(req, res, 400, `${label(field)} is too long`, formType);
      return;
    }
    if (value) cleaned[field] = value;
  }

  const missing = config.required.find((field) => !cleaned[field]);
  if (missing) {
    respondError(req, res, 400, `${label(missing)} is required`, formType);
    return;
  }

  if (!isValidContact(cleaned.contact)) {
    respondError(req, res, 400, "Enter a valid phone number or email address", formType);
    return;
  }

  if (formType === "commercial" && !PROPERTY_TYPES.has(cleaned.propertyType)) {
    respondError(req, res, 400, "Select a valid property type", formType);
    return;
  }

  const suppliedSubmissionId = stringValue(data._submissionId);
  if (suppliedSubmissionId && !/^[0-9a-f-]{36}$/i.test(suppliedSubmissionId)) {
    respondError(req, res, 400, "Invalid submission identifier", formType);
    return;
  }
  const submissionId = suppliedSubmissionId || randomUUID();

  const { RESEND_API_KEY, LEAD_TO_EMAIL, LEAD_FROM_EMAIL } = process.env;
  if (!RESEND_API_KEY || !LEAD_TO_EMAIL || !LEAD_FROM_EMAIL) {
    console.error("Lead email environment variables are not configured");
    respondError(req, res, 500, "Email service not configured", formType);
    return;
  }

  const rows = Object.entries(cleaned)
    .map(
      ([key, value]) =>
        `<tr><td style="padding:6px 16px 6px 0;color:#5e6b78;font-weight:600;vertical-align:top;white-space:nowrap;">${escapeHtml(
          label(key)
        )}</td><td style="padding:6px 0;white-space:pre-wrap;">${escapeHtml(value)}</td></tr>`
    )
    .join("");

  const leadName = cleaned.name || cleaned.contactName || cleaned.business;
  const subject = `${config.subject} — ${leadName}`.slice(0, 180);
  const replyTo = isEmail(cleaned.contact) ? cleaned.contact : undefined;
  const text = Object.entries(cleaned)
    .map(([key, value]) => `${label(key)}: ${value}`)
    .join("\n");

  const resendController = new AbortController();
  const resendTimeout = setTimeout(() => resendController.abort(), RESEND_TIMEOUT_MS);

  try {
    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `lead/${formType}/${submissionId}`,
      },
      body: JSON.stringify({
        from: LEAD_FROM_EMAIL,
        to: LEAD_TO_EMAIL,
        reply_to: replyTo,
        subject,
        html: `<h1 style="font:700 20px Arial,sans-serif;">${escapeHtml(config.subject)}</h1><table cellpadding="0" cellspacing="0" style="font:16px Arial,sans-serif;">${rows}</table>`,
        text,
      }),
      signal: resendController.signal,
    });

    if (!emailRes.ok) {
      console.error("Resend rejected a lead email", emailRes.status, await emailRes.text());
      respondError(req, res, 502, "Failed to send", formType);
      return;
    }

    respondSuccess(req, res, formType);
  } catch (error) {
    console.error("Lead email request failed", error);
    respondError(req, res, error?.name === "AbortError" ? 504 : 500, "Failed to send", formType);
  } finally {
    clearTimeout(resendTimeout);
  }
}

function parseBody(body) {
  if (body && typeof body === "object" && !Array.isArray(body)) return body;
  if (typeof body !== "string") return null;

  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    const parsed = Object.fromEntries(new URLSearchParams(body));
    return Object.keys(parsed).length ? parsed : null;
  }

  return null;
}

function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;

  try {
    const originHost = new URL(origin).host.toLowerCase();
    const requestHost = String(req.headers.host || "").toLowerCase();
    return (
      originHost === requestHost ||
      originHost === "dcservicespro.com" ||
      originHost === "www.dcservicespro.com"
    );
  } catch {
    return false;
  }
}

function isValidContact(value) {
  if (isEmail(value)) return true;
  if (!/^\+?[\d\s().-]+$/.test(value)) return false;
  const digitCount = value.replace(/\D/g, "").length;
  return digitCount >= 10 && digitCount <= 15;
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function respondSuccess(req, res, formType) {
  const contentType = String(req.headers["content-type"] || "");
  if (!contentType.includes("application/json")) {
    const returnTo = formType === "commercial" ? "/commercial-quote.html?sent=1#form-success" : "/quote.html?sent=1#form-success";
    res.setHeader("Location", returnTo);
    res.status(303).end();
    return;
  }

  res.status(200).json({ ok: true });
}

function respondError(req, res, status, error, formType) {
  const contentType = String(req.headers["content-type"] || "");
  if (!contentType.includes("application/json") && FORM_CONFIG[formType]) {
    const returnTo = formType === "commercial" ? "/commercial-quote.html?error=1#form-error" : "/quote.html?error=1#form-error";
    res.setHeader("Location", returnTo);
    res.status(303).end();
    return;
  }

  res.status(status).json({ error });
}

function label(key) {
  const overrides = {
    contactName: "Contact Name",
    propertyType: "Property Type",
  };
  if (overrides[key]) return overrides[key];
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
