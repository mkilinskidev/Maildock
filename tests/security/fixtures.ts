/** Local attack corpus. No mail provider is allowed to sanitize these inputs. */
export const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYqkAAAAASUVORK5CYII=",
  "base64",
);

export function attackFixtures(origin: string) {
  const u = (path: string) => `${origin}/${path}`;
  // Probes are independent: denied parent access must not abort the network or
  // execution marker before we could observe an unexpected script execution.
  const js = `document.body.setAttribute('data-executed','yes');fetch('${u("onerror")}');try{parent.document.getElementById('sentinel').textContent='PWNED'}catch{};try{localStorage.setItem('owned','yes')}catch{};try{var q=new XMLHttpRequest();q.open('GET','${u("xhr")}');q.send()}catch{};window.open('${u("popup")}');top.location='${u("navigation")}'`;
  return [
    {
      name: "execution-and-navigation",
      html: `<script>${js}</script><img src="${u("img")}" onload="${js}" onerror="${js}"><a href="jav&#x61;script:${js}">entity</a><a href="java&#9;script:alert(1)">tab</a><a href="&#106;&#97;vascript:alert(1)">numeric</a><a href="%6aavascript:alert(1)">percent</a><a href="javascript&colon;alert(1)">colon</a><a href="data:text/html,<script>alert(1)</script>">data</a><meta http-equiv="refresh" content="0;url=${u("navigation")}"><base href="${origin}/">`,
    },
    {
      name: "foreign-content-and-clobbering",
      html: `<svg onload="${js}"><script>${js}</script><use href="${u("svg-use")}#x"/><image href="${u("svg-image")}"/><foreignObject><iframe src="${u("iframe")}"></iframe></foreignObject></svg><math><mtext><table><mglyph><style><!--</style><img title="--><img src='${u("mxss")}' onerror='alert(1)'>"></math><form id="document"><input name="cookie"></form><a id="location" name="top">clobber</a>`,
    },
    {
      name: "resource-surface",
      html: `<p>resources</p><img src="${u("tracker")}" srcset="${u("srcset")} 2x"><img src="${u("redirect")}"><img src="${u("svg-as-img")}"><img src="${u("html-as-img")}"><picture><source srcset="${u("picture")}"></picture><body background="${u("body-background")}"><table background="${u("legacy-background")}"><tr><td>x</td></tr></table><link rel="stylesheet" href="${u("stylesheet")}"><link rel="preload" as="image" href="${u("preload")}"><link rel="prefetch" href="${u("prefetch")}"><link rel="dns-prefetch" href="${origin}"><iframe src="${u("iframe")}" srcdoc="<script>alert(1)</script>"></iframe><frame src="${u("frame")}"><object data="${u("object")}"></object><embed src="${u("embed")}"><video src="${u("media")}" poster="${u("poster")}"><source src="${u("source")}"><track src="${u("track")}"></video><audio src="${u("audio")}"></audio><form action="${u("form")}"><input type="submit"></form>`,
    },
    {
      name: "css-differentials",
      html: `<style>@import "${u("css-import")}";@import url(${u("css-import-url")});@font-face{font-family:evil;src:url(${u("font")})}p{background-image:url(${u("css-background")});list-style:url(${u("list-style")});cursor:url(${u("cursor")}),auto;color:red}p{background:u\\72l(${u("css-escape")});font-family:u/**/rl(${u("css-comment")});width:expression(alert(1));font:12px image-set("${u("image-set")}" 1x)}@media screen{p{padding:2px;color:rgb(1,2,3)}}@\\69mport '${u("escaped-import")}';</style><p style="background:url('${u("inline-background")}');font-family:u\\000072l('${u("inline-escape")}');color:blue;--x:url(${u("custom-property")});width:var(--x)">CSS</p>`,
    },
    {
      name: "parser-mutations",
      html: `<noscript><p title="</noscript><img src='${u("noscript")}' onerror='alert(1)'>">x</p></noscript><textarea></textarea><xmp><img src="${u("xmp")}"></xmp><table><p><style><!--</style><img src="${u("nested-img")}"></p></table><select><option><style></select><img src="${u("select-img")}" onerror="${js}"><p title="&quot; onmouseover=&quot;alert(1)">quote</p>`,
    },
    {
      name: "url-and-forged-capabilities",
      html: `<p>URL encodings</p><img src="h&#116;tp://${new URL(origin).host}/entity"><img src="${u("encoded%2Fimg")}"><img src="${u("query-img")}?x=&quot;&amp;y=1"><img src="//${new URL(origin).host}/protocol-relative"><img src="http://user:pass@${new URL(origin).host}/credential"><img src="/%2f%2fexample.invalid/relative"><img src="data:image/svg+xml,%3Csvg onload='alert(1)'/%3E"><img data-maildock-remote="${u("forged")}" data-maildock-cid="other-message"><a href="${u("safe-link")}" ping="${u("ping")}" target="_top">safe link</a>`,
    },
  ];
}

export type MimeResource = { cid: string; type: string; bytes: Buffer };
export function hostileMime(
  html: string,
  resources: MimeResource[] = [],
  from = "Trusted Display <evil@example.test>",
) {
  const boundary = "maildock-security-boundary";
  return [
    `From: ${from}`,
    "To: owner@example.test",
    "Subject: Local security fixture",
    "MIME-Version: 1.0",
    `Content-Type: multipart/related; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html).toString("base64"),
    ...resources.flatMap((r) => [
      `--${boundary}`,
      `Content-Type: ${r.type}`,
      `Content-ID: ${r.cid}`,
      "Content-Disposition: inline",
      "Content-Transfer-Encoding: base64",
      "",
      r.bytes.toString("base64"),
    ]),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}
