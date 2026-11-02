/* EJ Racking Invoice PWA
 * Photo -> OCR -> parse -> editable invoice -> PDF export
 */
(function () {
  'use strict';

  const APP_VERSION = '1.2.0';

  // ---------- Defaults / storage ----------
  const DEFAULT_SETTINGS = {
    companyName: 'EJ RACKING ENTERPRISE',
    regNo: '002330102-D',
    address: 'B2-G-34 & 36, Jalan Pinggiran 1/3, Taman Pinggiran Putra,\n43300 Seri Kembangan, Selangor D.E',
    tel: 'TEL / FAX : 03-89455339',
    gst: '0006 3847 6288',
    currency: 'RM',
    currencyWords: 'Ringgit Malaysia',
    nextInvNo: 4420,
    nextQtNo: 173,
    qtPrefix: 'QT-',
    visionKey: '',
    notes: '1. All cheques should be crossed and made payable to EJ RACKING ENTERPRISE.\n2. Goods sold are neither returnable nor refundable.',
    obRate: 5,
    obTransport: 200,
    obDeposit: 500,
  };

  const SETTINGS_KEY = 'ejr_settings_v1';

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return raw ? Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw)) : Object.assign({}, DEFAULT_SETTINGS);
    } catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
  }
  function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

  let settings = loadSettings();

  // ---------- DOM helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), ms);
  }

  // ---------- Tab navigation ----------
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('active'));
      $$('.view').forEach((v) => v.classList.remove('active'));
      tab.classList.add('active');
      $('#view-' + tab.dataset.view).classList.add('active');
    });
  });
  function goTo(view) {
    const tab = $(`.tab[data-view="${view}"]`);
    if (tab) tab.click();
  }

  // ---------- Image capture ----------
  let currentImageDataUrl = null;

  $('#photoInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      currentImageDataUrl = ev.target.result;
      $('#preview').src = currentImageDataUrl;
      $('#previewWrap').classList.remove('hidden');
      $('#runOcrBtn').disabled = false;
    };
    reader.readAsDataURL(file);
  });

  // ---------- OCR ----------
  $('#runOcrBtn').addEventListener('click', runOcr);

  async function runOcr() {
    if (!currentImageDataUrl) return;
    const engine = (document.querySelector('input[name="ocrEngine"]:checked') || {}).value || 'offline';
    $('#runOcrBtn').disabled = true;
    $('#ocrProgress').classList.remove('hidden');
    setOcrProgress(0, 'Starting…');

    let text = '';
    try {
      if (engine === 'cloud') {
        if (!settings.visionKey) {
          toast('No Cloud Vision API key set. Falling back to on-device OCR.');
          text = await ocrOffline();
        } else {
          setOcrProgress(30, 'Sending to Cloud Vision…');
          text = await ocrCloud(currentImageDataUrl, settings.visionKey);
          setOcrProgress(100, 'Done');
        }
      } else {
        text = await ocrOffline();
      }
    } catch (err) {
      console.error(err);
      toast('OCR failed: ' + (err.message || err));
      $('#runOcrBtn').disabled = false;
      return;
    }

    $('#rawText').textContent = text || '(no text detected)';
    $('#rawTextWrap').classList.remove('hidden');

    const invoices = parseNote(text);
    renderParsed(invoices);
    $('#runOcrBtn').disabled = false;
    toast(`Found ${invoices.length} invoice(s). Review below.`);
  }

  function setOcrProgress(pct, status) {
    $('#ocrBar').style.width = pct + '%';
    $('#ocrStatus').textContent = status;
  }

  async function ocrOffline() {
    const result = await Tesseract.recognize(currentImageDataUrl, 'eng', {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          setOcrProgress(Math.round(m.progress * 100), `Reading… ${Math.round(m.progress * 100)}%`);
        } else {
          setOcrProgress(10, m.status);
        }
      },
    });
    return result.data.text || '';
  }

  async function ocrCloud(dataUrl, apiKey) {
    const base64 = dataUrl.split(',')[1];
    const body = {
      requests: [{
        image: { content: base64 },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        imageContext: { languageHints: ['en'] },
      }],
    };
    const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (json.error) {
      const msg = json.error.message || 'Vision API error';
      if (json.error.status === 'PERMISSION_DENIED' || /API key not valid/i.test(msg)) {
        throw new Error('Vision API rejected the key. Check that the key is correct and the Cloud Vision API is enabled for its project. (' + msg + ')');
      }
      throw new Error(msg);
    }
    const r = json.responses && json.responses[0];
    if (r && r.error) throw new Error(r.error.message);
    return (r && r.fullTextAnnotation && r.fullTextAnnotation.text) || '';
  }

  // ---------- Parsing ----------
  // A note may contain multiple invoices separated by a divider or a new header
  // block (customer name + date). Heuristic: a line that is mostly letters and is
  // followed by a date-looking token starts a new invoice.

  const DATE_RE = /(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{2,4})/;
  const MONEY_RE = /(?:rm|rp|\$)?\s*([\d][\d.,]*)\s*(?:\/-|\/=)?/i;

  function parseNote(text) {
    const rawLines = (text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!rawLines.length) return [blankInvoice()];

    // Split into segments. A new invoice begins when:
    //   (a) an explicit divider line is seen (---, ___, ===), OR
    //   (b) a new "header" starts — a line that names a customer AND carries a date
    //       (that's the real signal in these notes), while we already have content.
    const segments = [];
    let current = [];
    rawLines.forEach((line) => {
      const isDivider = /^[-_=~]{3,}$/.test(line);
      const isNewHeader = startsNewInvoice(line);
      if (isDivider) {
        if (current.length) segments.push(current);
        current = [];
      } else if (isNewHeader && current.length) {
        // The header's date line is often the SECOND line of a 2-line header
        // (name on the line above). If the previous line looks like a name and
        // not an item, pull it into the new segment too.
        const prev = current[current.length - 1];
        if (prev && looksLikeHeader(prev) && !hasItemContent(current)) {
          // previous line is actually part of this new header
          current.pop();
          if (current.length) segments.push(current);
          current = [prev, line];
        } else {
          segments.push(current);
          current = [line];
        }
      } else {
        current.push(line);
      }
    });
    if (current.length) segments.push(current);

    const invoices = segments.map(segmentToInvoice).filter(Boolean);
    return invoices.length ? invoices : [blankInvoice()];
  }

  // A line starts a new invoice when it has a date AND some letters (customer name),
  // and is NOT itself an item line (no pcs/unit, not numbered).
  function startsNewInvoice(line) {
    const hasDate = DATE_RE.test(line);
    const letters = (line.match(/[a-z]/gi) || []).length;
    const isItem = /^\(?\d+[\).]/.test(line) || /\bpcs?\b|\bunit\b/i.test(line) || /(?:rm|rp)\s*\d/i.test(line);
    return hasDate && letters >= 3 && !isItem;
  }

  // True if the segment collected so far already contains an item/price line.
  function hasItemContent(lines) {
    return lines.some((l) => /\bpcs?\b|\bunit\b/i.test(l) || /(?:rm|rp)\s*\d/i.test(l) || /^\(?\d+[\).]/.test(l));
  }

  function looksLikeHeader(line) {
    // Header lines are mostly alphabetic words (a business/customer name), few digits.
    const letters = (line.match(/[a-z]/gi) || []).length;
    const digits = (line.match(/\d/g) || []).length;
    return letters >= 4 && letters > digits * 2 && !/\bpcs?\b|\bunit\b/i.test(line);
  }

  function segmentToInvoice(lines) {
    const inv = blankInvoice();
    const nameParts = [];
    const items = [];
    let no = 1;

    let itemsStarted = false;

    lines.forEach((line) => {
      const dateMatch = line.match(DATE_RE);
      if (dateMatch && !inv.date) inv.date = normalizeDate(dateMatch[0]);

      const money = line.match(/(?:rm|rp)\s*([\d][\d.,]*)/i);
      const qtyMatch = line.match(/(\d+)\s*(pcs?|unit)/i);
      const multMatch = line.match(/x\s*([\d][\d.,]*)\s*=?/i); // e.g. "x23 = RM575"
      const isNumbered = /^\(?\d+\s*[\).]+/.test(line); // 1) 1. 1.) (1)
      const isItemLine = isNumbered || !!qtyMatch || !!money || !!multMatch;

      // Header text (customer name) — only before any item begins. This also
      // captures a name sitting on the same line as the date (e.g. "Serenia. 13/10/26").
      if (!itemsStarted && !isItemLine) {
        const nameText = line.replace(DATE_RE, '').replace(/[.,]\s*$/, '').trim();
        if (nameText) nameParts.push(nameText);
        return;
      }

      // A numbered line starts a NEW item; subsequent item-ish lines append to it
      // (so "Shopping Basket" + "Black -25pcs" + "x23 =RM575" become ONE item).
      if (isNumbered || !itemsStarted) {
        itemsStarted = true;
        items.push({ no: no++, code: 'OTHER', desc: '', qty: null, unit: 'UNIT', price: 0, discount: '', amount: 0, _total: null });
      }
      const it = items[items.length - 1];

      if (qtyMatch) {
        it.qty = parseFloat(qtyMatch[1]);
        it.unit = /unit/i.test(qtyMatch[2]) ? 'UNIT' : 'PCS';
      }
      // "x23" multiplier (not a RM amount) = unit price
      if (multMatch && !/(?:rm|rp)/i.test(multMatch[0])) it.price = parseNum(multMatch[1]);
      // Money: "= RM575" or money appearing after a known price is a total; else unit price
      if (money) {
        const val = parseNum(money[1]);
        if (/=/.test(line) || it.price) it._total = val;
        else it.price = val;
      }

      // Description = line with numbering / qty / multiplier / money / date stripped out
      const descPart = line
        .replace(/^\(?\d+\s*[\).]+\s*/, '')
        .replace(/\d+\s*(pcs?|unit)\b/i, '')
        .replace(/x\s*[\d][\d.,]*\s*=?/i, '')
        .replace(/(?:rm|rp)\s*[\d][\d.,]*\s*(?:\/-|\/=)?/i, '')
        .replace(DATE_RE, '')
        .replace(/^[-=/.\s]+|[-=/.\s]+$/g, '') // trim stray punctuation at ends
        .trim();
      if (descPart) it.desc = (it.desc ? it.desc + ' ' : '') + descPart;
    });

    // Finalize each item's qty / price / amount from the gathered pieces.
    items.forEach((it) => {
      if (it.qty == null) it.qty = 1;
      if (it._total != null) {
        it.amount = +it._total.toFixed(2);
        if (!it.price && it.qty) it.price = +(it._total / it.qty).toFixed(2);
      } else {
        it.amount = +(it.qty * it.price).toFixed(2);
      }
      it.desc = (it.desc || 'Item').replace(/\s{2,}/g, ' ').replace(/\s+([.,])/g, '$1').trim();
      delete it._total;
    });

    inv.custName = (nameParts[0] || '').toUpperCase();
    inv.custAddress = nameParts.slice(1).join('\n');
    inv.items = items.length ? items : [blankItem(1)];
    recalc(inv);
    return inv;
  }

  function normalizeDate(s) {
    const m = s.match(DATE_RE);
    if (!m) return s;
    let [_, d, mo, y] = m;
    if (y.length === 2) y = '20' + y;
    return `${pad2(d)}/${pad2(mo)}/${y}`;
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function parseNum(s) { return parseFloat(String(s).replace(/,/g, '')) || 0; }

  // ---------- Invoice model ----------
  function blankItem(no) {
    return { no: no || 1, code: 'OTHER', desc: '', qty: 1, unit: 'UNIT', price: 0, discount: '', amount: 0 };
  }
  function blankInvoice(docType) {
    return {
      docType: docType || 'invoice', // 'invoice' | 'quotation'
      invNo: '', date: '', terms: 'C.O.D', yourRef: '', doNo: '',
      custName: '', custAddress: '', custAttn: '', custTel: '',
      items: [blankItem(1)], taxRate: 0, gross: 0, tax: 0, total: 0,
      // quotation-only
      qtValidity: '', qtDelivery: '', qtPayment: 'C.O.D.',
    };
  }

  function recalc(inv) {
    let gross = 0;
    inv.items.forEach((it) => {
      const disc = parseNum(it.discount);
      it.amount = +((it.qty * it.price) - disc).toFixed(2);
      gross += it.amount;
    });
    inv.gross = +gross.toFixed(2);
    inv.tax = +(inv.gross * (inv.taxRate || 0) / 100).toFixed(2);
    inv.total = +(inv.gross + inv.tax).toFixed(2);
    return inv;
  }

  // ---------- Parsed list rendering ----------
  function renderParsed(invoices) {
    const wrap = $('#parsedWrap');
    const list = $('#parsedList');
    list.innerHTML = '';
    invoices.forEach((inv, i) => {
      const div = document.createElement('div');
      div.className = 'parsed-item';
      const linesHtml = inv.items.map((it) =>
        `<li>${escapeHtml(it.desc || 'Item')} — qty ${it.qty}, ${settings.currency} ${it.price} = ${settings.currency} ${it.amount.toFixed(2)}</li>`
      ).join('');
      div.innerHTML = `
        <h4>${escapeHtml(inv.custName || 'Invoice ' + (i + 1))}</h4>
        <div class="parsed-meta">${inv.date ? 'Date: ' + escapeHtml(inv.date) : 'No date detected'} · ${inv.items.length} item(s) · Total ${settings.currency} ${inv.total.toFixed(2)}</div>
        <ul class="parsed-lines">${linesHtml}</ul>
        <button class="btn primary small">Edit this invoice</button>
      `;
      div.querySelector('button').addEventListener('click', () => {
        loadInvoiceIntoEditor(inv);
        goTo('invoice');
      });
      list.appendChild(div);
    });
    wrap.style.display = 'block';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Offer Bin quotation ----------
  const OFFER_BIN_SAMPLE = [
    'Company Name: Private Structure International Sdn Bhd',
    'Check In Date: 03/09',
    'Set-Up Time: 03/09',
    'Check Out Date: 06/09',
    'Dismantle Time: 07/09',
    'Quantity: 40',
    'Canvas: Yes / No : NO',
    'Delivery Address: Taman Shamelin Perkasa Cheras',
    'Contact: 0197905098',
    'Person in Charge: Fion',
  ].join('\n');

  // Parse the fixed customer template into a structured object.
  function parseOfferBin(text) {
    const get = (label) => {
      const re = new RegExp(label + '\\s*:?\\s*(.*)', 'i');
      const line = (text || '').split(/\r?\n/).find((l) => re.test(l));
      if (!line) return '';
      let v = line.replace(re, '$1').trim();
      return v;
    };
    // Canvas may be "Yes / No : NO" — take the last Yes/No token.
    let canvasRaw = get('Canvas');
    const canvasMatch = (canvasRaw.match(/\b(yes|no)\b/gi) || []);
    const canvas = canvasMatch.length ? /yes/i.test(canvasMatch[canvasMatch.length - 1]) : false;

    return {
      company: get('Company Name'),
      checkIn: cleanDate(get('Check In Date')),
      setUp: cleanDate(get('Set-?Up Time')),
      checkOut: cleanDate(get('Check Out Date')),
      dismantle: cleanDate(get('Dismantle Time')),
      quantity: parseInt((get('Quantity').match(/\d+/) || [0])[0], 10) || 0,
      canvas: canvas,
      address: get('Delivery Address'),
      contact: get('Contact'),
      pic: get('Person in Charge'),
    };
  }

  function cleanDate(s) { return (s || '').replace(/[^0-9\/\-.]/g, '').trim(); }

  // Inclusive day count between two dd/mm (or dd/mm/yy) dates.
  function rentalDays(checkIn, checkOut) {
    const a = parseDMY(checkIn), b = parseDMY(checkOut);
    if (!a || !b) return 1;
    const ms = b - a;
    const days = Math.round(ms / 86400000) + 1; // inclusive of both ends
    return days > 0 ? days : 1;
  }
  function parseDMY(s) {
    const m = (s || '').match(/(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/);
    if (!m) return null;
    let [_, d, mo, y] = m;
    const year = y ? (y.length === 2 ? 2000 + +y : +y) : new Date().getFullYear();
    return new Date(year, +mo - 1, +d);
  }

  // Build a quotation (invoice-model) from parsed Offer Bin data + pricing.
  function buildOfferBinQuote(data, pricing) {
    const quote = blankInvoice('quotation');
    quote.custName = (data.company || '').toUpperCase();
    quote.custAddress = data.address || '';
    quote.custAttn = data.pic ? ('MS/MR ' + data.pic).toUpperCase() : '';
    quote.custTel = data.contact || '';
    quote.date = formatToday();
    quote.qtPayment = 'C.O.D.';

    const days = rentalDays(data.checkIn, data.checkOut);
    const qty = data.quantity || 0;
    const rate = parseNum(pricing.rate);              // RM / unit / day
    const unitPricePerDay = +(rate * qty).toFixed(2); // price shown per DAY
    const rentalAmount = +(unitPricePerDay * days).toFixed(2);
    const canvasTxt = data.canvas ? ' + CANVAS' : '';

    const items = [];
    items.push({
      no: 1, code: 'RENTAL',
      desc: `OFFER BIN ONLY ( USED )${canvasTxt} ${days} DAYS X RM${fmtNum(rate)} X ${qty} UNITS`,
      qty: days, unit: 'DAYS', price: unitPricePerDay, discount: '', amount: rentalAmount,
    });
    const transport = parseNum(pricing.transport);
    items.push({
      no: 2, code: 'SERVICES',
      desc: 'SERVICES - TRANSPORT ( DAY ONLY 10AM - 6.30PM )',
      qty: 1, unit: 'UNIT', price: transport, discount: '', amount: transport,
    });
    const deposit = parseNum(pricing.deposit);
    items.push({
      no: 3, code: 'OTHER',
      desc: 'FULL PAYMENT + DEPOSIT ( WILL REFUND )',
      qty: 1, unit: 'UNIT', price: deposit, discount: '', amount: deposit,
    });
    items.push({
      no: 4, code: 'OTHER',
      desc: 'INCLUDING INSTALLATION / DISMANTLE ( DAY ONLY , FOC )',
      qty: 1, unit: 'UNIT', price: 0, discount: '', amount: 0,
    });
    items.push({
      no: 5, code: 'OTHER',
      desc: `DELIVERY ADDRESS ; ${(data.address || '').toUpperCase()}`,
      qty: 1, unit: 'UNIT', price: 0, discount: '', amount: 0,
    });
    quote.items = items;
    quote.taxRate = 0;
    recalc(quote);
    return quote;
  }

  function formatToday() {
    const d = new Date();
    return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  }

  // Offer Bin UI wiring
  let pendingOfferBin = null;
  $('#fillSampleBtn').addEventListener('click', () => { $('#offerBinInput').value = OFFER_BIN_SAMPLE; });

  $('#genQuoteBtn').addEventListener('click', () => {
    const text = $('#offerBinInput').value.trim();
    if (!text) { toast('Paste the customer message first.'); return; }
    pendingOfferBin = parseOfferBin(text);
    const d = pendingOfferBin;
    const days = rentalDays(d.checkIn, d.checkOut);
    $('#offerBinSummary').innerHTML =
      `<strong>${escapeHtml(d.company || '(no company)')}</strong><br>` +
      `Qty: ${d.quantity} · Canvas: ${d.canvas ? 'Yes' : 'No'} · ` +
      `Check-in ${escapeHtml(d.checkIn || '?')} → Check-out ${escapeHtml(d.checkOut || '?')} = <strong>${days} day(s)</strong><br>` +
      `PIC: ${escapeHtml(d.pic || '-')} · Tel: ${escapeHtml(d.contact || '-')}`;
    $('#obRate').value = settings.obRate;
    $('#obTransport').value = settings.obTransport;
    $('#obDeposit').value = settings.obDeposit;
    $('#offerBinPreviewCard').style.display = 'block';
    $('#offerBinPreviewCard').scrollIntoView({ behavior: 'smooth' });
  });

  $('#buildQuoteBtn').addEventListener('click', () => {
    if (!pendingOfferBin) return;
    const pricing = {
      rate: $('#obRate').value,
      transport: $('#obTransport').value,
      deposit: $('#obDeposit').value,
    };
    const quote = buildOfferBinQuote(pendingOfferBin, pricing);
    loadInvoiceIntoEditor(quote);
    goTo('invoice');
    toast('Quotation generated. Review & edit, then Export PDF.');
  });

  // ---------- Invoice editor ----------
  let activeInvoice = blankInvoice();

  function defaultDocNumber(docType) {
    return docType === 'quotation'
      ? (settings.qtPrefix || 'QT-') + String(settings.nextQtNo).padStart(5, '0')
      : String(settings.nextInvNo);
  }

  function loadInvoiceIntoEditor(inv) {
    activeInvoice = inv;
    if (!activeInvoice.docType) activeInvoice.docType = 'invoice';
    if (!activeInvoice.invNo) activeInvoice.invNo = defaultDocNumber(activeInvoice.docType);
    $('#docType').value = activeInvoice.docType;
    $('#invNo').value = activeInvoice.invNo;
    $('#invDate').value = activeInvoice.date || '';
    $('#invTerms').value = activeInvoice.terms || '';
    $('#invYourRef').value = activeInvoice.yourRef || '';
    $('#invDoNo').value = activeInvoice.doNo || '';
    $('#custName').value = activeInvoice.custName || '';
    $('#custAddress').value = activeInvoice.custAddress || '';
    $('#custAttn').value = activeInvoice.custAttn || '';
    $('#custTel').value = activeInvoice.custTel || '';
    $('#taxRate').value = activeInvoice.taxRate || 0;
    $('#qtValidity').value = activeInvoice.qtValidity || '';
    $('#qtDelivery').value = activeInvoice.qtDelivery || '';
    $('#qtPayment').value = activeInvoice.qtPayment || 'C.O.D.';
    applyDocTypeUI(activeInvoice.docType);
    renderItems();
    updateTotals();
    if (currentImageDataUrl) {
      $('#photoRef').src = currentImageDataUrl;
      $('#photoRefCard').classList.remove('hidden');
    }
  }

  // Show/hide fields and labels based on document type.
  function applyDocTypeUI(docType) {
    const isQuote = docType === 'quotation';
    document.querySelectorAll('.invoice-only').forEach((el) => { el.style.display = isQuote ? 'none' : ''; });
    document.querySelectorAll('.quotation-only').forEach((el) => { el.style.display = isQuote ? '' : 'none'; });
    $('#docEditTitle').textContent = isQuote ? 'Edit quotation' : 'Edit invoice';
    document.querySelectorAll('.doc-num-label').forEach((el) => { el.textContent = isQuote ? 'Quotation' : 'Invoice'; });
    $('#convertBtn').style.display = isQuote ? '' : 'none';
  }

  // Bind header fields
  const fieldBindings = {
    '#invNo': 'invNo', '#invDate': 'date', '#invTerms': 'terms',
    '#invYourRef': 'yourRef', '#invDoNo': 'doNo',
    '#custName': 'custName', '#custAddress': 'custAddress',
    '#custAttn': 'custAttn', '#custTel': 'custTel',
  };
  Object.entries(fieldBindings).forEach(([sel, key]) => {
    $(sel).addEventListener('input', (e) => { activeInvoice[key] = e.target.value; });
  });

  // Quotation footer bindings
  $('#qtValidity').addEventListener('input', (e) => { activeInvoice.qtValidity = e.target.value; });
  $('#qtDelivery').addEventListener('input', (e) => { activeInvoice.qtDelivery = e.target.value; });
  $('#qtPayment').addEventListener('input', (e) => { activeInvoice.qtPayment = e.target.value; });

  // Document type switch
  $('#docType').addEventListener('change', (e) => {
    const newType = e.target.value;
    activeInvoice.docType = newType;
    // Re-number to the series default only if the current number looks like the
    // OTHER series' auto number (avoid clobbering a manually typed number).
    const looksQuote = /^[A-Za-z]/.test(activeInvoice.invNo || '');
    if ((newType === 'quotation') !== looksQuote) {
      activeInvoice.invNo = defaultDocNumber(newType);
      $('#invNo').value = activeInvoice.invNo;
    }
    applyDocTypeUI(newType);
    updateTotals();
  });

  // Convert quotation -> invoice
  $('#convertBtn').addEventListener('click', () => {
    if (activeInvoice.docType !== 'quotation') return;
    activeInvoice.docType = 'invoice';
    activeInvoice.invNo = defaultDocNumber('invoice');
    // Drop the refundable-deposit line when converting (it's not billed on an invoice).
    activeInvoice.items = activeInvoice.items.filter((it) => !/deposit/i.test(it.desc));
    activeInvoice.items.forEach((it, i) => { it.no = i + 1; });
    recalc(activeInvoice);
    loadInvoiceIntoEditor(activeInvoice);
    toast('Converted to invoice. Review the deposit/line items before export.');
  });

  $('#taxRate').addEventListener('input', (e) => {
    activeInvoice.taxRate = parseNum(e.target.value);
    recalc(activeInvoice); updateTotals();
  });

  function renderItems() {
    const body = $('#itemsBody');
    body.innerHTML = '';
    activeInvoice.items.forEach((it, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="width:34px">${idx + 1}</td>
        <td><input data-k="code" value="${escapeAttr(it.code)}" /></td>
        <td class="desc-col"><input data-k="desc" value="${escapeAttr(it.desc)}" /></td>
        <td style="width:60px"><input data-k="qty" type="number" step="any" value="${it.qty}" /></td>
        <td style="width:64px"><input data-k="unit" value="${escapeAttr(it.unit)}" /></td>
        <td style="width:90px"><input data-k="price" type="number" step="any" value="${it.price}" /></td>
        <td style="width:80px"><input data-k="discount" value="${escapeAttr(it.discount)}" /></td>
        <td class="amount-cell" data-amount>${it.amount.toFixed(2)}</td>
        <td style="width:34px"><button class="row-del" title="Delete">&times;</button></td>
      `;
      tr.querySelectorAll('input').forEach((inp) => {
        inp.addEventListener('input', () => {
          const k = inp.dataset.k;
          it[k] = (k === 'qty' || k === 'price') ? parseNum(inp.value) : inp.value;
          recalc(activeInvoice);
          tr.querySelector('[data-amount]').textContent = it.amount.toFixed(2);
          updateTotals();
        });
      });
      tr.querySelector('.row-del').addEventListener('click', () => {
        activeInvoice.items.splice(idx, 1);
        if (!activeInvoice.items.length) activeInvoice.items.push(blankItem(1));
        recalc(activeInvoice); renderItems(); updateTotals();
      });
      body.appendChild(tr);
    });
  }

  function escapeAttr(s) { return escapeHtml(s == null ? '' : s); }

  $('#addItemBtn').addEventListener('click', () => {
    activeInvoice.items.push(blankItem(activeInvoice.items.length + 1));
    renderItems(); updateTotals();
  });
  $('#newInvoiceBtn').addEventListener('click', () => {
    loadInvoiceIntoEditor(blankInvoice());
    $('#photoRefCard').classList.add('hidden');
  });

  function updateTotals() {
    recalc(activeInvoice);
    $('#grossOut').textContent = activeInvoice.gross.toFixed(2);
    $('#taxOut').textContent = activeInvoice.tax.toFixed(2);
    $('#totalOut').textContent = activeInvoice.total.toFixed(2);
    $('#amountWords').value = amountToWords(activeInvoice.total, settings.currencyWords);
  }

  // ---------- Amount in words ----------
  function amountToWords(amount, currencyLabel) {
    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
      'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    function below1000(n) {
      let s = '';
      if (n >= 100) { s += ones[Math.floor(n / 100)] + ' Hundred '; n %= 100; }
      if (n >= 20) { s += tens[Math.floor(n / 10)] + ' '; n %= 10; }
      if (n > 0) s += ones[n] + ' ';
      return s.trim();
    }
    function toWords(n) {
      if (n === 0) return 'Zero';
      const units = [['Billion', 1e9], ['Million', 1e6], ['Thousand', 1e3], ['', 1]];
      let s = '';
      for (const [name, val] of units) {
        if (n >= val) {
          const chunk = Math.floor(n / val);
          s += below1000(chunk) + (name ? ' ' + name + ' ' : ' ');
          n %= val;
        }
      }
      return s.replace(/\s+/g, ' ').trim();
    }
    const whole = Math.floor(amount);
    const cents = Math.round((amount - whole) * 100);
    let words = `${currencyLabel}: ${toWords(whole)}`;
    if (cents > 0) words += ` And Cents ${toWords(cents)}`;
    words += ' Only';
    return words;
  }

  // ---------- PDF export ----------
  $('#exportPdfBtn').addEventListener('click', exportPdf);

  function exportPdf() {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      toast('PDF library did not load. Check your internet connection and reload the app.');
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const M = 12;
    let y = M;

    const isQuote = activeInvoice.docType === 'quotation';
    const centerX = pageW / 2;

    // ---- Centered serif company header (matches EJ Racking letterhead) ----
    doc.setFont('times', 'bold'); doc.setFontSize(15);
    doc.text(settings.companyName + (settings.regNo ? `  (${settings.regNo})` : ''), centerX, y + 2, { align: 'center' });
    y += 6;
    doc.setFont('times', 'normal'); doc.setFontSize(9.5);
    settings.address.split('\n').forEach((ln) => { doc.text(ln, centerX, y, { align: 'center' }); y += 4.3; });
    if (settings.tel) { doc.text(settings.tel, centerX, y, { align: 'center' }); y += 4.3; }
    if (settings.gst) { doc.text('(GST No.: ' + settings.gst + ')', centerX, y, { align: 'center' }); y += 4.3; }

    // Document title (right, serif bold) — vertically near the header top
    doc.setFont('times', 'bold'); doc.setFontSize(13);
    const title = (isQuote ? 'QUOTATION : ' : 'INVOICE : ') + (activeInvoice.invNo || '');
    doc.text(title, pageW - M, M + 6, { align: 'right' });

    y += 2;
    doc.setDrawColor(40); doc.setLineWidth(0.5);
    doc.line(M, y, pageW - M, y);
    y += 6;

    // ---- Bill-to (left, with L-bracket) + meta (right) ----
    const topY = y;
    const custLines = [];
    if (activeInvoice.custName) custLines.push({ t: activeInvoice.custName, b: true });
    (activeInvoice.custAddress || '').split('\n').forEach((ln) => { if (ln) custLines.push({ t: ln, b: false }); });
    if (activeInvoice.custAttn) custLines.push({ t: 'Attn : ' + activeInvoice.custAttn, b: false });
    if (activeInvoice.custTel || true) custLines.push({ t: 'Tel : ' + (activeInvoice.custTel || '') + '        FAX :', b: false });

    let cy = topY;
    custLines.forEach((ln) => {
      doc.setFont('times', ln.b ? 'bold' : 'normal'); doc.setFontSize(9.5);
      doc.text(ln.t, M + 3, cy + 3);
      cy += 4.6;
    });
    // L-shaped brackets around the bill-to block
    const boxTop = topY - 1, boxBot = cy + 1, bl = M, brk = 6;
    doc.setDrawColor(40); doc.setLineWidth(0.3);
    // top-left corner
    doc.line(bl, boxTop, bl + brk, boxTop); doc.line(bl, boxTop, bl, boxTop + brk);
    // bottom-left corner
    doc.line(bl, boxBot, bl + brk, boxBot); doc.line(bl, boxBot, bl, boxBot - brk);
    const brRight = M + 85;
    // top-right corner
    doc.line(brRight - brk, boxTop, brRight, boxTop); doc.line(brRight, boxTop, brRight, boxTop + brk);
    // bottom-right corner
    doc.line(brRight - brk, boxBot, brRight, boxBot); doc.line(brRight, boxBot, brRight, boxBot - brk);

    // meta right column
    const metaX = pageW - 72;
    let my = topY + 3;
    const meta = isQuote ? [
      ['Your Ref', activeInvoice.yourRef || ''],
      ['Our Ref', activeInvoice.doNo || ''],
      ['C. C.', ''],
      ['Date', activeInvoice.date || ''],
      ['Page', '1 of 1'],
    ] : [
      ['Your Ref', activeInvoice.yourRef || ''],
      ['Our D/O No', activeInvoice.doNo || ''],
      ['Terms', activeInvoice.terms || ''],
      ['Date', activeInvoice.date || ''],
      ['Page', '1 of 1'],
    ];
    doc.setFontSize(9.5);
    meta.forEach(([k, v]) => {
      doc.setFont('times', 'bold'); doc.text(k, metaX, my);
      doc.setFont('times', 'normal'); doc.text(': ' + v, metaX + 24, my);
      my += 4.8;
    });

    y = Math.max(cy, my) + 4;

    // Intro line (both docs use the same phrasing on the sample)
    doc.setFont('times', 'normal'); doc.setFontSize(9.5);
    doc.text('Thank you for your Inquiry. We are pleased to submit our quote as follows:', M, y);
    y += 5;

    // ---- Items table: plain, minimal borders, serif, roomy ----
    const cur = settings.currency;
    const rows = activeInvoice.items.map((it, i) => [
      i + 1, it.code || '', it.desc || '',
      fmtNum(it.qty), it.unit || '',
      fmtMoney(it.price), it.discount || '',
      fmtMoney(it.amount),
    ]);
    doc.autoTable({
      startY: y,
      head: [['No', 'Item Code', 'Description', 'Qty', 'Unit', 'Price/Unit', 'Disc', 'Amount']],
      body: rows,
      theme: 'plain',
      styles: { font: 'times', fontSize: 9, cellPadding: { top: 1.8, bottom: 1.8, left: 1.5, right: 1.5 }, textColor: 20, valign: 'top' },
      headStyles: { font: 'times', fontStyle: 'bold', fontSize: 9, textColor: 20 },
      // Draw only the header underline and a top line; keep body clean like the sample.
      didParseCell: function (data) {
        if (data.section === 'head') { data.cell.styles.lineWidth = { top: 0.3, bottom: 0.3, left: 0, right: 0 }; data.cell.styles.lineColor = [40, 40, 40]; }
      },
      columnStyles: {
        0: { cellWidth: 9, halign: 'center' },
        1: { cellWidth: 22 },
        2: { cellWidth: 'auto' },
        3: { cellWidth: 12, halign: 'right' },
        4: { cellWidth: 14 },
        5: { cellWidth: 22, halign: 'right' },
        6: { cellWidth: 14, halign: 'right' },
        7: { cellWidth: 24, halign: 'right' },
      },
      margin: { left: M, right: M },
    });
    // Bottom rule under the whole table
    {
      const by = doc.lastAutoTable.finalY;
      doc.setDrawColor(40); doc.setLineWidth(0.3);
      doc.line(M, by, pageW - M, by);
    }

    let ty = doc.lastAutoTable.finalY + 6;

    if (isQuote) {
      // ----- Quotation footer -----
      const termsY = ty;
      doc.setFontSize(9.5);
      doc.setFont('times', 'bold'); doc.text('Validity', M, ty); doc.setFont('times', 'normal'); doc.text(': ' + (activeInvoice.qtValidity || ''), M + 30, ty); ty += 5.5;
      doc.setFont('times', 'bold'); doc.text('Delivery Term', M, ty); doc.setFont('times', 'normal'); doc.text(': ' + (activeInvoice.qtDelivery || ''), M + 30, ty); ty += 5.5;
      doc.setFont('times', 'bold'); doc.text('Payment Term', M, ty); doc.setFont('times', 'normal'); doc.text(': ' + (activeInvoice.qtPayment || ''), M + 30, ty); ty += 5.5;

      // Total (RM) label + boxed value on the right, aligned with the terms block
      doc.setFont('times', 'bold'); doc.setFontSize(11);
      doc.text('Total (' + cur + ')', pageW - 62, termsY + 3);
      doc.setDrawColor(40); doc.setLineWidth(0.4);
      doc.rect(pageW - 37, termsY - 2.5, 25, 8);
      doc.text(fmtMoney(activeInvoice.total), pageW - 14, termsY + 3, { align: 'right' });

      ty += 2;
      doc.setFont('times', 'bold'); doc.setFontSize(9);
      doc.text('Note : Prices are subjected to change without prior notice.', M, ty); ty += 7;
      doc.setFont('times', 'normal');
      doc.text('We hope that our quotation is favourable to you and looking forward to receive your valued orders in due course.', M, ty); ty += 5.5;
      doc.text('Thank and regards.', M, ty); ty += 11;

      doc.text('Yours faithfully,', M, ty);
      doc.text('We confirm the order by accepting the terms', pageW - 82, ty);
      doc.text('& conditions stated above.', pageW - 82, ty + 4.5);
      ty += 24;
      doc.setLineWidth(0.3); doc.setDrawColor(120);
      doc.line(M, ty, M + 58, ty);
      doc.text('Authorised Signature', M, ty + 4.5);
      doc.line(pageW - 72, ty, pageW - 12, ty);
      doc.text('Person incharge :', pageW - 72, ty + 4.5);
      doc.text('Date :', pageW - 72, ty + 9.5);
    } else {
      // ----- Invoice footer -----
      doc.setFont('times', 'normal'); doc.setFontSize(9.5);
      const words = amountToWords(activeInvoice.total, settings.currencyWords);
      const wLines = doc.splitTextToSize(words, pageW - 82);
      doc.text(wLines, M, ty);

      const tX = pageW - 62, vX = pageW - M;
      const totals = [
        ['Gross (' + cur + ')', fmtMoney(activeInvoice.gross)],
        ['Sales Tax (' + cur + ')', fmtMoney(activeInvoice.tax)],
        ['Total (' + cur + ')', fmtMoney(activeInvoice.total)],
      ];
      let tyTot = ty;
      totals.forEach(([k, v], i) => {
        doc.setFont('times', i === 2 ? 'bold' : 'normal');
        doc.text(k, tX, tyTot); doc.text(v, vX, tyTot, { align: 'right' });
        tyTot += 5.5;
      });
      ty = Math.max(ty + wLines.length * 5, tyTot) + 6;

      doc.setFont('times', 'normal'); doc.setFontSize(8.5);
      doc.text('Notes:', M, ty); ty += 4.5;
      (settings.notes || '').split('\n').forEach((ln) => { if (ln) { doc.text(ln, M, ty); ty += 4.5; } });

      ty += 16;
      doc.setLineWidth(0.3); doc.setDrawColor(120);
      doc.line(M, ty, M + 58, ty);
      doc.text('Authorised Signature', M, ty + 4.5);
    }

    const prefix = isQuote ? 'Quotation' : 'Invoice';
    const fname = `${prefix}_${(activeInvoice.invNo || 'draft')}_${(activeInvoice.custName || '').replace(/[^a-z0-9]/gi, '_').slice(0, 20) || 'customer'}.pdf`;
    doc.save(fname);

    // Advance the relevant number series if the exported number matches the next auto value.
    if (isQuote) {
      const m = String(activeInvoice.invNo).match(/(\d+)\s*$/);
      const num = m ? parseInt(m[1], 10) : NaN;
      if (!isNaN(num) && num >= settings.nextQtNo) {
        settings.nextQtNo = num + 1;
        saveSettings(settings);
        $('#setNextQtNo').value = settings.nextQtNo;
      }
    } else {
      const num = parseInt(activeInvoice.invNo, 10);
      if (!isNaN(num) && num >= settings.nextInvNo) {
        settings.nextInvNo = num + 1;
        saveSettings(settings);
        $('#setNextInvNo').value = settings.nextInvNo;
      }
    }
    toast('PDF exported: ' + fname);
  }

  function fmtMoney(n) {
    const v = parseNum(n);
    return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtNum(n) {
    const v = parseNum(n);
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }

  // ---------- Settings UI ----------
  function fillSettingsForm() {
    $('#setCompanyName').value = settings.companyName;
    $('#setRegNo').value = settings.regNo;
    $('#setAddress').value = settings.address;
    $('#setTel').value = settings.tel;
    $('#setGst').value = settings.gst;
    $('#setCurrency').value = settings.currency;
    $('#setCurrencyWords').value = settings.currencyWords;
    $('#setNextInvNo').value = settings.nextInvNo;
    $('#setNextQtNo').value = settings.nextQtNo;
    $('#setQtPrefix').value = settings.qtPrefix;
    $('#setObRate').value = settings.obRate;
    $('#setObTransport').value = settings.obTransport;
    $('#setObDeposit').value = settings.obDeposit;
    $('#setVisionKey').value = settings.visionKey;
    $('#setNotes').value = settings.notes;
    $('#appVersion').textContent = APP_VERSION;
  }

  $('#saveSettingsBtn').addEventListener('click', () => {
    settings.companyName = $('#setCompanyName').value;
    settings.regNo = $('#setRegNo').value;
    settings.address = $('#setAddress').value;
    settings.tel = $('#setTel').value;
    settings.gst = $('#setGst').value;
    settings.currency = $('#setCurrency').value || 'RM';
    settings.currencyWords = $('#setCurrencyWords').value || 'Ringgit Malaysia';
    settings.nextInvNo = parseInt($('#setNextInvNo').value, 10) || settings.nextInvNo;
    settings.nextQtNo = parseInt($('#setNextQtNo').value, 10) || settings.nextQtNo;
    settings.qtPrefix = $('#setQtPrefix').value || 'QT-';
    settings.obRate = parseNum($('#setObRate').value);
    settings.obTransport = parseNum($('#setObTransport').value);
    settings.obDeposit = parseNum($('#setObDeposit').value);
    settings.visionKey = $('#setVisionKey').value.trim();
    settings.notes = $('#setNotes').value;
    saveSettings(settings);
    const msg = $('#settingsSaved');
    msg.classList.remove('hidden');
    setTimeout(() => msg.classList.add('hidden'), 1800);
    toast('Settings saved');
  });

  // ---------- Init ----------
  fillSettingsForm();
  loadInvoiceIntoEditor(blankInvoice());

  // If a Cloud Vision key is configured, default to the Cloud OCR engine
  // (much better for cursive). Falls back to on-device if no key.
  (function preferCloudIfKey() {
    const cloudRadio = document.querySelector('input[name="ocrEngine"][value="cloud"]');
    const offlineRadio = document.querySelector('input[name="ocrEngine"][value="offline"]');
    if (settings.visionKey && cloudRadio) { cloudRadio.checked = true; }
    else if (offlineRadio) { offlineRadio.checked = true; }
  })();
})();
