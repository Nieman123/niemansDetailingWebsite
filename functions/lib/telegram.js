"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.telegramEnabled = telegramEnabled;
exports.telegramConfigured = telegramConfigured;
exports.sendTelegramMessage = sendTelegramMessage;
// Owner alerts over Telegram. The bot token and chat ID come from the TELEGRAM_BOT_TOKEN and
// TELEGRAM_CHAT_ID parameters declared in index.ts, which Firebase exposes as environment variables.
function telegramEnabled() {
    return !process.env.FUNCTIONS_EMULATOR && process.env.ENABLE_TELEGRAM_NOTIFICATIONS !== "false";
}
function telegramConfigured() {
    const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
    const chat = process.env.TELEGRAM_CHAT_ID ?? "";
    return telegramEnabled() && !!token && token !== "disabled" && !!chat && chat !== "disabled";
}
async function sendTelegramMessage(text) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
    const chatId = process.env.TELEGRAM_CHAT_ID ?? "";
    if (!botToken || !chatId)
        throw new Error("Missing Telegram configuration");
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
        throw new Error(`Telegram request failed (${response.status})`);
    const result = await response.json();
    if (!result.ok)
        throw new Error("Telegram did not accept the message");
}
