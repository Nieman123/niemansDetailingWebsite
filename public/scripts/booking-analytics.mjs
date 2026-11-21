// Booking conversions for Google Analytics 4 and Google Ads.
//
// A booking counts once: when a paid deposit lands back on the appointment page, or when a returning customer
// who needs no deposit sends their request. GA4 gets a "purchase" event valued at the estimate, which Google Ads
// can import as a conversion (Ads > Goals > Conversions > New > Import > Google Analytics 4 > purchase).
// To also send a direct Ads conversion, create a "Book appointment" conversion action in Google Ads and paste
// its send_to value ("AW-17602789326/xxxxxxxxxxxx") below.
const ADS_BOOKING_SEND_TO = "";
const GA_ID = "G-2PM831JLRQ";
const ADS_ID = "AW-17602789326";
const PENDING_KEY = "pendingBookingConversion";

// Same rule as the rest of the site: only the production domain reports to Google.
const reporting = () => location.origin === "https://niemansdetailing.com";

function loadGtag() {
  if (!reporting()) return null;
  if (typeof window.gtag !== "function") {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() { window.dataLayer.push(arguments); };
    const script = Object.assign(document.createElement("script"), { async: true, src: `https://www.googletagmanager.com/gtag/js?id=${GA_ID}` });
    document.head.append(script);
    window.gtag("js", new Date());
    // Appointment links carry a private token after the #. Report the bare path only, and no page view.
    const page = { page_location: location.origin + location.pathname, send_page_view: false };
    window.gtag("config", GA_ID, page);
    window.gtag("config", ADS_ID, page);
  }
  return window.gtag;
}

// Called by the booking form just before it leaves for Stripe or the appointment page.
export function rememberBooking(id, valueCents, service) {
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify({ id, valueCents, service })); } catch {}
}

// Called by the appointment page once it knows the booking went through.
export function reportBookingConversion(id, appointment) {
  let pending;
  try { pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null"); } catch { return; }
  if (!pending || pending.id !== id) return;
  const booked = ["pending_approval", "confirmed"].includes(appointment.status) &&
    ((appointment.paidDeposit ?? 0) > 0 || !appointment.depositCents);
  if (!booked) return;
  try {
    sessionStorage.removeItem(PENDING_KEY);
    if (localStorage.getItem("bookingConverted:" + id)) return;
    localStorage.setItem("bookingConverted:" + id, "1");
  } catch {}
  const gtag = loadGtag();
  if (!gtag) return;
  const value = Math.round(appointment.estimateCents ?? pending.valueCents ?? 0) / 100;
  // A short, non-reversible transaction ID lets Google de-duplicate without exposing the appointment link.
  const transaction = "bk-" + id.slice(0, 12);
  gtag("event", "purchase", {
    transaction_id: transaction, value, currency: "USD",
    items: [{ item_name: appointment.service || pending.service || "Detailing appointment", price: value, quantity: 1 }],
  });
  gtag("event", "booking_complete", { value, currency: "USD", deposit_paid: (appointment.paidDeposit ?? 0) > 0 });
  if (ADS_BOOKING_SEND_TO) gtag("event", "conversion", { send_to: ADS_BOOKING_SEND_TO, value, currency: "USD", transaction_id: transaction });
}
