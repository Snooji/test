// Transactional email via Resend's HTTP API. Off unless RESEND_API_KEY and MAIL_FROM are set.
export const mailerEnabled = () => !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);

export async function sendMail({ to, subject, html, text, unsubscribeUrl }) {
  if (!mailerEnabled()) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: process.env.MAIL_FROM, to: [to], subject, html, text,
      headers: unsubscribeUrl ? { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
    }),
  });
  if (!res.ok) throw new Error(`mail send failed: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
  return true;
}

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** the sign-in code: proves the person typing the email can read it */
export function codeEmail({ name, code, playUrl }) {
  const subject = `${code} is your Let’s Move It code`;
  const text = `Hi ${name},\n\nYour Let’s Move It sign-in code is ${code}. It works for 15 minutes.\n\nDidn't try to sign in? Ignore this email; nobody can play as you without the code.\n\n${playUrl}\n`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;color:#1b1640">
  <h1 style="font-size:22px">Let’s <span style="color:#ff8a3d">Move It</span></h1><p style="margin-top:-8px;color:#666">by Starside Movers</p>
  <p>Hi ${esc(name)}, here's your sign-in code:</p>
  <p style="font-size:32px;font-weight:800;letter-spacing:6px">${esc(code)}</p>
  <p>It works for 15 minutes.</p>
  <p style="font-size:12px;color:#777">Didn't try to sign in? Ignore this email; nobody can play as you without the code.</p></div>`;
  return { subject, text, html };
}

export function confirmEmail({ name, confirmUrl, unsubscribeUrl, playUrl }) {
  const subject = 'Confirm your Let’s Move It news from Starside Movers';
  const text = `Hi ${name},\n\nThanks for clocking in at Let’s Move It! Confirm you'd like game news and offers:\n${confirmUrl}\n\nJump back in any time: ${playUrl}\n\nDon't want these emails? Unsubscribe: ${unsubscribeUrl}\n`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;color:#1b1640">
  <h1 style="font-size:22px">Let’s <span style="color:#ff8a3d">Move It</span></h1><p style="margin-top:-8px;color:#666">by Starside Movers</p>
  <p>Hi ${esc(name)}, thanks for clocking in!</p>
  <p>Tap below to confirm you'd like game news, new houses and Starside Movers offers. Mention the game when you book a move and get 15% off.</p>
  <p><a href="${esc(confirmUrl)}" style="display:inline-block;background:#6b4dff;color:#fff;padding:12px 18px;border-radius:12px;text-decoration:none;font-weight:700">Confirm my email</a></p>
  <p><a href="${esc(playUrl)}">Jump back into a move</a></p>
  <p style="font-size:12px;color:#777">Didn't sign up, or changed your mind? <a href="${esc(unsubscribeUrl)}">Unsubscribe</a>.</p></div>`;
  return { subject, text, html };
}
