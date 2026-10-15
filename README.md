# EJ Racking Invoice

A free, installable **PWA** (Progressive Web App) that turns a photo of a handwritten note into a clean, printable **invoice PDF** — styled like the EJ Racking Enterprise invoice.

## What it does

1. **📸 Capture** — take or upload a photo of a handwritten note.
2. **🔍 OCR** — reads the text. Two engines:
   - **On-device** (Tesseract.js) — free, works offline.
   - **Cloud Vision** (optional) — better for cursive; needs a free Google API key.
3. **✂️ Split** — if a note contains multiple jobs (e.g. two customers/dates separated by a line), it splits them into separate invoices.
4. **✏️ Edit** — a structured form pre-filled with best-guess values. Fix anything OCR got wrong; totals auto-calculate. The original photo stays visible for reference.
5. **📄 Export** — generates a PDF with your company header, line-item table, totals, amount-in-words, notes, and a signature line.

## Install on your phone

1. Open the published URL (see below) in your phone's browser.
2. **Android/Chrome:** menu → *Add to Home screen* / *Install app*.
   **iPhone/Safari:** Share → *Add to Home Screen*.
3. It now runs like a native app, works offline, and **updates automatically** — just reopen it after a new version is published. No reinstalling.

## Hosting (free, via GitHub Pages)

This repo includes a workflow that auto-deploys on every push to `main`.

**One-time setup:** In the repo on GitHub → **Settings → Pages → Build and deployment → Source → "GitHub Actions"**.

After that, every push publishes to:
```
https://rickychua370.github.io/EJRackingInvoice/
```

## Better cursive recognition (optional)

On-device OCR struggles with cursive. For better results:
1. Create a Google Cloud project and enable the **Cloud Vision API**.
2. Create an **API key** (free tier ≈ 1,000 scans/month).
3. In the app → **Settings → Cloud OCR**, paste the key.
4. On the Scan screen, pick **"Cloud Vision"** before reading.

The key is stored only on your device (localStorage).

## Tech

- Vanilla HTML/CSS/JS — no build step.
- [Tesseract.js](https://github.com/naptha/tesseract.js) — on-device OCR.
- [jsPDF](https://github.com/parallax/jsPDF) + autotable — PDF generation.
- Service worker for offline + auto-update (network-first).

## Settings are per-device

Company details, invoice numbering, and the API key are saved in your browser's localStorage on each device.
