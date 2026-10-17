// Account emails (verification, password reset) through the Resend API. Without a key (development), the email is
// written to the console instead, so links can be opened by hand.
export interface Email {
  to: string;
  subject: string;
  text: string;
}
export type Mailer = (email: Email) => Promise<void>;

export function resendMailer({ apiKey, from, fetchImpl = fetch }: { apiKey: string; from: string; fetchImpl?: typeof fetch }): Mailer {
  return async ({ to, subject, text }) => {
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text, html: html(text) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Resend refused the email (HTTP ${response.status}).`);
  };
}

export const consoleMailer: Mailer = async ({ to, subject, text }) => {
  console.log(`[email] To: ${to}\n[email] Subject: ${subject}\n${text}\n`);
};

const escape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
// Paragraphs, with links made clickable. The text has no markup of its own.
function html(text: string) {
  const body = text
    .split(/\n{2,}/)
    .map(p => `<p>${escape(p).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1d1f23">${body}</div>`;
}

export const emails = {
  verify: (url: string): Omit<Email, "to"> => ({
    subject: "Confirm your email for Opaya",
    text: `Open this link to confirm your email address and finish your Opaya account:\n${url}\n\nThe link is valid for 24 hours. If you did not sign up for Opaya, you can ignore this email.`,
  }),
  reset: (url: string): Omit<Email, "to"> => ({
    subject: "Reset your Opaya password",
    text: `Open this link to set a new password for your Opaya account:\n${url}\n\nThe link is valid for 1 hour. If you did not ask for a new password, you can ignore this email. Your password stays the same.`,
  }),
};
