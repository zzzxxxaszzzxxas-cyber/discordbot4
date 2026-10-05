"use strict";

const https = require("node:https");
const { URL } = require("node:url");
const emoji = require("../ui/emojis");

const DISCORD_WEBHOOK_PATTERN = /^https:\/\/(?:[a-zA-Z0-9-]+\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+$/;

function isValidDiscordWebhookUrl(url) {
    if (!url || typeof url !== "string") return false;
    const trimmed = url.trim();
    return DISCORD_WEBHOOK_PATTERN.test(trimmed);
}

function formatDurationThai(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) {
        return `${minutes} นาที ${seconds} วินาที`;
    }
    return `${seconds} วินาที`;
}

function sendRawWebhook(webhookUrl, payload) {
    return new Promise((resolve) => {
        if (!isValidDiscordWebhookUrl(webhookUrl)) {
            return resolve(false);
        }

        try {
            const urlObj = new URL(webhookUrl);
            const data = JSON.stringify(payload);

            const req = https.request(urlObj, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(data)
                },
                timeout: 10000
            }, (res) => {
                res.resume();
                resolve(res.statusCode >= 200 && res.statusCode < 300);
            });

            req.on("error", () => resolve(false));
            req.on("timeout", () => {
                req.destroy();
                resolve(false);
            });

            req.write(data);
            req.end();
        } catch (_) {
            resolve(false);
        }
    });
}

async function sendBatchLog({
    webhookUrl,
    mode,
    batchNumber,
    items = [],
    joinedCount,
    alreadyCount,
    failedCount,
    targetGuildName
}) {
    if (!webhookUrl || !isValidDiscordWebhookUrl(webhookUrl)) return;

    const mentions = items
        .map(item => `<@${item.userId}>`)
        .join(" ");

    const content = [
        `**${emoji.boost} รายงานการดึงสมาชิก (ชุดที่ ${batchNumber})**`,
        `เซิร์ฟเวอร์ปลายทาง: **${targetGuildName || "เซิร์ฟเวอร์เป้าหมาย"}**`,
        `ความคืบหน้าชุดนี้: ดึงเข้าสำเร็จ **${joinedCount}** คน | อยู่ในเซิร์ฟแล้ว **${alreadyCount}** คน | ไม่สำเร็จ **${failedCount}** คน`,
        "",
        `รายชื่อสมาชิกในชุดนี้:`,
        mentions.slice(0, 1500)
    ].join("\n");

    const payload = {
        content: content.slice(0, 1950),
        allowed_mentions: { parse: [] } // Silent mentions - does not trigger pings
    };

    await sendRawWebhook(webhookUrl, payload);
}

async function sendFinalSummaryEmbed({
    webhookUrl,
    mode,
    targetGuildName,
    targetGuildId,
    sourceGuildName,
    sourceGuildId,
    requestedQuota,
    joinedCount,
    alreadyCount,
    failedCount,
    processedCount,
    retryCount = 0,
    durationMs,
    finalStatus = "COMPLETED",
    statusReason = null
}) {
    if (!webhookUrl || !isValidDiscordWebhookUrl(webhookUrl)) return;

    let color = 0x57F287; // Green
    let title = `${emoji.boost} สรุปผลการดึงสมาชิกเข้าเซิร์ฟเวอร์ (เสร็จสิ้นสมบูรณ์)`;
    let description = `ดำเนินการดึงสมาชิกเข้าสู่ **${targetGuildName || targetGuildId}** ครบตามเป้าหมายเรียบร้อยแล้วครับ`;
    let statusLabel = "สำเร็จครบตามเป้าหมาย";

    if (finalStatus === "PARTIAL") {
        color = 0xFEE75C; // Yellow
        title = `${emoji.boost} สรุปผลการดึงสมาชิกเข้าเซิร์ฟเวอร์ (เสร็จสิ้นบางส่วน)`;
        description = `ดำเนินการดึงสมาชิกเข้าสู่ **${targetGuildName || targetGuildId}** เรียบร้อยแล้ว (สมาชิกที่พร้อมดึงในระบบหมดแล้ว)`;
        statusLabel = "เสร็จสิ้นบางส่วน";
    } else if (finalStatus === "SERVER_FULL") {
        color = 0xFEE75C; // Yellow
        title = `${emoji.alert} สรุปผลการดึงสมาชิกเข้าเซิร์ฟเวอร์ (เซิร์ฟเวอร์เต็ม)`;
        description = `เซิร์ฟเวอร์ปลายทางมีสมาชิกถึงจำนวนสูงสุดแล้ว ระบบจึงหยุดทำงาน`;
        statusLabel = "หยุดทำงาน (เซิร์ฟเวอร์เต็ม)";
    } else if (finalStatus === "FAILED") {
        color = 0xED4245; // Red
        title = `${emoji.error} สรุปผลการดึงสมาชิกเข้าเซิร์ฟเวอร์ (เกิดข้อผิดพลาด)`;
        description = `การดึงสมาชิกหยุดชะงักเนื่องจาก: ${statusReason || "เกิดข้อผิดพลาดในการเชื่อมต่อ"}`;
        statusLabel = "เกิดข้อผิดพลาด";
    }

    const fields = [
        {
            name: `${emoji.sparkle} รูปแบบการดึง`,
            value: mode?.label || "ทั้งระบบ → ปลายทาง",
            inline: true
        },
        {
            name: `${emoji.server} เซิร์ฟเวอร์ปลายทาง`,
            value: targetGuildName ? `${targetGuildName} (\`${targetGuildId}\`)` : `\`${targetGuildId}\``,
            inline: true
        }
    ];

    if (mode?.requiresSource && sourceGuildId) {
        fields.push({
            name: `${emoji.server} เซิร์ฟเวอร์ต้นทาง`,
            value: sourceGuildName ? `${sourceGuildName} (\`${sourceGuildId}\`)` : `\`${sourceGuildId}\``,
            inline: true
        });
    }

    fields.push(
        {
            name: `${emoji.boost} เป้าหมายที่ต้องการ`,
            value: `**${Number(requestedQuota).toLocaleString("th-TH")}** คน`,
            inline: true
        },
        {
            name: `${emoji.success} ดึงเข้าสำเร็จจริง`,
            value: `**${Number(joinedCount).toLocaleString("th-TH")}** คน`,
            inline: true
        },
        {
            name: `${emoji.members} อยู่ในเซิร์ฟแล้ว`,
            value: `**${Number(alreadyCount).toLocaleString("th-TH")}** คน`,
            inline: true
        },
        {
            name: `${emoji.error} ไม่สามารถดึงได้`,
            value: `**${Number(failedCount).toLocaleString("th-TH")}** คน`,
            inline: true
        },
        {
            name: `${emoji.loading} ตรวจเช็กไปแล้ว`,
            value: `**${Number(processedCount).toLocaleString("th-TH")}** คน`,
            inline: true
        },
        {
            name: `${emoji.alert} จำนวนครั้งที่ลองใหม่`,
            value: `**${Number(retryCount).toLocaleString("th-TH")}** ครั้ง`,
            inline: true
        },
        {
            name: `${emoji.shield} สถานะสุดท้าย`,
            value: `**${statusLabel}**`,
            inline: true
        },
        {
            name: `${emoji.sparkle} เวลาที่ใช้ทั้งหมด`,
            value: formatDurationThai(durationMs),
            inline: true
        }
    );

    const embed = {
        title,
        description,
        color,
        fields,
        footer: {
            text: "ดึงสมาชิกอัตโนมัติ • รายงานผลเสร็จสิ้น"
        },
        timestamp: new Date().toISOString()
    };

    await sendRawWebhook(webhookUrl, {
        embeds: [embed],
        allowed_mentions: { parse: [] }
    });
}

module.exports = {
    isValidDiscordWebhookUrl,
    formatDurationThai,
    sendRawWebhook,
    sendBatchLog,
    sendFinalSummaryEmbed
};
