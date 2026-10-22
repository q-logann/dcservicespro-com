// Lead form endpoint. This site is static (GitHub Pages), so the form handler
// lives in a separate Cloudflare Worker. Keep this in sync with the `action`
// attribute on the quote forms and with the CSP meta tag in each page.
const LEAD_ENDPOINT = "https://dcservicespro-lead.dcservicespro-lead-worker.workers.dev/";

const yearTargets = document.querySelectorAll("[data-year]");
const quoteForms = document.querySelectorAll("[data-quote-form]");
const formStartedAt = new WeakMap();
const submissionIds = new WeakMap();

yearTargets.forEach((target) => {
  target.textContent = new Date().getFullYear();
});

if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  document.querySelectorAll("video[autoplay]").forEach((video) => {
    video.removeAttribute("autoplay");
    video.pause();
    try {
      video.currentTime = 0;
    } catch {
      // The poster remains visible if the browser has not loaded a frame yet.
    }
  });
}

quoteForms.forEach((form) => {
  const successMessage = form.querySelector(".success-message");
  const errorMessage = form.querySelector(".error-message");
  const submitButton = form.querySelector("button[type=submit]");
  const contactInput = form.querySelector('input[name="contact"]');
  formStartedAt.set(form, performance.now());
  submissionIds.set(form, createSubmissionId());

  contactInput?.addEventListener("input", () => contactInput.setCustomValidity(""));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (contactInput && !isValidContact(contactInput.value.trim())) {
      contactInput.setCustomValidity("Enter a valid phone number or email address.");
      contactInput.reportValidity();
      return;
    }

    successMessage?.classList.remove("is-visible");
    errorMessage?.classList.remove("is-visible");

    const payload = Object.fromEntries(new FormData(form).entries());
    payload.formType = form.dataset.quoteForm || payload.formType || "unknown";
    payload._elapsedMs = Math.round(performance.now() - formStartedAt.get(form));
    payload._submissionId = submissionIds.get(form);

    const originalLabel = submitButton?.textContent;
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Sending…";
    }
    form.setAttribute("aria-busy", "true");

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 12_000);

    try {
      // The lead endpoint is a Cloudflare Worker on its own origin, not a path
      // on this site, since GitHub Pages cannot run server code.
      const response = await fetch(form.action || LEAD_ENDPOINT, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        credentials: "omit",
        signal: controller.signal,
      });

      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) throw new Error("Request failed");

      form.reset();
      formStartedAt.set(form, performance.now());
      submissionIds.set(form, createSubmissionId());
      if (successMessage) {
        successMessage.classList.add("is-visible");
        successMessage.focus({ preventScroll: true });
        successMessage.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    } catch {
      if (errorMessage) {
        errorMessage.classList.add("is-visible");
        errorMessage.focus({ preventScroll: true });
      }
    } finally {
      window.clearTimeout(timeoutId);
      form.removeAttribute("aria-busy");
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = originalLabel;
      }
    }
  });
});

const submissionState = new URLSearchParams(window.location.search);

if (submissionState.get("sent") === "1") {
  const successMessage = document.querySelector("[data-quote-form] .success-message");
  successMessage?.classList.add("is-visible");
  window.history.replaceState({}, "", window.location.pathname + window.location.hash);
}

if (submissionState.get("error") === "1") {
  const errorMessage = document.querySelector("[data-quote-form] .error-message");
  errorMessage?.classList.add("is-visible");
  window.history.replaceState({}, "", window.location.pathname + window.location.hash);
}

function isValidContact(value) {
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return true;
  if (!/^\+?[\d\s().-]+$/.test(value)) return false;
  const digitCount = value.replace(/\D/g, "").length;
  return digitCount >= 10 && digitCount <= 15;
}

function createSubmissionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}
