"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.friendlyDate = friendlyDate;
exports.invoicePdf = invoicePdf;
// Branded invoice and receipt PDFs. White paper so accounts-payable offices can print them, with the
// site's royal purple header band, white logo and gold accents, like the customer emails.
const pdfkit_1 = __importDefault(require("pdfkit"));
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const invoice_model_1 = require("./invoice-model");
const C = {
    purple: "#6b3fd8", purpleDeep: "#2a1b5c", ink: "#16131f", text: "#3a3550", muted: "#6f6987",
    line: "#dcd7ea", tint: "#f5f2fc", gold: "#e4bb5c", goldInk: "#8a6514", paid: "#1f7a4d",
};
const PAGE = { width: 612, height: 792, margin: 48 };
const RIGHT = PAGE.width - PAGE.margin;
const WIDTH = PAGE.width - PAGE.margin * 2;
let logo;
function logoImage() {
    if (logo === undefined) {
        try {
            logo = (0, node_fs_1.readFileSync)((0, node_path_1.join)(__dirname, "..", "assets", "invoice-logo.png"));
        }
        catch {
            logo = null;
        }
    }
    return logo;
}
const money = (cents) => (cents < 0 ? "-" : "") + "$" + (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const quantity = (value) => Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, "");
function friendlyDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match)
        return value;
    return new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
}
const methodLabel = (method) => ({ check: "Check", cash: "Cash", ach: "Bank transfer (ACH)", card: "Card", other: "Other" }[method] ?? method);
function invoicePdf(invoice, settings, kind) {
    const doc = new pdfkit_1.default({ size: "LETTER", margin: PAGE.margin, bufferPages: true,
        info: { Title: `${kind === "receipt" ? "Receipt" : "Invoice"} ${invoice.number}`, Author: settings.businessName, Creator: settings.businessName } });
    const chunks = [];
    doc.on("data", chunk => chunks.push(chunk));
    const done = new Promise((resolve, reject) => {
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);
    });
    const totals = (0, invoice_model_1.invoiceTotals)(invoice);
    const receipt = kind === "receipt";
    // Header band.
    const header = () => {
        doc.save().rect(0, 0, PAGE.width, 92).fill(C.purpleDeep).restore();
        doc.save().rect(0, 92, PAGE.width, 4).fill(C.gold).restore();
        const image = logoImage();
        if (image)
            doc.image(image, PAGE.margin, 34, { width: 250 });
        else
            doc.font("Helvetica-Bold").fontSize(20).fillColor("#ffffff").text("NIEMAN'S DETAILING", PAGE.margin, 34);
        doc.font("Helvetica-Bold").fontSize(24).fillColor(C.gold)
            .text(receipt ? "RECEIPT" : "INVOICE", PAGE.margin, 26, { width: WIDTH, align: "right", characterSpacing: 2 });
        doc.font("Helvetica").fontSize(10).fillColor("#ffffff")
            .text(`No. ${invoice.number}`, PAGE.margin, 58, { width: WIDTH, align: "right" });
    };
    header();
    // From and document details.
    let y = 122;
    const label = (value, x, top, width = 200) => doc.font("Helvetica-Bold").fontSize(7.5).fillColor(C.goldInk).text(value.toUpperCase(), x, top, { width, characterSpacing: 1.2 });
    const fromLines = [settings.businessName, ...settings.mailingAddress.split("\n"), settings.phone, settings.email, settings.website]
        .map(line => line.trim()).filter(Boolean);
    label("From", PAGE.margin, y);
    doc.font("Helvetica-Bold").fontSize(11).fillColor(C.ink).text(fromLines[0] ?? "", PAGE.margin, y + 12, { width: 240 });
    doc.font("Helvetica").fontSize(9.5).fillColor(C.text).text(fromLines.slice(1).join("\n"), { width: 240, lineGap: 1.5 });
    const fromBottom = doc.y;
    const meta = receipt ? [
        ["Receipt date", friendlyDate(totals.lastPaymentDate ?? invoice.issueDate)],
        ["For invoice", invoice.number],
        ["Invoice date", friendlyDate(invoice.issueDate)],
    ] : [
        ["Invoice date", friendlyDate(invoice.issueDate)],
        ["Terms", (0, invoice_model_1.termsLabel)(invoice.terms)],
        ["Due date", friendlyDate(invoice.dueDate)],
    ];
    if (invoice.reference)
        meta.push(["PO / reference", invoice.reference]);
    let metaY = y;
    for (const [name, value] of meta) {
        doc.font("Helvetica").fontSize(9).fillColor(C.muted).text(name, 340, metaY, { width: 100 });
        doc.font("Helvetica-Bold").fontSize(9.5).fillColor(C.ink).text(value, 440, metaY, { width: RIGHT - 440, align: "right" });
        metaY = Math.max(doc.y, metaY + 12) + 5;
    }
    y = Math.max(fromBottom, metaY) + 18;
    // Bill to, and the job it covers.
    doc.save().moveTo(PAGE.margin, y).lineTo(RIGHT, y).lineWidth(0.75).strokeColor(C.line).stroke().restore();
    y += 14;
    label(receipt ? "Received from" : "Bill to", PAGE.margin, y);
    const bill = invoice.billTo;
    doc.font("Helvetica-Bold").fontSize(11).fillColor(C.ink).text(bill.name, PAGE.margin, y + 12, { width: 260 });
    const billLines = [bill.attention ? `Attn: ${bill.attention}` : "", ...bill.address.split("\n"), bill.email, bill.phone].map(line => line.trim()).filter(Boolean);
    doc.font("Helvetica").fontSize(9.5).fillColor(C.text).text(billLines.join("\n"), { width: 260, lineGap: 1.5 });
    const billBottom = doc.y;
    let serviceBottom = y;
    if (invoice.serviceDate || invoice.serviceDetail) {
        label("Service", 340, y);
        const service = [invoice.serviceDate ? friendlyDate(invoice.serviceDate) : "", invoice.serviceDetail].filter(Boolean).join("\n");
        doc.font("Helvetica").fontSize(9.5).fillColor(C.text).text(service, 340, y + 12, { width: RIGHT - 340, lineGap: 1.5 });
        serviceBottom = doc.y;
    }
    y = Math.max(billBottom, serviceBottom) + 22;
    // Line items.
    const cols = { description: PAGE.margin + 10, qty: 350, unit: 400, amount: 480 };
    const tableHeader = () => {
        doc.save().roundedRect(PAGE.margin, y, WIDTH, 22, 4).fill(C.purple).restore();
        doc.font("Helvetica-Bold").fontSize(8).fillColor("#ffffff");
        doc.text("DESCRIPTION", cols.description, y + 7.5, { characterSpacing: 1 });
        doc.text("QTY", cols.qty, y + 7.5, { width: 40, align: "right", characterSpacing: 1 });
        doc.text("UNIT PRICE", cols.unit, y + 7.5, { width: 70, align: "right", characterSpacing: 1 });
        doc.text("AMOUNT", cols.amount, y + 7.5, { width: RIGHT - 10 - cols.amount, align: "right", characterSpacing: 1 });
        y += 28;
    };
    const newPage = () => {
        doc.addPage();
        header();
        y = 122;
    };
    tableHeader();
    invoice.lines.forEach((line, index) => {
        doc.font("Helvetica").fontSize(9.5);
        const height = Math.max(14, doc.heightOfString(line.description, { width: cols.qty - cols.description - 16 }));
        if (y + height + 12 > PAGE.height - 80) {
            newPage();
            tableHeader();
            doc.font("Helvetica").fontSize(9.5);
        }
        if (index % 2 === 1)
            doc.save().rect(PAGE.margin, y - 5, WIDTH, height + 10).fill(C.tint).restore();
        doc.fillColor(C.ink).text(line.description, cols.description, y, { width: cols.qty - cols.description - 16 });
        doc.fillColor(C.text).text(quantity(line.quantity), cols.qty, y, { width: 40, align: "right" });
        doc.text(money(line.unitCents), cols.unit, y, { width: 70, align: "right" });
        doc.font("Helvetica-Bold").fillColor(C.ink).text(money(totals.lineCents[index]), cols.amount, y, { width: RIGHT - 10 - cols.amount, align: "right" });
        y += height + 10;
    });
    doc.save().moveTo(PAGE.margin, y).lineTo(RIGHT, y).lineWidth(0.75).strokeColor(C.line).stroke().restore();
    y += 12;
    // Totals.
    const rows = [["Subtotal", totals.subtotalCents]];
    if (invoice.taxRateBasisPoints > 0)
        rows.push([`Sales tax (${(invoice.taxRateBasisPoints / 100).toFixed(2).replace(/\.?0+$/, "")}%)`, totals.taxCents]);
    rows.push(["Total", totals.totalCents, true]);
    for (const credit of invoice.credits)
        rows.push([credit.description, -credit.cents]);
    for (const payment of invoice.payments) {
        rows.push([`${methodLabel(payment.method)}${payment.reference ? ` #${payment.reference}` : ""}, ${friendlyDate(payment.date)}`, -payment.cents]);
    }
    const blockHeight = Math.max(rows.length * 20 + 40, 124);
    if (y + blockHeight > PAGE.height - 90)
        newPage();
    const totalsX = 330;
    const boxTop = y;
    for (const [name, cents, strong] of rows) {
        doc.font(strong ? "Helvetica-Bold" : "Helvetica").fontSize(strong ? 10.5 : 9.5).fillColor(strong ? C.ink : C.text)
            .text(name, totalsX, y, { width: 150 });
        doc.text(money(cents), 480, y, { width: RIGHT - 480 - 10, align: "right" });
        y += strong ? 20 : 17;
    }
    y += 4;
    const due = totals.balanceCents;
    doc.save().roundedRect(totalsX - 10, y, RIGHT - totalsX + 10, 34, 6).fill(receipt && due === 0 ? C.paid : C.purpleDeep).restore();
    doc.save().rect(totalsX - 10, y, 4, 34).fill(C.gold).restore();
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#ffffff")
        .text(receipt ? (due === 0 ? "PAID IN FULL" : "BALANCE REMAINING") : "AMOUNT DUE", totalsX + 4, y + 12, { width: 150, characterSpacing: 1 });
    doc.fontSize(13).text(money(due), 440, y + 10.5, { width: RIGHT - 440 - 10, align: "right" });
    const totalsBottom = y + 34;
    // How to pay (invoice), or a paid stamp (receipt), to the left of the totals.
    if (!receipt) {
        const payable = settings.payableTo || settings.businessName;
        doc.save().roundedRect(PAGE.margin, boxTop, 262, 124, 6).lineWidth(1).strokeColor(C.gold).stroke().restore();
        label("How to pay", PAGE.margin + 14, boxTop + 12, 230);
        doc.font("Helvetica").fontSize(9).fillColor(C.muted).text("Make checks payable to", PAGE.margin + 14, boxTop + 28, { width: 234 });
        doc.font("Helvetica-Bold").fontSize(10.5).fillColor(C.ink).text(payable, { width: 234 });
        doc.font("Helvetica").fontSize(9).fillColor(C.muted).text("Mail to", PAGE.margin + 14, doc.y + 5, { width: 234 });
        doc.font("Helvetica").fontSize(9.5).fillColor(C.ink).text([payable, ...settings.mailingAddress.split("\n")].map(line => line.trim()).filter(Boolean).join("\n"), { width: 234, lineGap: 1 });
        doc.font("Helvetica-Oblique").fontSize(8.5).fillColor(C.text).text(`Please write ${invoice.number} on the memo line.`, PAGE.margin + 14, boxTop + 104, { width: 234 });
    }
    else {
        const stamp = due === 0 ? "PAID" : "PARTIAL PAYMENT";
        doc.save().rotate(-8, { origin: [PAGE.margin + 110, boxTop + 60] });
        doc.roundedRect(PAGE.margin + 20, boxTop + 32, due === 0 ? 150 : 210, 50, 6).lineWidth(3).strokeColor(C.paid).stroke();
        doc.font("Helvetica-Bold").fontSize(due === 0 ? 30 : 20).fillColor(C.paid)
            .text(stamp, PAGE.margin + 20, boxTop + (due === 0 ? 43 : 48), { width: due === 0 ? 150 : 210, align: "center", characterSpacing: 3 });
        doc.restore();
    }
    y = Math.max(totalsBottom, boxTop + 124) + 24;
    // Notes and footer text.
    const note = receipt ? (invoice.receiptNote || settings.receiptNote) : (invoice.notes || settings.invoiceNote);
    if (note) {
        if (y + 60 > PAGE.height - 70)
            newPage();
        label("Notes", PAGE.margin, y);
        doc.font("Helvetica").fontSize(9.5).fillColor(C.text).text(note, PAGE.margin, y + 12, { width: WIDTH, lineGap: 1.5 });
    }
    // Footer on every page.
    const range = doc.bufferedPageRange();
    for (let page = range.start; page < range.start + range.count; page++) {
        doc.switchToPage(page);
        // Writing below the bottom margin would otherwise start a new page.
        doc.page.margins.bottom = 0;
        const bottom = PAGE.height - 46;
        doc.save().moveTo(PAGE.margin, bottom - 8).lineTo(RIGHT, bottom - 8).lineWidth(0.5).strokeColor(C.line).stroke().restore();
        const footer = [receipt ? "Thank you for your business." : "Thank you for choosing Nieman's Detailing.",
            settings.phone, settings.website, settings.taxId ? `NC sales tax ID ${settings.taxId}` : ""].filter(Boolean).join("   ·   ");
        doc.font("Helvetica").fontSize(8).fillColor(C.muted).text(footer, PAGE.margin, bottom, { width: WIDTH, align: "center", lineBreak: false });
        if (range.count > 1)
            doc.text(`Page ${page - range.start + 1} of ${range.count}`, PAGE.margin, bottom + 11, { width: WIDTH, align: "center", lineBreak: false });
    }
    doc.end();
    return done;
}
