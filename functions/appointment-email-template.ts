// Branded customer emails: dark ground, royal purple button, gold accents, logo from the site.
// Built from tables and inline styles so Gmail, Outlook, and Apple Mail all render it the same.

export type EmailContent = {
  eyebrow: string;
  heading: string;
  paragraphs: string[];
  details?: Array<[string, string]>;
  action?: { label: string; url: string };
  note?: string;
};

const PHONE = "(828) 273-3894";
const PHONE_LINK = "tel:+18282733894";
const SANS = "'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const DISPLAY = "'Archivo', 'Arial Black', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const C = {
  page: "#0a0912", card: "#13111f", panel: "#1b1830", line: "#2c2745", gold: "#e4bb5c", goldLine: "#5e4d2a",
  purple: "#6b3fd8", text: "#f5f2fb", text2: "#c9c3da", muted: "#8f89a6",
};

function escape(value: string) {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

export function emailSiteOrigin() {
  const origin = process.env.HOSTING_ORIGIN ?? "";
  return /^https:\/\/[a-z0-9.-]+$/i.test(origin) ? origin : "https://niemansdetailing.com";
}

export function emailText(content: EmailContent) {
  return [
    content.heading,
    "",
    ...content.paragraphs.flatMap(paragraph => [paragraph, ""]),
    ...(content.details?.length ? [...content.details.map(([label, value]) => `${label}: ${value}`), ""] : []),
    ...(content.action ? [`${content.action.label}: ${content.action.url}`, ""] : []),
    ...(content.note ? [content.note, ""] : []),
    "Nieman's Detailing",
    `Questions? Call or text ${PHONE}`,
    emailSiteOrigin().replace(/^https:\/\//, ""),
  ].join("\n");
}

export function emailHtml(content: EmailContent, subject: string) {
  const origin = emailSiteOrigin();
  const paragraphs = content.paragraphs.map(paragraph =>
    `<p style="margin:0 0 16px;font:400 16px/1.6 ${SANS};color:${C.text2};">${escape(paragraph)}</p>`).join("");
  const details = content.details?.length ? `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;background:${C.panel};border:1px solid ${C.goldLine};border-radius:14px;border-collapse:separate;">
${content.details.map(([label, value], index) => `<tr><td style="padding:${index ? "0" : "18px"} 20px ${index === content.details!.length - 1 ? "18px" : "14px"};">
<p style="margin:0 0 3px;font:700 11px/1.2 ${SANS};letter-spacing:1.4px;text-transform:uppercase;color:${C.gold};">${escape(label)}</p>
<p style="margin:0;font:500 16px/1.45 ${SANS};color:${C.text};">${escape(value)}</p></td></tr>`).join("")}
</table>` : "";
  const action = content.action ? `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr>
<td align="center" bgcolor="${C.purple}" style="border-radius:999px;background:${C.purple};">
<a href="${escape(content.action.url)}" target="_blank" style="display:inline-block;padding:15px 30px;font:700 16px/1 ${SANS};color:#ffffff;text-decoration:none;border-radius:999px;border:1px solid #8c66f0;">${escape(content.action.label)} &rarr;</a>
</td></tr></table>
<p style="margin:0 0 24px;font:400 12px/1.5 ${SANS};color:${C.muted};">Button not working? Paste this link into your browser:<br><a href="${escape(content.action.url)}" style="color:${C.text2};word-break:break-all;">${escape(content.action.url)}</a></p>` : "";
  const note = content.note ? `<p style="margin:0 0 8px;padding:14px 16px;border-left:3px solid ${C.gold};background:${C.panel};border-radius:0 10px 10px 0;font:400 14px/1.55 ${SANS};color:${C.text2};">${escape(content.note)}</p>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">
<title>${escape(subject)}</title>
<style>:root{color-scheme:dark;supported-color-schemes:dark}body{margin:0;padding:0;background:${C.page}}a{color:${C.gold}}
@media (max-width:620px){.nd-pad{padding-left:22px!important;padding-right:22px!important}.nd-h1{font-size:26px!important}}</style>
</head>
<body style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page};">${escape(content.paragraphs[0] ?? content.heading)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page};">
<tr><td align="center" style="padding:28px 12px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
<tr><td align="center" style="padding:6px 0 22px;">
<a href="${origin}" target="_blank" style="text-decoration:none;"><img src="${origin}/images/ND-logo-white-transparentbg-horizontal.png" width="320" height="32" alt="Nieman's Detailing" style="display:block;width:320px;max-width:100%;height:auto;border:0;color:${C.text};font:800 20px/1.2 ${DISPLAY};"></a>
</td></tr>
<tr><td bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.line};border-top:3px solid ${C.gold};border-radius:18px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="nd-pad" style="padding:34px 40px 26px;">
<p style="margin:0 0 10px;font:700 12px/1.2 ${SANS};letter-spacing:2px;text-transform:uppercase;color:${C.gold};">${escape(content.eyebrow)}</p>
<h1 class="nd-h1" style="margin:0 0 18px;font:800 30px/1.15 ${DISPLAY};letter-spacing:-0.5px;color:${C.text};">${escape(content.heading)}</h1>
${paragraphs}${details}${action}${note}
</td></tr></table>
</td></tr>
<tr><td align="center" class="nd-pad" style="padding:26px 20px 0;">
<p style="margin:0 0 6px;font:800 14px/1.4 ${DISPLAY};letter-spacing:.5px;color:${C.text};">NIEMAN'S <span style="color:${C.gold};">DETAILING</span></p>
<p style="margin:0 0 6px;font:400 13px/1.6 ${SANS};color:${C.muted};">Mobile detailing in Asheville, NC</p>
<p style="margin:0;font:400 13px/1.6 ${SANS};color:${C.muted};">Questions? Call or text <a href="${PHONE_LINK}" style="color:${C.gold};text-decoration:none;">${PHONE}</a> &middot; <a href="${origin}" style="color:${C.gold};text-decoration:none;">${escape(origin.replace(/^https:\/\//, ""))}</a></p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}
