/* EJ Racking Invoice PWA
 * Photo -> OCR -> parse -> editable invoice -> PDF export
 */
(function () {
  'use strict';

  const APP_VERSION = '1.0.0';

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
    visionKey: '',
    notes: '1. All cheques should be crossed and made payable to EJ RACKING ENTERPRISE.\n2. Goods sold are neither returnable nor refundable.',
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
    if (json.error) throw new Error(json.error.message || 'Vision API error');
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
  function blankInvoice() {
    return {
      invNo: '', date: '', terms: 'C.O.D', yourRef: '', doNo: '',
      custName: '', custAddress: '', custAttn: '', custTel: '',
      items: [blankItem(1)], taxRate: 0, gross: 0, tax: 0, total: 0,
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

  // ---------- Invoice editor ----------
  let activeInvoice = blankInvoice();

  function loadInvoiceIntoEditor(inv) {
    activeInvoice = inv;
    if (!activeInvoice.invNo) activeInvoice.invNo = String(settings.nextInvNo);
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
    renderItems();
    updateTotals();
    if (currentImageDataUrl) {
      $('#photoRef').src = currentImageDataUrl;
      $('#photoRefCard').classList.remove('hidden');
    }
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
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const M = 12;
    let y = M;

    // Company header
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
    doc.text(settings.companyName + (settings.regNo ? `  (${settings.regNo})` : ''), M, y + 2);
    y += 7;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    settings.address.split('\n').forEach((ln) => { doc.text(ln, M, y); y += 4.5; });
    if (settings.tel) { doc.text(settings.tel, M, y); y += 4.5; }
    if (settings.gst) { doc.text('(GST No.: ' + settings.gst + ')', M, y); y += 4.5; }

    // INVOICE title
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
    doc.text('INVOICE : ' + (activeInvoice.invNo || ''), pageW - M, M + 2, { align: 'right' });

    y += 2;
    doc.setDrawColor(31, 58, 95); doc.setLineWidth(0.4);
    doc.line(M, y, pageW - M, y);
    y += 5;

    // Bill-to + meta
    const topY = y;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5);
    doc.text(activeInvoice.custName || '', M, y); y += 4.5;
    doc.setFont('helvetica', 'normal');
    (activeInvoice.custAddress || '').split('\n').forEach((ln) => { if (ln) { doc.text(ln, M, y); y += 4.5; } });
    if (activeInvoice.custAttn) { doc.text('Attn : ' + activeInvoice.custAttn, M, y); y += 4.5; }
    if (activeInvoice.custTel) { doc.text('Tel : ' + activeInvoice.custTel, M, y); y += 4.5; }

    // meta right column
    const metaX = pageW - 70;
    let my = topY;
    const meta = [
      ['Your Ref', activeInvoice.yourRef || ''],
      ['Our D/O No', activeInvoice.doNo || ''],
      ['Terms', activeInvoice.terms || ''],
      ['Date', activeInvoice.date || ''],
      ['Page', '1 of 1'],
    ];
    doc.setFontSize(9);
    meta.forEach(([k, v]) => {
      doc.setFont('helvetica', 'bold'); doc.text(k, metaX, my);
      doc.setFont('helvetica', 'normal'); doc.text(': ' + v, metaX + 24, my);
      my += 4.5;
    });

    y = Math.max(y, my) + 3;

    // Items table
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
      theme: 'grid',
      styles: { fontSize: 8.5, cellPadding: 1.5, lineColor: [200, 200, 200] },
      headStyles: { fillColor: [31, 58, 95], textColor: 255, fontSize: 8.5 },
      columnStyles: {
        0: { cellWidth: 9, halign: 'center' },
        1: { cellWidth: 20 },
        2: { cellWidth: 'auto' },
        3: { cellWidth: 14, halign: 'right' },
        4: { cellWidth: 14 },
        5: { cellWidth: 22, halign: 'right' },
        6: { cellWidth: 16, halign: 'right' },
        7: { cellWidth: 24, halign: 'right' },
      },
      margin: { left: M, right: M },
    });

    let ty = doc.lastAutoTable.finalY + 6;

    // Amount in words (left) + totals (right)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    const words = amountToWords(activeInvoice.total, settings.currencyWords);
    const wLines = doc.splitTextToSize(words, pageW - 80);
    doc.text(wLines, M, ty);

    const tX = pageW - 70, vX = pageW - M;
    const totals = [
      ['Gross (' + cur + ')', fmtMoney(activeInvoice.gross)],
      ['Sales Tax (' + cur + ')', fmtMoney(activeInvoice.tax)],
      ['Total (' + cur + ')', fmtMoney(activeInvoice.total)],
    ];
    totals.forEach(([k, v], i) => {
      if (i === 2) doc.setFont('helvetica', 'bold'); else doc.setFont('helvetica', 'normal');
      doc.text(k, tX, ty); doc.text(v, vX, ty, { align: 'right' });
      ty += 5;
    });

    ty += 6;
    // Notes
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    doc.text('Notes:', M, ty); ty += 4;
    (settings.notes || '').split('\n').forEach((ln) => { if (ln) { doc.text(ln, M, ty); ty += 4; } });

    ty += 14;
    doc.setLineWidth(0.3); doc.setDrawColor(120);
    doc.line(M, ty, M + 55, ty);
    doc.text('Authorised Signature', M, ty + 4);

    const fname = `Invoice_${(activeInvoice.invNo || 'draft')}_${(activeInvoice.custName || '').replace(/[^a-z0-9]/gi, '_').slice(0, 20) || 'customer'}.pdf`;
    doc.save(fname);

    // Advance invoice number (only if it matched the current next number)
    const num = parseInt(activeInvoice.invNo, 10);
    if (!isNaN(num) && num >= settings.nextInvNo) {
      settings.nextInvNo = num + 1;
      saveSettings(settings);
      $('#setNextInvNo').value = settings.nextInvNo;
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
})();
