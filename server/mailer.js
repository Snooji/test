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

export function confirmEmail({ name, confirmUrl, unsubscribeUrl, playUrl }) {
  const subject = 'Confirm your Starside Movers news';
  const text = `Hi ${name},\n\nThanks for clocking in at Starside Movers! Confirm you'd like game news and offers:\n${confirmUrl}\n\nJump back in any time: ${playUrl}\n\nDon't want these emails? Unsubscribe: ${unsubscribeUrl}\n`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;color:#1b1640">
  <h1 style="font-size:22px">★ Starside <span style="color:#ff8a3d">Movers</span></h1>
  <p>Hi ${esc(name)}, thanks for clocking in!</p>
  <p>Tap below to confirm you'd like Starside Movers news, new houses and offers.</p>
  <p><a href="${esc(confirmUrl)}" style="display:inline-block;background:#6b4dff;color:#fff;padding:12px 18px;border-radius:12px;text-decoration:none;font-weight:700">Confirm my email</a></p>
  <p><a href="${esc(playUrl)}">Jump back into a move</a></p>
  <p style="font-size:12px;color:#777">Didn't sign up, or changed your mind? <a href="${esc(unsubscribeUrl)}">Unsubscribe</a>.</p></div>`;
  return { subject, text, html };
}
