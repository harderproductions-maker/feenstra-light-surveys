export function reportEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

export function reportBadge(label, tone = 'neutral') {
  const allowed = ['neutral', 'good', 'attention', 'bad'];
  return `<span class="report-badge ${allowed.includes(tone) ? tone : 'neutral'}">${reportEscape(label)}</span>`;
}

export const reportStyles = `
  *{box-sizing:border-box}
  @page{size:A4;margin:15mm}
  body{max-width:960px;margin:32px auto;padding:32px;color:#242039;background:#fff;font:13px/1.6 Arial,Helvetica,sans-serif;overflow-wrap:anywhere}
  .report-header{border-top:5px solid #6d35b1;padding:20px 0 22px;border-bottom:1px solid #e4ddee;margin-bottom:22px}
  .report-brand{display:flex;align-items:center;gap:12px;margin-bottom:24px}
  .report-mark{display:block;width:40px;height:40px;flex:none}
  .report-brand-name{font-size:13px;font-weight:700;letter-spacing:2px;color:#3a2aa8}
  .report-brand-note{display:block;color:#736c84;font-size:10px;letter-spacing:.5px}
  .report-kicker{margin:0 0 5px;color:#6d35b1;font-size:10px;letter-spacing:1.6px;text-transform:uppercase;font-weight:700}
  h1{font-size:29px;line-height:1.2;letter-spacing:-.7px;margin:0 0 12px;color:#282044}
  .report-subtitle{font-size:16px;color:#655779;margin:0 0 18px;white-space:pre-wrap}
  .report-metadata{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 24px;margin:20px 0 0}
  .report-metadata div{min-width:0}.report-metadata dt{font-size:9px;letter-spacing:.8px;text-transform:uppercase;font-weight:700;color:#736c84}
  .report-metadata dd{margin:2px 0 0;font-size:12px;font-weight:600;white-space:pre-wrap}
  .summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:22px 0}
  .summary div{border:1px solid #e4ddee;border-top:3px solid #8a56c4;background:#f8f5fc;border-radius:5px;padding:13px 12px;min-width:0}
  .summary strong{display:block;font-size:21px;line-height:1.25;color:#3a2aa8}
  .summary span{display:block;font-size:10px;color:#655779;margin-top:6px}
  h2{color:#3a2aa8;font-size:17px;line-height:1.4;margin:25px 0 12px;break-after:avoid-page}
  h3{color:#655779;font-size:11px;text-transform:uppercase;letter-spacing:.7px;margin:20px 0 8px;break-after:avoid-page}
  p{margin:9px 0;white-space:pre-wrap;orphans:3;widows:3}
  table{width:100%;border-collapse:collapse;font-size:11px;margin:14px 0 20px;table-layout:auto}
  th,td{border:0;border-bottom:1px solid #e4ddee;padding:10px 9px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
  th{color:#463261;background:#f0e9f8;font-size:9px;letter-spacing:.35px;text-transform:uppercase;font-weight:700}
  tbody tr:nth-child(even){background:#faf8fd}thead{display:table-header-group}
  tr{break-inside:avoid-page}td small{display:block;color:#736c84;line-height:1.5;margin-top:5px;font-size:9px}
  .n{text-align:right;font-variant-numeric:tabular-nums}
  .report-check,.entry,.machine-record{border-top:1px solid #e4ddee;padding:8px 0 18px;margin-top:20px}
  .report-check>h2,.entry>h2,.machine-record>h2{margin-top:12px}
  .notes{background:#f8f5fc;border-left:3px solid #b89ad9;padding:12px 14px;white-space:pre-wrap}
  .report-badge{display:inline-block;border:1px solid #dcd1eb;border-radius:4px;padding:3px 7px;background:#f5f0fa;color:#594172;font-size:10px;font-weight:700;line-height:1.5}
  .report-badge.good{color:#22614c;background:#eef7f2;border-color:#c5dfd1}
  .report-badge.attention{color:#80520d;background:#fff7e7;border-color:#ead6aa}
  .report-badge.bad{color:#9e343f;background:#fff1f3;border-color:#ecc7ce}
  .report-notice{border:1px solid #ead6aa;border-left:4px solid #ad7727;background:#fff9ed;color:#6b4c1c;padding:12px 15px;margin:20px 0;font-size:11px;break-inside:avoid-page}
  figure{display:inline-block;width:47%;margin:8px 2% 16px 0;vertical-align:top;padding:10px;border:1px solid #e4ddee;border-radius:5px;break-inside:avoid-page}
  figure img{display:block;width:100%;max-height:270px;object-fit:contain;background:#f8f6fb}
  figcaption{font-size:10px;color:#736c84;line-height:1.5;margin-top:8px}
  .history-item{padding:10px 14px;border-left:2px solid #d7c6ea;margin:12px 0}
  ul{padding-left:20px}li{margin:6px 0}details img{margin-top:10px}
  .audit-record{border:1px solid #e4ddee;border-radius:5px;padding:0 16px 12px;margin:20px 0;font-size:10px;color:#655779}
  .audit-record h2{font-size:13px;margin-top:14px}
  .total{text-align:right;font-size:19px;color:#3a2aa8;padding:16px;background:#f8f5fc;border-top:2px solid #8a56c4}
  .report-footer,.disclaimer{font-size:10px;line-height:1.6;color:#736c84;margin-top:28px;padding-top:12px;border-top:1px solid #e4ddee}
  .report-footer{display:flex;justify-content:space-between;gap:20px;font-size:9px}
  .report-page+.report-page{break-before:page}
  .no-print{font:inherit;color:#fff;background:#3a2aa8;border:0;border-radius:5px;padding:10px 16px;cursor:pointer;margin:0 0 20px}
  @media(max-width:600px){body{margin:0;padding:20px 14px}h1{font-size:25px}.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.report-metadata{grid-template-columns:1fr}th,td{padding:7px 5px}figure{width:100%;margin-right:0}}
  @media print{body{max-width:none;margin:0;padding:0;font-size:11px}.no-print{display:none!important}.report-header{padding-top:14px}.report-brand{margin-bottom:18px}h1{font-size:25px}.summary{grid-template-columns:repeat(4,minmax(0,1fr));break-inside:avoid-page}.report-metadata{grid-template-columns:repeat(2,minmax(0,1fr))}figure{width:47%;margin-right:2%}.report-footer{break-inside:avoid-page}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
`;

export function reportContent({ title, subtitle = '', category = 'Management report', metadata = [], summary = [], notice = '', body = '', footer = '' }) {
  return `<header class="report-header">
    <div class="report-brand"><svg class="report-mark" viewBox="0 0 512 512" aria-hidden="true"><rect x="16" y="16" width="480" height="480" rx="112" fill="#171232"/><path d="M160 368V144h120l72 72v48l-72 72h-56v-56h32l40-40-40-40h-40v112l-56 56Z" fill="#ab92fa"/><path d="m256 200 40 40-40 40h-32v56h56l72-72v-48l-56 24-40-40Z" fill="#65b4f7"/></svg><div><span class="report-brand-name">PRIMEOPS</span><span class="report-brand-note">PROPERTY &amp; OPERATIONS</span></div></div>
    <p class="report-kicker">${reportEscape(category)}</p><h1>${reportEscape(title)}</h1>
    ${subtitle ? `<p class="report-subtitle">${reportEscape(subtitle)}</p>` : ''}
    ${metadata.length ? `<dl class="report-metadata">${metadata.map(([label, value]) => `<div><dt>${reportEscape(label)}</dt><dd>${reportEscape(value ?? 'Not recorded')}</dd></div>`).join('')}</dl>` : ''}
    </header>
    ${notice ? `<aside class="report-notice">${reportEscape(notice)}</aside>` : ''}
    ${summary.length ? `<section class="summary" aria-label="Report summary">${summary.map(([label, value]) => `<div><strong>${reportEscape(value)}</strong><span>${reportEscape(label)}</span></div>`).join('')}</section>` : ''}
    ${body}
    ${footer ? `<p class="disclaimer">${reportEscape(footer)}</p>` : ''}
    <footer class="report-footer"><span>PRIMEOPS / ${reportEscape(category)}</span><span>Management copy &middot; Retain with property records</span></footer>`;
}

export function reportDocument(options) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${reportEscape(options.title)}${options.subtitle ? ` - ${reportEscape(options.subtitle)}` : ''}</title><style>${reportStyles}</style></head><body>${reportContent(options)}</body></html>`;
}
