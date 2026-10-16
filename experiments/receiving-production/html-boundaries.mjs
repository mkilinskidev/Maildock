// Two accepted, synthetic boundary inputs shared by the wire peer and oracle.
export function htmlBoundary(kind) {
  const count = kind === "newsletter" ? 3980 : 3900;
  const sections = Array.from(
    { length: count },
    (_, i) =>
      `<section class="offer c${i % 64}" title="Offer ${i}" dir="ltr"><h2>Offer ${i}</h2><p>Details <strong>available</strong></p><a href="https://example.invalid/${i}">Read more</a><span>End ${i}</span></section>`,
  ).join("");
  let css = ".hidden{display:none}";
  if (kind === "css") {
    // 63 blocks, just below 256 KiB total CSS; multiple valid selectors/rule.
    const rule = (i) =>
      `.c${i % 64},section.offer>p,.offer strong{color:rgb(20,30,40);margin:1px;padding:2px}`;
    const blocks = Array.from({ length: 63 }, (_, block) => {
      let text = block === 0 ? css : "";
      for (let i = 0; text.length + rule(i).length < 4150; i++) text += rule(i);
      return `<style>${text}</style>`;
    });
    css = blocks.join("");
  } else css = `<style>${css}</style>`;
  return {
    html: `<html><head>${css}</head><body><h1>Boundary newsletter</h1>${sections}<p class="hidden">SECRET HIDDEN</p><img src="https://remote.invalid/image"><img src="cid:r16-inline"><script>SECRET SCRIPT</script></body></html>`,
    searchText: `Boundary newsletter ${Array.from({ length: count }, (_, i) => `Offer ${i} Details available Read moreEnd ${i}`).join(" ")}`,
    count,
  };
}
