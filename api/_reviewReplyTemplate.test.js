const assert = require("node:assert/strict");
const { test } = require("node:test");

const { renderEmail, signatureBlock, LOGO_URL } = require("./_emailLayout");
const { buildThankYouEmail, DEFAULT_THANKYOU_MESSAGE, THANKYOU_SUBJECT } = require("./_reviewReplyTemplate");

test("renderEmail includes the logo by default and can be turned off", () => {
  const withLogo = renderEmail({ headerLabel: "TEST", contentHtml: "" });
  assert.ok(withLogo.includes(LOGO_URL), "logo URL should appear when showLogo defaults on");
  const noLogo = renderEmail({ headerLabel: "TEST", contentHtml: "", showLogo: false });
  // The signature (which also uses the logo) is off here, so no logo at all.
  assert.ok(!noLogo.includes(LOGO_URL), "logo URL should be absent when showLogo:false and no signature");
});

test("signature block renders 'Tabarnam Boodle' and the logo", () => {
  const sig = signatureBlock();
  assert.ok(sig.includes("Tabarnam Boodle"), "default signature name");
  assert.ok(sig.includes(LOGO_URL), "signature carries the logo");
  const custom = signatureBlock("The Team");
  assert.ok(custom.includes("The Team"));
});

test("renderEmail with signature:true appends the Tabarnam Boodle sign-off", () => {
  const html = renderEmail({ headerLabel: "THANK YOU", contentHtml: "", signature: true });
  assert.ok(html.includes("Tabarnam Boodle"), "signature present");
  assert.ok(html.includes("Warm regards"), "sign-off copy present");
});

test("buildThankYouEmail uses the default message and greets by first name", () => {
  const { subject, html } = buildThankYouEmail({ userName: "Jamie Rivera" });
  assert.equal(subject, THANKYOU_SUBJECT);
  assert.ok(html.includes("Hi Jamie,"), "greets by first name only");
  assert.ok(html.includes("make our community more transparent"), "default thank-you body present");
  assert.ok(html.includes("Tabarnam Boodle"), "signature present");
  assert.ok(html.includes(LOGO_URL), "logo present");
});

test("buildThankYouEmail escapes a personalized message and honors it over the default", () => {
  const { html } = buildThankYouEmail({ userName: "Sam", message: "Loved your <script> note & detail" });
  assert.ok(html.includes("Loved your"), "custom message used");
  assert.ok(!html.includes("<script>"), "raw HTML in the message is escaped");
  assert.ok(!html.includes(DEFAULT_THANKYOU_MESSAGE), "default not appended when a message is given");
});

test("buildThankYouEmail falls back to a generic greeting without a name", () => {
  const { html } = buildThankYouEmail({});
  assert.ok(html.includes("Hi there,"), "generic greeting when no name");
});
