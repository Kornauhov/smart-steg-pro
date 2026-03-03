function norm(s) {
  return String(s || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function pick(t, re) {
  const m = t.match(re);
  return m ? m[1].trim() : "";
}

function parseGermanDateToISO(d) {
  const m = String(d || "").match(/(\d{2})\.\s*(\d{2})\.\s*(\d{4})/);
  if (!m) return d || null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

function toNum(val) {
  // OCR-Fix: O->0, I->1, l->1, S->5, B->8
  const s = String(val || "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/S/g, "5")
    .replace(/B/g, "8")
    .replace(/[^\d]/g, "");
  return s ? Number(s) : null;
}

export function parseLabelText(ocrText) {
  const t = norm(ocrText);

  const artikel = pick(t, /Artikel\s*:\s*([0-9]{3,})/i);

  const lengthRaw = pick(t, /L[äa]nge\s*:\s*([0-9OISBL ]{3,})/i);
  const qtyRaw = pick(t, /Menge\s*:\s*([0-9OISBL ]{1,6})/i);

  const supplier = pick(t, /Lieferant\s*:\s*([A-Z0-9ÄÖÜ _-]{2,})/i);
  const orderNo = pick(t, /Bestellung\s*:\s*([A-Z0-9\/_-]{3,})/i);
  const dateStr = pick(t, /Datum\s*:\s*([0-9]{2}\.\s*[0-9]{2}\.\s*[0-9]{4})/i);

  return {
    itemKey: artikel || null,
    lengthMm: toNum(lengthRaw),
    qty: toNum(qtyRaw),
    supplier: supplier || null,
    orderNo: orderNo || null,
    deliveryDate: dateStr ? parseGermanDateToISO(dateStr) : null,
    rawText: t,
  };
}
