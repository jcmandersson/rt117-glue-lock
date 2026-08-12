import type { Application, Env } from "../types";
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
 * Utan RESEND_API_KEY skickas inget. Innehållet loggas i stället till konsolen
 * så att lokal utveckling fungerar utan mejlkonto. Det läget är avsiktligt
 * begränsat till `wrangler dev`; i produktion krävs nyckeln.
 */
async function send(env: Env, args: SendArgs): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.warn(
      `[e-post ej skickad, RESEND_API_KEY saknas]\nTill: ${args.to}\nÄmne: ${args.subject}\n\n${args.text}`,
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

/** Gemensam brevmall så alla mejl ser likadana ut. */
function layout(env: Env, heading: string, bodyHtml: string): string {
  const appName = escapeHtml(env.APP_NAME);
  return `<!doctype html>
<html lang="sv">
  <body style="margin:0;padding:24px;background:#eef3f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#142433">
    <table role="presentation" style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border-top:4px solid #0660a0">
      <tr><td>
        <p style="margin:0 0 4px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#5a6b7d">${appName}</p>
        <h1 style="margin:0 0 20px;font-size:22px">${escapeHtml(heading)}</h1>
        ${bodyHtml}
      </td></tr>
    </table>
  </body>
</html>`;
}

export async function sendLoginCode(
  env: Env,
  to: string,
  code: string,
  validMinutes: number,
): Promise<void> {
  const subject = `${code} är din kod till ${env.APP_NAME}`;

  const text = [
    `Din engångskod är: ${code}`,
    "",
    `Koden gäller i ${validMinutes} minuter och kan bara användas en gång.`,
    "",
    "Om det inte var du som försökte logga in kan du strunta i det här mejlet.",
    "Ingen kommer in utan koden.",
  ].join("\n");

  const html = layout(
    env,
    "Din engångskod",
    `<p style="margin:0 0 20px;font-size:15px;line-height:1.5">Skriv in koden nedan för att logga in.</p>
     <p style="margin:0 0 20px;font-size:34px;font-weight:700;letter-spacing:.24em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(code)}</p>
     <p style="margin:0 0 8px;font-size:14px;color:#5a6b7d">Koden gäller i ${validMinutes} minuter och kan bara användas en gång.</p>
     <p style="margin:0;font-size:14px;color:#5a6b7d">Var det inte du som försökte logga in? Då kan du strunta i det här mejlet.</p>`,
  );

  await send(env, { to, subject, text, html });
}

/** Till admins när någon skickat in en ny ansökan. */
export async function sendApplicationNotice(
  env: Env,
  to: string,
  application: Application,
): Promise<void> {
  const subject = `Ny ansökan till ${env.APP_NAME}: ${application.name}`;
  const adminUrl = `${env.APP_URL.replace(/\/+$/, "")}/admin`;

  const messageText = application.message ? `\nMeddelande: ${application.message}\n` : "";
  const text = [
    `${application.name} har ansökt om åtkomst till lokalen.`,
    "",
    `E-post: ${application.email}`,
    `Klubb: ${application.club}`,
    messageText,
    `Godkänn eller avslå på adminsidan: ${adminUrl}`,
  ].join("\n");

  const messageHtml = application.message
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;padding:12px;background:#eef3f8;border-radius:8px">${escapeHtml(application.message)}</p>`
    : "";

  const html = layout(
    env,
    "Ny ansökan om åtkomst",
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.5"><strong>${escapeHtml(application.name)}</strong> har ansökt om åtkomst till lokalen.</p>
     <p style="margin:0 0 4px;font-size:14px;color:#5a6b7d">E-post: ${escapeHtml(application.email)}</p>
     <p style="margin:0 0 16px;font-size:14px;color:#5a6b7d">Klubb: ${escapeHtml(application.club)}</p>
     ${messageHtml}
     <p style="margin:0"><a href="${adminUrl}" style="display:inline-block;padding:12px 20px;background:#0660a0;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Öppna adminsidan</a></p>`,
  );

  await send(env, { to, subject, text, html });
}

/** Till den sökande när en admin har godkänt. */
export async function sendApplicationApproved(
  env: Env,
  to: string,
  name: string,
): Promise<void> {
  const subject = `Välkommen! Du har nu tillgång till ${env.APP_NAME}`;
  const url = env.APP_URL.replace(/\/+$/, "");

  const text = [
    `Hej ${name}!`,
    "",
    "Din ansökan är godkänd. Du kan nu logga in och låsa upp dörren:",
    url,
    "",
    "Logga in med den här e-postadressen, med Google eller med en engångskod.",
  ].join("\n");

  const html = layout(
    env,
    "Din ansökan är godkänd",
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.5">Hej ${escapeHtml(name)}!</p>
     <p style="margin:0 0 20px;font-size:15px;line-height:1.5">Du kan nu logga in med den här e-postadressen och låsa upp dörren.</p>
     <p style="margin:0"><a href="${url}" style="display:inline-block;padding:12px 20px;background:#0660a0;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Till lokalen</a></p>`,
  );

  await send(env, { to, subject, text, html });
}

/** Till den sökande vid avslag. Neutralt hållet. */
export async function sendApplicationRejected(
  env: Env,
  to: string,
  name: string,
): Promise<void> {
  const subject = `Om din ansökan till ${env.APP_NAME}`;

  const text = [
    `Hej ${name}!`,
    "",
    "Din ansökan om åtkomst till lokalen har inte godkänts den här gången.",
    "Har du frågor är du välkommen att höra av dig till klubben.",
  ].join("\n");

  const html = layout(
    env,
    "Om din ansökan",
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.5">Hej ${escapeHtml(name)}!</p>
     <p style="margin:0 0 8px;font-size:15px;line-height:1.5">Din ansökan om åtkomst till lokalen har inte godkänts den här gången.</p>
     <p style="margin:0;font-size:14px;color:#5a6b7d">Har du frågor är du välkommen att höra av dig till klubben.</p>`,
  );

  await send(env, { to, subject, text, html });
}
