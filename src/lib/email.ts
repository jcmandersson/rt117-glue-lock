import type { Env } from "../types";
import { AppError } from "./http";

interface SendArgs {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Skickar e-post via Resend (gratisnivå: 100 mejl/dag, 3 000/månad).
 *
 * Utan RESEND_API_KEY skickas inget — koden loggas i stället till konsolen så
 * att lokal utveckling fungerar utan mejlkonto. Det läget är avsiktligt
 * begränsat till `wrangler dev`; i produktion krävs nyckeln.
 */
async function send(env: Env, args: SendArgs): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.warn(
      `[e-post ej skickad — RESEND_API_KEY saknas]\nTill: ${args.to}\nÄmne: ${args.subject}\n\n${args.text}`,
    );
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [args.to],
      subject: args.subject,
      text: args.text,
      html: args.html,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error("resend_failed", response.status, body.slice(0, 500));
    throw new AppError(502, "Kunde inte skicka e-post just nu. Försök igen.", "email_failed");
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function sendLoginCode(
  env: Env,
  to: string,
  code: string,
  validMinutes: number,
): Promise<void> {
  const appName = escapeHtml(env.APP_NAME);
  const subject = `${code} är din kod till ${env.APP_NAME}`;

  const text = [
    `Din engångskod är: ${code}`,
    "",
    `Koden gäller i ${validMinutes} minuter och kan bara användas en gång.`,
    "",
    "Om du inte försökte logga in kan du strunta i det här mejlet. Ingen kommer",
    "in i lokalen utan koden.",
  ].join("\n");

  const html = `<!doctype html>
<html lang="sv">
  <body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#16202c">
    <table role="presentation" style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px">
      <tr><td>
        <p style="margin:0 0 4px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#5b6b7f">${appName}</p>
        <h1 style="margin:0 0 20px;font-size:22px">Din engångskod</h1>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.5">Ange koden nedan för att låsa upp dörren.</p>
        <p style="margin:0 0 20px;font-size:34px;font-weight:700;letter-spacing:.24em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(code)}</p>
        <p style="margin:0 0 8px;font-size:14px;color:#5b6b7f">Koden gäller i ${validMinutes} minuter och kan bara användas en gång.</p>
        <p style="margin:0;font-size:14px;color:#5b6b7f">Försökte du inte logga in? Då kan du strunta i det här mejlet.</p>
      </td></tr>
    </table>
  </body>
</html>`;

  await send(env, { to, subject, text, html });
}
